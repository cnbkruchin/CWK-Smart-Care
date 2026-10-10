// ChangeSet builder: the only way application code expresses writes. It stamps metadata,
// normalizes + validates every record against the schema, computes partitions, derives audit
// diffs and the ChangeLog entry, and produces the plain object passed to MutationStore.commit.

import { getTable, normalizeRecord, assertValidRecord, hasVersion, secretColumns } from '../schema/index.js';
import { deterministicId, SYSTEM_USER_ID } from '../shared/uuid.js';
import { AppError } from '../shared/errors.js';
import { schoolDateOf } from '../shared/time.js';
import { partitionKeyForDate } from '../domain/calendar.js';

const NO_CHANGELOG = new Set(['MutationJournal', 'IdempotencyRecords', 'ChangeLog', 'OperationMetrics']);

export function partitionFor(tableName, record, terms, tz) {
  const t = getTable(tableName);
  if (t.partition !== 'TERM') return '*';
  const v = record[t.partitionColumn];
  if (!v) throw new AppError('INTERNAL_ERROR', `partition column ${t.partitionColumn} missing for ${tableName}`);
  const date = t.columns.find((c) => c.name === t.partitionColumn).type === 'date' ? v : schoolDateOf(v, tz);
  return partitionKeyForDate(terms, date);
}

function diff(before, after, table) {
  const secrets = new Set(secretColumns(table));
  const b = {};
  const a = {};
  const skip = new Set(['updated_at', 'updated_by', 'version', 'created_at', 'created_by']);
  for (const k of Object.keys(after)) {
    if (skip.has(k)) continue;
    const bv = before ? before[k] ?? null : null;
    const av = after[k] ?? null;
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    b[k] = secrets.has(k) ? (bv === null ? null : '[REDACTED]') : bv;
    a[k] = secrets.has(k) ? (av === null ? null : '[REDACTED]') : av;
  }
  return { before: before ? b : null, after: a };
}

export class ChangeSetBuilder {
  /**
   * @param {{operation:string, operationId:string, actorId:string, actorRoles?:string[], requestId?:string|null,
   *          now:string, terms:object[], tz:string, ids:{uuid():string}, channel?:string}} o
   */
  constructor(o) {
    this.operation = o.operation;
    this.operationId = o.operationId;
    this.actorId = o.actorId || SYSTEM_USER_ID;
    this.actorRoles = o.actorRoles || [];
    this.requestId = o.requestId || null;
    this.now = o.now;
    this.terms = o.terms || [];
    this.tz = o.tz || 'Asia/Bangkok';
    this.ids = o.ids;
    this.channel = o.channel || 'APP';
    this.writes = [];
    this.maintenanceAllowed = false;
    this._keys = new Set();
  }

  _push(table, op, record, expectedVersion) {
    const key = `${table}|${record.id}`;
    if (this._keys.has(key)) throw new AppError('INTERNAL_ERROR', `duplicate write for ${key} in one change set`);
    this._keys.add(key);
    assertValidRecord(table, record);
    this.writes.push({ table, op, partition: partitionFor(table, record, this.terms, this.tz), record, expected_version: expectedVersion });
    return record;
  }

  /** Insert a new row. `data.id` optional (random v4 assigned). */
  insert(table, data) {
    const t = getTable(table);
    const rec = normalizeRecord(table, { ...data, id: data.id || this.ids.uuid() });
    if (t.columns.some((c) => c.name === 'created_at')) {
      rec.created_at = rec.created_at || this.now;
      rec.created_by = rec.created_by || this.actorId;
    }
    if (hasVersion(table)) {
      rec.updated_at = this.now;
      rec.updated_by = this.actorId;
      rec.version = 1;
    }
    return this._push(table, 'insert', rec, null);
  }

  /** Update an existing row read earlier (`current` carries the version we expect).
   *  Updating a row already written in this change set merges into that pending write. */
  update(table, current, patch) {
    if (!hasVersion(table)) throw new AppError('INTERNAL_ERROR', `${table} is append-only`);
    if (!current || !current.id) throw new AppError('INTERNAL_ERROR', 'update requires the current record');
    const pending = this.writes.find((w) => w.table === table && w.record.id === current.id);
    if (pending) {
      const merged = normalizeRecord(table, { ...pending.record, ...patch, id: current.id });
      merged.created_at = pending.record.created_at;
      merged.created_by = pending.record.created_by;
      merged.updated_at = this.now;
      merged.updated_by = this.actorId;
      merged.version = pending.record.version;
      assertValidRecord(table, merged);
      pending.record = merged;
      return merged;
    }
    const rec = normalizeRecord(table, { ...current, ...patch, id: current.id });
    rec.created_at = current.created_at;
    rec.created_by = current.created_by;
    rec.updated_at = this.now;
    rec.updated_by = this.actorId;
    rec.version = current.version + 1;
    return this._push(table, 'update', rec, current.version);
  }

  /** Audit row (append-only). before/after are diffs with secrets redacted. */
  audit({ action, entityType = null, entityId = null, studentId = null, reason = null, before = null, after = null, table = null }) {
    const d = table && after ? diff(before, after, table) : { before, after };
    return this.insert('AuditEvents', {
      occurred_at: this.now, actor_id: this.actorId, actor_roles: this.actorRoles.join(',') || null, action,
      entity_type: entityType, entity_id: entityId, student_id: studentId, operation_id: this.operationId, request_id: this.requestId,
      channel: this.channel, reason, before_json: d.before, after_json: d.after,
    });
  }

  /** Finalize: adds ChangeLog + idempotency rows. */
  build({ result = {}, idempotency = null } = {}) {
    const changes = this.writes.filter((w) => !NO_CHANGELOG.has(w.table)).map((w) => ({ table: w.table, id: w.record.id, op: w.op === 'insert' ? 'INSERT' : 'UPDATE', version: w.record.version || 1 }));
    if (changes.length) {
      // seq is assigned by the MutationStore under its lock/transaction
      const rec = normalizeRecord('ChangeLog', {
        id: this.ids.uuid(), seq: 1, operation_id: this.operationId, operation: this.operation, committed_at: this.now,
        changes_json: changes, actor_id: this.actorId, created_at: this.now, created_by: this.actorId,
      });
      assertValidRecord('ChangeLog', rec);
      this.writes.push({ table: 'ChangeLog', op: 'insert', partition: partitionFor('ChangeLog', rec, this.terms, this.tz), record: rec, expected_version: null, assign_seq: true });
    }
    let idem = null;
    if (idempotency) {
      const rec = normalizeRecord('IdempotencyRecords', {
        id: deterministicId.idempotency(idempotency.scope_key), scope_key: idempotency.scope_key, actor_id: this.actorId, operation: this.operation,
        idempotency_key: idempotency.key, request_hash: idempotency.request_hash, result_json: result, operation_id: this.operationId,
        expires_at: idempotency.expires_at, created_at: this.now, created_by: this.actorId,
      });
      assertValidRecord('IdempotencyRecords', rec);
      idem = { scope_key: idempotency.scope_key, request_hash: idempotency.request_hash, record: rec, partition: partitionFor('IdempotencyRecords', rec, this.terms, this.tz) };
    }
    return {
      operation_id: this.operationId, operation: this.operation, actor_id: this.actorId, request_id: this.requestId,
      prepared_at: this.now, writes: this.writes, idempotency: idem, result, maintenance_allowed: this.maintenanceAllowed,
    };
  }

  get isEmpty() {
    return this.writes.length === 0;
  }
}

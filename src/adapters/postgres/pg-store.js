// PostgreSQL TableStore + MutationStore (reference REST backend, MASTER_PROMPT §16). Same contract as the
// memory and Sheets stores (src/ports/index.js), proved by tests/contract/store-contract.test.mjs:
//   - commit(changeSet) = ONE transaction: maintenance mode, idempotency (serialized per key), version
//     checks (UPDATE … WHERE version = expected), ChangeLog sequence (contiguous: transaction-scoped
//     advisory lock + max+1), inserts/updates; constraints (unique, FK, CHECK, exclusion) are the database's
//     enforcement in addition to domain validation; all foreign keys are DEFERRABLE INITIALLY DEFERRED so
//     the order of writes inside a change set does not matter (updates run first to free unique keys).
//   - reads return canonical records (dates/timestamps as ISO text) like every other adapter.
//   - no physical term partitions: TERM tables expose LOGICAL partitions computed in SQL with the same rule as
//     every other adapter (domain/calendar.js partitionKeyForDate on the school date of the partition column),
//     so partitions(), count(), scan() and partition hints in list()/findBy() match Sheets and memory.
// Methods return Promises — the application runs on the async runtime (runAsync).
import { getTable, SCHEMA_VERSION } from '../../schema/index.js';
import { AppError } from '../../shared/errors.js';
import { tzOffset } from '../../shared/time.js';
import { encodeCursor, decodeCursor, pageSize } from '../../shared/query.js';
import { canonicalRecord } from '../../application/migration/format.js';
import { selectList, paramValue, whereSql, orderSql, mapPgError, tableName, columnOf } from './sql-codec.js';

const CHANGE_LOG_LOCK = 734921; // advisory lock id for ChangeLog sequence assignment
const WORKER_LOCK = 734922; // session advisory lock: one background worker tick at a time

export class PgStore {
  /** @param {{pool: import('pg').Pool, timezone?: string}} o */
  constructor({ pool, timezone = 'Asia/Bangkok' }) {
    this.pool = pool;
    this.platformName = 'POSTGRES';
    this.tzMinutes = tzOffset(timezone);
    this.onLockWait = null; // optional (ms) => void: time spent waiting for the ChangeLog sequence lock
  }

  /**
   * SQL for the logical term partition of a row (null for unpartitioned tables). Mirrors partitionKeyForDate:
   * the term containing the school date (start ≤ d < end), else the latest term started on/before d, else the
   * earliest term, else UNPARTITIONED. Timestamps become school dates with the school's fixed UTC offset.
   */
  _partExpr(table) {
    const t = getTable(table);
    if (t.partition !== 'TERM') return null;
    const col = t.columns.find((c) => c.name === t.partitionColumn);
    const d = col.type === 'date' ? t.partitionColumn : `((${t.partitionColumn} + interval '${this.tzMinutes} minutes') AT TIME ZONE 'UTC')::date`;
    return `COALESCE((SELECT x.code FROM terms x WHERE ${d} >= x.start_date AND ${d} < x.end_date ORDER BY x.start_date, x.id LIMIT 1),
      (SELECT x.code FROM terms x WHERE x.start_date <= ${d} ORDER BY x.start_date DESC, x.id LIMIT 1),
      (SELECT x.code FROM terms x ORDER BY x.start_date, x.id LIMIT 1), 'UNPARTITIONED')`;
  }

  /** Adds "logical partition IN (...)" to a WHERE clause when a partition hint is given for a TERM table. */
  _withPartitions(table, where, params, partitions) {
    const expr = this._partExpr(table);
    if (!expr || !Array.isArray(partitions) || !partitions.length || partitions.includes('*')) return where;
    params.push(partitions);
    const cond = `${expr} = ANY($${params.length}::text[])`;
    return where ? `${where} AND ${cond}` : `WHERE ${cond}`;
  }

  async _q(sql, params = []) {
    try { return await this.pool.query(sql, params); } catch (e) { throw mapPgError(e); }
  }

  _rows(table, rows) { return rows.map((r) => canonicalRecord(table, r)); }

  // ───────── TableStore ─────────
  async get(table, id) {
    const r = await this._q(`SELECT ${selectList(table)} FROM ${tableName(table)} WHERE id = $1`, [id]);
    return r.rows.length ? canonicalRecord(table, r.rows[0]) : null;
  }

  async getMany(table, ids) {
    const out = new Map();
    if (!ids.length) return out;
    const r = await this._q(`SELECT ${selectList(table)} FROM ${tableName(table)} WHERE id = ANY($1::uuid[])`, [ids]);
    for (const row of this._rows(table, r.rows)) out.set(row.id, row);
    return out;
  }

  async findBy(table, column, value, opts = {}) {
    const c = columnOf(table, column);
    const params = value === null ? [] : [paramValue(c, value)];
    const where = this._withPartitions(table, `WHERE ${column} ${value === null ? 'IS NULL' : '= $1'}`, params, opts.partitions);
    const r = await this._q(`SELECT ${selectList(table)} FROM ${tableName(table)} ${where} ORDER BY id`, params);
    return this._rows(table, r.rows);
  }

  async list(table, q = {}) {
    const params = [];
    const where = this._withPartitions(table, whereSql(table, q.where, params), params, q.partitions);
    const order = orderSql(table, q.orderBy);
    if (q.all === true && !q.cursor) {
      const r = await this._q(`SELECT ${selectList(table)} FROM ${tableName(table)} ${where} ${order}`, params);
      return { items: this._rows(table, r.rows), next_cursor: null };
    }
    const size = pageSize(q.limit);
    const c = decodeCursor(q.cursor);
    const offset = c ? c.o : 0;
    params.push(size + 1, offset);
    const r = await this._q(`SELECT ${selectList(table)} FROM ${tableName(table)} ${where} ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const items = this._rows(table, r.rows.slice(0, size));
    return { items, next_cursor: r.rows.length > size ? encodeCursor({ o: offset + size, id: items[items.length - 1].id }) : null };
  }

  /** Raw order for export: keyset pagination by id within one (logical) partition (stable while the source is frozen). */
  async scan(table, partition, { cursor = null, limit = 500 } = {}) {
    const c = decodeCursor(cursor);
    const size = pageSize(limit);
    const params = [size + 1];
    let where = '';
    if (c) { params.push(c.id); where = `WHERE id > $${params.length}`; }
    where = this._withPartitions(table, where, params, partition ? [partition] : null);
    const r = await this._q(`SELECT ${selectList(table)} FROM ${tableName(table)} ${where} ORDER BY id LIMIT $1`, params);
    const items = this._rows(table, r.rows.slice(0, size));
    return { items, next_cursor: r.rows.length > size ? encodeCursor({ id: items[items.length - 1].id }) : null };
  }

  /** '*' for unpartitioned tables; the logical term partitions that hold rows for TERM tables. */
  async partitions(table) {
    const expr = this._partExpr(table);
    if (!expr) return ['*'];
    const r = await this._q(`SELECT DISTINCT ${expr} AS p FROM ${tableName(table)}`);
    return r.rows.map((x) => x.p).sort();
  }

  async count(table, partition = null) {
    const params = [];
    const where = this._withPartitions(table, '', params, partition ? [partition] : null);
    const r = await this._q(`SELECT count(*)::int AS n FROM ${tableName(table)} ${where}`, params);
    return r.rows[0].n;
  }

  /** Import contract (portable package → this database), used by tests and future tooling. */
  async importColumns(table, columns) {
    const r = await this._q(`SELECT ${selectList(table, columns)} FROM ${tableName(table)}`);
    return r.rows;
  }

  // ───────── system mode (Settings key system.mode; enforced here for every channel) ─────────
  async systemMode(client = null) {
    const sql = "SELECT value_json FROM settings WHERE key = 'system.mode' ORDER BY updated_at DESC LIMIT 1";
    const r = client ? await client.query(sql) : await this._q(sql);
    const v = r.rows.length ? r.rows[0].value_json : null;
    return v && v.value === 'READ_ONLY' ? 'READ_ONLY' : 'NORMAL';
  }

  async setSystemMode(mode, actorId) {
    const school = (await this._q('SELECT id FROM schools ORDER BY created_at LIMIT 1')).rows[0];
    if (!school) throw new AppError('CONFIGURATION_REQUIRED', 'school missing');
    await this._q(`INSERT INTO settings (id, school_id, key, value_json, is_example, description_th, created_at, created_by, updated_at, updated_by, version)
      VALUES (gen_random_uuid(), $1, 'system.mode', $2, false, 'โหมดระบบ (READ_ONLY = อ่านอย่างเดียว บังคับที่ฐานข้อมูล)', now(), $3, now(), $3, 1)
      ON CONFLICT (school_id, key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now(), updated_by = EXCLUDED.updated_by, version = settings.version + 1`,
    [school.id, JSON.stringify({ value: mode }), actorId]);
    return mode;
  }

  // ───────── MutationStore ─────────
  async commit(cs) {
    let client;
    try { client = await this.pool.connect(); } catch (e) { throw mapPgError(e); }
    try {
      await client.query('BEGIN');
      if (!cs.maintenance_allowed && (await this.systemMode(client)) === 'READ_ONLY') throw new AppError('MAINTENANCE_MODE', 'read-only mode');
      if (cs.idempotency) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cs.idempotency.scope_key]);
        const prior = (await client.query(`SELECT request_hash, result_json, ${selectList('IdempotencyRecords', ['created_at'])} FROM idempotency_records WHERE scope_key = $1`, [cs.idempotency.scope_key])).rows[0];
        if (prior) {
          await client.query('ROLLBACK');
          if (prior.request_hash !== cs.idempotency.request_hash) throw new AppError('DUPLICATE_REQUEST_MISMATCH', 'idempotency key reused with different payload');
          return { replayed: true, result: prior.result_json, committed_at: prior.created_at };
        }
      }
      const writes = cs.idempotency ? [...cs.writes, { table: 'IdempotencyRecords', op: 'insert', record: cs.idempotency.record, expected_version: null }] : cs.writes;
      let seq = null;
      if (writes.some((w) => w.assign_seq)) {
        const waitStart = Date.now();
        await client.query('SELECT pg_advisory_xact_lock($1)', [CHANGE_LOG_LOCK]);
        if (this.onLockWait) this.onLockWait(Date.now() - waitStart); // observability hook (load test, metrics)
        seq = Number((await client.query('SELECT COALESCE(MAX(seq), 0) AS m FROM change_log')).rows[0].m);
      }
      // updates first (they may free a unique key an insert takes); FKs are deferred to COMMIT
      const ordered = [...writes.filter((w) => w.op !== 'insert'), ...writes.filter((w) => w.op === 'insert')];
      for (const w of ordered) {
        const rec = w.assign_seq ? { ...w.record, seq: ++seq } : w.record;
        const cols = getTable(w.table).columns;
        if (w.op === 'insert') {
          await client.query(`INSERT INTO ${tableName(w.table)} (${cols.map((c) => c.name).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => paramValue(c, rec[c.name])));
        } else {
          const set = cols.filter((c) => c.name !== 'id');
          const res = await client.query(
            `UPDATE ${tableName(w.table)} SET ${set.map((c, i) => `${c.name} = $${i + 1}`).join(', ')} WHERE id = $${set.length + 1} AND version = $${set.length + 2}`,
            [...set.map((c) => paramValue(c, rec[c.name])), rec.id, w.expected_version],
          );
          if (res.rowCount !== 1) {
            const cur = (await client.query(`SELECT version FROM ${tableName(w.table)} WHERE id = $1`, [rec.id])).rows[0];
            throw new AppError('CONFLICT', cur ? `${w.table} version mismatch` : `${w.table} row missing`, { details: { entity: w.table, current_version: cur ? cur.version : null, expected_version: w.expected_version } });
          }
        }
      }
      await client.query('COMMIT');
      return { replayed: false, result: cs.result, committed_at: cs.prepared_at, seq };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
      throw mapPgError(e);
    } finally {
      client.release();
    }
  }

  /**
   * Single background worker across API instances: run fn only if this process holds the session-level
   * advisory lock (another instance's tick in progress → { skipped: true }). Jobs are additionally claimed
   * with version checks, so a lost lock can never run a job twice.
   */
  async withWorkerLock(fn) {
    let client;
    try { client = await this.pool.connect(); } catch (e) { throw mapPgError(e); }
    try {
      const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK])).rows[0].ok;
      if (!got) return { skipped: true };
      try { return await fn(); } finally { await client.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]); }
    } finally {
      client.release();
    }
  }

  async schemaVersion() {
    const r = await this._q("SELECT max(schema_version) AS v FROM schema_versions WHERE component = 'POSTGRES'");
    return r.rows[0].v === null ? null : Number(r.rows[0].v);
  }

  async ready() {
    const v = await this.schemaVersion();
    return { ok: v === SCHEMA_VERSION, schema_version: v };
  }
}

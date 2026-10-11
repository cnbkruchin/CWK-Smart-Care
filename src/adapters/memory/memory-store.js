// In-memory TableStore + MutationStore. Reference semantics for contract tests and fast
// application tests: atomic commit, version checks, unique keys (incl. partial), foreign keys,
// idempotency replay, maintenance mode and ChangeLog sequence.

import { TABLES, getTable, uniqueKeys } from '../../schema/index.js';
import { AppError } from '../../shared/errors.js';
import { applyListQuery, evalUniquePredicate, encodeCursor, decodeCursor, pageSize } from '../../shared/query.js';

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

export class MemoryStore {
  constructor() {
    this.tables = new Map(TABLES.map((t) => [t.name, new Map()]));
    this.partitionOf = new Map(TABLES.map((t) => [t.name, new Map()]));
    this.seq = 0;
    this.mode = 'NORMAL';
    this.commitCount = 0;
    this.failNextCommit = null; // test hook: Error to throw before applying
  }

  // ───────── TableStore ─────────
  get(table, id) {
    getTable(table);
    return clone(this.tables.get(table).get(id) || null);
  }

  getMany(table, ids) {
    const m = this.tables.get(table);
    const out = new Map();
    for (const id of ids) if (m.has(id)) out.set(id, clone(m.get(id)));
    return out;
  }

  _rows(table, partitions) {
    const rows = [...this.tables.get(table).values()];
    if (!partitions || partitions.includes('*')) return rows;
    const pm = this.partitionOf.get(table);
    return rows.filter((r) => partitions.includes(pm.get(r.id)));
  }

  findBy(table, column, value, opts = {}) {
    return this._rows(table, opts.partitions).filter((r) => r[column] === value).map(clone);
  }

  list(table, q = {}) {
    const page = applyListQuery(this._rows(table, q.partitions), q);
    return { items: page.items.map(clone), next_cursor: page.next_cursor };
  }

  scan(table, partition, { cursor = null, limit = 500 } = {}) {
    const rows = this._rows(table, partition === '*' ? null : [partition]);
    const c = decodeCursor(cursor);
    const start = c ? c.o : 0;
    const size = pageSize(limit);
    const items = rows.slice(start, start + size).map(clone);
    return { items, next_cursor: start + size < rows.length ? encodeCursor({ o: start + size }) : null };
  }

  partitions(table) {
    const t = getTable(table);
    if (t.partition !== 'TERM') return ['*'];
    const set = new Set(this.partitionOf.get(table).values());
    return [...set].sort().reverse();
  }

  /** Row count of a table, or of one partition ('*' = all rows). */
  count(table, partition = '*') {
    if (partition === '*' || partition === undefined) return this.tables.get(table).size;
    let n = 0;
    for (const p of this.partitionOf.get(table).values()) if (p === partition) n++;
    return n;
  }

  // ───────── import contract (portable package → new environment; see application/migration) ─────────
  /** Selected columns of every row (all partitions) — used to rebuild the import index. */
  importColumns(table, columns) {
    return [...this.tables.get(table).values()].map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
  }

  /** Append already-validated records verbatim (ids, versions, seq preserved). Refuses existing ids. */
  importAppend(table, partition, records) {
    getTable(table);
    const m = this.tables.get(table);
    for (const r of records) if (m.has(r.id)) throw new AppError('UNIQUE_VIOLATION', `${table} id exists`, { details: { entity: table, existing_id: r.id } });
    for (const r of records) {
      m.set(r.id, clone(r));
      this.partitionOf.get(table).set(r.id, partition);
      if (table === 'ChangeLog' && r.seq > this.seq) this.seq = r.seq;
    }
    return { inserted: records.length };
  }

  /** Apply newer versions of existing rows (delta/rollback import); expected_version must match. */
  importUpdate(table, _partition, updates) {
    const m = this.tables.get(table);
    for (const u of updates) {
      const cur = m.get(u.record.id);
      if (!cur || cur.version !== u.expected_version) throw new AppError('CONFLICT', `${table} version mismatch`, { details: { entity: table, current_version: cur ? cur.version : null, expected_version: u.expected_version } });
    }
    for (const u of updates) m.set(u.record.id, clone(u.record)); // partition unchanged (row stays where it was written)
    return { updated: updates.length };
  }

  /** Retention for the Jobs table (same contract as the Sheets store). */
  purgeWhere(table, where) {
    if (table !== 'Jobs') throw new AppError('VALIDATION_ERROR', 'purgeWhere is limited to the Jobs table');
    let n = 0;
    for (const [id, r] of [...this.tables.get(table).entries()]) {
      if (!applyListQuery([r], { where, limit: 1 }).items.length) continue;
      this.tables.get(table).delete(id);
      this.partitionOf.get(table).delete(id);
      n++;
    }
    return n;
  }

  /** Retention: drop all rows of one TERM partition (same contract as the Sheets store). */
  purgePartition(table, partition) {
    if (getTable(table).partition !== 'TERM' || partition === '*') throw new AppError('VALIDATION_ERROR', 'only TERM partitions can be purged');
    let n = 0;
    for (const [id, p] of [...this.partitionOf.get(table).entries()]) {
      if (p !== partition) continue;
      this.tables.get(table).delete(id);
      this.partitionOf.get(table).delete(id);
      n++;
    }
    return n;
  }

  // ───────── MutationStore ─────────
  commit(cs) {
    if (this.mode === 'READ_ONLY' && !cs.maintenance_allowed) {
      throw new AppError('MAINTENANCE_MODE', 'read-only mode');
    }
    if (cs.idempotency) {
      const existing = [...this.tables.get('IdempotencyRecords').values()].find((r) => r.scope_key === cs.idempotency.scope_key);
      if (existing) {
        if (existing.request_hash !== cs.idempotency.request_hash) throw new AppError('DUPLICATE_REQUEST_MISMATCH', 'idempotency key reused with different payload');
        return { replayed: true, result: clone(existing.result_json), committed_at: existing.created_at };
      }
    }
    const baseWrites = cs.idempotency ? [...cs.writes, { table: 'IdempotencyRecords', op: 'insert', partition: cs.idempotency.partition, record: cs.idempotency.record, expected_version: null }] : cs.writes;
    // assign the ChangeLog sequence BEFORE unique checks (seq is unique)
    let nextSeq = this.seq;
    const writes = baseWrites.map((w) => (w.assign_seq ? { ...w, record: { ...w.record, seq: ++nextSeq } } : w));
    const staged = new Map(); // table|id → record (post-image) for this change set
    for (const w of writes) {
      const m = this.tables.get(w.table);
      const cur = m.get(w.record.id);
      if (w.op === 'insert') {
        if (cur) throw new AppError('UNIQUE_VIOLATION', `${w.table} id exists`, { details: { entity: w.table, existing_id: w.record.id } });
      } else {
        if (!cur) throw new AppError('CONFLICT', `${w.table} row missing`, { details: { entity: w.table } });
        if (cur.version !== w.expected_version) {
          throw new AppError('CONFLICT', `${w.table} version mismatch`, { details: { entity: w.table, current_version: cur.version, expected_version: w.expected_version } });
        }
      }
      staged.set(`${w.table}|${w.record.id}`, w.record);
    }
    // unique keys against post-image (existing rows overlaid with staged ones)
    for (const w of writes) {
      for (const u of uniqueKeys(w.table)) {
        if (!evalUniquePredicate(u.where, w.record)) continue;
        if (!u.nullsNotDistinct && u.columns.some((c) => w.record[c] === null || w.record[c] === undefined)) continue;
        const key = u.columns.map((c) => JSON.stringify(w.record[c] ?? null)).join('|');
        const candidates = new Map();
        for (const r of this.tables.get(w.table).values()) candidates.set(r.id, r);
        for (const [k, r] of staged) if (k.startsWith(`${w.table}|`)) candidates.set(r.id, r);
        for (const r of candidates.values()) {
          if (r.id === w.record.id || !evalUniquePredicate(u.where, r)) continue;
          if (u.columns.map((c) => JSON.stringify(r[c] ?? null)).join('|') === key) {
            throw new AppError('UNIQUE_VIOLATION', `${w.table} unique (${u.columns.join(',')})`, { details: { entity: w.table, existing_id: r.id } });
          }
        }
      }
    }
    // foreign keys
    for (const w of writes) {
      for (const c of getTable(w.table).columns) {
        const v = w.record[c.name];
        if (!c.fk || v === null || v === undefined) continue;
        if (!this.tables.get(c.fk).has(v) && !staged.has(`${c.fk}|${v}`)) {
          throw new AppError('VALIDATION_ERROR', `${w.table}.${c.name} references missing ${c.fk}`, { details: { entity: w.table } });
        }
      }
    }
    if (this.failNextCommit) {
      const e = this.failNextCommit;
      this.failNextCommit = null;
      throw e;
    }
    this.seq = nextSeq;
    for (const w of writes) {
      const rec = clone(w.record);
      this.tables.get(w.table).set(rec.id, rec);
      this.partitionOf.get(w.table).set(rec.id, w.partition);
    }
    this.commitCount++;
    return { replayed: false, result: clone(cs.result), committed_at: cs.prepared_at, seq: this.seq };
  }

  /** Test/seed helper: insert rows without a change set (still validated by callers). */
  seed(table, records, partition = '*') {
    for (const r of records) {
      this.tables.get(table).set(r.id, clone(r));
      this.partitionOf.get(table).set(r.id, partition);
    }
  }
}

// Google Sheets TableStore + MutationStore (DECISIONS D-005, D-006, D-007).
// All writes enter through commit() under LockService.getScriptLock(): idempotency, expected versions,
// unique keys and foreign keys are checked under the lock; the write-set is journaled (PREPARED) before
// being applied and marked COMMITTED afterwards. recoverPending() rolls forward PREPARED operations.
// Rows are located by logical id via TextFinder — row numbers are never business identifiers.

import { TABLES, getTable, uniqueKeys } from '../../schema/index.js';
import { AppError } from '../../shared/errors.js';
import { applyListQuery, evalUniquePredicate, matchesWhere, encodeCursor, decodeCursor, pageSize } from '../../shared/query.js';
import { encodeRow, decodeRow, decodeCell, headerOf } from './sheets-codec.js';
import { schoolDateOf } from '../../shared/time.js';
import { partitionKeyForDate } from '../../domain/calendar.js';

const G = () => globalThis;
const JOURNAL_PART_CHARS = 45000;
const WORKBOOK_GROUP = { OPS: 'Ops', DAILY: 'Daily', NOTIFY: 'Notify' };

export class SheetsStore {
  /**
   * @param {{masterId:string, env:string, rootFolderId?:string|null, tz?:string, clock, ids, logger?, lockTimeoutMs?:number}} o
   */
  constructor(o) {
    if (!o.masterId) throw new AppError('CONFIGURATION_REQUIRED', 'CWK_MASTER_SPREADSHEET_ID missing', { messageTh: 'ยังไม่ได้ติดตั้งฐานข้อมูล (รัน adminSetup)' });
    this.masterId = o.masterId;
    this.env = o.env || 'DEV';
    this.rootFolderId = o.rootFolderId || null;
    this.tz = o.tz || 'Asia/Bangkok';
    this.clock = o.clock;
    this.ids = o.ids;
    this.logger = o.logger || { error() {}, info() {} };
    this.lockTimeoutMs = o.lockTimeoutMs || 10000;
    this._books = new Map();
    this._sheets = new Map();
    this._catalog = null;
    this._fkMemo = new Set();
    this.lastLockWaitMs = 0;
    this.faults = null; // test hook: { crashAfter: 'journal' | 'apply:<n>' }
    this.propertyReader = o.propertyReader || null;
  }

  // ───────── catalog & sheets ─────────
  _book(id) {
    if (!this._books.has(id)) {
      try { this._books.set(id, G().SpreadsheetApp.openById(id)); } catch (e) { throw new AppError('STORAGE_UNAVAILABLE', `cannot open workbook: ${e && e.message}`); }
    }
    return this._books.get(id);
  }

  catalog() {
    if (this._catalog) return this._catalog;
    const sh = this._book(this.masterId).getSheetByName('StorageCatalog');
    if (!sh) throw new AppError('CONFIGURATION_REQUIRED', 'StorageCatalog sheet missing', { messageTh: 'ไม่พบ StorageCatalog (รัน adminSetup)' });
    const m = new Map();
    const last = sh.getLastRow();
    if (last >= 2) {
      const values = sh.getRange(2, 1, last - 1, headerOf('StorageCatalog').length).getValues();
      for (const row of values) {
        const r = decodeRow('StorageCatalog', row);
        if (r.id) m.set(`${r.logical_table}|${r.partition_key}`, r);
      }
    }
    this._catalog = m;
    return m;
  }

  _entry(table, partition) {
    return this.catalog().get(`${table}|${partition}`) || null;
  }

  _sheet(table, partition) {
    const key = `${table}|${partition}`;
    if (this._sheets.has(key)) return this._sheets.get(key);
    const e = this._entry(table, partition);
    if (!e) return null;
    const sh = this._book(e.workbook_id).getSheetByName(e.sheet_name);
    if (!sh) throw new AppError('STORAGE_UNAVAILABLE', `sheet ${e.sheet_name} missing`);
    const header = sh.getRange(1, 1, 1, headerOf(table).length).getValues()[0].map(String);
    const expected = headerOf(table);
    if (header.join('|') !== expected.join('|')) {
      this.logger.error({ event: 'schema_drift', table, partition });
      throw new AppError('STORAGE_UNAVAILABLE', `header drift in ${table}/${partition}`, { messageTh: 'โครงสร้างชีตไม่ตรงกับ schema — ผู้ดูแลต้องตรวจด้วย adminSchemaCheck' });
    }
    this._sheets.set(key, sh);
    return sh;
  }

  partitions(table) {
    const t = getTable(table);
    if (t.partition !== 'TERM') return ['*'];
    const keys = [];
    for (const e of this.catalog().values()) if (e.logical_table === table) keys.push(e.partition_key);
    return keys.sort().reverse();
  }

  _parts(table, opts) {
    const all = this.partitions(table);
    if (opts && opts.partitions && !opts.partitions.includes('*')) return all.filter((p) => opts.partitions.includes(p));
    return all;
  }

  /** Partition for a record of a TERM table, using Terms rows read from the master workbook. */
  partitionOf(table, record) {
    const t = getTable(table);
    if (t.partition !== 'TERM') return '*';
    const col = t.columns.find((c) => c.name === t.partitionColumn);
    const v = record[t.partitionColumn];
    const date = col.type === 'date' ? v : schoolDateOf(v, this.tz);
    return partitionKeyForDate(this._terms(), date);
  }

  _terms() {
    if (!this.__terms) this.__terms = this._readAll('Terms', '*').map((x) => x.rec);
    return this.__terms;
  }

  // ───────── low-level reads ─────────
  _readAll(table, partition) {
    const sh = this._sheet(table, partition);
    if (!sh) return [];
    const last = sh.getLastRow();
    if (last < 2) return [];
    const n = headerOf(table).length;
    const values = sh.getRange(2, 1, last - 1, n).getValues();
    const out = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === '' || values[i][0] === null) continue;
      out.push({ row: i + 2, rec: decodeRow(table, values[i]) });
    }
    return out;
  }

  _colIndex(table, column) {
    const i = headerOf(table).indexOf(column);
    if (i < 0) throw new AppError('INTERNAL_ERROR', `unknown column ${table}.${column}`);
    return i + 1;
  }

  /** Row numbers whose `column` cell equals `value` exactly (TextFinder, case-sensitive, entire cell). */
  _findRows(table, partition, column, value) {
    const sh = this._sheet(table, partition);
    if (!sh) return [];
    const last = sh.getLastRow();
    if (last < 2 || value === null || value === undefined) return [];
    const col = this._colIndex(table, column);
    const needle = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
    const ranges = sh.getRange(2, col, last - 1, 1).createTextFinder(needle).matchEntireCell(true).matchCase(true).findAll();
    return ranges.map((r) => r.getRow());
  }

  _findRowsIn(table, partition, column, values) {
    const sh = this._sheet(table, partition);
    if (!sh || !values.length) return [];
    const last = sh.getLastRow();
    if (last < 2) return [];
    const col = this._colIndex(table, column);
    const rows = [];
    for (let i = 0; i < values.length; i += 40) {
      const chunk = values.slice(i, i + 40).map((v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const re = `^(?:${chunk.join('|')})$`;
      for (const r of sh.getRange(2, col, last - 1, 1).createTextFinder(re).useRegularExpression(true).matchCase(true).matchEntireCell(true).findAll()) rows.push(r.getRow());
    }
    return rows;
  }

  /** Read rows by number, grouping contiguous runs into single range reads. */
  _readRows(table, partition, rowNumbers) {
    const sh = this._sheet(table, partition);
    if (!sh || !rowNumbers.length) return [];
    const n = headerOf(table).length;
    const sorted = [...new Set(rowNumbers)].sort((a, b) => a - b);
    const out = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1 && j - i < 999) j++;
      // read the span; if rows are sparse but close, read a little extra instead of many calls
      const start = sorted[i];
      const values = sh.getRange(start, 1, sorted[j] - start + 1, n).getValues();
      for (let k = 0; k < values.length; k++) out.push({ row: start + k, rec: decodeRow(table, values[k]) });
      i = j + 1;
    }
    return out;
  }

  _locate(table, partition, id) {
    const rows = this._findRows(table, partition, 'id', id);
    if (!rows.length) return null;
    const hits = this._readRows(table, partition, rows).filter((x) => x.rec.id === id);
    if (hits.length > 1) throw new AppError('INTEGRITY_ERROR', `duplicate id ${id} in ${table}/${partition}`);
    return hits[0] || null;
  }

  // ───────── TableStore ─────────
  get(table, id, opts) {
    for (const p of this._parts(table, opts)) {
      const hit = this._locate(table, p, id);
      if (hit) return hit.rec;
    }
    return null;
  }

  getMany(table, ids, opts) {
    const out = new Map();
    const want = [...new Set(ids)];
    if (!want.length) return out;
    for (const p of this._parts(table, opts)) {
      const rows = this._findRowsIn(table, p, 'id', want.filter((x) => !out.has(x)));
      for (const x of this._readRows(table, p, rows)) if (want.includes(x.rec.id)) out.set(x.rec.id, x.rec);
      if (out.size === want.length) break;
    }
    return out;
  }

  findBy(table, column, value, opts) {
    const out = [];
    for (const p of this._parts(table, opts)) {
      const rows = this._findRows(table, p, column, value);
      for (const x of this._readRows(table, p, rows)) if (x.rec[column] === value) out.push(x.rec);
    }
    return out;
  }

  list(table, q = {}) {
    const t = getTable(table);
    const where = q.where || {};
    const lookupCols = ['id', ...(t.lookup || [])];
    let narrow = null;
    for (const c of lookupCols) {
      const cond = where[c];
      if (cond !== undefined && cond !== null && (typeof cond !== 'object' || Array.isArray(cond.in))) { narrow = [c, cond]; break; }
    }
    let records = [];
    for (const p of this._parts(table, q)) {
      if (narrow) {
        const [c, cond] = narrow;
        const rows = typeof cond === 'object' ? this._findRowsIn(table, p, c, cond.in) : this._findRows(table, p, c, cond);
        records = records.concat(this._readRows(table, p, rows).map((x) => x.rec).filter((r) => matchesWhere(r, where)));
      } else {
        records = records.concat(this._readAll(table, p).map((x) => x.rec).filter((r) => matchesWhere(r, where)));
      }
    }
    return applyListQuery(records, { ...q, where: null });
  }

  scan(table, partition, { cursor = null, limit = 500 } = {}) {
    const sh = this._sheet(table, partition);
    if (!sh) return { items: [], next_cursor: null };
    const last = sh.getLastRow();
    const c = decodeCursor(cursor);
    const start = c ? c.r : 2;
    const size = pageSize(limit);
    if (start > last) return { items: [], next_cursor: null };
    const count = Math.min(size, last - start + 1);
    const values = sh.getRange(start, 1, count, headerOf(table).length).getValues();
    const items = values.filter((v) => v[0] !== '').map((v) => decodeRow(table, v));
    return { items, next_cursor: start + count <= last ? encodeCursor({ r: start + count }) : null, last_row: last };
  }

  count(table, partition) {
    const sh = this._sheet(table, partition);
    return sh ? Math.max(0, sh.getLastRow() - 1) : 0;
  }

  // ───────── import contract (portable package → new environment; see application/migration) ─────────
  /** Selected columns of every row in every partition; reads one column range per column. */
  importColumns(table, columns) {
    const out = [];
    for (const p of this.partitions(table)) {
      const sh = this._sheet(table, p);
      if (!sh) continue;
      const last = sh.getLastRow();
      if (last < 2) continue;
      const defs = columns.map((c) => getTable(table).columns.find((x) => x.name === c));
      const cols = columns.map((c) => sh.getRange(2, this._colIndex(table, c), last - 1, 1).getValues().map((v) => v[0]));
      const ids = cols[columns.indexOf('id')];
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === '' || ids[i] === null) continue;
        const row = {};
        columns.forEach((c, k) => { row[c] = decodeCell(defs[k], cols[k][i]); });
        out.push(row);
      }
    }
    return out;
  }

  /** Append already-validated records verbatim into one partition (provisioned on demand), under the lock. */
  importAppend(table, partition, records) {
    if (!records.length) return { inserted: 0 };
    return this.withLock(() => {
      this._catalog = null;
      this._sheets.clear();
      this._ensurePartition(table, partition);
      this._appendRows(table, partition, records);
      G().SpreadsheetApp.flush();
      return { inserted: records.length };
    });
  }

  /** Apply newer versions of existing rows (delta/rollback import); expected_version must match. */
  importUpdate(table, partition, updates) {
    return this.withLock(() => {
      this._catalog = null;
      this._sheets.clear();
      const located = [];
      for (const u of updates) {
        // the row stays in the partition where it was first written (may differ from the sender's view)
        let hit = null;
        let where = null;
        for (const p of [partition, ...this.partitions(table).filter((x) => x !== partition)]) {
          hit = this._locate(table, p, u.record.id);
          if (hit) { where = p; break; }
        }
        if (!hit || hit.rec.version !== u.expected_version) throw new AppError('CONFLICT', `${table} version mismatch`, { details: { entity: table, current_version: hit ? hit.rec.version : null, expected_version: u.expected_version } });
        located.push([where, hit.row, u.record]);
      }
      for (const [p, row, rec] of located) this._sheet(table, p).getRange(row, 1, 1, headerOf(table).length).setValues([encodeRow(table, rec)]);
      G().SpreadsheetApp.flush();
      return { updated: updates.length };
    });
  }

  // ───────── MutationStore ─────────
  _systemMode() {
    if (this.propertyReader) return this.propertyReader('CWK_SYSTEM_MODE') || 'NORMAL';
    return G().PropertiesService.getScriptProperties().getProperty('CWK_SYSTEM_MODE') || 'NORMAL';
  }

  /**
   * Retention: clear every data row of one TERM partition of an operational table (header kept).
   * Runs under the script lock; the caller (retention.purge) checks policy/eligibility and audits.
   */
  purgePartition(table, partition) {
    if (getTable(table).partition !== 'TERM' || partition === '*') throw new AppError('VALIDATION_ERROR', 'only TERM partitions can be purged');
    return this.withLock(() => {
      this._catalog = null;
      this._sheets.clear();
      const sh = this._sheet(table, partition);
      if (!sh) return 0;
      const n = Math.max(0, sh.getLastRow() - 1);
      if (n > 0) sh.deleteRows(2, n);
      return n;
    });
  }

  /**
   * Retention for small non-partitioned operational tables (Jobs): rewrite the sheet without the rows
   * matching `where`, under the script lock. Returns the number of rows removed.
   */
  purgeWhere(table, where) {
    if (table !== 'Jobs') throw new AppError('VALIDATION_ERROR', 'purgeWhere is limited to the Jobs table');
    return this.withLock(() => {
      this._catalog = null;
      this._sheets.clear();
      const sh = this._sheet(table, '*');
      const rows = this._readAll(table, '*');
      const keep = rows.filter((x) => !matchesWhere(x.rec, where)).map((x) => encodeRow(table, x.rec));
      const removed = rows.length - keep.length;
      if (!removed) return 0;
      const last = sh.getLastRow();
      if (last >= 2) sh.deleteRows(2, last - 1);
      if (keep.length) sh.getRange(2, 1, keep.length, headerOf(table).length).setValues(keep);
      return removed;
    });
  }

  withLock(fn) {
    const lock = G().LockService.getScriptLock();
    const t0 = Date.now();
    if (!lock.tryLock(this.lockTimeoutMs)) throw new AppError('LOCK_TIMEOUT', 'script lock timeout');
    this.lastLockWaitMs = Date.now() - t0;
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }

  commit(cs) {
    return this.withLock(() => {
      // fresh view inside the lock
      this._catalog = null;
      this._sheets.clear();
      this.__terms = null;
      if (this._systemMode() === 'READ_ONLY' && !cs.maintenance_allowed) throw new AppError('MAINTENANCE_MODE', 'read-only mode');
      this.recoverPending();
      if (cs.idempotency) {
        const prior = this.findBy('IdempotencyRecords', 'scope_key', cs.idempotency.scope_key);
        if (prior.length) {
          if (prior[0].request_hash !== cs.idempotency.request_hash) throw new AppError('DUPLICATE_REQUEST_MISMATCH', 'idempotency key reused with different payload');
          return { replayed: true, result: prior[0].result_json, committed_at: prior[0].created_at };
        }
      }
      const writes = cs.idempotency ? [...cs.writes, { table: 'IdempotencyRecords', op: 'insert', partition: cs.idempotency.partition, record: cs.idempotency.record, expected_version: null }] : cs.writes.slice();
      // partitions are recomputed against the stored Terms (authoritative under the lock)
      for (const w of writes) w.partition = this.partitionOf(w.table, w.record);
      this._ensurePartitionsFor(writes);
      const located = this._checkVersions(writes);
      this._checkUnique(writes);
      this._checkForeignKeys(writes);
      let seq = null;
      for (const w of writes) {
        if (w.assign_seq) {
          seq = this._nextSeq();
          w.record = { ...w.record, seq };
        }
      }
      const journal = this._journalPrepare(cs, writes);
      if (this.faults && this.faults.crashAfter === 'journal') throw new Error('SIMULATED_CRASH after journal');
      this._apply(writes, located);
      G().SpreadsheetApp.flush();
      this._journalMark(journal, 'COMMITTED', { committed_at: this.clock.now() });
      G().SpreadsheetApp.flush();
      return { replayed: false, result: cs.result, committed_at: cs.prepared_at, seq, lock_wait_ms: this.lastLockWaitMs };
    });
  }

  _checkVersions(writes) {
    const located = new Map();
    for (const w of writes) {
      const hit = this._locate(w.table, w.partition, w.record.id);
      if (w.op === 'insert') {
        if (hit) throw new AppError('UNIQUE_VIOLATION', `${w.table} id exists`, { details: { entity: w.table, existing_id: w.record.id } });
      } else {
        if (!hit) throw new AppError('CONFLICT', `${w.table} row missing`, { details: { entity: w.table } });
        if (hit.rec.version !== w.expected_version) throw new AppError('CONFLICT', `${w.table} version mismatch`, { details: { entity: w.table, current_version: hit.rec.version, expected_version: w.expected_version } });
        located.set(`${w.table}|${w.record.id}`, hit.row);
      }
    }
    return located;
  }

  _checkUnique(writes) {
    for (const w of writes) {
      for (const u of uniqueKeys(w.table)) {
        if (u.columns.includes('seq')) continue; // assigned under this lock, monotonic
        if (!evalUniquePredicate(u.where, w.record)) continue;
        if (!u.nullsNotDistinct && u.columns.some((c) => w.record[c] === null || w.record[c] === undefined)) continue;
        const key = u.columns.map((c) => JSON.stringify(w.record[c] ?? null)).join('|');
        for (const o of writes) {
          if (o === w || o.table !== w.table || !evalUniquePredicate(u.where, o.record)) continue;
          if (u.columns.map((c) => JSON.stringify(o.record[c] ?? null)).join('|') === key) throw new AppError('UNIQUE_VIOLATION', `${w.table} unique (${u.columns.join(',')}) within change set`);
        }
        const probe = u.columns.find((c) => w.record[c] !== null && w.record[c] !== undefined);
        if (!probe) continue;
        for (const p of this.partitions(w.table)) {
          const rows = this._findRows(w.table, p, probe, w.record[probe]);
          for (const x of this._readRows(w.table, p, rows)) {
            if (x.rec.id === w.record.id || !evalUniquePredicate(u.where, x.rec)) continue;
            const pending = writes.find((o) => o.table === w.table && o.record.id === x.rec.id);
            const current = pending ? pending.record : x.rec;
            if (!evalUniquePredicate(u.where, current)) continue;
            if (u.columns.map((c) => JSON.stringify(current[c] ?? null)).join('|') === key) {
              throw new AppError('UNIQUE_VIOLATION', `${w.table} unique (${u.columns.join(',')})`, { details: { entity: w.table, existing_id: x.rec.id } });
            }
          }
        }
      }
    }
  }

  _checkForeignKeys(writes) {
    const staged = new Set(writes.map((w) => `${w.table}|${w.record.id}`));
    for (const w of writes) {
      for (const c of getTable(w.table).columns) {
        const v = w.record[c.name];
        if (!c.fk || v === null || v === undefined) continue;
        const k = `${c.fk}|${v}`;
        if (staged.has(k) || this._fkMemo.has(k)) continue;
        if (!this.get(c.fk, v)) throw new AppError('VALIDATION_ERROR', `${w.table}.${c.name} references missing ${c.fk}`, { details: { entity: w.table } });
        this._fkMemo.add(k); // rows are never hard-deleted by the application
      }
    }
  }

  _nextSeq() {
    let best = 0;
    for (const p of this.partitions('ChangeLog')) {
      const sh = this._sheet('ChangeLog', p);
      const last = sh ? sh.getLastRow() : 1;
      if (last >= 2) {
        const v = sh.getRange(last, this._colIndex('ChangeLog', 'seq'), 1, 1).getValues()[0][0];
        if (typeof v === 'number' && v > best) best = v;
      }
    }
    return best + 1;
  }

  _appendRows(table, partition, records) {
    const sh = this._sheet(table, partition);
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, records.length, headerOf(table).length).setValues(records.map((r) => encodeRow(table, r)));
    return start;
  }

  _apply(writes, located) {
    const inserts = new Map();
    let n = 0;
    for (const w of writes) {
      if (w.op === 'insert') {
        const k = `${w.table}|${w.partition}`;
        if (!inserts.has(k)) inserts.set(k, { table: w.table, partition: w.partition, records: [] });
        inserts.get(k).records.push(w.record);
      } else {
        const row = located.get(`${w.table}|${w.record.id}`);
        this._sheet(w.table, w.partition).getRange(row, 1, 1, headerOf(w.table).length).setValues([encodeRow(w.table, w.record)]);
        if (this.faults && this.faults.crashAfter === `apply:${++n}`) throw new Error('SIMULATED_CRASH during apply');
      }
    }
    for (const g of inserts.values()) {
      this._appendRows(g.table, g.partition, g.records);
      if (this.faults && this.faults.crashAfter === `apply:${++n}`) throw new Error('SIMULATED_CRASH during apply');
    }
  }

  // ───────── journal ─────────
  _journalPartition(cs) {
    return this.partitionOf('MutationJournal', { prepared_at: cs.prepared_at });
  }

  _journalPrepare(cs, writes) {
    const payload = JSON.stringify({ writes: writes.map((w) => ({ table: w.table, op: w.op, partition: w.partition, record: w.record, expected_version: w.expected_version })) });
    const parts = [];
    for (let i = 0; i < payload.length; i += JOURNAL_PART_CHARS) parts.push(payload.slice(i, i + JOURNAL_PART_CHARS));
    if (!parts.length) parts.push('');
    const partition = this._journalPartition(cs);
    this._ensurePartition('MutationJournal', partition);
    const now = this.clock.now();
    const rows = parts.map((p, i) => ({
      id: this.ids.uuid(), operation_id: cs.operation_id, operation: cs.operation, actor_id: cs.actor_id, request_id: cs.request_id, status: 'PREPARED',
      part_no: i + 1, part_count: parts.length, writes_json: p, prepared_at: cs.prepared_at, committed_at: null, recovered_at: null, recovery_attempts: 0, last_error: null,
      created_at: now, created_by: cs.actor_id, updated_at: now, updated_by: cs.actor_id, version: 1,
    }));
    const start = this._appendRows('MutationJournal', partition, rows);
    G().SpreadsheetApp.flush();
    return { partition, start, count: rows.length };
  }

  _journalMark(j, status, extra = {}) {
    const sh = this._sheet('MutationJournal', j.partition);
    const statusCol = this._colIndex('MutationJournal', 'status');
    sh.getRange(j.start, statusCol, j.count, 1).setValues(Array.from({ length: j.count }, () => [`'${status}`]));
    if (extra.committed_at) sh.getRange(j.start, this._colIndex('MutationJournal', 'committed_at'), j.count, 1).setValues(Array.from({ length: j.count }, () => [`'${extra.committed_at}`]));
    if (extra.recovered_at) sh.getRange(j.start, this._colIndex('MutationJournal', 'recovered_at'), j.count, 1).setValues(Array.from({ length: j.count }, () => [`'${extra.recovered_at}`]));
    if (extra.last_error) sh.getRange(j.start, this._colIndex('MutationJournal', 'last_error'), j.count, 1).setValues(Array.from({ length: j.count }, () => [`'${String(extra.last_error).slice(0, 480)}`]));
  }

  /** Roll forward PREPARED operations (must hold the script lock). Returns a summary. */
  recoverPending() {
    const summary = { recovered: 0, aborted: 0, recovery_required: 0 };
    const parts = this.partitions('MutationJournal').slice(0, 2);
    for (const p of parts) {
      const rows = this._findRows('MutationJournal', p, 'status', 'PREPARED');
      if (!rows.length) continue;
      const entries = this._readRows('MutationJournal', p, rows).filter((x) => x.rec.status === 'PREPARED');
      const byOp = new Map();
      for (const e of entries) {
        if (!byOp.has(e.rec.operation_id)) byOp.set(e.rec.operation_id, []);
        byOp.get(e.rec.operation_id).push(e);
      }
      for (const [opId, list] of byOp) {
        list.sort((a, b) => a.rec.part_no - b.rec.part_no);
        const start = list[0].row;
        const j = { partition: p, start, count: list.length };
        const contiguous = list.every((e, i) => e.row === start + i);
        if (list.length !== list[0].rec.part_count || !contiguous) {
          if (contiguous) this._journalMark(j, 'ABORTED', { last_error: 'incomplete journal; nothing applied' });
          summary.aborted++;
          continue;
        }
        let payload;
        try { payload = JSON.parse(list.map((e) => e.rec.writes_json || '').join('')); } catch (e) {
          this._journalMark(j, 'RECOVERY_REQUIRED', { last_error: 'journal parse error' });
          summary.recovery_required++;
          continue;
        }
        try {
          this._replay(payload.writes);
          G().SpreadsheetApp.flush();
          this._journalMark(j, 'COMMITTED', { committed_at: this.clock.now(), recovered_at: this.clock.now() });
          summary.recovered++;
          this.logger.info({ event: 'journal_recovered', operation_id: opId });
        } catch (e) {
          this._journalMark(j, 'RECOVERY_REQUIRED', { last_error: e && e.message ? e.message : String(e) });
          summary.recovery_required++;
          this.logger.error({ event: 'journal_recovery_required', operation_id: opId, message: e && e.message });
        }
      }
    }
    return summary;
  }

  _replay(writes) {
    for (const w of writes) {
      this._ensurePartition(w.table, w.partition);
      const hit = this._locate(w.table, w.partition, w.record.id);
      if (w.op === 'insert') {
        if (!hit) this._appendRows(w.table, w.partition, [w.record]);
        else if ((hit.rec.version || 1) !== (w.record.version || 1)) throw new Error(`replay insert ${w.table}/${w.record.id}: row exists with different version`);
      } else if (!hit) {
        throw new Error(`replay update ${w.table}/${w.record.id}: row missing`);
      } else if (hit.rec.version === w.record.version) {
        // already applied
      } else if (hit.rec.version === w.expected_version) {
        this._sheet(w.table, w.partition).getRange(hit.row, 1, 1, headerOf(w.table).length).setValues([encodeRow(w.table, w.record)]);
      } else {
        throw new Error(`replay update ${w.table}/${w.record.id}: version ${hit.rec.version} neither ${w.expected_version} nor ${w.record.version}`);
      }
    }
  }

  journalStatus() {
    const out = { PREPARED: 0, RECOVERY_REQUIRED: 0 };
    for (const p of this.partitions('MutationJournal').slice(0, 2)) {
      out.PREPARED += this._findRows('MutationJournal', p, 'status', 'PREPARED').length;
      out.RECOVERY_REQUIRED += this._findRows('MutationJournal', p, 'status', 'RECOVERY_REQUIRED').length;
    }
    return out;
  }

  // ───────── partition provisioning ─────────
  _ensurePartitionsFor(writes) {
    for (const w of writes) this._ensurePartition(w.table, w.partition);
  }

  _ensurePartition(table, partition) {
    if (this._entry(table, partition)) return;
    const t = getTable(table);
    if (t.partition !== 'TERM') throw new AppError('STORAGE_UNAVAILABLE', `table ${table} not provisioned`, { messageTh: 'ชีตข้อมูลยังไม่ถูกสร้าง (รัน adminSetup)' });
    this.provisionPartition(partition);
  }

  /** Create the Ops/Daily/Notify workbooks of a term partition and register them (idempotent). */
  provisionPartition(partition) {
    const groups = {};
    for (const t of TABLES.filter((x) => x.partition === 'TERM')) {
      if (!groups[t.workbook]) groups[t.workbook] = [];
      groups[t.workbook].push(t.name);
    }
    const now = this.clock.now();
    const catalogRows = [];
    for (const [wb, tables] of Object.entries(groups)) {
      const missing = tables.filter((n) => !this._entry(n, partition));
      if (!missing.length) continue;
      const existing = tables.map((n) => this._entry(n, partition)).find(Boolean);
      const book = existing ? this._book(existing.workbook_id) : createWorkbook(`CWK-${this.env}-${WORKBOOK_GROUP[wb]}-${partition}`, this.rootFolderId, this.tz);
      for (const name of missing) {
        ensureSheet(book, name);
        catalogRows.push({
          id: this.ids.uuid(), logical_table: name, partition_key: partition, workbook_id: book.getId(), sheet_name: name, schema_version: 1, status: 'ACTIVE',
          row_count: 0, cell_count: 0, measured_at: now, created_at: now, created_by: '00000000-0000-4000-8000-000000000001', updated_at: now, updated_by: '00000000-0000-4000-8000-000000000001', version: 1,
        });
      }
      removeDefaultSheet(book);
    }
    if (catalogRows.length) {
      const sh = this._book(this.masterId).getSheetByName('StorageCatalog');
      sh.getRange(sh.getLastRow() + 1, 1, catalogRows.length, headerOf('StorageCatalog').length).setValues(catalogRows.map((r) => encodeRow('StorageCatalog', r)));
      G().SpreadsheetApp.flush();
      this._catalog = null;
    }
    return catalogRows.length;
  }
}

export function createWorkbook(name, folderId, tz) {
  const g = G();
  const book = g.SpreadsheetApp.create(name);
  book.setSpreadsheetTimeZone(tz || 'Asia/Bangkok');
  if (folderId) {
    const file = g.DriveApp.getFileById(book.getId());
    file.moveTo(g.DriveApp.getFolderById(folderId));
  }
  return book;
}

export function ensureSheet(book, tableName) {
  let sh = book.getSheetByName(tableName);
  const header = headerOf(tableName);
  if (!sh) {
    sh = book.insertSheet(tableName);
    sh.getRange(1, 1, 1, header.length).setValues([header.map((h) => `'${h}`)]);
    sh.setFrozenRows(1);
  } else {
    const current = sh.getRange(1, 1, 1, header.length).getValues()[0].map(String);
    if (current.every((x) => x === '')) {
      sh.getRange(1, 1, 1, header.length).setValues([header.map((h) => `'${h}`)]);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

export function removeDefaultSheet(book) {
  for (const name of ['Sheet1', 'แผ่น1', 'ชีต1']) {
    const s = book.getSheetByName(name);
    if (s && book.getSheets().length > 1) book.deleteSheet(s);
  }
}

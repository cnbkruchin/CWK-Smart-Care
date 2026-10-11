// Sinks for processPackage():
//   IndexSink  — validation only: keeps IDs/unique keys in memory, writes nothing.
//   StoreSink  — import into a TableStore that implements the import contract (MemoryStore, SheetsStore):
//                importColumns(table, columns), getMany(table, ids, {partitions}), importAppend(table,
//                partition, records), importUpdate(table, partition, records) and AttachmentStorage put/get.
// The import target is a NEW, empty environment by default; existing identical rows are skipped
// (idempotent re-import), different rows are conflicts (rejected unless the policy is APPLY_NEWER for deltas).
import { getTable, uniqueKeys } from '../../schema/index.js';
import { uniqueKeyOf } from './process.js';
import { canonicalRecord } from './format.js';
import { SYSTEM_USER_ID } from '../../shared/uuid.js';

function predicateColumns(table) {
  const cols = new Set();
  for (const u of uniqueKeys(table)) {
    for (const c of u.columns) cols.add(c);
    if (u.where) { const m = /^(\w+)/.exec(u.where.trim()); if (m) cols.add(m[1]); }
  }
  return [...cols];
}

export class IndexSink {
  constructor() {
    this.name = 'validate';
    this.mode = 'VALIDATE';
    this.conflictPolicy = 'REJECT';
    this.attachmentsSeen = [];
  }
  *append(table, _partition, records) {
    if (table === 'Attachments') for (const r of records) this.attachmentsSeen.push({ id: r.id, sha256: r.sha256, size_bytes: r.size_bytes, status: r.status });
    return { inserted: 0 };
  }
  *attachmentRows() { return this.attachmentsSeen; }
}

/** Read every row of a table through TableStore.scan (all partitions). */
export function* scanAll(store, table) {
  const out = [];
  for (const p of yield store.partitions(table)) {
    let cursor = null;
    do {
      const page = yield store.scan(table, p, { cursor, limit: 500 });
      for (const r of page.items) out.push(r);
      cursor = page.next_cursor;
    } while (cursor);
  }
  return out;
}

export class StoreSink {
  /**
   * @param {{store:object, storage?:object, ids:{uuid:()=>string}, clock:{now:()=>string}, conflictPolicy?:'REJECT'|'APPLY_NEWER', crypto:{sha256Hex:Function}}} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.name = 'store';
    this.mode = 'IMPORT';
    this.conflictPolicy = o.conflictPolicy || 'REJECT';
  }
  *loadIndex(table) {
    const cols = ['id', ...predicateColumns(table).filter((c) => c !== 'id')];
    const rows = yield this.store.importColumns(table, cols);
    const uniques = [];
    uniqueKeys(table).forEach((u, index) => {
      for (const r of rows) { const key = uniqueKeyOf(u, r); if (key !== null) uniques.push({ index, key, id: r.id }); }
    });
    return { ids: rows.map((r) => r.id), uniques };
  }
  *existing(table, partition, ids) {
    const m = yield this.store.getMany(table, ids, { partitions: [partition] });
    const out = new Map();
    for (const [id, r] of m) out.set(id, canonicalRecord(table, r));
    return out;
  }
  *append(table, partition, records) {
    const inserts = [];
    const updates = [];
    for (const r of records) {
      if (r.__update_from_version !== undefined) {
        const { __update_from_version: from, ...rest } = r;
        updates.push({ record: rest, expected_version: from });
      } else inserts.push(r);
    }
    if (inserts.length) yield this.store.importAppend(table, partition, inserts);
    if (updates.length) yield this.store.importUpdate(table, partition, updates);
    return { inserted: inserts.length, updated: updates.length };
  }
  *terms() { return yield* scanAll(this.store, 'Terms'); }
  *attachmentRows() {
    const rows = yield* scanAll(this.store, 'Attachments');
    return rows.map((r) => ({ id: r.id, sha256: r.sha256, size_bytes: r.size_bytes, status: r.status }));
  }
  /** Copy one attachment into the target storage and record the new provider mapping (idempotent). */
  *attachment(entry, bytes) {
    if (!this.storage) return { written: false };
    const maps = (yield this.store.findBy('StorageObjectMappings', 'attachment_id', entry.logical_id)).filter((m) => m.status === 'ACTIVE');
    for (const m of maps) {
      try {
        const b = yield this.storage.get(m);
        if (b && this.crypto.sha256Hex(b) === entry.sha256) return { written: false, mapping_id: m.id };
      } catch (_) { /* stale mapping: copy again */ }
    }
    const stored = yield this.storage.put(entry.logical_id, bytes, { mime: entry.mime_type, folderPath: 'files/imported' });
    const now = this.clock.now();
    const rec = canonicalRecord('StorageObjectMappings', {
      id: this.ids.uuid(), attachment_id: entry.logical_id, provider: stored.provider, object_key: stored.object_key, container: stored.container || null,
      status: 'ACTIVE', sha256_verified_at: now, created_at: now, created_by: SYSTEM_USER_ID, updated_at: now, updated_by: SYSTEM_USER_ID, version: 1,
    });
    yield this.store.importAppend('StorageObjectMappings', '*', [rec]);
    return { written: true, mapping_id: rec.id };
  }
}

export { predicateColumns, getTable };

// Delta packages for rollback after cutover (MASTER_PROMPT §15.7, docs/MIGRATION_RUNBOOK_TH.md §8):
// rows changed on a system since a ChangeLog sequence, exported with the same format (kind DELTA) and
// applied to the other system with the APPLY_NEWER policy (insert new rows; update a row only when the
// incoming version is newer than the stored one and the stored version is the one it was based on).
// Nothing is dropped: a row that changed on both sides is a CONFLICT and stops the apply.
//
// Not carried in a delta: per-system bookkeeping (ChangeLog, Jobs, MigrationRuns/Checkpoints,
// OperationMetrics, BackupRuns) and the snapshot exclusions. The application never hard-deletes rows,
// so deltas contain no tombstones (retention purges of operational logs are not replayed).
import { getTable, SCHEMA_VERSION } from '../../schema/index.js';
import { AppError } from '../../shared/errors.js';
import {
  FORMAT, FORMAT_VERSION, EXCLUDED_TABLES, TRANSFORMS, exportTables, canonicalRecord, applyExportTransforms, recordLine, newTableAcc, accumulate,
  chunkPath, attachmentBatchDir, manifestShaLine, derivedColumns, CHUNK_ROWS,
} from './format.js';
import { processPackage } from './process.js';
import { partitionFor } from '../changeset.js';
import { StoreSink } from './sinks.js';
import { summarizeImport } from './import.js';
import { APP_VERSION } from './docs-bundle.js';

export const DELTA_EXCLUDED = new Set(['ChangeLog', 'Jobs', 'MigrationRuns', 'MigrationCheckpoints', 'OperationMetrics', 'BackupRuns']);

const json = (o) => JSON.stringify(o, null, 2) + '\n';

/**
 * Export rows touched after `sinceSeq` (exclusive) as a DELTA package. Small by nature (changes made
 * after a cutover), so it runs in one pass. The source should be READ_ONLY while this runs.
 * @param {object} deps  {store, crypto, clock, config, platform:{storage}}
 */
export function* exportDelta(deps, { sinceSeq, baseExportId, handle, exportId, actorId = null, frozen = true, platformName = 'MEMORY' }) {
  const sha = (d) => deps.crypto.sha256Hex(d);
  const now = deps.clock.now();
  const touched = new Map();
  let toSeq = sinceSeq;
  for (const p of yield deps.store.partitions('ChangeLog')) {
    let cursor = null;
    do {
      const page = yield deps.store.list('ChangeLog', { partitions: [p], where: { seq: { gt: sinceSeq } }, limit: 500, cursor });
      for (const e of page.items) {
        if (e.seq > toSeq) toSeq = e.seq;
        for (const ch of Array.isArray(e.changes_json) ? e.changes_json : []) {
          if (EXCLUDED_TABLES[ch.table] || DELTA_EXCLUDED.has(ch.table)) continue;
          if (!touched.has(ch.table)) touched.set(ch.table, new Set());
          touched.get(ch.table).add(ch.id);
        }
      }
      cursor = page.next_cursor;
    } while (cursor);
  }
  const order = exportTables().filter((t) => !DELTA_EXCLUDED.has(t));
  const terms = (yield deps.store.list('Terms', { limit: 500 })).items;
  const tz = (deps.config && deps.config.timezone) || 'Asia/Bangkok';
  const tables = [];
  const transforms = {};
  const attIds = [];
  for (const t of order) {
    const ids = touched.has(t) ? [...touched.get(t)].sort() : [];
    const byPartition = new Map();
    const acc = newTableAcc();
    for (const id of ids) {
      const raw = yield deps.store.get(t, id);
      if (!raw) continue;
      const tr = applyExportTransforms(t, canonicalRecord(t, raw));
      for (const k of tr.applied) transforms[k] = (transforms[k] || 0) + 1;
      const rec = tr.record;
      const part = partitionFor(t, rec, terms, tz);
      if (!byPartition.has(part)) byPartition.set(part, []);
      byPartition.get(part).push(rec);
      if (t === 'Attachments' && rec.status !== 'DELETED') attIds.push(rec);
    }
    const partitions = [];
    for (const [key, recs] of [...byPartition.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const chunks = [];
      for (let i = 0; i < recs.length; i += CHUNK_ROWS) {
        const slice = recs.slice(i, i + CHUNK_ROWS);
        const lines = slice.map((r) => { const l = recordLine(r); accumulate(acc, t, r, sha, l); return l; });
        const text = lines.join('\n') + '\n';
        const path = chunkPath(t, key, chunks.length + 1);
        const res = yield handle.writeText(path, text);
        chunks.push({ path, rows: lines.length, bytes: res.bytes, sha256: sha(text), first_id: slice[0].id, last_id: slice[slice.length - 1].id, csv: null });
      }
      partitions.push({ key, row_count: recs.length, chunks });
    }
    tables.push({ name: t, partition_mode: getTable(t).partition, row_count: acc.rows, digest_all: acc.digest_all, digest_source: acc.digest_source, derived_columns: derivedColumns(t), live: false, partitions });
  }
  // attachment bytes for new/changed files
  const entries = [];
  const missing = [];
  let bytesTotal = 0;
  for (const a of attIds) {
    const maps = (yield deps.store.findBy('StorageObjectMappings', 'attachment_id', a.id)).filter((m) => m.status === 'ACTIVE');
    let b = null;
    try { b = maps.length ? yield deps.platform.storage.get(maps[0]) : null; } catch (_) { b = null; }
    if (!b || sha(b) !== a.sha256) { missing.push({ logical_id: a.id, reason: b ? 'CHECKSUM_MISMATCH' : 'UNREADABLE' }); continue; }
    const path = `${attachmentBatchDir(1)}/${a.id}`;
    yield handle.writeBytes(path, b);
    bytesTotal += b.length;
    const links = (yield deps.store.findBy('AttachmentLinks', 'attachment_id', a.id)).filter((l) => !l.unlinked_at)
      .map((l) => ({ entity_type: l.entity_type, entity_id: l.entity_id, purpose: l.purpose || null })).sort((x, y) => (x.entity_id + x.entity_type < y.entity_id + y.entity_type ? -1 : 1));
    entries.push({ logical_id: a.id, path, size_bytes: a.size_bytes, mime_type: a.mime_type, sha256: a.sha256, classification: a.classification, original_filename: a.original_filename, links });
  }
  entries.sort((x, y) => (x.logical_id < y.logical_id ? -1 : 1));
  const indexText = entries.length ? entries.map((e) => recordLine(e)).join('\n') + '\n' : '';
  const idxRes = yield handle.writeText('attachment-index.jsonl', indexText);
  const reasons = [];
  if (!frozen) reasons.push('NOT_FROZEN');
  if (missing.length) reasons.push(`ATTACHMENTS_MISSING:${missing.length}`);
  const manifest = {
    format: FORMAT, format_version: FORMAT_VERSION, kind: 'DELTA', export_id: exportId, app_version: APP_VERSION, schema_version: SCHEMA_VERSION, school: null, mode: 'FULL_SNAPSHOT',
    snapshot: { started_at: now, finished_at: deps.clock.now(), frozen, system_mode_at_start: (deps.config && deps.config.systemMode) || 'NORMAL', high_water_mark: { change_log_seq: toSeq }, school_date: now.slice(0, 10), timezone: (deps.config && deps.config.timezone) || 'Asia/Bangkok' },
    delta: { base_export_id: baseExportId, from_seq: sinceSeq, to_seq: toSeq, tombstones: 0 },
    source: { platform: platformName, env: (deps.config && deps.config.env) || 'DEV' },
    serialization: { encoding: 'UTF-8', newline: 'LF', canonical_json: 'sorted-keys-v1 (src/shared/canonical-json.js)', record_hash: 'sha256(utf8(canonical_json(record)))', table_digest: 'sum of record hashes mod 2^256 (hex); digest_source excludes derived columns' },
    tables,
    excluded_tables: [
      ...Object.entries(EXCLUDED_TABLES).map(([name, e]) => ({ name, reason: e.reason, note_th: e.note_th, metadata_path: null })),
      ...[...DELTA_EXCLUDED].filter((t) => !EXCLUDED_TABLES[t]).map((name) => ({ name, reason: 'NOT_SELECTED', note_th: 'บันทึกเฉพาะระบบ ไม่ย้อนกลับใน delta', metadata_path: null })),
    ],
    transforms: TRANSFORMS.map((t) => ({ table: t.table, column: t.column, rule: t.rule, rows_affected: transforms[`${t.table}.${t.column}`] || 0, note_th: t.note_th })),
    attachments: { included: true, index: { path: 'attachment-index.jsonl', sha256: sha(indexText), bytes: idxRes.bytes }, files: entries.length, bytes: bytesTotal, batches: entries.length ? [{ path: attachmentBatchDir(1), files: entries.length, bytes: bytesTotal }] : [], missing },
    files: [],
    completeness: reasons.length ? 'PARTIAL' : 'COMPLETE', completeness_reasons: reasons,
    consistency: { checked: frozen, changes_after_hwm: 0, non_live_tables_changed: [], count_mismatches: [] },
    created_at: now, created_by: actorId,
  };
  const text = json(manifest);
  yield handle.writeText('manifest.json', text);
  yield handle.writeText('manifest.sha256', manifestShaLine(sha(text)));
  return { manifest, rows: tables.reduce((s, t) => s + t.row_count, 0), to_seq: toSeq };
}

/**
 * Apply a DELTA package to a store (rollback to the old system, or roll-forward). dryRun checks
 * everything against the target without writing.
 */
export function* applyDelta(deps, handle, { dryRun = false, checkpoint = null, deadlineAt = null, importId = null, targetName = 'source' } = {}) {
  const sink = new StoreSink({ store: deps.store, storage: deps.platform && deps.platform.storage, ids: deps.ids, clock: deps.clock, crypto: deps.crypto, conflictPolicy: 'APPLY_NEWER' });
  if (dryRun) { sink.append = function* () { return { inserted: 0 }; }; sink.attachment = function* () { return { written: false }; }; }
  const head = yield handle.readText('manifest.json');
  const m = head ? JSON.parse(head) : null;
  if (!m || m.kind !== 'DELTA') throw new AppError('VALIDATION_ERROR', 'not a delta package', { messageTh: 'package นี้ไม่ใช่ชุดการเปลี่ยนแปลง (DELTA)' });
  const startedAt = deps.clock.now();
  const res = yield* processPackage(handle, sink, { sha256Hex: (d) => deps.crypto.sha256Hex(d), failFast: !dryRun, checkpoint, deadlineAt });
  if (!res.done) return { done: false, report: res.report };
  const report = summarizeImport(res, { target: targetName, importId, mode: dryRun ? 'DRY_RUN' : 'APPLY', startedAt, finishedAt: deps.clock.now() });
  if (handle.writeText) yield handle.writeText(dryRun ? 'reports/delta-dry-run.json' : 'reports/delta-apply.json', JSON.stringify(report, null, 2) + '\n');
  return { done: true, report };
}

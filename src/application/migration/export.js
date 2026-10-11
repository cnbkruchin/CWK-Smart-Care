// Portable export (MASTER_PROMPT §15.2–15.3): a resumable background job that writes a package
// (docs/PORTABLE_FORMAT.md) through ctx.platform.packageStore (Drive folder on Apps Script, directory in
// Node, Map in tests).
//
// FULL_SNAPSHOT / REHEARSAL require the server-enforced READ_ONLY mode (system.setMode): no mutation except
// maintenance tasks can commit. The job records the ChangeLog high-water mark H and row counts per
// table/partition, exports chunks with checkpoints, then PROVES consistency before calling the package
// COMPLETE: every ChangeLog entry after H may touch only LIVE_TABLES (export bookkeeping) and every frozen
// table/partition must have exactly the rows counted at H. A source that changed during the export gives
// completeness FAILED — never a silently inconsistent "snapshot".
import { TABLES, getTable, tableJsonSchema, dependencyOrder, validateRecord, ENUMS, SCHEMA_VERSION } from '../../schema/index.js';
import { toCsv } from '../../shared/csv.js';
import { AppError, isAppError } from '../../shared/errors.js';
import { commitRaw } from '../context.js';
import { assertTransition } from '../../domain/state-machines.js';
import {
  FORMAT, FORMAT_VERSION, CHUNK_ROWS, ATTACHMENT_BATCH_BYTES, ATTACHMENT_BATCH_FILES, EXCLUDED_TABLES, LIVE_TABLES, TRANSFORMS, MANIFEST_SCHEMA, ATTACHMENT_INDEX_SCHEMA,
  exportTables, isLiveTable, derivedColumns, canonicalRecord, applyExportTransforms, recordLine, newTableAcc, accumulate, chunkPath, csvPath, attachmentBatchDir,
  manifestShaLine, dataDictionaryRows,
} from './format.js';
import { processPackage } from './process.js';
import { IndexSink, scanAll } from './sinks.js';
import { sampleContext, chooseSamples, reportPlan, computeReports, choosePermissionUsers, computePermissionSamples } from './samples.js';
import { APP_VERSION, PACKAGE_DOCS } from './docs-bundle.js';

export const EXPORT_JOB = 'migration.export';
const SAFETY_MS = 45000;

// ───────── inventory ─────────

export function* inventory(ctx) {
  const tables = [];
  let estimate = 0;
  for (const t of TABLES) {
    const parts = (yield ctx.store.partitions(t.name)).slice().sort();
    const partitions = [];
    let rows = 0;
    for (const p of parts) {
      const n = ctx.store.count ? yield ctx.store.count(t.name, p) : 0;
      partitions.push({ key: p, rows: n });
      rows += n;
    }
    const est = rows * t.columns.length * 14;
    estimate += EXCLUDED_TABLES[t.name] ? 0 : est;
    tables.push({
      table: t.name, group: t.group, kind: t.kind, partition_mode: t.partition, sensitivity: t.sensitivity, rows, partitions, estimated_bytes: est,
      export: EXCLUDED_TABLES[t.name] ? EXCLUDED_TABLES[t.name].reason : 'EXPORTED', live: isLiveTable(t.name),
    });
  }
  const atts = yield* scanAll(ctx.store, 'Attachments');
  const active = atts.filter((a) => a.status !== 'DELETED');
  const byClass = {};
  for (const a of active) byClass[a.classification] = (byClass[a.classification] || 0) + 1;
  const bytes = active.reduce((s, a) => s + (a.size_bytes || 0), 0);
  return {
    schema_version: SCHEMA_VERSION, app_version: APP_VERSION, format_version: FORMAT_VERSION, system_mode: ctx.config.systemMode || 'NORMAL',
    terms: ctx.terms.map((x) => ({ code: x.code, start_date: x.start_date, end_date: x.end_date, status: x.status })),
    tables, attachments: { files: active.length, bytes, by_classification: byClass, deleted: atts.length - active.length },
    estimated_total_bytes: estimate + bytes,
  };
}

// ───────── helpers ─────────

export function* maxChangeSeq(ctx) {
  if (ctx.platform.maxChangeSeq) return yield ctx.platform.maxChangeSeq();
  let best = 0;
  for (const p of yield ctx.store.partitions('ChangeLog')) {
    const page = yield ctx.store.list('ChangeLog', { partitions: [p], orderBy: [['seq', 'desc']], limit: 1 });
    if (page.items.length && page.items[0].seq > best) best = page.items[0].seq;
  }
  return best;
}

function* journalStatus(ctx) {
  if (ctx.platform.journalStatus) return yield ctx.platform.journalStatus();
  return { PREPARED: 0, RECOVERY_REQUIRED: 0 };
}

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function* writeFileRef(ctx, pkg, path, text) {
  const res = yield pkg.writeText(path, text);
  return { path, sha256: ctx.crypto.sha256Hex(text), bytes: res && res.bytes !== undefined ? res.bytes : text.length };
}

const json = (o) => JSON.stringify(o, null, 2) + '\n';

function* updateRun(ctx, runId, patch, action = null) {
  const run = yield ctx.store.get('MigrationRuns', runId);
  if (action) assertTransition('Migration', run.state, action);
  const cs = ctx.changeSet('migration.export.state');
  cs.maintenanceAllowed = true;
  const next = cs.update('MigrationRuns', run, patch);
  yield* commitRaw(ctx, cs);
  return next;
}

function* failRun(ctx, runId, err) {
  try {
    const run = yield ctx.store.get('MigrationRuns', runId);
    if (!run || ['FAILED', 'CANCELLED', 'EXPORTED'].includes(run.state)) return;
    yield* updateRun(ctx, runId, { state: 'FAILED', finished_at: ctx.now, completeness: 'FAILED', summary_json: { ...(run.summary_json || {}), error: isAppError(err) ? err.code : 'INTERNAL_ERROR', error_th: isAppError(err) ? err.messageTh : 'เกิดข้อผิดพลาดภายใน' } });
  } catch (_) { /* the job record keeps last_error */ }
}

// ───────── the job ─────────

export function* exportJob(ctx, job, { checkpoint, timeLeftMs }) {
  const runId = job.payload_json && job.payload_json.run_id;
  const run = runId ? yield ctx.store.get('MigrationRuns', runId) : null;
  if (!run) throw new AppError('NOT_FOUND', 'migration run missing', { retryable: false });
  if (['CANCELLED', 'FAILED', 'EXPORTED'].includes(run.state)) return { done: true, result: { state: run.state } };
  if (!ctx.platform.packageStore) throw new AppError('CONFIGURATION_REQUIRED', 'package store not configured', { messageTh: 'ยังไม่ได้ตั้งค่าที่เก็บไฟล์ส่งออก' });
  try {
    return yield* exportSteps(ctx, job, run, checkpoint, timeLeftMs);
  } catch (e) {
    const retry = job.attempts < job.max_attempts && (!isAppError(e) || e.retryable || e.code === 'CONFLICT');
    if (!retry) yield* failRun(ctx, run.id, e);
    throw e;
  }
}
exportJob.maintenanceAllowed = true;

function* exportSteps(ctx, job, run, checkpoint, timeLeftMs) {
  const frozen = run.mode !== 'PARTIAL';
  const scope = run.scope_json || {};
  let c = job.cursor_json && job.cursor_json.phase ? job.cursor_json : { phase: 'PREPARE' };
  const progress = (extra = {}) => ({ phase: c.phase, table: c.tables ? c.tables[c.ti] || null : null, tables_done: c.ti || 0, tables_total: c.tables ? c.tables.length : 0, rows: c.rows || 0, chunks: c.chunks || 0, attachments: c.att ? c.att.files : 0, ...extra });
  const save = function* () { yield* checkpoint(c, progress()); };
  // operator control between chunks: cancel stops for good, pause parks the job until resumed
  const control = function* () {
    const r = yield ctx.store.get('MigrationRuns', run.id);
    if (!r || r.state === 'CANCELLED') return { done: true, result: { run_id: run.id, state: 'CANCELLED' } };
    if (r.summary_json && r.summary_json.pause_requested) return { done: false, pause: true };
    return null;
  };

  // ── PREPARE: freeze checks, high-water mark, counts, package folder ──
  if (c.phase === 'PREPARE') {
    if (frozen && ctx.config.systemMode !== 'READ_ONLY') {
      throw new AppError('INVALID_STATE', 'source not frozen', { retryable: false, messageTh: 'ต้องเปิดโหมดอ่านอย่างเดียว (READ_ONLY) ก่อนส่งออกภาพรวมทั้งระบบ' });
    }
    const j = yield* journalStatus(ctx);
    if (j.PREPARED || j.RECOVERY_REQUIRED) throw new AppError('STORAGE_UNAVAILABLE', 'journal has pending operations', { retryable: true, messageTh: 'มีรายการค้างใน journal — ระบบจะกู้แล้วลองใหม่' });
    const hwm = yield* maxChangeSeq(ctx);
    const tables = run.mode === 'PARTIAL' ? exportTables().filter((t) => (scope.tables || []).includes(t)) : exportTables();
    const counts = {};
    if (frozen) {
      for (const t of tables) {
        if (isLiveTable(t) || t === 'ChangeLog') continue;
        for (const p of yield ctx.store.partitions(t)) counts[`${t}|${p}`] = yield ctx.store.count(t, p);
      }
    }
    const env = (ctx.config.env || 'DEV').toLowerCase();
    const location = yield ctx.platform.packageStore.create(`cwk-${env}-${run.mode.toLowerCase()}-${ctx.today}-${run.id.slice(0, 8)}`);
    yield* updateRun(ctx, run.id, { state: 'SNAPSHOTTING', package_location: String(location), high_water_marks_json: { change_log_seq: hwm, row_counts: counts, system_mode: ctx.config.systemMode || 'NORMAL', school_date: ctx.today } }, 'START_SNAPSHOT');
    c = {
      phase: 'TABLES', location, hwm, tables, ti: 0, parts: null, pi: 0, scan: null, chunk_no: 0, acc: {}, rows: 0, chunks: 0, transforms: {},
      record_errors: 0, record_error_samples: [], cl: { min: null, max: null, n: 0 }, started_at: ctx.now,
      att: { scan: null, batch: 1, batch_bytes: 0, batch_files: 0, files: 0, bytes: 0, pages: 0, missing: [], missing_count: 0, batches: [] },
    };
    yield* save();
  }
  const pkg = yield ctx.platform.packageStore.open(c.location);

  // ── TABLES: chunked, checkpointed ──
  while (c.phase === 'TABLES') {
    if (c.ti >= c.tables.length) { c.phase = 'ATTACHMENTS'; yield* save(); break; }
    if (timeLeftMs() < SAFETY_MS) return { done: false };
    const stop = yield* control();
    if (stop) return stop;
    if (frozen && ctx.config.systemMode !== 'READ_ONLY') throw new AppError('INVALID_STATE', 'freeze released during export', { retryable: false, messageTh: 'โหมดอ่านอย่างเดียวถูกปิดระหว่างส่งออก — ภาพรวมนี้ใช้ไม่ได้ ต้องเริ่มใหม่' });
    const table = c.tables[c.ti];
    if (!c.parts) {
      c.parts = (yield ctx.store.partitions(table)).slice().sort();
      c.pi = 0; c.scan = null; c.chunk_no = 0;
      c.acc[table] = c.acc[table] || { ...newTableAcc(), partitions: {} };
    }
    if (c.pi >= c.parts.length) { c.ti++; c.parts = null; yield* save(); continue; }
    const p = c.parts[c.pi];
    const acc = c.acc[table];
    if (acc.partitions[p] === undefined) acc.partitions[p] = { rows: 0, chunks: 0 };
    const recs = [];
    let cursor = c.scan;
    let exhausted = false;
    while (recs.length < CHUNK_ROWS) {
      const page = yield ctx.store.scan(table, p, { cursor, limit: 500 });
      for (const r of page.items) recs.push(r);
      cursor = page.next_cursor;
      if (!cursor) { exhausted = true; break; }
    }
    const lines = [];
    const csvRows = [];
    const cols = getTable(table).columns.map((x) => x.name);
    for (const raw of recs) {
      let rec = canonicalRecord(table, raw);
      if (table === 'ChangeLog' && rec.seq > c.hwm) continue;
      const errs = validateRecord(table, rec);
      if (errs.length) {
        c.record_errors++;
        if (c.record_error_samples.length < 20) c.record_error_samples.push({ table, id: rec.id, fields: errs.map((e) => `${e.field}:${e.code}`).join(',') });
      }
      const t = applyExportTransforms(table, rec);
      rec = t.record;
      for (const k of t.applied) c.transforms[k] = (c.transforms[k] || 0) + 1;
      const line = recordLine(rec);
      accumulate(acc, table, rec, (s) => ctx.crypto.sha256Hex(s), line);
      lines.push(line);
      if (scope.include_csv !== false) csvRows.push(cols.map((k) => cell(rec[k])));
      if (table === 'ChangeLog') {
        c.cl.n++;
        c.cl.min = c.cl.min === null ? rec.seq : Math.min(c.cl.min, rec.seq);
        c.cl.max = c.cl.max === null ? rec.seq : Math.max(c.cl.max, rec.seq);
      }
    }
    if (lines.length) {
      const n = acc.partitions[p].chunks + 1;
      const text = lines.join('\n') + '\n';
      const ref = yield* writeFileRef(ctx, pkg, chunkPath(table, p, n), text);
      let csv = null;
      if (scope.include_csv !== false) csv = yield* writeFileRef(ctx, pkg, csvPath(table, p, n), toCsv(cols, csvRows));
      const cs = ctx.changeSet('migration.export.chunk');
      cs.maintenanceAllowed = true;
      cs.insert('MigrationCheckpoints', {
        migration_run_id: run.id, step: 'CHUNK', table_name: table, partition_key: p, chunk_no: n, rows_done: lines.length, chunk_sha256: ref.sha256, status: 'SUCCEEDED',
        cursor_json: { path: ref.path, bytes: ref.bytes, first_id: JSON.parse(lines[0]).id || null, last_id: JSON.parse(lines[lines.length - 1]).id || null, csv },
      });
      yield* commitRaw(ctx, cs);
      acc.partitions[p].chunks = n;
      acc.partitions[p].rows += lines.length;
      c.rows += lines.length;
      c.chunks++;
    }
    c.scan = exhausted ? null : cursor;
    if (exhausted) c.pi++;
    yield* save();
  }

  // ── ATTACHMENTS: real bytes, SHA-256 verified, batched by size ──
  while (c.phase === 'ATTACHMENTS') {
    if (!scope.include_attachments || (run.mode === 'PARTIAL' && !(scope.tables || []).includes('Attachments'))) { c.phase = 'FINALIZE'; yield* save(); break; }
    if (timeLeftMs() < SAFETY_MS) return { done: false };
    const stopA = yield* control();
    if (stopA) return stopA;
    const page = yield ctx.store.scan('Attachments', '*', { cursor: c.att.scan, limit: 20 });
    const entries = [];
    for (const raw of page.items) {
      const a = canonicalRecord('Attachments', raw);
      if (a.status === 'DELETED') continue;
      const miss = (reason) => {
        c.att.missing_count++;
        if (c.att.missing.length < 200) c.att.missing.push({ logical_id: a.id, reason });
      };
      const maps = (yield ctx.store.findBy('StorageObjectMappings', 'attachment_id', a.id)).filter((m) => m.status === 'ACTIVE');
      if (!maps.length || !ctx.platform.storage) { miss('NO_STORAGE_MAPPING'); continue; }
      let bytes;
      try { bytes = yield ctx.platform.storage.get(maps[0]); } catch (_) { miss('UNREADABLE'); continue; }
      if (!bytes || bytes.length !== a.size_bytes || ctx.crypto.sha256Hex(bytes) !== a.sha256) { miss('CHECKSUM_MISMATCH'); continue; }
      if (c.att.batch_files >= ATTACHMENT_BATCH_FILES || (c.att.batch_files > 0 && c.att.batch_bytes + bytes.length > ATTACHMENT_BATCH_BYTES)) {
        c.att.batches.push({ path: attachmentBatchDir(c.att.batch), files: c.att.batch_files, bytes: c.att.batch_bytes });
        c.att.batch++; c.att.batch_files = 0; c.att.batch_bytes = 0;
      }
      const path = `${attachmentBatchDir(c.att.batch)}/${a.id}`;
      yield pkg.writeBytes(path, bytes);
      const links = (yield ctx.store.findBy('AttachmentLinks', 'attachment_id', a.id)).filter((l) => !l.unlinked_at)
        .map((l) => ({ entity_type: l.entity_type, entity_id: l.entity_id, purpose: l.purpose || null })).sort((x, y) => (x.entity_id + x.entity_type < y.entity_id + y.entity_type ? -1 : 1));
      entries.push({ logical_id: a.id, path, size_bytes: a.size_bytes, mime_type: a.mime_type, sha256: a.sha256, classification: a.classification, original_filename: a.original_filename, links });
      c.att.batch_files++; c.att.batch_bytes += bytes.length; c.att.files++; c.att.bytes += bytes.length;
    }
    if (entries.length) {
      c.att.pages++;
      yield pkg.writeText(`attachments/index-pages/page-${String(c.att.pages).padStart(5, '0')}.jsonl`, entries.map((e) => recordLine(e)).join('\n') + '\n');
    }
    c.att.scan = page.next_cursor;
    if (!page.next_cursor) {
      if (c.att.batch_files) c.att.batches.push({ path: attachmentBatchDir(c.att.batch), files: c.att.batch_files, bytes: c.att.batch_bytes });
      c.phase = 'FINALIZE';
    }
    yield* save();
  }

  // ── FINALIZE: consistency proof, metadata, schema, docs, index, manifest ──
  if (c.phase === 'FINALIZE') {
    if (timeLeftMs() < SAFETY_MS * 2) return { done: false };
    const stopF = yield* control();
    if (stopF) return stopF;
    const fresh = yield ctx.store.get('MigrationRuns', run.id);
    const hw = fresh.high_water_marks_json || {};
    const consistency = { checked: frozen, changes_after_hwm: 0, non_live_tables_changed: [], count_mismatches: [] };
    if (frozen) {
      const touched = new Set();
      for (const p of yield ctx.store.partitions('ChangeLog')) {
        let cursor = null;
        do {
          const page = yield ctx.store.list('ChangeLog', { partitions: [p], where: { seq: { gt: c.hwm } }, limit: 500, cursor });
          for (const e of page.items) {
            consistency.changes_after_hwm++;
            for (const ch of Array.isArray(e.changes_json) ? e.changes_json : []) touched.add(ch.table);
          }
          cursor = page.next_cursor;
        } while (cursor);
      }
      consistency.non_live_tables_changed = [...touched].filter((t) => !LIVE_TABLES.includes(t) && t !== 'ChangeLog').sort();
      for (const [key, n] of Object.entries(hw.row_counts || {})) {
        const [t, p] = key.split('|');
        const got = c.acc[t] && c.acc[t].partitions[p] ? c.acc[t].partitions[p].rows : 0;
        if (got !== n) consistency.count_mismatches.push(`${t}/${p}: ${n} → ${got}`);
      }
      for (const t of c.tables) {
        if (isLiveTable(t) || t === 'ChangeLog') continue;
        for (const p of Object.keys(c.acc[t] ? c.acc[t].partitions : {})) if ((hw.row_counts || {})[`${t}|${p}`] === undefined && c.acc[t].partitions[p].rows) consistency.count_mismatches.push(`${t}/${p}: new partition`);
      }
      if (c.cl.n && (c.cl.max !== c.hwm || c.cl.max - c.cl.min + 1 !== c.cl.n)) consistency.count_mismatches.push(`ChangeLog: seq ${c.cl.min}..${c.cl.max} rows ${c.cl.n} (H=${c.hwm})`);
    }
    const files = [];
    const add = function* (path, text) { files.push(yield* writeFileRef(ctx, pkg, path, text)); };
    // schema/
    for (const t of c.tables) yield* add(`schema/tables/${t}.schema.json`, json(tableJsonSchema(t)));
    yield* add('schema/enums.json', json(Object.fromEntries(Object.entries(ENUMS).map(([k, v]) => [k, { values: v.values, th: v.th }]))));
    yield* add('schema/dependency-order.json', json({ schema_version: SCHEMA_VERSION, order: dependencyOrder(), exported: c.tables }));
    yield* add('schema/manifest.schema.json', json(MANIFEST_SCHEMA));
    yield* add('schema/attachment-index.schema.json', json(ATTACHMENT_INDEX_SCHEMA));
    // metadata/
    const cfg = ctx.config || {};
    yield* add('metadata/config.json', json({ env: cfg.env || null, timezone: ctx.tz, system_mode: cfg.systemMode || 'NORMAL', app_version: APP_VERSION, schema_version: SCHEMA_VERSION, features: { email_enabled: !!cfg.emailEnabled, line_enabled: !!cfg.lineEnabled }, note_th: 'ค่าตั้งที่ไม่ใช่ความลับเท่านั้น — secrets (token, รหัสผ่าน, HMAC key) ต้องตั้งใหม่ที่ปลายทาง' }));
    const catalog = (yield* scanAll(ctx.store, 'StorageCatalog')).map((r) => ({ logical_table: r.logical_table, partition_key: r.partition_key, workbook_id: r.workbook_id, sheet_name: r.sheet_name, status: r.status }));
    yield* add('metadata/storage-catalog.json', json({ note_th: 'ตำแหน่งชีตของ environment ต้นทาง (อ้างอิงเท่านั้น)', items: catalog }));
    const mappings = (yield* scanAll(ctx.store, 'StorageObjectMappings')).map((m) => ({ attachment_id: m.attachment_id, provider: m.provider, object_key: m.object_key, container: m.container, status: m.status }));
    yield* add('metadata/storage-mapping.json', json({ note_th: 'logical file ID → object ของต้นทาง (ปลายทางสร้าง mapping ใหม่)', items: mappings }));
    const sv = (yield* scanAll(ctx.store, 'SchemaVersions')).map((r) => ({ component: r.component, schema_version: r.schema_version, applied_at: r.applied_at }));
    yield* add('metadata/schema-versions.json', json({ items: sv }));
    const termsByCode = new Map(ctx.terms.map((t) => [t.code, t]));
    const parts = {};
    for (const t of c.tables) {
      if (getTable(t).partition !== 'TERM') continue;
      for (const [p, v] of Object.entries(c.acc[t] ? c.acc[t].partitions : {})) {
        if (!parts[p]) parts[p] = { key: p, term: termsByCode.has(p) ? { code: p, start_date: termsByCode.get(p).start_date, end_date: termsByCode.get(p).end_date } : null, readable: true, tables: [] };
        parts[p].tables.push({ table: t, rows: v.rows });
      }
    }
    const statusByPart = new Map(catalog.map((r) => [r.partition_key, r.status]));
    yield* add('metadata/archive-partitions.json', json({ note_th: 'ทุก partition ภาคเรียนในขอบเขต รวมที่เก็บถาวร (ARCHIVED/READONLY)', items: Object.values(parts).map((x) => ({ ...x, storage_status: statusByPart.get(x.key) || null })).sort((a, b) => (a.key < b.key ? -1 : 1)) }));
    const rules = (yield* scanAll(ctx.store, 'RuleVersions')).map((r) => ({ id: r.id, rule_type: r.rule_type, version_no: r.version_no, effective_from: r.effective_from, effective_to: r.effective_to, is_example: r.is_example, status: r.status }));
    yield* add('metadata/rule-versions.json', json({ items: rules }));
    // business and permission samples (recomputed on the target during reconciliation)
    const sctx = yield* sampleContext(ctx.deps, c.started_at);
    const samples = yield* chooseSamples(sctx);
    const plan = reportPlan(samples);
    const reports = yield* computeReports(sctx, plan);
    yield* add('metadata/business-totals.json', json({ computed_at: c.started_at, school_date: sctx.today, samples, reports }));
    const users = yield* choosePermissionUsers(sctx, sctx.today);
    yield* add('metadata/permission-samples.json', json({ date: sctx.today, users: yield* computePermissionSamples(sctx, users, sctx.today) }));
    // docs + dictionary
    for (const [name, text] of Object.entries(PACKAGE_DOCS)) yield* add(`docs/${name}`, text);
    const dd = dataDictionaryRows();
    yield* add('csv/DATA_DICTIONARY.csv', toCsv(dd.headers, dd.rows));
    // attachment-index.jsonl from the page files
    let index = null;
    const includeAtt = !!scope.include_attachments && !(run.mode === 'PARTIAL' && !(scope.tables || []).includes('Attachments'));
    if (includeAtt) {
      const parts2 = [];
      for (let i = 1; i <= c.att.pages; i++) {
        const pth = `attachments/index-pages/page-${String(i).padStart(5, '0')}.jsonl`;
        const t = yield pkg.readText(pth);
        if (t === null) throw new AppError('INTEGRITY_ERROR', `attachment index page ${i} missing`, { retryable: false });
        parts2.push(t);
      }
      const lines = parts2.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => (a.logical_id < b.logical_id ? -1 : 1)).map((e) => recordLine(e));
      index = yield* writeFileRef(ctx, pkg, 'attachment-index.jsonl', lines.length ? lines.join('\n') + '\n' : '');
      for (let i = 1; i <= c.att.pages; i++) yield pkg.remove(`attachments/index-pages/page-${String(i).padStart(5, '0')}.jsonl`);
    }
    // completeness
    const reasons = [];
    if (run.mode === 'PARTIAL') reasons.push('PARTIAL_MODE');
    const missingDeps = [];
    for (const t of c.tables) for (const col of getTable(t).columns) if (col.fk && !EXCLUDED_TABLES[col.fk] && !c.tables.includes(col.fk)) missingDeps.push(`${t}.${col.name}→${col.fk}`);
    if (missingDeps.length) reasons.push(`MISSING_DEPENDENCIES:${[...new Set(missingDeps)].slice(0, 20).join(',')}`);
    if (!includeAtt) reasons.push('ATTACHMENTS_EXCLUDED');
    if (c.att.missing_count) reasons.push(`ATTACHMENTS_MISSING:${c.att.missing_count}`);
    if (c.record_errors) reasons.push(`RECORD_ERRORS:${c.record_errors}`);
    if (frozen && (consistency.non_live_tables_changed.length || consistency.count_mismatches.length)) reasons.push('SOURCE_CHANGED_DURING_SNAPSHOT');
    const failed = c.record_errors > 0 || reasons.includes('SOURCE_CHANGED_DURING_SNAPSHOT');
    const completeness = failed ? 'FAILED' : reasons.length ? 'PARTIAL' : 'COMPLETE';
    const school = (yield ctx.store.list('Schools', { limit: 1 })).items[0] || null;
    const allTables = new Set(exportTables());
    const manifest = {
      format: FORMAT, format_version: FORMAT_VERSION, kind: 'SNAPSHOT', export_id: run.id, app_version: APP_VERSION, schema_version: SCHEMA_VERSION,
      school: school ? { id: school.id, code: school.code, name_th: school.name_th } : null,
      mode: run.mode,
      snapshot: { started_at: c.started_at, finished_at: ctx.now, frozen, system_mode_at_start: hw.system_mode || 'NORMAL', high_water_mark: { change_log_seq: c.hwm }, school_date: hw.school_date || ctx.today, timezone: ctx.tz },
      delta: null,
      source: { platform: ctx.platform.platformName || 'MEMORY', env: cfg.env || 'DEV' },
      serialization: { encoding: 'UTF-8', newline: 'LF', canonical_json: 'sorted-keys-v1 (src/shared/canonical-json.js)', record_hash: 'sha256(utf8(canonical_json(record)))', table_digest: 'sum of record hashes mod 2^256 (hex); digest_source excludes derived columns' },
      tables: c.tables.map((t) => {
        const a = c.acc[t] || { ...newTableAcc(), partitions: {} };
        return {
          name: t, partition_mode: getTable(t).partition, row_count: a.rows, digest_all: a.digest_all, digest_source: a.digest_source, derived_columns: derivedColumns(t), live: isLiveTable(t),
          partitions: Object.keys(a.partitions).sort().map((p) => ({ key: p, row_count: a.partitions[p].rows, chunks: [] })),
        };
      }),
      excluded_tables: [
        ...Object.entries(EXCLUDED_TABLES).map(([name, e]) => ({ name, reason: e.reason, note_th: e.note_th, metadata_path: e.metadata || null })),
        ...[...allTables].filter((t) => !c.tables.includes(t)).map((name) => ({ name, reason: 'NOT_SELECTED', note_th: 'ไม่ได้เลือกในการส่งออกบางส่วน', metadata_path: null })),
      ],
      transforms: TRANSFORMS.map((t) => ({ table: t.table, column: t.column, rule: t.rule, rows_affected: c.transforms[`${t.table}.${t.column}`] || 0, note_th: t.note_th })),
      attachments: { included: includeAtt, index, files: c.att.files, bytes: c.att.bytes, batches: c.att.batches, missing: c.att.missing },
      files,
      completeness, completeness_reasons: reasons, consistency,
      created_at: ctx.now, created_by: run.started_by,
    };
    // chunk refs from checkpoint rows (latest per table/partition/chunk)
    const cps = (yield ctx.store.findBy('MigrationCheckpoints', 'migration_run_id', run.id)).filter((x) => x.step === 'CHUNK');
    const latest = new Map();
    for (const x of cps) {
      const k = `${x.table_name}|${x.partition_key}|${x.chunk_no}`;
      if (!latest.has(k) || latest.get(k).created_at <= x.created_at) latest.set(k, x);
    }
    for (const t of manifest.tables) {
      for (const p of t.partitions) {
        const n = c.acc[t.name].partitions[p.key].chunks;
        for (let i = 1; i <= n; i++) {
          const x = latest.get(`${t.name}|${p.key}|${i}`);
          if (!x) throw new AppError('INTEGRITY_ERROR', `checkpoint for ${t.name}/${p.key}/${i} missing`, { retryable: false });
          p.chunks.push({ path: x.cursor_json.path, rows: x.rows_done, bytes: x.cursor_json.bytes, sha256: x.chunk_sha256, first_id: x.cursor_json.first_id, last_id: x.cursor_json.last_id, csv: x.cursor_json.csv || null });
        }
      }
    }
    const text = json(manifest);
    yield pkg.writeText('manifest.json', text);
    const msha = ctx.crypto.sha256Hex(text);
    yield pkg.writeText('manifest.sha256', manifestShaLine(msha));
    c.phase = 'VERIFY';
    c.verify = null;
    c.manifest_sha256 = msha;
    c.record_error_samples = c.record_error_samples.slice(0, 20);
    yield* save();
  }

  // ── VERIFY: re-read the written package (resumable) ──
  if (c.phase === 'VERIFY') {
    const level = ctx.platform.packageVerifyLevel || 'FULL';
    const res = yield* processPackage(pkg, new IndexSink(), {
      sha256Hex: (d) => ctx.crypto.sha256Hex(d), level,
      deadlineAt: Date.now() + Math.max(0, timeLeftMs() - SAFETY_MS),
      checkpoint: { *load() { return c.verify; }, *save(st) { c.verify = st; yield* save(); } },
    });
    if (!res.done) return { done: false };
    const report = res.report;
    let manifestSha = res.manifest_sha256;
    let manifest = res.manifest;
    // a PARTIAL export legitimately references parents it did not select; that keeps it PARTIAL, not FAILED
    const onlyUnselectedParents = !!manifest && manifest.mode === 'PARTIAL' && report.error_count > 0 && report.error_count === report.errors.length && report.errors.every((e) => e.code === 'FK_PARENT_NOT_EXPORTED');
    if (manifest && !report.ok && !onlyUnselectedParents && manifest.completeness !== 'FAILED') {
      manifest = { ...manifest, completeness: 'FAILED', completeness_reasons: [...manifest.completeness_reasons, 'VERIFY_FAILED'] };
      const text = json(manifest);
      yield pkg.writeText('manifest.json', text);
      manifestSha = ctx.crypto.sha256Hex(text);
      yield pkg.writeText('manifest.sha256', manifestShaLine(manifestSha));
    }
    const completeness = manifest ? manifest.completeness : 'FAILED';
    const usable = report.ok && completeness === 'COMPLETE' && manifest.mode === 'FULL_SNAPSHOT';
    yield pkg.writeText('reports/validation.json', json({ format: 'cwk-validation', level, validated_at: ctx.now, validated_by: 'export', manifest_sha256: manifestSha, export_id: run.id, ok: report.ok, completeness, usable_for_cutover: usable, report: report.toJSON() }));
    const ok = (report.ok || onlyUnselectedParents) && completeness !== 'FAILED';
    const totalRows = manifest ? manifest.tables.reduce((s, t) => s + t.row_count, 0) : 0;
    yield* updateRun(ctx, run.id, {
      state: ok ? 'EXPORTED' : 'FAILED', manifest_sha256: manifestSha, completeness, finished_at: ctx.now,
      summary_json: {
        total_rows: totalRows, tables: manifest ? manifest.tables.length : 0, chunks: c.chunks, attachments: { files: c.att.files, bytes: c.att.bytes, missing: c.att.missing_count },
        completeness_reasons: manifest ? manifest.completeness_reasons : [], record_error_samples: c.record_error_samples, transforms: c.transforms,
        validation: { level, ok: report.ok, error_count: report.error_count, first_errors: report.errors.slice(0, 10) }, usable_for_cutover: usable,
      },
    }, 'EXPORT_DONE');
    c.phase = 'DONE';
    yield* save();
    return { done: true, result: { run_id: run.id, completeness, manifest_sha256: manifestSha, ok } };
  }
  return { done: true, result: { run_id: run.id } };
}

// Import Center operations: upload → preview → dry-run → apply (job). Conflict policy defaults to
// "reject mismatch": CONFLICT rows are never overwritten silently.
import { op } from '../dispatcher.js';
import { obj, S, notFound } from './common.js';
import { requirePermission } from '../authz.js';
import { commit, commitRaw } from '../context.js';
import { AppError } from '../../shared/errors.js';
import { parseCsv, toCsv } from '../../shared/csv.js';
import { utf8Decode } from '../../shared/canonical-json.js';
import { validateUpload, stageAttachment, linkAttachment, readAttachmentBytes } from '../files.js';
import { IMPORT_TYPES, templateCsvHeader, mapRows, autoMapping, normalizeImportRow } from '../imports/definitions.js';
import { loadReference, planImport, summarize, applyPlannedRow } from '../imports/planner.js';
import { enqueueJobOnce } from '../jobs.js';

export const MAX_IMPORT_ROWS = 5000;
const CHUNK = 50;

const OPTIONS = obj({
  date_format: { type: ['string', 'null'], enum: ['ISO', 'DMY_BE', 'DMY_CE', null] },
  default_effective_from: S.dateOrNull,
  update_existing: { type: ['boolean', 'null'] },
});

export function* parseSource(ctx, bytes, ext) {
  let table;
  if (ext === 'csv') table = parseCsv(utf8Decode(bytes));
  else if (ext === 'xlsx') {
    if (!ctx.platform.parseXlsx) throw new AppError('FEATURE_DISABLED', 'xlsx parsing not available', { messageTh: 'ระบบนี้ยังไม่รองรับไฟล์ XLSX กรุณาบันทึกเป็น CSV (UTF-8)' });
    table = yield ctx.platform.parseXlsx(bytes);
  } else throw new AppError('VALIDATION_ERROR', 'unsupported');
  if (!table.length) throw new AppError('VALIDATION_ERROR', 'empty', { messageTh: 'ไฟล์ไม่มีข้อมูล' });
  const header = table[0].map((h) => String(h).trim());
  const rows = table.slice(1).map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
  if (rows.length > MAX_IMPORT_ROWS) throw new AppError('PAYLOAD_TOO_LARGE', 'too many rows', { messageTh: `นำเข้าได้ไม่เกิน ${MAX_IMPORT_ROWS} แถวต่อครั้ง กรุณาแบ่งไฟล์` });
  return { header, rows };
}

function* loadBatch(ctx, id) {
  const b = yield ctx.store.get('ImportBatches', id);
  if (!b) throw notFound('import batch');
  return b;
}

function* batchRows(ctx, batch) {
  const bytes = yield* readAttachmentBytes(ctx, batch.source_attachment_id);
  const { header, rows } = yield* parseSource(ctx, bytes, batch.source_format.toLowerCase());
  return mapRows(header, rows, batch.mapping_json.columns || {});
}

export const importOps = [
  op({
    name: 'import.template', description_th: 'ไฟล์ตัวอย่าง CSV (UTF-8 BOM) ของการนำเข้าแต่ละชนิด', permission: 'import.manage',
    input: obj({ import_type: S.enum('ImportType') }, ['import_type']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'import.manage');
      const def = IMPORT_TYPES[input.import_type];
      return { filename: `cwk-import-${input.import_type.toLowerCase()}.csv`, mime_type: 'text/csv', content: toCsv(templateCsvHeader(input.import_type), []), columns: def.columns.map(([name, kind, required, label]) => ({ name, kind, required, label_th: label })) };
    },
  }),

  op({
    name: 'import.upload', mutation: true, rateLimitPerMinute: 10, description_th: 'อัปโหลดไฟล์นำเข้า (CSV/XLSX ≤ 5 MB, ≤ 5,000 แถว)', permission: 'import.manage',
    input: obj({ import_type: S.enum('ImportType'), file: obj({ filename: S.str(200), mime_type: S.strOrNull(100), content_base64: { type: 'string', minLength: 4 } }, ['filename', 'content_base64']) }, ['import_type', 'file']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'import.manage');
      const f = validateUpload(input.file, 'IMPORT_SOURCE');
      const { header, rows } = yield* parseSource(ctx, f.bytes, f.ext);
      const cs = ctx.changeSet();
      const att = yield* stageAttachment(ctx, cs, f, 'IMPORT_SOURCE');
      const mapping = autoMapping(input.import_type, header);
      const batch = cs.insert('ImportBatches', { import_type: input.import_type, source_attachment_id: att.id, source_format: f.ext.toUpperCase(), mapping_json: { columns: mapping, options: {} }, status: 'UPLOADED', row_count: rows.length });
      yield* linkAttachment(ctx, cs, att, 'IMPORT_BATCH', batch.id, 'IMPORT_SOURCE');
      cs.audit({ action: 'import.upload', entityType: 'ImportBatches', entityId: batch.id, after: { import_type: input.import_type, rows: rows.length, filename: f.filename } });
      yield* commit(ctx, cs, { batch_id: batch.id });
      return { batch_id: batch.id, header, row_count: rows.length, sample: rows.slice(0, 10), auto_mapping: mapping, columns: IMPORT_TYPES[input.import_type].columns.map(([name, kind, required, label]) => ({ name, kind, required, label_th: label })) };
    },
  }),

  op({
    name: 'import.preview', description_th: 'ดูตัวอย่างหลัง mapping (ไม่บันทึกข้อมูล)', permission: 'import.manage',
    input: obj({ batch_id: S.uuid, mapping: { type: 'object' }, options: OPTIONS }, ['batch_id', 'mapping']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'import.manage');
      const batch = yield* loadBatch(ctx, input.batch_id);
      const bytes = yield* readAttachmentBytes(ctx, batch.source_attachment_id);
      const { header, rows } = yield* parseSource(ctx, bytes, batch.source_format.toLowerCase());
      const mapped = mapRows(header, rows.slice(0, 20), input.mapping);
      return { rows: mapped.map((r, i) => ({ row_no: i + 2, ...normalizeImportRow(batch.import_type, r, { ...(input.options || {}), today: ctx.today }) })) };
    },
  }),

  op({
    name: 'import.dryRun', mutation: true, description_th: 'ตรวจทุกแถวและสรุปผลที่จะเกิด (เพิ่ม/แก้/ข้าม/ขัดแย้ง/ผิดพลาด) โดยไม่แก้ข้อมูลจริง', permission: 'import.manage',
    input: obj({ batch_id: S.uuid, mapping: { type: 'object' }, options: OPTIONS }, ['batch_id', 'mapping']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'import.manage');
      const batch = yield* loadBatch(ctx, input.batch_id);
      if (!['UPLOADED', 'PREVIEWED', 'VALIDATED'].includes(batch.status)) throw new AppError('INVALID_STATE', 'batch not editable');
      const bytes = yield* readAttachmentBytes(ctx, batch.source_attachment_id);
      const { header, rows } = yield* parseSource(ctx, bytes, batch.source_format.toLowerCase());
      const mapped = mapRows(header, rows, input.mapping);
      const ref = yield* loadReference(ctx, batch.import_type);
      const opts = { ...(input.options || {}), today: ctx.today };
      const plan = planImport(batch.import_type, mapped, ref, opts);
      const summary = summarize(plan);
      const attempt = ((batch.dry_run_summary_json && batch.dry_run_summary_json.attempt_no) || 0) + 1;
      const cs = ctx.changeSet();
      let written = 0;
      for (const r of plan) {
        for (const e of [...r.errors, ...r.warnings.map((w) => ({ ...w, code: `WARN_${w.code}` }))]) {
          if (written >= 1000) break;
          cs.insert('ImportErrors', { import_batch_id: batch.id, attempt_no: attempt, row_no: r.row_no, column_name: e.column, error_code: e.code, message_th: e.message_th.slice(0, 500), raw_value_redacted: null });
          written++;
        }
      }
      cs.update('ImportBatches', batch, {
        status: 'VALIDATED', mapping_json: { columns: input.mapping, options: input.options || {} }, dry_run_summary_json: { ...summary, attempt_no: attempt, at: ctx.now },
        row_count: plan.length, valid_count: summary.INSERT + summary.UPDATE + summary.SKIP, error_count: summary.ERROR + summary.CONFLICT,
      });
      yield* commit(ctx, cs, { batch_id: batch.id, attempt_no: attempt });
      return {
        batch_id: batch.id, attempt_no: attempt, summary,
        rows: plan.filter((r) => r.errors.length || r.warnings.length).slice(0, 200).map((r) => ({ row_no: r.row_no, action: r.action, errors: r.errors, warnings: r.warnings })),
      };
    },
  }),

  op({
    name: 'import.apply', mutation: true, description_th: 'เริ่มนำเข้าจริงเป็นงานเบื้องหลัง (แบ่งชุด resume ได้ รันซ้ำไม่สร้างซ้ำ)', permission: 'import.manage',
    input: obj({ batch_id: S.uuid, accept_skipping_conflicts: S.bool }, ['batch_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'import.manage');
      const batch = yield* loadBatch(ctx, input.batch_id);
      if (batch.status !== 'VALIDATED') throw new AppError('INVALID_STATE', 'dry-run required', { messageTh: 'ต้องตรวจ (dry-run) ให้ผ่านก่อนนำเข้า' });
      const sum = batch.dry_run_summary_json || {};
      if (sum.ERROR > 0) throw new AppError('VALIDATION_ERROR', 'errors remain', { messageTh: `ยังมีแถวผิดพลาด ${sum.ERROR} แถว ต้องแก้ไฟล์แล้วตรวจใหม่` });
      if (sum.CONFLICT > 0 && !input.accept_skipping_conflicts) throw new AppError('VALIDATION_ERROR', 'conflicts remain', { messageTh: `มีแถวขัดแย้ง ${sum.CONFLICT} แถว ระบบจะไม่เขียนทับ — ยืนยัน "ข้ามแถวที่ขัดแย้ง" หรือแก้ไฟล์` });
      const cs = ctx.changeSet();
      const job = yield* enqueueJobOnce(ctx, cs, { job_type: 'import.apply', payload: { batch_id: batch.id }, dedupe_key: `import|${batch.id}`, priority: 6 });
      if (!job) throw new AppError('INVALID_STATE', 'already running', { messageTh: 'ชุดนี้กำลังนำเข้าอยู่' });
      cs.update('ImportBatches', batch, { status: 'APPLYING', job_id: job.id });
      cs.audit({ action: 'import.apply', entityType: 'ImportBatches', entityId: batch.id, after: { summary: sum, accept_skipping_conflicts: !!input.accept_skipping_conflicts } });
      return yield* commit(ctx, cs, { batch_id: batch.id, job_id: job.id });
    },
  }),

  op({
    name: 'import.get', description_th: 'สถานะชุดนำเข้าและข้อผิดพลาดรายแถว', permission: 'import.manage',
    input: obj({ batch_id: S.uuid, attempt_no: { type: ['integer', 'null'], minimum: 1 } }, ['batch_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'import.manage');
      const batch = yield* loadBatch(ctx, input.batch_id);
      const attempt = input.attempt_no || (batch.dry_run_summary_json && batch.dry_run_summary_json.attempt_no) || null;
      const errors = attempt ? (yield ctx.store.findBy('ImportErrors', 'import_batch_id', batch.id)).filter((e) => e.attempt_no === attempt).sort((a, b) => a.row_no - b.row_no) : [];
      return { batch, errors: errors.slice(0, 500) };
    },
  }),

  op({
    name: 'import.list', description_th: 'ประวัติการนำเข้า', permission: 'import.manage', input: obj({ cursor: S.cursor, limit: S.limit }),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'import.manage');
      return yield ctx.store.list('ImportBatches', { orderBy: [['created_at', 'desc']], cursor: input.cursor, limit: input.limit || 30 });
    },
  }),
];

/** Job handler: apply a validated import batch in chunks with a resumable cursor. */
export function* importApplyJob(ctx, job, { checkpoint, timeLeftMs }) {
  const batch = yield ctx.store.get('ImportBatches', job.payload_json.batch_id);
  if (!batch) return { done: true, result: { error: 'batch missing' } };
  ctx.principal.user_id = batch.created_by; // attribute writes to the importer (authorized at import.apply)
  const rows = yield* batchRows(ctx, batch);
  const opts = { ...(batch.mapping_json.options || {}), today: ctx.today };
  let cursor = job.cursor_json || { next_row: 0, applied: 0, skipped: 0, conflicts: 0 };
  while (cursor.next_row < rows.length) {
    if (timeLeftMs() < 60000) return { done: false };
    const slice = rows.slice(cursor.next_row, cursor.next_row + CHUNK);
    const ref = yield* loadReference(ctx, batch.import_type);
    const plan = planImport(batch.import_type, slice, ref, opts).map((r) => ({ ...r, row_no: r.row_no + cursor.next_row }));
    const cs = ctx.changeSet('import.applyChunk');
    const memo = new Map();
    let applied = 0;
    let skipped = 0;
    let conflicts = 0;
    for (const r of plan) {
      if (r.action === 'INSERT' || r.action === 'UPDATE') { applyPlannedRow(batch.import_type, r, cs, ctx, ref, opts, memo); applied++; }
      else if (r.action === 'SKIP') skipped++;
      else conflicts++;
    }
    if (!cs.isEmpty) {
      cs.audit({ action: 'import.apply_chunk', entityType: 'ImportBatches', entityId: batch.id, after: { from_row: cursor.next_row + 2, rows: slice.length, applied, skipped, conflicts } });
      yield* commitRaw(ctx, cs);
    }
    cursor = { next_row: cursor.next_row + slice.length, applied: cursor.applied + applied, skipped: cursor.skipped + skipped, conflicts: cursor.conflicts + conflicts };
    yield* checkpoint(cursor, { done: cursor.next_row, total: rows.length, message_th: `นำเข้าแล้ว ${cursor.next_row}/${rows.length} แถว` });
  }
  const b2 = yield ctx.store.get('ImportBatches', batch.id);
  const cs = ctx.changeSet('import.finish');
  cs.update('ImportBatches', b2, { status: 'APPLIED', applied_count: cursor.applied });
  cs.audit({ action: 'import.applied', entityType: 'ImportBatches', entityId: batch.id, after: cursor });
  yield* commitRaw(ctx, cs);
  return { done: true, result: cursor };
}

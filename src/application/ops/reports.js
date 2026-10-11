// Reports (MASTER_PROMPT §12): catalog, on-screen preview, file runs (CSV/XLSX/PDF) as jobs with
// progress, secure download (permission re-checked; no secrets in links), lock + revision.
// Every run stores filter, as_of, schema/rule versions and requester to explain later differences.
import { listAll } from '../queries.js';
import { op } from '../dispatcher.js';
import { obj, S, notFound, assertVersion } from './common.js';
import { requirePermission, allows, scopeFor } from '../authz.js';
import { commit, loadSchool, setting } from '../context.js';
import { principalForBoundUser } from '../principal.js';
import { enqueueJob } from '../jobs.js';
import { stageAttachment, linkAttachment, readAttachmentBytes } from '../files.js';
import { REPORTS, OPTION_LABELS_TH } from '../reports/definitions.js';
import { renderFile, ROW_LIMITS } from '../reports/render.js';
import { profileOps } from './profile.js';
import { leaveOps } from './leave.js';
import { AppError, isAppError } from '../../shared/errors.js';
import { toBase64 } from '../../shared/hash.js';
import { localPartsOf } from '../../shared/time.js';
import { formatThaiDateTime } from '../../shared/thai-format.js';
import { SCHEMA_VERSION } from '../../schema/index.js';
import { ENUMS } from '../../schema/enums.js';

const CODES = Object.keys(REPORTS);
const FILTER = { type: 'object', maxProperties: 20, additionalProperties: { type: ['string', 'boolean', 'null'], maxLength: 100 } };
const handlerOf = (ops, name) => ops.find((o) => o.name === name).handler;
const HANDLERS = { profileHandler: handlerOf(profileOps, 'student.profile'), leaveGetHandler: handlerOf(leaveOps, 'leave.get') };

function hasGrant(ctx, action) {
  try { return !!scopeFor(ctx, action); } catch (e) { if (e.code === 'FORBIDDEN') return false; throw e; }
}

/** Grant-level check (any scope); the data scope itself is enforced by the report builder. */
function requireGrant(ctx, action) {
  if (!hasGrant(ctx, action)) throw new AppError('FORBIDDEN', `no ${action}`);
}

function cleanFilter(code, filter) {
  const allowed = new Set(REPORTS[code].filters.map((f) => f.name));
  const out = {};
  for (const [k, v] of Object.entries(filter || {})) {
    if (!allowed.has(k)) throw new AppError('VALIDATION_ERROR', 'unknown filter', { fieldErrors: [{ field: k, code: 'UNKNOWN', message_th: 'ตัวกรองไม่รองรับในรายงานนี้' }] });
    if (v === '' || v === null || v === undefined || v === false) continue;
    out[k] = v;
  }
  for (const f of REPORTS[code].filters) if (f.required && out[f.name] === undefined) throw new AppError('VALIDATION_ERROR', 'required', { fieldErrors: [{ field: f.name, code: 'REQUIRED', message_th: `ระบุ${f.label_th}` }] });
  return out;
}

function filterText(code, filter) {
  return REPORTS[code].filters.filter((f) => filter[f.name] !== undefined).map((f) => {
    const v = filter[f.name];
    const shown = f.type === 'enum' ? (ENUMS[f.enum].th[v] || v) : f.type === 'select' ? (OPTION_LABELS_TH[v] || v) : f.type === 'bool' ? 'ใช่' : v;
    return `${f.label_th}: ${shown}`;
  }).join(' · ');
}

/** Build the report as `principal` (the requester) — permission scope is applied inside the builder. */
export function* buildDoc(ctx, code, filter) {
  if (!hasGrant(ctx, REPORTS[code].permission)) throw new AppError('FORBIDDEN', `no ${REPORTS[code].permission}`);
  const res = yield* REPORTS[code].build(ctx, filter, HANDLERS);
  let school = null;
  try { school = yield* loadSchool(ctx); } catch (_) { school = null; }
  const signatures = yield* setting(ctx, 'report.signature_lines', []);
  const asOf = localPartsOf(ctx.now, ctx.tz);
  return {
    code, title: `${code} ${res.title_override || ENUMS.ReportCode.th[code]}`, subtitle: filterText(code, filter), columns: res.columns, rows: res.rows, totals: res.totals, notes_th: res.notes_th || [],
    rule_versions: res.rule_versions || {},
    meta: {
      school_name: school ? school.name_th : '', unit_th: school ? school.unit_th || '' : '', scope_th: res.scope_th || '', generated_by: ctx.principal.user ? ctx.principal.user.display_name : '',
      as_of: ctx.now, as_of_local: `${asOf.date} ${asOf.hhmm}`, as_of_th: formatThaiDateTime(ctx.now, ctx.tz), schema_version: SCHEMA_VERSION, signatures: Array.isArray(signatures) ? signatures : [],
    },
  };
}

function* canSeeRun(ctx, run) {
  if (run.requested_by === ctx.principal.user_id) return true;
  return yield* allows(ctx, 'report.lock'); // SCHOOL-scoped (student affairs/admin) may see all runs
}

export const reportOps = [
  op({
    name: 'report.catalog', description_th: 'รายงานที่บัญชีนี้ใช้ได้ พร้อมตัวกรองและรูปแบบไฟล์', permission: 'report.view | notification.monitor | audit.read | system.health',
    input: obj({}),
    *handler(ctx) {
      const canExport = hasGrant(ctx, 'report.export');
      const items = CODES.filter((c) => hasGrant(ctx, REPORTS[c].permission)).map((c) => ({
        code: c, title_th: ENUMS.ReportCode.th[c],
        filters: REPORTS[c].filters.map((f) => ({ ...f, options: f.type === 'enum' ? ENUMS[f.enum].values.map((v) => ({ value: v, label_th: ENUMS[f.enum].th[v] })) : f.options ? f.options.map((v) => ({ value: v, label_th: OPTION_LABELS_TH[v] || v })) : undefined })),
        formats: ['JSON', ...(canExport ? ['CSV', 'XLSX', 'PDF'] : [])],
      }));
      return { items, row_limits: ROW_LIMITS, can_lock: hasGrant(ctx, 'report.lock') };
    },
  }),

  op({
    name: 'report.preview', description_th: 'แสดงรายงานบนจอ (ไม่เกิน 500 แถว) — ใช้ projection เดียวกับแดชบอร์ด', permission: 'ตามรายงาน', rateLimitPerMinute: 30,
    input: obj({ code: { type: 'string', enum: CODES }, filter: FILTER }, ['code']),
    *handler(ctx, input) {
      const filter = cleanFilter(input.code, input.filter);
      const doc = yield* buildDoc(ctx, input.code, filter);
      return { ...doc, row_count: doc.rows.length, truncated: doc.rows.length > ROW_LIMITS.JSON, rows: doc.rows.slice(0, ROW_LIMITS.JSON) };
    },
  }),

  op({
    name: 'report.run', mutation: true, description_th: 'สร้างไฟล์รายงาน (CSV/XLSX/PDF) เป็นงานเบื้องหลัง', permission: 'report.export + สิทธิ์ของรายงาน', rateLimitPerMinute: 10,
    input: obj({ code: { type: 'string', enum: CODES }, filter: FILTER, format: { type: 'string', enum: ['CSV', 'XLSX', 'PDF'] } }, ['code', 'format']),
    *handler(ctx, input) {
      requireGrant(ctx, 'report.export');
      if (!hasGrant(ctx, REPORTS[input.code].permission)) throw new AppError('FORBIDDEN', 'report permission');
      const filter = cleanFilter(input.code, input.filter);
      const cs = ctx.changeSet();
      const run = cs.insert('ReportRuns', {
        report_code: input.code, filter_json: filter, as_of: ctx.now, schema_version: SCHEMA_VERSION, rule_versions_json: null, status: 'QUEUED', output_format: input.format,
        locked: false, requested_by: ctx.principal.user_id,
      });
      const job = enqueueJob(cs, ctx, { job_type: 'report.render', payload: { run_id: run.id }, priority: 6, max_attempts: 3 });
      cs.update('ReportRuns', run, { job_id: job.id });
      cs.audit({ action: 'report.run', entityType: 'ReportRuns', entityId: run.id, after: { code: input.code, format: input.format, filter } });
      return yield* commit(ctx, cs, { run_id: run.id, job_id: job.id });
    },
  }),

  op({
    name: 'report.rerun', mutation: true, description_th: 'สร้างรายงานฉบับใหม่ด้วยตัวกรองเดิม (revision) — ฉบับเดิมยังเก็บไว้', permission: 'report.export',
    input: obj({ run_id: S.uuid }, ['run_id']),
    *handler(ctx, input) {
      requireGrant(ctx, 'report.export');
      const old = yield ctx.store.get('ReportRuns', input.run_id);
      if (!old || !(yield* canSeeRun(ctx, old))) throw notFound('report run');
      if (!hasGrant(ctx, REPORTS[old.report_code].permission)) throw new AppError('FORBIDDEN', 'report permission');
      const cs = ctx.changeSet();
      const run = cs.insert('ReportRuns', {
        report_code: old.report_code, filter_json: old.filter_json, as_of: ctx.now, schema_version: SCHEMA_VERSION, rule_versions_json: null, status: 'QUEUED', output_format: old.output_format,
        locked: false, requested_by: ctx.principal.user_id, supersedes_run_id: old.id,
      });
      const job = enqueueJob(cs, ctx, { job_type: 'report.render', payload: { run_id: run.id }, priority: 6, max_attempts: 3 });
      cs.update('ReportRuns', run, { job_id: job.id });
      cs.audit({ action: 'report.rerun', entityType: 'ReportRuns', entityId: run.id, after: { supersedes: old.id } });
      return yield* commit(ctx, cs, { run_id: run.id, job_id: job.id });
    },
  }),

  op({
    name: 'report.runs', description_th: 'รายการไฟล์รายงานที่สร้าง (ของฉัน หรือทั้งหมดสำหรับผู้ล็อกรายงานได้)', permission: 'report.export | report.lock',
    input: obj({ code: { type: ['string', 'null'], enum: [...CODES, null] }, limit: S.limit }),
    *handler(ctx, input) {
      const all = hasGrant(ctx, 'report.lock');
      if (!all) requireGrant(ctx, 'report.export');
      const where = {};
      if (input.code) where.report_code = input.code;
      if (!all) where.requested_by = ctx.principal.user_id;
      const runs = (yield* listAll(ctx, 'ReportRuns', { where })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, input.limit || 50);
      const users = yield ctx.store.getMany('Users', [...new Set(runs.map((r) => r.requested_by))]);
      return {
        items: runs.map((r) => ({
          id: r.id, report_code: r.report_code, title_th: ENUMS.ReportCode.th[r.report_code], filter_th: filterText(r.report_code, r.filter_json || {}), output_format: r.output_format, status: r.status, row_count: r.row_count,
          as_of: r.as_of, locked: r.locked, locked_at: r.locked_at, supersedes_run_id: r.supersedes_run_id, superseded_by_run_id: r.superseded_by_run_id, job_id: r.job_id,
          requested_by_name: users.get(r.requested_by) ? users.get(r.requested_by).display_name : '', rule_versions: r.rule_versions_json, version: r.version,
        })),
      };
    },
  }),

  op({
    name: 'report.download', description_th: 'ดาวน์โหลดไฟล์รายงาน (ตรวจสิทธิ์อีกครั้งทุกครั้ง)', permission: 'report.export', rateLimitPerMinute: 30,
    input: obj({ run_id: S.uuid }, ['run_id']),
    *handler(ctx, input) {
      requireGrant(ctx, 'report.export');
      const run = yield ctx.store.get('ReportRuns', input.run_id);
      if (!run || !(yield* canSeeRun(ctx, run))) throw notFound('report run');
      if (!hasGrant(ctx, REPORTS[run.report_code].permission)) throw new AppError('FORBIDDEN', 'report permission');
      if (run.status !== 'READY' && run.status !== 'SUPERSEDED') throw new AppError('INVALID_STATE', 'not ready', { messageTh: 'ไฟล์ยังไม่พร้อม' });
      const att = yield ctx.store.get('Attachments', run.output_attachment_id);
      if (!att || att.status === 'DELETED') throw new AppError('NOT_FOUND', 'file removed', { messageTh: 'ไฟล์ถูกลบตามระยะเวลาเก็บแล้ว — สร้างใหม่ได้' });
      const bytes = yield* readAttachmentBytes(ctx, att.id);
      if (ctx.crypto.sha256Hex(bytes) !== att.sha256) throw new AppError('INTEGRITY_ERROR', 'checksum', { messageTh: 'ไฟล์เสียหาย (checksum ไม่ตรง)' });
      // audit the export download (who took data out, which run)
      const cs = ctx.changeSet();
      cs.audit({ action: 'report.download', entityType: 'ReportRuns', entityId: run.id, after: { code: run.report_code, format: run.output_format, rows: run.row_count } });
      yield* commit(ctx, cs, {});
      return { filename: att.original_filename, mime_type: att.mime_type, size_bytes: att.size_bytes, content_base64: toBase64(bytes) };
    },
  }),

  op({
    name: 'report.lock', mutation: true, description_th: 'ล็อกรายงานเป็นฉบับทางการ (แก้ไขข้อมูลภายหลังต้องออกฉบับใหม่ ฉบับนี้ไม่เปลี่ยน)', permission: 'report.lock',
    input: obj({ run_id: S.uuid, note: S.strOrNull(500) }, ['run_id']),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'report.lock');
      const run = yield ctx.store.get('ReportRuns', input.run_id);
      if (!run) throw notFound('report run');
      assertVersion(run, env.expected_version);
      if (run.status !== 'READY') throw new AppError('INVALID_STATE', 'not ready', { messageTh: 'ล็อกได้เฉพาะรายงานที่สร้างเสร็จและยังไม่ถูกแทนที่' });
      if (run.locked) return { run_id: run.id, locked: true };
      const cs = ctx.changeSet();
      const after = cs.update('ReportRuns', run, { locked: true, locked_by: ctx.principal.user_id, locked_at: ctx.now });
      cs.audit({ action: 'report.lock', entityType: 'ReportRuns', entityId: run.id, reason: input.note });
      return yield* commit(ctx, cs, { run_id: run.id, locked: true, version: after.version });
    },
  }),
];

/** Job: build as the requester (permissions re-checked now), render, store as a private attachment. */
export function* reportRenderJob(ctx, job) {
  const run = yield ctx.store.get('ReportRuns', job.payload_json.run_id);
  if (!run || run.status === 'READY') return { done: true, result: { skipped: true } };
  const user = yield ctx.store.get('Users', run.requested_by);
  const finish = function* (patch, audit) {
    const latest = yield ctx.store.get('ReportRuns', run.id);
    const cs = ctx.changeSet('report.finish');
    cs.update('ReportRuns', latest, patch);
    if (audit) cs.audit(audit);
    yield ctx.mutations.commit(cs.build({ result: {} }));
  };
  let doc;
  let file;
  try {
    ctx.principal = yield* principalForBoundUser(ctx, user, 'JOB');
    {
      const cs = ctx.changeSet('report.start');
      cs.update('ReportRuns', run, { status: 'RUNNING' });
      yield ctx.mutations.commit(cs.build({ result: {} }));
    }
    doc = yield* buildDoc(ctx, run.report_code, run.filter_json || {});
    file = yield* renderFile(ctx, doc, run.output_format);
  } catch (e) {
    const final = (isAppError(e) && !e.retryable) || (e && e.code === 'CONFIGURATION_REQUIRED') || job.attempts >= job.max_attempts;
    if (final) {
      yield* finish({ status: 'FAILED' }, { action: 'report.failed', entityType: 'ReportRuns', entityId: run.id, after: { code: (e && e.code) || 'PLATFORM_ERROR' } });
      return { done: true, result: { failed: (e && e.code) || 'PLATFORM_ERROR', message_th: e && e.messageTh ? e.messageTh : null } };
    }
    throw e; // retryable/platform errors → job retry with backoff
  }
  const cs = ctx.changeSet('report.store');
  const att = yield* stageAttachment(ctx, cs, { bytes: file.bytes, filename: file.filename, mime: file.mime, size: file.bytes.length }, 'REPORT');
  yield* linkAttachment(ctx, cs, att, 'REPORT_RUN', run.id, 'OUTPUT');
  const latest = yield ctx.store.get('ReportRuns', run.id);
  cs.update('ReportRuns', latest, { status: 'READY', output_attachment_id: att.id, row_count: doc.rows.length, totals_json: doc.totals, rule_versions_json: doc.rule_versions });
  if (run.supersedes_run_id) {
    const old = yield ctx.store.get('ReportRuns', run.supersedes_run_id);
    if (old && !old.superseded_by_run_id) cs.update('ReportRuns', old, { superseded_by_run_id: run.id, status: old.status === 'READY' ? 'SUPERSEDED' : old.status });
  }
  cs.audit({ action: 'report.ready', entityType: 'ReportRuns', entityId: run.id, after: { rows: doc.rows.length, format: run.output_format } });
  yield ctx.mutations.commit(cs.build({ result: {} }));
  return { done: true, result: { run_id: run.id, rows: doc.rows.length } };
}

export const REPORT_JOB_HANDLERS = { 'report.render': reportRenderJob };

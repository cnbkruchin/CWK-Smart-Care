// Migration Center (MASTER_PROMPT §15.1, §15.7): inventory, portable export (job), pause/resume/cancel,
// package validation (job), evidence from the import target (reports/import.json, reports/reconciliation.json
// written into the package by the target importer or tools/migrate.mjs), readiness checklist, cutover and
// rollback through the Migration state machine. Only SYSTEM_ADMIN holds migration.* permissions.
//
// Imports never run here: a package is imported into a NEW environment (another Apps Script project via
// adminImportPackage, or PostgreSQL via tools/migrate.mjs) — this system is never overwritten.
import { op } from '../dispatcher.js';
import { obj, S, notFound } from './common.js';
import { requirePermission } from '../authz.js';
import { commit, commitRaw } from '../context.js';
import { enqueueJob } from '../jobs.js';
import { listAll } from '../queries.js';
import { assertTransition, MACHINES } from '../../domain/state-machines.js';
import { AppError, isAppError } from '../../shared/errors.js';
import { EXCLUDED_TABLES, LIVE_TABLES, exportTables } from '../migration/format.js';
import { inventory, exportJob, maxChangeSeq, EXPORT_JOB } from '../migration/export.js';
import { processPackage } from '../migration/process.js';
import { IndexSink } from '../migration/sinks.js';
import { getTable } from '../../schema/index.js';

export const VALIDATE_JOB = 'migration.validate';
export const CUTOVER_SETTING = 'migration.cutover_active';

/** Readiness checklist (all required before CUTOVER_READY). */
export const READINESS_ITEMS = Object.freeze([
  { key: 'rehearsal_done', label_th: 'ซ้อมย้ายบน staging สำเร็จ (โหมด REHEARSAL) และบันทึกเวลาที่ใช้' },
  { key: 'backup_verified', label_th: 'สำรองข้อมูลต้นทางล่าสุดและเคยทดสอบ restore แล้ว' },
  { key: 'maintenance_window', label_th: 'ประกาศช่วงปิดปรับปรุง ผู้รับผิดชอบ และช่องทางติดต่อแล้ว' },
  { key: 'identity_ready', label_th: 'ระบบใหม่ตั้ง identity provider, callback URL และ allowed domains แล้ว (ผู้ใช้อาจต้องเข้าสู่ระบบใหม่)' },
  { key: 'secrets_ready', label_th: 'ตั้ง secrets ใหม่ที่ระบบปลายทางแล้ว (package ไม่มี secrets)' },
  { key: 'integrations_ready', label_th: 'แผนย้าย LINE webhook, triggers/scheduler และสิทธิ์ storage พร้อม' },
  { key: 'roles_verified', label_th: 'ตรวจสิทธิ์ผู้ใช้ตัวอย่างทุกบทบาทบนระบบใหม่ (รวมผู้ปกครองหลายบุตร)' },
  { key: 'notifications_reviewed', label_th: 'ตรวจคิวแจ้งเตือนที่นำเข้า (replay_blocked) ก่อนเปิดส่ง' },
  { key: 'rollback_plan', label_th: 'ทบทวนแผนย้อนกลับ (MIGRATION_RUNBOOK_TH §8) และผู้มีอำนาจตัดสินใจ' },
]);

function* requireRun(ctx, id) {
  const r = yield ctx.store.get('MigrationRuns', id);
  if (!r || r.run_type !== 'EXPORT') throw notFound('migration run');
  return r;
}

function* readReport(ctx, run, path) {
  if (!ctx.platform.packageStore || !run.package_location) return null;
  try {
    const h = yield ctx.platform.packageStore.open(run.package_location);
    const t = yield h.readText(path);
    return t ? JSON.parse(t) : null;
  } catch (e) {
    if (isAppError(e)) throw e;
    return null;
  }
}

function allowedActions(state) {
  return MACHINES.Migration.transitions.filter((t) => t.from.includes(state || '(new)')).map((t) => t.action);
}

function* cutoverSetting(ctx) {
  const rows = yield ctx.store.findBy('Settings', 'key', CUTOVER_SETTING);
  return rows[0] || null;
}

function runView(r, job) {
  return {
    id: r.id, mode: r.mode, state: r.state, completeness: r.completeness, manifest_sha256: r.manifest_sha256, package_location: r.package_location,
    started_at: r.started_at, finished_at: r.finished_at, scope: r.scope_json, high_water_mark: r.high_water_marks_json ? r.high_water_marks_json.change_log_seq : null,
    summary: r.summary_json || {}, version: r.version, allowed_actions: allowedActions(r.state),
    job: job ? { id: job.id, status: job.status, progress: job.progress_json, attempts: job.attempts, last_error: job.last_error, heartbeat_at: job.heartbeat_at } : null,
  };
}

function* patchRun(ctx, run, patch, action, audit) {
  if (action) assertTransition('Migration', run.state, action);
  const cs = ctx.changeSet();
  cs.maintenanceAllowed = true;
  const next = cs.update('MigrationRuns', run, patch);
  if (audit) cs.audit({ entityType: 'MigrationRuns', entityId: run.id, ...audit });
  return { cs, next };
}

export const migrationOps = [
  op({
    name: 'migration.inventory', description_th: 'รายการข้อมูลทั้งหมด: ตาราง partition จำนวนรายการ ไฟล์แนบ schema version ขนาดประมาณการ และตารางที่ไม่ส่งออก', permission: 'migration.export',
    input: obj({}), maintenanceAllowed: true,
    *handler(ctx) {
      yield* requirePermission(ctx, 'migration.export');
      const inv = yield* inventory(ctx);
      return { ...inv, excluded: Object.entries(EXCLUDED_TABLES).map(([name, e]) => ({ name, ...e })), live_tables: LIVE_TABLES, exportable_tables: exportTables() };
    },
  }),

  op({
    name: 'migration.startExport', mutation: true, maintenanceAllowed: true, permission: 'migration.export',
    description_th: 'เริ่มส่งออก portable package (งานเบื้องหลัง): ภาพรวมทั้งระบบ/ซ้อมย้าย ต้องเปิดโหมดอ่านอย่างเดียวก่อน; บางส่วนระบุตาราง (ใช้ย้ายระบบทั้งชุดไม่ได้)',
    input: obj({
      mode: { type: 'string', enum: ['FULL_SNAPSHOT', 'REHEARSAL', 'PARTIAL'] },
      tables: { type: ['array', 'null'], maxItems: 80, uniqueItems: true, items: { type: 'string', maxLength: 60 } },
      include_attachments: S.bool, include_csv: S.bool, reason: S.str(500, 3),
    }, ['mode', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.export');
      if (!ctx.platform.packageStore) throw new AppError('FEATURE_DISABLED', 'package store not configured', { messageTh: 'แพลตฟอร์มนี้ยังไม่มีที่เก็บ package ส่งออก' });
      const frozen = input.mode !== 'PARTIAL';
      if (frozen && ctx.config.systemMode !== 'READ_ONLY') throw new AppError('INVALID_STATE', 'freeze required', { messageTh: 'เปิดโหมดอ่านอย่างเดียว (หน้าสถานะระบบ) ก่อนส่งออกภาพรวมทั้งระบบหรือซ้อมย้าย' });
      const all = exportTables();
      let tables = null;
      let missing = [];
      if (input.mode === 'PARTIAL') {
        if (!input.tables || !input.tables.length) throw new AppError('VALIDATION_ERROR', 'tables required', { fieldErrors: [{ field: 'tables', code: 'REQUIRED', message_th: 'เลือกตารางที่ต้องการส่งออก' }] });
        const bad = input.tables.filter((t) => !all.includes(t));
        if (bad.length) throw new AppError('VALIDATION_ERROR', 'unknown tables', { fieldErrors: [{ field: 'tables', code: 'ENUM', message_th: `ตารางที่ส่งออกไม่ได้: ${bad.join(', ')}` }] });
        tables = all.filter((t) => input.tables.includes(t));
        for (const t of tables) for (const c of getTable(t).columns) if (c.fk && !EXCLUDED_TABLES[c.fk] && !tables.includes(c.fk)) missing.push(`${t}.${c.name} → ${c.fk}`);
        missing = [...new Set(missing)];
      } else if (input.tables && input.tables.length) {
        throw new AppError('VALIDATION_ERROR', 'tables only for PARTIAL', { fieldErrors: [{ field: 'tables', code: 'NOT_ALLOWED', message_th: 'ภาพรวมทั้งระบบส่งออกทุกตาราง' }] });
      }
      const active = (yield* listAll(ctx, 'MigrationRuns', { where: { run_type: 'EXPORT', state: { in: ['PLANNED', 'SNAPSHOTTING'] } } }));
      if (active.length) throw new AppError('INVALID_STATE', 'export running', { messageTh: 'มีงานส่งออกที่ยังทำงานอยู่ — รอให้เสร็จหรือยกเลิกก่อน' });
      assertTransition('Migration', null, 'PLAN');
      const cs = ctx.changeSet();
      cs.maintenanceAllowed = true;
      const run = cs.insert('MigrationRuns', {
        run_type: 'EXPORT', mode: input.mode, state: 'PLANNED', scope_json: { tables, include_attachments: input.include_attachments !== false, include_csv: input.include_csv !== false, reason: input.reason, missing_dependencies: missing },
        started_by: ctx.principal.user_id, started_at: ctx.now,
      });
      const job = enqueueJob(cs, ctx, { job_type: EXPORT_JOB, payload: { run_id: run.id }, priority: 8, max_attempts: 3, dedupe_key: `export|${run.id}` });
      cs.update('MigrationRuns', run, { job_id: job.id });
      cs.audit({ action: 'migration.export_requested', entityType: 'MigrationRuns', entityId: run.id, reason: input.reason, after: { mode: input.mode, tables: tables ? tables.length : 'ALL' } });
      return yield* commit(ctx, cs, { run_id: run.id, job_id: job.id, missing_dependencies: missing, partial: input.mode === 'PARTIAL' });
    },
  }),

  op({
    name: 'migration.runs', description_th: 'งานส่งออก/ย้ายข้อมูลทั้งหมด พร้อมสถานะงานเบื้องหลัง', permission: 'migration.export', maintenanceAllowed: true,
    input: obj({ limit: S.limit }),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.export');
      const runs = (yield* listAll(ctx, 'MigrationRuns', { where: { run_type: 'EXPORT' } })).sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, input.limit || 20);
      const items = [];
      for (const r of runs) items.push(runView(r, r.job_id ? yield ctx.store.get('Jobs', r.job_id) : null));
      const co = yield* cutoverSetting(ctx);
      return { items, cutover_active: co ? co.value_json : null, system_mode: ctx.config.systemMode || 'NORMAL' };
    },
  }),

  op({
    name: 'migration.get', description_th: 'รายละเอียดงาน: checkpoint ผลตรวจ package หลักฐานนำเข้า/กระทบยอด และ checklist', permission: 'migration.export', maintenanceAllowed: true,
    input: obj({ run_id: S.uuid }, ['run_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.export');
      const r = yield* requireRun(ctx, input.run_id);
      const job = r.job_id ? yield ctx.store.get('Jobs', r.job_id) : null;
      const cps = yield ctx.store.findBy('MigrationCheckpoints', 'migration_run_id', r.id);
      const validation = yield* readReport(ctx, r, 'reports/validation.json');
      const imported = yield* readReport(ctx, r, 'reports/import.json');
      const reconciliation = yield* readReport(ctx, r, 'reports/reconciliation.json');
      const summarize = (x) => (x ? { ok: x.ok, overall: x.overall, level: x.level, target: x.target, manifest_matches: x.manifest_sha256 === r.manifest_sha256, at: x.validated_at || x.finished_at || x.reconciled_at, error_count: x.report ? x.report.error_count : x.error_count, failed_checks: (x.checks || []).filter((c) => c.status === 'FAIL').map((c) => c.key), ready_to_cutover: x.ready_to_cutover } : null);
      return {
        run: runView(r, job), chunks: cps.filter((x) => x.step === 'CHUNK').length,
        validation: summarize(validation), validation_errors: validation && validation.report ? validation.report.errors.slice(0, 20) : [],
        import_report: summarize(imported), reconciliation: summarize(reconciliation),
        reconciliation_checks: reconciliation ? reconciliation.checks.map((c) => ({ key: c.key, status: c.status, detail_th: c.detail_th })) : [],
        checklist: READINESS_ITEMS.map((i) => ({ ...i, done: !!(r.summary_json && r.summary_json.checklist && r.summary_json.checklist[i.key]) })),
      };
    },
  }),

  op({
    name: 'migration.packageDoc', description_th: 'ดาวน์โหลดคู่มือที่แนบใน package (ตรงกับ schema/app version ของ package นั้น)', permission: 'migration.export', maintenanceAllowed: true,
    input: obj({ run_id: S.uuid, name: { type: 'string', enum: ['PORTABLE_FORMAT.md', 'MIGRATION_RUNBOOK_TH.md'] } }, ['run_id', 'name']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.export');
      const r = yield* requireRun(ctx, input.run_id);
      if (!ctx.platform.packageStore || !r.package_location) throw notFound('package');
      const h = yield ctx.platform.packageStore.open(r.package_location);
      const text = yield h.readText(`docs/${input.name}`);
      if (text === null) throw notFound('document');
      return { filename: input.name, mime_type: 'text/markdown; charset=utf-8', text };
    },
  }),

  op({
    name: 'migration.pause', mutation: true, maintenanceAllowed: true, description_th: 'หยุดงานส่งออกชั่วคราวอย่างปลอดภัย (หยุดหลัง chunk ปัจจุบัน)', permission: 'migration.export',
    input: obj({ run_id: S.uuid }, ['run_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.export');
      const r = yield* requireRun(ctx, input.run_id);
      if (!['PLANNED', 'SNAPSHOTTING'].includes(r.state)) throw new AppError('INVALID_STATE', 'not running', { messageTh: 'งานนี้ไม่ได้กำลังทำงาน' });
      const { cs } = yield* patchRun(ctx, r, { summary_json: { ...(r.summary_json || {}), pause_requested: true } }, null, { action: 'migration.pause' });
      const job = r.job_id ? yield ctx.store.get('Jobs', r.job_id) : null;
      if (job && job.status === 'QUEUED') cs.update('Jobs', job, { status: 'PAUSED' });
      return yield* commit(ctx, cs, { run_id: r.id, paused: true });
    },
  }),

  op({
    name: 'migration.resume', mutation: true, maintenanceAllowed: true, description_th: 'ทำงานส่งออกต่อจาก checkpoint ล่าสุด', permission: 'migration.export',
    input: obj({ run_id: S.uuid }, ['run_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.export');
      const r = yield* requireRun(ctx, input.run_id);
      if (!['PLANNED', 'SNAPSHOTTING'].includes(r.state)) throw new AppError('INVALID_STATE', 'not resumable', { messageTh: 'งานนี้ทำต่อไม่ได้ในสถานะปัจจุบัน' });
      const s = { ...(r.summary_json || {}) };
      delete s.pause_requested;
      const { cs } = yield* patchRun(ctx, r, { summary_json: s }, null, { action: 'migration.resume' });
      const job = r.job_id ? yield ctx.store.get('Jobs', r.job_id) : null;
      if (job && ['PAUSED', 'FAILED'].includes(job.status)) cs.update('Jobs', job, { status: 'QUEUED', next_run_at: ctx.now, attempts: job.status === 'FAILED' ? 0 : job.attempts, last_error: null, finished_at: null });
      return yield* commit(ctx, cs, { run_id: r.id, resumed: true });
    },
  }),

  op({
    name: 'migration.cancel', mutation: true, maintenanceAllowed: true, description_th: 'ยกเลิกงาน (ไฟล์ที่ส่งออกแล้วยังอยู่ แต่ใช้ย้ายระบบไม่ได้)', permission: 'migration.export',
    input: obj({ run_id: S.uuid, reason: S.str(500, 3) }, ['run_id', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.export');
      const r = yield* requireRun(ctx, input.run_id);
      if (r.state === 'ACTIVE') throw new AppError('INVALID_STATE', 'active', { messageTh: 'ระบบใหม่ใช้งานแล้ว — ใช้การย้อนกลับ (rollback) ตาม RUNBOOK แทน' });
      const { cs } = yield* patchRun(ctx, r, { state: 'CANCELLED', finished_at: ctx.now }, 'CANCEL', { action: 'migration.cancel', reason: input.reason });
      const job = r.job_id ? yield ctx.store.get('Jobs', r.job_id) : null;
      if (job && ['QUEUED', 'PAUSED'].includes(job.status)) cs.update('Jobs', job, { status: 'CANCELLED', finished_at: ctx.now });
      return yield* commit(ctx, cs, { run_id: r.id, state: 'CANCELLED', note_th: 'ยังอยู่ในโหมดอ่านอย่างเดียว — ปิดโหมดเองที่หน้าสถานะระบบเมื่อพร้อม' });
    },
  }),

  op({
    name: 'migration.validate', mutation: true, maintenanceAllowed: true, description_th: 'ตรวจ package ซ้ำ (checksum, schema, ข้อมูล) เป็นงานเบื้องหลัง → ผ่าน = VALIDATED', permission: 'migration.validate',
    input: obj({ run_id: S.uuid }, ['run_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.validate');
      const r = yield* requireRun(ctx, input.run_id);
      assertTransition('Migration', r.state, 'VALIDATE');
      const cs = ctx.changeSet();
      cs.maintenanceAllowed = true;
      const job = enqueueJob(cs, ctx, { job_type: VALIDATE_JOB, payload: { run_id: r.id }, priority: 8, max_attempts: 2, dedupe_key: `validate|${r.id}` });
      cs.audit({ action: 'migration.validate_requested', entityType: 'MigrationRuns', entityId: r.id });
      return yield* commit(ctx, cs, { run_id: r.id, job_id: job.id });
    },
  }),

  op({
    name: 'migration.recordEvidence', mutation: true, maintenanceAllowed: true, permission: 'migration.import',
    description_th: 'อ่านหลักฐานจากปลายทางใน package (reports/import.json → STAGED, reports/reconciliation.json → RECONCILED เมื่อผ่านทุกหัวข้อ)',
    input: obj({ run_id: S.uuid, kind: { type: 'string', enum: ['IMPORT', 'RECONCILIATION'] } }, ['run_id', 'kind']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.import');
      const r = yield* requireRun(ctx, input.run_id);
      const path = input.kind === 'IMPORT' ? 'reports/import.json' : 'reports/reconciliation.json';
      const rep = yield* readReport(ctx, r, path);
      if (!rep) throw new AppError('NOT_FOUND', 'report missing', { messageTh: `ไม่พบ ${path} ในโฟลเดอร์ package — รันการนำเข้า/กระทบยอดที่ปลายทางแล้ววางไฟล์รายงานในโฟลเดอร์ reports/ ของ package` });
      if (rep.manifest_sha256 !== r.manifest_sha256) throw new AppError('INTEGRITY_ERROR', 'report belongs to another package', { messageTh: 'รายงานนี้ไม่ได้มาจาก package ของงานนี้ (manifest checksum ไม่ตรง)', details: { report_manifest_sha256: rep.manifest_sha256 || null, run_manifest_sha256: r.manifest_sha256 } });
      const summary = { ...(r.summary_json || {}) };
      if (input.kind === 'IMPORT') {
        if (!rep.ok || rep.mode !== 'APPLY') throw new AppError('INVALID_STATE', 'import not applied', { messageTh: 'รายงานแสดงว่าการนำเข้ายังไม่สำเร็จ (ต้องเป็น --apply และไม่มีข้อผิดพลาด)' });
        summary.import = { target: rep.target, finished_at: rep.finished_at, rows: rep.rows_inserted, identical: rep.rows_identical };
        const { cs } = yield* patchRun(ctx, r, { state: 'STAGED', summary_json: summary }, 'STAGE', { action: 'migration.staged', after: summary.import });
        return yield* commit(ctx, cs, { run_id: r.id, state: 'STAGED' });
      }
      summary.reconciliation = { overall: rep.overall, ready_to_cutover: !!rep.ready_to_cutover, target: rep.target, at: rep.reconciled_at, failed: (rep.checks || []).filter((c) => c.status === 'FAIL').map((c) => c.key) };
      if (rep.overall !== 'PASS') {
        // keep STAGED: the target can be fixed/re-imported and reconciled again; never READY on FAIL
        if (r.state !== 'STAGED') throw new AppError('INVALID_STATE', 'not staged', { messageTh: 'ต้องบันทึกผลนำเข้า (STAGED) ก่อน' });
        const { cs } = yield* patchRun(ctx, r, { summary_json: summary }, null, { action: 'migration.reconciliation_failed', after: summary.reconciliation });
        return yield* commit(ctx, cs, { run_id: r.id, state: r.state, overall: 'FAIL', failed: summary.reconciliation.failed });
      }
      const { cs } = yield* patchRun(ctx, r, { state: 'RECONCILED', summary_json: summary }, 'RECONCILE', { action: 'migration.reconciled', after: summary.reconciliation });
      return yield* commit(ctx, cs, { run_id: r.id, state: 'RECONCILED', overall: 'PASS' });
    },
  }),

  op({
    name: 'migration.checklist', mutation: true, maintenanceAllowed: true, description_th: 'บันทึก readiness checklist ก่อนสลับระบบ', permission: 'migration.cutover',
    input: obj({ run_id: S.uuid, items: { type: 'object', additionalProperties: { type: 'boolean' }, maxProperties: 20 } }, ['run_id', 'items']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.cutover');
      const r = yield* requireRun(ctx, input.run_id);
      if (!['VALIDATED', 'STAGED', 'RECONCILED', 'CUTOVER_READY'].includes(r.state)) throw new AppError('INVALID_STATE', 'checklist not applicable', { messageTh: 'บันทึก checklist ได้หลังตรวจ package ผ่าน' });
      const keys = new Set(READINESS_ITEMS.map((i) => i.key));
      const bad = Object.keys(input.items).filter((k) => !keys.has(k));
      if (bad.length) throw new AppError('VALIDATION_ERROR', 'unknown checklist item', { fieldErrors: [{ field: 'items', code: 'UNKNOWN', message_th: `ไม่รู้จัก ${bad.join(', ')}` }] });
      const checklist = { ...((r.summary_json && r.summary_json.checklist) || {}), ...input.items };
      const { cs } = yield* patchRun(ctx, r, { summary_json: { ...(r.summary_json || {}), checklist, checklist_by: ctx.principal.user_id, checklist_at: ctx.now } }, null, { action: 'migration.checklist', after: input.items });
      return yield* commit(ctx, cs, { run_id: r.id, done: READINESS_ITEMS.filter((i) => checklist[i.key]).length, total: READINESS_ITEMS.length });
    },
  }),

  op({
    name: 'migration.markReady', mutation: true, maintenanceAllowed: true, description_th: 'ยืนยันพร้อมสลับระบบ (ต้องกระทบยอดผ่าน + checklist ครบ + package ครบถ้วน)', permission: 'migration.cutover',
    input: obj({ run_id: S.uuid }, ['run_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.cutover');
      const r = yield* requireRun(ctx, input.run_id);
      const s = r.summary_json || {};
      const why = [];
      if (r.mode !== 'FULL_SNAPSHOT') why.push('package ไม่ใช่ภาพรวมทั้งระบบ (FULL_SNAPSHOT)');
      if (r.completeness !== 'COMPLETE') why.push(`completeness = ${r.completeness}`);
      if (!s.reconciliation || s.reconciliation.overall !== 'PASS' || !s.reconciliation.ready_to_cutover) why.push('ยังไม่มีผลกระทบยอดที่ผ่านทุกหัวข้อ');
      const missing = READINESS_ITEMS.filter((i) => !(s.checklist && s.checklist[i.key])).map((i) => i.key);
      if (missing.length) why.push(`checklist ยังไม่ครบ: ${missing.join(', ')}`);
      if (why.length) throw new AppError('INVALID_STATE', 'not ready', { messageTh: `ยังไม่พร้อมสลับระบบ — ${why.join('; ')}`, details: { reasons: why } });
      const { cs } = yield* patchRun(ctx, r, { state: 'CUTOVER_READY' }, 'MARK_READY', { action: 'migration.ready' });
      return yield* commit(ctx, cs, { run_id: r.id, state: 'CUTOVER_READY' });
    },
  }),

  op({
    name: 'migration.cutover', mutation: true, maintenanceAllowed: true, permission: 'migration.cutover',
    description_th: 'สลับระบบ: ระบบนี้กลายเป็น archive อ่านอย่างเดียวถาวร (ห้าม dual-write) — routing ไประบบใหม่ทำตาม RUNBOOK',
    input: obj({ run_id: S.uuid, reason: S.str(500, 3), confirm: { type: 'string', const: 'CUTOVER' } }, ['run_id', 'reason', 'confirm']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.cutover');
      const r = yield* requireRun(ctx, input.run_id);
      assertTransition('Migration', r.state, 'CUTOVER');
      if (ctx.config.systemMode !== 'READ_ONLY') throw new AppError('INVALID_STATE', 'source not frozen', { messageTh: 'ระบบต้นทางต้องอยู่ในโหมดอ่านอย่างเดียวตั้งแต่ส่งออกจนสลับระบบ' });
      // the package must still describe this system: no business change since the high-water mark
      const hwm = r.high_water_marks_json ? r.high_water_marks_json.change_log_seq : 0;
      const now = yield* maxChangeSeq(ctx);
      if (now > hwm) {
        const later = [];
        for (const p of yield ctx.store.partitions('ChangeLog')) later.push(...(yield* listAll(ctx, 'ChangeLog', { partitions: [p], where: { seq: { gt: hwm } } })));
        const tables = new Set();
        // Migration Center operations only touch runs, jobs, audit and the cutover marker itself
        for (const e of later) if (!String(e.operation).startsWith('migration.')) for (const ch of Array.isArray(e.changes_json) ? e.changes_json : []) tables.add(ch.table);
        const business = [...tables].filter((t) => !LIVE_TABLES.includes(t));
        if (business.length) throw new AppError('INVALID_STATE', 'source changed since snapshot', { messageTh: `ข้อมูลต้นทางเปลี่ยนหลังส่งออก (${business.join(', ')}) — ต้องส่งออกภาพรวมสุดท้ายใหม่และกระทบยอดอีกครั้ง` });
      }
      const { cs } = yield* patchRun(ctx, r, { state: 'ACTIVE' }, 'CUTOVER', { action: 'migration.cutover', reason: input.reason });
      const existing = yield* cutoverSetting(ctx);
      const value = { run_id: r.id, at: ctx.now, by: ctx.principal.user_id, manifest_sha256: r.manifest_sha256 };
      if (existing) cs.update('Settings', existing, { value_json: value });
      else {
        const school = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
        cs.insert('Settings', { school_id: school.id, key: CUTOVER_SETTING, value_json: value, is_example: false, description_th: 'ระบบนี้ถูกสลับไประบบใหม่แล้ว — อ่านอย่างเดียวถาวรจนกว่าจะ rollback' });
      }
      const res = yield* commit(ctx, cs, { run_id: r.id, state: 'ACTIVE', note_th: 'ระบบนี้เป็น archive อ่านอย่างเดียว — เปลี่ยน routing ผู้ใช้ไประบบใหม่ตาม RUNBOOK' });
      if (ctx.platform.setSystemMode) yield ctx.platform.setSystemMode('READ_ONLY');
      return res;
    },
  }),

  op({
    name: 'migration.rollback', mutation: true, maintenanceAllowed: true, permission: 'migration.cutover',
    description_th: 'ย้อนกลับมาใช้ระบบนี้: กรณีไม่มีข้อมูลใหม่ หรือมีข้อมูลใหม่ที่นำ delta กลับมาแล้ว (ตรวจหลักฐาน) — ไม่ทิ้งข้อมูลใหม่',
    input: obj({ run_id: S.uuid, case: { type: 'string', enum: ['NO_NEW_DATA', 'NEW_DATA_RETURNED'] }, reason: S.str(500, 3), delta_location: S.strOrNull(300) }, ['run_id', 'case', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'migration.cutover');
      const r = yield* requireRun(ctx, input.run_id);
      assertTransition('Migration', r.state, 'ROLLBACK');
      let evidence = null;
      if (input.case === 'NEW_DATA_RETURNED') {
        if (!input.delta_location || !ctx.platform.packageStore) throw new AppError('VALIDATION_ERROR', 'delta required', { fieldErrors: [{ field: 'delta_location', code: 'REQUIRED', message_th: 'ระบุตำแหน่ง delta package ที่นำกลับมาแล้ว' }] });
        const h = yield ctx.platform.packageStore.open(input.delta_location);
        const t = yield h.readText('reports/delta-apply.json');
        const rep = t ? JSON.parse(t) : null;
        if (!rep || !rep.ok || rep.mode !== 'APPLY' || rep.base_export_id !== r.id) throw new AppError('INVALID_STATE', 'delta not applied', { messageTh: 'ไม่พบหลักฐานว่าได้นำ delta ของงานนี้กลับเข้าระบบเดิมครบแล้ว (reports/delta-apply.json)' });
        evidence = { delta_manifest_sha256: rep.manifest_sha256, rows: rep.rows_inserted + (rep.rows_updated || 0), applied_at: rep.finished_at };
      }
      const { cs } = yield* patchRun(ctx, r, { state: 'ROLLED_BACK', summary_json: { ...(r.summary_json || {}), rollback: { case: input.case, at: ctx.now, evidence } } }, 'ROLLBACK', { action: 'migration.rollback', reason: input.reason, after: { case: input.case, evidence } });
      const existing = yield* cutoverSetting(ctx);
      if (existing) cs.update('Settings', existing, { value_json: { cleared_at: ctx.now, previous_run_id: r.id } });
      return yield* commit(ctx, cs, { run_id: r.id, state: 'ROLLED_BACK', note_th: 'ตรวจข้อมูลแล้วเปิดใช้งานด้วย "ปิดโหมดอ่านอย่างเดียว" ที่หน้าสถานะระบบ' });
    },
  }),
];

/** True while this system is the read-only archive of an ACTIVE cutover. */
export function* cutoverActive(ctx) {
  const s = yield* cutoverSetting(ctx);
  return !!(s && s.value_json && s.value_json.run_id && !s.value_json.cleared_at);
}

export function* validateJob(ctx, job, { checkpoint, timeLeftMs }) {
  const run = yield ctx.store.get('MigrationRuns', job.payload_json.run_id);
  if (!run || run.state !== 'EXPORTED') return { done: true, result: { skipped: true } };
  const c = job.cursor_json || {};
  const h = yield ctx.platform.packageStore.open(run.package_location);
  const level = ctx.platform.packageVerifyLevel || 'FULL';
  const res = yield* processPackage(h, new IndexSink(), {
    sha256Hex: (d) => ctx.crypto.sha256Hex(d), level, deadlineAt: Date.now() + Math.max(0, timeLeftMs() - 45000),
    checkpoint: { *load() { return c.verify || null; }, *save(st) { c.verify = st; yield* checkpoint(c, { phase: 'VALIDATE' }); } },
  });
  if (!res.done) return { done: false };
  const ok = res.report.ok && res.manifest_sha256 === run.manifest_sha256;
  const usable = ok && res.manifest && res.manifest.completeness === 'COMPLETE' && res.manifest.mode === 'FULL_SNAPSHOT';
  yield h.writeText('reports/validation.json', JSON.stringify({ format: 'cwk-validation', level, validated_at: ctx.now, validated_by: 'migration.validate', manifest_sha256: res.manifest_sha256, export_id: run.id, ok, completeness: res.manifest ? res.manifest.completeness : 'FAILED', usable_for_cutover: usable, report: res.report.toJSON() }, null, 2) + '\n');
  assertTransition('Migration', run.state, 'VALIDATE');
  const cs = ctx.changeSet('migration.validate.done');
  cs.maintenanceAllowed = true;
  cs.update('MigrationRuns', run, { state: ok ? 'VALIDATED' : 'FAILED', summary_json: { ...(run.summary_json || {}), validation: { level, ok, error_count: res.report.error_count, first_errors: res.report.errors.slice(0, 10), at: ctx.now }, usable_for_cutover: usable } });
  yield* commitRaw(ctx, cs);
  return { done: true, result: { ok, level } };
}
validateJob.maintenanceAllowed = true;

export const MIGRATION_JOB_HANDLERS = { [EXPORT_JOB]: exportJob, [VALIDATE_JOB]: validateJob };

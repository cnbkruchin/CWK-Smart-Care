// Apps Script composition root (bundled to gas-dist/Code.js as the single global `CWK`).
// Reads Script Properties once per execution and wires adapters → application. Public top-level
// functions live in gas-dist/Entrypoints.js and only delegate here.

import { loadGasConfig, setSystemModeProperty } from '../adapters/gas/config.js';
import { gasClock, gasIds, gasCrypto, gasCache, gasRateLimiter, gasLogger, gasMetrics } from '../adapters/gas/ports.js';
import { SheetsStore } from '../adapters/gas/sheets-store.js';
import { DriveAttachmentStorage, parseXlsxViaDrive } from '../adapters/gas/drive-storage.js';
import { GatewayIdentityVerifier } from '../adapters/gas/identity-gateway.js';
import { assertEditorContext, provisionMaster, recordSchemaVersion, installTriggers, isProjectTrigger, selfTestCellEncoding, schemaCheck } from '../adapters/gas/setup.js';
import { DemoIdentityVerifier } from '../application/identity/demo.js';
import { buildRegistry, JOB_HANDLERS } from '../application/registry.js';
import { dispatch, API_VERSION } from '../application/dispatcher.js';
import { runSync } from '../application/runtime.js';
import { runDueJobs } from '../application/jobs.js';
import { bootstrapInstallation } from '../application/bootstrap.js';
import { seedDemoData } from '../application/demo-seed.js';
import { tasksForMode } from '../application/scheduler.js';
import { AppError, toErrorEnvelope } from '../shared/errors.js';
import { SCHEMA_VERSION } from '../schema/index.js';
import { gasPlatformExtras } from '../adapters/gas/extras.js';
import { GasReportRenderer, ensureReportTemplate } from '../adapters/gas/report-renderer.js';
import { GasBackup, restoreSnapshot } from '../adapters/gas/backup.js';
import { DrivePackageStore, DrivePackageHandle } from '../adapters/gas/drive-package.js';
import { importIntoStore, reconcileStore } from '../application/migration/import.js';
import { applyDelta } from '../application/migration/delta.js';

const G = () => globalThis;
let deps = null;

export function buildDeps() {
  if (deps) return deps;
  const config = loadGasConfig();
  const store = config.masterSpreadsheetId
    ? new SheetsStore({ masterId: config.masterSpreadsheetId, env: config.env, rootFolderId: config.driveRootFolderId, clock: gasClock, ids: gasIds, logger: gasLogger })
    : null;
  let identity;
  if (config.authMode === 'GATEWAY') {
    identity = lazy(() => new GatewayIdentityVerifier({ gatewayUrl: config.gatewayUrl, keyId: config.gatewayKeyId, secret: config.secret('CWK_GATEWAY_SECRET'), projectId: config.firebaseProjectId, tenantId: config.firebaseTenantId, crypto: gasCrypto, cache: gasCache, ids: gasIds, clock: gasClock }));
  } else {
    identity = lazy(() => new DemoIdentityVerifier({ env: config.env, passphrase: config.secret('CWK_DEMO_PASSPHRASE') }));
  }
  const storage = config.driveRootFolderId ? new DriveAttachmentStorage({ rootFolderId: config.driveRootFolderId }) : null;
  deps = {
    config, store: guardStore(store), mutations: guardStore(store), identity, clock: gasClock, ids: gasIds, crypto: gasCrypto, cache: gasCache,
    registry: buildRegistry(), rateLimiter: gasRateLimiter, metrics: gasMetrics(), logger: gasLogger,
    platform: {
      storage,
      parseXlsx: (bytes) => parseXlsxViaDrive(bytes, storage ? storage.folder('staging').getId() : null),
      setSystemMode: (mode) => { setSystemModeProperty(mode); config.systemMode = mode; return mode; },
      ensurePartitions: (code) => store.withLock(() => store.provisionPartition(code)),
      health: () => platformHealth(config, store),
      reportRenderer: config.driveRootFolderId ? new GasReportRenderer({ rootFolderId: config.driveRootFolderId, templateDocId: config.reportTemplateDocId }) : null,
      backup: store && config.driveRootFolderId ? new GasBackup({ store, rootFolderId: config.driveRootFolderId, crypto: gasCrypto, env: config.env }) : null,
      // portable migration: packages in private Drive folders; the export proves consistency against the
      // journal and the ChangeLog high-water mark read under the script lock
      packageStore: config.driveRootFolderId ? new DrivePackageStore({ rootFolderId: config.driveRootFolderId }) : null,
      packageVerifyLevel: 'INTEGRITY', // FULL validation (all IDs in memory) runs in tools/migrate.mjs and in imports
      platformName: 'GAS_SHEETS',
      journalStatus: () => store.journalStatus(),
      maxChangeSeq: () => store.withLock(() => store._nextSeq() - 1),
      ...gasPlatformExtras(() => deps),
    },
    rawStore: store,
  };
  return deps;
}

function lazy(factory) {
  let inst = null;
  const get = () => (inst = inst || factory());
  return {
    verifyCredential: (c) => get().verifyCredential(c),
    forget: (c) => (get().forget ? get().forget(c) : true),
    revokeSessions: (l) => (get().revokeSessions ? get().revokeSessions(l) : true),
  };
}

function guardStore(store) {
  if (store) return store;
  const fail = () => { throw new AppError('CONFIGURATION_REQUIRED', 'storage not installed', { messageTh: 'ยังไม่ได้ติดตั้งระบบ — ผู้ดูแลต้องรัน adminSetup จาก Apps Script Editor' }); };
  return { get: fail, getMany: fail, findBy: fail, list: fail, scan: fail, partitions: fail, commit: fail };
}

function platformHealth(config, store) {
  const g = G();
  const checks = [];
  const info = { schema_version: SCHEMA_VERSION, api_version: API_VERSION };
  try {
    const triggers = g.ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'cronTick');
    checks.push({ key: 'triggers.cronTick', status: triggers.length === 1 ? 'OK' : triggers.length ? 'WARN' : 'REQUIRED_SETUP', detail_th: `พบ trigger cronTick ${triggers.length} ตัว (ควรมี 1)` });
  } catch (e) { checks.push({ key: 'triggers.cronTick', status: 'WARN', detail_th: 'ตรวจ trigger ไม่ได้' }); }
  if (store) {
    try {
      const j = store.journalStatus();
      checks.push({ key: 'journal.pending', status: j.RECOVERY_REQUIRED ? 'FAIL' : j.PREPARED ? 'WARN' : 'OK', detail_th: `journal PREPARED ${j.PREPARED}, RECOVERY_REQUIRED ${j.RECOVERY_REQUIRED}` });
    } catch (e) { checks.push({ key: 'journal.pending', status: 'WARN', detail_th: 'อ่าน journal ไม่ได้' }); }
    try {
      const sizes = [];
      const books = new Map();
      for (const e of store.catalog().values()) {
        const sh = store._sheet(e.logical_table, e.partition_key);
        if (!sh) continue;
        const cells = Math.max(0, sh.getLastRow()) * sh.getLastColumn();
        books.set(e.workbook_id, (books.get(e.workbook_id) || 0) + cells);
        sizes.push({ table: e.logical_table, partition: e.partition_key, rows: Math.max(0, sh.getLastRow() - 1) });
      }
      const worst = Math.max(0, ...books.values());
      checks.push({ key: 'storage.cells', status: worst > 8000000 ? 'FAIL' : worst > 6000000 ? 'WARN' : 'OK', detail_th: `workbook ที่ใหญ่ที่สุดใช้ประมาณ ${worst.toLocaleString()} เซลล์ (ขีดจำกัด 10 ล้าน)` });
      info.table_rows = sizes;
    } catch (e) { checks.push({ key: 'storage.cells', status: 'WARN', detail_th: 'วัดขนาดไม่ได้' }); }
  }
  try { info.mail_quota_remaining = g.MailApp.getRemainingDailyQuota(); } catch (_) { /* scope may be absent in DEV */ }
  return { checks, info };
}

// ───────── public surface (called from Entrypoints.js) ─────────

export function rpc(envelopeJson) {
  let out;
  try {
    const d = buildDeps();
    out = runSync(dispatch, d, envelopeJson, { channel: 'APP' });
  } catch (e) {
    gasLogger.error({ event: 'rpc_fatal', message: String(e && e.message) });
    out = toErrorEnvelope(e, null);
  }
  return JSON.stringify(out);
}

export function doGet(e) {
  const g = G();
  const d = buildDeps();
  let publicConfig = null;
  try {
    const res = runSync(dispatch, d, JSON.stringify({ api_version: API_VERSION, request_id: d.ids.uuid(), operation: 'app.publicConfig', payload: {} }));
    publicConfig = res.ok ? res.data : { env: d.config.env, setup_required: true };
  } catch (_) { publicConfig = { env: d.config.env, setup_required: true }; }
  const page = e && e.parameter && typeof e.parameter.page === 'string' && /^[a-z-]{1,40}$/.test(e.parameter.page) ? e.parameter.page : null;
  const focus = e && e.parameter && /^[0-9a-f-]{36}$/.test(e.parameter.id || '') ? e.parameter.id : null;
  const linkToken = e && e.parameter && /^[A-Za-z0-9_-]{8,200}$/.test(e.parameter.linkToken || '') ? e.parameter.linkToken : null;
  const boot = JSON.stringify({ public_config: publicConfig, initial_route: page, focus_id: focus, line_link_token: linkToken, transport: 'GAS' }).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
  const html = g.HtmlService.createHtmlOutputFromFile('App').getContent().replace('/*__CWK_BOOT__*/null', boot);
  return g.HtmlService.createHtmlOutput(html)
    .setTitle('CWK Smart Care')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(g.HtmlService.XFrameOptionsMode.DEFAULT);
}

export function doPost(e) {
  const g = G();
  const d = buildDeps();
  let body;
  try {
    body = d.platform.handleWebhookEnvelope ? d.platform.handleWebhookEnvelope(e) : { ok: false, error: 'WEBHOOK_DISABLED' };
  } catch (err) {
    gasLogger.error({ event: 'webhook_error', message: String(err && err.message) });
    body = { ok: false, error: err && err.code ? err.code : 'INTERNAL_ERROR', stored: false };
  }
  return g.ContentService.createTextOutput(JSON.stringify(body)).setMimeType(g.ContentService.MimeType.JSON);
}

export function cronTick(e) {
  if (!isProjectTrigger(e)) return 'REFUSED: cronTick runs only from this project\'s installed trigger';
  const started = Date.now();
  const deadlineAt = started + 270000; // 4.5 min of the 6 min execution limit
  const d = buildDeps();
  const report = { tasks: {} };
  if (!d.rawStore) return 'NOT_INSTALLED';
  try { report.recovery = d.rawStore.withLock(() => d.rawStore.recoverPending()); } catch (err) { report.recovery = { error: err.code || String(err.message) }; }
  for (const task of tasksForMode(d.config.systemMode)) {
    if (Date.now() > deadlineAt - 30000) break;
    try {
      report.tasks[task.name] = runSync(task.run, d, { deadlineAt, now: d.clock.now() });
    } catch (err) {
      report.tasks[task.name] = { error: err && err.code ? err.code : String(err && err.message) };
      gasLogger.error({ event: 'tick_task_error', task: task.name, message: String(err && err.message) });
    }
  }
  try { report.tasks.jobs = runSync(runDueJobs, d, JOB_HANDLERS, { deadlineAt, owner: `tick-${started}` }); } catch (err) { report.tasks.jobs = { error: String(err && err.message) }; }
  report.ms = Date.now() - started;
  gasLogger.info({ event: 'tick', ...report });
  return JSON.stringify(report);
}

// ───────── editor-only admin ─────────
function adminDeps() {
  deps = null;
  return buildDeps();
}

export const admin = {
  setup(opts = {}) {
    const email = assertEditorContext();
    const props = G().PropertiesService.getScriptProperties();
    if (!props.getProperty('CWK_INSTALL_OWNER_EMAIL')) props.setProperty('CWK_INSTALL_OWNER_EMAIL', email);
    const env = props.getProperty('CWK_ENV') || 'DEV';
    const prov = provisionMaster({ env, ids: gasIds, clock: gasClock });
    prov.report_template = ensureReportTemplate(props.getProperty('CWK_DRIVE_ROOT_FOLDER_ID'), env);
    const d = adminDeps();
    recordSchemaVersion(d.rawStore, { ids: gasIds, clock: gasClock, appliedBy: email });
    const boot = runSync(bootstrapInstallation, d, {
      school_code: opts.school_code || 'CWK', school_name_th: opts.school_name_th || 'โรงเรียนจุนวิทยาคม', unit_th: 'กลุ่มบริหารงานกิจการนักเรียน',
      admin_display_name: opts.admin_display_name || 'ผู้ดูแลระบบคนแรก', admin_email: email, rule_effective_from: opts.rule_effective_from || '2026-01-01',
    });
    const out = { provisioned: prov, bootstrap: { created: boot.created }, next_steps_th: [] };
    if (boot.invitation_code) {
      // shown ONCE in this editor execution log; bound to the installer email; expires in 24 h
      out.bootstrap_invitation_code = boot.invitation_code;
      out.next_steps_th.push(`เปิดเว็บแอป สมัคร/เข้าสู่ระบบด้วยอีเมล ${email} ยืนยันอีเมล แล้วกรอกรหัสคำเชิญนี้ภายใน 24 ชั่วโมง`);
    }
    out.next_steps_th.push('รัน adminInstallTriggers() และ adminSelfTest() แล้วตั้งค่า deployment ตาม docs/INSTALL_GAS_TH.md');
    console.log(JSON.stringify(out, null, 2));
    return out;
  },
  seedDemo(opts = {}) {
    assertEditorContext();
    const d = adminDeps();
    if (d.config.env === 'PROD') throw new Error('DEMO data is refused in PROD');
    const res = runSync(seedDemoData, d, { start_year_ce: opts.start_year_ce || 2026, grades: opts.grades || ['M1', 'M2'], rooms_per_grade: opts.rooms_per_grade || 2, students_per_class: opts.students_per_class || 10, guardian_accounts: 5 });
    console.log(JSON.stringify({ ...res, note_th: 'ใช้รหัสผ่านทดสอบ CWK_DEMO_PASSPHRASE กับบัญชี DEMO (เฉพาะ DEV/STAGING)' }, null, 2));
    return res;
  },
  installTriggers() {
    assertEditorContext();
    const d = adminDeps();
    const res = installTriggers(d.config.tickMinutes);
    console.log(JSON.stringify(res));
    return res;
  },
  selfTest() {
    assertEditorContext();
    const d = adminDeps();
    const res = { cell_encoding: selfTestCellEncoding(d.config.driveRootFolderId), config: d.config.healthChecks() };
    console.log(JSON.stringify(res, null, 2));
    return res;
  },
  schemaCheck() {
    assertEditorContext();
    const d = adminDeps();
    const res = schemaCheck(d.rawStore);
    console.log(JSON.stringify(res, null, 2));
    return res;
  },
  /** Restore drill: run in a NEW project/environment with CWK_RESTORE_FROM_FOLDER_ID = backup folder id. */
  restoreSnapshot() {
    assertEditorContext();
    const props = G().PropertiesService.getScriptProperties();
    const folderId = props.getProperty('CWK_RESTORE_FROM_FOLDER_ID');
    if (!folderId) throw new Error('Set Script Property CWK_RESTORE_FROM_FOLDER_ID to the backup folder id first');
    const res = restoreSnapshot(folderId, { crypto: gasCrypto });
    props.deleteProperty('CWK_RESTORE_FROM_FOLDER_ID');
    deps = null;
    console.log(JSON.stringify(res, null, 2));
    return res;
  },
  /**
   * Import a portable package into a NEW environment (run in the NEW project with
   * CWK_IMPORT_PACKAGE_FOLDER_ID = package folder id). Resumable: run again until it reports done.
   * The new environment stays READ_ONLY with e-mail/LINE off until an administrator has checked it.
   */
  importPackage() {
    assertEditorContext();
    const props = G().PropertiesService.getScriptProperties();
    const folderId = props.getProperty('CWK_IMPORT_PACKAGE_FOLDER_ID');
    if (!folderId) throw new Error('Set Script Property CWK_IMPORT_PACKAGE_FOLDER_ID to the portable package folder id first');
    const inProgress = props.getProperty('CWK_IMPORT_IN_PROGRESS');
    if (props.getProperty('CWK_MASTER_SPREADSHEET_ID') && inProgress !== folderId) throw new Error('IMPORT_REFUSED: this environment already has data — import only into a NEW project/environment');
    props.setProperties({ CWK_SYSTEM_MODE: 'READ_ONLY', CWK_EMAIL_ENABLED: 'false', CWK_LINE_ENABLED: 'false' });
    if (!inProgress) {
      const env = props.getProperty('CWK_ENV') || 'DEV';
      provisionMaster({ env, ids: gasIds, clock: gasClock });
      ensureReportTemplate(props.getProperty('CWK_DRIVE_ROOT_FOLDER_ID'), env);
      props.setProperty('CWK_IMPORT_IN_PROGRESS', folderId);
      props.setProperty('CWK_IMPORT_ID', gasIds.uuid());
      recordSchemaVersion(adminDeps().rawStore, { ids: gasIds, clock: gasClock, appliedBy: 'import' });
    }
    const d = adminDeps();
    const importId = props.getProperty('CWK_IMPORT_ID');
    const handle = new DrivePackageHandle(folderId);
    const stateFile = `reports/import-state-${importId.slice(0, 8)}.json`;
    const checkpoint = { *load() { const t = handle.readText(stateFile); return t ? JSON.parse(t) : null; }, *save(st) { handle.writeText(stateFile, JSON.stringify(st)); } };
    const res = runSync(importIntoStore, d, handle, { importId, target: 'sheets', checkpoint, deadlineAt: Date.now() + 240000 });
    let out;
    if (!res.done) out = { done: false, progress: res.report.tables, next_th: 'ยังไม่เสร็จ — รัน adminImportPackage อีกครั้งเพื่อทำต่อจาก checkpoint' };
    else if (!res.report.ok) out = { done: true, ok: false, errors: res.report.errors.slice(0, 20), next_th: 'นำเข้าไม่สำเร็จ — ห้ามใช้ environment นี้ ลบทิ้งแล้วแก้ package ก่อนเริ่มใหม่ในโปรเจกต์ใหม่' };
    else {
      const rec = runSync(reconcileStore, d, handle, { target: 'sheets' });
      handle.remove(stateFile);
      ['CWK_IMPORT_IN_PROGRESS', 'CWK_IMPORT_PACKAGE_FOLDER_ID', 'CWK_IMPORT_ID'].forEach((k) => props.deleteProperty(k));
      out = {
        done: true, ok: true, rows_inserted: res.report.rows_inserted, attachments: res.report.attachments, reconciliation: { overall: rec.overall, ready_to_cutover: rec.ready_to_cutover, failed: rec.checks.filter((c) => c.status === 'FAIL').map((c) => c.key) },
        next_th: 'รายงาน import.json และ reconciliation.json อยู่ในโฟลเดอร์ reports/ ของ package — บันทึกเป็นหลักฐานที่ระบบต้นทาง (ศูนย์ย้ายข้อมูล) ระบบนี้ยังอ่านอย่างเดียวและปิดอีเมล/LINE จนกว่าผู้ดูแลจะตรวจเสร็จ',
      };
    }
    deps = null;
    console.log(JSON.stringify(out, null, 2));
    return out;
  },
  /**
   * Rollback path: apply a DELTA package (changes made on the new system after cutover) to THIS system.
   * CWK_DELTA_PACKAGE_FOLDER_ID = delta folder; CWK_DELTA_MODE = DRY_RUN (default) | APPLY. Resumable.
   */
  applyDelta() {
    assertEditorContext();
    const props = G().PropertiesService.getScriptProperties();
    const folderId = props.getProperty('CWK_DELTA_PACKAGE_FOLDER_ID');
    if (!folderId) throw new Error('Set Script Property CWK_DELTA_PACKAGE_FOLDER_ID to the delta package folder id first');
    const dryRun = (props.getProperty('CWK_DELTA_MODE') || 'DRY_RUN') !== 'APPLY';
    const d = adminDeps();
    if (!d.rawStore) throw new Error('this environment has no data to apply a delta to');
    const handle = new DrivePackageHandle(folderId);
    const stateFile = dryRun ? null : 'reports/delta-state.json';
    const checkpoint = stateFile ? { *load() { const t = handle.readText(stateFile); return t ? JSON.parse(t) : null; }, *save(st) { handle.writeText(stateFile, JSON.stringify(st)); } } : null;
    const res = runSync(applyDelta, d, handle, { dryRun, checkpoint, deadlineAt: Date.now() + 240000, importId: gasIds.uuid(), targetName: 'source-sheets' });
    const out = res.done
      ? { done: true, mode: dryRun ? 'DRY_RUN' : 'APPLY', ok: res.report.ok, inserted: res.report.rows_inserted, updated: res.report.rows_updated, identical: res.report.rows_identical, errors: res.report.errors.slice(0, 20) }
      : { done: false, next_th: 'ยังไม่เสร็จ — รัน adminApplyDelta อีกครั้ง' };
    if (res.done && stateFile) { handle.remove(stateFile); if (res.report.ok) props.deleteProperty('CWK_DELTA_PACKAGE_FOLDER_ID'); }
    deps = null;
    console.log(JSON.stringify(out, null, 2));
    return out;
  },
  recoverJournal() {
    assertEditorContext();
    const d = adminDeps();
    const res = d.rawStore.withLock(() => d.rawStore.recoverPending());
    console.log(JSON.stringify(res));
    return res;
  },
};

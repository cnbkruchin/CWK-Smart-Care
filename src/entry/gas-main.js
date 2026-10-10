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
import { TICK_TASKS } from '../application/scheduler.js';
import { AppError, toErrorEnvelope } from '../shared/errors.js';
import { SCHEMA_VERSION } from '../schema/index.js';
import { gasPlatformExtras } from '../adapters/gas/extras.js';

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
  for (const task of TICK_TASKS) {
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
  recoverJournal() {
    assertEditorContext();
    const d = adminDeps();
    const res = d.rawStore.withLock(() => d.rawStore.recoverPending());
    console.log(JSON.stringify(res));
    return res;
  },
};

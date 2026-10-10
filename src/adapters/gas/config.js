// Deployment configuration from Script Properties (read once per execution) + production gate.
// Secrets are only read through secret(); they are never logged, returned to clients or exported.

import { AppError } from '../../shared/errors.js';

const G = () => globalThis;
export const SECRET_KEYS = ['CWK_GATEWAY_SECRET', 'CWK_DEMO_PASSPHRASE', 'CWK_LINE_CHANNEL_ACCESS_TOKEN', 'CWK_LINE_WEBHOOK_SECRET'];

export function loadGasConfig() {
  const props = G().PropertiesService.getScriptProperties();
  const all = props.getProperties() || {};
  const get = (k, d = null) => (all[k] === undefined || all[k] === '' ? d : all[k]);
  const env = get('CWK_ENV', 'DEV');
  const cfg = {
    env,
    systemMode: get('CWK_SYSTEM_MODE', 'NORMAL'),
    serviceBackend: get('CWK_SERVICE_BACKEND', 'GAS'),
    dataAdapter: get('CWK_DATA_ADAPTER', 'SHEETS'),
    masterSpreadsheetId: get('CWK_MASTER_SPREADSHEET_ID'),
    driveRootFolderId: get('CWK_DRIVE_ROOT_FOLDER_ID'),
    reportTemplateDocId: get('CWK_REPORT_TEMPLATE_DOC_ID'),
    authMode: get('CWK_AUTH_MODE', 'DEMO'),
    authPersistence: get('CWK_AUTH_PERSISTENCE', 'SESSION'),
    firebasePublic: get('CWK_FIREBASE_PROJECT_ID') ? {
      apiKey: get('CWK_FIREBASE_WEB_API_KEY'), authDomain: get('CWK_FIREBASE_AUTH_DOMAIN'), projectId: get('CWK_FIREBASE_PROJECT_ID'), tenantId: get('CWK_FIREBASE_TENANT_ID'),
    } : null,
    firebaseProjectId: get('CWK_FIREBASE_PROJECT_ID'),
    firebaseTenantId: get('CWK_FIREBASE_TENANT_ID'),
    gatewayUrl: get('CWK_GATEWAY_URL'),
    gatewayKeyId: get('CWK_GATEWAY_KEY_ID'),
    lineEnabled: get('CWK_LINE_ENABLED', 'false') === 'true',
    lineWebhookKeyId: get('CWK_LINE_WEBHOOK_KEY_ID'),
    lineRetryWindowHours: Number(get('CWK_LINE_RETRY_WINDOW_HOURS', '12')),
    emailEnabled: get('CWK_EMAIL_ENABLED', 'true') === 'true',
    emailSenderName: get('CWK_EMAIL_SENDER_NAME', 'CWK Smart Care'),
    notifyAllowlist: (get('CWK_NOTIFY_ALLOWLIST', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    webappUrl: get('CWK_WEBAPP_URL'),
    restBaseUrl: get('CWK_REST_BASE_URL'),
    tickMinutes: Number(get('CWK_TICK_MINUTES', '1')),
    timezone: 'Asia/Bangkok',
    secret: (k) => {
      if (!SECRET_KEYS.includes(k)) throw new AppError('INTERNAL_ERROR', `not a secret key ${k}`);
      return get(k);
    },
    hasSecret: (k) => !!get(k),
  };
  cfg.assertSafe = () => assertProductionSafe(cfg);
  cfg.healthChecks = () => configHealth(cfg);
  return cfg;
}

/** Production gate (MASTER_PROMPT §5.2, §14): refuse to serve when PROD is misconfigured. */
export function assertProductionSafe(cfg) {
  if (!['DEV', 'STAGING', 'PROD'].includes(cfg.env)) throw new AppError('CONFIGURATION_REQUIRED', 'CWK_ENV invalid');
  if (cfg.env === 'PROD') {
    if (cfg.authMode !== 'GATEWAY') throw new AppError('CONFIGURATION_REQUIRED', 'PROD requires CWK_AUTH_MODE=GATEWAY');
    if (!cfg.gatewayUrl || !cfg.hasSecret('CWK_GATEWAY_SECRET') || !cfg.firebaseProjectId) throw new AppError('CONFIGURATION_REQUIRED', 'PROD identity gateway not configured');
    if (cfg.notifyAllowlist.length) throw new AppError('CONFIGURATION_REQUIRED', 'CWK_NOTIFY_ALLOWLIST must be empty in PROD');
  }
  if (cfg.authMode === 'DEMO' && !cfg.hasSecret('CWK_DEMO_PASSPHRASE')) throw new AppError('CONFIGURATION_REQUIRED', 'CWK_DEMO_PASSPHRASE missing');
}

export function configHealth(cfg) {
  const c = [];
  const add = (key, status, detail_th) => c.push({ key, status, detail_th });
  add('env', ['DEV', 'STAGING', 'PROD'].includes(cfg.env) ? 'OK' : 'FAIL', `environment = ${cfg.env}`);
  add('storage.master', cfg.masterSpreadsheetId ? 'OK' : 'REQUIRED_SETUP', cfg.masterSpreadsheetId ? 'ตั้งค่า master spreadsheet แล้ว' : 'ยังไม่ได้รัน adminSetup');
  add('storage.drive', cfg.driveRootFolderId ? 'OK' : 'REQUIRED_SETUP', cfg.driveRootFolderId ? 'ตั้งค่าโฟลเดอร์ Drive แล้ว' : 'ยังไม่มีโฟลเดอร์ Drive');
  if (cfg.authMode === 'GATEWAY') {
    add('auth.gateway', cfg.gatewayUrl && cfg.hasSecret('CWK_GATEWAY_SECRET') && cfg.firebaseProjectId ? 'OK' : 'REQUIRED_SETUP', 'Firebase + verification gateway');
  } else {
    add('auth.mode', cfg.env === 'PROD' ? 'FAIL' : 'WARN', 'โหมด DEMO — ใช้ได้เฉพาะสภาพแวดล้อมทดสอบ ต้องตั้ง identity provider ก่อนเปิดใช้งานจริง');
  }
  add('line', cfg.lineEnabled ? (cfg.hasSecret('CWK_LINE_CHANNEL_ACCESS_TOKEN') && cfg.hasSecret('CWK_LINE_WEBHOOK_SECRET') ? 'OK' : 'REQUIRED_SETUP') : 'WARN', cfg.lineEnabled ? 'LINE เปิดใช้งาน' : 'LINE ยังไม่เปิด (ต้องตั้งค่า) — ใช้ในแอปและอีเมลไปก่อน');
  add('notify.allowlist', cfg.env !== 'PROD' && !cfg.notifyAllowlist.length ? 'WARN' : 'OK', cfg.env === 'PROD' ? 'PROD ไม่ใช้ allowlist' : `DEV/STAGING ส่งได้เฉพาะ ${cfg.notifyAllowlist.length} ผู้รับทดสอบ`);
  add('webapp.url', cfg.webappUrl ? 'OK' : 'WARN', cfg.webappUrl ? 'ตั้งค่า URL /exec แล้ว' : 'ยังไม่ได้ตั้ง CWK_WEBAPP_URL (ลิงก์ในข้อความจะไม่สมบูรณ์)');
  add('mode', cfg.systemMode === 'NORMAL' ? 'OK' : 'WARN', `system mode = ${cfg.systemMode}`);
  return c;
}

export function setSystemModeProperty(mode) {
  G().PropertiesService.getScriptProperties().setProperty('CWK_SYSTEM_MODE', mode);
}

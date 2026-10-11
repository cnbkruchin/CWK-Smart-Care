// Reference REST backend configuration — environment variables only (see .env.example). Secrets never
// come from arguments or files in the repository. PROD refuses DEMO authentication and insecure origins.
export class ConfigError extends Error {}

const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));

export function loadConfig(env = process.env) {
  const c = {
    env: env.API_ENV || 'DEV',
    port: Number(env.API_PORT || 8080),
    host: env.API_HOST || '0.0.0.0',
    databaseUrl: env.DATABASE_URL || null,
    authMode: env.API_AUTH_MODE || 'FIREBASE',
    demoPassphrase: env.API_DEMO_PASSPHRASE || null,
    firebaseProjectId: env.FIREBASE_PROJECT_ID || null,
    firebaseTenantId: env.FIREBASE_TENANT_ID || null,
    // public web configuration for the browser sign-in (not secrets; restrict the key by HTTP referrer)
    firebaseWebApiKey: env.FIREBASE_WEB_API_KEY || null,
    firebaseAuthDomain: env.FIREBASE_AUTH_DOMAIN || null,
    allowedOrigins: (env.API_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    storageDir: env.STORAGE_DIR || './.local/storage',
    exportDir: env.EXPORT_DIR || './.local/exports',
    maxBodyBytes: Number(env.API_MAX_BODY_BYTES || 12 * 1024 * 1024),
    worker: bool(env.API_WORKER, true),
    workerIntervalSeconds: Number(env.API_WORKER_INTERVAL_SECONDS || 60),
    serveWeb: bool(env.API_SERVE_WEB, true),
    timezone: env.API_TIMEZONE || 'Asia/Bangkok',
    publicUrl: env.API_PUBLIC_URL || null,
    lineWebhookKeyId: env.API_LINE_WEBHOOK_KEY_ID || null,
    lineWebhookSecret: env.API_LINE_WEBHOOK_SECRET || null,
  };
  const problems = [];
  if (!['DEV', 'STAGING', 'PROD'].includes(c.env)) problems.push('API_ENV must be DEV, STAGING or PROD');
  if (!c.databaseUrl) problems.push('DATABASE_URL is required');
  if (!['FIREBASE', 'DEMO'].includes(c.authMode)) problems.push('API_AUTH_MODE must be FIREBASE or DEMO');
  if (c.authMode === 'DEMO' && c.env === 'PROD') problems.push('DEMO authentication is refused in PROD');
  if (c.authMode === 'DEMO' && (!c.demoPassphrase || c.demoPassphrase.length < 8)) problems.push('API_DEMO_PASSPHRASE (≥ 8 chars) is required for DEMO');
  if (c.authMode === 'FIREBASE' && !c.firebaseProjectId) problems.push('FIREBASE_PROJECT_ID is required');
  if (c.authMode === 'FIREBASE' && c.env === 'PROD' && !c.firebaseWebApiKey) problems.push('FIREBASE_WEB_API_KEY is required for browser sign-in');
  if (c.env === 'PROD' && c.allowedOrigins.some((o) => !o.startsWith('https://'))) problems.push('PROD origins must be https://');
  if (!Number.isInteger(c.port) || c.port < 0) problems.push('API_PORT invalid');
  if (problems.length) throw new ConfigError(problems.join('; '));
  return c;
}

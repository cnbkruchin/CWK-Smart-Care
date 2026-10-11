// Composition root of the reference REST backend: the SAME application layer (dispatcher, operations,
// jobs, migration) as Apps Script, wired to PostgreSQL, a private filesystem storage and the Node ports.
import { PgStore } from '../../../src/adapters/postgres/pg-store.js';
import { FsAttachmentStorage } from '../../../src/adapters/node/fs-storage.js';
import { FsPackageStore } from '../../../src/adapters/node/fs-package.js';
import { nodeIds, nodeCrypto, MemoryCache, MemoryRateLimiter, MetricsRecorder } from '../../../src/adapters/node/ports.js';
import { buildRegistry } from '../../../src/application/registry.js';
import { SCHEMA_VERSION } from '../../../src/schema/index.js';
import { API_VERSION } from '../../../src/application/dispatcher.js';
import { SYSTEM_USER_ID } from '../../../src/shared/uuid.js';
import { createIdentity } from './identity.mjs';

export const jsonLogger = {
  info: (o) => process.stdout.write(JSON.stringify({ level: 'info', ts: new Date().toISOString(), ...o }) + '\n'),
  error: (o) => process.stderr.write(JSON.stringify({ level: 'error', ts: new Date().toISOString(), ...o }) + '\n'),
};

export function buildDeps({ config, pool, identity = null, logger = jsonLogger, clock = null }) {
  const store = new PgStore({ pool, timezone: config.timezone });
  const c = clock || { now: () => new Date().toISOString() };
  const appConfig = {
    env: config.env, authMode: config.authMode, systemMode: 'NORMAL', timezone: config.timezone, authPersistence: 'SESSION',
    firebasePublic: config.authMode === 'FIREBASE' ? { apiKey: config.firebaseWebApiKey, authDomain: config.firebaseAuthDomain, projectId: config.firebaseProjectId, tenantId: config.firebaseTenantId } : null,
    // outbound e-mail/LINE providers are not part of the reference backend (MASTER_PROMPT §2.3 scope):
    // queued messages stay in the outbox until providers are configured — nothing is sent silently
    emailEnabled: false, lineEnabled: false, notifyAllowlist: [], lineRetryWindowHours: 12, webappUrl: config.publicUrl,
    lineWebhookKeyId: config.lineWebhookKeyId,
    secret: (k) => (k === 'CWK_LINE_WEBHOOK_SECRET' ? config.lineWebhookSecret : null),
    healthChecks: () => [
      { key: 'config.env', status: 'OK', detail_th: `environment ${config.env}` },
      { key: 'config.auth', status: config.authMode === 'DEMO' && config.env !== 'DEV' ? 'WARN' : 'OK', detail_th: `การยืนยันตัวตน ${config.authMode}` },
    ],
  };
  const deps = {
    store, mutations: store, clock: c, ids: nodeIds, crypto: nodeCrypto, cache: new MemoryCache(c), config: appConfig,
    identity: identity || createIdentity(config), registry: buildRegistry(), rateLimiter: new MemoryRateLimiter(c), metrics: new MetricsRecorder(c), logger,
    platform: {
      platformName: 'POSTGRES',
      storage: new FsAttachmentStorage(config.storageDir),
      packageStore: new FsPackageStore(config.exportDir),
      packageVerifyLevel: 'FULL',
      setSystemMode: async (mode) => { await store.setSystemMode(mode, SYSTEM_USER_ID); appConfig.systemMode = mode; return mode; },
      health: async () => {
        const ready = await store.ready();
        return {
          checks: [{ key: 'postgres.schema_version', status: ready.ok ? 'OK' : 'FAIL', detail_th: `schema_version ${ready.schema_version} (ต้องเป็น ${SCHEMA_VERSION})` }],
          info: { schema_version: ready.schema_version, api_version: API_VERSION, backend: 'REST/PostgreSQL' },
        };
      },
    },
  };
  return deps;
}

/** Refresh the system mode from the database (every channel sees the same READ_ONLY flag). */
export async function refreshMode(deps, cache = { at: 0 }) {
  if (Date.now() - cache.at < 2000) return deps.config.systemMode;
  deps.config.systemMode = await deps.store.systemMode();
  cache.at = Date.now();
  return deps.config.systemMode;
}

#!/usr/bin/env node
// Reference REST backend entry point (Node 22 + PostgreSQL). Configuration and secrets come from the
// environment only (.env.example lists the variables; use a secret manager in deployment).
//   API_ENV=DEV API_AUTH_MODE=DEMO API_DEMO_PASSPHRASE=… DATABASE_URL=… node future-platform/api/server.mjs
// Refuses to start when the database schema version does not match the code (run the SQL migrations first).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig, ConfigError } from './src/config.mjs';
import { buildDeps, jsonLogger } from './src/deps.mjs';
import { createApp, loadWebFiles } from './src/app.mjs';
import { startWorker } from './src/worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) { jsonLogger.error({ event: 'config_error', message: e.message }); process.exit(2); }
  throw e;
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: Number(process.env.API_DB_POOL_MAX || 10), application_name: 'cwk-api', idleTimeoutMillis: 30000 });
pool.on('error', (e) => jsonLogger.error({ event: 'pg_pool_error', code: e && e.code }));
const deps = buildDeps({ config, pool });

try {
  const ready = await deps.store.ready();
  if (!ready.ok) {
    jsonLogger.error({ event: 'schema_mismatch', schema_version: ready.schema_version, message: 'apply database/postgres/migrations before starting the API' });
    await pool.end();
    process.exit(3);
  }
  deps.config.systemMode = await deps.store.systemMode();
} catch (e) {
  jsonLogger.error({ event: 'database_unavailable', code: e && e.code, message: String(e && e.message).slice(0, 200) });
  await pool.end();
  process.exit(3);
}

const webFiles = config.serveWeb ? loadWebFiles(path.join(here, '..', 'web')) : new Map();
const handler = createApp({ config, deps, webFiles });
const server = http.createServer((req, res) => { handler(req, res); });
server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
const worker = config.worker ? startWorker(deps, { intervalSeconds: config.workerIntervalSeconds }) : null;

server.listen(config.port, config.host, () => {
  jsonLogger.info({ event: 'listening', port: server.address().port, env: config.env, auth: config.authMode, worker: !!worker, web: webFiles.size > 0, system_mode: deps.config.systemMode });
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  jsonLogger.info({ event: 'shutdown', signal });
  const force = setTimeout(() => process.exit(1), 30000);
  force.unref();
  await new Promise((r) => server.close(r));
  if (worker) await worker.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

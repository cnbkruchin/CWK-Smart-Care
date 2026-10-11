#!/usr/bin/env node
// Test helper (not shipped): runs the reference REST API in its own process with a FIXED school-day clock so
// synchronous clients (the Apps Script emulator's UrlFetchApp bridge, a browser) can call it. Synthetic data only.
//   TEST_API_DATABASE_URL, TEST_API_NOW (ISO), TEST_API_DIR, TEST_API_PASSPHRASE → prints {"port": n} on stdout.
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';
import { loadConfig } from '../../future-platform/api/src/config.mjs';
import { buildDeps } from '../../future-platform/api/src/deps.mjs';
import { createApp, loadWebFiles } from '../../future-platform/api/src/app.mjs';
import { FixedClock, silentLogger } from '../../src/adapters/node/ports.js';

const e = process.env;
const config = loadConfig({
  API_ENV: 'DEV', API_AUTH_MODE: 'DEMO', API_DEMO_PASSPHRASE: e.TEST_API_PASSPHRASE, DATABASE_URL: e.TEST_API_DATABASE_URL,
  STORAGE_DIR: path.join(e.TEST_API_DIR, 'storage'), EXPORT_DIR: path.join(e.TEST_API_DIR, 'exports'), API_WORKER: 'false', API_SERVE_WEB: 'true',
});
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
const deps = buildDeps({ config, pool, clock: new FixedClock(e.TEST_API_NOW), logger: silentLogger });
deps.config.systemMode = await deps.store.systemMode();
const server = http.createServer(createApp({ config, deps, webFiles: loadWebFiles(path.resolve(import.meta.dirname, '../../future-platform/web')) }));
server.listen(0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`));
process.on('SIGTERM', () => server.close(() => pool.end().then(() => process.exit(0))));

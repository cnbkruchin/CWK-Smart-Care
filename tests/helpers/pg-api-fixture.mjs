// Shared fixture for tests that need the reference REST API on a REAL PostgreSQL in a separate process:
// a fresh database (schema + roles), a LOGIN member of cwk_app, bootstrap + synthetic demo data (fixed clock),
// and the API started by tests/helpers/api-server.mjs. Synthetic data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildDeps } from '../../future-platform/api/src/deps.mjs';
import { FixedClock, silentLogger } from '../../src/adapters/node/ports.js';
import { runAsync } from '../../src/application/runtime.js';
import { bootstrapInstallation } from '../../src/application/bootstrap.js';
import { seedDemoData } from '../../src/application/demo-seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function urlFor(base, db, user = null) {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = ''; }
  return u.toString();
}

/** Fresh database with schema, roles, an app login and synthetic demo data. */
export async function seededDatabase(baseUrl, { now, passphrase }) {
  const tag = crypto.randomBytes(3).toString('hex');
  const db = `cwk_fx_${tag}`;
  const login = `cwk_fx_${tag}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
  const owner = urlFor(baseUrl, db);
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
  await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/roles.sql'), 'utf8'));
  await c.query(`CREATE ROLE ${login} LOGIN IN ROLE cwk_app`);
  await c.end();
  const app = urlFor(baseUrl, db, login);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-fx-'));
  const pool = new pg.Pool({ connectionString: app, max: 2 });
  const config = { env: 'DEV', authMode: 'DEMO', timezone: 'Asia/Bangkok', publicUrl: null, storageDir: path.join(dir, 'storage'), exportDir: path.join(dir, 'exports'), lineWebhookKeyId: null, lineWebhookSecret: null, demoPassphrase: passphrase };
  const deps = buildDeps({ config, pool, clock: new FixedClock(now), logger: silentLogger, identity: { verifyCredential: () => { throw new Error('not used'); } } });
  await runAsync(bootstrapInstallation, deps, { school_code: 'CWK', school_name_th: 'โรงเรียนจุนวิทยาคม (ทดสอบ)', admin_display_name: 'ผู้ติดตั้ง', admin_email: 'admin@example.com', rule_effective_from: '2026-01-01' });
  const seed = await runAsync(seedDemoData, deps, { start_year_ce: 2026, grades: ['M1'], rooms_per_grade: 2, students_per_class: 5, guardian_accounts: 3 });
  await pool.end();
  return {
    db, login, owner, app, dir, seed, ids: Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id])),
    async query(text, params = []) {
      const k = new pg.Client({ connectionString: owner });
      await k.connect();
      try { return (await k.query(text, params)).rows; } finally { await k.end(); }
    },
    async drop() {
      const a = new pg.Client({ connectionString: baseUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await a.query(`DROP ROLE IF EXISTS ${login}`);
      await a.end();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Start the API in a child process (fixed clock); resolves when it listens. */
export function startApiProcess({ appUrl, now, dir, passphrase }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests/helpers/api-server.mjs')], {
      env: { ...process.env, TEST_API_DATABASE_URL: appUrl, TEST_API_NOW: now, TEST_API_DIR: dir, TEST_API_PASSPHRASE: passphrase },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`API did not start: ${err}`)); }, 20000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{"port"'));
      if (line) {
        clearTimeout(timer);
        const { port } = JSON.parse(line);
        resolve({
          port, base: `http://127.0.0.1:${port}`,
          stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }),
        });
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); if (!out.includes('"port"')) reject(new Error(`API exited ${code}: ${err}`)); });
  });
}

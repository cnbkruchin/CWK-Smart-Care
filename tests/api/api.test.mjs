// Reference REST backend over a REAL PostgreSQL (MASTER_PROMPT §16, §18): HTTP contract, credential
// verification at the backend, scoped authorization, idempotency, optimistic concurrency, CORS, body
// limits, READ_ONLY enforced by the database, worker jobs (CSV report), webhook intake, and portable
// migration in both directions (PostgreSQL as export source; rollback delta from PostgreSQL to the
// previous system). The API connects as a LOGIN member of cwk_app (database/postgres/roles.sql) to prove
// least privilege. Needs DATABASE_URL (npm run test:pg); without it every test is SKIPPED, never passed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../../future-platform/api/src/config.mjs';
import { buildDeps } from '../../future-platform/api/src/deps.mjs';
import { createApp, loadWebFiles } from '../../future-platform/api/src/app.mjs';
import { runTick } from '../../future-platform/api/src/worker.mjs';
import { FixedClock, silentLogger } from '../../src/adapters/node/ports.js';
import { runAsync, runSync } from '../../src/application/runtime.js';
import { bootstrapInstallation } from '../../src/application/bootstrap.js';
import { seedDemoData } from '../../src/application/demo-seed.js';
import { importIntoStore, reconcileStore } from '../../src/application/migration/import.js';
import { applyDelta } from '../../src/application/migration/delta.js';
import { FsPackageStore } from '../../src/adapters/node/fs-package.js';
import { AppError } from '../../src/shared/errors.js';
import { buildEnvelope } from '../../gateway/src/app.mjs';
import { makeHarness } from '../helpers/app-harness.mjs';
import { generatePackage } from '../../tools/fixtures/generate-synthetic.mjs';
import { PDF_BYTES, BKK } from '../helpers/migration-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_URL = process.env.DATABASE_URL;
const skip = BASE_URL ? false : 'DATABASE_URL not set — run `npm run test:pg` (starts a local PostgreSQL)';
const PASS = 'api-test-passphrase';
const ORIGIN = 'https://ui.example.com';
const tag = crypto.randomBytes(3).toString('hex');
const LOGIN = `cwk_api_t_${tag}`;
const created = [];
let work;
let A; // API over database A (bootstrap + synthetic demo data)
let seed;
let ids;

function dbUrl(name, user = null) {
  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  if (user) { u.username = user; u.password = ''; }
  return u.toString();
}

async function createDb(name) {
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
  } finally { await admin.end(); }
  const c = new pg.Client({ connectionString: dbUrl(name) });
  await c.connect();
  try {
    await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
    await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/roles.sql'), 'utf8'));
    if (!(await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [LOGIN])).rows.length) await c.query(`CREATE ROLE ${LOGIN} LOGIN IN ROLE cwk_app`);
  } finally { await c.end(); }
  return { owner: dbUrl(name), app: dbUrl(name, LOGIN) };
}

async function startApi(appUrl, { now, storageDir, exportDir, env = {} }) {
  const config = loadConfig({
    API_ENV: 'DEV', API_AUTH_MODE: 'DEMO', API_DEMO_PASSPHRASE: PASS, DATABASE_URL: appUrl, API_ALLOWED_ORIGINS: ORIGIN,
    STORAGE_DIR: storageDir, EXPORT_DIR: exportDir, API_WORKER: 'false', API_SERVE_WEB: 'true', ...env,
  });
  const pool = new pg.Pool({ connectionString: appUrl, max: 6 });
  const clock = new FixedClock(now);
  const deps = buildDeps({ config, pool, clock, logger: silentLogger });
  const server = http.createServer(createApp({ config, deps, webFiles: loadWebFiles(path.join(ROOT, 'future-platform/web')) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, deps, pool, clock, config, server,
    async close() { await new Promise((r) => server.close(r)); await pool.end(); },
  };
}

const cred = (userId) => `demo:${userId}:${PASS}`;

async function op(api, userId, operation, payload = {}, { idem, ifMatch, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (userId) h.authorization = `Bearer ${cred(userId)}`;
  if (idem !== undefined) h['idempotency-key'] = idem;
  else if (api.deps.registry.get(operation) && api.deps.registry.get(operation).mutation) h['idempotency-key'] = crypto.randomUUID();
  if (ifMatch !== undefined) h['if-match'] = String(ifMatch);
  const r = await fetch(`${api.base}/v1/ops/${operation}`, { method: 'POST', headers: h, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.json(), headers: r.headers };
}

async function ok(api, userId, operation, payload, opts) {
  const r = await op(api, userId, operation, payload, opts);
  if (!r.body.ok) throw new Error(`${operation} → ${r.status} ${JSON.stringify(r.body.error)}`);
  return r.body.data;
}

async function q(url, text, params = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(text, params)).rows; } finally { await c.end(); }
}

async function drainJobs(api, max = 30) {
  for (let i = 0; i < max; i++) {
    const open = await q(api.urls.owner, "SELECT count(*)::int AS n FROM jobs WHERE status IN ('QUEUED','RUNNING')");
    if (!open[0].n) return;
    await runTick(api.deps, { budgetMs: 120000 });
  }
  throw new Error('jobs did not finish');
}

before(async () => {
  if (skip) return;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-apitest-'));
  const urls = await createDb(`cwk_api_${tag}_a`);
  // Monday 12 Oct 2026 07:30 (Asia/Bangkok) — inside demo term AY2026-T1
  A = await startApi(urls.app, { now: '2026-10-12T00:30:00.000Z', storageDir: path.join(work, 'a-storage'), exportDir: path.join(work, 'a-exports') });
  A.urls = urls;
  await runAsync(bootstrapInstallation, A.deps, { school_code: 'CWK', school_name_th: 'โรงเรียนจุนวิทยาคม (ทดสอบ)', admin_display_name: 'ผู้ติดตั้ง', admin_email: 'admin@example.com', rule_effective_from: '2026-01-01' });
  seed = await runAsync(seedDemoData, A.deps, { start_year_ce: 2026, grades: ['M1'], rooms_per_grade: 2, students_per_class: 5, guardian_accounts: 3 });
  ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
});

after(async () => {
  if (skip) return;
  if (A) await A.close();
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${LOGIN}`);
  await admin.end();
  fs.rmSync(work, { recursive: true, force: true });
});

test('health, readiness, routing and the published public configuration (no secrets)', { skip }, async () => {
  let r = await fetch(`${A.base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  r = await fetch(`${A.base}/readyz`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).schema_version, 1);
  assert.equal((await fetch(`${A.base}/v1/nothing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(`${A.base}/v1/rpc`, { method: 'PUT' })).status, 405);
  const unknown = await op(A, ids.admin, 'student.dropAll', {});
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'UNSUPPORTED_OPERATION');
  const pc = await op(A, null, 'app.publicConfig', {});
  assert.equal(pc.status, 200);
  assert.equal(pc.body.data.auth_mode, 'DEMO');
  assert.equal(pc.body.data.school.name_th, 'โรงเรียนจุนวิทยาคม (ทดสอบ)');
  const text = JSON.stringify(pc.body);
  assert.ok(!text.includes(PASS) && !text.includes('postgres://'), 'public config carries no secret');
  assert.equal(pc.headers.get('cache-control'), 'no-store');
  assert.equal(pc.headers.get('x-content-type-options'), 'nosniff');
  // web starter is served with a strict CSP; arbitrary paths never reach the filesystem
  r = await fetch(`${A.base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${A.base}/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${A.base}/../../package.json`)).status, 404);
});

test('the backend verifies the credential itself: missing, wrong, malformed or doubled credentials are refused', { skip }, async () => {
  let r = await op(A, null, 'student.search', { q: 'ทดสอบ' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'UNAUTHENTICATED');
  r = await op(A, null, 'student.search', { q: 'x' }, { headers: { authorization: `Bearer demo:${ids.admin}:wrong-passphrase` } });
  assert.equal(r.status, 401);
  r = await op(A, null, 'student.search', { q: 'x' }, { headers: { authorization: 'Basic abc' } });
  assert.equal(r.status, 401);
  const env = { api_version: 'v1', request_id: crypto.randomUUID(), operation: 'auth.getCurrentUser', payload: {}, credential: cred(ids.gate) };
  r = await fetch(`${A.base}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cred(ids.admin)}` }, body: JSON.stringify(env) });
  assert.equal(r.status, 400, 'credential in both header and envelope is ambiguous');
  // envelope credential alone (GAS-compatible) and header alone both work; the user comes from the credential only
  r = await fetch(`${A.base}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
  const me = await r.json();
  assert.equal(me.data.user.id, ids.gate);
  assert.equal(r.headers.get('x-request-id'), env.request_id);
  r = await fetch(`${A.base}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cred(ids.affairs)}` }, body: JSON.stringify({ ...env, credential: null, request_id: crypto.randomUUID(), payload: {} }) });
  assert.equal((await r.json()).data.user.id, ids.affairs);
  // the error body never echoes a credential
  r = await op(A, null, 'student.search', { q: 'x' }, { headers: { authorization: `Bearer demo:${ids.admin}:wrong-passphrase` } });
  assert.ok(!JSON.stringify(r.body).includes('wrong-passphrase'));
});

test('record arrival end to end: idempotent replay, mismatch refused, scoped reads, optimistic concurrency', { skip }, async () => {
  const station = (await q(A.urls.owner, 'SELECT id FROM stations ORDER BY code LIMIT 1'))[0];
  const cls = await q(A.urls.owner, "SELECT id FROM classes ORDER BY code");
  const roster = async (cid) => (await q(A.urls.owner, 'SELECT student_id FROM enrollments WHERE class_id = $1 ORDER BY student_id', [cid])).map((x) => x.student_id);
  const r1 = await roster(cls[0].id);
  const sid = r1[0];
  const key = crypto.randomUUID();
  const first = await op(A, ids.duty, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' }, { idem: key });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.is_late, false);
  const replay = await op(A, ids.duty, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' }, { idem: key });
  assert.equal(replay.body.meta.replayed, true);
  assert.deepEqual(replay.body.data, first.body.data);
  const mismatch = await op(A, ids.duty, 'attendance.recordArrival', { student_id: r1[1], station_id: station.id, source: 'SCAN_KEYBOARD' }, { idem: key });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'DUPLICATE_REQUEST_MISMATCH');
  assert.equal((await q(A.urls.owner, 'SELECT count(*)::int AS n FROM attendance_events WHERE student_id = $1', [sid]))[0].n, 1);
  // late arrival after the cutoff (server time, not client time)
  A.clock.set('2026-10-12T01:12:00.000Z');
  const late = await ok(A, ids.gate, 'attendance.recordArrival', { student_id: r1[2], station_id: station.id, source: 'SEARCH_CODE' });
  assert.equal(late.is_late, true);
  // scoped reads: homeroom of class 1 sees the full profile, gate staff the basic one, a guardian only their child
  assert.equal((await ok(A, ids.homeroom1, 'student.profile', { student_id: sid })).access, 'FULL');
  assert.equal((await ok(A, ids.gate, 'student.profile', { student_id: sid })).access, 'BASIC');
  const g = seed.guardian_users[0];
  const other = r1.concat(await roster(cls[1].id)).find((s) => s !== g.student_id);
  const denied = await op(A, g.user_id, 'student.profile', { student_id: other });
  assert.ok([403, 404].includes(denied.status));
  assert.ok(['FORBIDDEN', 'NOT_FOUND'].includes(denied.body.error.code));
  assert.equal((await ok(A, g.user_id, 'student.listMine', {})).items.map((s) => s.id).includes(other), false);
  // optimistic concurrency through If-Match
  const ver = (await q(A.urls.owner, 'SELECT version FROM students WHERE id = $1', [sid]))[0].version;
  const upd = await op(A, ids.affairs, 'student.update', { student_id: sid, nickname: 'หนึ่ง', reason: 'แก้ชื่อเล่น (ทดสอบ)' }, { ifMatch: ver });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const stale = await op(A, ids.affairs, 'student.update', { student_id: sid, nickname: 'สอง', reason: 'แก้ชื่อเล่น (ทดสอบ)' }, { ifMatch: ver });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'CONFLICT');
  assert.equal(stale.body.error.details.current_version, ver + 1);
  assert.equal((await op(A, ids.affairs, 'student.update', { student_id: sid, nickname: 'x', reason: 'yy' }, { ifMatch: 'abc' })).status, 400);
  // a subject teacher cannot record arrivals
  assert.equal((await op(A, ids.subject, 'attendance.recordArrival', { student_id: r1[3], station_id: station.id, source: 'SCAN_KEYBOARD' })).status, 403);
  // ChangeLog stays contiguous under the PostgreSQL adapter
  const seqs = (await q(A.urls.owner, 'SELECT seq FROM change_log ORDER BY seq')).map((x) => Number(x.seq));
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
});

test('CORS allowlist, content type, malformed JSON, invalid UTF-8 and body size limits', { skip }, async () => {
  let r = await fetch(`${A.base}/v1/rpc`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(r.headers.get('access-control-allow-headers'), /idempotency-key/);
  assert.equal(r.headers.get('access-control-allow-credentials'), null, 'bearer tokens only; no cookies');
  r = await fetch(`${A.base}/v1/rpc`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.net', 'access-control-request-method': 'POST' } });
  assert.equal(r.status, 403);
  r = await fetch(`${A.base}/v1/ops/app.publicConfig`, { method: 'POST', headers: { origin: 'https://evil.example.net', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  r = await fetch(`${A.base}/v1/ops/app.publicConfig`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  r = await fetch(`${A.base}/v1/ops/app.publicConfig`, { method: 'POST', headers: { origin: A.base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200, 'same-origin web starter');
  r = await fetch(`${A.base}/v1/ops/app.publicConfig`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  r = await fetch(`${A.base}/v1/ops/app.publicConfig`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":' });
  assert.equal(r.status, 400);
  r = await fetch(`${A.base}/v1/ops/app.publicConfig`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) });
  assert.equal(r.status, 400);
  const small = await startApi(A.urls.app, { now: A.clock.now(), storageDir: path.join(work, 'a-storage'), exportDir: path.join(work, 'a-exports'), env: { API_MAX_BODY_BYTES: '2048' } });
  try {
    r = await fetch(`${small.base}/v1/ops/app.publicConfig`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'ก'.repeat(5000) }) });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error.code, 'PAYLOAD_TOO_LARGE');
  } finally { await small.close(); }
});

test('READ_ONLY is enforced by the database for every API instance; reads continue; NORMAL restores writes', { skip }, async () => {
  const station = (await q(A.urls.owner, 'SELECT id FROM stations ORDER BY code LIMIT 1'))[0];
  const sid = (await q(A.urls.owner, 'SELECT id FROM students ORDER BY student_code OFFSET 6 LIMIT 1'))[0].id;
  assert.equal((await op(A, ids.affairs, 'system.setMode', { mode: 'READ_ONLY', reason: 'ทดสอบ' })).status, 403);
  await ok(A, ids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'ทดสอบโหมดอ่านอย่างเดียว' });
  const w = await op(A, ids.duty, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' });
  assert.equal(w.status, 503);
  assert.equal(w.body.error.code, 'MAINTENANCE_MODE');
  assert.ok(Number(w.headers.get('retry-after')) > 0);
  assert.equal((await op(A, ids.affairs, 'student.profile', { student_id: sid })).status, 200, 'reads still work');
  // a second API instance that still believes the mode is NORMAL cannot write either (enforced in the transaction)
  const other = await startApi(A.urls.app, { now: A.clock.now(), storageDir: path.join(work, 'a-storage'), exportDir: path.join(work, 'a-exports') });
  try {
    other.deps.config.systemMode = 'NORMAL';
    const cs = { writes: [], maintenance_allowed: false, idempotency: null, result: null, prepared_at: A.clock.now() };
    await assert.rejects(() => other.deps.store.commit(cs), (e) => e instanceof AppError && e.code === 'MAINTENANCE_MODE');
  } finally { await other.close(); }
  await ok(A, ids.admin, 'system.setMode', { mode: 'NORMAL', reason: 'จบการทดสอบ' });
  A.deps.config.systemMode = 'NORMAL';
  const again = await op(A, ids.duty, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test('worker: a CSV report job runs on PostgreSQL and is downloadable only by its owner; PDF needs a renderer', { skip }, async () => {
  const run = await ok(A, ids.homeroom1, 'report.run', { code: 'R06', filter: { from: '2026-10-12', to: '2026-10-12' }, format: 'CSV' });
  await drainJobs(A);
  const file = await ok(A, ids.homeroom1, 'report.download', { run_id: run.run_id });
  const csv = Buffer.from(file.content_base64, 'base64');
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  assert.match(csv.toString('utf8'), /[฀-๿]/, 'Thai headers preserved');
  assert.equal((await op(A, ids.homeroom2, 'report.download', { run_id: run.run_id })).body.error.code, 'NOT_FOUND');
  const pdf = await ok(A, ids.homeroom1, 'report.run', { code: 'R06', filter: { from: '2026-10-12', to: '2026-10-12' }, format: 'PDF' });
  await drainJobs(A);
  const st = (await q(A.urls.owner, 'SELECT status FROM report_runs WHERE id = $1', [pdf.run_id]))[0];
  assert.equal(st.status, 'FAILED', 'no PDF renderer in the reference backend — reported, not faked');
  // tick tasks run as the system principal under the worker lock
  const report = await runTick(A.deps, { budgetMs: 60000 });
  assert.ok(report.tasks && Object.keys(report.tasks).length > 1);
});

test('LINE webhook route: disabled without LINE; with the envelope key it stores once and refuses bad signatures', { skip }, async () => {
  const body = (nonce, secret = 'webhook-envelope-secret-for-tests') => JSON.stringify(buildEnvelope({
    keyId: 'line-test-1', secret, nonce, nowMs: Date.parse(A.clock.now()),
    payload: JSON.stringify({ type: 'follow', webhookEventId: nonce, timestamp: Date.parse(A.clock.now()), source: { type: 'user', userId: `U${'a'.repeat(32)}` }, mode: 'active' }),
  }));
  let r = await fetch(`${A.base}/v1/webhook/line`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('01HTESTNONCE0001') });
  assert.equal(r.status, 404);
  const cfg = A.deps.config;
  const saved = { lineEnabled: cfg.lineEnabled, lineWebhookKeyId: cfg.lineWebhookKeyId, secret: cfg.secret };
  Object.assign(cfg, { lineEnabled: true, lineWebhookKeyId: 'line-test-1', secret: (k) => (k === 'CWK_LINE_WEBHOOK_SECRET' ? 'webhook-envelope-secret-for-tests' : null) });
  try {
    r = await fetch(`${A.base}/v1/webhook/line`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('01HTESTNONCE0001') });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).stored, true);
    r = await fetch(`${A.base}/v1/webhook/line`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('01HTESTNONCE0001') });
    assert.equal((await r.json()).duplicate, true);
    r = await fetch(`${A.base}/v1/webhook/line`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('01HTESTNONCE0002', 'another-secret-not-configured') });
    assert.equal(r.status, 401);
    assert.equal((await q(A.urls.owner, "SELECT count(*)::int AS n FROM webhook_inbox WHERE source = 'LINE'"))[0].n, 1);
  } finally { Object.assign(cfg, saved); }
});

test('PostgreSQL as migration source: export job → FULL validation → import into a new store → reconciliation PASS', { skip }, async () => {
  const g = seed.guardian_users[0];
  await ok(A, g.user_id, 'leave.submit', {
    student_id: g.student_id, leave_type: 'SICK', reason: 'ไปพบแพทย์ (ข้อมูลสังเคราะห์)', days: [{ school_date: '2026-10-13', unit: 'FULL_DAY' }],
    attachments: [{ filename: 'ใบรับรองแพทย์.pdf', mime_type: 'application/pdf', content_base64: PDF_BYTES.toString('base64') }],
  });
  // TERM tables expose the same logical partitions as Sheets (term codes), computed from the data
  assert.deepEqual(await A.deps.store.partitions('AttendanceEvents'), ['AY2026-T1']);
  assert.equal(await A.deps.store.count('AttendanceEvents', 'AY2026-T1'), await A.deps.store.count('AttendanceEvents'));
  assert.equal(await A.deps.store.count('AttendanceEvents', 'AY2026-T2'), 0);
  assert.deepEqual(await A.deps.store.partitions('Students'), ['*']);
  await ok(A, ids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'freeze ก่อนส่งออก' });
  const st = await ok(A, ids.admin, 'migration.startExport', { mode: 'FULL_SNAPSHOT', include_attachments: true, reason: 'ซ้อมย้ายจาก PostgreSQL' });
  await drainJobs(A);
  let run = (await q(A.urls.owner, 'SELECT r.state, r.completeness, r.package_location, r.summary_json FROM migration_runs r WHERE r.id = $1', [st.run_id]))[0];
  assert.equal(run.state, 'EXPORTED', JSON.stringify(run.summary_json).slice(0, 1500));
  assert.equal(run.completeness, 'COMPLETE');
  await ok(A, ids.admin, 'migration.validate', { run_id: st.run_id });
  await drainJobs(A);
  run = (await q(A.urls.owner, 'SELECT state, package_location FROM migration_runs WHERE id = $1', [st.run_id]))[0];
  assert.equal(run.state, 'VALIDATED');
  const handle = new FsPackageStore(path.join(work, 'a-exports')).open(run.package_location);
  const t = makeHarness({ now: BKK('2026-10-12', '17:00') });
  const imp = runSync(importIntoStore, t.deps, handle, { importId: crypto.randomUUID(), target: 'memory' });
  assert.equal(imp.report.ok, true, JSON.stringify(imp.report.errors.slice(0, 3)));
  const rec = runSync(reconcileStore, t.deps, handle, {});
  assert.equal(rec.overall, 'PASS', JSON.stringify(rec.checks.filter((c) => c.status !== 'PASS').slice(0, 3)));
  assert.equal(rec.ready_to_cutover, true);
  await ok(A, ids.admin, 'system.setMode', { mode: 'NORMAL', reason: 'จบการซ้อม' });
});

test('rollback from the REST backend: Sheets-style source → package → PostgreSQL → new data via API → DELTA from PostgreSQL → back to the source', { skip }, async () => {
  const { dir, run, src } = generatePackage(path.join(work, 'b-packages'));
  const urls = await createDb(`cwk_api_${tag}_b`);
  const storage = path.join(work, 'b-storage');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/migrate.mjs'), 'import', '--input', dir, '--target', 'postgres', '--apply', '--attachments-dir', storage, '--quiet'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: urls.owner, MIGRATION_DATABASE_URL: '' } });
  assert.equal(r.status, 0, r.stderr);
  const importedSeq = Number((await q(urls.owner, 'SELECT max(seq) AS m FROM change_log'))[0].m);
  const B = await startApi(urls.app, { now: BKK('2026-06-16', '07:45'), storageDir: storage, exportDir: path.join(work, 'b-exports') });
  try {
    const { ids: sids, station, g } = src;
    const arrival = await ok(B, sids.duty, 'attendance.recordArrival', { student_id: src.late, station_id: station.id, source: 'SCAN_KEYBOARD' });
    const ver = (await q(urls.owner, 'SELECT version FROM students WHERE id = $1', [src.zeroStudentId]))[0].version;
    await ok(B, sids.affairs, 'student.update', { student_id: src.zeroStudentId, nickname: 'ฟ้าใส', reason: 'แก้ในระบบใหม่ (REST)' }, { ifMatch: ver });
    // imported attachment bytes are served by the REST backend from its private storage
    const leaveId = (await q(urls.owner, 'SELECT id FROM leave_requests WHERE student_id = $1 LIMIT 1', [g.student_id]))[0].id;
    const detail = await ok(B, g.user_id, 'leave.get', { leave_request_id: leaveId });
    const dl = await ok(B, g.user_id, 'attachment.download', { attachment_id: detail.attachments[0].id });
    assert.deepEqual(Buffer.from(dl.content_base64, 'base64'), PDF_BYTES);
    await ok(B, sids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'freeze ระบบใหม่ก่อนย้อนกลับ' });
    // the operator's command: admin.mjs export-delta (refused while the database is writable)
    const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'future-platform/api/admin.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: urls.app } });
    await q(urls.owner, "UPDATE settings SET value_json = '{\"value\":\"NORMAL\"}' WHERE key = 'system.mode'");
    assert.equal(cli('export-delta', '--base-package', dir, '--out', path.join(work, 'b-exports')).status, 2, 'refused unless READ_ONLY');
    await q(urls.owner, "UPDATE settings SET value_json = '{\"value\":\"READ_ONLY\"}' WHERE key = 'system.mode'");
    const ex = cli('export-delta', '--base-package', dir, '--out', path.join(work, 'b-exports'));
    assert.equal(ex.status, 0, ex.stderr);
    const d = JSON.parse(ex.stdout);
    assert.ok(d.rows > 0);
    assert.equal(d.from_seq, importedSeq);
    assert.equal(d.completeness, 'COMPLETE');
    const dh = new FsPackageStore(path.join(work, 'b-exports')).open(d.package);
    const applied = runSync(applyDelta, src.h.deps, dh, {});
    assert.equal(applied.report.ok, true, JSON.stringify(applied.report.errors.slice(0, 3)));
    assert.equal(src.h.store.get('Students', src.zeroStudentId).nickname, 'ฟ้าใส');
    assert.ok(src.h.store.get('AttendanceEvents', arrival.event_id), 'the arrival recorded on the REST backend is back on the source');
  } finally { await B.close(); }
});

test('admin CLI: init-db is idempotent, status reports the schema, set-mode writes the mode the API enforces', { skip }, async () => {
  const env = { ...process.env, DATABASE_OWNER_URL: A.urls.owner, DATABASE_URL: A.urls.app, APP_LOGIN_PASSWORD: '' };
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'future-platform/api/admin.mjs'), ...args], { encoding: 'utf8', env });
  let r = cli('init-db');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).schema_applied, false, 'existing schema untouched');
  r = cli('status');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).schema_version, 1);
  r = cli('status', '--x', A.urls.owner);
  assert.equal(r.status, 2, 'connection strings are refused as arguments');
  r = cli('set-mode', 'READ_ONLY');
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await q(A.urls.owner, "SELECT value_json FROM settings WHERE key = 'system.mode'"))[0].value_json.value, 'READ_ONLY');
  r = cli('set-mode', 'NORMAL');
  assert.equal(r.status, 0, r.stderr);
});

test('server.mjs process: refuses bad config (2) and a database without the schema (3); serves, ticks and stops cleanly; logs carry no secrets', { skip }, async () => {
  const { spawn } = await import('node:child_process');
  const server = path.join(ROOT, 'future-platform/api/server.mjs');
  const baseEnv = { PATH: process.env.PATH, API_ENV: 'DEV', API_AUTH_MODE: 'DEMO', API_DEMO_PASSPHRASE: PASS, API_PORT: '0', API_HOST: '127.0.0.1', STORAGE_DIR: path.join(work, 'p-storage'), EXPORT_DIR: path.join(work, 'p-exports') };
  let r = spawnSync(process.execPath, [server], { encoding: 'utf8', env: { ...baseEnv, API_ENV: 'PROD', DATABASE_URL: A.urls.app } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DEMO authentication is refused in PROD/);
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  const empty = `cwk_api_${tag}_empty`;
  await admin.query(`CREATE DATABASE ${empty}`);
  created.push(empty);
  await admin.end();
  r = spawnSync(process.execPath, [server], { encoding: 'utf8', env: { ...baseEnv, DATABASE_URL: dbUrl(empty) } });
  assert.equal(r.status, 3, r.stderr);
  const child = spawn(process.execPath, [server], { env: { ...baseEnv, DATABASE_URL: A.urls.app, API_WORKER: 'true', API_WORKER_INTERVAL_SECONDS: '5' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const waitFor = async (re, ms = 15000) => { const t0 = Date.now(); while (!re.test(out)) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}: ${out}`); await new Promise((x) => setTimeout(x, 100)); } };
  await waitFor(/"event":"listening"/);
  const port = JSON.parse(out.split('\n').find((l) => l.includes('"listening"'))).port;
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(ready.status, 200);
  await waitFor(/"event":"tick"/);
  const exited = new Promise((x) => child.once('exit', x));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.match(out, /"event":"shutdown"/);
  assert.ok(!out.includes(PASS) && !out.includes('postgres://'), 'no passphrase or connection string in logs');
});

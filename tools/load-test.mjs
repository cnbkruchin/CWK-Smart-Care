#!/usr/bin/env node
// Load test of the morning gate peak (MASTER_PROMPT §3, §18) with SYNTHETIC data only — no real people, no
// real messages. Scenario (assumptions, not measurements of the school):
//   • N students (default 1,500 = the §3 test assumption) arrive between 07:10 and 08:10 (cutoff 08:00 → ~1/6 late)
//   • S gate stations (default 5): each arrival = attendance.lookupForGate + attendance.recordArrival (like the UI)
//   • D dashboard users (default 10) polling dashboard.summary once a minute (the UI default)
//   • the background tick runs every simulated minute (openDay before the peak; outbox, jobs during it)
// Targets — results are labelled with where they came from; none of them is a measurement on Apps Script:
//   --target memory        in-process application layer + memory store (cost of the code itself)
//   --target rest          reference REST API over HTTP + PostgreSQL (needs DATABASE_URL of a server where a
//                          throw-away database may be created; S stations and D dashboards run CONCURRENTLY)
//   --target gas-emulator  built gas-dist bundle on the Apps Script emulator (sequential executions; the
//                          emulator has no Sheets/network latency and no quotas — a lower bound only)
// Options: --students N --stations S --dashboards D --mail-quota Q (MailApp recipients/day assumed; default 1500)
//          --json <file> (write the raw summary)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = '2026-06-15'; // Monday in demo term AY2026-T1 (example cutoff 08:00)
const BKK = (hhmm, date = DAY) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
const WINDOW_START = Date.parse(BKK('07:10'));
const WINDOW_MS = 60 * 60 * 1000;

function args(argv) {
  const o = { target: 'memory', students: 1500, stations: 5, dashboards: 10, 'mail-quota': 1500, json: null };
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  for (const k of ['students', 'stations', 'dashboards', 'mail-quota']) o[k] = Number(o[k]);
  if (!['memory', 'rest', 'gas-emulator'].includes(o.target) || !(o.students >= 30) || !(o.stations >= 1) || !(o.dashboards >= 0)) {
    process.stderr.write('usage: node tools/load-test.mjs --target memory|rest|gas-emulator [--students 1500] [--stations 5] [--dashboards 10]\n');
    process.exit(2);
  }
  return o;
}

class Stats {
  constructor() { this.ops = new Map(); this.extra = {}; }
  add(op, ms, ok, code = null) {
    if (!this.ops.has(op)) this.ops.set(op, { ms: [], errors: {} });
    const s = this.ops.get(op);
    s.ms.push(ms);
    if (!ok) s.errors[code || 'ERROR'] = (s.errors[code || 'ERROR'] || 0) + 1;
  }
  summary() {
    const out = {};
    for (const [op, s] of this.ops) {
      const v = [...s.ms].sort((a, b) => a - b);
      const q = (p) => (v.length ? v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)] : 0);
      const errors = Object.values(s.errors).reduce((a, b) => a + b, 0);
      out[op] = { count: v.length, p50_ms: round(q(0.5)), p95_ms: round(q(0.95)), max_ms: round(v[v.length - 1] || 0), errors, error_rate: v.length ? round((errors / v.length) * 100, 2) : 0, error_codes: s.errors };
    }
    return out;
  }
}
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const timeSync = (stats, op, fn) => {
  const t = performance.now();
  let res;
  try { res = fn(); } catch (e) { stats.add(op, performance.now() - t, false, e.code || 'THROWN'); return null; }
  stats.add(op, performance.now() - t, !!(res && res.ok), res && !res.ok ? res.error.code : null);
  return res;
};
const timeAsync = async (stats, op, fn) => {
  const t = performance.now();
  let res;
  try { res = await fn(); } catch (e) { stats.add(op, performance.now() - t, false, e.code || 'THROWN'); return null; }
  stats.add(op, performance.now() - t, !!(res && res.ok), res && !res.ok ? res.error.code : null);
  return res;
};

/** Deterministic shuffled arrival plan: student index → minute offset inside the window. */
function plan(n) {
  const order = [...Array(n).keys()];
  let x = 2569;
  for (let i = n - 1; i > 0; i--) { x = (x * 1103515245 + 12345) % 2147483648; const j = x % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  return order.map((idx, k) => ({ idx, at: new Date(WINDOW_START + Math.floor((k / n) * WINDOW_MS)).toISOString() }));
}
const seedParams = (n) => ({ start_year_ce: 2026, grades: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'], rooms_per_grade: 5, students_per_class: Math.ceil(n / 30), guardian_accounts: Math.round(n * 0.2) });
const envelope = (operation, payload, credential, mutation) => ({ api_version: 'v1', request_id: crypto.randomUUID(), operation, payload, credential, idempotency_key: mutation ? crypto.randomUUID() : null, expected_version: null });

// ───────── memory ─────────
async function runMemory(o) {
  const { makeHarness, FakeEmailProvider } = await import('../tests/helpers/app-harness.mjs');
  const { runSync } = await import('../src/application/runtime.js');
  const { dispatch } = await import('../src/application/dispatcher.js');
  const email = new FakeEmailProvider();
  email.quota = o['mail-quota'];
  const h = makeHarness({ now: BKK('05:50'), extraPlatform: { providers: { EMAIL: email } } });
  h.bootstrap();
  const seed = h.seed(seedParams(o.students));
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  // DEV sends only to allowlisted addresses: allowlist the synthetic guardian accounts (example.com) so the
  // outbox does real work against the fake provider (nothing leaves the process)
  h.config.notifyAllowlist = h.store.list('Users', { where: { user_type: 'GUARDIAN' }, all: true }).items.map((u) => u.contact_email).filter(Boolean);
  const students = h.store.list('Students', { orderBy: [['student_code', 'asc']], all: true }).items.slice(0, o.students);
  const stations = h.store.list('Stations', { all: true }).items;
  const stats = new Stats();
  const call = (user, op, payload, mutation) => runSync(dispatch, h.deps, JSON.stringify(envelope(op, payload, h.cred(user), mutation)));
  // before the peak: 06:00 tick opens the day (dense UNKNOWN rows)
  h.clock.set(BKK('06:00'));
  let t = performance.now();
  for (let i = 0; i < 20; i++) { h.tick(); const r = h.runJobs(); if (!r.claimed) break; }
  stats.extra.open_day_ms = round(performance.now() - t);
  const devices = [...Array(o.stations).keys()].map((k) => ({ user: k % 2 ? ids.duty : ids.gate, station: stations[k % stations.length].id }));
  const dashUsers = [ids.exec, ids.affairs, ids.homeroom1, ids.homeroom2]; // SYSTEM_ADMIN has no student data (FORBIDDEN by design)
  const dashEvery = o.dashboards ? Math.max(1, Math.floor(o.students / (o.dashboards * 60))) : Infinity;
  let minute = null;
  let ticks = 0;
  t = performance.now();
  plan(students.length).forEach((p, k) => {
    h.clock.set(p.at);
    const m = p.at.slice(0, 16);
    if (m !== minute) { minute = m; const tt = performance.now(); h.tick(); h.runJobs(); stats.add('tick (every minute)', performance.now() - tt, true); ticks++; }
    const d = devices[k % devices.length];
    const s = students[p.idx];
    const look = timeSync(stats, 'attendance.lookupForGate', () => call(d.user, 'attendance.lookupForGate', { code: s.student_code }, false));
    if (look && look.ok) timeSync(stats, 'attendance.recordArrival', () => call(d.user, 'attendance.recordArrival', { student_id: s.id, station_id: d.station, source: 'SCAN_KEYBOARD' }, true));
    if (k % dashEvery === 0) timeSync(stats, 'dashboard.summary', () => call(dashUsers[k % dashUsers.length], 'dashboard.summary', {}, false));
  });
  stats.extra.peak_wall_ms = round(performance.now() - t);
  // queue latency: drain the outbox one simulated minute (one GAS tick) at a time
  const pending = () => h.store.list('NotificationOutbox', { where: { delivery_state: { in: ['QUEUED', 'RETRY_WAIT'] } }, all: true }).items.length;
  stats.extra.outbox_pending_after_peak = pending();
  let drainTicks = 0;
  while (pending() && drainTicks < 240) { h.clock.advance(60000); h.tick(['outbox.dispatch']); drainTicks++; }
  const rows = h.store.list('NotificationOutbox', { all: true }).items;
  const lat = rows.filter((r) => r.accepted_at).map((r) => (Date.parse(r.accepted_at) - Date.parse(r.created_at)) / 60000).sort((a, b) => a - b);
  stats.extra.outbox_rows = rows.length;
  stats.extra.outbox_states = rows.reduce((m, r) => ({ ...m, [r.delivery_state]: (m[r.delivery_state] || 0) + 1 }), {});
  stats.extra.queue_latency_minutes_simulated = { accepted: lat.length, p50: lat[Math.floor(lat.length * 0.5)] ?? null, p95: lat[Math.floor(lat.length * 0.95)] ?? null, max: lat[lat.length - 1] ?? null, note: 'created → provider accepted, in simulated minutes with one tick per minute (GAS cronTick cadence)' };
  stats.extra.outbox_drain_ticks_after_peak = drainTicks;
  stats.extra.emails_sent = email.sent.length;
  stats.extra.mail_quota_assumed = o['mail-quota'];
  stats.extra.late_arrivals = h.store.list('DailyAttendance', { where: { school_date: DAY, is_late: true }, all: true }).items.length;
  stats.extra.attendance_events = h.store.count('AttendanceEvents');
  stats.extra.ticks_during_peak = ticks;
  return { stats, label: 'in-process memory store (application cost only — no storage, network or lock latency)' };
}

// ───────── REST + PostgreSQL ─────────
async function runRest(o) {
  if (!process.env.DATABASE_URL) { process.stderr.write('DATABASE_URL is required for --target rest (a throw-away database is created and dropped)\n'); process.exit(2); }
  const pg = (await import('pg')).default;
  const { loadConfig } = await import('../future-platform/api/src/config.mjs');
  const { buildDeps } = await import('../future-platform/api/src/deps.mjs');
  const { createApp } = await import('../future-platform/api/src/app.mjs');
  const { runTick } = await import('../future-platform/api/src/worker.mjs');
  const { FixedClock, silentLogger } = await import('../src/adapters/node/ports.js');
  const { runAsync } = await import('../src/application/runtime.js');
  const { bootstrapInstallation } = await import('../src/application/bootstrap.js');
  const { seedDemoData } = await import('../src/application/demo-seed.js');
  const base = process.env.DATABASE_URL;
  const tag = crypto.randomBytes(3).toString('hex');
  const db = `cwk_load_${tag}`;
  const login = `cwk_load_${tag}`;
  const url = (user = null) => { const u = new URL(base); u.pathname = `/${db}`; if (user) { u.username = user; u.password = ''; } return u.toString(); };
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const owner = new pg.Client({ connectionString: url() });
  await owner.connect();
  await owner.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
  await owner.query(fs.readFileSync(path.join(ROOT, 'database/postgres/roles.sql'), 'utf8'));
  await owner.query(`CREATE ROLE ${login} LOGIN IN ROLE cwk_app`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-load-'));
  const pass = crypto.randomBytes(12).toString('hex');
  const config = loadConfig({ API_ENV: 'DEV', API_AUTH_MODE: 'DEMO', API_DEMO_PASSPHRASE: pass, DATABASE_URL: url(login), STORAGE_DIR: path.join(dir, 's'), EXPORT_DIR: path.join(dir, 'e'), API_WORKER: 'false', API_SERVE_WEB: 'false' });
  const pool = new pg.Pool({ connectionString: url(login), max: 20 });
  pool.on('error', () => {}); // idle clients are terminated when the throw-away database is dropped
  const clock = new FixedClock(BKK('05:50'));
  const deps = buildDeps({ config, pool, clock, logger: silentLogger });
  const lockWaits = [];
  deps.store.onLockWait = (ms) => lockWaits.push(ms);
  const stats = new Stats();
  const server = http.createServer(createApp({ config, deps }));
  try {
    let t = performance.now();
    await runAsync(bootstrapInstallation, deps, { school_code: 'CWK', school_name_th: 'โรงเรียนทดสอบโหลด', admin_display_name: 'ผู้ดูแล', admin_email: 'admin@example.com', rule_effective_from: '2026-01-01' });
    const seed = await runAsync(seedDemoData, deps, seedParams(o.students));
    stats.extra.seed_ms = round(performance.now() - t);
    const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
    const students = (await owner.query('SELECT id, student_code FROM students ORDER BY student_code LIMIT $1', [o.students])).rows;
    const stations = (await owner.query('SELECT id FROM stations ORDER BY code')).rows;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}`;
    const post = (user, op, payload, mutation) => fetch(`${api}/v1/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer demo:${user}:${pass}` }, body: JSON.stringify(envelope(op, payload, null, mutation)) }).then((r) => r.json());
    clock.set(BKK('06:00'));
    t = performance.now();
    for (let i = 0; i < 20; i++) { const rep = await runTick(deps, { budgetMs: 120000 }); if (!rep.tasks || !rep.tasks.jobs || !rep.tasks.jobs.claimed) break; }
    stats.extra.open_day_ms = round(performance.now() - t);
    const arrivals = plan(students.length);
    let next = 0;
    let done = 0;
    let lastMinute = null;
    let tickRunning = null;
    const advance = () => {
      const p = arrivals[Math.min(done, arrivals.length - 1)];
      clock.set(p.at);
      const m = p.at.slice(0, 16);
      if (m !== lastMinute && !tickRunning) {
        lastMinute = m;
        const tt = performance.now();
        tickRunning = runTick(deps, { budgetMs: 50000 }).then(() => stats.add('tick (every minute)', performance.now() - tt, true)).catch(() => stats.add('tick (every minute)', performance.now() - tt, false, 'TICK_ERROR')).finally(() => { tickRunning = null; });
      }
    };
    const station = async (k) => {
      const user = k % 2 ? ids.duty : ids.gate;
      const st = stations[k % stations.length].id;
      for (;;) {
        const i = next++;
        if (i >= arrivals.length) return;
        const s = students[arrivals[i].idx];
        const look = await timeAsync(stats, 'attendance.lookupForGate', () => post(user, 'attendance.lookupForGate', { code: s.student_code }, false));
        if (look && look.ok) await timeAsync(stats, 'attendance.recordArrival', () => post(user, 'attendance.recordArrival', { student_id: s.id, station_id: st, source: 'SCAN_KEYBOARD' }, true));
        done++;
        advance();
      }
    };
    const dashUsers = [ids.exec, ids.affairs, ids.homeroom1, ids.homeroom2]; // SYSTEM_ADMIN has no student data (FORBIDDEN by design)
    let running = true;
    const dashboard = async (k) => {
      // one poll per simulated minute per user (wall time compressed: the peak runs as fast as the stations can)
      let seen = null;
      while (running) {
        const m = clock.now().slice(0, 16);
        if (m !== seen) { seen = m; await timeAsync(stats, 'dashboard.summary', () => post(dashUsers[k % dashUsers.length], 'dashboard.summary', {}, false)); }
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    t = performance.now();
    const dashes = [...Array(o.dashboards).keys()].map(dashboard);
    await Promise.all([...Array(o.stations).keys()].map(station));
    running = false;
    await Promise.all(dashes);
    if (tickRunning) await tickRunning;
    stats.extra.peak_wall_ms = round(performance.now() - t);
    stats.extra.arrivals_per_minute_wall = round(students.length / (stats.extra.peak_wall_ms / 60000));
    const lw = [...lockWaits].sort((a, b) => a - b);
    stats.extra.changelog_lock_wait_ms = { count: lw.length, p50: lw[Math.floor(lw.length * 0.5)] || 0, p95: lw[Math.floor(lw.length * 0.95)] || 0, max: lw[lw.length - 1] || 0 };
    const c = (q) => owner.query(q).then((r) => r.rows[0].n);
    stats.extra.attendance_events = await c('SELECT count(*)::int AS n FROM attendance_events');
    stats.extra.duplicate_events = await c('SELECT count(*)::int AS n FROM (SELECT student_id FROM attendance_events GROUP BY student_id, school_date HAVING count(*) > 1) x');
    stats.extra.late_arrivals = await c(`SELECT count(*)::int AS n FROM daily_attendance WHERE school_date = '${DAY}' AND is_late`);
    stats.extra.outbox_rows = await c('SELECT count(*)::int AS n FROM notification_outbox');
    stats.extra.change_log_rows = await c('SELECT count(*)::int AS n FROM change_log');
    stats.extra.pool_max_connections = 20;
    return { stats, label: 'reference REST API (node:http, same process as the load driver) + PostgreSQL 16 on the development container — not Apps Script' };
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await owner.end();
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${login}`);
    await admin.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ───────── Apps Script emulator ─────────
async function runGasEmulator(o) {
  const { GasSim } = await import('../tests/gas-sim/gas-sim.mjs');
  const DIST = path.join(ROOT, 'gas-dist');
  if (!fs.existsSync(path.join(DIST, 'Code.js'))) { process.stderr.write('gas-dist missing — run npm run build\n'); process.exit(2); }
  const pass = crypto.randomBytes(12).toString('hex');
  const sim = new GasSim({ now: BKK('05:50'), properties: { CWK_ENV: 'DEV', CWK_AUTH_MODE: 'DEMO', CWK_DEMO_PASSPHRASE: pass, CWK_ADMIN_TASKS_ENABLED_UNTIL: new Date(Date.parse(BKK('05:50')) + 3600 * 1000).toISOString() } });
  sim.load(DIST);
  const stats = new Stats();
  let t = performance.now();
  sim.ctx.adminSetup();
  const seed = sim.ctx.CWK.admin.seedDemo(seedParams(o.students));
  sim.ctx.adminInstallTriggers();
  stats.extra.seed_ms = round(performance.now() - t);
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  const cred = (u) => `demo:${u}:${pass}`;
  const call = (u, op, payload, mutation) => sim.rpc(envelope(op, payload, cred(u), mutation));
  const tick = () => JSON.parse(sim.ctx.cronTick({ triggerUid: sim.triggers[0].getUniqueId() }));
  const list = (op, payload) => call(ids.affairs, op, payload, false);
  const students = [];
  for (let cursor = null; ;) {
    const page = list('student.search', { q: null, cursor, limit: 100 });
    students.push(...page.data.items);
    cursor = page.data.next_cursor;
    if (!cursor || students.length >= o.students) break;
  }
  const stations = call(ids.gate, 'station.list', {}, false).data.items;
  sim.setNow(BKK('06:00'));
  t = performance.now();
  for (let i = 0; i < 20; i++) { const r = tick(); if (!r.tasks.jobs || !r.tasks.jobs.claimed) break; }
  stats.extra.open_day_ms = round(performance.now() - t);
  const dashUsers = [ids.exec, ids.affairs, ids.homeroom1, ids.homeroom2]; // SYSTEM_ADMIN has no student data (FORBIDDEN by design)
  const dashEvery = o.dashboards ? Math.max(1, Math.floor(o.students / (o.dashboards * 60))) : Infinity;
  let minute = null;
  t = performance.now();
  plan(Math.min(students.length, o.students)).forEach((p, k) => {
    sim.setNow(p.at);
    const m = p.at.slice(0, 16);
    if (m !== minute) { minute = m; const tt = performance.now(); tick(); stats.add('cronTick (every minute)', performance.now() - tt, true); }
    const user = k % 2 ? ids.duty : ids.gate;
    const s = students[p.idx];
    const look = timeSync(stats, 'attendance.lookupForGate', () => call(user, 'attendance.lookupForGate', { code: s.student_code }, false));
    if (look && look.ok) timeSync(stats, 'attendance.recordArrival', () => call(user, 'attendance.recordArrival', { student_id: s.id, station_id: stations[k % stations.length].id, source: 'SCAN_KEYBOARD' }, true));
    if (k % dashEvery === 0) timeSync(stats, 'dashboard.summary', () => call(dashUsers[k % dashUsers.length], 'dashboard.summary', {}, false));
  });
  stats.extra.peak_wall_ms = round(performance.now() - t);
  stats.extra.executions = [...stats.ops.values()].reduce((a, s) => a + s.ms.length, 0);
  return { stats, label: 'gas-dist on the Apps Script EMULATOR (sequential; no real Sheets/Drive latency, no quotas, no concurrent executions) — lower bound only' };
}

const o = args(process.argv.slice(2));
const started = new Date().toISOString();
const res = o.target === 'memory' ? await runMemory(o) : o.target === 'rest' ? await runRest(o) : await runGasEmulator(o);
const out = { target: o.target, label: res.label, started_at: started, node: process.version, cpus: os.cpus().length, assumptions: { students: o.students, stations: o.stations, dashboards: o.dashboards, window: '07:10–08:10 Asia/Bangkok, cutoff 08:00 (example rule)', mail_quota_per_day: o['mail-quota'] }, operations: res.stats.summary(), extra: res.stats.extra };
process.stdout.write(`\n# ${o.target}: ${res.label}\n\n| operation | count | p50 ms | p95 ms | max ms | errors | error % |\n|---|---|---|---|---|---|---|\n`);
for (const [op, s] of Object.entries(out.operations)) process.stdout.write(`| ${op} | ${s.count} | ${s.p50_ms} | ${s.p95_ms} | ${s.max_ms} | ${s.errors}${s.errors ? ` ${JSON.stringify(s.error_codes)}` : ''} | ${s.error_rate} |\n`);
process.stdout.write(`\n${JSON.stringify(out.extra, null, 2)}\n`);
if (o.json) fs.writeFileSync(o.json, JSON.stringify(out, null, 2));

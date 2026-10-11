// Upgrade path step 2 (MASTER_PROMPT §2.3, §16): the BUILT Apps Script bundle (gas-dist) in REST mode on the
// emulator forwards google.script.run.rpc envelopes to the reference REST backend running on a real PostgreSQL
// (separate process, fixed school-day clock). Proves: the user's credential is forwarded and verified by the
// backend (nothing from GAS is trusted as identity), core phase-1 operations work through the transport
// (queries, scoped reads, record arrival, idempotent replay, optimistic concurrency, error codes), Apps Script
// keeps no data of its own in this mode, and an unreachable backend is reported as retryable.
// Needs DATABASE_URL (npm run test:pg) and gas-dist (npm run build); otherwise SKIPPED — never passed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GasSim } from '../gas-sim/gas-sim.mjs';
import { seededDatabase, startApiProcess } from '../helpers/pg-api-fixture.mjs';
import { syncFetch } from '../helpers/sync-fetch.mjs';

const DIST = path.resolve(import.meta.dirname, '../../gas-dist');
const BASE_URL = process.env.DATABASE_URL;
const skip = !BASE_URL ? 'DATABASE_URL not set — run `npm run test:pg`' : !fs.existsSync(path.join(DIST, 'Code.js')) ? 'gas-dist missing — run `npm run build`' : false;
const PASS = 'gas-rest-test-passphrase';
const NOW = '2026-10-12T00:30:00.000Z'; // Monday 07:30 Asia/Bangkok, demo term AY2026-T1
let fx;
let api;
let sim;
const seen = [];

before(async () => {
  if (skip) return;
  fx = await seededDatabase(BASE_URL, { now: NOW, passphrase: PASS });
  api = await startApiProcess({ appUrl: fx.app, now: NOW, dir: fx.dir, passphrase: PASS });
  sim = new GasSim({ properties: { CWK_ENV: 'DEV', CWK_SERVICE_BACKEND: 'REST', CWK_REST_BASE_URL: api.base, CWK_AUTH_MODE: 'DEMO' } });
  sim.load(DIST);
  sim.fetchHandler = (url, params) => {
    seen.push({ url, headers: { ...(params.headers || {}) }, body: params.payload ? JSON.parse(params.payload) : null });
    return syncFetch(url, params);
  };
});

after(async () => {
  if (skip) return;
  if (api) await api.stop();
  if (fx) await fx.drop();
});

function call(userId, operation, payload = {}, { key, expectedVersion = null, credential } = {}) {
  return sim.rpc({
    api_version: 'v1', request_id: crypto.randomUUID(), operation, payload, credential: credential !== undefined ? credential : (userId ? `demo:${userId}:${PASS}` : null),
    idempotency_key: key === undefined ? null : key, expected_version: expectedVersion,
  });
}

test('google.script.run.rpc → HttpApiAdapter → REST: the credential is forwarded in Authorization and verified by the backend', { skip }, () => {
  const me = call(fx.ids.gate, 'auth.getCurrentUser');
  assert.equal(me.ok, true, JSON.stringify(me.error));
  assert.equal(me.data.user.id, fx.ids.gate);
  const last = seen[seen.length - 1];
  assert.equal(last.url, `${api.base}/v1/rpc`);
  assert.equal(last.headers.Authorization, `Bearer demo:${fx.ids.gate}:${PASS}`);
  assert.equal(last.body.credential, null, 'the credential never travels in the forwarded body');
  assert.ok(!('user_id' in last.body) && !('roles' in last.body), 'no identity asserted by Apps Script');
  const wrong = call(fx.ids.admin, 'auth.getCurrentUser', {}, { credential: `demo:${fx.ids.admin}:not-the-passphrase` });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'UNAUTHENTICATED');
  const none = call(null, 'student.search', { q: 'a' });
  assert.equal(none.error.code, 'UNAUTHENTICATED');
});

test('core operations through the transport: search, scoped profile, gate lookup, record arrival, replay, concurrency', { skip }, async () => {
  const station = call(fx.ids.duty, 'station.list').data.items[0];
  const cls = await fx.query('SELECT id FROM classes ORDER BY code');
  const roster = (await fx.query('SELECT student_id FROM enrollments WHERE class_id = $1 ORDER BY student_id', [cls[0].id])).map((x) => x.student_id);
  const sid = roster[0];
  const found = call(fx.ids.affairs, 'student.search', { q: null, limit: 5 });
  assert.equal(found.ok, true, JSON.stringify(found.error));
  assert.ok(found.data.items.length > 0);
  assert.equal(call(fx.ids.homeroom1, 'student.profile', { student_id: sid }).data.access, 'FULL');
  assert.equal(call(fx.ids.gate, 'student.profile', { student_id: sid }).data.access, 'BASIC');
  const code = (await fx.query('SELECT student_code FROM students WHERE id = $1', [sid]))[0].student_code;
  const look = call(fx.ids.gate, 'attendance.lookupForGate', { code });
  assert.equal(look.data.student.id, sid);
  assert.equal(look.data.student.student_code, code, 'leading zeros preserved end to end');
  const key = crypto.randomUUID();
  const rec = call(fx.ids.gate, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' }, { key });
  assert.equal(rec.ok, true, JSON.stringify(rec.error));
  assert.equal(rec.data.is_late, false);
  assert.equal(rec.data.arrived_at, NOW, 'server time of the backend');
  const again = call(fx.ids.gate, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' }, { key });
  assert.equal(again.meta.replayed, true);
  assert.equal(again.data.event_id, rec.data.event_id);
  assert.equal((await fx.query('SELECT count(*)::int AS n FROM attendance_events WHERE student_id = $1', [sid]))[0].n, 1, 'no duplicate write in PostgreSQL');
  assert.equal(call(fx.ids.subject, 'attendance.recordArrival', { student_id: roster[1], station_id: station.id, source: 'SCAN_KEYBOARD' }, { key: crypto.randomUUID() }).error.code, 'FORBIDDEN');
  const v = (await fx.query('SELECT version FROM students WHERE id = $1', [sid]))[0].version;
  assert.equal(call(fx.ids.affairs, 'student.update', { student_id: sid, nickname: 'ผ่าน GAS', reason: 'ทดสอบ transport' }, { key: crypto.randomUUID(), expectedVersion: v }).ok, true);
  const stale = call(fx.ids.affairs, 'student.update', { student_id: sid, nickname: 'ซ้ำ', reason: 'ทดสอบ transport' }, { key: crypto.randomUUID(), expectedVersion: v });
  assert.equal(stale.error.code, 'CONFLICT');
  assert.equal(stale.error.details.current_version, v + 1);
});

test('REST mode: doGet boots the UI with the backend\'s public config; GAS stores nothing; jobs, webhook and admin tasks refuse', { skip }, () => {
  const page = sim.ctx.doGet({ parameter: {} }).getContent();
  const boot = JSON.parse(/<script>window\.__CWK_BOOT__ = (.*?);<\/script>/.exec(page)[1]);
  assert.equal(boot.public_config.auth_mode, 'DEMO');
  assert.equal(boot.public_config.school.name_th, 'โรงเรียนจุนวิทยาคม (ทดสอบ)');
  assert.equal(boot.transport, 'GAS');
  assert.match(sim.ctx.cronTick({}), /^REST_BACKEND/);
  assert.equal(JSON.parse(sim.ctx.doPost({ postData: { contents: '{}' } }).getContent()).error, 'WEBHOOK_DISABLED');
  sim.props.CWK_ADMIN_TASKS_ENABLED_UNTIL = new Date(Date.now() + 3600 * 1000).toISOString();
  assert.throws(() => sim.ctx.adminSetup(), /REST_BACKEND/);
  assert.equal(sim.books.size, 0, 'no spreadsheet was created in REST mode');
  assert.ok(!Object.keys(sim.props).includes('CWK_MASTER_SPREADSHEET_ID'));
});

test('backend unreachable or answering garbage → STORAGE_UNAVAILABLE (retryable; retry uses the same idempotency key)', { skip }, () => {
  const saved = sim.fetchHandler;
  try {
    sim.fetchHandler = () => { throw new Error('Exception: Address unavailable'); };
    let r = call(fx.ids.gate, 'auth.getCurrentUser');
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(r.error.retryable, true);
    sim.fetchHandler = () => ({ status: 502, body: '<html>Bad gateway</html>', headers: {} });
    r = call(fx.ids.gate, 'auth.getCurrentUser');
    assert.equal(r.error.code, 'STORAGE_UNAVAILABLE');
  } finally { sim.fetchHandler = saved; }
});

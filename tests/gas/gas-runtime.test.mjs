// Tests of the BUILT gas-dist bundle on the Apps Script emulator (automated pass on emulator only;
// real Apps Script behaviour is verified by adminSelfTest + UAT on the school account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GasSim, topLevelFunctions } from '../gas-sim/gas-sim.mjs';

const DIST = path.resolve(import.meta.dirname, '../../gas-dist');
const PASS = 'emulator-pass-123';
const ALLOWED = ['doGet', 'doPost', 'rpc', 'cronTick', 'adminSetup', 'adminSeedDemo', 'adminInstallTriggers', 'adminSelfTest', 'adminSchemaCheck', 'adminRecoverJournal', 'adminRestoreSnapshot'];

function inTwoHours() { return new Date(Date.now() + 3600 * 1000).toISOString(); }

function installed({ seed = true, now = null } = {}) {
  const sim = new GasSim({ now, properties: { CWK_ENV: 'DEV', CWK_AUTH_MODE: 'DEMO', CWK_DEMO_PASSPHRASE: PASS, CWK_ADMIN_TASKS_ENABLED_UNTIL: now ? new Date(Date.parse(now) + 3600 * 1000).toISOString() : inTwoHours() } });
  sim.load(DIST);
  const setup = sim.ctx.adminSetup();
  let demo = null;
  if (seed) demo = sim.ctx.adminSeedDemo();
  return { sim, setup, demo };
}

function env(sim, userId, operation, payload = {}, opts = {}) {
  return sim.rpc({
    api_version: 'v1', request_id: crypto.randomUUID(), operation, payload, credential: userId ? `demo:${userId}:${PASS}` : null,
    idempotency_key: opts.key === undefined ? (opts.mutation ? crypto.randomUUID() : null) : opts.key, expected_version: opts.expectedVersion ?? null,
  });
}

test('public surface: Entrypoints declares only the allowlisted functions; Code.js exposes one global', () => {
  const entry = fs.readFileSync(path.join(DIST, 'Entrypoints.js'), 'utf8');
  assert.deepEqual(topLevelFunctions(entry).sort(), [...ALLOWED].sort());
  const code = fs.readFileSync(path.join(DIST, 'Code.js'), 'utf8');
  assert.deepEqual(topLevelFunctions(code), [], 'bundle must not declare top-level functions');
  assert.ok(/^var CWK = /m.test(code));
  assert.ok(!/^\s*(import|export)\s/m.test(code), 'no ES module syntax in .gs');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'appsscript.json'), 'utf8'));
  assert.equal(manifest.timeZone, 'Asia/Bangkok');
  assert.equal(manifest.runtimeVersion, 'V8');
});

test('admin functions refuse without the time window, from a web visitor, or for a non-owner', () => {
  const sim = new GasSim({ properties: { CWK_ENV: 'DEV' } });
  sim.load(DIST);
  assert.throws(() => sim.ctx.adminSetup(), /ADMIN_TASKS_DISABLED/);
  sim.props.CWK_ADMIN_TASKS_ENABLED_UNTIL = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  assert.throws(() => sim.ctx.adminSetup(), /ADMIN_TASKS_DISABLED/, 'window longer than 2 h is refused');
  sim.props.CWK_ADMIN_TASKS_ENABLED_UNTIL = inTwoHours();
  sim.activeEmail = ''; // anonymous web visitor on an execute-as-owner deployment
  assert.throws(() => sim.ctx.adminSetup(), /ADMIN_TASKS_EDITOR_ONLY/);
  sim.activeEmail = 'teacher@example.com'; // same-domain visitor
  assert.throws(() => sim.ctx.adminSetup(), /ADMIN_TASKS_EDITOR_ONLY/);
  assert.equal(Object.keys(sim.books).length, 0);
});

test('setup is idempotent, creates private storage and a one-time bootstrap invitation', () => {
  const { sim, setup } = installed({ seed: false });
  assert.ok(setup.bootstrap_invitation_code);
  assert.ok(sim.props.CWK_MASTER_SPREADSHEET_ID && sim.props.CWK_DRIVE_ROOT_FOLDER_ID);
  assert.equal(sim.props.CWK_INSTALL_OWNER_EMAIL, 'owner@example.com');
  const master = sim.book(sim.props.CWK_MASTER_SPREADSHEET_ID);
  assert.equal(master.getSpreadsheetTimeZone(), 'Asia/Bangkok');
  assert.ok(master.getSheetByName('Students') && master.getSheetByName('StorageCatalog'));
  assert.equal(master.getSheetByName('Sheet1'), null);
  const studentsHeader = master.getSheetByName('Students').getRange(1, 1, 1, 3).getValues()[0];
  assert.deepEqual(studentsHeader, ['id', 'school_id', 'student_code']);
  const again = sim.ctx.adminSetup();
  assert.equal(again.bootstrap_invitation_code, undefined, 'second run issues no new invitation');
  assert.ok(sim.files.every((f) => f.sharing === 'PRIVATE'), 'nothing is shared');
  // other owner cannot run after ownership recorded
  sim.activeEmail = 'other@example.com';
  sim.ownerEmail = 'other@example.com';
  assert.throws(() => sim.ctx.adminSetup(), /ADMIN_TASKS_OWNER_ONLY/);
});

test('rpc on Sheets: scoped search, leading zeros and formula-like text survive the cell encoding', () => {
  const { sim, demo } = installed();
  const affairs = demo.staff.find((s) => s.key === 'affairs').user_id;
  const r = env(sim, affairs, 'student.search', { q: '00001' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.data.items[0].student_code, '00001');
  const cls = env(sim, affairs, 'class.list').data.items[0];
  const create = env(sim, affairs, 'student.create', { student_code: '00777', first_name_th: '+สมมติ', last_name_th: '@ทดสอบ', nickname: '-หนึ่ง', class_id: cls.id, effective_from: '2026-06-01' }, { mutation: true });
  assert.equal(create.ok, true, JSON.stringify(create.error));
  const got = env(sim, affairs, 'student.get', { student_id: create.data.student_id });
  assert.equal(got.data.student.student_code, '00777');
  assert.equal(got.data.student.first_name_th, '+สมมติ');
  assert.equal(got.data.student.last_name_th, '@ทดสอบ');
  assert.equal(got.data.student.nickname, '-หนึ่ง');
  const g1 = demo.guardian_users[0];
  const other = demo.guardian_users[1];
  assert.equal(env(sim, g1.user_id, 'student.get', { student_id: other.student_id }).error.code, 'FORBIDDEN');
  assert.equal(env(sim, demo.staff.find((s) => s.key === 'gate').user_id, 'user.list').error.code, 'FORBIDDEN');
});

test('idempotent replay and optimistic conflict through the Sheets MutationStore', () => {
  const { sim, demo } = installed();
  const affairs = demo.staff.find((s) => s.key === 'affairs').user_id;
  const s = env(sim, affairs, 'student.search', { q: '00002' }).data.items[0];
  const key = crypto.randomUUID();
  const a = env(sim, affairs, 'student.update', { student_id: s.id, nickname: 'เอ', reason: 'ทดสอบ' }, { key, expectedVersion: s.version });
  const b = env(sim, affairs, 'student.update', { student_id: s.id, nickname: 'เอ', reason: 'ทดสอบ' }, { key, expectedVersion: s.version });
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.meta.replayed, true);
  const c = env(sim, affairs, 'student.update', { student_id: s.id, nickname: 'บี', reason: 'ทดสอบ' }, { mutation: true, expectedVersion: s.version });
  assert.equal(c.error.code, 'CONFLICT');
});

test('journal recovery: crash after PREPARED is rolled forward by the next writer; nothing is lost or duplicated', () => {
  const { sim, demo } = installed();
  const affairs = demo.staff.find((s) => s.key === 'affairs').user_id;
  const cls = env(sim, affairs, 'class.list').data.items[0];
  const before = env(sim, affairs, 'student.search', { q: '0088' }).data.items.length;
  // inject a crash right after the journal is written (process dies before applying)
  const store = sim.ctx.CWK.buildDeps().rawStore;
  store.faults = { crashAfter: 'journal' };
  const r = env(sim, affairs, 'student.create', { student_code: '00881', first_name_th: 'กู้', last_name_th: 'คืน', class_id: cls.id, effective_from: '2026-06-01' }, { mutation: true });
  assert.equal(r.ok, false);
  store.faults = null;
  // next mutation recovers the prepared write-set first
  const r2 = env(sim, affairs, 'student.create', { student_code: '00882', first_name_th: 'ถัด', last_name_th: 'ไป', class_id: cls.id, effective_from: '2026-06-01' }, { mutation: true });
  assert.equal(r2.ok, true, JSON.stringify(r2.error));
  const after = env(sim, affairs, 'student.search', { q: '0088' }).data.items.map((x) => x.student_code).sort();
  assert.deepEqual(after, ['00881', '00882']);
  assert.equal(before, 0);
  const journal = store.journalStatus();
  assert.deepEqual(JSON.parse(JSON.stringify(journal)), { PREPARED: 0, RECOVERY_REQUIRED: 0 }); // cross-realm object
});

test('journal recovery after a crash mid-apply completes remaining writes exactly once', () => {
  const { sim, demo } = installed();
  const affairs = demo.staff.find((s) => s.key === 'affairs').user_id;
  const store = sim.ctx.CWK.buildDeps().rawStore;
  const s = env(sim, affairs, 'student.search', { q: '00003' }).data.items[0];
  store.faults = { crashAfter: 'apply:1' }; // first update applied, inserts (audit/changelog/idempotency) not yet
  const r = env(sim, affairs, 'student.update', { student_id: s.id, nickname: 'ครึ่งทาง', reason: 'ทดสอบ crash' }, { mutation: true, expectedVersion: s.version });
  assert.equal(r.ok, false);
  store.faults = null;
  const summary = store.withLock(() => store.recoverPending());
  assert.equal(summary.recovered, 1);
  const again = store.withLock(() => store.recoverPending());
  assert.equal(again.recovered, 0, 'recovery is idempotent');
  const got = env(sim, affairs, 'student.get', { student_id: s.id }).data.student;
  assert.equal(got.nickname, 'ครึ่งทาง');
  assert.equal(got.version, s.version + 1);
});

test('lock contention returns retryable LOCK_TIMEOUT without writing', () => {
  const { sim, demo } = installed();
  const affairs = demo.staff.find((s) => s.key === 'affairs').user_id;
  const s = env(sim, affairs, 'student.search', { q: '00004' }).data.items[0];
  sim.lockHeldByOther = true;
  const r = env(sim, affairs, 'student.update', { student_id: s.id, nickname: 'x', reason: 'y' }, { mutation: true });
  assert.equal(r.error.code, 'LOCK_TIMEOUT');
  assert.equal(r.error.retryable, true);
  sim.lockHeldByOther = false;
});

test('cronTick refuses manual/client invocation and runs from the installed trigger', () => {
  const { sim } = installed();
  assert.match(sim.ctx.cronTick({}), /REFUSED/);
  assert.match(sim.ctx.cronTick({ triggerUid: '9999' }), /REFUSED/);
  const t = sim.ctx.adminInstallTriggers();
  assert.equal(t.created, true);
  assert.equal(sim.ctx.adminInstallTriggers().created, false, 'idempotent');
  const out = JSON.parse(sim.ctx.cronTick({ triggerUid: sim.triggers[0].getUniqueId() }));
  assert.ok(out.recovery && out.tasks);
});

test('doGet serves App.html with escaped boot JSON and no secrets', () => {
  const { sim } = installed();
  const out = sim.ctx.doGet({ parameter: { page: 'gate', id: '<script>' } });
  const html = out.getContent();
  assert.ok(html.includes('window.__CWK_BOOT__ = {'));
  assert.ok(!html.includes('/*__CWK_BOOT__*/null'));
  assert.ok(!html.includes(PASS), 'demo passphrase is never sent to the page');
  assert.ok(html.includes('"initial_route":"gate"'));
  assert.ok(!html.includes('"focus_id":"<script>"'));
  assert.equal(out.xfo, 'DEFAULT');
});

test('term.create provisions per-term Ops/Daily/Notify workbooks registered in StorageCatalog', () => {
  const { sim, demo } = installed();
  const affairs = demo.staff.find((s) => s.key === 'affairs').user_id;
  const y = env(sim, affairs, 'academicYear.create', { start_year_ce: 2027, start_date: '2027-05-01', end_date: '2028-04-01' }, { mutation: true });
  assert.equal(y.ok, true, JSON.stringify(y.error));
  const t = env(sim, affairs, 'term.create', { academic_year_id: y.data.academic_year_id, term_no: 1, start_date: '2027-05-16', end_date: '2027-10-01' }, { mutation: true });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  const names = [...sim.books.values()].map((b) => b.getName());
  for (const g of ['Ops', 'Daily', 'Notify']) assert.ok(names.includes(`CWK-DEV-${g}-AY2027-T1`), `${g} workbook`);
});

test('daily flows on Sheets: gate arrival (dedupe), roll call, leave approval and dashboard on a fixed school day', () => {
  // 2026-06-15 08:10 Asia/Bangkok — Monday in demo term AY2026-T1 (example cutoff 08:00, grace 0)
  const { sim, demo } = installed({ now: '2026-06-15T01:10:00.000Z' });
  const staff = Object.fromEntries(demo.staff.map((s) => [s.key, s.user_id]));
  const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
  const classes = ok(env(sim, staff.homeroom1, 'class.list', {})).items;
  let mine = null;
  for (const c of classes) {
    const r = env(sim, staff.homeroom1, 'rollcall.get', { class_id: c.id, school_date: '2026-06-15' });
    if (r.ok && r.data.can_mark) { mine = r.data; break; }
  }
  assert.ok(mine && mine.items.length >= 3, 'homeroom1 has a class roster');
  const station = ok(env(sim, staff.duty, 'station.list', {})).items[0];
  const target = mine.items[1].student;
  const look = ok(env(sim, staff.duty, 'attendance.lookupForGate', { code: target.student_code }));
  assert.equal(look.student.id, target.id);
  const arr = ok(env(sim, staff.duty, 'attendance.recordArrival', { student_id: target.id, station_id: station.id, source: 'SCAN_KEYBOARD' }, { mutation: true }));
  assert.deepEqual([arr.is_late, arr.late_minutes, arr.late_counted], [true, 10, true]);
  const dup = ok(env(sim, staff.duty, 'attendance.recordArrival', { student_id: target.id, station_id: station.id, source: 'SCAN_KEYBOARD' }, { mutation: true }));
  assert.equal(dup.duplicate, true);
  assert.equal(dup.event_id, arr.event_id);
  // events land in the term partition workbook, not the master
  const daily = [...sim.books.values()].filter((b) => /AY2026-T1/.test(b.getName()));
  assert.ok(daily.length >= 1, 'term workbooks exist for the demo term');
  const evSheet = daily.map((b) => b.getSheetByName('AttendanceEvents')).find(Boolean);
  assert.ok(evSheet && evSheet.getLastRow() === 2, 'exactly one arrival row (header + 1)');
  // roll call with one absent, then the projection and dashboard agree
  const absent = mine.items[2].student.id;
  const sub = ok(env(sim, staff.homeroom1, 'rollcall.submit', { class_id: mine.class.id, school_date: '2026-06-15', marks: [{ student_id: absent, mark: 'ABSENT' }] }, { mutation: true }));
  assert.equal(sub.ABSENT, 1);
  const again = ok(env(sim, staff.homeroom1, 'rollcall.get', { class_id: mine.class.id, school_date: '2026-06-15' }));
  assert.equal(again.session.status, 'SUBMITTED');
  assert.equal(again.items.find((x) => x.student.id === absent).mark, 'ABSENT');
  assert.equal(again.items.find((x) => x.student.id === target.id).is_late, true);
  const dash = ok(env(sim, staff.homeroom1, 'dashboard.summary', { class_id: mine.class.id }));
  assert.equal(dash.totals.late_counted, 1);
  assert.equal(dash.totals.school_days, mine.items.length);
  assert.equal(dash.roll_call.classes_submitted, 1);
  // leave: guardian of a student in this class submits, the routed homeroom approves
  const g = demo.guardian_users.find((x) => mine.items.some((i) => i.student.id === x.student_id));
  assert.ok(g, 'demo seed links a guardian account to a student in this class');
  {
    const lv = ok(env(sim, g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'PERSONAL', reason: 'ไปทำธุระ', days: [{ school_date: '2026-06-16', unit: 'FULL_DAY' }] }, { mutation: true }));
    assert.equal(lv.status, 'PENDING_SCHOOL');
    const inbox = ok(env(sim, staff.homeroom1, 'leave.inbox', {})).items;
    assert.ok(inbox.some((x) => x.request.id === lv.leave_request_id));
    const dec = ok(env(sim, staff.homeroom1, 'leave.decide', { leave_request_id: lv.leave_request_id, decision: 'APPROVED' }, { mutation: true, expectedVersion: 1 }));
    assert.equal(dec.status, 'APPROVED');
    assert.equal(ok(env(sim, g.user_id, 'leave.get', { leave_request_id: lv.leave_request_id })).segments[0].status, 'APPROVED');
  }
});

test('notifications on Apps Script: MailApp email, doPost envelope → LINE account link, LINE push with retry key', async () => {
  const { buildEnvelope } = await import('../../gateway/src/app.mjs');
  const now = '2026-06-15T03:30:00.000Z'; // 10:30 Bangkok, outside quiet hours
  const sim = new GasSim({ now, properties: {
    CWK_ENV: 'DEV', CWK_AUTH_MODE: 'DEMO', CWK_DEMO_PASSPHRASE: PASS, CWK_ADMIN_TASKS_ENABLED_UNTIL: new Date(Date.parse(now) + 3600 * 1000).toISOString(),
    CWK_LINE_ENABLED: 'true', CWK_LINE_CHANNEL_ACCESS_TOKEN: 'emulator-line-token', CWK_LINE_WEBHOOK_SECRET: 'emulator-envelope-secret', CWK_LINE_WEBHOOK_KEY_ID: 'line-k1',
    CWK_WEBAPP_URL: 'https://script.google.com/macros/s/EMULATOR/exec',
  } });
  sim.load(DIST);
  sim.ctx.adminSetup();
  const demo = sim.ctx.adminSeedDemo();
  const staff = Object.fromEntries(demo.staff.map((s) => [s.key, s.user_id]));
  const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
  // LINE Messaging API double behind UrlFetchApp
  const pushes = [];
  const seenKeys = new Set();
  const replies = [];
  sim.fetchHandler = (url, params) => {
    const headers = params.headers || {};
    assert.equal(headers.Authorization, 'Bearer emulator-line-token');
    if (url.endsWith('/linkToken')) return { status: 200, body: JSON.stringify({ linkToken: 'EmuLinkToken123' }) };
    if (url.endsWith('/v2/bot/message/reply')) { replies.push(JSON.parse(params.payload)); return { status: 200, body: '{}' }; }
    if (url.endsWith('/v2/bot/message/push')) {
      const key = headers['X-Line-Retry-Key'];
      assert.match(key, /^[0-9a-f-]{36}$/);
      if (seenKeys.has(key)) return { status: 409, body: '{"message":"The retry key is already accepted"}', headers: { 'x-line-accepted-request-id': 'req-1' } };
      seenKeys.add(key);
      pushes.push(JSON.parse(params.payload));
      return { status: 200, body: '{}', headers: { 'x-line-request-id': `req-${pushes.length}` } };
    }
    return { status: 404, body: '{}' };
  };
  // find homeroom1's class and a linked guardian there
  let mine = null;
  for (const c of ok(env(sim, staff.homeroom1, 'class.list', {})).items) {
    const r = env(sim, staff.homeroom1, 'rollcall.get', { class_id: c.id, school_date: '2026-06-15' });
    if (r.ok && r.data.can_mark) { mine = r.data; break; }
  }
  const g = demo.guardian_users.find((x) => mine.items.some((i) => i.student.id === x.student_id));
  assert.ok(g);
  const gEmail = `guardian${demo.guardian_users.indexOf(g) + 1}@example.com`;
  sim.props.CWK_NOTIFY_ALLOWLIST = `${gEmail},U0123456789abcdef0123456789abcdef`;
  sim.ctx.adminInstallTriggers();
  const tick = () => JSON.parse(sim.ctx.cronTick({ triggerUid: sim.triggers[0].getUniqueId() }));
  // 1) email path works without LINE being linked
  ok(env(sim, staff.homeroom1, 'rollcall.submit', { class_id: mine.class.id, school_date: '2026-06-15', marks: [{ student_id: g.student_id, mark: 'ABSENT' }] }, { mutation: true }));
  ok(env(sim, staff.homeroom1, 'attendance.verifyDay', { class_id: mine.class.id, school_date: '2026-06-15', confirm_absent_student_ids: [g.student_id] }, { mutation: true }));
  const t1 = tick();
  assert.equal(t1.tasks['outbox.dispatch'].sent, 1, JSON.stringify(t1.tasks['outbox.dispatch']));
  const mail = sim.mail.find((m) => m.to === gEmail);
  assert.ok(mail, 'MailApp.sendEmail called for the allowlisted guardian');
  assert.match(mail.subject, /แจ้งขาดเรียน/);
  assert.equal(mail.noReply, true);
  // 2) LINE account link through doPost envelopes (Thai text in payload exercises UTF-8 hashing)
  const post = (event) => {
    const e = buildEnvelope({ keyId: 'line-k1', secret: 'emulator-envelope-secret', nonce: event.webhookEventId, payload: JSON.stringify(event), nowMs: Date.parse(now) });
    return JSON.parse(sim.ctx.doPost({ postData: { contents: JSON.stringify(e), type: 'application/json' } }).getContent());
  };
  const LINE_ID = 'U0123456789abcdef0123456789abcdef';
  const base = { timestamp: Date.parse(now), mode: 'active', source: { type: 'user', userId: LINE_ID }, deliveryContext: { isRedelivery: false } };
  assert.deepEqual(post({ ...base, type: 'follow', webhookEventId: '01HXEMU0000000000000000001', replyToken: 'rt1' }), { ok: true, stored: true });
  assert.match(replies[0].messages[0].text, /page=line-link&linkToken=EmuLinkToken123/);
  const start = ok(env(sim, g.user_id, 'channel.startLineLink', { link_token: 'EmuLinkToken123' }, { mutation: true }));
  const nonce = new URL(start.redirect_url).searchParams.get('nonce');
  assert.deepEqual(post({ ...base, type: 'accountLink', webhookEventId: '01HXEMU0000000000000000002', replyToken: 'rt2', link: { result: 'ok', nonce } }), { ok: true, stored: true });
  assert.equal(ok(env(sim, g.user_id, 'channel.status', {})).bindings[0].status, 'ACTIVE');
  assert.deepEqual(post({ ...base, type: 'accountLink', webhookEventId: '01HXEMU0000000000000000002', replyToken: 'rt2', link: { result: 'ok', nonce } }), { ok: true, stored: true, duplicate: true });
  // a forged envelope is refused and nothing is stored
  const forged = JSON.parse(sim.ctx.doPost({ postData: { contents: JSON.stringify({ v: 1, kid: 'line-k1', ts: Math.floor(Date.parse(now) / 1000), nonce: '01HXEMU0000000000000000003', source: 'LINE', payload: '{}', sig: 'AAAA' }) } }).getContent());
  assert.deepEqual([forged.ok, forged.stored], [false, false]);
  // inbound Thai message from the bound guardian reaches the homeroom contact inbox
  assert.deepEqual(post({ ...base, type: 'message', webhookEventId: '01HXEMU0000000000000000004', replyToken: 'rt4', message: { type: 'text', id: 'm1', text: 'ลูกไม่สบาย ขอลาพรุ่งนี้ค่ะ' } }), { ok: true, stored: true });
  assert.ok(ok(env(sim, staff.homeroom1, 'contact.inbox', {})).items.some((x) => x.summary.includes('ไม่สบาย')));
  // 3) the next notification goes to LINE with a retry key; a re-push with the same key is a 409 no-op
  const station = ok(env(sim, staff.duty, 'station.list', {})).items[0];
  sim.setNow('2026-06-16T01:20:00.000Z'); // 08:20 next school day → late
  ok(env(sim, staff.duty, 'attendance.recordArrival', { student_id: g.student_id, station_id: station.id, source: 'SCAN_KEYBOARD' }, { mutation: true }));
  sim.setNow('2026-06-16T03:00:00.000Z');
  const t2 = tick();
  assert.ok(t2.tasks['outbox.dispatch'].sent >= 1, JSON.stringify(t2.tasks['outbox.dispatch']));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, LINE_ID);
  assert.match(pushes[0].messages[0].text, /มาสาย|แจ้งมาสาย/);
  assert.ok(pushes[0].messages[1].template.actions.some((a) => a.type === 'postback'));
});

test('reports on Apps Script: PDF via Docs template (header row pinned), real XLSX export, CSV; backup snapshot and restore drill', () => {
  const now = '2026-06-15T03:30:00.000Z';
  const { sim, demo } = installed({ now });
  const staff = Object.fromEntries(demo.staff.map((s) => [s.key, s.user_id]));
  const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
  assert.ok(sim.props.CWK_REPORT_TEMPLATE_DOC_ID, 'adminSetup created the A4 report template');
  const station = ok(env(sim, staff.duty, 'station.list', {})).items[0];
  const someone = ok(env(sim, staff.affairs, 'student.search', { q: null, limit: 1 })).items[0];
  ok(env(sim, staff.duty, 'attendance.recordArrival', { student_id: someone.id, station_id: station.id, source: 'SCAN_KEYBOARD' }, { mutation: true }));
  sim.ctx.adminInstallTriggers();
  const tick = () => JSON.parse(sim.ctx.cronTick({ triggerUid: sim.triggers[0].getUniqueId() }));
  const pdf = ok(env(sim, staff.affairs, 'report.run', { code: 'R01', filter: { date: '2026-06-15' }, format: 'PDF' }, { mutation: true }));
  const xlsx = ok(env(sim, staff.affairs, 'report.run', { code: 'R02', filter: { from: '2026-06-15', to: '2026-06-15' }, format: 'XLSX' }, { mutation: true }));
  const csv = ok(env(sim, staff.affairs, 'report.run', { code: 'R02', filter: { from: '2026-06-15', to: '2026-06-15' }, format: 'CSV' }, { mutation: true }));
  tick();
  tick();
  const runs = ok(env(sim, staff.affairs, 'report.runs', {})).items;
  for (const id of [pdf.run_id, xlsx.run_id, csv.run_id]) assert.equal(runs.find((r) => r.id === id).status, 'READY', JSON.stringify(runs.map((r) => [r.report_code, r.status])));
  const pdfFile = ok(env(sim, staff.affairs, 'report.download', { run_id: pdf.run_id }));
  const pdfText = Buffer.from(pdfFile.content_base64, 'base64').toString('utf8');
  assert.match(pdfText, /^%PDF-EMULATOR/);
  assert.match(pdfText, /R01 การมาเรียนประจำวัน/);
  assert.match(pdfText, /ผู้มีสิทธิ์มาเรียน \| มาแล้ว/, 'table header row present');
  assert.match(pdfText, /ลงชื่อ/, 'signature lines');
  assert.doesNotMatch(pdfText, /\{\{/, 'all placeholders filled');
  const pinned = [...sim.docs.values()].flatMap((d) => d.requests).filter((r) => r.pinTableHeaderRows);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].pinTableHeaderRows.pinnedHeaderRowsCount, 1);
  const x = Buffer.from(ok(env(sim, staff.affairs, 'report.download', { run_id: xlsx.run_id })).content_base64, 'base64');
  assert.deepEqual([...x.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'Drive export produced a zip container (xlsx), not a renamed CSV');
  const c = Buffer.from(ok(env(sim, staff.affairs, 'report.download', { run_id: csv.run_id })).content_base64, 'base64').toString('utf8');
  assert.equal(c.charCodeAt(0), 0xfeff);
  assert.ok(sim.files.filter((f) => /^cwk-report-tmp-/.test(f.name)).every((f) => f.trashed), 'temporary docs/sheets trashed');
  assert.ok(sim.files.every((f) => f.sharing === 'PRIVATE'), 'nothing shared');
  // backup snapshot (manual) → manifest + config without secrets
  const b = ok(env(sim, staff.admin, 'backup.run', {}, { mutation: true }));
  tick();
  const run = ok(env(sim, staff.admin, 'backup.list', {})).items.find((r) => r.id === b.backup_run_id);
  assert.equal(run.status, 'SUCCEEDED', JSON.stringify(run));
  assert.equal(run.manifest_sha256.length, 64);
  const folder = sim.folders.find((f) => f.id === run.package_location);
  const names = sim.files.filter((f) => f.folder === folder).map((f) => f.name);
  assert.ok(names.includes('manifest.json') && names.includes('config.json') && names.includes('attachments-manifest.json'));
  const cfg = sim.files.find((f) => f.folder === folder && f.name === 'config.json').getBlob().getDataAsString();
  assert.doesNotMatch(cfg, /CWK_DEMO_PASSPHRASE|emulator-pass|CWK_GATEWAY_SECRET/);
  // restore drill into a NEW environment (same Drive owner): refuses while data exists
  sim.props.CWK_RESTORE_FROM_FOLDER_ID = run.package_location;
  assert.throws(() => sim.ctx.adminRestoreSnapshot(), /RESTORE_REFUSED/);
  const oldMaster = sim.props.CWK_MASTER_SPREADSHEET_ID;
  delete sim.props.CWK_MASTER_SPREADSHEET_ID;
  delete sim.props.CWK_DRIVE_ROOT_FOLDER_ID;
  const restored = sim.ctx.adminRestoreSnapshot();
  assert.equal(restored.row_count_check, 'OK', JSON.stringify(restored.mismatches));
  assert.notEqual(sim.props.CWK_MASTER_SPREADSHEET_ID, oldMaster);
  const found = ok(env(sim, staff.affairs, 'student.search', { q: someone.student_code })).items;
  assert.equal(found[0].id, someone.id, 'restored environment serves the same data');
  const r2 = ok(env(sim, staff.affairs, 'report.preview', { code: 'R02', filter: { from: '2026-06-15', to: '2026-06-15' } }));
  assert.equal(r2.rows.length, 1, 'term partition workbook restored and catalog re-pointed');
});

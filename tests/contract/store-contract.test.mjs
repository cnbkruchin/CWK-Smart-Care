// Repository contract (MASTER_PROMPT §18 "repository contract tests"): the SAME behaviour from every
// MutationStore/TableStore adapter — memory (always) and PostgreSQL (needs DATABASE_URL; otherwise reported
// as skipped). The Sheets adapter runs the same operations through the GAS emulator tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MemoryStore } from '../../src/adapters/memory/memory-store.js';
import { PgStore } from '../../src/adapters/postgres/pg-store.js';
import { ChangeSetBuilder } from '../../src/application/changeset.js';
import { nodeIds } from '../../src/adapters/node/ports.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_URL = process.env.DATABASE_URL;
const NOW = '2026-06-15T03:00:00.123Z';
let pgEnv = null;

before(async () => {
  if (!BASE_URL) return;
  const name = `cwk_contract_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 8 });
  await pool.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
  pgEnv = { name, pool };
});

after(async () => {
  if (!pgEnv) return;
  await pgEnv.pool.end();
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${pgEnv.name} WITH (FORCE)`);
  await admin.end();
});

const cs = (operation = 'test.op') => new ChangeSetBuilder({ operation, operationId: crypto.randomUUID(), actorId: '00000000-0000-4000-8000-000000000001', now: NOW, terms: [], tz: 'Asia/Bangkok', ids: nodeIds });

const SYSTEM = '00000000-0000-4000-8000-000000000001';
/** First change set of any installation: a school and the system user that every ChangeLog row references. */
async function bootstrap(store) {
  const b = cs('bootstrap');
  const sc = b.insert('Schools', { code: 'BOOT', name_th: 'โรงเรียนตั้งต้น', timezone: 'Asia/Bangkok', locale: 'th-TH' });
  b.insert('Users', { id: SYSTEM, school_id: sc.id, user_type: 'SYSTEM', display_name: 'ระบบ', status: 'ACTIVE' });
  await store.commit(b.build());
}
let pgBooted = false;

const ADAPTERS = [
  { name: 'memory', skip: false, make: async () => { const store = new MemoryStore(); await bootstrap(store); return { store, setMode: async (s, m) => { s.mode = m; } }; } },
  {
    name: 'postgres', skip: BASE_URL ? false : 'DATABASE_URL not set — run `npm run test:pg`',
    make: async () => {
      // each test works in its own school (unique codes) inside the shared contract database
      const store = new PgStore({ pool: pgEnv.pool });
      if (!pgBooted) { await bootstrap(store); pgBooted = true; }
      return { store, setMode: async (s, m) => s.setSystemMode(m, '00000000-0000-4000-8000-000000000001') };
    },
  },
];

async function school(store) {
  const b = cs();
  const s = b.insert('Schools', { code: `S-${crypto.randomBytes(3).toString('hex')}`, name_th: 'โรงเรียนทดสอบ', timezone: 'Asia/Bangkok', locale: 'th-TH' });
  await store.commit(b.build());
  return s;
}

function student(b, schoolId, code, extra = {}) {
  return b.insert('Students', { school_id: schoolId, student_code: code, first_name_th: 'ทดสอบ', last_name_th: 'สังเคราะห์', status: 'ACTIVE', ...extra });
}

for (const A of ADAPTERS) {
  test(`[${A.name}] canonical values round-trip exactly (leading zeros, Thai, null, boolean, json, timestamps)`, { skip: A.skip }, async () => {
    const { store } = await A.make();
    const sc = await school(store);
    const b = cs();
    const st = student(b, sc.id, '00123', { first_name_th: 'ด.ญ. ศศิธร', nickname: null, birth_date: '2013-02-28' });
    const station = b.insert('Stations', { school_id: sc.id, code: '=1+1', name_th: 'ประตูหน้า', station_type: 'GATE', status: 'ACTIVE' });
    const setting = b.insert('Settings', { school_id: sc.id, key: 'test.json_roundtrip', value_json: { a: [1, 'สอง', null], ok: true, n: { x: 1.5 } }, is_example: false });
    await store.commit(b.build());
    const got = await store.get('Students', st.id);
    assert.deepEqual(got, st);
    const s2 = await store.get('Stations', station.id);
    assert.deepEqual(s2, station);
    assert.equal(s2.code, '=1+1');
    assert.deepEqual(await store.get('Settings', setting.id), setting);
    assert.equal(got.created_at, NOW);
  });

  test(`[${A.name}] list: where operators, null-aware ne/nin, text order, paging and all`, { skip: A.skip }, async () => {
    const { store } = await A.make();
    const sc = await school(store);
    const b = cs();
    const codes = ['00010', '00002', 'A01', 'b02', 'Z99', 'a00'];
    const names = ['ขาว', 'กล้า', 'คม', 'กุ้ง', 'ขวัญ', 'อร'];
    codes.forEach((c, i) => student(b, sc.id, c, { nickname: i % 2 ? null : `n${i}`, first_name_th: names[i] }));
    await store.commit(b.build());
    const q = async (where, extra = {}) => (await store.list('Students', { where: { school_id: sc.id, ...where }, limit: 500, ...extra })).items.map((x) => x.student_code);
    assert.deepEqual(await q({}, { orderBy: [['student_code', 'asc']] }), ['00002', '00010', 'A01', 'Z99', 'a00', 'b02'], 'byte order, like JavaScript');
    assert.deepEqual(await q({}, { orderBy: [['first_name_th', 'asc']] }), ['00002', 'b02', 'Z99', '00010', 'A01', 'a00'], 'Thai text in code-point order');
    assert.deepEqual(await q({ student_code: { in: ['A01', 'Z99'] } }, { orderBy: [['student_code', 'asc']] }), ['A01', 'Z99']);
    assert.equal((await q({ nickname: { ne: 'n0' } })).length, 5, 'ne keeps NULLs (JavaScript semantics)');
    assert.equal((await q({ nickname: { nin: ['n0', 'n2'] } })).length, 4);
    assert.deepEqual(await q({ nickname: null }, { orderBy: [['student_code', 'asc']] }), ['00002', 'a00', 'b02']);
    assert.deepEqual(await q({ nickname: { isNull: false } }, { orderBy: [['student_code', 'asc']] }), ['00010', 'A01', 'Z99']);
    assert.deepEqual(await q({ student_code: { prefix: '000' } }, { orderBy: [['student_code', 'desc']] }), ['00010', '00002']);
    assert.deepEqual(await q({ student_code: { gte: 'A01', lt: 'a' } }, { orderBy: [['student_code', 'asc']] }), ['A01', 'Z99']);
    assert.deepEqual(await q({ first_name_th: { contains: 'ข' } }, { orderBy: [['student_code', 'asc']] }), ['00010', 'Z99']);
    const p1 = await store.list('Students', { where: { school_id: sc.id }, orderBy: [['student_code', 'asc']], limit: 4 });
    assert.equal(p1.items.length, 4);
    const p2 = await store.list('Students', { where: { school_id: sc.id }, orderBy: [['student_code', 'asc']], limit: 4, cursor: p1.next_cursor });
    assert.deepEqual(p2.items.map((x) => x.student_code), ['a00', 'b02']);
    assert.equal(p2.next_cursor, null);
    assert.equal((await store.list('Students', { where: { school_id: sc.id }, all: true })).items.length, 6);
    assert.equal((await store.findBy('Students', 'student_code', '00010')).filter((x) => x.school_id === sc.id).length, 1);
  });

  test(`[${A.name}] optimistic concurrency: stale or missing versions are CONFLICT and nothing is written`, { skip: A.skip }, async () => {
    const { store } = await A.make();
    const sc = await school(store);
    let b = cs();
    const st = student(b, sc.id, 'C001');
    await store.commit(b.build());
    b = cs();
    b.update('Students', st, { nickname: 'หนึ่ง' });
    await store.commit(b.build());
    b = cs();
    b.update('Students', st, { nickname: 'แข่ง' }); // still based on version 1
    await assert.rejects(async () => store.commit(b.build()), (e) => e.code === 'CONFLICT' && e.details.current_version === 2);
    assert.equal((await store.get('Students', st.id)).nickname, 'หนึ่ง');
  });

  test(`[${A.name}] a change set is atomic: a unique violation rolls back every write in it`, { skip: A.skip }, async () => {
    const { store } = await A.make();
    const sc = await school(store);
    let b = cs();
    student(b, sc.id, 'U001');
    await store.commit(b.build());
    b = cs();
    const ok = student(b, sc.id, 'U002');
    student(b, sc.id, 'U001');
    await assert.rejects(async () => store.commit(b.build()), (e) => e.code === 'UNIQUE_VIOLATION');
    assert.equal(await store.get('Students', ok.id), null, 'the valid insert of the same change set was not kept');
  });

  test(`[${A.name}] foreign keys are enforced; writes inside one change set may come in any order`, { skip: A.skip }, async () => {
    const { store } = await A.make();
    const sc = await school(store);
    let b = cs();
    student(b, '99999999-9999-4999-8999-999999999999', 'F001');
    await assert.rejects(async () => store.commit(b.build()), (e) => e.code === 'VALIDATION_ERROR');
    // child before parent in the same change set
    b = cs();
    const parentId = crypto.randomUUID();
    student(b, parentId, 'F002');
    b.insert('Schools', { id: parentId, code: `P-${crypto.randomBytes(3).toString('hex')}`, name_th: 'ใหม่', timezone: 'Asia/Bangkok', locale: 'th-TH' });
    await store.commit(b.build());
    assert.ok(await store.get('Schools', parentId));
    void sc;
  });

  test(`[${A.name}] idempotency: same key + payload replays, different payload is refused`, { skip: A.skip }, async () => {
    const { store } = await A.make();
    const sc = await school(store);
    const key = `u|student.create|${crypto.randomUUID()}`;
    const idem = (hash) => ({ scope_key: key, key: crypto.randomUUID(), request_hash: hash, expires_at: '2026-06-22T03:00:00.000Z' });
    let b = cs('student.create');
    const s1 = student(b, sc.id, 'I001');
    const r1 = await store.commit(b.build({ result: { student_id: s1.id }, idempotency: idem('h1') }));
    assert.equal(r1.replayed, false);
    b = cs('student.create');
    student(b, sc.id, 'I002');
    const r2 = await store.commit(b.build({ result: { student_id: 'other' }, idempotency: idem('h1') }));
    assert.equal(r2.replayed, true);
    assert.deepEqual(r2.result, { student_id: s1.id });
    assert.equal((await store.findBy('Students', 'student_code', 'I002')).length, 0, 'the replayed request wrote nothing');
    b = cs('student.create');
    student(b, sc.id, 'I003');
    await assert.rejects(async () => store.commit(b.build({ result: {}, idempotency: idem('h2') })), (e) => e.code === 'DUPLICATE_REQUEST_MISMATCH');
  });

  test(`[${A.name}] read-only mode is enforced by the store; maintenance writes still pass`, { skip: A.skip }, async () => {
    const { store, setMode } = await A.make();
    const sc = await school(store);
    await setMode(store, 'READ_ONLY');
    try {
      let b = cs();
      student(b, sc.id, 'M001');
      await assert.rejects(async () => store.commit(b.build()), (e) => e.code === 'MAINTENANCE_MODE');
      b = cs();
      b.maintenanceAllowed = true;
      student(b, sc.id, 'M002');
      await store.commit(b.build());
    } finally {
      await setMode(store, 'NORMAL');
    }
  });

  test(`[${A.name}] ChangeLog sequence is unique and contiguous, also under concurrent commits`, { skip: A.skip }, async () => {
    const { store } = await A.make();
    const sc = await school(store);
    const before = (await store.list('ChangeLog', { all: true })).items.map((c) => c.seq);
    const start = before.length ? Math.max(...before) : 0;
    const commits = Array.from({ length: 12 }, (_, i) => { const b = cs(); student(b, sc.id, `Q${String(i).padStart(3, '0')}`); return store.commit(b.build()); });
    const res = await Promise.all(commits);
    const seqs = res.map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 12 }, (_, i) => start + i + 1));
    const all = (await store.list('ChangeLog', { all: true, orderBy: [['seq', 'asc']] })).items.map((c) => c.seq);
    assert.deepEqual(all, Array.from({ length: all.length }, (_, i) => all[0] + i));
  });
}

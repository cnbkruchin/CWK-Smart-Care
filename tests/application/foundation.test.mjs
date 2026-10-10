import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeHarness, TokenMapVerifier } from '../helpers/app-harness.mjs';
import { SYSTEM_USER_ID } from '../../src/shared/uuid.js';

function setup() {
  const h = makeHarness();
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  return { h, seed, ids };
}

test('bootstrap is idempotent and never grants student-data roles to the first admin', () => {
  const h = makeHarness();
  const a = h.bootstrap();
  assert.ok(a.invitation_code && /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/.test(a.invitation_code));
  const b = h.bootstrap();
  assert.equal(b.invitation_code, null, 'second run creates nothing new');
  assert.deepEqual(b.created, []);
  const roles = h.store.list('UserRoles', { limit: 50 }).items;
  assert.deepEqual(roles.map((r) => r.role), ['SYSTEM_ADMIN']);
  const rules = h.store.list('RuleVersions', { limit: 50 }).items;
  assert.ok(rules.length >= 5 && rules.every((r) => r.is_example), 'seeded rules are flagged as examples');
});

test('first admin activation: verified email must match the bound invitation; code is single-use', () => {
  const verifier = new TokenMapVerifier();
  const h = makeHarness({ identity: verifier });
  const { invitation_code: code } = h.bootstrap('owner@example.com');
  verifier.add('tok-wrong', { subject: 'uid-x', email: 'attacker@example.com' });
  verifier.add('tok-unverified', { subject: 'uid-u', email: 'owner@example.com', email_verified: false });
  verifier.add('tok-owner', { subject: 'uid-owner', email: 'owner@example.com' });
  const raw = { rawCredential: true };
  let r = h.call('tok-unverified', 'auth.redeemInvitation', { code }, raw);
  assert.equal(r.error.code, 'FORBIDDEN');
  r = h.call('tok-wrong', 'auth.redeemInvitation', { code }, raw);
  assert.equal(r.error.code, 'FORBIDDEN');
  const inv = h.store.list('InvitationRecords', { limit: 5 }).items[0];
  assert.equal(inv.attempt_count, 1, 'mismatch is counted durably');
  r = h.call('tok-owner', 'auth.getCurrentUser', {}, raw);
  assert.equal(r.data.linked, false);
  assert.deepEqual(r.data.needs, ['REDEEM_INVITATION']);
  r = h.call('tok-owner', 'auth.redeemInvitation', { code: code.toLowerCase().replace(/-/g, ' ') }, raw);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  r = h.call('tok-owner', 'auth.getCurrentUser', {}, raw);
  assert.equal(r.data.linked, true);
  assert.deepEqual(r.data.roles, ['SYSTEM_ADMIN']);
  assert.ok(!r.data.actions.includes('student.read'));
  verifier.add('tok-other', { subject: 'uid-2', email: 'owner@example.com' });
  r = h.call('tok-other', 'auth.redeemInvitation', { code }, raw);
  assert.equal(r.error.code, 'VALIDATION_ERROR', 'already redeemed');
});

test('an unlinked identity cannot call USER operations; unknown operations are rejected', () => {
  const verifier = new TokenMapVerifier();
  const h = makeHarness({ identity: verifier });
  h.bootstrap();
  verifier.add('tok', { subject: 'stranger', email: 's@example.com' });
  assert.equal(h.call('tok', 'student.search', { q: '0' }, { rawCredential: true }).error.code, 'ACCOUNT_NOT_LINKED');
  assert.equal(h.call('tok', 'setup.bootstrap', {}, { rawCredential: true }).error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(h.call('tok', 'constructor', {}, { rawCredential: true }).error.code, 'VALIDATION_ERROR');
  assert.equal(h.call(null, 'student.search', { q: '0' }).error.code, 'UNAUTHENTICATED');
});

test('guardian sees only verified-linked child; payload tampering is refused', () => {
  const { h, seed } = setup();
  const [g1, g2] = seed.guardian_users;
  const mine = h.ok(g1.user_id, 'student.listMine');
  assert.deepEqual(mine.items.map((s) => s.id), [g1.student_id]);
  assert.equal(h.ok(g1.user_id, 'student.get', { student_id: g1.student_id }).access, 'FULL');
  const other = h.call(g1.user_id, 'student.get', { student_id: g2.student_id });
  assert.equal(other.error.code, 'FORBIDDEN');
  assert.equal(h.call(g1.user_id, 'student.search', { q: '' }).error.code, 'FORBIDDEN');
  assert.equal(h.call(g1.user_id, 'guardian.listForStudent', { student_id: g1.student_id }).error.code, 'FORBIDDEN');
  // ending the relationship removes access immediately
  const link = h.store.findBy('StudentGuardians', 'student_id', g1.student_id)[0];
  h.ok(seed.staff.find((s) => s.key === 'affairs').user_id, 'guardian.endLink', { link_id: link.id, effective_to: '2026-06-15', reason: 'เปลี่ยนผู้ปกครอง' });
  assert.equal(h.call(g1.user_id, 'student.get', { student_id: g1.student_id }).error.code, 'FORBIDDEN');
});

test('duty/gate staff: basic identification only; no user list or export; homeroom limited to class', () => {
  const { h, ids, seed } = setup();
  const anyStudent = h.store.list('Students', { limit: 1 }).items[0];
  assert.equal(h.ok(ids.gate, 'student.get', { student_id: anyStudent.id }).access, 'BASIC');
  assert.ok(!('birth_date' in h.ok(ids.gate, 'student.get', { student_id: anyStudent.id }).student));
  assert.equal(h.call(ids.duty, 'user.list', {}).error.code, 'FORBIDDEN');
  const hr = h.ok(ids.homeroom1, 'student.search', { q: null });
  const classes = new Set(hr.items.map((s) => s.class_code));
  assert.deepEqual([...classes], ['M1/1']);
  assert.equal(hr.items.length, 5);
  assert.equal(h.ok(ids.affairs, 'student.search', { q: null }).items.length, 10);
  assert.equal(h.call(ids.admin, 'student.search', { q: null }).error.code, 'FORBIDDEN', 'system admin has no student data access');
  void seed;
});

test('leading zeros, Thai search and code prefix search', () => {
  const { h, ids } = setup();
  const r = h.ok(ids.affairs, 'student.search', { q: '00001' });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].student_code, '00001');
  const s = h.store.list('Students', { limit: 1 }).items[0];
  const byName = h.ok(ids.affairs, 'student.search', { q: s.first_name_th });
  assert.ok(byName.items.some((x) => x.id === s.id));
});

test('idempotency: same key + same payload replays; same key + different payload is rejected', () => {
  const { h, ids, seed } = setup();
  const cls = h.store.list('Classes', { limit: 1 }).items[0];
  const key = crypto.randomUUID();
  const payload = { student_code: '09999', first_name_th: 'ทดลอง', last_name_th: 'ซ้ำ', class_id: cls.id, effective_from: '2026-06-15' };
  const a = h.call(ids.affairs, 'student.create', payload, { idempotencyKey: key });
  const b = h.call(ids.affairs, 'student.create', payload, { idempotencyKey: key });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.meta.replayed, true);
  assert.deepEqual(a.data, b.data);
  assert.equal(h.store.findBy('Students', 'student_code', '09999').length, 1);
  const c = h.call(ids.affairs, 'student.create', { ...payload, first_name_th: 'อื่น' }, { idempotencyKey: key });
  assert.equal(c.error.code, 'DUPLICATE_REQUEST_MISMATCH');
  const missing = h.call(ids.affairs, 'student.create', payload, { idempotencyKey: null });
  assert.equal(missing.error.code, 'VALIDATION_ERROR');
  void seed;
});

test('optimistic concurrency: stale expected_version yields CONFLICT (no silent last-write-wins)', () => {
  const { h, ids } = setup();
  const s = h.store.list('Students', { limit: 1 }).items[0];
  const first = h.call(ids.affairs, 'student.update', { student_id: s.id, nickname: 'หนึ่ง', reason: 'แก้ชื่อเล่น' }, { expectedVersion: s.version });
  assert.equal(first.ok, true);
  const second = h.call(ids.affairs, 'student.update', { student_id: s.id, nickname: 'สอง', reason: 'แก้ชื่อเล่น' }, { expectedVersion: s.version });
  assert.equal(second.error.code, 'CONFLICT');
  assert.equal(second.error.details.current_version, s.version + 1);
  assert.equal(h.store.get('Students', s.id).nickname, 'หนึ่ง');
});

test('separation of duties: staff cannot grant themselves data roles; guardian roles cannot be granted directly', () => {
  const { h, ids } = setup();
  let r = h.call(ids.admin, 'role.grant', { user_id: ids.admin, role: 'STUDENT_AFFAIRS', effective_from: '2026-06-15', reason: 'ทดสอบ' });
  assert.equal(r.error.code, 'FORBIDDEN');
  r = h.call(ids.admin, 'role.grant', { user_id: ids.gate, role: 'GUARDIAN', effective_from: '2026-06-15', reason: 'ทดสอบ' });
  assert.equal(r.error.code, 'VALIDATION_ERROR');
  r = h.call(ids.admin, 'role.grant', { user_id: ids.gate, role: 'DUTY_TEACHER', effective_from: '2026-06-15', reason: 'เพิ่มเวร' });
  assert.equal(r.ok, true);
  r = h.call(ids.affairs, 'role.grant', { user_id: ids.gate, role: 'EXECUTIVE', effective_from: '2026-06-15', reason: 'x' });
  assert.equal(r.error.code, 'FORBIDDEN', 'student affairs has no role.assign');
});

test('disabled account is refused immediately; maintenance mode blocks writes on every path', () => {
  const { h, ids } = setup();
  h.ok(ids.admin, 'user.setStatus', { user_id: ids.gate, status: 'DISABLED', reason: 'ทดสอบระงับ' });
  assert.equal(h.call(ids.gate, 'auth.getCurrentUser').error.code, 'ACCOUNT_DISABLED');
  h.ok(ids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'ซ้อมย้ายข้อมูล' });
  const s = h.store.list('Students', { limit: 1 }).items[0];
  const w = h.call(ids.affairs, 'student.update', { student_id: s.id, nickname: 'x', reason: 'y' });
  assert.equal(w.error.code, 'MAINTENANCE_MODE');
  assert.equal(w.error.retryable, true);
  h.config.systemMode = 'NORMAL'; // dispatcher check bypassed → store must still refuse
  const w2 = h.call(ids.affairs, 'student.update', { student_id: s.id, nickname: 'x', reason: 'y' });
  assert.equal(w2.error.code, 'MAINTENANCE_MODE', 'store-level enforcement');
  assert.equal(h.call(ids.affairs, 'student.search', { q: null }).ok, true, 'reads still work');
});

test('audit rows record actor, operation and redacted diffs; system user exists', () => {
  const { h, ids } = setup();
  const s = h.store.list('Students', { limit: 1 }).items[0];
  h.ok(ids.affairs, 'student.update', { student_id: s.id, nickname: 'ใหม่', reason: 'ตามคำขอผู้ปกครอง' });
  const audit = h.store.list('AuditEvents', { where: { action: 'student.update' }, limit: 5 }).items[0];
  assert.equal(audit.actor_id, ids.affairs);
  assert.equal(audit.reason, 'ตามคำขอผู้ปกครอง');
  assert.deepEqual(audit.after_json, { nickname: 'ใหม่', search_name: audit.after_json.search_name });
  assert.ok(h.store.get('Users', SYSTEM_USER_ID));
  const cl = h.store.list('ChangeLog', { orderBy: [['seq', 'desc']], limit: 1 }).items[0];
  assert.ok(cl.seq > 1 && cl.changes_json.some((c) => c.table === 'Students' && c.op === 'UPDATE'));
});

test('invitation for guardian requires a verified relationship and returns the code once', () => {
  const { h, ids } = setup();
  const g = h.store.list('Guardians', { limit: 20 }).items.find((x) => !h.store.findBy('Users', 'guardian_id', x.id).length);
  const acc = h.ok(ids.affairs, 'guardian.createAccount', { guardian_id: g.id, contact_email: 'parent@example.com' });
  const key = crypto.randomUUID();
  const inv = h.call(ids.affairs, 'invitation.create', { user_id: acc.user_id, bound_email: 'parent@example.com' }, { idempotencyKey: key });
  assert.ok(inv.data.code);
  const replay = h.call(ids.affairs, 'invitation.create', { user_id: acc.user_id, bound_email: 'parent@example.com' }, { idempotencyKey: key });
  assert.equal(replay.meta.replayed, true);
  assert.ok(!replay.data.code, 'code is never stored or replayed');
  const rec = h.store.get('InvitationRecords', inv.data.invitation_id);
  assert.ok(!JSON.stringify(rec).includes(inv.data.code.replace(/-/g, '')), 'only the hash is stored');
  // homeroom teacher of another class cannot invite this guardian
  const link = h.store.findBy('StudentGuardians', 'guardian_id', g.id)[0];
  const enr = h.store.findBy('Enrollments', 'student_id', link.student_id)[0];
  const cls = h.store.get('Classes', enr.class_id);
  const otherTeacher = cls.code === 'M1/1' ? ids.homeroom2 : ids.homeroom1;
  assert.equal(h.call(otherTeacher, 'invitation.create', { user_id: acc.user_id }).error.code, 'FORBIDDEN');
});

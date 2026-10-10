import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, listScope, GRANTS, ACTIONS, rolesFor, isBasicOnly } from '../../src/domain/permissions.js';
import { ENUMS } from '../../src/schema/enums.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CLS_A = 'class-a';
const CLS_B = 'class-b';

const facts = (roles, extra = {}) => ({
  user_id: 'u-1', roles: new Set(roles), homeroomClassIds: new Set(), teachingClassIds: new Set(), guardianLinks: new Map(), selfStudentId: null, ...extra,
});

test('every grant references a known action and role', () => {
  for (const g of GRANTS) {
    assert.ok(ACTIONS[g.action], `unknown action ${g.action}`);
    assert.ok(ENUMS.Role.values.includes(g.role), `unknown role ${g.role}`);
    assert.ok(['SCHOOL', 'SCHOOL_BASIC', 'CLASS', 'LINKED', 'SELF', 'OWN', 'SYSTEM'].includes(g.scope));
  }
  for (const action of Object.keys(ACTIONS)) assert.ok(rolesFor(action).length > 0, `no role holds ${action}`);
});

test('guardian of A cannot read, download or search child B even with tampered payload', () => {
  const g = facts(['GUARDIAN'], { guardianLinks: new Map([[A, new Set(['VIEW_ATTENDANCE', 'SUBMIT_LEAVE'])]]) });
  assert.equal(decide(g, 'student.read', { student_id: A }).allowed, true);
  assert.equal(decide(g, 'student.read', { student_id: B }).allowed, false);
  assert.equal(decide(g, 'attendance.read', { student_id: B }).allowed, false);
  assert.equal(decide(g, 'leave.submit', { student_id: B }).allowed, false);
  assert.equal(decide(g, 'attachment.read', { student_id: A }).allowed, false, 'VIEW_DOCUMENTS not granted on link');
  assert.equal(decide(g, 'leave.confirm_guardian', { student_id: A }).allowed, false, 'CONFIRM_LEAVE not granted on link');
  assert.equal(decide(g, 'student.search', {}).allowed, false, 'guardians cannot search the school');
  const scope = listScope(g, 'student.read');
  assert.deepEqual([...scope.studentIds], [A]);
  assert.equal(scope.all, false);
});

test('duty teacher: basic identification only, no export, no full profile', () => {
  const d = facts(['DUTY_TEACHER']);
  assert.equal(decide(d, 'student.read_basic', { student_id: A }).allowed, true);
  assert.equal(decide(d, 'attendance.record', { student_id: A }).allowed, true);
  assert.equal(decide(d, 'student.read', { student_id: A }).allowed, false);
  assert.equal(decide(d, 'report.export', {}).allowed, false);
  assert.equal(decide(d, 'migration.export', {}).allowed, false);
  assert.equal(decide(d, 'attachment.read_sensitive', { student_id: A, class_ids: [CLS_A] }).allowed, false);
  assert.equal(isBasicOnly(d, { student_id: A }), true);
});

test('system admin: system work without student data unless given another role', () => {
  const s = facts(['SYSTEM_ADMIN']);
  assert.equal(decide(s, 'settings.system', {}).allowed, true);
  assert.equal(decide(s, 'migration.export', {}).allowed, true);
  assert.equal(decide(s, 'student.read', { student_id: A }).allowed, false);
  assert.equal(decide(s, 'attachment.read_sensitive', { student_id: A }).allowed, false);
  assert.equal(listScope(s, 'student.search'), null);
  const both = facts(['SYSTEM_ADMIN', 'STUDENT_AFFAIRS']);
  assert.equal(decide(both, 'student.read', { student_id: A }).allowed, true);
});

test('homeroom teacher limited to own classes by date-specific enrollment', () => {
  const h = facts(['HOMEROOM_TEACHER'], { homeroomClassIds: new Set([CLS_A]) });
  assert.equal(decide(h, 'student.read', { student_id: A, class_ids: [CLS_A] }).allowed, true);
  assert.equal(decide(h, 'student.read', { student_id: B, class_ids: [CLS_B] }).allowed, false);
  assert.equal(decide(h, 'leave.approve', { student_id: B, class_ids: [CLS_B] }).allowed, false);
  assert.equal(decide(h, 'attendance.correct', { student_id: A, class_ids: [CLS_A] }).allowed, true);
  assert.equal(decide(h, 'settings.system', {}).allowed, false);
  assert.deepEqual([...listScope(h, 'student.read').classIds], [CLS_A]);
});

test('subject teacher sees roster/status for taught classes but not sensitive documents or contacts', () => {
  const t = facts(['SUBJECT_TEACHER'], { teachingClassIds: new Set([CLS_A]) });
  assert.equal(decide(t, 'attendance.read', { student_id: A, class_ids: [CLS_A] }).allowed, true);
  assert.equal(decide(t, 'attachment.read_sensitive', { student_id: A, class_ids: [CLS_A] }).allowed, false);
  assert.equal(decide(t, 'guardian.read_contact', { student_id: A, class_ids: [CLS_A] }).allowed, false);
});

test('student self only; cannot approve or read others', () => {
  const st = facts(['STUDENT'], { selfStudentId: A });
  assert.equal(decide(st, 'attendance.read', { student_id: A }).allowed, true);
  assert.equal(decide(st, 'attendance.read', { student_id: B }).allowed, false);
  assert.equal(decide(st, 'leave.approve', { student_id: A }).allowed, false);
  assert.equal(decide(st, 'leave.withdraw', { owner_user_id: 'u-1' }).allowed, true);
  assert.equal(decide(st, 'leave.withdraw', { owner_user_id: 'someone-else' }).allowed, false);
});

test('executive has overview but no retroactive correction rights', () => {
  const e = facts(['EXECUTIVE']);
  assert.equal(decide(e, 'report.view', {}).allowed, true);
  assert.equal(decide(e, 'attendance.correct', { student_id: A }).allowed, false);
  assert.equal(decide(e, 'leave.approve', { student_id: A }).allowed, false);
});

test('unknown action and empty role set are denied', () => {
  assert.equal(decide(facts(['STUDENT_AFFAIRS']), 'everything.do', {}).allowed, false);
  assert.equal(decide(facts([]), 'self.read', { owner_user_id: 'u-1' }).allowed, false);
});

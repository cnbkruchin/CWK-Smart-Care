import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLeaveSubmission, planSchoolDecision, segmentsOverlap, resolveRoute, statusFromSegments } from '../../src/domain/leave.js';
import { projectDailyAttendance, activeEvents, projectionChanged } from '../../src/domain/attendance.js';
import { findEffectiveEnrollment, rosterForClass, planEnrollmentChange, findOverlap } from '../../src/domain/enrollment.js';
import { assertTransition } from '../../src/domain/state-machines.js';
import { dayInfo, periodsFor } from '../../src/domain/calendar.js';
import { TERMS, CALENDAR, PERIODS, LATENESS, ROUTING, S1, S2, C1, C2, CLASSES, ENROLLMENTS, bkk } from '../fixtures/domain-fixtures.mjs';

const base = {
  studentId: S1, leaveType: 'SICK', requesterType: 'GUARDIAN', today: '2026-10-05', enrollments: ENROLLMENTS, classesById: CLASSES,
  terms: TERMS, calendarEntries: CALENDAR, periods: PERIODS, routingRule: ROUTING, existingSegments: [],
};

test('leave: rejects non-school days; counts full/half/period units separately', () => {
  assert.throws(() => planLeaveSubmission({ ...base, days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }, { school_date: '2026-10-07', unit: 'FULL_DAY' }] }),
    (e) => e.code === 'VALIDATION_ERROR' && e.fieldErrors.some((f) => f.code === 'NOT_SCHOOL_DAY'));
  const p = planLeaveSubmission({ ...base, days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }, { school_date: '2026-10-08', unit: 'HALF_DAY_PM' }, { school_date: '2026-10-09', unit: 'PERIODS', periods: [2, 1] }] });
  assert.deepEqual(p.counts, { school_days_count: 3, full_day_count: 1, half_day_count: 1, period_count: 2 });
  assert.equal(p.start_date, '2026-10-06');
  assert.equal(p.end_date, '2026-10-10');
  assert.deepEqual(p.segments[2].periods, [1, 2]);
  assert.equal(p.status, 'PENDING_SCHOOL', 'guardian requester does not need separate guardian confirmation');
  assert.equal(p.guardian_status, 'CONFIRMED');
  assert.equal(p.approver_role, 'HOMEROOM_TEACHER');
  assert.equal(p.attachment_required, true, 'SICK >= 3 school days requires attachment (example rule)');
});

test('leave: student requester requires guardian confirmation (separate step)', () => {
  const p = planLeaveSubmission({ ...base, requesterType: 'STUDENT', days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }] });
  assert.equal(p.status, 'PENDING_GUARDIAN');
  assert.equal(p.guardian_status, 'PENDING');
  assert.equal(p.school_status, 'NOT_STARTED');
});

test('leave: overlap rules — AM vs PM ok, AM vs period 2 overlaps, full day overlaps all', () => {
  const pod = periodsFor({ periods: PERIODS, date: '2026-10-06' });
  const seg = (unit, periods = null) => ({ school_date: '2026-10-06', unit, periods });
  assert.equal(segmentsOverlap(seg('HALF_DAY_AM'), seg('HALF_DAY_PM'), pod), false);
  assert.equal(segmentsOverlap(seg('HALF_DAY_AM'), seg('PERIODS', [2]), pod), true);
  assert.equal(segmentsOverlap(seg('HALF_DAY_PM'), seg('PERIODS', [2]), pod), false);
  assert.equal(segmentsOverlap(seg('FULL_DAY'), seg('PERIODS', [7]), pod), true);
  assert.throws(() => planLeaveSubmission({ ...base, existingSegments: [{ ...seg('HALF_DAY_AM'), status: 'APPROVED' }], days: [{ school_date: '2026-10-06', unit: 'PERIODS', periods: [3] }] }),
    (e) => e.fieldErrors.some((f) => f.code === 'OVERLAP'));
  // withdrawn/rejected segments do not block
  const ok = planLeaveSubmission({ ...base, existingSegments: [{ ...seg('FULL_DAY'), status: 'REJECTED' }], days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }] });
  assert.equal(ok.segments.length, 1);
});

test('leave: retroactive requires reason and respects window; enrollment required', () => {
  assert.throws(() => planLeaveSubmission({ ...base, today: '2026-10-09', days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }] }), (e) => e.fieldErrors.some((f) => f.field === 'retroactive_reason'));
  const p = planLeaveSubmission({ ...base, today: '2026-10-09', retroactiveReason: 'ป่วยกะทันหัน', days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }] });
  assert.equal(p.is_retroactive, true);
  assert.throws(() => planLeaveSubmission({ ...base, today: '2026-10-30', retroactiveReason: 'x', days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }] }), (e) => e.code === 'FORBIDDEN');
  const sa = planLeaveSubmission({ ...base, today: '2026-10-30', retroactiveReason: 'x', requesterRoles: new Set(['STUDENT_AFFAIRS']), requesterType: 'STAFF', days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }] });
  assert.equal(sa.guardian_status, 'NOT_REQUIRED');
  assert.throws(() => planLeaveSubmission({ ...base, studentId: '99999999-9999-4999-8999-999999999999', days: [{ school_date: '2026-10-06', unit: 'FULL_DAY' }] }), (e) => e.fieldErrors.some((f) => f.code === 'NOT_ENROLLED'));
});

test('leave: routing first match; long leave goes to STUDENT_AFFAIRS; activity separate', () => {
  const r = ROUTING.params_json;
  assert.equal(resolveRoute(r, { leaveType: 'SICK', schoolDaysCount: 2 }), 'HOMEROOM_TEACHER');
  assert.equal(resolveRoute(r, { leaveType: 'SICK', schoolDaysCount: 5 }), 'STUDENT_AFFAIRS');
  assert.equal(resolveRoute(r, { leaveType: 'SCHOOL_ACTIVITY', schoolDaysCount: 1 }), 'STUDENT_AFFAIRS');
});

test('leave: school decision transitions incl. partial approval and invalid transitions', () => {
  const req = { status: 'PENDING_SCHOOL' };
  const segs = [{ id: 'a', status: 'REQUESTED' }, { id: 'b', status: 'REQUESTED' }];
  const full = planSchoolDecision({ request: req, segments: segs, decision: 'APPROVED' });
  assert.equal(full.to_status, 'APPROVED');
  assert.deepEqual(full.segment_updates.map((s) => s.status), ['APPROVED', 'APPROVED']);
  const part = planSchoolDecision({ request: req, segments: segs, decision: 'PARTIALLY_APPROVED', segmentDecisions: { a: 'APPROVED', b: 'REJECTED' }, comment: 'วันที่สองไม่มีหลักฐาน' });
  assert.equal(part.to_status, 'PARTIALLY_APPROVED');
  assert.throws(() => planSchoolDecision({ request: req, segments: segs, decision: 'REJECTED' }), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => planSchoolDecision({ request: { status: 'PENDING_GUARDIAN' }, segments: segs, decision: 'APPROVED' }), (e) => e.code === 'INVALID_STATE');
  assert.throws(() => assertTransition('Leave', 'WITHDRAWN', 'APPROVE'), (e) => e.code === 'INVALID_STATE' && Array.isArray(e.details.allowed_transitions));
  assert.equal(statusFromSegments([{ status: 'APPROVED' }, { status: 'REJECTED' }, { status: 'WITHDRAWN' }]), 'PARTIALLY_APPROVED');
});

test('enrollment: mid-term class change keeps history; overlap detected', () => {
  const enr = [{ id: 'e1', student_id: S1, class_id: C1, effective_from: '2026-05-18', effective_to: null }];
  const plan = planEnrollmentChange({ enrollments: enr, studentId: S1, effectiveDate: '2026-08-01', newClassId: C2, reason: 'CLASS_CHANGE' });
  assert.equal(plan.close.effective_to, '2026-08-01');
  assert.equal(plan.open.effective_from, '2026-08-01');
  const after = [plan.close, { ...plan.open, id: 'e2' }];
  assert.equal(findEffectiveEnrollment(after, S1, '2026-07-31').class_id, C1, 'report for past date shows old class');
  assert.equal(findEffectiveEnrollment(after, S1, '2026-08-01').class_id, C2);
  assert.equal(rosterForClass(after, C1, '2026-08-01').length, 0, 'denominator excludes moved student after effective date');
  assert.ok(findOverlap(after, { id: 'x', student_id: S1, effective_from: '2026-07-01', effective_to: '2026-07-15' }));
  const exit = planEnrollmentChange({ enrollments: after, studentId: S1, effectiveDate: '2026-09-01', reason: 'TRANSFER_OUT' });
  assert.equal(exit.open, null);
});

// ───────── projection ─────────
const day = '2026-10-06';
const pod = periodsFor({ periods: PERIODS, date: day });
const enr = ENROLLMENTS[0];
const ev = (o) => ({ id: o.id, student_id: S1, school_date: day, recorded_at: o.occurred_at, supersedes_event_id: null, actor_id: 'u', ...o });
const project = (over = {}) => projectDailyAttendance({
  studentId: S1, schoolDate: day, enrollment: enr, gradeLevel: 'M1', dayInfo: dayInfo({ date: day, terms: TERMS, calendarEntries: CALENDAR }),
  events: [], rollCallSession: null, leaveSegments: [], periodsOfDay: pod, latenessRule: LATENESS, tz: 'Asia/Bangkok', now: '2026-10-06T05:00:00.000Z', ...over,
});

test('projection: no evidence is UNKNOWN, never absent', () => {
  const p = project();
  assert.equal(p.presence_status, 'UNKNOWN');
  assert.equal(p.confirmed_absence, false);
  assert.equal(p.roll_call_mark, 'NOT_MARKED');
});

test('projection: late gate arrival counts once even with duplicate scans; roll call default present', () => {
  const a1 = ev({ id: 'a1', event_type: 'GATE_ARRIVAL', occurred_at: bkk(day, '08:10:00') });
  const p = project({ events: [a1] });
  assert.equal(p.presence_status, 'PRESENT');
  assert.equal(p.is_late, true);
  assert.equal(p.late_minutes, 10);
  assert.equal(p.late_counted, true);
  const session = { id: 'rc1', class_id: C1, status: 'SUBMITTED' };
  const p2 = project({ events: [], rollCallSession: session });
  assert.equal(p2.presence_status, 'PRESENT');
  assert.equal(p2.roll_call_mark, 'PRESENT');
  assert.equal(p2.verification_level, 'ROLL_CALL');
});

test('projection: mixed day — late morning + approved afternoon leave', () => {
  const a1 = ev({ id: 'a1', event_type: 'GATE_ARRIVAL', occurred_at: bkk(day, '08:20:00') });
  const seg = { id: 'sg1', leave_request_id: 'lr1', school_date: day, unit: 'HALF_DAY_PM', periods: null, status: 'APPROVED', request_status: 'APPROVED' };
  const p = project({ events: [a1], leaveSegments: [seg] });
  assert.equal(p.presence_status, 'PRESENT');
  assert.equal(p.late_counted, true);
  assert.equal(p.partial_leave, true);
  assert.equal(p.full_day_leave, false);
  assert.equal(p.leave_units, 'PM');
  assert.equal(p.has_conflict, false);
});

test('projection: approved morning leave + afternoon arrival is not counted late', () => {
  const a1 = ev({ id: 'a1', event_type: 'GATE_ARRIVAL', occurred_at: bkk(day, '12:30:00') });
  const seg = { id: 'sg1', leave_request_id: 'lr1', school_date: day, unit: 'HALF_DAY_AM', status: 'APPROVED', request_status: 'APPROVED' };
  const p = project({ events: [a1], leaveSegments: [seg] });
  assert.equal(p.is_late, true);
  assert.equal(p.late_counted, false);
  assert.equal(p.evidence_refs.late_not_counted_reason, 'LEAVE_COVERS_ARRIVAL');
});

test('projection: full-day leave + presence keeps approval and raises conflict', () => {
  const a1 = ev({ id: 'a1', event_type: 'GATE_ARRIVAL', occurred_at: bkk(day, '07:40:00') });
  const seg = { id: 'sg1', leave_request_id: 'lr1', school_date: day, unit: 'FULL_DAY', status: 'APPROVED', request_status: 'APPROVED' };
  const p = project({ events: [a1], leaveSegments: [seg] });
  assert.equal(p.presence_status, 'PRESENT');
  assert.equal(p.full_day_leave, true);
  assert.deepEqual(p.leave_request_ids, ['lr1']);
  assert.ok(p.conflicts.some((c) => c.type === 'CONFLICT_LEAVE_PRESENCE'));
  const p2 = project({ leaveSegments: [seg] });
  assert.equal(p2.presence_status, 'ON_LEAVE_FULL_DAY');
  const pending = project({ leaveSegments: [{ ...seg, status: 'REQUESTED', request_status: 'PENDING_SCHOOL' }] });
  assert.equal(pending.presence_status, 'UNKNOWN', 'pending leave is not approved leave');
});

test('projection: roll call absent stays UNKNOWN until verified; then ABSENT_CONFIRMED; correction supersedes', () => {
  const session = { id: 'rc1', class_id: C1, status: 'SUBMITTED' };
  const abs = ev({ id: 'r1', event_type: 'ROLL_CALL_ABSENT', occurred_at: bkk(day, '08:30:00'), roll_call_session_id: 'rc1' });
  assert.equal(project({ events: [abs], rollCallSession: session }).presence_status, 'UNKNOWN');
  const conf = ev({ id: 'x1', event_type: 'ABSENCE_CONFIRMED', occurred_at: bkk(day, '10:05:00') });
  const p = project({ events: [abs, conf], rollCallSession: session });
  assert.equal(p.presence_status, 'ABSENT_CONFIRMED');
  assert.equal(p.verification_level, 'VERIFIED');
  // correction: void the absence confirmation and add presence
  const voidConf = ev({ id: 'v1', event_type: 'EVENT_VOIDED', occurred_at: bkk(day, '11:00:00'), supersedes_event_id: 'x1' });
  const present = ev({ id: 'r2', event_type: 'ROLL_CALL_PRESENT', occurred_at: bkk(day, '11:00:00'), supersedes_event_id: 'r1' });
  const fixed = project({ events: [abs, conf, voidConf, present], rollCallSession: session });
  assert.equal(fixed.presence_status, 'PRESENT');
  assert.deepEqual(activeEvents([abs, conf, voidConf, present]).map((e) => e.id).sort(), ['r2']);
});

test('projection: gate record vs roll call absent conflict; exemption not counted; ineligible/non-school days', () => {
  const a1 = ev({ id: 'a1', event_type: 'GATE_ARRIVAL', occurred_at: bkk(day, '08:40:00') });
  const abs = ev({ id: 'r1', event_type: 'ROLL_CALL_ABSENT', occurred_at: bkk(day, '08:30:00') });
  const p = project({ events: [a1, abs], rollCallSession: { id: 'rc1', class_id: C1, status: 'SUBMITTED' } });
  assert.ok(p.conflicts.some((c) => c.type === 'CONFLICT_ROLLCALL_GATE'));
  const ex = ev({ id: 'x', event_type: 'LATENESS_EXEMPTED', occurred_at: bkk(day, '09:00:00'), reason_code: 'BUS_DELAY' });
  const p2 = project({ events: [a1, ex] });
  assert.equal(p2.is_late, true);
  assert.equal(p2.lateness_exempted, true);
  assert.equal(p2.late_counted, false);
  assert.equal(project({ enrollment: null }).presence_status, 'NOT_ELIGIBLE');
  assert.equal(project({ schoolDate: '2026-10-07', dayInfo: dayInfo({ date: '2026-10-07', terms: TERMS, calendarEntries: CALENDAR }) }).presence_status, 'NON_SCHOOL_DAY');
  assert.equal(projectionChanged(p2, { ...p2, computed_at: 'later' }), false);
  assert.equal(projectionChanged(p2, { ...p2, late_counted: true }), true);
});

test('projection is deterministic for identical inputs (cross-platform IDs)', () => {
  const a = project();
  const b = project();
  assert.deepEqual(a, b);
  assert.notEqual(project({ studentId: S2 }).id, a.id);
});

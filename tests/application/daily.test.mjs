// Daily workflows on the memory adapter: gate, roll call, verification, leave, corrections, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeHarness } from '../helpers/app-harness.mjs';
import { deterministicId } from '../../src/shared/uuid.js';

// 2026-06-15 is a Monday inside demo term AY2026-T1; example lateness rule: cutoff 08:00, grace 0.
const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();

function setup(now = BKK('2026-06-15', '07:30')) {
  const h = makeHarness({ now });
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  const station = h.store.list('Stations', { limit: 1 }).items[0];
  const classes = h.store.list('Classes', { limit: 10, orderBy: [['code', 'asc']] }).items;
  const roster = (cid) => h.store.findBy('Enrollments', 'class_id', cid).map((e) => e.student_id);
  return { h, seed, ids, station, c1: classes[0], c2: classes[1], roster };
}

const projection = (h, sid, date) => h.store.get('DailyAttendance', deterministicId.dailyAttendance(sid, date));

test('gate: before/at/after cutoff uses server time; duplicate scans return the original record', () => {
  const { h, ids, station, c1, roster } = setup(BKK('2026-06-15', '07:59'));
  const [s1, s2] = roster(c1.id);
  const r1 = h.ok(ids.duty, 'attendance.recordArrival', { student_id: s1, station_id: station.id, source: 'SCAN_KEYBOARD' });
  assert.equal(r1.is_late, false);
  h.clock.set(BKK('2026-06-15', '08:00'));
  assert.equal(h.ok(ids.duty, 'attendance.recordArrival', { student_id: s2, station_id: station.id, source: 'SEARCH_CODE' }).is_late, false, 'exactly at cutoff is on time');
  h.clock.set(BKK('2026-06-15', '08:07'));
  const s3 = roster(c1.id)[2];
  const late = h.ok(ids.gate, 'attendance.recordArrival', { student_id: s3, station_id: station.id, source: 'SCAN_KEYBOARD' });
  assert.deepEqual([late.is_late, late.late_minutes, late.late_counted], [true, 7, true]);
  const again = h.ok(ids.duty, 'attendance.recordArrival', { student_id: s3, station_id: station.id, source: 'SCAN_CAMERA' });
  assert.equal(again.duplicate, true);
  assert.equal(again.event_id, late.event_id);
  const events = h.store.findBy('AttendanceEvents', 'student_id', s3);
  assert.equal(events.length, 1, 'no second arrival event');
  const p = projection(h, s3, '2026-06-15');
  assert.equal(p.presence_status, 'PRESENT');
  assert.equal(p.late_counted, true);
  // the client is told that gate recording is not classroom entry
  assert.match(late.note_th, /ไม่ใช่หลักฐานว่าเข้าห้องเรียน/);
});

test('gate: same idempotency key from two stations replays; late arrival notifies guardian via outbox (not sent yet)', () => {
  const { h, ids, station, c1, roster, seed } = setup(BKK('2026-06-15', '08:20'));
  const g = seed.guardian_users[0];
  const key = crypto.randomUUID();
  const a = h.call(ids.duty, 'attendance.recordArrival', { student_id: g.student_id, station_id: station.id, source: 'SCAN_KEYBOARD' }, { idempotencyKey: key });
  const b = h.call(ids.duty, 'attendance.recordArrival', { student_id: g.student_id, station_id: station.id, source: 'SCAN_KEYBOARD' }, { idempotencyKey: key });
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.meta.replayed, true);
  const notif = h.store.list('Notifications', { where: { notification_type: 'LATE_CONFIRMED' }, limit: 5 }).items;
  assert.equal(notif.length, 1);
  const rec = h.store.findBy('NotificationRecipients', 'notification_id', notif[0].id);
  assert.deepEqual(rec.map((r) => r.recipient_user_id), [g.user_id]);
  const out = h.store.findBy('NotificationOutbox', 'notification_id', notif[0].id);
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, 'EMAIL');
  assert.equal(out[0].delivery_state, 'QUEUED');
  void c1; void roster;
});

test('gate: manual time needs a reason and cannot be in the future or another day; queue time keeps provenance', () => {
  const { h, ids, station, c1, roster } = setup(BKK('2026-06-15', '08:10'));
  const [s1, s2] = roster(c1.id);
  let r = h.call(ids.duty, 'attendance.recordArrival', { student_id: s1, station_id: station.id, source: 'MANUAL_TIME', arrived_at: BKK('2026-06-15', '07:55') });
  assert.equal(r.error.field_errors[0].field, 'reason_text');
  r = h.call(ids.duty, 'attendance.recordArrival', { student_id: s1, station_id: station.id, source: 'MANUAL_TIME', arrived_at: BKK('2026-06-15', '08:30'), reason_text: 'x' });
  assert.equal(r.error.field_errors[0].code, 'FUTURE');
  const q = h.ok(ids.duty, 'attendance.recordArrival', { student_id: s2, station_id: station.id, source: 'QUEUE_BATCH', arrived_at: BKK('2026-06-15', '07:59') });
  assert.equal(q.is_late, false, 'queue processing time does not add a penalty');
  const ev = h.store.get('AttendanceEvents', q.event_id);
  assert.equal(ev.source, 'QUEUE_BATCH');
  assert.ok(ev.recorded_at > ev.occurred_at);
});

test('missing data is UNKNOWN; roll call default present; absent mark stays UNKNOWN until teacher verification', () => {
  const { h, ids, c1, roster, seed } = setup(BKK('2026-06-15', '08:40'));
  const students = roster(c1.id);
  const g = seed.guardian_users.find((x) => students.includes(x.student_id));
  const view0 = h.ok(ids.homeroom1, 'attendance.classDay', { class_id: c1.id, school_date: '2026-06-15' });
  assert.ok(view0.items.every((i) => i.presence_status === 'UNKNOWN'), 'no scan ≠ absent');
  const absent = g.student_id;
  const res = h.ok(ids.homeroom1, 'rollcall.submit', { class_id: c1.id, school_date: '2026-06-15', marks: [{ student_id: absent, mark: 'ABSENT' }] });
  assert.equal(res.ABSENT, 1);
  const view1 = h.ok(ids.homeroom1, 'attendance.classDay', { class_id: c1.id, school_date: '2026-06-15' });
  assert.equal(view1.items.filter((i) => i.presence_status === 'PRESENT').length, students.length - 1);
  assert.equal(view1.items.find((i) => i.student.id === absent).presence_status, 'UNKNOWN');
  assert.equal(h.store.list('Notifications', { where: { notification_type: 'ABSENCE_CONFIRMED' }, limit: 5 }).items.length, 0, 'no "absent" message before verification');
  assert.equal(h.call(ids.homeroom2, 'attendance.verifyDay', { class_id: c1.id, school_date: '2026-06-15', confirm_absent_student_ids: [absent] }).error.code, 'FORBIDDEN');
  const v = h.ok(ids.homeroom1, 'attendance.verifyDay', { class_id: c1.id, school_date: '2026-06-15', confirm_absent_student_ids: [absent, students[0] === absent ? students[1] : students[0]] });
  assert.equal(v.confirmed.length, 1);
  assert.equal(v.refused.length, 1, 'present student cannot be confirmed absent');
  assert.equal(projection(h, absent, '2026-06-15').presence_status, 'ABSENT_CONFIRMED');
  const n = h.store.list('Notifications', { where: { notification_type: 'ABSENCE_CONFIRMED' }, limit: 5 }).items;
  assert.equal(n.length, 1);
  assert.equal(h.store.findBy('NotificationRecipients', 'notification_id', n[0].id)[0].ack_state, 'PENDING_ACK');
});

test('mixed day: late morning + approved afternoon leave counts once; dashboard does not double count', () => {
  const { h, ids, station, c1, roster, seed } = setup(BKK('2026-06-15', '07:00'));
  // periods are seeded (7 periods, AM 1-4)
  const g = seed.guardian_users.find((x) => roster(c1.id).includes(x.student_id));
  const sub = h.ok(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'PERSONAL', reason: 'ไปทำธุระกับครอบครัว', days: [{ school_date: '2026-06-15', unit: 'HALF_DAY_PM' }] });
  assert.equal(sub.status, 'PENDING_SCHOOL', 'guardian-submitted leave needs no separate guardian confirmation');
  h.ok(ids.homeroom1, 'leave.decide', { leave_request_id: sub.leave_request_id, decision: 'APPROVED' }, { expectedVersion: sub.version });
  h.clock.set(BKK('2026-06-15', '08:15'));
  const arr = h.ok(ids.duty, 'attendance.recordArrival', { student_id: g.student_id, station_id: station.id, source: 'SCAN_KEYBOARD' });
  assert.equal(arr.late_counted, true);
  const p = projection(h, g.student_id, '2026-06-15');
  assert.deepEqual([p.presence_status, p.partial_leave, p.full_day_leave, p.leave_units, p.has_conflict], ['PRESENT', true, false, 'PM', false]);
  const dash = h.ok(ids.homeroom1, 'dashboard.summary', { school_date: '2026-06-15' });
  assert.equal(dash.totals.school_days, roster(c1.id).length);
  assert.equal(dash.totals.present, 1);
  assert.equal(dash.totals.late_counted, 1, 'late is a subset of present, not added');
  assert.equal(dash.totals.partial_leave, 1);
  assert.equal(dash.totals.unknown, roster(c1.id).length - 1);
});

test('leave: student request needs guardian confirmation first; approvals are separate steps; conflicts are controlled', () => {
  const { h, ids, c1, roster, seed } = setup();
  const studentUser = h.store.list('Users', { where: { user_type: 'STUDENT' }, limit: 1 }).items[0];
  const sub = h.ok(studentUser.id, 'leave.submit', { student_id: studentUser.student_id, leave_type: 'SICK', reason: 'ไม่สบาย', days: [{ school_date: '2026-06-16', unit: 'FULL_DAY' }] });
  assert.equal(sub.status, 'PENDING_GUARDIAN');
  const early = h.call(ids.homeroom1, 'leave.decide', { leave_request_id: sub.leave_request_id, decision: 'APPROVED' });
  assert.equal(early.error.code, 'INVALID_STATE', 'school cannot approve before guardian confirmation');
  const guardian = seed.guardian_users.find((g) => g.student_id === studentUser.student_id);
  const conf = h.ok(guardian.user_id, 'leave.confirmGuardian', { leave_request_id: sub.leave_request_id, decision: 'CONFIRMED' });
  assert.equal(conf.status, 'PENDING_SCHOOL');
  const req = h.store.get('LeaveRequests', sub.leave_request_id);
  assert.deepEqual([req.guardian_confirmation_status, req.school_approval_status], ['CONFIRMED', 'PENDING']);
  // two approvers act on the same version: second gets CONFLICT
  const a = h.call(ids.homeroom1, 'leave.decide', { leave_request_id: req.id, decision: 'APPROVED' }, { expectedVersion: req.version });
  const b = h.call(ids.affairs, 'leave.decide', { leave_request_id: req.id, decision: 'REJECTED', comment: 'ไม่มีหลักฐาน' }, { expectedVersion: req.version });
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.error.code, 'CONFLICT');
  const approvals = h.store.findBy('LeaveApprovals', 'leave_request_id', req.id).map((x) => x.step_type).sort();
  assert.deepEqual(approvals, ['GUARDIAN_CONFIRMATION', 'SCHOOL_APPROVAL']);
  const revisions = h.store.findBy('LeaveRevisions', 'leave_request_id', req.id).map((r) => r.action);
  assert.deepEqual(revisions.sort(), ['APPROVE', 'GUARDIAN_CONFIRM', 'SUBMIT']);
  // overlapping second request is rejected
  const dup = h.call(guardian.user_id, 'leave.submit', { student_id: studentUser.student_id, leave_type: 'PERSONAL', reason: 'ซ้ำ', days: [{ school_date: '2026-06-16', unit: 'HALF_DAY_AM' }] });
  assert.equal(dup.error.field_errors[0].code, 'OVERLAP');
  void c1; void roster;
});

test('leave: retroactive approval re-evaluates past days; cancelling restores; withdraw; other class teacher cannot approve', () => {
  const { h, ids, station, c1, roster, seed } = setup(BKK('2026-06-12', '08:30'));
  const g = seed.guardian_users.find((x) => roster(c1.id).includes(x.student_id));
  // Friday: nobody recorded the student; Monday the guardian files retroactive sick leave
  h.ok(ids.homeroom1, 'rollcall.submit', { class_id: c1.id, school_date: '2026-06-12', marks: [{ student_id: g.student_id, mark: 'ABSENT' }] });
  h.clock.set(BKK('2026-06-15', '09:00'));
  let r = h.call(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'SICK', reason: 'ป่วย', days: [{ school_date: '2026-06-12', unit: 'FULL_DAY' }] });
  assert.equal(r.error.field_errors[0].field, 'retroactive_reason');
  const sub = h.ok(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'SICK', reason: 'ป่วย', retroactive_reason: 'ไปโรงพยาบาลกะทันหัน', days: [{ school_date: '2026-06-12', unit: 'FULL_DAY' }] });
  assert.equal(h.call(ids.homeroom2, 'leave.decide', { leave_request_id: sub.leave_request_id, decision: 'APPROVED' }).error.code, 'FORBIDDEN');
  h.ok(ids.homeroom1, 'leave.decide', { leave_request_id: sub.leave_request_id, decision: 'APPROVED' });
  assert.equal(projection(h, g.student_id, '2026-06-12').presence_status, 'ON_LEAVE_FULL_DAY');
  const cancel = h.ok(ids.affairs, 'leave.decideCancel', { leave_request_id: sub.leave_request_id, approve: true, reason: 'ยื่นผิดวัน' });
  assert.equal(cancel.status, 'CANCELLED');
  assert.equal(projection(h, g.student_id, '2026-06-12').presence_status, 'UNKNOWN', 'roll call absent again pending verification');
  const w = h.ok(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'PERSONAL', reason: 'ธุระ', days: [{ school_date: '2026-06-17', unit: 'FULL_DAY' }] });
  assert.equal(h.ok(g.user_id, 'leave.withdraw', { leave_request_id: w.leave_request_id }).status, 'WITHDRAWN');
  void station;
});

test('full-day approved leave + actual arrival keeps the approval and opens a reconciliation task', () => {
  const { h, ids, station, c1, roster, seed } = setup(BKK('2026-06-15', '07:00'));
  const g = seed.guardian_users.find((x) => roster(c1.id).includes(x.student_id));
  const sub = h.ok(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'PERSONAL', reason: 'ธุระ', days: [{ school_date: '2026-06-15', unit: 'FULL_DAY' }] });
  h.ok(ids.homeroom1, 'leave.decide', { leave_request_id: sub.leave_request_id, decision: 'APPROVED' });
  h.clock.set(BKK('2026-06-15', '07:45'));
  h.ok(ids.duty, 'attendance.recordArrival', { student_id: g.student_id, station_id: station.id, source: 'SCAN_KEYBOARD' });
  const p = projection(h, g.student_id, '2026-06-15');
  assert.deepEqual([p.presence_status, p.full_day_leave, p.has_conflict], ['PRESENT', true, true]);
  assert.equal(h.store.get('LeaveRequests', sub.leave_request_id).status, 'APPROVED', 'approval is never deleted');
  const tasks = h.ok(ids.homeroom1, 'reconciliation.list', {}).items;
  assert.ok(tasks.some((t) => t.task_type === 'CONFLICT_LEAVE_PRESENCE' && t.student_id === g.student_id));
});

test('correction: amend arrival time changes lateness, keeps history, audits and notifies only when a confirmed fact changes', () => {
  const { h, ids, station, c1, roster, seed } = setup(BKK('2026-06-15', '08:25'));
  const g = seed.guardian_users.find((x) => roster(c1.id).includes(x.student_id));
  const arr = h.ok(ids.duty, 'attendance.recordArrival', { student_id: g.student_id, station_id: station.id, source: 'SCAN_KEYBOARD' });
  assert.equal(arr.late_counted, true);
  h.clock.set(BKK('2026-06-16', '09:00'));
  const bad = h.call(ids.homeroom1, 'attendance.correct', { student_id: g.student_id, school_date: '2026-06-15', correction_type: 'AMEND_ARRIVAL_TIME', new_arrived_at: BKK('2026-06-15', '07:50'), reason: 'x' });
  assert.equal(bad.error.code, 'VALIDATION_ERROR', 'reason too short');
  const c = h.ok(ids.homeroom1, 'attendance.correct', { student_id: g.student_id, school_date: '2026-06-15', correction_type: 'AMEND_ARRIVAL_TIME', new_arrived_at: BKK('2026-06-15', '07:50'), reason: 'รถโรงเรียนมาส่งก่อน 8 โมง ครูเวรสแกนช้า' });
  assert.equal(c.before.late_counted, true);
  assert.equal(c.after.late_counted, false);
  const events = h.store.findBy('AttendanceEvents', 'student_id', g.student_id);
  assert.equal(events.length, 2, 'original arrival kept; new event supersedes it');
  assert.ok(events.some((e) => e.supersedes_event_id === arr.event_id));
  assert.equal(h.store.list('Notifications', { where: { notification_type: 'DATA_CORRECTED' }, limit: 5 }).items.length, 1);
  assert.ok(h.store.list('AuditEvents', { where: { action: 'attendance.correct' }, limit: 5 }).items[0].reason.includes('รถโรงเรียน'));
  assert.equal(h.call(ids.exec, 'attendance.correct', { student_id: g.student_id, school_date: '2026-06-15', correction_type: 'EXEMPT_LATENESS', reason: 'ผู้บริหารแก้เอง' }).error.code, 'FORBIDDEN');
});

test('correction request from a guardian opens a review task; the decision applies it and closes the task', () => {
  const { h, ids, station, c1, roster, seed } = setup(BKK('2026-06-15', '08:25'));
  const g = seed.guardian_users.find((x) => roster(c1.id).includes(x.student_id));
  h.ok(ids.duty, 'attendance.recordArrival', { student_id: g.student_id, station_id: station.id, source: 'SCAN_KEYBOARD' });
  h.clock.set(BKK('2026-06-15', '17:00'));
  const req = h.ok(g.user_id, 'attendance.requestCorrection', { student_id: g.student_id, school_date: '2026-06-15', correction_type: 'AMEND_ARRIVAL_TIME', requested_text: 'ลูกมาถึง 07:55 พร้อมรถโรงเรียน' });
  const tasks = h.ok(ids.homeroom1, 'reconciliation.list', { class_id: c1.id }).items.filter((t) => t.evidence_refs && t.evidence_refs.correction_id === req.correction_id);
  assert.equal(tasks.length, 1);
  assert.equal(h.call(g.user_id, 'attendance.decideCorrection', { correction_id: req.correction_id, decision: 'REJECT', decision_note: 'ไม่ได้' }).error.code, 'FORBIDDEN');
  const d = h.ok(ids.homeroom1, 'attendance.decideCorrection', { correction_id: req.correction_id, decision: 'APPLY', decision_note: 'ตรวจกล้องแล้ว', new_arrived_at: BKK('2026-06-15', '07:55') });
  assert.deepEqual([d.before.late_counted, d.after.late_counted], [true, false]);
  assert.equal(h.store.get('ReconciliationTasks', tasks[0].id).status, 'RESOLVED');
  assert.equal(h.store.get('AttendanceCorrections', req.correction_id).status, 'APPLIED');
  assert.equal(h.call(ids.homeroom1, 'attendance.decideCorrection', { correction_id: req.correction_id, decision: 'REJECT', decision_note: 'ซ้ำ' }).error.code, 'INVALID_STATE');
});

test('exemption (bus delay) shows the real late arrival but does not count it', () => {
  const { h, ids, station, c1, roster } = setup(BKK('2026-06-15', '08:30'));
  const [s1, s2] = roster(c1.id);
  h.ok(ids.duty, 'attendance.recordArrival', { student_id: s1, station_id: station.id, source: 'SCAN_KEYBOARD' });
  h.ok(ids.duty, 'attendance.recordArrival', { student_id: s2, station_id: station.id, source: 'SCAN_KEYBOARD' });
  assert.equal(h.call(ids.duty, 'attendance.exempt', { school_date: '2026-06-15', student_ids: [s1], reason_code: 'TRANSPORT_DELAY', reason_text: 'รถรับส่งสายเหนือเสีย' }).error.code, 'FORBIDDEN');
  h.ok(ids.affairs, 'attendance.exempt', { school_date: '2026-06-15', student_ids: [s1], reason_code: 'TRANSPORT_DELAY', reason_text: 'รถรับส่งสายเหนือเสีย' });
  const p1 = projection(h, s1, '2026-06-15');
  const p2 = projection(h, s2, '2026-06-15');
  assert.deepEqual([p1.is_late, p1.lateness_exempted, p1.late_counted], [true, true, false]);
  assert.equal(p2.late_counted, true);
});

test('offline sync: re-sync is idempotent; wrong device clock, shared device and unknown codes go to review', () => {
  const { h, ids, station, c1, roster } = setup(BKK('2026-06-15', '09:00'));
  const students = h.store.getMany('Students', roster(c1.id));
  const codes = [...students.values()].map((s) => s.student_code);
  const recs = [
    { local_id: 'l1', idempotency_key: crypto.randomUUID(), student_code: codes[0], captured_at: BKK('2026-06-15', '07:40'), claimed_user_id: ids.duty },
    { local_id: 'l2', idempotency_key: crypto.randomUUID(), student_code: codes[1], captured_at: BKK('2026-06-15', '11:00'), claimed_user_id: ids.duty },
    { local_id: 'l3', idempotency_key: crypto.randomUUID(), student_code: codes[2], captured_at: BKK('2026-06-15', '08:10'), claimed_user_id: ids.gate },
    { local_id: 'l4', idempotency_key: crypto.randomUUID(), student_code: '99999', captured_at: BKK('2026-06-15', '08:10'), claimed_user_id: ids.duty },
  ];
  const r = h.ok(ids.duty, 'attendance.syncOffline', { station_id: station.id, records: recs });
  assert.deepEqual(r.results.map((x) => x.status), ['RECORDED', 'REVIEW', 'REVIEW', 'REVIEW']);
  const ev = h.store.get('AttendanceEvents', r.results[0].event_id);
  assert.deepEqual([ev.offline, ev.source, ev.actor_id, ev.claimed_actor_id], [true, 'OFFLINE_SYNC', ids.duty, ids.duty]);
  assert.ok(ev.captured_at && ev.synced_at && ev.captured_at < ev.synced_at);
  const again = h.ok(ids.duty, 'attendance.syncOffline', { station_id: station.id, records: [recs[0]] });
  assert.equal(again.results[0].status, 'DUPLICATE');
  assert.equal(h.store.findBy('AttendanceEvents', 'student_id', ev.student_id).length, 1);
  h.ok(ids.admin, 'user.setStatus', { user_id: ids.duty, status: 'DISABLED', reason: 'สิ้นสุดหน้าที่' });
  assert.equal(h.call(ids.duty, 'attendance.syncOffline', { station_id: station.id, records: [recs[1]] }).error.code, 'ACCOUNT_DISABLED', 'expired account cannot sync');
});

test('enrollment change mid-term: past day keeps old class, denominator moves on the effective date', () => {
  const { h, ids, c1, c2, roster } = setup(BKK('2026-06-15', '09:00'));
  const mover = roster(c1.id)[0];
  h.ok(ids.homeroom1, 'rollcall.submit', { class_id: c1.id, school_date: '2026-06-15', marks: [] });
  h.clock.set(BKK('2026-06-16', '09:00'));
  h.ok(ids.affairs, 'enrollment.change', { student_id: mover, effective_date: '2026-06-16', reason: 'CLASS_CHANGE', new_class_id: c2.id, note: 'ย้ายตามคำขอผู้ปกครอง' });
  assert.equal(projection(h, mover, '2026-06-15').class_id, c1.id, 'history keeps the old class');
  const d1 = h.ok(ids.affairs, 'dashboard.summary', { school_date: '2026-06-15', class_id: c1.id });
  const d2 = h.ok(ids.affairs, 'dashboard.summary', { school_date: '2026-06-16', class_id: c1.id });
  assert.equal(d1.totals.school_days, 5);
  assert.equal(d2.totals.school_days, 4, 'moved student excluded from the old class after the effective date');
  const view = h.ok(ids.homeroom2, 'attendance.classDay', { class_id: c2.id, school_date: '2026-06-16' });
  assert.ok(view.items.some((i) => i.student.id === mover));
});

test('jobs: openDay creates dense UNKNOWN rows once; unknownCheck raises one task per class with reminders', () => {
  const { h, ids, c1 } = setup(BKK('2026-06-15', '05:45'));
  return import('../../src/application/jobs/attendance-jobs.js').then(async ({ ATTENDANCE_TICK }) => {
    const { runSync: rs } = await import('../../src/application/runtime.js');
    const out = rs(ATTENDANCE_TICK.run, h.deps, {});
    assert.equal(out.open_day, true);
    assert.equal(rs(ATTENDANCE_TICK.run, h.deps, {}).open_day, false, 'enqueued once per day');
    h.runJobs();
    const rows = h.store.list('DailyAttendance', { where: { school_date: '2026-06-15' }, limit: 500 }).items;
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.presence_status === 'UNKNOWN'));
    h.clock.set(BKK('2026-06-15', '10:05'));
    assert.equal(rs(ATTENDANCE_TICK.run, h.deps, {}).unknown_check, true);
    h.runJobs();
    const tasks = h.ok(ids.homeroom1, 'reconciliation.list', {}).items.filter((t) => t.task_type === 'UNKNOWN_STATUS');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].class_id, c1.id);
    assert.equal(h.store.list('Notifications', { where: { notification_type: 'ROLL_CALL_REMINDER' }, limit: 10 }).items.length, 2);
  });
});

test('attachments: medical certificate readable by homeroom and uploader, not by subject teacher or other guardians; reads audited', () => {
  const { h, ids, c1, roster, seed } = setup();
  const [g1, g2] = seed.guardian_users;
  const pdf = Buffer.from('%PDF-1.4\n%synthetic test certificate\n').toString('base64');
  const sub = h.ok(g1.user_id, 'leave.submit', { student_id: g1.student_id, leave_type: 'SICK', reason: 'ป่วย', days: [{ school_date: '2026-06-16', unit: 'FULL_DAY' }], attachments: [{ filename: 'ใบรับรองแพทย์.pdf', mime_type: 'application/pdf', content_base64: pdf }] });
  const detail = h.ok(g1.user_id, 'leave.get', { leave_request_id: sub.leave_request_id });
  const att = detail.attachments[0];
  assert.equal(att.classification, 'MEDICAL');
  const homeroom = roster(c1.id).includes(g1.student_id) ? ids.homeroom1 : ids.homeroom2;
  assert.equal(h.ok(homeroom, 'attachment.download', { attachment_id: att.id }).content_base64, pdf);
  assert.equal(h.ok(g1.user_id, 'attachment.download', { attachment_id: att.id }).filename, 'ใบรับรองแพทย์.pdf');
  assert.equal(h.call(g2.user_id, 'attachment.download', { attachment_id: att.id }).error.code, 'FORBIDDEN');
  assert.equal(h.call(ids.subject, 'attachment.download', { attachment_id: att.id }).error.code, 'FORBIDDEN');
  assert.equal(h.call(ids.duty, 'attachment.download', { attachment_id: att.id }).error.code, 'FORBIDDEN');
  const audits = h.store.list('AuditEvents', { where: { action: 'attachment.read_sensitive' }, limit: 10 }).items;
  assert.equal(audits.length, 2);
});

test('student profile: full for homeroom, basic for gate, scoped stats and counting notes', () => {
  const { h, ids, station, c1, roster, seed } = setup(BKK('2026-06-15', '08:12'));
  const sid = roster(c1.id)[0];
  h.ok(ids.duty, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' });
  const full = h.ok(ids.homeroom1, 'student.profile', { student_id: sid });
  assert.equal(full.access, 'FULL');
  assert.equal(full.latest.presence_status, 'PRESENT');
  assert.equal(full.stats.period.late_counted, 1);
  assert.ok(full.stats.counting_note_th.length >= 4);
  assert.ok(full.guardians.length >= 1 && full.guardians[0].contacts[0].value.startsWith('+999'));
  assert.ok(full.timeline.some((t) => t.type === 'GATE_ARRIVAL'));
  const basic = h.ok(ids.gate, 'student.profile', { student_id: sid });
  assert.equal(basic.access, 'BASIC');
  assert.equal(basic.timeline, undefined);
  assert.equal(h.ok(ids.homeroom2, 'student.profile', { student_id: sid }).access, 'BASIC', 'other-class homeroom who is also a duty teacher gets identification only');
  const otherGuardian = seed.guardian_users.find((g) => g.student_id !== sid);
  assert.equal(h.call(otherGuardian.user_id, 'student.profile', { student_id: sid }).error.code, 'FORBIDDEN');
});

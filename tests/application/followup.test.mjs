// Follow-up (MASTER_PROMPT §7.6): rule cases with evidence, dedupe + cooldown, manual cases, contact
// logs, appointments, assignment, callback requests, acknowledgement timeouts and overdue reminders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/app-harness.mjs';

// 2026-06-15 is a Monday in demo term AY2026-T1; example rules: late cutoff 08:00, FOLLOWUP_LATE_COUNT
// 3 lates / 30 school days, cooldown 10 school days; ABSENCE_CONFIRMED requires ack within 24 h.
const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();

function setup(now = BKK('2026-06-15', '07:30')) {
  const h = makeHarness({ now });
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  const station = h.store.list('Stations', { limit: 1 }).items[0];
  const classes = h.store.list('Classes', { limit: 10, orderBy: [['code', 'asc']] }).items;
  const roster = (cid) => h.store.findBy('Enrollments', 'class_id', cid).map((e) => e.student_id);
  const homeroomOf = (cid) => h.store.findBy('StaffAssignments', 'class_id', cid).find((a) => a.assignment_type === 'HOMEROOM').user_id;
  return { h, seed, ids, station, c1: classes[0], c2: classes[1], roster, homeroomOf };
}

function lateOn(h, ids, station, sid, date) {
  h.clock.set(BKK(date, '08:12'));
  return h.ok(ids.duty, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' });
}

function evaluateAt(h, date) {
  h.clock.set(BKK(date, '17:00'));
  h.tick(['followup.schedule']);
  return h.runJobs();
}

test('late rule: 3 counted lates in the window open ONE case with evidence; re-evaluation does not duplicate', () => {
  const { h, ids, station, c1, roster, homeroomOf } = setup();
  const sid = roster(c1.id)[0];
  lateOn(h, ids, station, sid, '2026-06-15');
  lateOn(h, ids, station, sid, '2026-06-16');
  evaluateAt(h, '2026-06-16');
  assert.equal(h.store.findBy('Cases', 'student_id', sid).length, 0, 'below threshold');
  lateOn(h, ids, station, sid, '2026-06-17');
  evaluateAt(h, '2026-06-17');
  const cases = h.store.findBy('Cases', 'student_id', sid);
  assert.equal(cases.length, 1);
  const c = cases[0];
  assert.equal(c.case_type, 'RULE_LATE_COUNT');
  assert.equal(c.owner_user_id, homeroomOf(c1.id));
  assert.equal(c.trigger_evidence_json.count, 3);
  assert.deepEqual(c.trigger_evidence_json.items.map((x) => x.school_date), ['2026-06-15', '2026-06-16', '2026-06-17']);
  assert.equal(c.trigger_evidence_json.is_example_rule, true, 'evidence says the rule is an example, not school policy');
  assert.match(c.trigger_summary_th, /มาสาย 3 ครั้ง/);
  const n = h.store.findBy('Notifications', 'source_entity_id', c.id);
  assert.equal(n.length, 1);
  assert.equal(n[0].notification_type, 'CASE_NEW');
  // a 4th late + re-run of the job and of the tick: still one open case
  lateOn(h, ids, station, sid, '2026-06-18');
  evaluateAt(h, '2026-06-18');
  h.ok(homeroomOf(c1.id), 'case.list', {});
  assert.equal(h.store.findBy('Cases', 'student_id', sid).length, 1);
});

test('closing a rule case sets a cooldown; facts before the close never re-trigger; new facts after cooldown do', () => {
  const { h, ids, station, c1, roster, homeroomOf } = setup();
  const sid = roster(c1.id)[1];
  const hr = homeroomOf(c1.id);
  for (const d of ['2026-06-15', '2026-06-16', '2026-06-17']) lateOn(h, ids, station, sid, d);
  evaluateAt(h, '2026-06-17');
  const c = h.store.findBy('Cases', 'student_id', sid)[0];
  h.clock.set(BKK('2026-06-18', '09:00'));
  assert.equal(h.call(hr, 'case.close', { case_id: c.id, resolution_summary: 'x' }, { expectedVersion: c.version }).error.code, 'VALIDATION_ERROR', 'summary required');
  const closed = h.ok(hr, 'case.close', { case_id: c.id, resolution_summary: 'คุยกับผู้ปกครองแล้ว ปรับเวลาออกจากบ้าน' }, { expectedVersion: c.version });
  assert.ok(closed.cooldown_until > BKK('2026-06-30', '00:00'), '10 school days of cooldown');
  // three new lates inside the cooldown: no new case
  for (const d of ['2026-06-19', '2026-06-22', '2026-06-23']) lateOn(h, ids, station, sid, d);
  evaluateAt(h, '2026-06-23');
  assert.equal(h.store.findBy('Cases', 'student_id', sid).filter((x) => x.status !== 'CLOSED').length, 0, 'cooldown');
  // after the cooldown the lates after the close date count (the ones before do not)
  lateOn(h, ids, station, sid, '2026-07-06');
  evaluateAt(h, '2026-07-06');
  const open = h.store.findBy('Cases', 'student_id', sid).filter((x) => x.status !== 'CLOSED');
  assert.equal(open.length, 1);
  assert.ok(open[0].trigger_evidence_json.items.every((x) => x.school_date > '2026-06-18'), 'only facts after the closed case');
  assert.equal(open[0].trigger_evidence_json.since_date, '2026-06-18');
});

test('manual case: contact log moves status, appointment, assignment rules, resolve/close/reopen with permissions', () => {
  const { h, ids, c1, c2, roster, homeroomOf } = setup(BKK('2026-06-15', '09:00'));
  const sid = roster(c1.id)[2];
  const hr1 = homeroomOf(c1.id);
  const hr2 = homeroomOf(c2.id);
  assert.equal(h.call(hr2, 'case.create', { student_id: sid, summary_th: 'ขาดบ่อยช่วงเช้า', priority: 'NORMAL' }).error.code, 'FORBIDDEN', 'other homeroom');
  assert.equal(h.call(ids.exec, 'case.create', { student_id: sid, summary_th: 'ขาดบ่อยช่วงเช้า', priority: 'NORMAL' }).error.code, 'FORBIDDEN', 'executive has no case.manage');
  const { case_id } = h.ok(hr1, 'case.create', { student_id: sid, summary_th: 'ผู้ปกครองแจ้งว่านักเรียนป่วยบ่อย', priority: 'HIGH', next_action_th: 'โทรสอบถาม' });
  let c = h.store.get('Cases', case_id);
  assert.equal(c.owner_user_id, hr1);
  // tapping tel: is not a call — only a logged outcome changes the case
  const noAnswer = h.ok(hr1, 'contact.log', { student_id: sid, case_id, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'NO_ANSWER', summary: 'โทร 2 ครั้ง ไม่มีผู้รับ', follow_up_required: true, next_follow_up_at: BKK('2026-06-16', '10:00') });
  c = h.store.get('Cases', case_id);
  assert.equal(c.status, 'WAITING_RESPONSE');
  assert.equal(c.due_at, BKK('2026-06-16', '10:00'));
  assert.ok(noAnswer.contact_log_id);
  h.ok(hr1, 'contact.log', { student_id: sid, case_id, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'REACHED', summary: 'คุยกับมารดาแล้ว', follow_up_required: false });
  assert.equal(h.store.get('Cases', case_id).status, 'IN_PROGRESS');
  assert.equal(h.call(hr1, 'contact.log', { student_id: roster(c2.id)[0], case_id, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'REACHED', summary: 'ผิดคน', follow_up_required: false }).error.code, 'VALIDATION_ERROR');
  const ap = h.ok(hr1, 'appointment.create', { case_id, scheduled_at: BKK('2026-06-17', '15:30'), location: 'ห้องแนะแนว' });
  assert.equal(h.store.get('Cases', case_id).next_appointment_at, BKK('2026-06-17', '15:30'));
  assert.equal(h.call(hr1, 'appointment.update', { appointment_id: ap.appointment_id, status: 'COMPLETED' }, { expectedVersion: 1 }).error.code, 'VALIDATION_ERROR', 'outcome note required');
  h.ok(hr1, 'appointment.update', { appointment_id: ap.appointment_id, status: 'COMPLETED', outcome_note: 'ผู้ปกครองมาพบ ตกลงแนวทางร่วมกัน' }, { expectedVersion: 1 });
  // assignment: only to someone who may manage the student
  c = h.store.get('Cases', case_id);
  assert.equal(h.call(hr1, 'case.assign', { case_id, owner_user_id: hr2, reason: 'ส่งต่อ' }, { expectedVersion: c.version }).error.code, 'VALIDATION_ERROR');
  const assignable = h.ok(hr1, 'case.assignable', { student_id: sid }).items.map((x) => x.user_id);
  assert.ok(assignable.includes(ids.affairs) && !assignable.includes(hr2));
  h.ok(hr1, 'case.assign', { case_id, owner_user_id: ids.affairs, reason: 'ต้องการการดูแลจากกิจการนักเรียน' }, { expectedVersion: c.version });
  c = h.store.get('Cases', case_id);
  assert.equal(c.owner_user_id, ids.affairs);
  const events = h.ok(ids.affairs, 'case.get', { case_id }).events.map((e) => e.event_type);
  assert.deepEqual(events, ['OPENED', 'CONTACT_LOGGED', 'CONTACT_LOGGED', 'APPOINTMENT_SET', 'NOTE', 'TRANSFERRED']);
  h.ok(ids.affairs, 'case.resolve', { case_id, note: 'นักเรียนมาเรียนสม่ำเสมอขึ้น' }, { expectedVersion: c.version });
  c = h.store.get('Cases', case_id);
  h.ok(ids.affairs, 'case.close', { case_id, resolution_summary: 'ติดตามครบ 2 สัปดาห์ ไม่มีปัญหาเพิ่ม' }, { expectedVersion: c.version });
  c = h.store.get('Cases', case_id);
  assert.equal(c.cooldown_until, null, 'manual cases have no cooldown');
  assert.equal(h.call(ids.affairs, 'case.reopen', { case_id, reason: 'x' }, { expectedVersion: c.version }).error.code, 'VALIDATION_ERROR');
  h.ok(ids.affairs, 'case.reopen', { case_id, reason: 'ผู้ปกครองแจ้งปัญหาใหม่' }, { expectedVersion: c.version });
  assert.equal(h.store.get('Cases', case_id).reopened_count, 1);
  // list scope: hr1 still sees the case (student in homeroom) though no longer owner; hr2 does not
  assert.ok(h.ok(hr1, 'case.list', {}).items.some((x) => x.id === case_id));
  assert.ok(!h.ok(hr2, 'case.list', {}).items.some((x) => x.id === case_id));
  assert.equal(h.call(hr2, 'case.get', { case_id }).error.code, 'FORBIDDEN');
});

function absenceForGuardian(h, ids, c1, roster, homeroomOf, seed) {
  const g = seed.guardian_users.find((x) => roster(c1.id).includes(x.student_id));
  const hr = homeroomOf(c1.id);
  h.clock.set(BKK('2026-06-15', '10:30'));
  h.ok(hr, 'rollcall.submit', { class_id: c1.id, school_date: '2026-06-15', marks: [{ student_id: g.student_id, mark: 'ABSENT' }] });
  const v = h.ok(hr, 'attendance.verifyDay', { class_id: c1.id, school_date: '2026-06-15', confirm_absent_student_ids: [g.student_id] });
  assert.deepEqual(v.confirmed, [g.student_id]);
  return { g, hr };
}

test('guardian acknowledges or asks for a callback; callback opens ONE case for the homeroom owner', () => {
  const { h, ids, c1, roster, homeroomOf, seed } = setup();
  const { g, hr } = absenceForGuardian(h, ids, c1, roster, homeroomOf, seed);
  const list = h.ok(g.user_id, 'notification.list', {});
  const item = list.items.find((x) => x.type === 'ABSENCE_CONFIRMED');
  assert.ok(item, 'guardian got the in-app notification');
  assert.equal(item.ack_state, 'PENDING_ACK');
  assert.deepEqual(item.actions.sort(), ['ACKNOWLEDGED', 'CALLBACK_REQUESTED']);
  assert.equal(list.pending_ack, 1);
  // someone else cannot act on this recipient row
  assert.equal(h.call(hr, 'notification.acknowledge', { recipient_id: item.recipient_id, action: 'ACKNOWLEDGED' }).error.code, 'NOT_FOUND');
  const cb = h.ok(g.user_id, 'notification.acknowledge', { recipient_id: item.recipient_id, action: 'CALLBACK_REQUESTED', note: 'ลูกไม่สบาย อยากคุยกับครู' });
  const again = h.ok(g.user_id, 'notification.acknowledge', { recipient_id: item.recipient_id, action: 'CALLBACK_REQUESTED' });
  assert.equal(again.duplicate, true);
  assert.equal(again.case_id, cb.case_id);
  const kase = h.store.get('Cases', cb.case_id);
  assert.equal(kase.case_type, 'CALLBACK_REQUEST');
  assert.equal(kase.owner_user_id, hr);
  assert.equal(kase.priority, 'HIGH');
  const ownerNote = h.store.findBy('Notifications', 'source_entity_id', kase.id).find((n) => n.notification_type === 'CALLBACK_REQUESTED');
  assert.ok(ownerNote, 'owner notified');
  const rec = h.store.get('NotificationRecipients', item.recipient_id);
  assert.equal(rec.ack_state, 'FOLLOW_UP_REQUIRED');
  assert.equal(h.ok(hr, 'case.list', { mine: true }).items.filter((x) => x.id === kase.id).length, 1);
  // the guardian can still acknowledge; the state stays FOLLOW_UP_REQUIRED until staff act
  h.ok(g.user_id, 'notification.acknowledge', { recipient_id: item.recipient_id, action: 'ACKNOWLEDGED' });
  assert.equal(h.store.get('NotificationRecipients', item.recipient_id).ack_state, 'FOLLOW_UP_REQUIRED');
  assert.equal(h.store.findBy('Acknowledgements', 'recipient_id', item.recipient_id).length, 2);
});

test('required acknowledgement not given in time → FOLLOW_UP_REQUIRED and one ACK_TIMEOUT case; overdue reminder once per due date', () => {
  const { h, ids, c1, roster, homeroomOf, seed } = setup();
  const { g, hr } = absenceForGuardian(h, ids, c1, roster, homeroomOf, seed);
  h.clock.set(BKK('2026-06-16', '11:00'));
  h.tick(['followup.schedule']);
  h.tick(['followup.schedule']);
  const rec = h.store.findBy('NotificationRecipients', 'recipient_user_id', g.user_id).find((r) => r.ack_required);
  assert.equal(rec.ack_state, 'FOLLOW_UP_REQUIRED');
  const timeoutCases = h.store.findBy('Cases', 'student_id', g.student_id).filter((c) => c.case_type === 'ACK_TIMEOUT');
  assert.equal(timeoutCases.length, 1);
  assert.equal(timeoutCases[0].owner_user_id, hr);
  // the case is due in 24 h; after that the owner is reminded once for that due date
  h.clock.set(BKK('2026-06-17', '12:00'));
  h.tick(['followup.schedule']);
  h.tick(['followup.schedule']);
  const reminders = h.store.findBy('Notifications', 'source_entity_id', timeoutCases[0].id).filter((n) => n.notification_type === 'CASE_OVERDUE');
  assert.equal(reminders.length, 1);
  assert.ok(h.ok(hr, 'case.list', { overdue_only: true }).items.some((x) => x.id === timeoutCases[0].id));
});

test('contact inbox lists inbound guardian messages until a staff reply handles them', () => {
  const { h, c1, roster, homeroomOf, seed } = setup(BKK('2026-06-15', '09:00'));
  const g = seed.guardian_users.find((x) => roster(c1.id).includes(x.student_id));
  const hr = homeroomOf(c1.id);
  const guardianId = h.store.get('Users', g.user_id).guardian_id;
  // an inbound contact recorded by staff (e.g. the guardian phoned the office)
  const inbound = h.ok(hr, 'contact.log', { student_id: g.student_id, guardian_id: guardianId, channel: 'PHONE', direction: 'INBOUND', outcome: 'FOLLOW_UP_NEEDED', summary: 'ผู้ปกครองโทรมาขอคุยเรื่องการบ้าน', follow_up_required: true });
  let inbox = h.ok(hr, 'contact.inbox', {});
  assert.ok(inbox.items.some((x) => x.id === inbound.contact_log_id));
  h.ok(hr, 'contact.log', { student_id: g.student_id, guardian_id: guardianId, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'REACHED', summary: 'โทรกลับแล้ว', follow_up_required: false, handles_contact_id: inbound.contact_log_id });
  inbox = h.ok(hr, 'contact.inbox', {});
  assert.ok(!inbox.items.some((x) => x.id === inbound.contact_log_id));
});

// Leave operations (MASTER_PROMPT §7.2, §9). Guardian confirmation and school approval are stored
// separately; every change appends LeaveRevisions; decisions append LeaveApprovals; approved/cancelled
// segments re-evaluate DailyAttendance for past/today dates (retroactive leave updates reports).
import { op } from '../dispatcher.js';
import { obj, S, notFound, assertVersion } from './common.js';
import { requirePermission, allows, scopeFor } from '../authz.js';
import { commit, ruleFor } from '../context.js';
import { requireStudent, getClass, enrollmentsOf, allCalendar, allPeriods } from '../queries.js';
import { refreshDay } from '../services/attendance-core.js';
import { emitNotification, guardianRecipients, homeroomRecipients, roleRecipients, studentShortName } from '../services/notify.js';
import { validateUpload, stageAttachment, linkAttachment } from '../files.js';
import { planLeaveSubmission, planSchoolDecision, statusFromSegments, approverRoleAllowed, ACTIVE_SEGMENT_STATUSES } from '../../domain/leave.js';
import { assertTransition } from '../../domain/state-machines.js';
import { findEffectiveEnrollment } from '../../domain/enrollment.js';
import { AppError } from '../../shared/errors.js';
import { formatThaiDate } from '../../shared/thai-format.js';
import { ENUMS } from '../../schema/enums.js';

const DAY = obj({ school_date: S.date, unit: S.enum('LeaveUnit'), periods: { type: ['array', 'null'], maxItems: 20, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 20 } } }, ['school_date', 'unit']);
const FILE = obj({ filename: S.str(200), mime_type: S.strOrNull(100), content_base64: { type: 'string', minLength: 4 } }, ['filename', 'content_base64']);

function requesterTypeOf(ctx) {
  const r = ctx.principal.roles;
  if (r.has('GUARDIAN') && ctx.principal.user && ctx.principal.user.user_type === 'GUARDIAN') return 'GUARDIAN';
  if (r.has('STUDENT') && ctx.principal.user && ctx.principal.user.user_type === 'STUDENT') return 'STUDENT';
  return 'STAFF';
}

function daysText(segments) {
  if (!segments.length) return '';
  const unitTh = (s) => (s.unit === 'FULL_DAY' ? '' : s.unit === 'PERIODS' ? ` (คาบ ${s.periods.join(',')})` : ` (${ENUMS.LeaveUnit.th[s.unit]})`);
  const first = segments[0];
  const last = segments[segments.length - 1];
  return segments.length === 1 ? `${formatThaiDate(first.school_date)}${unitTh(first)}` : `${formatThaiDate(first.school_date)} – ${formatThaiDate(last.school_date)} (${segments.length} วันเรียน)`;
}

function snapshot(req, segs) {
  return { status: req.status, guardian_confirmation_status: req.guardian_confirmation_status, school_approval_status: req.school_approval_status, leave_type: req.leave_type, reason: req.reason, segments: segs.map((s) => ({ school_date: s.school_date, unit: s.unit, periods: s.periods, status: s.status })) };
}

function* loadRequest(ctx, id) {
  const req = yield ctx.store.get('LeaveRequests', id);
  if (!req) throw notFound('leave request');
  const segs = (yield ctx.store.findBy('LeaveSegments', 'leave_request_id', id)).sort((a, b) => (a.school_date < b.school_date ? -1 : 1));
  return { req, segs };
}

/** Stage DailyAttendance recomputation for segment dates up to today (future dates are opened later). */
function* refreshDates(ctx, cs, studentId, segmentsAfter) {
  const byDate = new Map();
  for (const s of segmentsAfter) if (s.school_date <= ctx.today) byDate.set(s.school_date, true);
  const req = cs.writes.find((w) => w.table === 'LeaveRequests');
  for (const date of byDate.keys()) {
    yield* refreshDay(ctx, cs, studentId, date, {
      segmentPatch: (segs) => {
        // overlay staged segment states and request status from this change set
        const staged = new Map(cs.writes.filter((w) => w.table === 'LeaveSegments').map((w) => [w.record.id, w.record]));
        const merged = segs.map((s) => (staged.has(s.id) ? { ...staged.get(s.id), request_status: req ? req.record.status : s.request_status } : (req && s.leave_request_id === req.record.id ? { ...s, request_status: req.record.status } : s)));
        for (const st of staged.values()) if (st.school_date === date && st.student_id === studentId && !merged.some((m) => m.id === st.id)) merged.push({ ...st, request_status: req ? req.record.status : null });
        return merged.filter((s) => s.school_date === date);
      },
    });
  }
}

function* approversFor(ctx, req) {
  if (req.current_approver_user_id) {
    const u = yield ctx.store.get('Users', req.current_approver_user_id);
    return u && u.status === 'ACTIVE' ? [{ user: u, role: req.current_approver_role || 'STUDENT_AFFAIRS' }] : [];
  }
  if (req.current_approver_role === 'HOMEROOM_TEACHER') {
    const enr = findEffectiveEnrollment(yield* enrollmentsOf(ctx, req.student_id), req.student_id, req.start_date);
    return yield* homeroomRecipients(ctx, enr ? enr.class_id : null);
  }
  return yield* roleRecipients(ctx, 'STUDENT_AFFAIRS');
}

function* notifyPending(ctx, cs, req, segs, student, cls) {
  const params = { student_name: studentShortName(student), class_name: cls ? cls.name_th : '', days_text: daysText(segs), leave_type_th: ENUMS.LeaveType.th[req.leave_type] };
  if (req.status === 'PENDING_GUARDIAN') {
    yield* emitNotification(ctx, cs, { type: 'LEAVE_PENDING_GUARDIAN', sourceEntityType: 'LeaveRequests', sourceEntityId: req.id, studentId: req.student_id, purpose: `rev${req.revision_no}`, params, recipients: yield* guardianRecipients(ctx, req.student_id, 'LEAVE_PENDING_GUARDIAN'), noAck: true });
  } else if (req.status === 'PENDING_SCHOOL' || req.status === 'CANCELLATION_REQUESTED') {
    yield* emitNotification(ctx, cs, { type: 'LEAVE_PENDING_SCHOOL', sourceEntityType: 'LeaveRequests', sourceEntityId: req.id, studentId: req.student_id, purpose: `${req.status}|rev${req.revision_no}`, params, recipients: yield* approversFor(ctx, req), noAck: true });
  }
}

function* notifyDecision(ctx, cs, req, segs, student, decisionTh) {
  const recipients = [...(yield* guardianRecipients(ctx, req.student_id, 'LEAVE_DECIDED'))];
  const requester = yield ctx.store.get('Users', req.requester_user_id);
  if (requester && requester.status === 'ACTIVE' && !recipients.some((r) => r.user.id === requester.id)) recipients.push({ user: requester, role: requester.user_type === 'STUDENT' ? 'STUDENT' : requester.user_type === 'GUARDIAN' ? 'GUARDIAN' : 'HOMEROOM_TEACHER' });
  yield* emitNotification(ctx, cs, {
    type: 'LEAVE_DECIDED', sourceEntityType: 'LeaveRequests', sourceEntityId: req.id, studentId: req.student_id, purpose: `${req.status}|rev${req.revision_no}`,
    params: { student_name: studentShortName(student), days_text: daysText(segs.filter((s) => s.status !== 'WITHDRAWN')), decision_th: decisionTh }, recipients,
  });
}

function* planFor(ctx, input, requesterType, excludeRequestId = null) {
  const student = yield* requireStudent(ctx, input.student_id);
  const enrollments = yield* enrollmentsOf(ctx, student.id);
  const classIds = [...new Set(enrollments.map((e) => e.class_id))];
  const classesById = new Map();
  for (const id of classIds) classesById.set(id, yield* getClass(ctx, id));
  const existing = (yield ctx.store.findBy('LeaveSegments', 'student_id', student.id)).filter((s) => s.leave_request_id !== excludeRequestId && ACTIVE_SEGMENT_STATUSES.has(s.status));
  const routingRule = yield* ruleFor(ctx, 'LEAVE_ROUTING', ctx.today);
  const plan = planLeaveSubmission({
    days: input.days, studentId: student.id, leaveType: input.leave_type, requesterType, today: ctx.today, enrollments, classesById, terms: ctx.terms,
    calendarEntries: yield* allCalendar(ctx), periods: yield* allPeriods(ctx), routingRule, existingSegments: existing, retroactiveReason: input.retroactive_reason, requesterRoles: ctx.principal.roles,
  });
  return { student, plan, routingRule, classesById };
}

export const leaveOps = [
  op({
    name: 'leave.submit', mutation: true, permission: 'leave.submit', rateLimitPerMinute: 30,
    description_th: 'ยื่นใบลา (ทั้งวัน/ครึ่งวัน/บางคาบ หลายวัน) พร้อมเอกสาร — ตรวจวันซ้อน วันหยุด และ enrollment',
    input: obj({
      student_id: S.uuid, leave_type: S.enum('LeaveType'), reason: S.str(1000, 3), days: { type: 'array', minItems: 1, maxItems: 31, items: DAY },
      retroactive_reason: S.strOrNull(1000), attachments: { type: 'array', maxItems: 3, items: FILE },
    }, ['student_id', 'leave_type', 'reason', 'days']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'leave.submit', { student_id: input.student_id });
      const requesterType = requesterTypeOf(ctx);
      const { student, plan, routingRule } = yield* planFor(ctx, input, requesterType);
      const files = (input.attachments || []).map((f) => validateUpload(f, input.leave_type === 'SICK' ? 'MEDICAL' : 'GENERAL'));
      const cs = ctx.changeSet();
      const req = cs.insert('LeaveRequests', {
        student_id: student.id, requester_user_id: ctx.principal.user_id, requester_type: requesterType, leave_type: input.leave_type, start_date: plan.start_date, end_date: plan.end_date,
        reason: input.reason, status: plan.status, guardian_confirmation_status: plan.guardian_status, school_approval_status: plan.school_status, route_rule_version_id: routingRule.id,
        current_approver_role: plan.approver_role, is_retroactive: plan.is_retroactive, retroactive_reason: plan.is_retroactive ? input.retroactive_reason : null,
        ...plan.counts, revision_no: 1, submitted_at: ctx.now, attachment_required: plan.attachment_required,
      });
      const segs = plan.segments.map((sg) => cs.insert('LeaveSegments', { leave_request_id: req.id, student_id: student.id, school_date: sg.school_date, unit: sg.unit, periods: sg.periods, status: 'REQUESTED', usage_status: 'NOT_EVALUATED' }));
      for (const f of files) {
        const att = yield* stageAttachment(ctx, cs, f, input.leave_type === 'SICK' ? 'MEDICAL' : 'GENERAL');
        yield* linkAttachment(ctx, cs, att, 'LEAVE_REQUEST', req.id, 'EVIDENCE');
      }
      cs.insert('LeaveRevisions', { leave_request_id: req.id, revision_no: 1, action: 'SUBMIT', actor_id: ctx.principal.user_id, acted_at: ctx.now, from_status: null, to_status: req.status, snapshot_json: snapshot(req, segs), comment: null, operation_id: cs.operationId });
      cs.audit({ action: 'leave.submit', entityType: 'LeaveRequests', entityId: req.id, studentId: student.id, after: { leave_type: req.leave_type, days: segs.length, retroactive: req.is_retroactive } });
      const enr = findEffectiveEnrollment(yield* enrollmentsOf(ctx, student.id), student.id, plan.start_date);
      yield* notifyPending(ctx, cs, req, segs, student, enr ? yield* getClass(ctx, enr.class_id) : null);
      return yield* commit(ctx, cs, { leave_request_id: req.id, status: req.status, guardian_confirmation_status: req.guardian_confirmation_status, school_approval_status: req.school_approval_status, approver_role: req.current_approver_role, attachment_required: req.attachment_required, version: 1 });
    },
  }),

  op({
    name: 'leave.confirmGuardian', mutation: true, permission: 'leave.confirm_guardian',
    description_th: 'ผู้ปกครองยืนยัน/ไม่ยืนยันใบลาที่นักเรียนยื่น (แยกจากการอนุมัติของโรงเรียน)',
    input: obj({ leave_request_id: S.uuid, decision: { type: 'string', enum: ['CONFIRMED', 'DECLINED'] }, comment: S.strOrNull(1000) }, ['leave_request_id', 'decision']),
    *handler(ctx, input, env) {
      const { req, segs } = yield* loadRequest(ctx, input.leave_request_id);
      yield* requirePermission(ctx, 'leave.confirm_guardian', { student_id: req.student_id });
      assertVersion(req, env.expected_version);
      const tr = assertTransition('Leave', req.status, input.decision === 'CONFIRMED' ? 'GUARDIAN_CONFIRM' : 'GUARDIAN_DECLINE');
      const student = yield* requireStudent(ctx, req.student_id);
      const cs = ctx.changeSet();
      const to = tr.to[0];
      const updated = cs.update('LeaveRequests', req, {
        status: to, guardian_confirmation_status: input.decision, school_approval_status: to === 'PENDING_SCHOOL' ? 'PENDING' : req.school_approval_status, revision_no: req.revision_no + 1, decided_at: to === 'REJECTED' ? ctx.now : null,
      });
      const newSegs = input.decision === 'DECLINED' ? segs.map((s) => (s.status === 'REQUESTED' ? cs.update('LeaveSegments', s, { status: 'REJECTED' }) : s)) : segs;
      const appr = cs.insert('LeaveApprovals', { leave_request_id: req.id, step_no: 1, step_type: 'GUARDIAN_CONFIRMATION', decision: input.decision, decided_by: ctx.principal.user_id, decided_at: ctx.now, approver_role: 'GUARDIAN', comment: input.comment, revision_no: updated.revision_no, operation_id: cs.operationId });
      cs.insert('LeaveRevisions', { leave_request_id: req.id, revision_no: updated.revision_no, action: input.decision === 'CONFIRMED' ? 'GUARDIAN_CONFIRM' : 'GUARDIAN_DECLINE', actor_id: ctx.principal.user_id, acted_at: ctx.now, from_status: req.status, to_status: to, snapshot_json: snapshot(updated, newSegs), comment: input.comment, operation_id: cs.operationId });
      cs.audit({ action: 'leave.confirm_guardian', entityType: 'LeaveRequests', entityId: req.id, studentId: req.student_id, after: { decision: input.decision, approval_id: appr.id } });
      if (to === 'PENDING_SCHOOL') {
        const enr = findEffectiveEnrollment(yield* enrollmentsOf(ctx, req.student_id), req.student_id, req.start_date);
        yield* notifyPending(ctx, cs, updated, newSegs, student, enr ? yield* getClass(ctx, enr.class_id) : null);
      } else yield* notifyDecision(ctx, cs, updated, newSegs, student, 'ผู้ปกครองไม่ยืนยันใบลา');
      return yield* commit(ctx, cs, { leave_request_id: req.id, status: to, version: updated.version });
    },
  }),

  op({
    name: 'leave.decide', mutation: true, permission: 'leave.approve',
    description_th: 'โรงเรียนพิจารณาใบลา: อนุมัติ / อนุมัติบางช่วง / ไม่อนุมัติ / ส่งกลับแก้ไข (ตามเส้นทางอนุมัติ หรือผู้รักษาการแทน)',
    input: obj({ leave_request_id: S.uuid, decision: { type: 'string', enum: ['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'RETURNED'] }, segment_decisions: { type: ['object', 'null'] }, comment: S.strOrNull(1000) }, ['leave_request_id', 'decision']),
    *handler(ctx, input, env) {
      const { req, segs } = yield* loadRequest(ctx, input.leave_request_id);
      yield* requirePermission(ctx, 'leave.approve', { student_id: req.student_id, dates: [req.start_date] });
      assertVersion(req, env.expected_version);
      const actingRole = req.current_approver_user_id && req.current_approver_user_id !== ctx.principal.user_id && !ctx.principal.roles.has('STUDENT_AFFAIRS')
        ? null : approverRoleAllowed(req.current_approver_role, ctx.principal.roles);
      if (!actingRole) throw new AppError('FORBIDDEN', 'not the approver', { messageTh: 'ใบลานี้ต้องพิจารณาโดยผู้มีอำนาจตามเส้นทางอนุมัติ (เช่น กลุ่มงานกิจการนักเรียน)' });
      if (input.decision === 'RETURNED' && req.status === 'PENDING_GUARDIAN') { /* allowed by machine */ }
      const plan = planSchoolDecision({ request: req, segments: segs, decision: input.decision, segmentDecisions: input.segment_decisions, comment: input.comment });
      const student = yield* requireStudent(ctx, req.student_id);
      const cs = ctx.changeSet();
      const updated = cs.update('LeaveRequests', req, {
        status: plan.to_status, school_approval_status: plan.school_status, revision_no: req.revision_no + 1, decided_at: ['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'].includes(plan.to_status) ? ctx.now : null,
      });
      const appr = cs.insert('LeaveApprovals', {
        leave_request_id: req.id, step_no: 2, step_type: 'SCHOOL_APPROVAL', decision: input.decision, decided_by: ctx.principal.user_id, decided_at: ctx.now, approver_role: actingRole,
        acting_for_user_id: null, comment: input.comment, segment_decisions_json: plan.segment_updates.length ? Object.fromEntries(plan.segment_updates.map((u) => [u.id, u.status])) : null, revision_no: updated.revision_no, operation_id: cs.operationId,
      });
      const newSegs = segs.map((s) => {
        const u = plan.segment_updates.find((x) => x.id === s.id);
        return u ? cs.update('LeaveSegments', s, { status: u.status, decision_id: appr.id }) : s;
      });
      cs.insert('LeaveRevisions', { leave_request_id: req.id, revision_no: updated.revision_no, action: plan.action, actor_id: ctx.principal.user_id, acted_at: ctx.now, from_status: req.status, to_status: plan.to_status, snapshot_json: snapshot(updated, newSegs), comment: input.comment, operation_id: cs.operationId });
      if (plan.to_status === 'APPROVED' || plan.to_status === 'PARTIALLY_APPROVED') yield* refreshDates(ctx, cs, req.student_id, newSegs);
      cs.audit({ action: 'leave.decide', entityType: 'LeaveRequests', entityId: req.id, studentId: req.student_id, reason: input.comment, after: { decision: input.decision, approver_role: actingRole, retroactive: req.is_retroactive } });
      const th = { APPROVED: 'อนุมัติ', PARTIALLY_APPROVED: 'อนุมัติบางช่วง', REJECTED: 'ไม่อนุมัติ', RETURNED: 'ส่งกลับให้แก้ไข' }[input.decision];
      yield* notifyDecision(ctx, cs, updated, newSegs, student, `${th}${input.comment ? ` — ${input.comment}` : ''}`);
      return yield* commit(ctx, cs, { leave_request_id: req.id, status: plan.to_status, version: updated.version });
    },
  }),

  op({
    name: 'leave.resubmit', mutation: true, permission: 'leave.submit',
    description_th: 'แก้ไขและส่งใบลาที่ถูกส่งกลับ (revision ใหม่; ช่วงเดิมถูกถอน)',
    input: obj({ leave_request_id: S.uuid, leave_type: S.enum('LeaveType'), reason: S.str(1000, 3), days: { type: 'array', minItems: 1, maxItems: 31, items: DAY }, retroactive_reason: S.strOrNull(1000) }, ['leave_request_id', 'leave_type', 'reason', 'days']),
    *handler(ctx, input, env) {
      const { req, segs } = yield* loadRequest(ctx, input.leave_request_id);
      yield* requirePermission(ctx, 'leave.submit', { student_id: req.student_id });
      if (req.requester_user_id !== ctx.principal.user_id && !ctx.principal.roles.has('STUDENT_AFFAIRS')) throw new AppError('FORBIDDEN', 'not requester', { messageTh: 'แก้ไขได้เฉพาะผู้ยื่นใบลา' });
      assertVersion(req, env.expected_version);
      assertTransition('Leave', req.status, 'RESUBMIT');
      const { student, plan, routingRule } = yield* planFor(ctx, { ...input, student_id: req.student_id }, req.requester_type, req.id);
      const cs = ctx.changeSet();
      for (const s of segs) if (ACTIVE_SEGMENT_STATUSES.has(s.status)) cs.update('LeaveSegments', s, { status: 'WITHDRAWN' });
      const updated = cs.update('LeaveRequests', req, {
        leave_type: input.leave_type, reason: input.reason, start_date: plan.start_date, end_date: plan.end_date, status: plan.status, guardian_confirmation_status: plan.guardian_status,
        school_approval_status: plan.school_status, route_rule_version_id: routingRule.id, current_approver_role: plan.approver_role, is_retroactive: plan.is_retroactive,
        retroactive_reason: plan.is_retroactive ? input.retroactive_reason : null, ...plan.counts, revision_no: req.revision_no + 1, submitted_at: ctx.now, attachment_required: plan.attachment_required,
      });
      const newSegs = plan.segments.map((sg) => cs.insert('LeaveSegments', { leave_request_id: req.id, student_id: req.student_id, school_date: sg.school_date, unit: sg.unit, periods: sg.periods, status: 'REQUESTED', usage_status: 'NOT_EVALUATED' }));
      cs.insert('LeaveRevisions', { leave_request_id: req.id, revision_no: updated.revision_no, action: 'RESUBMIT', actor_id: ctx.principal.user_id, acted_at: ctx.now, from_status: req.status, to_status: updated.status, snapshot_json: snapshot(updated, newSegs), comment: null, operation_id: cs.operationId });
      cs.audit({ action: 'leave.resubmit', entityType: 'LeaveRequests', entityId: req.id, studentId: req.student_id });
      const enr = findEffectiveEnrollment(yield* enrollmentsOf(ctx, req.student_id), req.student_id, plan.start_date);
      yield* notifyPending(ctx, cs, updated, newSegs, student, enr ? yield* getClass(ctx, enr.class_id) : null);
      return yield* commit(ctx, cs, { leave_request_id: req.id, status: updated.status, version: updated.version });
    },
  }),

  op({
    name: 'leave.withdraw', mutation: true, permission: 'leave.withdraw',
    description_th: 'ถอนคำขอลาที่ยังไม่ได้ข้อยุติ',
    input: obj({ leave_request_id: S.uuid, reason: S.strOrNull(500) }, ['leave_request_id']),
    *handler(ctx, input, env) {
      const { req, segs } = yield* loadRequest(ctx, input.leave_request_id);
      const own = yield* allows(ctx, 'leave.withdraw', { owner_user_id: req.requester_user_id });
      if (!own) yield* requirePermission(ctx, 'leave.withdraw', { student_id: req.student_id });
      assertVersion(req, env.expected_version);
      assertTransition('Leave', req.status, 'WITHDRAW');
      const cs = ctx.changeSet();
      const updated = cs.update('LeaveRequests', req, { status: 'WITHDRAWN', revision_no: req.revision_no + 1 });
      const newSegs = segs.map((s) => (ACTIVE_SEGMENT_STATUSES.has(s.status) ? cs.update('LeaveSegments', s, { status: 'WITHDRAWN' }) : s));
      cs.insert('LeaveRevisions', { leave_request_id: req.id, revision_no: updated.revision_no, action: 'WITHDRAW', actor_id: ctx.principal.user_id, acted_at: ctx.now, from_status: req.status, to_status: 'WITHDRAWN', snapshot_json: snapshot(updated, newSegs), comment: input.reason, operation_id: cs.operationId });
      cs.audit({ action: 'leave.withdraw', entityType: 'LeaveRequests', entityId: req.id, studentId: req.student_id, reason: input.reason });
      return yield* commit(ctx, cs, { leave_request_id: req.id, status: 'WITHDRAWN', version: updated.version });
    },
  }),

  op({
    name: 'leave.requestCancel', mutation: true, permission: 'leave.cancel',
    description_th: 'ขอยกเลิกใบลาที่อนุมัติแล้ว (ต้องมีผู้มีอำนาจพิจารณา)',
    input: obj({ leave_request_id: S.uuid, reason: S.str(1000, 3) }, ['leave_request_id', 'reason']),
    *handler(ctx, input, env) {
      const { req, segs } = yield* loadRequest(ctx, input.leave_request_id);
      yield* requirePermission(ctx, 'leave.cancel', { student_id: req.student_id });
      assertVersion(req, env.expected_version);
      assertTransition('Leave', req.status, 'CANCEL_REQUEST');
      const student = yield* requireStudent(ctx, req.student_id);
      const cs = ctx.changeSet();
      const updated = cs.update('LeaveRequests', req, { status: 'CANCELLATION_REQUESTED', revision_no: req.revision_no + 1 });
      cs.insert('LeaveRevisions', { leave_request_id: req.id, revision_no: updated.revision_no, action: 'CANCEL_REQUEST', actor_id: ctx.principal.user_id, acted_at: ctx.now, from_status: req.status, to_status: updated.status, snapshot_json: snapshot(updated, segs), comment: input.reason, operation_id: cs.operationId });
      cs.audit({ action: 'leave.request_cancel', entityType: 'LeaveRequests', entityId: req.id, studentId: req.student_id, reason: input.reason });
      const enr = findEffectiveEnrollment(yield* enrollmentsOf(ctx, req.student_id), req.student_id, req.start_date);
      yield* notifyPending(ctx, cs, updated, segs, student, enr ? yield* getClass(ctx, enr.class_id) : null);
      return yield* commit(ctx, cs, { leave_request_id: req.id, status: updated.status, version: updated.version });
    },
  }),

  op({
    name: 'leave.decideCancel', mutation: true, permission: 'leave.approve',
    description_th: 'พิจารณาการยกเลิกใบลา (หรือยกเลิกโดยตรงโดยผู้มีอำนาจ) — คำนวณการมาเรียนใหม่',
    input: obj({ leave_request_id: S.uuid, approve: S.bool, reason: S.str(1000, 3) }, ['leave_request_id', 'approve', 'reason']),
    *handler(ctx, input, env) {
      const { req, segs } = yield* loadRequest(ctx, input.leave_request_id);
      yield* requirePermission(ctx, 'leave.approve', { student_id: req.student_id, dates: [req.start_date] });
      if (!approverRoleAllowed(req.current_approver_role, ctx.principal.roles)) throw new AppError('FORBIDDEN', 'not approver');
      assertVersion(req, env.expected_version);
      const tr = assertTransition('Leave', req.status, input.approve ? 'CANCEL_APPROVE' : 'CANCEL_REJECT');
      const student = yield* requireStudent(ctx, req.student_id);
      const cs = ctx.changeSet();
      let to = tr.to[0];
      let newSegs = segs;
      if (input.approve) newSegs = segs.map((s) => (s.status === 'APPROVED' ? cs.update('LeaveSegments', s, { status: 'CANCELLED' }) : s));
      else to = statusFromSegments(segs);
      const updated = cs.update('LeaveRequests', req, { status: to, revision_no: req.revision_no + 1, cancelled_at: input.approve ? ctx.now : null });
      cs.insert('LeaveApprovals', { leave_request_id: req.id, step_no: 3, step_type: 'CANCELLATION_DECISION', decision: input.approve ? 'APPROVED' : 'REJECTED', decided_by: ctx.principal.user_id, decided_at: ctx.now, approver_role: approverRoleAllowed(req.current_approver_role, ctx.principal.roles), comment: input.reason, revision_no: updated.revision_no, operation_id: cs.operationId });
      cs.insert('LeaveRevisions', { leave_request_id: req.id, revision_no: updated.revision_no, action: input.approve ? 'CANCEL_APPROVE' : 'CANCEL_REJECT', actor_id: ctx.principal.user_id, acted_at: ctx.now, from_status: req.status, to_status: to, snapshot_json: snapshot(updated, newSegs), comment: input.reason, operation_id: cs.operationId });
      if (input.approve) yield* refreshDates(ctx, cs, req.student_id, segs.filter((s) => s.status === 'APPROVED'));
      cs.audit({ action: input.approve ? 'leave.cancelled' : 'leave.cancel_rejected', entityType: 'LeaveRequests', entityId: req.id, studentId: req.student_id, reason: input.reason });
      yield* notifyDecision(ctx, cs, updated, newSegs, student, input.approve ? `ยกเลิกใบลาแล้ว — ${input.reason}` : `ไม่อนุมัติการยกเลิก — ${input.reason}`);
      return yield* commit(ctx, cs, { leave_request_id: req.id, status: to, version: updated.version });
    },
  }),

  op({
    name: 'leave.reroute', mutation: true, permission: 'leave.approve (STUDENT_AFFAIRS)',
    description_th: 'เปลี่ยนผู้พิจารณา (ผู้พิจารณาไม่อยู่/ส่งต่อ) โดยกลุ่มงานกิจการนักเรียน',
    input: obj({ leave_request_id: S.uuid, approver_role: { type: 'string', enum: ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'] }, approver_user_id: S.uuidOrNull, reason: S.str(500, 3) }, ['leave_request_id', 'approver_role', 'reason']),
    *handler(ctx, input, env) {
      const { req, segs } = yield* loadRequest(ctx, input.leave_request_id);
      yield* requirePermission(ctx, 'leave.approve', { student_id: req.student_id });
      if (!ctx.principal.roles.has('STUDENT_AFFAIRS')) throw new AppError('FORBIDDEN', 'student affairs only', { messageTh: 'เปลี่ยนเส้นทางอนุมัติได้เฉพาะกลุ่มงานกิจการนักเรียน' });
      assertVersion(req, env.expected_version);
      assertTransition('Leave', req.status, 'REROUTE');
      const student = yield* requireStudent(ctx, req.student_id);
      const cs = ctx.changeSet();
      const updated = cs.update('LeaveRequests', req, { current_approver_role: input.approver_role, current_approver_user_id: input.approver_user_id, revision_no: req.revision_no + 1 });
      cs.insert('LeaveRevisions', { leave_request_id: req.id, revision_no: updated.revision_no, action: 'REROUTE', actor_id: ctx.principal.user_id, acted_at: ctx.now, from_status: req.status, to_status: req.status, snapshot_json: snapshot(updated, segs), comment: input.reason, operation_id: cs.operationId });
      cs.audit({ action: 'leave.reroute', entityType: 'LeaveRequests', entityId: req.id, studentId: req.student_id, reason: input.reason, after: { approver_role: input.approver_role, approver_user_id: input.approver_user_id } });
      const enr = findEffectiveEnrollment(yield* enrollmentsOf(ctx, req.student_id), req.student_id, req.start_date);
      yield* notifyPending(ctx, cs, updated, segs, student, enr ? yield* getClass(ctx, enr.class_id) : null);
      return yield* commit(ctx, cs, { leave_request_id: req.id, version: updated.version });
    },
  }),

  op({
    name: 'leave.addAttachment', mutation: true, permission: 'leave.submit | leave.approve',
    description_th: 'แนบเอกสารเพิ่ม (เช่น ใบรับรองแพทย์) ให้ใบลา',
    input: obj({ leave_request_id: S.uuid, file: FILE }, ['leave_request_id', 'file']),
    *handler(ctx, input) {
      const { req } = yield* loadRequest(ctx, input.leave_request_id);
      const ok = req.requester_user_id === ctx.principal.user_id ? yield* allows(ctx, 'leave.submit', { student_id: req.student_id }) : yield* allows(ctx, 'leave.approve', { student_id: req.student_id });
      if (!ok) throw new AppError('FORBIDDEN', 'attach');
      if (['WITHDRAWN', 'CANCELLED'].includes(req.status)) throw new AppError('INVALID_STATE', 'closed');
      const cls = req.leave_type === 'SICK' ? 'MEDICAL' : 'GENERAL';
      const f = validateUpload(input.file, cls);
      const cs = ctx.changeSet();
      const att = yield* stageAttachment(ctx, cs, f, cls);
      yield* linkAttachment(ctx, cs, att, 'LEAVE_REQUEST', req.id, 'EVIDENCE');
      cs.audit({ action: 'leave.add_attachment', entityType: 'LeaveRequests', entityId: req.id, studentId: req.student_id, after: { attachment_id: att.id, classification: cls } });
      return yield* commit(ctx, cs, { attachment_id: att.id });
    },
  }),

  op({
    name: 'leave.get', description_th: 'รายละเอียดใบลา ช่วงลา ผลพิจารณา ประวัติ และเอกสาร (ตามสิทธิ์)', permission: 'leave.read',
    input: obj({ leave_request_id: S.uuid }, ['leave_request_id']),
    *handler(ctx, input) {
      const { req, segs } = yield* loadRequest(ctx, input.leave_request_id);
      const own = req.requester_user_id === ctx.principal.user_id;
      if (!own) yield* requirePermission(ctx, 'leave.read', { student_id: req.student_id, dates: [req.start_date] });
      const student = yield* requireStudent(ctx, req.student_id);
      const approvals = (yield ctx.store.findBy('LeaveApprovals', 'leave_request_id', req.id)).sort((a, b) => (a.decided_at < b.decided_at ? -1 : 1));
      const revisions = (yield ctx.store.findBy('LeaveRevisions', 'leave_request_id', req.id)).sort((a, b) => a.revision_no - b.revision_no);
      const links = (yield ctx.store.findBy('AttachmentLinks', 'entity_id', req.id)).filter((l) => !l.unlinked_at);
      const atts = yield ctx.store.getMany('Attachments', links.map((l) => l.attachment_id));
      const actors = yield ctx.store.getMany('Users', [...new Set([...approvals.map((a) => a.decided_by), ...revisions.map((r) => r.actor_id), req.requester_user_id])]);
      const name = (id) => (actors.get(id) ? actors.get(id).display_name : '—');
      const canDecide = yield* allows(ctx, 'leave.approve', { student_id: req.student_id, dates: [req.start_date] });
      const canConfirm = yield* allows(ctx, 'leave.confirm_guardian', { student_id: req.student_id });
      return {
        request: req, student: { id: student.id, student_code: student.student_code, name: studentShortName(student) }, segments: segs,
        approvals: approvals.map((a) => ({ ...a, decided_by_name: name(a.decided_by) })), revisions: revisions.map((r) => ({ ...r, actor_name: name(r.actor_id) })),
        attachments: [...atts.values()].filter((a) => a.status !== 'DELETED').map((a) => ({ id: a.id, filename: a.original_filename, mime_type: a.mime_type, size_bytes: a.size_bytes, classification: a.classification, uploaded_at: a.uploaded_at })),
        requester_name: name(req.requester_user_id), can: { decide: canDecide && approverRoleAllowed(req.current_approver_role, ctx.principal.roles) !== null, confirm_guardian: canConfirm, own },
      };
    },
  }),

  op({
    name: 'leave.list', description_th: 'รายการใบลาตามขอบเขตสิทธิ์', permission: 'leave.read',
    input: obj({ student_id: S.uuidOrNull, status: S.enumOrNull('LeaveStatus'), from: S.dateOrNull, to: S.dateOrNull, cursor: S.cursor, limit: S.limit }),
    *handler(ctx, input) {
      const where = {};
      if (input.status) where.status = input.status;
      if (input.from) where.end_date = { gt: input.from };
      if (input.to) where.start_date = { lt: input.to };
      if (input.student_id) {
        yield* requirePermission(ctx, 'leave.read', { student_id: input.student_id });
        where.student_id = input.student_id;
      } else {
        const scope = scopeFor(ctx, 'leave.read');
        if (!scope.all) {
          const ids = new Set(scope.studentIds || []);
          if (scope.classIds && scope.classIds.size) {
            for (const cid of scope.classIds) for (const e of yield ctx.store.findBy('Enrollments', 'class_id', cid)) ids.add(e.student_id);
          }
          where.student_id = { in: [...ids] };
        }
      }
      const page = yield ctx.store.list('LeaveRequests', { where, orderBy: [['submitted_at', 'desc']], cursor: input.cursor, limit: input.limit || 30 });
      const students = yield ctx.store.getMany('Students', page.items.map((r) => r.student_id));
      return { items: page.items.map((r) => ({ ...r, student_name: students.get(r.student_id) ? studentShortName(students.get(r.student_id)) : '', student_code: (students.get(r.student_id) || {}).student_code })), next_cursor: page.next_cursor };
    },
  }),

  op({
    name: 'leave.inbox', description_th: 'งานที่รอฉันพิจารณา (ผู้ปกครองยืนยัน / โรงเรียนอนุมัติ / ขอยกเลิก)', permission: 'leave.approve | leave.confirm_guardian',
    input: obj({ limit: S.limit }),
    *handler(ctx) {
      const p = ctx.principal;
      const out = [];
      const add = (r, kind) => out.push({ kind, request: r });
      if (p.roles.has('GUARDIAN')) {
        for (const [sid, perms] of p.facts.guardianLinks) {
          if (!perms.has('CONFIRM_LEAVE')) continue;
          for (const r of yield ctx.store.findBy('LeaveRequests', 'student_id', sid)) if (r.status === 'PENDING_GUARDIAN') add(r, 'GUARDIAN_CONFIRMATION');
        }
      }
      if (p.roles.has('STUDENT_AFFAIRS') || p.roles.has('HOMEROOM_TEACHER')) {
        const pending = (yield ctx.store.list('LeaveRequests', { where: { status: { in: ['PENDING_SCHOOL', 'CANCELLATION_REQUESTED'] } }, limit: 500, orderBy: [['submitted_at', 'asc']] })).items;
        for (const r of pending) {
          if (r.current_approver_user_id && r.current_approver_user_id !== p.user_id && !p.roles.has('STUDENT_AFFAIRS')) continue;
          if (!approverRoleAllowed(r.current_approver_role, p.roles)) continue;
          if (!(yield* allows(ctx, 'leave.approve', { student_id: r.student_id, dates: [r.start_date] }))) continue;
          add(r, r.status === 'CANCELLATION_REQUESTED' ? 'CANCELLATION_DECISION' : 'SCHOOL_APPROVAL');
        }
      }
      const students = yield ctx.store.getMany('Students', out.map((x) => x.request.student_id));
      return { items: out.map((x) => ({ ...x, student_name: students.get(x.request.student_id) ? studentShortName(students.get(x.request.student_id)) : '' })) };
    },
  }),
];

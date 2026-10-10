// Leave rules (MASTER_PROMPT §7.2, §9). Pure functions; callers load the inputs.
// Units are kept separate: full days, half days and periods are counted independently.

import { AppError, fieldError, validationError } from '../shared/errors.js';
import { addDays, diffDays } from '../shared/time.js';
import { dayInfo, periodsFor } from './calendar.js';
import { findEffectiveEnrollment } from './enrollment.js';
import { assertTransition } from './state-machines.js';

export const ACTIVE_REQUEST_STATUSES = new Set(['PENDING_GUARDIAN', 'PENDING_SCHOOL', 'RETURNED', 'APPROVED', 'PARTIALLY_APPROVED', 'CANCELLATION_REQUESTED', 'SUBMITTED']);
export const ACTIVE_SEGMENT_STATUSES = new Set(['REQUESTED', 'APPROVED']);

/** Which sessions/periods a segment occupies on its date. */
export function segmentOccupancy(segment, periodsOfDay) {
  const all = periodsOfDay.map((p) => p.period_no);
  switch (segment.unit) {
    case 'FULL_DAY': return { full: true, periods: new Set(all) };
    case 'HALF_DAY_AM': return { full: false, periods: new Set(periodsOfDay.filter((p) => p.session === 'AM').map((p) => p.period_no)), session: 'AM' };
    case 'HALF_DAY_PM': return { full: false, periods: new Set(periodsOfDay.filter((p) => p.session === 'PM').map((p) => p.period_no)), session: 'PM' };
    case 'PERIODS': return { full: false, periods: new Set(segment.periods || []) };
    default: return { full: false, periods: new Set() };
  }
}

export function segmentsOverlap(a, b, periodsOfDay) {
  if (a.school_date !== b.school_date) return false;
  if (a.unit === 'FULL_DAY' || b.unit === 'FULL_DAY') return true;
  if ((a.unit === 'HALF_DAY_AM' && b.unit === 'HALF_DAY_AM') || (a.unit === 'HALF_DAY_PM' && b.unit === 'HALF_DAY_PM')) return true;
  if ((a.unit === 'HALF_DAY_AM' && b.unit === 'HALF_DAY_PM') || (a.unit === 'HALF_DAY_PM' && b.unit === 'HALF_DAY_AM')) return false;
  const pa = segmentOccupancy(a, periodsOfDay).periods;
  const pb = segmentOccupancy(b, periodsOfDay).periods;
  for (const p of pa) if (pb.has(p)) return true;
  return false;
}

/** First matching route wins. */
export function resolveRoute(routingParams, { leaveType, schoolDaysCount, gradeLevel }) {
  for (const r of routingParams.routes) {
    if (r.leave_types && !r.leave_types.includes(leaveType)) continue;
    if (r.grade_levels && gradeLevel && !r.grade_levels.includes(gradeLevel)) continue;
    if (r.min_school_days != null && schoolDaysCount < r.min_school_days) continue;
    if (r.max_school_days != null && schoolDaysCount > r.max_school_days) continue;
    return r.approver_role;
  }
  return 'STUDENT_AFFAIRS';
}

/**
 * Validate & expand a leave submission into segments.
 * @param {object} a
 * @param {Array<{school_date:string, unit:string, periods?:number[]}>} a.days
 * @returns {{segments, start_date, end_date, counts, is_retroactive, approver_role, guardian_status, status, school_status, attachment_required, grade_level}}
 */
export function planLeaveSubmission(a) {
  const { days, studentId, leaveType, requesterType, today, enrollments, classesById, terms, calendarEntries, periods, routingRule, existingSegments, retroactiveReason, requesterRoles = new Set() } = a;
  const errors = [];
  if (!Array.isArray(days) || days.length === 0) throw validationError([fieldError('days', 'REQUIRED', 'กรุณาเลือกวันที่ลา')]);
  if (days.length > 31) throw validationError([fieldError('days', 'MAX_ITEMS', 'ลาได้ไม่เกิน 31 วันต่อหนึ่งใบลา')]);
  const seen = new Set();
  const segments = [];
  let gradeLevel = null;
  for (const [i, d] of days.entries()) {
    const path = `days[${i}]`;
    if (seen.has(d.school_date)) { errors.push(fieldError(`${path}.school_date`, 'DUPLICATE', 'เลือกวันที่ซ้ำ')); continue; }
    seen.add(d.school_date);
    const enr = findEffectiveEnrollment(enrollments, studentId, d.school_date);
    if (!enr) { errors.push(fieldError(`${path}.school_date`, 'NOT_ENROLLED', `วันที่ ${d.school_date} นักเรียนไม่มีข้อมูลห้องที่มีผล`)); continue; }
    const cls = classesById.get(enr.class_id);
    gradeLevel = gradeLevel || (cls && cls.grade_level) || null;
    const info = dayInfo({ date: d.school_date, gradeLevel: cls && cls.grade_level, terms, calendarEntries });
    if (!info.school_day) { errors.push(fieldError(`${path}.school_date`, 'NOT_SCHOOL_DAY', `วันที่ ${d.school_date} ไม่ใช่วันเรียน`)); continue; }
    const periodsOfDay = periodsFor({ periods, date: d.school_date, gradeLevel: cls && cls.grade_level });
    if (d.unit === 'PERIODS') {
      const valid = new Set(periodsOfDay.map((p) => p.period_no));
      if (!Array.isArray(d.periods) || d.periods.length === 0) { errors.push(fieldError(`${path}.periods`, 'REQUIRED', 'กรุณาเลือกคาบ')); continue; }
      const bad = d.periods.filter((p) => !valid.has(p));
      if (bad.length) { errors.push(fieldError(`${path}.periods`, 'INVALID_PERIOD', `ไม่พบคาบ ${bad.join(', ')} ในวันดังกล่าว`)); continue; }
    } else if (d.periods && d.periods.length) {
      errors.push(fieldError(`${path}.periods`, 'NOT_ALLOWED', 'ระบุคาบได้เฉพาะการลาบางคาบ'));
      continue;
    }
    if ((d.unit === 'HALF_DAY_AM' || d.unit === 'HALF_DAY_PM') && !periodsOfDay.some((p) => p.session === (d.unit === 'HALF_DAY_AM' ? 'AM' : 'PM'))) {
      errors.push(fieldError(`${path}.unit`, 'NO_PERIODS', 'ยังไม่ได้ตั้งค่าคาบเรียนของช่วงเวลานี้'));
      continue;
    }
    const seg = { school_date: d.school_date, unit: d.unit, periods: d.unit === 'PERIODS' ? [...d.periods].sort((x, y) => x - y) : null, class_id: enr.class_id, grade_level: cls && cls.grade_level };
    const clash = existingSegments.find((s) => ACTIVE_SEGMENT_STATUSES.has(s.status) && segmentsOverlap(s, seg, periodsOfDay));
    if (clash) { errors.push(fieldError(`${path}.school_date`, 'OVERLAP', `วันที่ ${d.school_date} ซ้อนกับใบลาที่ยื่นไว้แล้ว`)); continue; }
    segments.push(seg);
  }
  if (errors.length) throw validationError(errors, 'leave submission invalid');
  segments.sort((x, y) => (x.school_date < y.school_date ? -1 : 1));
  const startDate = segments[0].school_date;
  const endDate = addDays(segments[segments.length - 1].school_date, 1);
  const counts = {
    school_days_count: segments.length,
    full_day_count: segments.filter((s) => s.unit === 'FULL_DAY').length,
    half_day_count: segments.filter((s) => s.unit === 'HALF_DAY_AM' || s.unit === 'HALF_DAY_PM').length,
    period_count: segments.filter((s) => s.unit === 'PERIODS').reduce((n, s) => n + s.periods.length, 0),
  };
  const params = routingRule.params_json;
  const isRetro = startDate < today;
  if (isRetro) {
    if (!retroactiveReason) throw validationError([fieldError('retroactive_reason', 'REQUIRED', 'ใบลาย้อนหลังต้องระบุเหตุผลที่ยื่นช้า')]);
    const ageDays = diffDays(startDate, today);
    if (ageDays > params.retroactive_max_days && !requesterRoles.has('STUDENT_AFFAIRS')) {
      throw new AppError('FORBIDDEN', 'retroactive window exceeded', { messageTh: `ยื่นลาย้อนหลังเกิน ${params.retroactive_max_days} วัน ต้องให้กลุ่มงานกิจการนักเรียนดำเนินการ` });
    }
  }
  const approverRole = resolveRoute(params, { leaveType, schoolDaysCount: counts.school_days_count, gradeLevel });
  const needsGuardian = params.guardian_confirmation_required_for.includes(requesterType);
  const guardianStatus = requesterType === 'GUARDIAN' ? 'CONFIRMED' : needsGuardian ? 'PENDING' : 'NOT_REQUIRED';
  const status = guardianStatus === 'PENDING' ? 'PENDING_GUARDIAN' : 'PENDING_SCHOOL';
  const schoolStatus = status === 'PENDING_SCHOOL' ? 'PENDING' : 'NOT_STARTED';
  const attachmentRequired = (params.attachment_required_rules || []).some((r) => r.leave_type === leaveType && counts.school_days_count >= r.min_school_days);
  return {
    segments, start_date: startDate, end_date: endDate, counts, is_retroactive: isRetro, approver_role: approverRole,
    guardian_status: guardianStatus, status, school_status: schoolStatus, attachment_required: attachmentRequired, grade_level: gradeLevel,
  };
}

/**
 * Decision on a pending request. `segmentDecisions` maps segment id → 'APPROVED'|'REJECTED'
 * (omitted = all follow `decision`).
 */
export function planSchoolDecision({ request, segments, decision, segmentDecisions = null, comment }) {
  const action = decision === 'APPROVED' ? 'APPROVE' : decision === 'REJECTED' ? 'REJECT' : decision === 'RETURNED' ? 'RETURN' : decision === 'PARTIALLY_APPROVED' ? 'PARTIAL_APPROVE' : null;
  if (!action) throw validationError([fieldError('decision', 'ENUM', 'ผลพิจารณาไม่ถูกต้อง')]);
  if ((decision === 'REJECTED' || decision === 'RETURNED') && !comment) throw validationError([fieldError('comment', 'REQUIRED', 'กรุณาระบุเหตุผล')]);
  const active = segments.filter((s) => s.status === 'REQUESTED');
  let perSegment;
  if (decision === 'PARTIALLY_APPROVED') {
    if (!segmentDecisions) throw validationError([fieldError('segment_decisions', 'REQUIRED', 'กรุณาระบุผลรายช่วง')]);
    perSegment = active.map((s) => {
      const d = segmentDecisions[s.id];
      if (d !== 'APPROVED' && d !== 'REJECTED') throw validationError([fieldError(`segment_decisions.${s.id}`, 'REQUIRED', 'กรุณาระบุผลทุกช่วง')]);
      return { id: s.id, status: d };
    });
    const nApproved = perSegment.filter((x) => x.status === 'APPROVED').length;
    if (nApproved === 0 || nApproved === perSegment.length) {
      throw validationError([fieldError('decision', 'INCONSISTENT', nApproved === 0 ? 'ไม่มีช่วงที่อนุมัติ ให้เลือก "ไม่อนุมัติ"' : 'อนุมัติทุกช่วง ให้เลือก "อนุมัติ"')]);
    }
    if (!comment) throw validationError([fieldError('comment', 'REQUIRED', 'กรุณาระบุเหตุผลของช่วงที่ไม่อนุมัติ')]);
  } else if (decision === 'APPROVED') {
    perSegment = active.map((s) => ({ id: s.id, status: 'APPROVED' }));
  } else if (decision === 'REJECTED') {
    perSegment = active.map((s) => ({ id: s.id, status: 'REJECTED' }));
  } else {
    perSegment = [];
  }
  const tr = assertTransition('Leave', request.status, action);
  const to = tr.to[0];
  const schoolStatus = decision === 'RETURNED' ? 'RETURNED' : decision;
  return { action, to_status: to, school_status: schoolStatus, segment_updates: perSegment };
}

/** Status after a cancellation request is rejected: derived from segments, not from memory. */
export function statusFromSegments(segments) {
  const decided = segments.filter((s) => s.status === 'APPROVED' || s.status === 'REJECTED');
  const approved = decided.filter((s) => s.status === 'APPROVED').length;
  if (approved === 0) return 'REJECTED';
  return approved === decided.length ? 'APPROVED' : 'PARTIALLY_APPROVED';
}

/** Can this approver role decide given the route? STUDENT_AFFAIRS may always decide (escalation). */
export function approverRoleAllowed(routeRole, principalRoles) {
  if (principalRoles.has('STUDENT_AFFAIRS')) return 'STUDENT_AFFAIRS';
  if (routeRole === 'HOMEROOM_TEACHER' && principalRoles.has('HOMEROOM_TEACHER')) return 'HOMEROOM_TEACHER';
  return null;
}

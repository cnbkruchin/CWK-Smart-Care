// Daily attendance projection (MASTER_PROMPT §7.4, §9). Pure and deterministic: the same inputs
// always yield the same DailyAttendance values on every platform, so reports, dashboard and
// reconciliation share one rule implementation.
//
// Key principles:
//  - Missing gate scan or missing leave is NOT absence; status stays UNKNOWN until verified.
//  - Presence and lateness overlap ("มาแล้ว N คน ในจำนวนนี้สาย M คน").
//  - Approved leave is never deleted by presence evidence; the conflict is surfaced instead.
//  - Late arrival covered by approved morning leave is not counted as late.

import { deterministicId } from '../shared/uuid.js';
import { evaluateArrival } from './lateness.js';
import { segmentOccupancy } from './leave.js';

export const PROJECTION_VERSION = 1;

const ROLL_EVENT_TO_MARK = {
  ROLL_CALL_PRESENT: 'PRESENT',
  ROLL_CALL_ABSENT: 'ABSENT',
  ROLL_CALL_LATE: 'LATE',
  ROLL_CALL_LEAVE_REPORTED: 'LEAVE_REPORTED',
};

/** Events that are still in force: not voided and not superseded by a later event. */
export function activeEvents(events) {
  const superseded = new Set(events.map((e) => e.supersedes_event_id).filter(Boolean));
  return events.filter((e) => !superseded.has(e.id) && e.event_type !== 'EVENT_VOIDED');
}

function byOccurred(a, b) {
  if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1;
  return a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : (a.id < b.id ? -1 : 1);
}

/**
 * @param {object} i
 * @param {string} i.studentId
 * @param {string} i.schoolDate
 * @param {object|null} i.enrollment          effective enrollment on schoolDate
 * @param {string|null} i.gradeLevel
 * @param {{school_day:boolean}} i.dayInfo
 * @param {object[]} i.events                 AttendanceEvents for student/date (all, incl. superseded)
 * @param {object|null} i.rollCallSession     RollCallSessions row for (class, date) if any
 * @param {object[]} i.leaveSegments          LeaveSegments for student/date with parent request status
 * @param {object[]} i.periodsOfDay
 * @param {object|null} i.latenessRule        RuleVersions SCHOOL_LATENESS effective on date
 * @param {string} i.tz
 * @param {string} i.now
 */
export function projectDailyAttendance(i) {
  const id = deterministicId.dailyAttendance(i.studentId, i.schoolDate);
  const eligible = !!i.enrollment;
  const schoolDay = !!(i.dayInfo && i.dayInfo.school_day);
  const act = activeEvents(i.events || []).sort(byOccurred);
  const conflicts = [];

  const arrival = act.find((e) => e.event_type === 'GATE_ARRIVAL') || null;
  const classroom = act.find((e) => e.event_type === 'CLASSROOM_ENTERED') || null;
  const confirmedAbsence = act.find((e) => e.event_type === 'ABSENCE_CONFIRMED') || null;
  const exemption = act.find((e) => e.event_type === 'LATENESS_EXEMPTED') || null;

  // Roll call: class session submitted ⇒ default PRESENT unless an exception event exists.
  let rollMark = 'NOT_MARKED';
  let rollSessionId = null;
  const session = i.rollCallSession && (i.rollCallSession.status === 'SUBMITTED' || i.rollCallSession.status === 'VERIFIED') ? i.rollCallSession : null;
  if (session && i.enrollment && session.class_id === i.enrollment.class_id) {
    rollSessionId = session.id;
    rollMark = 'PRESENT';
    const rollEvents = act.filter((e) => ROLL_EVENT_TO_MARK[e.event_type]);
    if (rollEvents.length) rollMark = ROLL_EVENT_TO_MARK[rollEvents[rollEvents.length - 1].event_type];
  }

  // Leave (approved segments count; pending ones are evidence only).
  const approved = (i.leaveSegments || []).filter((s) => s.status === 'APPROVED' && ['APPROVED', 'PARTIALLY_APPROVED', 'CANCELLATION_REQUESTED'].includes(s.request_status));
  const occ = approved.map((s) => ({ seg: s, o: segmentOccupancy(s, i.periodsOfDay || []) }));
  const hasAm = approved.some((s) => s.unit === 'HALF_DAY_AM');
  const hasPm = approved.some((s) => s.unit === 'HALF_DAY_PM');
  const allPeriods = (i.periodsOfDay || []).map((p) => p.period_no);
  const coveredPeriods = new Set();
  for (const x of occ) for (const p of x.o.periods) coveredPeriods.add(p);
  const fullDayLeave = approved.some((s) => s.unit === 'FULL_DAY') || (hasAm && hasPm)
    || (allPeriods.length > 0 && allPeriods.every((p) => coveredPeriods.has(p)));
  const partialLeave = !fullDayLeave && approved.length > 0;
  const firstPeriod = (i.periodsOfDay || []).slice().sort((a, b) => a.period_no - b.period_no)[0];
  const leaveCoversMorningStart = hasAm || fullDayLeave || (!!firstPeriod && coveredPeriods.has(firstPeriod.period_no));
  const leaveUnits = approved.map((s) => (s.unit === 'FULL_DAY' ? 'FULL' : s.unit === 'HALF_DAY_AM' ? 'AM' : s.unit === 'HALF_DAY_PM' ? 'PM' : (s.periods || []).map((p) => `P${p}`).join(','))).join(';') || null;

  // Lateness from the gate arrival under the rule effective that day.
  let isLate = false;
  let lateMinutes = null;
  if (arrival && i.latenessRule && schoolDay && eligible) {
    const ev = evaluateArrival({ arrivedAt: arrival.occurred_at, schoolDate: i.schoolDate, tz: i.tz, rule: i.latenessRule, gradeLevel: i.gradeLevel });
    isLate = ev.is_late;
    lateMinutes = ev.is_late ? ev.late_minutes : 0;
  } else if (!arrival && rollMark === 'LATE') {
    isLate = true;
  }

  const presenceEvidence = !!arrival || !!classroom || rollMark === 'PRESENT' || rollMark === 'LATE';
  let presence;
  if (!eligible) presence = 'NOT_ELIGIBLE';
  else if (!schoolDay) presence = 'NON_SCHOOL_DAY';
  else if (presenceEvidence) presence = 'PRESENT';
  else if (fullDayLeave) presence = 'ON_LEAVE_FULL_DAY';
  else if (confirmedAbsence) presence = 'ABSENT_CONFIRMED';
  else presence = 'UNKNOWN';

  const latenessExempted = !!exemption;
  const lateCountedReasonBlocked = leaveCoversMorningStart && isLate;
  const lateCounted = presence === 'PRESENT' && isLate && !latenessExempted && !lateCountedReasonBlocked;

  if (eligible && schoolDay) {
    if (arrival && rollMark === 'ABSENT') conflicts.push({ type: 'CONFLICT_ROLLCALL_GATE', refs: [arrival.id, rollSessionId] });
    if (presenceEvidence && fullDayLeave) conflicts.push({ type: 'CONFLICT_LEAVE_PRESENCE', refs: [arrival && arrival.id, ...approved.map((s) => s.leave_request_id)].filter(Boolean) });
    if (presenceEvidence && confirmedAbsence) conflicts.push({ type: 'CONFLICT_ABSENCE_PRESENCE', refs: [confirmedAbsence.id, arrival && arrival.id].filter(Boolean) });
    if (rollMark === 'LEAVE_REPORTED' && !(i.leaveSegments || []).some((s) => ['REQUESTED', 'APPROVED'].includes(s.status))) {
      conflicts.push({ type: 'LEAVE_REPORTED_NO_REQUEST', refs: [rollSessionId] });
    }
  }

  let verification = 'NONE';
  if (arrival) verification = 'GATE_RECORD';
  if (rollMark !== 'NOT_MARKED') verification = 'ROLL_CALL';
  if (confirmedAbsence || (session && session.status === 'VERIFIED')) verification = 'VERIFIED';

  return {
    id,
    student_id: i.studentId,
    school_date: i.schoolDate,
    class_id: i.enrollment ? i.enrollment.class_id : null,
    school_day: schoolDay,
    eligible,
    presence_status: presence,
    verification_level: verification,
    is_late: isLate,
    late_minutes: lateMinutes,
    late_counted: lateCounted,
    lateness_exempted: latenessExempted,
    arrival_event_id: arrival ? arrival.id : null,
    arrived_at: arrival ? arrival.occurred_at : null,
    roll_call_mark: rollMark,
    roll_call_session_id: rollSessionId,
    full_day_leave: fullDayLeave,
    partial_leave: partialLeave,
    leave_units: leaveUnits,
    leave_request_ids: approved.length ? [...new Set(approved.map((s) => s.leave_request_id))].sort() : null,
    confirmed_absence: !!confirmedAbsence,
    has_conflict: conflicts.length > 0,
    conflicts: conflicts.length ? conflicts : null,
    evidence_refs: {
      events: act.map((e) => e.id),
      leave_segments: approved.map((s) => s.id).sort(),
      roll_call_session_id: rollSessionId,
      late_not_counted_reason: isLate && !lateCounted ? (latenessExempted ? 'EXEMPTED' : lateCountedReasonBlocked ? 'LEAVE_COVERS_ARRIVAL' : 'NOT_PRESENT') : null,
    },
    calculated_rule_version_id: i.latenessRule ? i.latenessRule.id : null,
    projection_version: PROJECTION_VERSION,
    computed_at: i.now,
    verified_by: confirmedAbsence ? confirmedAbsence.actor_id : (session && session.status === 'VERIFIED' ? session.verified_by : null),
    verified_at: confirmedAbsence ? confirmedAbsence.recorded_at : (session && session.status === 'VERIFIED' ? session.verified_at : null),
  };
}

/** Fields compared to decide whether a stored projection is stale (computed_at excluded). */
export const PROJECTION_COMPARE_FIELDS = [
  'class_id', 'school_day', 'eligible', 'presence_status', 'verification_level', 'is_late', 'late_minutes', 'late_counted', 'lateness_exempted',
  'arrival_event_id', 'arrived_at', 'roll_call_mark', 'roll_call_session_id', 'full_day_leave', 'partial_leave', 'leave_units', 'leave_request_ids',
  'confirmed_absence', 'has_conflict', 'conflicts', 'evidence_refs', 'calculated_rule_version_id', 'projection_version', 'verified_by', 'verified_at',
];

export function projectionChanged(stored, computed) {
  if (!stored) return true;
  return PROJECTION_COMPARE_FIELDS.some((f) => JSON.stringify(stored[f] ?? null) !== JSON.stringify(computed[f] ?? null));
}

/** Dedupe key for gate arrival events: first arrival per student/day. */
export function arrivalDedupeKey(studentId, schoolDate) {
  return `ARR|${studentId}|${schoolDate}`;
}

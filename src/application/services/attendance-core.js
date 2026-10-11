// Shared attendance plumbing: load the inputs of a (student, date), compute the DailyAttendance
// projection with the domain function, stage it in a ChangeSet (insert/update with version check)
// and raise reconciliation tasks for conflicts. Used by gate, roll call, leave, corrections and jobs.

import { projectDailyAttendance, projectionChanged } from '../../domain/attendance.js';
import { findEffectiveEnrollment } from '../../domain/enrollment.js';
import { deterministicId } from '../../shared/uuid.js';
import { partitionsForDates, ruleFor } from '../context.js';
import { getClass, enrollmentsOf, dayInfoFor, periodsOfDay, listAll } from '../queries.js';

/** All attendance events for the student on the date (incl. superseded), partition-hinted. */
export function* eventsFor(ctx, studentId, date) {
  const rows = yield ctx.store.findBy('AttendanceEvents', 'student_id', studentId, { partitions: partitionsForDates(ctx, [date]) });
  return rows.filter((e) => e.school_date === date);
}

export function* leaveSegmentsFor(ctx, studentId, date) {
  const segs = (yield ctx.store.findBy('LeaveSegments', 'student_id', studentId)).filter((s) => s.school_date === date);
  if (!segs.length) return [];
  const reqs = yield ctx.store.getMany('LeaveRequests', [...new Set(segs.map((s) => s.leave_request_id))]);
  return segs.map((s) => ({ ...s, request_status: (reqs.get(s.leave_request_id) || {}).status || null }));
}

export function* storedProjection(ctx, studentId, date) {
  return yield ctx.store.get('DailyAttendance', deterministicId.dailyAttendance(studentId, date), { partitions: partitionsForDates(ctx, [date]) });
}

/**
 * Compute the projection for (student, date). `overrides` lets a command include writes staged in
 * the current change set (new events, session, segments) before they are committed.
 */
export function* computeDay(ctx, studentId, date, overrides = {}) {
  const enrollment = overrides.enrollment !== undefined ? overrides.enrollment : findEffectiveEnrollment(yield* enrollmentsOf(ctx, studentId), studentId, date);
  const cls = enrollment ? yield* getClass(ctx, enrollment.class_id) : null;
  const gradeLevel = cls ? cls.grade_level : null;
  const info = yield* dayInfoFor(ctx, date, gradeLevel);
  let events = overrides.events || (yield* eventsFor(ctx, studentId, date));
  if (overrides.extraEvents) events = [...events, ...overrides.extraEvents];
  let session = overrides.session;
  if (session === undefined && enrollment) session = yield ctx.store.get('RollCallSessions', deterministicId.rollCallSession(enrollment.class_id, date), { partitions: partitionsForDates(ctx, [date]) });
  let segments = overrides.leaveSegments || (yield* leaveSegmentsFor(ctx, studentId, date));
  if (overrides.segmentPatch) segments = overrides.segmentPatch(segments);
  const rule = yield* ruleFor(ctx, 'SCHOOL_LATENESS', date, { required: false });
  const computed = projectDailyAttendance({
    studentId, schoolDate: date, enrollment, gradeLevel, dayInfo: info, events, rollCallSession: session || null, leaveSegments: segments,
    periodsOfDay: yield* periodsOfDay(ctx, date, gradeLevel), latenessRule: rule, tz: ctx.tz, now: ctx.now,
  });
  const stored = overrides.stored !== undefined ? overrides.stored : yield* storedProjection(ctx, studentId, date);
  return { computed, stored, enrollment, cls, info, events, rule };
}

/** Stage insert/update of the projection; returns the record that will be committed (or stored). */
export function stageProjection(cs, computed, stored) {
  const pending = cs.writes.find((w) => w.table === 'DailyAttendance' && w.record.id === computed.id);
  if (pending) return cs.update('DailyAttendance', pending.record, computed);
  if (!stored) return cs.insert('DailyAttendance', computed);
  if (!projectionChanged(stored, computed)) return stored;
  return cs.update('DailyAttendance', stored, computed);
}

const TASK_TEXT = {
  CONFLICT_LEAVE_PRESENCE: 'มีใบลาที่อนุมัติแต่พบหลักฐานการมาเรียน — ตรวจสอบและบันทึกการใช้ใบลา',
  CONFLICT_ROLLCALL_GATE: 'เช็กชื่อว่าไม่พบตัว แต่มีบันทึกมาถึงที่ประตู — ตรวจสอบตัวนักเรียน',
  CONFLICT_ABSENCE_PRESENCE: 'ยืนยันขาดแล้วแต่พบหลักฐานการมาเรียน — แก้ไขข้อมูลด้วย correction',
  LEAVE_REPORTED_NO_REQUEST: 'แจ้งลาด้วยวาจาแต่ยังไม่มีใบลาในระบบ — ติดตามให้ผู้ปกครองยื่นใบลา',
};

/** Create reconciliation tasks for new conflict types (deduped by type|student|date). */
export function* stageConflictTasks(ctx, cs, computed) {
  if (!computed.has_conflict) return [];
  const created = [];
  for (const c of computed.conflicts) {
    const type = c.type === 'CONFLICT_ABSENCE_PRESENCE' ? 'CONFLICT_LEAVE_PRESENCE' : c.type;
    const dedupe = `${c.type}|${computed.student_id}|${computed.school_date}`;
    const id = deterministicId.reconciliationTask(dedupe);
    if (cs.writes.some((w) => w.table === 'ReconciliationTasks' && w.record.id === id)) continue;
    if (yield ctx.store.get('ReconciliationTasks', id)) continue;
    created.push(cs.insert('ReconciliationTasks', {
      id, task_type: ['UNKNOWN_STATUS', 'CONFLICT_LEAVE_PRESENCE', 'CONFLICT_ROLLCALL_GATE', 'OFFLINE_REVIEW', 'IMPORT_REVIEW', 'LEAVE_REPORTED_NO_REQUEST', 'DATA_QUALITY'].includes(type) ? type : 'DATA_QUALITY',
      student_id: computed.student_id, class_id: computed.class_id, school_date: computed.school_date, evidence_refs: { refs: c.refs, conflict: c.type },
      description_th: TASK_TEXT[c.type] || 'ข้อมูลขัดกัน ต้องตรวจสอบ', assigned_role: 'HOMEROOM_TEACHER', status: 'OPEN', dedupe_key: dedupe,
    }));
  }
  return created;
}

/** Recompute & stage the projection for a student/date; returns {record, computed}. */
export function* refreshDay(ctx, cs, studentId, date, overrides = {}) {
  const r = yield* computeDay(ctx, studentId, date, overrides);
  const record = stageProjection(cs, r.computed, r.stored);
  yield* stageConflictTasks(ctx, cs, r.computed);
  return { ...r, record };
}

export function staffClassScope(ctx) {
  return ctx.principal && ctx.principal.facts ? ctx.principal.facts.homeroomClassIds : new Set();
}

/**
 * Batch preload for many students on one date (roll call, class views, jobs): one read per table
 * instead of several lookups per student — essential on Sheets.
 * Returns overrides per student usable with computeDay/refreshDay.
 */
export { listAll };

export function* preloadDay(ctx, date, studentIds) {
  const parts = partitionsForDates(ctx, [date]);
  const want = new Set(studentIds);
  const events = yield* listAll(ctx, 'AttendanceEvents', { where: { school_date: date }, partitions: parts });
  const segs = yield* listAll(ctx, 'LeaveSegments', { where: { school_date: date } });
  const reqs = segs.length ? yield ctx.store.getMany('LeaveRequests', [...new Set(segs.map((s) => s.leave_request_id))]) : new Map();
  const stored = yield ctx.store.getMany('DailyAttendance', studentIds.map((id) => deterministicId.dailyAttendance(id, date)), { partitions: parts });
  const out = new Map();
  for (const id of want) out.set(id, { events: [], leaveSegments: [], stored: stored.get(deterministicId.dailyAttendance(id, date)) || null });
  for (const e of events) if (want.has(e.student_id)) out.get(e.student_id).events.push(e);
  for (const sg of segs) if (want.has(sg.student_id)) out.get(sg.student_id).leaveSegments.push({ ...sg, request_status: (reqs.get(sg.leave_request_id) || {}).status || null });
  return out;
}

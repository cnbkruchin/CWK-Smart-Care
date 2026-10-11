// Attendance background jobs and their schedules (MASTER_PROMPT §7.4, §10.3).
import { createContext, ruleFor, setting } from '../context.js';
import { systemPrincipal } from '../principal.js';
import { computeDay, preloadDay, refreshDay, stageProjection, listAll } from '../services/attendance-core.js';
import { emitNotification, homeroomRecipients } from '../services/notify.js';
import { enqueueOnceEver } from '../jobs.js';
import { dayInfo } from '../../domain/calendar.js';
import { rosterForClass } from '../../domain/enrollment.js';
import { dateInRange, localPartsOf, eachDate, addDays, hhmmToMinutes } from '../../shared/time.js';
import { deterministicId, SYSTEM_USER_ID } from '../../shared/uuid.js';
import { allCalendar } from '../queries.js';

const CHUNK = 150;

function* enrolledOn(ctx, date) {
  const all = yield* listAll(ctx, 'Enrollments', { where: { effective_from: { lte: date } } });
  return all.filter((e) => dateInRange(date, e.effective_from, e.effective_to));
}

/** Create UNKNOWN projections for everyone eligible today (dense daily rows), chunked + resumable. */
export function* openDayJob(ctx, job, { checkpoint, timeLeftMs }) {
  const date = job.payload_json.school_date;
  const roster = (yield* enrolledOn(ctx, date)).sort((a, b) => (a.class_id < b.class_id ? -1 : a.class_id > b.class_id ? 1 : (a.roll_no || 0) - (b.roll_no || 0)));
  let cursor = job.cursor_json || { next: 0, created: 0 };
  while (cursor.next < roster.length) {
    if (timeLeftMs() < 45000) return { done: false };
    const slice = roster.slice(cursor.next, cursor.next + CHUNK);
    const pre = yield* preloadDay(ctx, date, slice.map((e) => e.student_id));
    const cs = ctx.changeSet('attendance.openDay');
    let created = 0;
    for (const e of slice) {
      const p = pre.get(e.student_id);
      if (p.stored) continue;
      const { computed } = yield* computeDay(ctx, e.student_id, date, { ...p, enrollment: e, stored: null });
      if (!computed.school_day) continue;
      stageProjection(cs, computed, null);
      created++;
    }
    if (!cs.isEmpty) yield ctx.mutations.commit(cs.build({ result: {} }));
    cursor = { next: cursor.next + slice.length, created: cursor.created + created };
    yield* checkpoint(cursor, { done: cursor.next, total: roster.length, message_th: `สร้างรายการวันนี้ ${cursor.next}/${roster.length}` });
  }
  return { done: true, result: cursor };
}

export function* recomputeStudentJob(ctx, job, { checkpoint, timeLeftMs }) {
  const { student_id: sid, from_date: from, to_date: to } = job.payload_json;
  const dates = eachDate(from, addDays(to, 1), 400);
  let cursor = job.cursor_json || { next: 0, changed: 0 };
  while (cursor.next < dates.length) {
    if (timeLeftMs() < 45000) return { done: false };
    const slice = dates.slice(cursor.next, cursor.next + 20);
    const cs = ctx.changeSet('attendance.recomputeStudent');
    for (const d of slice) {
      const r = yield* computeDay(ctx, sid, d);
      if (!r.stored && !r.computed.eligible) continue;
      stageProjection(cs, r.computed, r.stored);
    }
    const changed = cs.writes.filter((w) => w.table === 'DailyAttendance').length;
    if (!cs.isEmpty) yield ctx.mutations.commit(cs.build({ result: {} }));
    cursor = { next: cursor.next + slice.length, changed: cursor.changed + changed };
    yield* checkpoint(cursor, { done: cursor.next, total: dates.length, message_th: `คำนวณใหม่ ${cursor.next}/${dates.length} วัน` });
  }
  return { done: true, result: cursor };
}

export function* recomputeDateJob(ctx, job, { checkpoint, timeLeftMs }) {
  const date = job.payload_json.school_date;
  const roster = yield* enrolledOn(ctx, date);
  let cursor = job.cursor_json || { next: 0, changed: 0 };
  while (cursor.next < roster.length) {
    if (timeLeftMs() < 45000) return { done: false };
    const slice = roster.slice(cursor.next, cursor.next + CHUNK);
    const pre = yield* preloadDay(ctx, date, slice.map((e) => e.student_id));
    const cs = ctx.changeSet('attendance.recomputeDate');
    for (const e of slice) yield* refreshDay(ctx, cs, e.student_id, date, { ...pre.get(e.student_id), enrollment: e });
    const changed = cs.writes.filter((w) => w.table === 'DailyAttendance').length;
    if (!cs.isEmpty) yield ctx.mutations.commit(cs.build({ result: {} }));
    cursor = { next: cursor.next + slice.length, changed: cursor.changed + changed };
    yield* checkpoint(cursor, { done: cursor.next, total: roster.length, message_th: `คำนวณใหม่ ${cursor.next}/${roster.length} คน` });
  }
  return { done: true, result: cursor };
}

/** After the verification time: one task + reminder per class that still has UNKNOWN students. */
export function* unknownCheckJob(ctx, job) {
  const date = job.payload_json.school_date;
  const enrollments = yield* listAll(ctx, 'Enrollments', { where: { effective_from: { lte: date } } });
  const classes = (yield ctx.store.list('Classes', { limit: 500 })).items;
  let tasks = 0;
  for (const cls of classes) {
    const roster = rosterForClass(enrollments, cls.id, date);
    if (!roster.length) continue;
    const pre = yield* preloadDay(ctx, date, roster.map((e) => e.student_id));
    const unknown = [];
    for (const e of roster) {
      const { computed } = yield* computeDay(ctx, e.student_id, date, { ...pre.get(e.student_id), enrollment: e });
      if (computed.presence_status === 'UNKNOWN') unknown.push(e.student_id);
    }
    if (!unknown.length) continue;
    const dedupe = `UNKNOWN_STATUS|${cls.id}|${date}`;
    const id = deterministicId.reconciliationTask(dedupe);
    if (yield ctx.store.get('ReconciliationTasks', id)) continue;
    const cs = ctx.changeSet('attendance.unknownCheck');
    const t = cs.insert('ReconciliationTasks', {
      id, task_type: 'UNKNOWN_STATUS', class_id: cls.id, school_date: date, evidence_refs: { student_ids: unknown }, description_th: `ห้อง ${cls.name_th} มีนักเรียน ${unknown.length} คนยังไม่ทราบสถานะ — ตรวจสอบก่อนยืนยันขาด`,
      assigned_role: 'HOMEROOM_TEACHER', status: 'OPEN', dedupe_key: dedupe,
    });
    yield* emitNotification(ctx, cs, { type: 'ROLL_CALL_REMINDER', sourceEntityType: 'ReconciliationTasks', sourceEntityId: t.id, params: { class_name: cls.name_th, count: unknown.length, school_date: date }, recipients: yield* homeroomRecipients(ctx, cls.id), noAck: true });
    yield ctx.mutations.commit(cs.build({ result: {} }));
    tasks++;
  }
  return { done: true, result: { tasks } };
}

export const ATTENDANCE_TICK = {
  name: 'attendance.schedule',
  *run(deps) {
    const ctx = yield* createContext(deps, { operation: 'tick.attendance', channel: 'JOB' });
    ctx.principal = systemPrincipal(SYSTEM_USER_ID);
    const info = dayInfo({ date: ctx.today, gradeLevel: null, terms: ctx.terms, calendarEntries: yield* allCalendar(ctx) });
    const out = { school_day: info.school_day };
    if (!info.school_day) return out;
    const nowMin = (() => { const p = localPartsOf(ctx.now, ctx.tz); return p.hh * 60 + p.mm; })();
    const openAt = hhmmToMinutes(String(yield* setting(ctx, 'attendance.open_day_time', '05:30')));
    if (nowMin >= openAt) out.open_day = yield* enqueueOnceEver(ctx, { job_type: 'attendance.openDay', payload: { school_date: ctx.today }, dedupe_key: `openDay|${ctx.today}`, priority: 8 });
    const verify = yield* ruleFor(ctx, 'ABSENCE_VERIFICATION', ctx.today, { required: false });
    if (verify && nowMin >= hhmmToMinutes(verify.params_json.verify_after_time)) {
      out.unknown_check = yield* enqueueOnceEver(ctx, { job_type: 'attendance.unknownCheck', payload: { school_date: ctx.today }, dedupe_key: `unknownCheck|${ctx.today}`, priority: 6 });
    }
    return out;
  },
};

export const ATTENDANCE_JOB_HANDLERS = {
  'attendance.openDay': openDayJob,
  'attendance.recomputeStudent': recomputeStudentJob,
  'attendance.recomputeDate': recomputeDateJob,
  'attendance.unknownCheck': unknownCheckJob,
};

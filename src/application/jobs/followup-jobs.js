// Follow-up background work (MASTER_PROMPT §7.6, §11.1):
//   followup.evaluateDate — after school, evaluate follow-up rules for students with a counted late or
//                           a confirmed absence that day (chunked, resumable, idempotent via dedupe keys)
//   tick: schedule the daily evaluation; remind owners of overdue cases once per due date; mark
//         unacknowledged required notifications FOLLOW_UP_REQUIRED and open an ACK_TIMEOUT case for guardians.
import { createContext, setting, partitionsForDates } from '../context.js';
import { systemPrincipal } from '../principal.js';
import { enqueueOnceEver } from '../jobs.js';
import { evaluateStudentRules, stageNewCase, defaultOwner } from '../services/followup.js';
import { emitNotification, studentShortName } from '../services/notify.js';
import { allCalendar } from '../queries.js';
import { dayInfo } from '../../domain/calendar.js';
import { caseDedupeKey } from '../../domain/followup.js';
import { localPartsOf, hhmmToMinutes, addDays, addMinutesIso, schoolDateOf } from '../../shared/time.js';
import { SYSTEM_USER_ID } from '../../shared/uuid.js';
import { isAppError } from '../../shared/errors.js';
import { TEMPLATES } from '../services/templates.js';

const CHUNK = 40;

export function* evaluateDateJob(ctx, job, { checkpoint, timeLeftMs }) {
  const date = job.payload_json.school_date;
  const rows = yield ctx.store.findBy('DailyAttendance', 'school_date', date, { partitions: partitionsForDates(ctx, [date]) });
  const studentIds = [...new Set(rows.filter((r) => r.late_counted || (r.is_late && r.lateness_exempted) || r.presence_status === 'ABSENT_CONFIRMED').map((r) => r.student_id))].sort();
  let cursor = job.cursor_json || { next: 0, opened: 0 };
  while (cursor.next < studentIds.length) {
    if (timeLeftMs() < 40000) return { done: false };
    const slice = studentIds.slice(cursor.next, cursor.next + CHUNK);
    let opened = 0;
    for (const sid of slice) {
      const student = yield ctx.store.get('Students', sid);
      if (!student || student.status !== 'ACTIVE') continue;
      const cs = ctx.changeSet('followup.evaluate');
      const res = yield* evaluateStudentRules(ctx, cs, student, date);
      if (cs.isEmpty) continue;
      try {
        yield ctx.mutations.commit(cs.build({ result: {} }));
        opened += res.opened.length;
      } catch (e) {
        // a concurrent run opened the same case first (partial unique dedupe_key) — nothing to do
        if (!(isAppError(e) && e.code === 'UNIQUE_VIOLATION')) throw e;
      }
    }
    cursor = { next: cursor.next + slice.length, opened: cursor.opened + opened };
    yield* checkpoint(cursor, { done: cursor.next, total: studentIds.length, opened: cursor.opened });
  }
  return { done: true, result: { candidates: studentIds.length, opened: cursor.opened } };
}

/** CASE_OVERDUE once per (case, due date). */
function* overdueReminders(ctx, limit = 30) {
  const cases = (yield ctx.store.list('Cases', { where: { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE'] } }, limit: 500 })).items
    .filter((c) => c.due_at && c.due_at < ctx.now && c.owner_user_id);
  let sent = 0;
  for (const c of cases) {
    if (sent >= limit) break;
    const due = schoolDateOf(c.due_at, ctx.tz);
    const prior = yield ctx.store.findBy('Notifications', 'source_entity_id', c.id);
    if (prior.some((n) => n.notification_type === 'CASE_OVERDUE' && n.params_json && n.params_json.due_date === due)) continue;
    const owner = yield ctx.store.get('Users', c.owner_user_id);
    const student = yield ctx.store.get('Students', c.student_id);
    if (!owner || owner.status !== 'ACTIVE' || !student) continue;
    const cs = ctx.changeSet('followup.overdue');
    yield* emitNotification(ctx, cs, {
      type: 'CASE_OVERDUE', sourceEntityType: 'Cases', sourceEntityId: c.id, studentId: c.student_id, purpose: `overdue|${due}`,
      params: { student_name: studentShortName(student), due_date: due }, recipients: [{ user: owner, role: 'HOMEROOM_TEACHER' }], noAck: true,
    });
    yield ctx.mutations.commit(cs.build({ result: {} }));
    sent++;
  }
  return sent;
}

/** Required acknowledgements past due → FOLLOW_UP_REQUIRED; guardians' → one ACK_TIMEOUT case per notification. */
function* ackTimeouts(ctx, limit = 30) {
  const parts = partitionsForDates(ctx, [addDays(ctx.today, -30), ctx.today]);
  const due = (yield ctx.store.list('NotificationRecipients', { where: { ack_state: 'PENDING_ACK' }, partitions: parts, limit: 500 })).items
    .filter((r) => r.ack_due_at && r.ack_due_at < ctx.now).slice(0, limit);
  let marked = 0;
  let opened = 0;
  for (const r of due) {
    const n = yield ctx.store.get('Notifications', r.notification_id, { partitions: parts });
    const cs = ctx.changeSet('followup.ack_timeout');
    cs.update('NotificationRecipients', r, { ack_state: 'FOLLOW_UP_REQUIRED' });
    if (n && n.student_id && r.recipient_role_context === 'GUARDIAN') {
      const key = caseDedupeKey('ACK_TIMEOUT', n.student_id, n.id);
      const exists = (yield ctx.store.findBy('Cases', 'dedupe_key', key)).length > 0 || cs.writes.some((w) => w.table === 'Cases' && w.record.dedupe_key === key);
      const student = yield ctx.store.get('Students', n.student_id);
      if (!exists && student) {
        const owner = yield* defaultOwner(ctx, student.id);
        yield* stageNewCase(ctx, cs, {
          student, caseType: 'ACK_TIMEOUT', dedupeKey: key, priority: n.urgency === 'URGENT' ? 'URGENT' : 'HIGH', owner, dueAt: addMinutesIso(ctx.now, 24 * 60),
          summaryTh: `ผู้ปกครองยังไม่กดรับทราบ "${TEMPLATES[n.notification_type].title}" ภายในเวลาที่กำหนด — ติดต่อด้วยช่องทางอื่น`,
          evidence: { notification_id: n.id, notification_type: n.notification_type, recipient_id: r.id, ack_due_at: r.ack_due_at }, nextActionTh: 'โทรติดต่อผู้ปกครองและบันทึกผล',
        });
        opened++;
      }
    }
    try {
      yield ctx.mutations.commit(cs.build({ result: {} }));
      marked++;
    } catch (e) {
      if (!(isAppError(e) && ['CONFLICT', 'UNIQUE_VIOLATION'].includes(e.code))) throw e;
    }
  }
  return { marked, opened };
}

export const FOLLOWUP_TICK = {
  name: 'followup.schedule',
  *run(deps) {
    const ctx = yield* createContext(deps, { operation: 'tick.followup', channel: 'JOB' });
    ctx.principal = systemPrincipal(SYSTEM_USER_ID);
    const out = {};
    const cal = yield* allCalendar(ctx);
    const isSchool = (d) => dayInfo({ date: d, gradeLevel: null, terms: ctx.terms, calendarEntries: cal }).school_day;
    const p = localPartsOf(ctx.now, ctx.tz);
    const evalAt = hhmmToMinutes(String(yield* setting(ctx, 'followup.evaluate_time', '16:30')));
    if (isSchool(ctx.today) && p.hh * 60 + p.mm >= evalAt) {
      out.evaluate = yield* enqueueOnceEver(ctx, { job_type: 'followup.evaluateDate', payload: { school_date: ctx.today }, dedupe_key: `followupEval|${ctx.today}`, priority: 4 });
    }
    // catch up the previous school day if the tick did not run after school that day
    let prev = addDays(ctx.today, -1);
    for (let i = 0; i < 10 && !isSchool(prev); i++) prev = addDays(prev, -1);
    if (isSchool(prev)) out.evaluate_prev = yield* enqueueOnceEver(ctx, { job_type: 'followup.evaluateDate', payload: { school_date: prev }, dedupe_key: `followupEval|${prev}`, priority: 4 });
    out.overdue = yield* overdueReminders(ctx);
    out.ack = yield* ackTimeouts(ctx);
    return out;
  },
};

export const FOLLOWUP_JOB_HANDLERS = { 'followup.evaluateDate': evaluateDateJob };

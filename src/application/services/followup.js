// Follow-up services (MASTER_PROMPT §7.6): rule evaluation against the DailyAttendance projection,
// case creation with dedupe + cooldown, owner resolution and case events. Ops and jobs share these.
import { ruleFor, partitionsForDates } from '../context.js';
import { allCalendar, enrollmentsOf, getClass } from '../queries.js';
import { emitNotification, homeroomRecipients, roleRecipients, studentShortName } from './notify.js';
import { dayInfo } from '../../domain/calendar.js';
import { findEffectiveEnrollment } from '../../domain/enrollment.js';
import { evaluateCountRule, schoolDaysBack, schoolDaysForward, caseDedupeKey, RULE_CASE_TYPES } from '../../domain/followup.js';
import { addDays, addMinutesIso, localToUtc, schoolDateOf } from '../../shared/time.js';

export const FOLLOWUP_RULE_TYPES = Object.keys(RULE_CASE_TYPES);

/** Memoised school-day predicate for a grade (calendar exceptions per level are honoured). */
export function* schoolDayPredicate(ctx, gradeLevel = null) {
  const calendarEntries = yield* allCalendar(ctx);
  const memo = new Map();
  return (date) => {
    if (!memo.has(date)) memo.set(date, dayInfo({ date, gradeLevel, terms: ctx.terms, calendarEntries }).school_day);
    return memo.get(date);
  };
}

/** Current class of a student (as of `date`), or null. */
export function* currentClassOf(ctx, studentId, date = null) {
  const enr = findEffectiveEnrollment(yield* enrollmentsOf(ctx, studentId), studentId, date || ctx.today);
  return enr ? yield* getClass(ctx, enr.class_id) : null;
}

const byId = (a, b) => (a.user.id < b.user.id ? -1 : 1);

/** Default owner {user, role}: an active homeroom teacher of the current class, else a STUDENT_AFFAIRS user. */
export function* defaultOwner(ctx, studentId) {
  const cls = yield* currentClassOf(ctx, studentId);
  const homeroom = cls ? yield* homeroomRecipients(ctx, cls.id) : [];
  if (homeroom.length) return [...homeroom].sort(byId)[0];
  const affairs = yield* roleRecipients(ctx, 'STUDENT_AFFAIRS');
  return affairs.length ? [...affairs].sort(byId)[0] : null;
}

export function caseEvent(cs, ctx, kase, eventType, { data = null, note = null } = {}) {
  return cs.insert('CaseEvents', { case_id: kase.id, event_type: eventType, actor_id: ctx.principal.user_id, occurred_at: ctx.now, data_json: data, note, operation_id: cs.operationId });
}

/**
 * Stage a new case + OPENED event + CASE_NEW notification to the owner.
 * @returns the inserted case
 */
export function* stageNewCase(ctx, cs, { student, caseType, dedupeKey, priority = 'NORMAL', dueAt = null, owner = null /* {user, role} */, summaryTh, evidence = null, ruleVersionId = null, nextActionTh = null, notify = null }) {
  const kase = cs.insert('Cases', {
    student_id: student.id, case_type: caseType, rule_version_id: ruleVersionId, trigger_summary_th: summaryTh, trigger_evidence_json: evidence, dedupe_key: dedupeKey,
    status: 'OPEN', priority, owner_user_id: owner ? owner.user.id : null, due_at: dueAt, next_action_th: nextActionTh || 'ติดต่อผู้ปกครองและบันทึกผล', reopened_count: 0,
  });
  caseEvent(cs, ctx, kase, 'OPENED', { data: { case_type: caseType, owner_user_id: kase.owner_user_id, rule_version_id: ruleVersionId } });
  cs.audit({ action: 'case.open', entityType: 'Cases', entityId: kase.id, studentId: student.id, after: { case_type: caseType, priority, owner_user_id: kase.owner_user_id } });
  if (owner) {
    yield* emitNotification(ctx, cs, {
      type: notify ? notify.type : 'CASE_NEW', sourceEntityType: 'Cases', sourceEntityId: kase.id, studentId: student.id, purpose: `open|${kase.reopened_count}`,
      params: { student_name: studentShortName(student), summary_th: summaryTh, ...(notify ? notify.params : {}) }, recipients: [owner],
    });
  }
  return kase;
}

/**
 * Evaluate every active follow-up rule for one student as of `asOf` and stage cases that fire.
 * Dedupe: one open case per (rule case type, student) — the partial unique key enforces it under the
 * lock too. Re-open policy after closing: facts on/before the close date never count again, and no
 * new case opens before `cooldown_until`.
 * @returns {Promise<{opened:object[], skipped:object[]}>}
 */
export function* evaluateStudentRules(ctx, cs, student, asOf) {
  const out = { opened: [], skipped: [] };
  const cls = yield* currentClassOf(ctx, student.id, asOf);
  const isSchool = yield* schoolDayPredicate(ctx, cls ? cls.grade_level : null);
  const cases = yield ctx.store.findBy('Cases', 'student_id', student.id);
  let rows = null;
  for (const ruleType of FOLLOWUP_RULE_TYPES) {
    const rule = yield* ruleFor(ctx, ruleType, asOf, { required: false });
    if (!rule) { out.skipped.push({ rule_type: ruleType, reason: 'NO_ACTIVE_RULE' }); continue; }
    const caseType = RULE_CASE_TYPES[ruleType];
    const key = caseDedupeKey(caseType, student.id);
    const same = cases.filter((c) => c.dedupe_key === key);
    if (same.some((c) => c.status !== 'CLOSED') || cs.writes.some((w) => w.table === 'Cases' && w.record.dedupe_key === key && w.record.status !== 'CLOSED')) {
      out.skipped.push({ rule_type: ruleType, reason: 'OPEN_CASE_EXISTS' }); continue;
    }
    const lastClosed = same.filter((c) => c.closed_at).sort((a, b) => (a.closed_at < b.closed_at ? 1 : -1))[0] || null;
    if (lastClosed && lastClosed.cooldown_until && ctx.now < lastClosed.cooldown_until) { out.skipped.push({ rule_type: ruleType, reason: 'COOLDOWN' }); continue; }
    const windowDates = schoolDaysBack(asOf, rule.params_json.window_school_days, isSchool, addDays);
    if (!windowDates.length) { out.skipped.push({ rule_type: ruleType, reason: 'NO_SCHOOL_DAYS' }); continue; }
    if (!rows) rows = yield ctx.store.findBy('DailyAttendance', 'student_id', student.id, { partitions: partitionsForDates(ctx, [windowDates[0], asOf]) });
    const sinceDate = lastClosed ? schoolDateOf(lastClosed.closed_at, ctx.tz) : null;
    const ev = evaluateCountRule({ ruleType, params: rule.params_json, rows, windowDates, sinceDate });
    if (!ev.fired) { out.skipped.push({ rule_type: ruleType, reason: 'BELOW_THRESHOLD', count: ev.count }); continue; }
    const owner = yield* defaultOwner(ctx, student.id);
    const kase = yield* stageNewCase(ctx, cs, {
      student, caseType, dedupeKey: key, priority: rule.params_json.priority, owner, summaryTh: ev.summary_th, ruleVersionId: rule.id,
      dueAt: addMinutesIso(ctx.now, rule.params_json.due_in_days * 24 * 60),
      evidence: { rule_type: ruleType, rule_version_no: rule.version_no, is_example_rule: !!rule.is_example, window_from: ev.window_from, window_to: ev.window_to, count: ev.count, threshold: ev.threshold, items: ev.evidence, since_date: sinceDate },
    });
    out.opened.push({ case_id: kase.id, case_type: caseType, count: ev.count });
  }
  return out;
}

/** cooldown_until for a closing rule case (school days after the close date), or null. */
export function* cooldownUntil(ctx, kase) {
  if (!kase.rule_version_id) return null;
  const rule = yield ctx.store.get('RuleVersions', kase.rule_version_id);
  const days = rule && rule.params_json ? rule.params_json.cooldown_school_days || 0 : 0;
  if (!days) return null;
  const cls = yield* currentClassOf(ctx, kase.student_id);
  const isSchool = yield* schoolDayPredicate(ctx, cls ? cls.grade_level : null);
  const until = schoolDaysForward(ctx.today, days, isSchool, addDays);
  return localToUtc(until, '00:00', ctx.tz);
}

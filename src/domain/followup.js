// Follow-up rules (MASTER_PROMPT §7.6). Pure functions: count defined facts from the DailyAttendance
// projection over a window of SCHOOL days and say whether a versioned rule fires, with the evidence.
// The system never judges behaviour, guilt or punishment — it opens a case for a person to follow up.

export const RULE_CASE_TYPES = Object.freeze({ FOLLOWUP_LATE_COUNT: 'RULE_LATE_COUNT', FOLLOWUP_ABSENCE_COUNT: 'RULE_ABSENCE_COUNT' });

/** One open case per (type, student) for rule cases; manual/callback cases carry their own key. */
export function caseDedupeKey(caseType, studentId, extra = null) {
  return extra ? `${caseType}|${studentId}|${extra}` : `${caseType}|${studentId}`;
}

/**
 * The last `n` school days up to and including `asOf`, oldest first.
 * @param {(date:string)=>boolean} isSchoolDay
 */
export function schoolDaysBack(asOf, n, isSchoolDay, addDays, maxCalendarDays = 400) {
  const out = [];
  let d = asOf;
  for (let i = 0; i < maxCalendarDays && out.length < n; i++) {
    if (isSchoolDay(d)) out.push(d);
    d = addDays(d, -1);
  }
  return out.reverse();
}

/** The date `n` school days after `from` (exclusive of `from`); falls back to calendar days past the horizon. */
export function schoolDaysForward(from, n, isSchoolDay, addDays, maxCalendarDays = 400) {
  if (n <= 0) return from;
  let d = from;
  let count = 0;
  for (let i = 0; i < maxCalendarDays; i++) {
    d = addDays(d, 1);
    if (isSchoolDay(d)) { count++; if (count >= n) return d; }
  }
  return addDays(from, n);
}

function countsAsLate(row, params) {
  if (row.late_counted) return true;
  return !!(params.count_exempted && row.is_late && row.lateness_exempted);
}

/**
 * Evaluate a count rule.
 * @param {object} a
 * @param {'FOLLOWUP_LATE_COUNT'|'FOLLOWUP_ABSENCE_COUNT'} a.ruleType
 * @param {object} a.params           rule params (validated against RULE_PARAM_SCHEMAS)
 * @param {object[]} a.rows           DailyAttendance rows of the student (any dates)
 * @param {string[]} a.windowDates    school days of the window (oldest first)
 * @param {string|null} a.sinceDate   facts on/before this date were already handled by a closed case
 * @returns {{fired:boolean, count:number, threshold:number, window_from:string|null, window_to:string|null, evidence:object[], summary_th:string}}
 */
export function evaluateCountRule({ ruleType, params, rows, windowDates, sinceDate = null }) {
  const inWindow = new Set(windowDates.filter((d) => !sinceDate || d > sinceDate));
  const byDate = new Map();
  for (const r of rows) if (inWindow.has(r.school_date) && r.eligible !== false && r.school_day !== false) byDate.set(r.school_date, r);
  const hits = [...byDate.values()]
    .filter((r) => (ruleType === 'FOLLOWUP_LATE_COUNT' ? countsAsLate(r, params) : r.presence_status === 'ABSENT_CONFIRMED'))
    .sort((a, b) => (a.school_date < b.school_date ? -1 : 1));
  const evidence = hits.map((r) => (ruleType === 'FOLLOWUP_LATE_COUNT'
    ? { daily_attendance_id: r.id, school_date: r.school_date, arrived_at: r.arrived_at || null, late_minutes: r.late_minutes || 0, exempted: !!r.lateness_exempted }
    : { daily_attendance_id: r.id, school_date: r.school_date }));
  const dates = [...inWindow].sort();
  const what = ruleType === 'FOLLOWUP_LATE_COUNT' ? 'มาสาย' : 'ขาดเรียน (ยืนยันแล้ว)';
  return {
    fired: hits.length >= params.threshold_count,
    count: hits.length,
    threshold: params.threshold_count,
    window_from: dates[0] || null,
    window_to: dates[dates.length - 1] || null,
    evidence,
    summary_th: `${what} ${hits.length} ครั้งใน ${params.window_school_days} วันเรียนล่าสุด (เกณฑ์ ${params.threshold_count} ครั้ง)`,
  };
}

/** Case status after logging a contact with `outcome`. */
export function statusAfterContact(outcome) {
  return ['NO_ANSWER', 'FOLLOW_UP_NEEDED', 'WRONG_CONTACT'].includes(outcome) ? 'WAITING_RESPONSE' : 'IN_PROGRESS';
}

export function isCaseOpen(status) {
  return status !== 'CLOSED';
}

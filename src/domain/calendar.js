// School calendar & term resolution. Default: Monday–Friday inside a term are school days;
// SchoolCalendar rows override per date (level-specific row beats all-level row).

import { isoWeekday, addDays } from '../shared/time.js';

export const COUNTING_DAY_TYPES = new Set(['SCHOOL_DAY', 'EXAM_DAY', 'ACTIVITY_DAY']);

export function termForDate(terms, date) {
  return terms.find((t) => date >= t.start_date && date < t.end_date) || null;
}

/**
 * Partition key for operational tables. Dates outside any term (vacations) go to the most recent
 * term that started on/before the date, so every date maps deterministically to one partition.
 */
export function partitionKeyForDate(terms, date) {
  const t = termForDate(terms, date);
  if (t) return t.code;
  const earlier = terms.filter((x) => x.start_date <= date).sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  if (earlier.length) return earlier[0].code;
  const later = [...terms].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  return later.length ? later[0].code : 'UNPARTITIONED';
}

/**
 * @returns {{school_day: boolean, day_type: string, source: 'CALENDAR'|'DEFAULT', term_code: string|null}}
 */
export function dayInfo({ date, gradeLevel = null, terms, calendarEntries }) {
  const forDate = calendarEntries.filter((c) => c.calendar_date === date);
  const specific = gradeLevel ? forDate.find((c) => c.applies_to_level === gradeLevel) : null;
  const general = forDate.find((c) => c.applies_to_level == null);
  const entry = specific || general;
  const term = termForDate(terms, date);
  if (entry) {
    return { school_day: COUNTING_DAY_TYPES.has(entry.day_type) && !!term, day_type: entry.day_type, source: 'CALENDAR', term_code: term ? term.code : null };
  }
  const weekday = isoWeekday(date);
  const isWeekday = weekday >= 1 && weekday <= 5;
  return { school_day: !!term && isWeekday, day_type: !!term && isWeekday ? 'SCHOOL_DAY' : 'NO_SCHOOL', source: 'DEFAULT', term_code: term ? term.code : null };
}

export function isSchoolDay(args) {
  return dayInfo(args).school_day;
}

/** School days in [start, endExclusive). */
export function schoolDaysInRange({ start, endExclusive, gradeLevel = null, terms, calendarEntries }) {
  const out = [];
  let d = start;
  let guard = 0;
  while (d < endExclusive) {
    if (isSchoolDay({ date: d, gradeLevel, terms, calendarEntries })) out.push(d);
    d = addDays(d, 1);
    if (++guard > 800) break;
  }
  return out;
}

/** The N most recent school days ending at `date` inclusive (for rolling-window rules). */
export function lastNSchoolDays({ date, n, gradeLevel = null, terms, calendarEntries }) {
  const out = [];
  let d = date;
  let guard = 0;
  while (out.length < n && guard < 800) {
    if (isSchoolDay({ date: d, gradeLevel, terms, calendarEntries })) out.push(d);
    d = addDays(d, -1);
    guard++;
  }
  return out;
}

/** Add `n` school days after `date` (exclusive); used for due dates. Falls back to calendar days outside terms. */
export function addSchoolDays({ date, n, gradeLevel = null, terms, calendarEntries }) {
  let d = date;
  let count = 0;
  let guard = 0;
  while (count < n && guard < 800) {
    d = addDays(d, 1);
    guard++;
    if (isSchoolDay({ date: d, gradeLevel, terms, calendarEntries }) || !termForDate(terms, d)) count++;
  }
  return d;
}

/** Periods effective on date for level (level-specific overrides general by period_no). */
export function periodsFor({ periods, date, gradeLevel = null }) {
  const eff = periods.filter((p) => date >= p.effective_from && (p.effective_to == null || date < p.effective_to));
  const byNo = new Map();
  for (const p of eff.filter((x) => x.applies_to_level == null)) byNo.set(p.period_no, p);
  if (gradeLevel) for (const p of eff.filter((x) => x.applies_to_level === gradeLevel)) byNo.set(p.period_no, p);
  return [...byNo.values()].sort((a, b) => a.period_no - b.period_no);
}

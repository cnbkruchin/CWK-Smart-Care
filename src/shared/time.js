// Time utilities. Storage rules:
//  - timestamps: UTC ISO 8601 with milliseconds, e.g. "2026-10-10T01:42:00.000Z"
//  - school dates: "YYYY-MM-DD" (Gregorian/CE) derived in the school's time zone (Asia/Bangkok)
//  - local clock times in rules: "HH:MM" (24h) in the school's time zone
// Asia/Bangkok has had a fixed UTC+07:00 offset with no daylight saving since 1920, so a fixed
// offset table is exact for this deployment and avoids depending on Intl time-zone data in GAS.
// Buddhist-era conversion (+543) happens ONLY in the presentation layer (see thai-format.js).

import { AppError } from './errors.js';

export const TZ_OFFSETS_MINUTES = Object.freeze({ 'Asia/Bangkok': 420, UTC: 0 });

export function tzOffset(tz) {
  const off = TZ_OFFSETS_MINUTES[tz || 'Asia/Bangkok'];
  if (off === undefined) throw new AppError('CONFIGURATION_REQUIRED', `unsupported timezone ${tz}`);
  return off;
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isIsoTimestamp(s) {
  if (typeof s !== 'string' || !TS_RE.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === s.slice(0, 19);
}

export function normalizeTimestamp(s) {
  if (s instanceof Date) return s.toISOString();
  if (!isIsoTimestamp(s)) throw new AppError('VALIDATION_ERROR', `invalid timestamp ${s}`);
  return new Date(s).toISOString();
}

export function isIsoDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isHhMm(s) {
  return typeof s === 'string' && HHMM_RE.test(s);
}

export function hhmmToMinutes(s) {
  const m = HHMM_RE.exec(s);
  if (!m) throw new AppError('VALIDATION_ERROR', `invalid HH:MM ${s}`);
  return +m[1] * 60 + +m[2];
}

/** School date (YYYY-MM-DD) of a UTC instant in the given zone. */
export function schoolDateOf(isoUtc, tz = 'Asia/Bangkok') {
  const ms = new Date(isoUtc).getTime() + tzOffset(tz) * 60000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Local wall-clock parts of a UTC instant. */
export function localPartsOf(isoUtc, tz = 'Asia/Bangkok') {
  const local = new Date(new Date(isoUtc).getTime() + tzOffset(tz) * 60000).toISOString();
  return {
    date: local.slice(0, 10),
    hh: +local.slice(11, 13),
    mm: +local.slice(14, 16),
    ss: +local.slice(17, 19),
    ms: +local.slice(20, 23),
    hhmm: local.slice(11, 16),
  };
}

/** UTC ISO instant for a local date + HH:MM (seconds = 0). */
export function localToUtc(date, hhmm, tz = 'Asia/Bangkok') {
  if (!isIsoDate(date)) throw new AppError('VALIDATION_ERROR', `invalid date ${date}`);
  const mins = hhmmToMinutes(hhmm);
  const [y, mo, d] = date.split('-').map(Number);
  const ms = Date.UTC(y, mo - 1, d, 0, mins) - tzOffset(tz) * 60000;
  return new Date(ms).toISOString();
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Dates in the half-open interval [start, endExclusive). */
export function eachDate(start, endExclusive, maxDays = 400) {
  const out = [];
  let cur = start;
  while (cur < endExclusive) {
    out.push(cur);
    if (out.length > maxDays) throw new AppError('VALIDATION_ERROR', 'date range too long');
    cur = addDays(cur, 1);
  }
  return out;
}

/** True when date is inside [from, to) where `to` may be null (open-ended). */
export function dateInRange(date, from, to) {
  return date >= from && (to == null || date < to);
}

/** Half-open interval overlap for date ranges with nullable (open) end. */
export function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  const aEndsAfterBStarts = aTo == null || aTo > bFrom;
  const bEndsAfterAStarts = bTo == null || bTo > aFrom;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

export function addMinutesIso(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

export function addSecondsIso(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export function diffSeconds(fromIso, toIso) {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000;
}

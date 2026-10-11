// Reusable read helpers (generators) shared by services. Per-request memoization lives on ctx.
import { findEffectiveEnrollment, rosterForClass } from '../domain/enrollment.js';
import { dayInfo, periodsFor } from '../domain/calendar.js';
import { AppError } from '../shared/errors.js';

/**
 * Every row matching a list query. Stores that support `all` return one page; otherwise the cursor is
 * followed (TableStore pages are capped at 500). Throws instead of silently truncating above `max`.
 */
export function* listAll(ctx, table, q = {}, max = 200000) {
  const out = [];
  let cursor = null;
  do {
    const page = yield ctx.store.list(table, { ...q, all: true, limit: 500, cursor });
    for (const r of page.items) out.push(r);
    if (out.length > max) throw new AppError('PAYLOAD_TOO_LARGE', `${table} result exceeds ${max}`, { messageTh: 'ข้อมูลมีจำนวนมากเกินกว่าที่ประมวลผลได้ในครั้งเดียว — ใช้ตัวกรองให้แคบลง' });
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

function memo(ctx, key) {
  ctx._memo = ctx._memo || new Map();
  return ctx._memo;
}

export function* getClass(ctx, id) {
  if (!id) return null;
  const m = memo(ctx);
  const k = `class:${id}`;
  if (!m.has(k)) m.set(k, yield ctx.store.get('Classes', id));
  return m.get(k);
}

export function* enrollmentsOf(ctx, studentId) {
  const m = memo(ctx);
  const k = `enr:${studentId}`;
  if (!m.has(k)) m.set(k, yield ctx.store.findBy('Enrollments', 'student_id', studentId));
  return m.get(k);
}

export function* effectiveEnrollment(ctx, studentId, date) {
  return findEffectiveEnrollment(yield* enrollmentsOf(ctx, studentId), studentId, date);
}

export function* rosterOf(ctx, classId, date) {
  const enrs = yield ctx.store.findBy('Enrollments', 'class_id', classId);
  return rosterForClass(enrs, classId, date);
}

export function* allCalendar(ctx) {
  const m = memo(ctx);
  if (!m.has('calendar')) {
    m.set('calendar', yield* listAll(ctx, 'SchoolCalendar', { where: { calendar_date: { gte: shiftYear(ctx.today, -1), lt: shiftYear(ctx.today, 1) } } }));
  }
  return m.get('calendar');
}

function shiftYear(date, n) {
  return `${Number(date.slice(0, 4)) + n}${date.slice(4)}`;
}

export function* calendarFor(ctx, dates) {
  const inWindow = dates.every((d) => d >= shiftYear(ctx.today, -1) && d < shiftYear(ctx.today, 1));
  if (inWindow) return yield* allCalendar(ctx);
  const out = [];
  for (const d of dates) out.push(...(yield ctx.store.findBy('SchoolCalendar', 'calendar_date', d)));
  return out;
}

export function* allPeriods(ctx) {
  const m = memo(ctx);
  if (!m.has('periods')) m.set('periods', yield* listAll(ctx, 'Periods'));
  return m.get('periods');
}

export function* dayInfoFor(ctx, date, gradeLevel) {
  const cal = yield* calendarFor(ctx, [date]);
  return dayInfo({ date, gradeLevel, terms: ctx.terms, calendarEntries: cal });
}

export function* periodsOfDay(ctx, date, gradeLevel) {
  return periodsFor({ periods: yield* allPeriods(ctx), date, gradeLevel });
}

export function* requireStudent(ctx, id) {
  const s = yield ctx.store.get('Students', id);
  if (!s) throw new AppError('NOT_FOUND', 'student not found', { messageTh: 'ไม่พบข้อมูลนักเรียน' });
  return s;
}

export function* currentAcademicYear(ctx) {
  const page = yield ctx.store.list('AcademicYears', { limit: 50 });
  return page.items.find((y) => ctx.today >= y.start_date && ctx.today < y.end_date) || page.items.sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0] || null;
}

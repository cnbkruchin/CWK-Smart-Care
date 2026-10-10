// Small hand-checkable fixtures for pure domain tests (synthetic data only).
import { EXAMPLE_RULE_PARAMS } from '../../src/domain/rules.js';

export const TERMS = [
  { id: 't1', code: 'AY2026-T1', start_date: '2026-05-18', end_date: '2026-10-10' },
  { id: 't2', code: 'AY2026-T2', start_date: '2026-11-02', end_date: '2027-03-27' },
];

// 2026-10-05 Mon … 2026-10-09 Fri; 2026-10-07 is a holiday for everyone; 2026-10-08 exam day for M6 only (still school day)
export const CALENDAR = [
  { calendar_date: '2026-10-07', day_type: 'HOLIDAY', applies_to_level: null },
  { calendar_date: '2026-10-08', day_type: 'NO_SCHOOL', applies_to_level: 'M6' },
];

export const PERIODS = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
  period_no: n, session: n <= 4 ? 'AM' : 'PM', start_time: `${String(7 + n).padStart(2, '0')}:30`, end_time: `${String(8 + n).padStart(2, '0')}:20`,
  effective_from: '2026-05-01', effective_to: null, applies_to_level: null,
}));

export const rule = (rule_type, params = EXAMPLE_RULE_PARAMS[rule_type], extra = {}) => ({
  id: `rule-${rule_type}-${extra.version_no || 1}`, rule_type, version_no: 1, status: 'ACTIVE', effective_from: '2026-01-01', effective_to: null, params_json: params, is_example: true, ...extra,
});

export const LATENESS = rule('SCHOOL_LATENESS', { cutoff_time: '08:00', grace_minutes: 5, rounding: 'CEIL_MINUTE', late_minutes_basis: 'CUTOFF', applies_to_levels: null });
export const ROUTING = rule('LEAVE_ROUTING');

export const S1 = '11111111-1111-4111-8111-111111111111';
export const S2 = '22222222-2222-4222-8222-222222222222';
export const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
export const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';

export const CLASSES = new Map([
  [C1, { id: C1, grade_level: 'M1', code: 'M1/1' }],
  [C2, { id: C2, grade_level: 'M6', code: 'M6/1' }],
]);

export const ENROLLMENTS = [
  { id: 'e1', student_id: S1, class_id: C1, effective_from: '2026-05-18', effective_to: null, roll_no: 1 },
  { id: 'e2', student_id: S2, class_id: C2, effective_from: '2026-05-18', effective_to: null, roll_no: 1 },
];

export function bkk(date, hhmmss) {
  // local Bangkok wall clock → UTC ISO
  const [h, m, s = '00'] = hhmmss.split(':');
  const ms = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +h - 7, +m, +s);
  return new Date(ms).toISOString();
}

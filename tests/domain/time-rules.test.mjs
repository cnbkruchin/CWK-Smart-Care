import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateArrival } from '../../src/domain/lateness.js';
import { dayInfo, partitionKeyForDate, schoolDaysInRange, lastNSchoolDays, periodsFor } from '../../src/domain/calendar.js';
import { selectRule, findOverlappingRule, validateRuleParams, EXAMPLE_RULE_PARAMS } from '../../src/domain/rules.js';
import { TERMS, CALENDAR, PERIODS, LATENESS, bkk, rule } from '../fixtures/domain-fixtures.mjs';

const D = '2026-10-06';

test('lateness: before, at cutoff, inside grace, at grace boundary, after grace (CEIL)', () => {
  const ev = (t) => evaluateArrival({ arrivedAt: bkk(D, t), schoolDate: D, rule: LATENESS });
  assert.deepEqual([ev('07:59:59').is_late, ev('07:59:59').late_minutes], [false, 0]);
  assert.equal(ev('08:00:00').is_late, false);
  assert.equal(ev('08:04:59').is_late, false);
  assert.equal(ev('08:05:00').is_late, false, 'arrival exactly at threshold is on time (inclusive)');
  const late = ev('08:05:01');
  assert.equal(late.is_late, true);
  assert.equal(late.late_minutes, 6, 'measured from cutoff, ceil(5m1s)=6');
  assert.equal(ev('08:30:00').late_minutes, 30);
});

test('lateness: FLOOR rounding and GRACE_END basis', () => {
  const r = rule('SCHOOL_LATENESS', { cutoff_time: '08:00', grace_minutes: 5, rounding: 'FLOOR_MINUTE', late_minutes_basis: 'GRACE_END', applies_to_levels: null });
  const ev = (t) => evaluateArrival({ arrivedAt: bkk(D, t), schoolDate: D, rule: r });
  assert.equal(ev('08:05:30').late_minutes, 1, 'minimum 1 minute when late');
  assert.equal(ev('08:07:59').late_minutes, 2);
});

test('lateness: rejects arrival recorded for another school date (UTC crossing)', () => {
  // 06:30 BKK on the 6th = 23:30Z on the 5th; school date must be 2026-10-06
  assert.equal(evaluateArrival({ arrivedAt: '2026-10-05T23:30:00.000Z', schoolDate: '2026-10-06', rule: LATENESS }).is_late, false);
  assert.throws(() => evaluateArrival({ arrivedAt: '2026-10-05T23:30:00.000Z', schoolDate: '2026-10-05', rule: LATENESS }), /VALIDATION_ERROR|not on the school date/);
});

test('lateness: missing rule => CONFIGURATION_REQUIRED, level filter', () => {
  assert.throws(() => evaluateArrival({ arrivedAt: bkk(D, '09:00'), schoolDate: D, rule: null }), (e) => e.code === 'CONFIGURATION_REQUIRED');
  const r = rule('SCHOOL_LATENESS', { ...LATENESS.params_json, applies_to_levels: ['M6'] });
  assert.equal(evaluateArrival({ arrivedAt: bkk(D, '09:00'), schoolDate: D, rule: r, gradeLevel: 'M1' }).is_late, false);
  assert.equal(evaluateArrival({ arrivedAt: bkk(D, '09:00'), schoolDate: D, rule: r, gradeLevel: 'M6' }).is_late, true);
});

test('calendar: weekdays in term, holidays, level-specific overrides, out-of-term', () => {
  const info = (date, gradeLevel = null) => dayInfo({ date, gradeLevel, terms: TERMS, calendarEntries: CALENDAR });
  assert.equal(info('2026-10-05').school_day, true);
  assert.equal(info('2026-10-07').school_day, false, 'holiday');
  assert.equal(info('2026-10-08', 'M1').school_day, true);
  assert.equal(info('2026-10-08', 'M6').school_day, false, 'level-specific no-school');
  assert.equal(info('2026-10-10').school_day, false, 'Saturday and term ended (exclusive end)');
  assert.equal(info('2026-10-20').school_day, false, 'between terms');
  assert.deepEqual(schoolDaysInRange({ start: '2026-10-05', endExclusive: '2026-10-10', terms: TERMS, calendarEntries: CALENDAR }), ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09']);
  assert.deepEqual(lastNSchoolDays({ date: '2026-10-09', n: 3, terms: TERMS, calendarEntries: CALENDAR }), ['2026-10-09', '2026-10-08', '2026-10-06']);
});

test('partition key: in-term, vacation falls back to previous term, before all terms', () => {
  assert.equal(partitionKeyForDate(TERMS, '2026-06-01'), 'AY2026-T1');
  assert.equal(partitionKeyForDate(TERMS, '2026-10-20'), 'AY2026-T1');
  assert.equal(partitionKeyForDate(TERMS, '2026-12-01'), 'AY2026-T2');
  assert.equal(partitionKeyForDate(TERMS, '2025-01-01'), 'AY2026-T1');
  assert.equal(partitionKeyForDate([], '2025-01-01'), 'UNPARTITIONED');
});

test('periods effective by date', () => {
  const ps = periodsFor({ periods: PERIODS, date: D });
  assert.equal(ps.length, 7);
  assert.equal(ps.filter((p) => p.session === 'AM').length, 4);
});

test('rule selection by effective date and version; overlap detection', () => {
  const v1 = rule('SCHOOL_LATENESS', LATENESS.params_json, { id: 'v1', version_no: 1, effective_from: '2026-05-01', effective_to: '2026-11-01' });
  const v2 = rule('SCHOOL_LATENESS', { ...LATENESS.params_json, cutoff_time: '07:50' }, { id: 'v2', version_no: 2, effective_from: '2026-11-01' });
  assert.equal(selectRule([v1, v2], 'SCHOOL_LATENESS', '2026-10-31').id, 'v1');
  assert.equal(selectRule([v1, v2], 'SCHOOL_LATENESS', '2026-11-01').id, 'v2');
  assert.equal(selectRule([v1, v2], 'SCHOOL_LATENESS', '2026-04-30'), null);
  assert.equal(findOverlappingRule([v1, v2], { ...v2, id: 'v3', effective_from: '2026-10-01' }).id, 'v1');
  for (const [type, params] of Object.entries(EXAMPLE_RULE_PARAMS)) validateRuleParams(type, params);
  assert.throws(() => validateRuleParams('SCHOOL_LATENESS', { cutoff_time: '8:00', grace_minutes: -1, rounding: 'X', late_minutes_basis: 'CUTOFF' }), (e) => e.code === 'VALIDATION_ERROR');
});

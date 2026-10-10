// School-arrival lateness (MASTER_PROMPT §7.3). Period lateness is a separate metric/rule and is
// NOT computed from gate time. Recording at the gate is never evidence of classroom entry.
//
// Definitions (rule SCHOOL_LATENESS, local school time):
//   cutoff      = school_date + cutoff_time
//   threshold   = cutoff + grace_minutes
//   ON TIME     ⇔ arrived_at ≤ threshold            (inclusive, to the millisecond)
//   LATE        ⇔ arrived_at > threshold
//   late_minutes measured from `cutoff` (basis CUTOFF) or `threshold` (basis GRACE_END),
//   rounded up (CEIL_MINUTE, default) or down (FLOOR_MINUTE) to whole minutes, minimum 1 when late.

import { localToUtc, schoolDateOf } from '../shared/time.js';
import { AppError } from '../shared/errors.js';

export function evaluateArrival({ arrivedAt, schoolDate, tz = 'Asia/Bangkok', rule, gradeLevel = null }) {
  if (!rule) throw new AppError('CONFIGURATION_REQUIRED', 'lateness rule missing', { messageTh: 'ยังไม่ได้ตั้งค่าเวลาเริ่มสาย' });
  const p = rule.params_json;
  if (schoolDateOf(arrivedAt, tz) !== schoolDate) {
    throw new AppError('VALIDATION_ERROR', 'arrival time is not on the school date', { messageTh: 'เวลามาถึงไม่ตรงกับวันเรียนที่บันทึก' });
  }
  const applies = !p.applies_to_levels || !gradeLevel || p.applies_to_levels.includes(gradeLevel);
  const cutoffAt = localToUtc(schoolDate, p.cutoff_time, tz);
  const thresholdMs = new Date(cutoffAt).getTime() + p.grace_minutes * 60000;
  const arrivedMs = new Date(arrivedAt).getTime();
  if (!applies) {
    return { is_late: false, late_minutes: 0, cutoff_at: cutoffAt, threshold_at: new Date(thresholdMs).toISOString(), rule_version_id: rule.id, applies: false };
  }
  const isLate = arrivedMs > thresholdMs;
  let lateMinutes = 0;
  if (isLate) {
    const basisMs = p.late_minutes_basis === 'GRACE_END' ? thresholdMs : new Date(cutoffAt).getTime();
    const raw = (arrivedMs - basisMs) / 60000;
    lateMinutes = p.rounding === 'FLOOR_MINUTE' ? Math.floor(raw) : Math.ceil(raw);
    if (lateMinutes < 1) lateMinutes = 1;
  }
  return { is_late: isLate, late_minutes: lateMinutes, cutoff_at: cutoffAt, threshold_at: new Date(thresholdMs).toISOString(), rule_version_id: rule.id, applies: true };
}

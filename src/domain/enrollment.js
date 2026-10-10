// Enrollment history rules. Intervals are half-open [effective_from, effective_to).
// Reports use the enrollment effective ON the reported date, never today's roster.

import { dateInRange, rangesOverlap } from '../shared/time.js';
import { AppError } from '../shared/errors.js';

export function findEffectiveEnrollment(enrollments, studentId, date) {
  const matches = enrollments.filter((e) => e.student_id === studentId && dateInRange(date, e.effective_from, e.effective_to));
  if (matches.length > 1) {
    throw new AppError('INTEGRITY_ERROR', `overlapping enrollments for ${studentId} on ${date}`, { messageTh: 'พบข้อมูลการอยู่ห้องซ้อนกัน ต้องแก้ไขข้อมูลก่อน' });
  }
  return matches[0] || null;
}

export function rosterForClass(enrollments, classId, date) {
  return enrollments
    .filter((e) => e.class_id === classId && dateInRange(date, e.effective_from, e.effective_to))
    .sort((a, b) => (a.roll_no || 9999) - (b.roll_no || 9999) || (a.student_id < b.student_id ? -1 : 1));
}

export function findOverlap(enrollments, candidate) {
  return enrollments.find((e) => e.id !== candidate.id && e.student_id === candidate.student_id
    && rangesOverlap(e.effective_from, e.effective_to, candidate.effective_from, candidate.effective_to)) || null;
}

/**
 * Plan a class change / promotion / exit effective on `effectiveDate`.
 * Returns {close: updated current enrollment|null, open: new enrollment fields|null}.
 */
export function planEnrollmentChange({ enrollments, studentId, effectiveDate, newClassId = null, academicYearId = null, reason, rollNo = null }) {
  const current = findEffectiveEnrollment(enrollments, studentId, effectiveDate);
  const future = enrollments.filter((e) => e.student_id === studentId && e.effective_from > effectiveDate);
  if (future.length) {
    throw new AppError('INVALID_STATE', 'student has a future enrollment', { messageTh: 'นักเรียนมีข้อมูลห้องที่มีผลในอนาคตอยู่แล้ว ต้องจัดการรายการนั้นก่อน' });
  }
  if (current && current.class_id === newClassId) {
    throw new AppError('VALIDATION_ERROR', 'same class', { messageTh: 'นักเรียนอยู่ห้องนี้แล้ว' });
  }
  if (current && current.effective_from === effectiveDate && reason !== 'CORRECTION') {
    throw new AppError('VALIDATION_ERROR', 'zero-length enrollment', { messageTh: 'วันที่มีผลซ้ำกับวันเริ่มห้องเดิม ให้ใช้การแก้ไขข้อมูลผิด (CORRECTION)' });
  }
  const close = current ? { ...current, effective_to: effectiveDate, end_reason: reason } : null;
  const exiting = ['TRANSFER_OUT', 'GRADUATION', 'WITHDRAWAL'].includes(reason);
  const open = !exiting && newClassId
    ? { student_id: studentId, class_id: newClassId, academic_year_id: academicYearId, effective_from: effectiveDate, effective_to: null, end_reason: null, roll_no: rollNo }
    : null;
  if (!close && !open) throw new AppError('INVALID_STATE', 'nothing to change', { messageTh: 'ไม่มีข้อมูลห้องที่ต้องเปลี่ยน' });
  return { close, open };
}

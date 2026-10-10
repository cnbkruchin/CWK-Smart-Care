// Import planning (dry-run) and application. Planning classifies each row as
// INSERT | UPDATE | SKIP | CONFLICT | ERROR against CURRENT data; apply re-plans each chunk so
// re-running an import (or resuming after a crash) never duplicates rows (SKIP).

import { normalizeImportRow } from './definitions.js';
import { findEffectiveEnrollment, planEnrollmentChange } from '../../domain/enrollment.js';
import { dateInRange } from '../../shared/time.js';
import { searchKey } from '../ops/common.js';
import { DEFAULT_GUARDIAN_PERMISSIONS, DEFAULT_NOTIFICATION_PREFS } from '../ops/students.js';
import { ENUMS } from '../../schema/enums.js';

const STUDENT_COMPARE = ['prefix_th', 'first_name_th', 'last_name_th', 'first_name_en', 'last_name_en', 'nickname', 'gender', 'birth_date'];

/** Load the reference data a plan needs (one pass; Sheets-friendly). */
export function* loadReference(ctx, type) {
  const ref = {};
  const listAll = function* (table, q = {}) {
    let out = [];
    let cursor = null;
    do {
      const page = yield ctx.store.list(table, { ...q, limit: 500, cursor });
      out = out.concat(page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  };
  ref.school = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
  if (['STUDENTS', 'ENROLLMENTS', 'STAFF', 'CLASSES'].includes(type)) {
    ref.classes = yield* listAll('Classes');
    ref.years = yield* listAll('AcademicYears');
  }
  if (['STUDENTS', 'GUARDIANS', 'ENROLLMENTS'].includes(type)) {
    const students = yield* listAll('Students');
    ref.studentsByCode = new Map(students.map((s) => [s.student_code, s]));
    ref.studentsByName = new Map();
    for (const s of students) {
      const k = searchKey(s.first_name_th, s.last_name_th);
      if (!ref.studentsByName.has(k)) ref.studentsByName.set(k, []);
      ref.studentsByName.get(k).push(s);
    }
  }
  if (['STUDENTS', 'ENROLLMENTS'].includes(type)) {
    const enrs = yield* listAll('Enrollments');
    ref.enrollmentsByStudent = new Map();
    for (const e of enrs) {
      if (!ref.enrollmentsByStudent.has(e.student_id)) ref.enrollmentsByStudent.set(e.student_id, []);
      ref.enrollmentsByStudent.get(e.student_id).push(e);
    }
  }
  if (type === 'GUARDIANS') {
    const guardians = yield* listAll('Guardians');
    ref.guardiansByRef = new Map(guardians.filter((g) => g.external_ref).map((g) => [g.external_ref, g]));
    const links = yield* listAll('StudentGuardians');
    ref.linksByPair = new Map(links.filter((l) => l.status === 'ACTIVE').map((l) => [`${l.student_id}|${l.guardian_id}`, l]));
  }
  if (type === 'STAFF') {
    const users = yield* listAll('Users', { where: { user_type: 'STAFF' } });
    ref.staffByCode = new Map(users.filter((u) => u.staff_code).map((u) => [u.staff_code, u]));
  }
  if (type === 'CALENDAR') {
    const cal = yield* listAll('SchoolCalendar');
    ref.calendarByKey = new Map(cal.map((c) => [`${c.calendar_date}|${c.applies_to_level || ''}`, c]));
  }
  return ref;
}

function classFor(ref, code, date) {
  const year = ref.years.find((y) => date >= y.start_date && date < y.end_date);
  if (!year) return { error: `ไม่มีปีการศึกษาที่ครอบคลุมวันที่ ${date}` };
  const cls = ref.classes.find((c) => c.code === code && c.academic_year_id === year.id);
  if (!cls) return { error: `ไม่พบห้อง ${code} ในปีการศึกษา ${year.start_year_ce + 543}` };
  return { cls, year };
}

/**
 * @returns {Array<{row_no:number, action:string, value:object, errors:object[], warnings:object[]}>}
 */
export function planImport(type, rawRows, ref, opts = {}) {
  const seen = new Map();
  const out = [];
  rawRows.forEach((raw, i) => {
    const row_no = i + 2; // header is row 1
    const { value, errors } = normalizeImportRow(type, raw, opts);
    const warnings = [];
    let action = errors.length ? 'ERROR' : 'INSERT';
    const conflict = (column, code, message_th) => { errors.push({ column, code, message_th }); action = 'CONFLICT'; };
    if (!errors.length) {
      switch (type) {
        case 'STUDENTS': {
          if (seen.has(value.student_code)) { errors.push({ column: 'student_code', code: 'DUPLICATE_IN_FILE', message_th: `รหัสซ้ำกับแถว ${seen.get(value.student_code)}` }); action = 'ERROR'; break; }
          seen.set(value.student_code, row_no);
          const c = classFor(ref, value.class_code, value.effective_from);
          if (c.error) { errors.push({ column: 'class_code', code: 'CLASS_NOT_FOUND', message_th: c.error }); action = 'ERROR'; break; }
          value._class_id = c.cls.id;
          value._academic_year_id = c.cls.academic_year_id;
          const existing = ref.studentsByCode.get(value.student_code);
          const sameName = (ref.studentsByName.get(searchKey(value.first_name_th, value.last_name_th)) || []).filter((s) => s.student_code !== value.student_code);
          if (sameName.length) warnings.push({ column: 'first_name_th', code: 'DUPLICATE_NAME', message_th: `ชื่อซ้ำกับนักเรียนรหัส ${sameName.map((s) => s.student_code).join(', ')} — ระบบไม่รวมเป็นคนเดียวกัน ตรวจสอบรหัส` });
          if (existing) {
            value._student_id = existing.id;
            const diffs = STUDENT_COMPARE.filter((k) => (value[k] ?? null) !== (existing[k] ?? null));
            const enr = findEffectiveEnrollment(ref.enrollmentsByStudent.get(existing.id) || [], existing.id, value.effective_from);
            if (enr && enr.class_id !== c.cls.id) { conflict('class_code', 'ENROLLMENT_DIFFERS', 'นักเรียนอยู่ห้องอื่นในวันที่มีผล — ใช้การนำเข้า "ย้ายห้อง/เลื่อนชั้น"'); break; }
            value._needs_enrollment = !enr;
            if (!diffs.length && enr) action = 'SKIP';
            else if (diffs.length && !opts.update_existing) conflict(diffs[0], 'EXISTS_DIFFERENT', `มีรหัสนี้แล้วแต่ข้อมูลต่าง (${diffs.join(', ')}) — เลือก "อัปเดตข้อมูลเดิม" หากต้องการแก้ไข`);
            else action = 'UPDATE';
            value._diffs = diffs;
          }
          break;
        }
        case 'GUARDIANS': {
          const s = ref.studentsByCode.get(value.student_code);
          if (!s) { errors.push({ column: 'student_code', code: 'STUDENT_NOT_FOUND', message_th: 'ไม่พบรหัสนักเรียน' }); action = 'ERROR'; break; }
          value._student_id = s.id;
          const g = ref.guardiansByRef.get(value.guardian_ref);
          const fileFirst = seen.get(value.guardian_ref);
          if (g) {
            value._guardian_id = g.id;
            if (searchKey(g.first_name_th, g.last_name_th) !== searchKey(value.first_name_th, value.last_name_th)) { conflict('guardian_ref', 'REF_NAME_MISMATCH', 'รหัสผู้ปกครองนี้มีอยู่แล้วแต่ชื่อไม่ตรง — ตรวจสอบรหัส'); break; }
            action = ref.linksByPair.has(`${s.id}|${g.id}`) ? 'SKIP' : 'INSERT';
          } else if (fileFirst) {
            if (searchKey(fileFirst.first_name_th, fileFirst.last_name_th) !== searchKey(value.first_name_th, value.last_name_th)) { errors.push({ column: 'guardian_ref', code: 'REF_NAME_MISMATCH', message_th: `รหัสผู้ปกครองซ้ำกับแถว ${fileFirst.row_no} แต่ชื่อไม่ตรง` }); action = 'ERROR'; }
          } else {
            seen.set(value.guardian_ref, { row_no, first_name_th: value.first_name_th, last_name_th: value.last_name_th });
          }
          break;
        }
        case 'CLASSES': {
          const year = ref.years.find((y) => y.start_year_ce === value.start_year_ce);
          if (!year) { errors.push({ column: 'start_year_ce', code: 'YEAR_NOT_FOUND', message_th: 'ยังไม่ได้สร้างปีการศึกษานี้' }); action = 'ERROR'; break; }
          value._academic_year_id = year.id;
          value._code = `${value.grade_level}/${value.room_no}`;
          if (ref.classes.some((c) => c.academic_year_id === year.id && c.code === value._code) || seen.has(value._code)) action = 'SKIP';
          seen.set(value._code, row_no);
          break;
        }
        case 'ENROLLMENTS': {
          const s = ref.studentsByCode.get(value.student_code);
          if (!s) { errors.push({ column: 'student_code', code: 'STUDENT_NOT_FOUND', message_th: 'ไม่พบรหัสนักเรียน' }); action = 'ERROR'; break; }
          value._student_id = s.id;
          if (['TRANSFER_OUT', 'GRADUATION', 'WITHDRAWAL'].includes(value.reason)) { value._class_id = null; }
          else {
            const c = classFor(ref, value.class_code, value.effective_date);
            if (c.error) { errors.push({ column: 'class_code', code: 'CLASS_NOT_FOUND', message_th: c.error }); action = 'ERROR'; break; }
            value._class_id = c.cls.id;
            value._academic_year_id = c.cls.academic_year_id;
          }
          const enrs = ref.enrollmentsByStudent.get(s.id) || [];
          const cur = findEffectiveEnrollment(enrs, s.id, value.effective_date);
          if (cur && cur.class_id === value._class_id) { action = 'SKIP'; break; }
          try {
            planEnrollmentChange({ enrollments: enrs, studentId: s.id, effectiveDate: value.effective_date, newClassId: value._class_id, academicYearId: value._academic_year_id, reason: value.reason, rollNo: value.roll_no });
            action = 'UPDATE';
          } catch (e) { conflict('effective_date', e.code || 'INVALID', e.messageTh || 'ไม่สามารถเปลี่ยนห้องได้'); }
          break;
        }
        case 'STAFF': {
          if (seen.has(value.staff_code)) { errors.push({ column: 'staff_code', code: 'DUPLICATE_IN_FILE', message_th: `รหัสซ้ำกับแถว ${seen.get(value.staff_code)}` }); action = 'ERROR'; break; }
          seen.set(value.staff_code, row_no);
          if (value.homeroom_class_code) {
            const year = ref.years.find((y) => opts.today >= y.start_date && opts.today < y.end_date);
            const cls = year && ref.classes.find((c) => c.code === value.homeroom_class_code && c.academic_year_id === year.id);
            if (!cls) { errors.push({ column: 'homeroom_class_code', code: 'CLASS_NOT_FOUND', message_th: 'ไม่พบห้องในปีการศึกษาปัจจุบัน' }); action = 'ERROR'; break; }
            value._homeroom_class_id = cls.id;
          }
          const u = ref.staffByCode.get(value.staff_code);
          if (u) action = u.display_name === value.display_name ? 'SKIP' : 'CONFLICT';
          if (action === 'CONFLICT') errors.push({ column: 'display_name', code: 'EXISTS_DIFFERENT', message_th: 'มีรหัสบุคลากรนี้แล้วแต่ชื่อต่าง' });
          break;
        }
        case 'CALENDAR': {
          const key = `${value.calendar_date}|${value.applies_to_level || ''}`;
          const ex = ref.calendarByKey.get(key);
          if (seen.has(key)) { errors.push({ column: 'calendar_date', code: 'DUPLICATE_IN_FILE', message_th: `ซ้ำกับแถว ${seen.get(key)}` }); action = 'ERROR'; break; }
          seen.set(key, row_no);
          if (ex) { value._existing_id = ex.id; action = ex.day_type === value.day_type && (ex.title_th || null) === (value.title_th || null) ? 'SKIP' : 'UPDATE'; }
          break;
        }
        default:
      }
    }
    out.push({ row_no, action, value, errors, warnings });
  });
  return out;
}

export function summarize(plan) {
  const s = { total: plan.length, INSERT: 0, UPDATE: 0, SKIP: 0, CONFLICT: 0, ERROR: 0, warnings: 0 };
  for (const r of plan) { s[r.action]++; s.warnings += r.warnings.length; }
  return s;
}

/** Write one planned row into the change set (apply phase). Returns number of business rows written. */
export function applyPlannedRow(type, r, cs, ctx, ref, opts, memo) {
  const v = r.value;
  const actor = cs.actorId;
  switch (type) {
    case 'STUDENTS': {
      const fields = { prefix_th: v.prefix_th, first_name_th: v.first_name_th, last_name_th: v.last_name_th, first_name_en: v.first_name_en, last_name_en: v.last_name_en, nickname: v.nickname, gender: v.gender, birth_date: v.birth_date };
      const search_name = searchKey(v.prefix_th, v.first_name_th, v.last_name_th, v.nickname, v.first_name_en, v.last_name_en);
      if (r.action === 'INSERT') {
        const s = cs.insert('Students', { school_id: ref.school.id, student_code: v.student_code, ...fields, status: 'ACTIVE', status_effective_date: v.effective_from, search_name });
        cs.insert('Enrollments', { student_id: s.id, class_id: v._class_id, academic_year_id: v._academic_year_id, effective_from: v.effective_from, roll_no: v.roll_no });
        return 2;
      }
      const existing = ref.studentsByCode.get(v.student_code);
      let n = 0;
      if (v._diffs && v._diffs.length) { cs.update('Students', existing, { ...fields, search_name }); n++; }
      if (v._needs_enrollment) { cs.insert('Enrollments', { student_id: existing.id, class_id: v._class_id, academic_year_id: v._academic_year_id, effective_from: v.effective_from, roll_no: v.roll_no }); n++; }
      return n;
    }
    case 'GUARDIANS': {
      let gid = v._guardian_id || memo.get(`g:${v.guardian_ref}`);
      let n = 0;
      if (!gid) {
        const g = cs.insert('Guardians', { school_id: ref.school.id, external_ref: v.guardian_ref, prefix_th: v.prefix_th, first_name_th: v.first_name_th, last_name_th: v.last_name_th, search_name: searchKey(v.prefix_th, v.first_name_th, v.last_name_th), status: 'ACTIVE' });
        gid = g.id;
        memo.set(`g:${v.guardian_ref}`, gid);
        if (v.phone) cs.insert('ContactEndpoints', { owner_type: 'GUARDIAN', owner_id: gid, channel: 'PHONE', value: v.phone, is_primary: true, verified_at: ctx.now, verified_by: actor, status: 'ACTIVE' });
        if (v.email) cs.insert('ContactEndpoints', { owner_type: 'GUARDIAN', owner_id: gid, channel: 'EMAIL', value: v.email, is_primary: true, verified_at: ctx.now, verified_by: actor, status: 'ACTIVE' });
        n++;
      }
      if (!ref.linksByPair.has(`${v._student_id}|${gid}`) && !memo.has(`l:${v._student_id}|${gid}`)) {
        cs.insert('StudentGuardians', {
          student_id: v._student_id, guardian_id: gid, relationship: v.relationship, is_primary_contact: !!v.is_primary_contact, contact_priority: v.contact_priority || 1,
          permitted_actions: DEFAULT_GUARDIAN_PERMISSIONS, notification_preferences: DEFAULT_NOTIFICATION_PREFS, status: 'ACTIVE', verified_by: actor, verified_at: ctx.now,
          verification_method: 'SCHOOL_RECORD', effective_from: opts.default_effective_from || ctx.today,
        });
        memo.set(`l:${v._student_id}|${gid}`, true);
        n++;
      }
      return n;
    }
    case 'CLASSES': {
      cs.insert('Classes', { school_id: ref.school.id, academic_year_id: v._academic_year_id, grade_level: v.grade_level, room_no: v.room_no, code: v._code, name_th: `${ENUMS.GradeLevel.th[v.grade_level]}/${v.room_no}`, status: 'ACTIVE' });
      return 1;
    }
    case 'ENROLLMENTS': {
      const enrs = ref.enrollmentsByStudent.get(v._student_id) || [];
      const plan = planEnrollmentChange({ enrollments: enrs, studentId: v._student_id, effectiveDate: v.effective_date, newClassId: v._class_id, academicYearId: v._academic_year_id, reason: v.reason, rollNo: v.roll_no });
      let n = 0;
      if (plan.close) { cs.update('Enrollments', enrs.find((e) => e.id === plan.close.id), { effective_to: plan.close.effective_to, end_reason: plan.close.end_reason }); n++; }
      if (plan.open) { cs.insert('Enrollments', plan.open); n++; }
      const exit = { TRANSFER_OUT: 'TRANSFERRED_OUT', GRADUATION: 'GRADUATED', WITHDRAWAL: 'WITHDRAWN' }[v.reason];
      if (exit) { cs.update('Students', ref.studentsByCode.get(v.student_code), { status: exit, status_effective_date: v.effective_date }); n++; }
      return n;
    }
    case 'STAFF': {
      const u = cs.insert('Users', { school_id: ref.school.id, user_type: 'STAFF', display_name: v.display_name, contact_email: v.email, staff_code: v.staff_code, status: 'INVITED' });
      for (const role of v.roles || []) cs.insert('UserRoles', { user_id: u.id, role, effective_from: ctx.today, granted_by: actor, reason: 'นำเข้าบุคลากร' });
      if (v._homeroom_class_id) cs.insert('StaffAssignments', { user_id: u.id, assignment_type: 'HOMEROOM', class_id: v._homeroom_class_id, effective_from: ctx.today });
      return 1;
    }
    case 'CALENDAR': {
      if (r.action === 'UPDATE') {
        const ex = [...ref.calendarByKey.values()].find((c) => c.id === v._existing_id);
        cs.update('SchoolCalendar', ex, { day_type: v.day_type, title_th: v.title_th });
      } else {
        cs.insert('SchoolCalendar', { school_id: ref.school.id, calendar_date: v.calendar_date, day_type: v.day_type, applies_to_level: v.applies_to_level, title_th: v.title_th });
      }
      return 1;
    }
    default:
      return 0;
  }
}

export { dateInRange };

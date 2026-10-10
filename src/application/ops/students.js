// Students, classes, enrollments, guardians, relationships and contact endpoints (MASTER_PROMPT §7.1).
import { op } from '../dispatcher.js';
import { obj, S, EMPTY, basicStudent, fullStudent, assertVersion, notFound, searchKey, publicUser } from './common.js';
import { requirePermission, scopeFor, allows } from '../authz.js';
import { commit } from '../context.js';
import { enrollmentsOf, getClass, rosterOf, requireStudent, currentAcademicYear } from '../queries.js';
import { planEnrollmentChange, findOverlap } from '../../domain/enrollment.js';
import { enqueueJobOnce } from '../jobs.js';
import { AppError } from '../../shared/errors.js';
import { dateInRange } from '../../shared/time.js';
import { ENUMS } from '../../schema/enums.js';

const EXIT_STATUS = { TRANSFER_OUT: 'TRANSFERRED_OUT', GRADUATION: 'GRADUATED', WITHDRAWAL: 'WITHDRAWN' };
export const DEFAULT_GUARDIAN_PERMISSIONS = ['VIEW_ATTENDANCE', 'SUBMIT_LEAVE', 'CONFIRM_LEAVE', 'RECEIVE_NOTIFICATIONS', 'VIEW_CASE_SUMMARY', 'VIEW_DOCUMENTS'];
export const DEFAULT_NOTIFICATION_PREFS = { LATE_CONFIRMED: true, ABSENCE_CONFIRMED: true, LEAVE_DECIDED: true, LEAVE_PENDING_GUARDIAN: true, DATA_CORRECTED: true, CASE_NEW: true };

/** Map student_id → effective enrollment today, loaded with one scan (Sheets-friendly). */
export function* enrollmentIndex(ctx, date) {
  const page = yield ctx.store.list('Enrollments', { where: { effective_from: { lte: date } }, limit: 500, orderBy: [['effective_from', 'asc']] });
  let items = page.items;
  let cursor = page.next_cursor;
  while (cursor) {
    const next = yield ctx.store.list('Enrollments', { where: { effective_from: { lte: date } }, limit: 500, orderBy: [['effective_from', 'asc']], cursor });
    items = items.concat(next.items);
    cursor = next.next_cursor;
  }
  const m = new Map();
  for (const e of items) if (dateInRange(date, e.effective_from, e.effective_to)) m.set(e.student_id, e);
  return m;
}

function* classMap(ctx) {
  const page = yield ctx.store.list('Classes', { limit: 500 });
  return new Map(page.items.map((c) => [c.id, c]));
}

const STUDENT_FIELDS = {
  prefix_th: S.strOrNull(30), first_name_th: S.str(100), last_name_th: S.str(100), first_name_en: S.strOrNull(100), last_name_en: S.strOrNull(100),
  nickname: S.strOrNull(50), gender: S.enumOrNull('Gender'), birth_date: S.dateOrNull,
};

export const studentOps = [
  op({
    name: 'class.list', description_th: 'รายชื่อห้องเรียน (ข้อมูลไม่อ่อนไหว)', input: obj({ academic_year_id: S.uuidOrNull }),
    *handler(ctx, input) {
      const year = input.academic_year_id ? { id: input.academic_year_id } : yield* currentAcademicYear(ctx);
      const page = yield ctx.store.list('Classes', { where: year ? { academic_year_id: year.id } : {}, orderBy: [['grade_level', 'asc'], ['room_no', 'asc']], limit: 200 });
      return { items: page.items.map((c) => ({ id: c.id, code: c.code, name_th: c.name_th, grade_level: c.grade_level, room_no: c.room_no, status: c.status })), academic_year_id: year ? year.id : null };
    },
  }),

  op({
    name: 'class.create', mutation: true, description_th: 'สร้างห้องเรียน', permission: 'settings.business',
    input: obj({ academic_year_id: S.uuid, grade_level: S.enum('GradeLevel'), room_no: { type: 'string', pattern: '^[0-9A-Za-z]{1,10}$' } }, ['academic_year_id', 'grade_level', 'room_no']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'settings.business');
      const year = yield ctx.store.get('AcademicYears', input.academic_year_id);
      if (!year) throw notFound('academic year');
      const school = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
      const code = `${input.grade_level}/${input.room_no}`;
      const cs = ctx.changeSet();
      const c = cs.insert('Classes', { school_id: school.id, academic_year_id: year.id, grade_level: input.grade_level, room_no: input.room_no, code, name_th: `${ENUMS.GradeLevel.th[input.grade_level]}/${input.room_no}`, status: 'ACTIVE' });
      cs.audit({ action: 'class.create', entityType: 'Classes', entityId: c.id, after: { code } });
      return yield* commit(ctx, cs, { class_id: c.id, code });
    },
  }),

  op({
    name: 'student.search', description_th: 'ค้นหานักเรียนตามสิทธิ์ (กรองที่ server ก่อนแบ่งหน้า)', permission: 'student.search', rateLimitPerMinute: 240,
    input: obj({ q: S.strOrNull(100), class_id: S.uuidOrNull, status: S.enumOrNull('StudentStatus'), cursor: S.cursor, limit: S.limit }),
    *handler(ctx, input) {
      const scope = scopeFor(ctx, 'student.search');
      const date = ctx.today;
      const enrIdx = yield* enrollmentIndex(ctx, date);
      const classes = yield* classMap(ctx);
      let candidateIds = null;
      if (!scope.all) {
        candidateIds = new Set();
        for (const [sid, e] of enrIdx) if (scope.classIds && scope.classIds.has(e.class_id)) candidateIds.add(sid);
        for (const sid of scope.studentIds || []) candidateIds.add(sid);
      }
      if (input.class_id) {
        const inClass = new Set([...enrIdx].filter(([, e]) => e.class_id === input.class_id).map(([sid]) => sid));
        candidateIds = candidateIds ? new Set([...candidateIds].filter((x) => inClass.has(x))) : inClass;
      }
      const q = input.q ? searchKey(input.q) : null;
      let students;
      if (q && /^[0-9A-Za-z-]+$/.test(input.q) && !candidateIds) {
        const exact = yield ctx.store.findBy('Students', 'student_code', input.q);
        students = exact.length ? exact : (yield ctx.store.list('Students', { where: { student_code: { prefix: input.q } }, limit: 200 })).items;
      } else if (candidateIds) {
        students = [...(yield ctx.store.getMany('Students', [...candidateIds])).values()];
      } else {
        const where = {};
        if (q) where.search_name = { contains: q };
        if (input.status) where.status = input.status;
        const page = yield ctx.store.list('Students', { where, orderBy: [['student_code', 'asc']], cursor: input.cursor, limit: input.limit || 30 });
        return { items: page.items.map((s) => basicStudent(s, classes.get((enrIdx.get(s.id) || {}).class_id))), next_cursor: page.next_cursor };
      }
      let filtered = students.filter((s) => (!q || s.search_name.includes(q) || s.student_code.startsWith(input.q)) && (!input.status || s.status === input.status));
      filtered.sort((a, b) => (a.student_code < b.student_code ? -1 : 1));
      const start = input.cursor ? Number(input.cursor) || 0 : 0;
      const size = input.limit || 30;
      const pageItems = filtered.slice(start, start + size);
      return {
        items: pageItems.map((s) => basicStudent(s, classes.get((enrIdx.get(s.id) || {}).class_id))),
        next_cursor: start + size < filtered.length ? String(start + size) : null,
      };
    },
  }),

  op({
    name: 'student.listMine', description_th: 'นักเรียนที่ผู้ปกครองดูแล/ตนเอง (ตามความสัมพันธ์ที่ยืนยัน)', input: EMPTY,
    *handler(ctx) {
      const scope = scopeFor(ctx, 'student.read');
      const ids = scope.all ? [] : [...(scope.studentIds || [])];
      const students = yield ctx.store.getMany('Students', ids);
      const out = [];
      for (const s of students.values()) {
        const e = (yield* enrollmentsOf(ctx, s.id)).find((x) => dateInRange(ctx.today, x.effective_from, x.effective_to));
        out.push(basicStudent(s, e ? yield* getClass(ctx, e.class_id) : null));
      }
      return { items: out };
    },
  }),

  op({
    name: 'student.get', description_th: 'ข้อมูลนักเรียน (เต็ม หรือเฉพาะระบุตัวตามสิทธิ์)', permission: 'student.read | student.read_basic',
    input: obj({ student_id: S.uuid }, ['student_id']),
    *handler(ctx, input) {
      const full = yield* allows(ctx, 'student.read', { student_id: input.student_id });
      if (!full) yield* requirePermission(ctx, 'student.read_basic', { student_id: input.student_id });
      const s = yield* requireStudent(ctx, input.student_id);
      const enrs = yield* enrollmentsOf(ctx, s.id);
      const current = enrs.find((e) => dateInRange(ctx.today, e.effective_from, e.effective_to));
      const cls = current ? yield* getClass(ctx, current.class_id) : null;
      if (!full) return { access: 'BASIC', student: basicStudent(s, cls) };
      const history = [];
      for (const e of [...enrs].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))) {
        const c = yield* getClass(ctx, e.class_id);
        history.push({ id: e.id, class_id: e.class_id, class_name_th: c ? c.name_th : null, effective_from: e.effective_from, effective_to: e.effective_to, end_reason: e.end_reason, roll_no: e.roll_no });
      }
      return { access: 'FULL', student: fullStudent(s, cls), enrollments: history };
    },
  }),

  op({
    name: 'student.create', mutation: true, description_th: 'เพิ่มนักเรียนพร้อมห้องเรียนที่มีผล', permission: 'student.manage',
    input: obj({ student_code: S.studentCode, ...STUDENT_FIELDS, class_id: S.uuid, effective_from: S.date, roll_no: { type: ['integer', 'null'], minimum: 1, maximum: 200 } },
      ['student_code', 'first_name_th', 'last_name_th', 'class_id', 'effective_from']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'student.manage');
      const dup = yield ctx.store.findBy('Students', 'student_code', input.student_code);
      if (dup.length) throw new AppError('UNIQUE_VIOLATION', 'student_code exists', { messageTh: `มีรหัสนักเรียน ${input.student_code} อยู่แล้ว`, details: { existing_id: dup[0].id } });
      const cls = yield* getClass(ctx, input.class_id);
      if (!cls) throw notFound('class');
      const school = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
      const cs = ctx.changeSet();
      const s = cs.insert('Students', {
        school_id: school.id, student_code: input.student_code, prefix_th: input.prefix_th, first_name_th: input.first_name_th, last_name_th: input.last_name_th,
        first_name_en: input.first_name_en, last_name_en: input.last_name_en, nickname: input.nickname, gender: input.gender, birth_date: input.birth_date,
        status: 'ACTIVE', status_effective_date: input.effective_from, search_name: searchKey(input.prefix_th, input.first_name_th, input.last_name_th, input.nickname, input.first_name_en, input.last_name_en),
      });
      const e = cs.insert('Enrollments', { student_id: s.id, class_id: cls.id, academic_year_id: cls.academic_year_id, effective_from: input.effective_from, effective_to: null, roll_no: input.roll_no });
      cs.audit({ action: 'student.create', entityType: 'Students', entityId: s.id, studentId: s.id, after: { student_code: s.student_code, class_id: cls.id } });
      return yield* commit(ctx, cs, { student_id: s.id, enrollment_id: e.id });
    },
  }),

  op({
    name: 'student.update', mutation: true, description_th: 'แก้ไขข้อมูลนักเรียน (มี audit และ version)', permission: 'student.manage',
    input: obj({ student_id: S.uuid, ...STUDENT_FIELDS, first_name_th: { type: 'string', minLength: 1, maxLength: 100 }, last_name_th: { type: 'string', minLength: 1, maxLength: 100 }, reason: S.str(500) }, ['student_id', 'reason']),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'student.manage', { student_id: input.student_id });
      const s = yield* requireStudent(ctx, input.student_id);
      assertVersion(s, env.expected_version);
      const patch = {};
      for (const k of Object.keys(STUDENT_FIELDS)) if (k in input) patch[k] = input[k];
      const merged = { ...s, ...patch };
      patch.search_name = searchKey(merged.prefix_th, merged.first_name_th, merged.last_name_th, merged.nickname, merged.first_name_en, merged.last_name_en);
      const cs = ctx.changeSet();
      const after = cs.update('Students', s, patch);
      cs.audit({ action: 'student.update', entityType: 'Students', entityId: s.id, studentId: s.id, reason: input.reason, table: 'Students', before: s, after });
      return yield* commit(ctx, cs, { student_id: s.id, version: after.version });
    },
  }),

  op({
    name: 'enrollment.change', mutation: true, description_th: 'ย้ายห้อง เลื่อนชั้น ย้ายออก พ้นสภาพ จบการศึกษา (มีวันที่มีผล)', permission: 'student.manage',
    input: obj({ student_id: S.uuid, effective_date: S.date, reason: S.enum('EnrollmentEndReason'), new_class_id: S.uuidOrNull, roll_no: { type: ['integer', 'null'], minimum: 1, maximum: 200 }, note: S.str(500) },
      ['student_id', 'effective_date', 'reason', 'note']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'student.manage', { student_id: input.student_id });
      const s = yield* requireStudent(ctx, input.student_id);
      const enrs = yield* enrollmentsOf(ctx, s.id);
      let newClass = null;
      if (input.new_class_id) {
        newClass = yield* getClass(ctx, input.new_class_id);
        if (!newClass) throw notFound('class');
      } else if (!EXIT_STATUS[input.reason]) {
        throw new AppError('VALIDATION_ERROR', 'new class required', { fieldErrors: [{ field: 'new_class_id', code: 'REQUIRED', message_th: 'กรุณาเลือกห้องใหม่' }] });
      }
      const plan = planEnrollmentChange({ enrollments: enrs, studentId: s.id, effectiveDate: input.effective_date, newClassId: newClass && newClass.id, academicYearId: newClass && newClass.academic_year_id, reason: input.reason, rollNo: input.roll_no });
      const cs = ctx.changeSet();
      if (plan.close) {
        const cur = enrs.find((e) => e.id === plan.close.id);
        cs.update('Enrollments', cur, { effective_to: plan.close.effective_to, end_reason: plan.close.end_reason });
      }
      let opened = null;
      if (plan.open) {
        if (findOverlap(enrs.map((e) => (plan.close && e.id === plan.close.id ? plan.close : e)), { id: 'new', ...plan.open })) {
          throw new AppError('VALIDATION_ERROR', 'overlap', { messageTh: 'ช่วงเวลาห้องเรียนซ้อนกัน' });
        }
        opened = cs.insert('Enrollments', plan.open);
      }
      if (EXIT_STATUS[input.reason]) cs.update('Students', s, { status: EXIT_STATUS[input.reason], status_effective_date: input.effective_date });
      if (input.effective_date <= ctx.today) {
        yield* enqueueJobOnce(ctx, cs, { job_type: 'attendance.recomputeStudent', payload: { student_id: s.id, from_date: input.effective_date, to_date: ctx.today }, dedupe_key: `recompute|${s.id}|${input.effective_date}` });
      }
      cs.audit({ action: 'enrollment.change', entityType: 'Students', entityId: s.id, studentId: s.id, reason: input.note, after: { reason: input.reason, effective_date: input.effective_date, new_class_id: newClass && newClass.id } });
      return yield* commit(ctx, cs, { student_id: s.id, closed_enrollment_id: plan.close ? plan.close.id : null, new_enrollment_id: opened ? opened.id : null });
    },
  }),

  op({
    name: 'student.createAccount', mutation: true, description_th: 'สร้างบัญชีนักเรียน (รอเปิดใช้งานด้วยคำเชิญ)', permission: 'student.manage',
    input: obj({ student_id: S.uuid, contact_email: { type: ['string', 'null'], format: 'email' } }, ['student_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'student.manage', { student_id: input.student_id });
      const s = yield* requireStudent(ctx, input.student_id);
      const existing = yield ctx.store.findBy('Users', 'student_id', s.id);
      if (existing.length) throw new AppError('UNIQUE_VIOLATION', 'account exists', { messageTh: 'นักเรียนคนนี้มีบัญชีแล้ว', details: { existing_id: existing[0].id } });
      const cs = ctx.changeSet();
      const u = cs.insert('Users', { school_id: s.school_id, user_type: 'STUDENT', display_name: `${s.first_name_th} ${s.last_name_th}`, contact_email: input.contact_email, student_id: s.id, status: 'INVITED' });
      cs.insert('UserRoles', { user_id: u.id, role: 'STUDENT', effective_from: ctx.today, granted_by: ctx.principal.user_id, reason: 'บัญชีนักเรียน' });
      cs.audit({ action: 'student.create_account', entityType: 'Users', entityId: u.id, studentId: s.id });
      return yield* commit(ctx, cs, { user_id: u.id });
    },
  }),

  // ───────── guardians ─────────
  op({
    name: 'guardian.search', description_th: 'ค้นหาผู้ปกครอง (ชื่อ/รหัสที่โรงเรียนรับรอง)', permission: 'guardian.manage',
    input: obj({ q: S.str(100), limit: S.limit }, ['q']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'guardian.manage');
      const byRef = yield ctx.store.findBy('Guardians', 'external_ref', input.q);
      const q = searchKey(input.q);
      const page = byRef.length ? { items: byRef } : yield ctx.store.list('Guardians', { where: { search_name: { contains: q } }, limit: input.limit || 30, orderBy: [['search_name', 'asc']] });
      return { items: page.items.map((g) => ({ id: g.id, external_ref: g.external_ref, prefix_th: g.prefix_th, first_name_th: g.first_name_th, last_name_th: g.last_name_th, status: g.status })) };
    },
  }),

  op({
    name: 'guardian.create', mutation: true, description_th: 'เพิ่มผู้ปกครองและช่องทางติดต่อ (เจ้าหน้าที่ยืนยัน)', permission: 'guardian.manage',
    input: obj({
      external_ref: { type: ['string', 'null'], pattern: '^[0-9A-Za-z_-]{1,40}$' }, prefix_th: S.strOrNull(30), first_name_th: S.str(100), last_name_th: S.str(100),
      contacts: { type: 'array', maxItems: 5, items: obj({ channel: { type: 'string', enum: ['PHONE', 'EMAIL'] }, value: S.str(254), label_th: S.strOrNull(100), is_primary: S.bool }, ['channel', 'value']) },
    }, ['first_name_th', 'last_name_th']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'guardian.manage');
      if (input.external_ref && (yield ctx.store.findBy('Guardians', 'external_ref', input.external_ref)).length) {
        throw new AppError('UNIQUE_VIOLATION', 'external_ref exists', { messageTh: 'มีรหัสผู้ปกครองนี้แล้ว' });
      }
      const school = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
      const cs = ctx.changeSet();
      const g = cs.insert('Guardians', { school_id: school.id, external_ref: input.external_ref, prefix_th: input.prefix_th, first_name_th: input.first_name_th, last_name_th: input.last_name_th, search_name: searchKey(input.prefix_th, input.first_name_th, input.last_name_th), status: 'ACTIVE' });
      for (const c of input.contacts || []) addContact(cs, ctx, g.id, c);
      cs.audit({ action: 'guardian.create', entityType: 'Guardians', entityId: g.id, after: { external_ref: g.external_ref, contacts: (input.contacts || []).length } });
      return yield* commit(ctx, cs, { guardian_id: g.id });
    },
  }),

  op({
    name: 'guardian.link', mutation: true, description_th: 'ผูกผู้ปกครองกับนักเรียน (เจ้าหน้าที่ยืนยันตัวตนแล้ว) พร้อมสิทธิ์และการรับแจ้ง', permission: 'guardian.manage',
    input: obj({
      student_id: S.uuid, guardian_id: S.uuid, relationship: S.enum('Relationship'), relationship_note: S.strOrNull(200), is_primary_contact: S.bool,
      contact_priority: S.int(1, 9), permitted_actions: S.enumList('GuardianPermission'), notification_preferences: { type: ['object', 'null'] },
      verification_method: S.enum('VerificationMethod'), effective_from: S.date,
    }, ['student_id', 'guardian_id', 'relationship', 'is_primary_contact', 'contact_priority', 'verification_method', 'effective_from']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'guardian.manage', { student_id: input.student_id });
      yield* requireStudent(ctx, input.student_id);
      const g = yield ctx.store.get('Guardians', input.guardian_id);
      if (!g) throw notFound('guardian');
      const links = yield ctx.store.findBy('StudentGuardians', 'student_id', input.student_id);
      if (links.some((l) => l.guardian_id === g.id && l.status === 'ACTIVE' && dateInRange(input.effective_from, l.effective_from, l.effective_to))) {
        throw new AppError('UNIQUE_VIOLATION', 'already linked', { messageTh: 'ผูกผู้ปกครองคนนี้กับนักเรียนแล้ว' });
      }
      const cs = ctx.changeSet();
      if (input.is_primary_contact) {
        for (const l of links.filter((x) => x.status === 'ACTIVE' && x.is_primary_contact)) cs.update('StudentGuardians', l, { is_primary_contact: false });
      }
      const link = cs.insert('StudentGuardians', {
        student_id: input.student_id, guardian_id: g.id, relationship: input.relationship, relationship_note: input.relationship_note,
        is_primary_contact: input.is_primary_contact, contact_priority: input.contact_priority,
        permitted_actions: input.permitted_actions || DEFAULT_GUARDIAN_PERMISSIONS, notification_preferences: input.notification_preferences || DEFAULT_NOTIFICATION_PREFS,
        status: 'ACTIVE', verified_by: ctx.principal.user_id, verified_at: ctx.now, verification_method: input.verification_method, effective_from: input.effective_from, effective_to: null,
      });
      cs.audit({ action: 'guardian.link', entityType: 'StudentGuardians', entityId: link.id, studentId: input.student_id, after: { guardian_id: g.id, relationship: input.relationship, permitted_actions: link.permitted_actions, verification_method: input.verification_method } });
      return yield* commit(ctx, cs, { link_id: link.id });
    },
  }),

  op({
    name: 'guardian.updateLink', mutation: true, description_th: 'แก้ไขสิทธิ์/การรับแจ้ง/ลำดับติดต่อของความสัมพันธ์ (มี audit)', permission: 'guardian.manage',
    input: obj({ link_id: S.uuid, is_primary_contact: S.bool, contact_priority: S.int(1, 9), permitted_actions: S.enumList('GuardianPermission'), notification_preferences: { type: 'object' }, reason: S.str(500) }, ['link_id', 'reason']),
    *handler(ctx, input, env) {
      const link = yield ctx.store.get('StudentGuardians', input.link_id);
      if (!link) throw notFound('link');
      yield* requirePermission(ctx, 'guardian.manage', { student_id: link.student_id });
      assertVersion(link, env.expected_version);
      const patch = {};
      for (const k of ['is_primary_contact', 'contact_priority', 'permitted_actions', 'notification_preferences']) if (k in input) patch[k] = input[k];
      const cs = ctx.changeSet();
      const after = cs.update('StudentGuardians', link, patch);
      cs.audit({ action: 'guardian.update_link', entityType: 'StudentGuardians', entityId: link.id, studentId: link.student_id, reason: input.reason, table: 'StudentGuardians', before: link, after });
      return yield* commit(ctx, cs, { link_id: link.id, version: after.version });
    },
  }),

  op({
    name: 'guardian.endLink', mutation: true, description_th: 'สิ้นสุดความสัมพันธ์ (เช่น เปลี่ยนผู้ปกครอง) — ผู้ปกครองหมดสิทธิ์เห็นข้อมูลและไม่ได้รับข้อความใหม่', permission: 'guardian.manage',
    input: obj({ link_id: S.uuid, effective_to: S.date, reason: S.str(500) }, ['link_id', 'effective_to', 'reason']),
    *handler(ctx, input) {
      const link = yield ctx.store.get('StudentGuardians', input.link_id);
      if (!link) throw notFound('link');
      yield* requirePermission(ctx, 'guardian.manage', { student_id: link.student_id });
      if (link.status === 'ENDED') throw new AppError('INVALID_STATE', 'ended');
      if (input.effective_to <= link.effective_from) throw new AppError('VALIDATION_ERROR', 'range', { messageTh: 'วันสิ้นสุดต้องหลังวันเริ่มความสัมพันธ์ (ช่วงเวลาแบบไม่รวมวันสิ้นสุด)' });
      const cs = ctx.changeSet();
      // effective_to is exclusive; access ends at the start of that date. Status flips now when already ended.
      const after = cs.update('StudentGuardians', link, { status: input.effective_to <= ctx.today ? 'ENDED' : link.status, effective_to: input.effective_to });
      cs.audit({ action: 'guardian.end_link', entityType: 'StudentGuardians', entityId: link.id, studentId: link.student_id, reason: input.reason, table: 'StudentGuardians', before: link, after });
      return yield* commit(ctx, cs, { link_id: link.id });
    },
  }),

  op({
    name: 'guardian.listForStudent', description_th: 'ผู้ปกครองและช่องทางติดต่อของนักเรียน', permission: 'guardian.read_contact',
    input: obj({ student_id: S.uuid }, ['student_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'guardian.read_contact', { student_id: input.student_id });
      const links = yield ctx.store.findBy('StudentGuardians', 'student_id', input.student_id);
      const out = [];
      for (const l of links.sort((a, b) => a.contact_priority - b.contact_priority)) {
        const g = yield ctx.store.get('Guardians', l.guardian_id);
        const contacts = (yield ctx.store.findBy('ContactEndpoints', 'owner_id', l.guardian_id)).filter((c) => c.status === 'ACTIVE');
        const users = (yield ctx.store.findBy('Users', 'guardian_id', l.guardian_id)).map(publicUser);
        out.push({ link: l, guardian: g, contacts, accounts: users });
      }
      return { items: out };
    },
  }),

  op({
    name: 'contact.add', mutation: true, description_th: 'เพิ่มช่องทางติดต่อผู้ปกครอง (เจ้าหน้าที่ยืนยัน)', permission: 'guardian.manage',
    input: obj({ guardian_id: S.uuid, channel: { type: 'string', enum: ['PHONE', 'EMAIL'] }, value: S.str(254), label_th: S.strOrNull(100), is_primary: S.bool, reason: S.str(300) }, ['guardian_id', 'channel', 'value', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'guardian.manage');
      const g = yield ctx.store.get('Guardians', input.guardian_id);
      if (!g) throw notFound('guardian');
      const cs = ctx.changeSet();
      if (input.is_primary) {
        for (const c of (yield ctx.store.findBy('ContactEndpoints', 'owner_id', g.id)).filter((x) => x.channel === input.channel && x.is_primary && x.status === 'ACTIVE')) cs.update('ContactEndpoints', c, { is_primary: false });
      }
      const c = addContact(cs, ctx, g.id, input);
      cs.audit({ action: 'contact.add', entityType: 'ContactEndpoints', entityId: c.id, reason: input.reason, after: { channel: c.channel } });
      return yield* commit(ctx, cs, { contact_id: c.id });
    },
  }),

  op({
    name: 'contact.disable', mutation: true, description_th: 'ยกเลิกช่องทางติดต่อ (มี audit)', permission: 'guardian.manage',
    input: obj({ contact_id: S.uuid, reason: S.str(300) }, ['contact_id', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'guardian.manage');
      const c = yield ctx.store.get('ContactEndpoints', input.contact_id);
      if (!c) throw notFound('contact');
      const cs = ctx.changeSet();
      const after = cs.update('ContactEndpoints', c, { status: 'INACTIVE', is_primary: false });
      cs.audit({ action: 'contact.disable', entityType: 'ContactEndpoints', entityId: c.id, reason: input.reason, table: 'ContactEndpoints', before: c, after });
      return yield* commit(ctx, cs, { contact_id: c.id });
    },
  }),

  op({
    name: 'guardian.createAccount', mutation: true, description_th: 'สร้างบัญชีผู้ปกครอง (ยังไม่มีสิทธิ์จนใช้คำเชิญ)', permission: 'guardian.manage',
    input: obj({ guardian_id: S.uuid, contact_email: { type: ['string', 'null'], format: 'email' } }, ['guardian_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'guardian.manage');
      const g = yield ctx.store.get('Guardians', input.guardian_id);
      if (!g) throw notFound('guardian');
      const existing = yield ctx.store.findBy('Users', 'guardian_id', g.id);
      if (existing.length) throw new AppError('UNIQUE_VIOLATION', 'account exists', { messageTh: 'ผู้ปกครองคนนี้มีบัญชีแล้ว', details: { existing_id: existing[0].id } });
      const cs = ctx.changeSet();
      const u = cs.insert('Users', { school_id: g.school_id, user_type: 'GUARDIAN', display_name: `${g.first_name_th} ${g.last_name_th}`, contact_email: input.contact_email, guardian_id: g.id, status: 'INVITED' });
      cs.insert('UserRoles', { user_id: u.id, role: 'GUARDIAN', effective_from: ctx.today, granted_by: ctx.principal.user_id, reason: 'บัญชีผู้ปกครอง' });
      cs.audit({ action: 'guardian.create_account', entityType: 'Users', entityId: u.id });
      return yield* commit(ctx, cs, { user_id: u.id });
    },
  }),
];

function addContact(cs, ctx, guardianId, c) {
  const value = c.channel === 'PHONE' ? String(c.value).replace(/[\s-]/g, '') : String(c.value).toLowerCase();
  if (c.channel === 'PHONE' && !/^\+?[0-9]{9,15}$/.test(value)) throw new AppError('VALIDATION_ERROR', 'phone', { fieldErrors: [{ field: 'value', code: 'FORMAT', message_th: 'เบอร์โทรไม่ถูกต้อง' }] });
  return cs.insert('ContactEndpoints', { owner_type: 'GUARDIAN', owner_id: guardianId, channel: c.channel, value, label_th: c.label_th || null, is_primary: !!c.is_primary, verified_at: ctx.now, verified_by: ctx.principal.user_id, status: 'ACTIVE' });
}

export { rosterOf };

// RBAC + data-scope permission matrix (MASTER_PROMPT §6). Pure: decisions are computed from
// "facts" that the application layer loads from repositories (roles, assignments, verified
// guardian links). Server code calls this for EVERY operation, including searches, reports,
// exports and attachment downloads. Client-supplied roles/user IDs are never used.
//
// Scope kinds:
//   SCHOOL        all students of the school (role-wide)
//   SCHOOL_BASIC  any student, identification fields only (name, code, class, photo) — gate work
//   CLASS         students enrolled (on the relevant date) in classes assigned to the user
//                 (HOMEROOM incl. active delegation, or TEACHING for subject teachers)
//   LINKED        students with an ACTIVE, staff-verified StudentGuardians link that grants the
//                 required guardian permission
//   SELF          the student's own record
//   OWN           a resource owned by the user (own request, own notification, own job)
//   SYSTEM        system administration without student data access

export const ACTIONS = Object.freeze({
  'self.read': 'ดูข้อมูลบัญชีของตนเอง',
  'student.read': 'ดูข้อมูลนักเรียนและประวัติ',
  'student.read_basic': 'ดูข้อมูลระบุตัว (ชื่อ รหัส ห้อง รูป) เพื่อลงเวลา',
  'student.search': 'ค้นหานักเรียน',
  'student.manage': 'เพิ่ม/แก้ไขนักเรียน ห้อง และการลงทะเบียน',
  'guardian.read_contact': 'ดูข้อมูลติดต่อผู้ปกครอง',
  'guardian.manage': 'เพิ่ม/ยืนยัน/เปลี่ยนผู้ปกครอง เบอร์ และความสัมพันธ์',
  'guardian.invite': 'ออกคำเชิญผู้ปกครองที่ยืนยันความสัมพันธ์แล้ว',
  'attendance.record': 'ลงเวลามาถึง',
  'attendance.read': 'ดูข้อมูลการมาเรียน',
  'attendance.read_station': 'ดูรายการลงเวลาของจุดลงเวลาวันนี้',
  'attendance.rollcall': 'เช็กชื่อประจำวัน',
  'attendance.verify': 'ยืนยันการขาดเรียน/ตรวจสอบรายวัน',
  'attendance.correct': 'แก้ไขข้อมูลการมาเรียนย้อนหลัง (มีเหตุผล)',
  'attendance.request_correction': 'ร้องขอแก้ไขข้อมูลการมาเรียน',
  'attendance.exempt': 'รับรองข้อยกเว้นการนับสาย (เช่น รถโรงเรียนล่าช้า)',
  'attendance.reconcile': 'ปิดงานตรวจสอบข้อมูลขัดกัน',
  'leave.submit': 'แจ้งลา',
  'leave.read': 'ดูใบลา',
  'leave.confirm_guardian': 'ผู้ปกครองยืนยันใบลา',
  'leave.approve': 'พิจารณาใบลา (ตามเส้นทางอนุมัติ)',
  'leave.withdraw': 'ถอนคำขอลา',
  'leave.cancel': 'ขอยกเลิก/ยกเลิกใบลาที่อนุมัติแล้ว',
  'attachment.upload': 'อัปโหลดไฟล์',
  'attachment.read': 'ดาวน์โหลดไฟล์ทั่วไปที่เกี่ยวข้อง',
  'attachment.read_sensitive': 'ดาวน์โหลดเอกสารอ่อนไหว (เช่น ใบรับรองแพทย์)',
  'case.read': 'ดูรายละเอียดเรื่องติดตาม',
  'case.read_summary': 'ดูสรุปเรื่องติดตาม',
  'case.manage': 'เปิด/มอบหมาย/ส่งต่อ/ปิดเรื่องติดตาม',
  'case.record_contact': 'บันทึกการติดต่อและนัดหมาย',
  'notification.read_own': 'ดูการแจ้งเตือนของตน',
  'notification.acknowledge': 'รับทราบ/ขอให้ติดต่อกลับ',
  'notification.monitor': 'ดูสถานะคิวแจ้งเตือนและรายการส่งไม่สำเร็จ',
  'notification.resend': 'ส่งการแจ้งเตือนใหม่',
  'channel.bind': 'เชื่อมช่องทาง LINE ของตน',
  'report.view': 'ดูรายงาน',
  'report.export': 'ส่งออกรายงาน (CSV/XLSX/PDF)',
  'report.lock': 'ล็อกรอบรายงาน',
  'audit.read': 'ดู audit log',
  'import.manage': 'นำเข้าข้อมูล',
  'migration.export': 'ส่งออก portable snapshot ทั้งระบบ',
  'migration.validate': 'ตรวจ package ย้ายข้อมูล',
  'migration.import': 'นำเข้า package ลง staging/ปลายทางใหม่',
  'migration.cutover': 'เปลี่ยนสถานะ cutover/rollback',
  'backup.manage': 'สำรอง/ทดสอบ restore',
  'settings.business': 'ตั้งค่าธุรกิจ (กฎ ปฏิทิน คาบ จุดลงเวลา)',
  'settings.system': 'ตั้งค่าระบบ (โหมดอ่านอย่างเดียว feature flags งานเบื้องหลัง)',
  'user.read': 'ดูรายชื่อผู้ใช้และบทบาท',
  'user.manage': 'สร้าง/ระงับบัญชีบุคลากรและออกคำเชิญ',
  'role.assign': 'กำหนด/เพิกถอนบทบาท',
  'system.health': 'ดูสถานะระบบ',
  'system.maintenance': 'สั่งงานบำรุงรักษา (อ่านอย่างเดียว กู้รายการค้าง)',
  'job.read': 'ดูสถานะงานเบื้องหลัง',
});

const g = (role, action, scope, extra = {}) => ({ role, action, scope, ...extra });

// Order is not significant. Absence of a grant = deny.
export const GRANTS = Object.freeze([
  // everyone authenticated (role list below is exhaustive on purpose)
  ...['SYSTEM_ADMIN', 'STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF', 'GUARDIAN', 'STUDENT'].flatMap((r) => [
    g(r, 'self.read', 'OWN'), g(r, 'notification.read_own', 'OWN'), g(r, 'notification.acknowledge', 'OWN'),
    g(r, 'attachment.upload', 'OWN'), g(r, 'job.read', 'OWN'),
  ]),
  ...['GUARDIAN', 'STUDENT', 'HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'].map((r) => g(r, 'channel.bind', 'OWN')),

  // STUDENT_AFFAIRS — school-wide student data work
  ...['student.read', 'student.read_basic', 'student.search', 'student.manage', 'guardian.read_contact', 'guardian.manage', 'guardian.invite',
    'attendance.record', 'attendance.read', 'attendance.read_station', 'attendance.rollcall', 'attendance.verify', 'attendance.correct', 'attendance.exempt', 'attendance.reconcile',
    'leave.submit', 'leave.read', 'leave.approve', 'leave.withdraw', 'leave.cancel', 'attachment.read', 'attachment.read_sensitive',
    'case.read', 'case.read_summary', 'case.manage', 'case.record_contact', 'notification.monitor', 'notification.resend',
    'report.view', 'report.export', 'report.lock', 'audit.read', 'import.manage', 'settings.business', 'user.read', 'system.health',
  ].map((a) => g('STUDENT_AFFAIRS', a, 'SCHOOL')),

  // EXECUTIVE — overview + drill-down, no retroactive edits
  ...['student.read', 'student.read_basic', 'student.search', 'attendance.read', 'leave.read', 'case.read_summary', 'report.view', 'report.export']
    .map((a) => g('EXECUTIVE', a, 'SCHOOL')),

  // HOMEROOM_TEACHER — own classes (incl. active delegation)
  ...['student.read', 'student.read_basic', 'student.search', 'guardian.read_contact', 'guardian.invite', 'attendance.read', 'attendance.rollcall', 'attendance.verify',
    'attendance.correct', 'attendance.reconcile', 'leave.submit', 'leave.read', 'leave.approve', 'attachment.read', 'attachment.read_sensitive',
    'case.read', 'case.read_summary', 'case.manage', 'case.record_contact', 'report.view', 'report.export',
  ].map((a) => g('HOMEROOM_TEACHER', a, 'CLASS', { classSource: 'HOMEROOM' })),
  ...['case.read', 'case.manage', 'case.record_contact'].map((a) => g('HOMEROOM_TEACHER', a, 'OWN')),
  g('HOMEROOM_TEACHER', 'leave.withdraw', 'OWN'),

  // SUBJECT_TEACHER — roster/status for taught classes, no health documents
  ...['student.read_basic', 'student.search', 'attendance.read', 'leave.read'].map((a) => g('SUBJECT_TEACHER', a, 'CLASS', { classSource: 'TEACHING' })),

  // DUTY_TEACHER / GATE_STAFF — identification + recording only, no bulk export
  ...['DUTY_TEACHER', 'GATE_STAFF'].flatMap((r) => ['student.read_basic', 'student.search', 'attendance.record', 'attendance.read_station'].map((a) => g(r, a, 'SCHOOL_BASIC'))),

  // GUARDIAN — verified, effective links only; per-link permitted actions
  g('GUARDIAN', 'student.read', 'LINKED', { guardianPermission: 'VIEW_ATTENDANCE' }),
  g('GUARDIAN', 'student.read_basic', 'LINKED', { guardianPermission: 'VIEW_ATTENDANCE' }),
  g('GUARDIAN', 'attendance.read', 'LINKED', { guardianPermission: 'VIEW_ATTENDANCE' }),
  g('GUARDIAN', 'attendance.request_correction', 'LINKED', { guardianPermission: 'VIEW_ATTENDANCE' }),
  g('GUARDIAN', 'leave.read', 'LINKED', { guardianPermission: 'VIEW_ATTENDANCE' }),
  g('GUARDIAN', 'leave.submit', 'LINKED', { guardianPermission: 'SUBMIT_LEAVE' }),
  g('GUARDIAN', 'leave.confirm_guardian', 'LINKED', { guardianPermission: 'CONFIRM_LEAVE' }),
  g('GUARDIAN', 'leave.withdraw', 'OWN'),
  g('GUARDIAN', 'leave.cancel', 'LINKED', { guardianPermission: 'SUBMIT_LEAVE' }),
  g('GUARDIAN', 'attachment.read', 'LINKED', { guardianPermission: 'VIEW_DOCUMENTS' }),
  g('GUARDIAN', 'attachment.read_sensitive', 'OWN'),
  g('GUARDIAN', 'case.read_summary', 'LINKED', { guardianPermission: 'VIEW_CASE_SUMMARY' }),

  // STUDENT — own data, leave request, correction request
  ...['student.read', 'student.read_basic', 'attendance.read', 'attendance.request_correction', 'leave.submit', 'leave.read', 'leave.cancel', 'attachment.read']
    .map((a) => g('STUDENT', a, 'SELF')),
  g('STUDENT', 'leave.withdraw', 'OWN'),
  g('STUDENT', 'attachment.read_sensitive', 'OWN'),

  // SYSTEM_ADMIN — system work only; personal data requires an additional role
  ...['notification.monitor', 'audit.read', 'migration.export', 'migration.validate', 'migration.import', 'migration.cutover', 'backup.manage',
    'settings.system', 'user.read', 'user.manage', 'role.assign', 'system.health', 'system.maintenance', 'job.read']
    .map((a) => g('SYSTEM_ADMIN', a, 'SYSTEM')),
]);

/**
 * @typedef {object} PrincipalFacts
 * @property {string} user_id
 * @property {Set<string>} roles                       effective roles today
 * @property {Set<string>} homeroomClassIds            incl. active delegations
 * @property {Set<string>} teachingClassIds
 * @property {Map<string, Set<string>>} guardianLinks  student_id → permitted guardian actions (ACTIVE + effective)
 * @property {string|null} selfStudentId
 *
 * @typedef {object} ResourceScope
 * @property {string} [student_id]
 * @property {Iterable<string>} [class_ids]  classes relevant to the resource (student's enrollment on the relevant date, or the class itself)
 * @property {string} [owner_user_id]
 */

function intersects(set, iterable) {
  if (!iterable) return false;
  for (const x of iterable) if (set.has(x)) return true;
  return false;
}

function grantMatches(grant, facts, resource) {
  switch (grant.scope) {
    case 'SCHOOL':
    case 'SCHOOL_BASIC':
    case 'SYSTEM':
      return true;
    case 'CLASS': {
      const set = grant.classSource === 'TEACHING' ? facts.teachingClassIds : facts.homeroomClassIds;
      return !!set && intersects(set, resource.class_ids);
    }
    case 'LINKED': {
      if (!resource.student_id || !facts.guardianLinks) return false;
      const perms = facts.guardianLinks.get(resource.student_id);
      return !!perms && (!grant.guardianPermission || perms.has(grant.guardianPermission));
    }
    case 'SELF':
      return !!resource.student_id && facts.selfStudentId === resource.student_id;
    case 'OWN':
      return !!resource.owner_user_id && resource.owner_user_id === facts.user_id;
    default:
      return false;
  }
}

/** Pure decision. Returns { allowed, grant } where grant is the first matching grant (for audit). */
export function decide(facts, action, resource = {}) {
  if (!ACTIONS[action]) return { allowed: false, grant: null, reason: 'UNKNOWN_ACTION' };
  for (const grant of GRANTS) {
    if (grant.action !== action || !facts.roles.has(grant.role)) continue;
    if (grantMatches(grant, facts, resource)) return { allowed: true, grant };
  }
  return { allowed: false, grant: null, reason: 'NO_MATCHING_GRANT' };
}

/** Roles that hold `action` through any grant (used by UI menus and docs). */
export function rolesFor(action) {
  return [...new Set(GRANTS.filter((x) => x.action === action).map((x) => x.role))];
}

/**
 * Data filter for list/search endpoints, computed BEFORE pagination.
 * Returns null when the principal has no grant at all for the action.
 */
export function listScope(facts, action) {
  let all = false;
  const classIds = new Set();
  const studentIds = new Set();
  let own = false;
  let any = false;
  for (const grant of GRANTS) {
    if (grant.action !== action || !facts.roles.has(grant.role)) continue;
    any = true;
    switch (grant.scope) {
      case 'SCHOOL': case 'SCHOOL_BASIC': case 'SYSTEM': all = true; break;
      case 'CLASS': for (const c of (grant.classSource === 'TEACHING' ? facts.teachingClassIds : facts.homeroomClassIds) || []) classIds.add(c); break;
      case 'LINKED':
        for (const [sid, perms] of facts.guardianLinks || []) if (!grant.guardianPermission || perms.has(grant.guardianPermission)) studentIds.add(sid);
        break;
      case 'SELF': if (facts.selfStudentId) studentIds.add(facts.selfStudentId); break;
      case 'OWN': own = true; break;
    }
  }
  if (!any) return null;
  if (all) return { all: true, classIds: null, studentIds: null, own };
  return { all: false, classIds, studentIds, own };
}

/** Basic-only access: true when the principal may see a student only through SCHOOL_BASIC/basic grants. */
export function isBasicOnly(facts, resource) {
  return !decide(facts, 'student.read', resource).allowed && decide(facts, 'student.read_basic', resource).allowed;
}

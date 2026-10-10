// Synthetic DEV/STAGING data (MASTER_PROMPT §1 rule 8): fictional names, example.com emails,
// non-routable phone numbers (+999… — ITU reserved code), deterministic PRNG. Never runs in PROD.

import { createContext, commit } from './context.js';
import { systemPrincipal } from './principal.js';
import { AppError } from '../shared/errors.js';
import { SYSTEM_USER_ID, uuidV5 } from '../shared/uuid.js';
import { searchKey } from './ops/common.js';
import { DEFAULT_GUARDIAN_PERMISSIONS, DEFAULT_NOTIFICATION_PREFS } from './ops/students.js';
import { ENUMS } from '../schema/enums.js';

const BOYS = ['กิตติ', 'ชยพล', 'ณัฐวุฒิ', 'ธนกร', 'ปกรณ์', 'พงศกร', 'ภูมิพัฒน์', 'วรเมธ', 'ศุภชัย', 'อนุชา', 'กฤษดา', 'จิรายุ', 'ธีรเดช', 'นพดล', 'ปิยะพงษ์', 'รัฐภูมิ', 'สิทธิชัย', 'อภิวัฒน์', 'เอกชัย', 'ทินภัทร'];
const GIRLS = ['กมลชนก', 'จิราพร', 'ชนิดา', 'ณัฐธิดา', 'ธันยพร', 'นภัสสร', 'ปวีณา', 'พิมพ์ชนก', 'ภัทรา', 'มาลินี', 'รัตนาภรณ์', 'วรรณิดา', 'ศิริพร', 'สุภาวดี', 'อรอุมา', 'กัญญารัตน์', 'ชลธิชา', 'ดารุณี', 'เบญจวรรณ', 'ปาริชาติ'];
const SURNAMES = ['ทดสอบดี', 'ใจสมมติ', 'สุขตัวอย่าง', 'มั่นจำลอง', 'รักเรียนสาธิต', 'แสงทดลอง', 'ศรีสังเคราะห์', 'บุญตัวอย่าง', 'วงศ์ทดสอบ', 'คำจำลอง', 'ทองสมมติ', 'เพชรสาธิต', 'ชัยทดลอง', 'อินทร์ตัวอย่าง', 'จันทร์สังเคราะห์', 'พรหมทดสอบ', 'สมบูรณ์จำลอง', 'ประเสริฐสาธิต', 'นาคทดลอง', 'ดวงตัวอย่าง'];
const ADULTS = ['สมชาย', 'สมหญิง', 'ประยูร', 'บุญมี', 'มานพ', 'วิไล', 'สุดา', 'อำนวย', 'จันทร์เพ็ญ', 'เกษม'];

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_STAFF = [
  ['ผู้ดูแลระบบ (ทดสอบ)', ['SYSTEM_ADMIN'], 'admin'],
  ['เจ้าหน้าที่กิจการนักเรียน (ทดสอบ)', ['STUDENT_AFFAIRS'], 'affairs'],
  ['ผู้บริหาร (ทดสอบ)', ['EXECUTIVE'], 'exec'],
  ['ครูที่ปรึกษา ม.1/1 (ทดสอบ)', ['HOMEROOM_TEACHER'], 'homeroom1'],
  ['ครูที่ปรึกษา ม.1/2 (ทดสอบ)', ['HOMEROOM_TEACHER', 'DUTY_TEACHER'], 'homeroom2'],
  ['ครูประจำวิชา (ทดสอบ)', ['SUBJECT_TEACHER'], 'subject'],
  ['ครูเวรประตู (ทดสอบ)', ['DUTY_TEACHER'], 'duty'],
  ['เจ้าหน้าที่ประตู (ทดสอบ)', ['GATE_STAFF'], 'gate'],
];

/**
 * @param {object} deps
 * @param {{start_year_ce:number, grades?:string[], rooms_per_grade?:number, students_per_class?:number, seed?:number, guardian_accounts?:number, today?:string}} p
 */
export function* seedDemoData(deps, p) {
  if (deps.config.env === 'PROD') throw new AppError('FORBIDDEN', 'demo seed refused in PROD');
  const ctx = yield* createContext(deps, { operation: 'setup.demoSeed', channel: 'EDITOR' });
  ctx.principal = systemPrincipal(SYSTEM_USER_ID);
  const rnd = prng(p.seed || 2569);
  const school = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
  if (!school) throw new AppError('CONFIGURATION_REQUIRED', 'run bootstrap first');
  if ((yield ctx.store.list('Students', { limit: 1 })).items.length) return { skipped: true, reason: 'students already exist' };
  const y = p.start_year_ce;
  const det = (name) => uuidV5(`demo|${p.seed || 2569}|${name}`);
  const writes = [];
  const flush = function* (cs) { if (!cs.isEmpty) { cs.maintenanceAllowed = true; yield* commit(ctx, cs, {}); writes.push(cs.writes.length); } };

  let cs = ctx.changeSet('setup.demoSeed');
  const year = cs.insert('AcademicYears', { id: det('year'), school_id: school.id, start_year_ce: y, label_th: `ปีการศึกษา ${y + 543}`, start_date: `${y}-05-01`, end_date: `${y + 1}-04-01`, status: 'ACTIVE' });
  const t1 = cs.insert('Terms', { id: det('t1'), academic_year_id: year.id, term_no: 1, code: `AY${y}-T1`, start_date: `${y}-05-01`, end_date: `${y}-10-16`, status: 'ACTIVE' });
  const t2 = cs.insert('Terms', { id: det('t2'), academic_year_id: year.id, term_no: 2, code: `AY${y}-T2`, start_date: `${y}-11-01`, end_date: `${y + 1}-04-01`, status: 'ACTIVE' });
  const stations = ['GATE-1', 'GATE-2'].map((code, i) => cs.insert('Stations', { id: det(`st${i}`), school_id: school.id, code, name_th: `ประตู ${i + 1} (ทดสอบ)`, station_type: 'GATE', status: 'ACTIVE' }));
  for (let n = 1; n <= 7; n++) {
    const start = [null, '08:30', '09:20', '10:10', '11:00', '13:00', '13:50', '14:40'][n];
    const end = [null, '09:20', '10:10', '11:00', '11:50', '13:50', '14:40', '15:30'][n];
    cs.insert('Periods', { id: det(`p${n}`), school_id: school.id, period_no: n, label_th: `คาบ ${n}`, session: n <= 4 ? 'AM' : 'PM', start_time: start, end_time: end, effective_from: `${y}-05-01`, effective_to: null, applies_to_level: null });
  }
  const grades = p.grades || ['M1', 'M2'];
  const rooms = p.rooms_per_grade || 2;
  const classes = [];
  for (const g of grades) for (let r = 1; r <= rooms; r++) {
    classes.push(cs.insert('Classes', { id: det(`c${g}${r}`), school_id: school.id, academic_year_id: year.id, grade_level: g, room_no: String(r), code: `${g}/${r}`, name_th: `${ENUMS.GradeLevel.th[g]}/${r}`, status: 'ACTIVE' }));
  }
  const staff = [];
  for (const [name, roles, key] of DEMO_STAFF) {
    const u = cs.insert('Users', { id: det(`staff-${key}`), school_id: school.id, user_type: 'STAFF', display_name: name, contact_email: `${key}@example.com`, staff_code: `T-${key.toUpperCase()}`, status: 'ACTIVE' });
    for (const role of roles) cs.insert('UserRoles', { user_id: u.id, role, effective_from: `${y}-05-01`, granted_by: SYSTEM_USER_ID, reason: 'ข้อมูลทดสอบ' });
    cs.insert('IdentityLinks', { user_id: u.id, provider: 'demo', issuer: 'cwk-demo', subject: u.id, email_at_link: `${key}@example.com`, linked_at: ctx.now, linked_via: 'DEMO_SEED', status: 'ACTIVE' });
    staff.push({ key, user: u });
  }
  const byKey = Object.fromEntries(staff.map((s) => [s.key, s.user]));
  if (classes[0]) cs.insert('StaffAssignments', { user_id: byKey.homeroom1.id, assignment_type: 'HOMEROOM', class_id: classes[0].id, effective_from: `${y}-05-01` });
  if (classes[1]) cs.insert('StaffAssignments', { user_id: byKey.homeroom2.id, assignment_type: 'HOMEROOM', class_id: classes[1].id, effective_from: `${y}-05-01` });
  if (classes[0]) cs.insert('StaffAssignments', { user_id: byKey.subject.id, assignment_type: 'TEACHING', class_id: classes[0].id, subject_code: 'ว21101', effective_from: `${y}-05-01` });
  cs.insert('StaffAssignments', { user_id: byKey.duty.id, assignment_type: 'DUTY', station_id: stations[0].id, effective_from: `${y}-05-01` });
  yield* flush(cs);

  const perClass = p.students_per_class || 10;
  let seq = 0;
  const guardianUsers = [];
  for (const c of classes) {
    cs = ctx.changeSet('setup.demoSeed');
    for (let i = 1; i <= perClass; i++) {
      seq++;
      const girl = rnd() < 0.5;
      const first = (girl ? GIRLS : BOYS)[Math.floor(rnd() * 20)];
      const last = SURNAMES[Math.floor(rnd() * SURNAMES.length)];
      const prefix = girl ? 'ด.ญ.' : 'ด.ช.';
      const code = String(seq).padStart(5, '0'); // leading zeros on purpose
      const s = cs.insert('Students', {
        id: det(`s${seq}`), school_id: school.id, student_code: code, prefix_th: prefix, first_name_th: first, last_name_th: last, gender: girl ? 'FEMALE' : 'MALE',
        status: 'ACTIVE', status_effective_date: `${y}-05-01`, search_name: searchKey(prefix, first, last),
      });
      cs.insert('Enrollments', { id: det(`e${seq}`), student_id: s.id, class_id: c.id, academic_year_id: year.id, effective_from: `${y}-05-01`, roll_no: i });
      const gFirst = ADULTS[Math.floor(rnd() * ADULTS.length)];
      const g = cs.insert('Guardians', { id: det(`g${seq}`), school_id: school.id, external_ref: `G-${code}`, prefix_th: rnd() < 0.5 ? 'นาย' : 'นาง', first_name_th: gFirst, last_name_th: last, search_name: searchKey(gFirst, last), status: 'ACTIVE' });
      cs.insert('ContactEndpoints', { owner_type: 'GUARDIAN', owner_id: g.id, channel: 'PHONE', value: `+99900${String(seq).padStart(6, '0')}`, label_th: 'มือถือ (ทดสอบ)', is_primary: true, verified_at: ctx.now, verified_by: SYSTEM_USER_ID, status: 'ACTIVE' });
      cs.insert('StudentGuardians', {
        id: det(`sg${seq}`), student_id: s.id, guardian_id: g.id, relationship: rnd() < 0.5 ? 'FATHER' : 'MOTHER', is_primary_contact: true, contact_priority: 1,
        permitted_actions: DEFAULT_GUARDIAN_PERMISSIONS, notification_preferences: DEFAULT_NOTIFICATION_PREFS, status: 'ACTIVE', verified_by: SYSTEM_USER_ID, verified_at: ctx.now,
        verification_method: 'SCHOOL_RECORD', effective_from: `${y}-05-01`,
      });
      if (guardianUsers.length < (p.guardian_accounts ?? 3)) {
        const gu = cs.insert('Users', { id: det(`gu${seq}`), school_id: school.id, user_type: 'GUARDIAN', display_name: `${gFirst} ${last} (ผู้ปกครองทดสอบ)`, contact_email: `guardian${seq}@example.com`, guardian_id: g.id, status: 'ACTIVE' });
        cs.insert('UserRoles', { user_id: gu.id, role: 'GUARDIAN', effective_from: `${y}-05-01`, granted_by: SYSTEM_USER_ID, reason: 'ข้อมูลทดสอบ' });
        cs.insert('IdentityLinks', { user_id: gu.id, provider: 'demo', issuer: 'cwk-demo', subject: gu.id, email_at_link: `guardian${seq}@example.com`, linked_at: ctx.now, linked_via: 'DEMO_SEED', status: 'ACTIVE' });
        guardianUsers.push({ user_id: gu.id, student_id: s.id });
      }
      if (seq === 1) {
        const su = cs.insert('Users', { id: det('student-user-1'), school_id: school.id, user_type: 'STUDENT', display_name: `${first} ${last} (นักเรียนทดสอบ)`, student_id: s.id, status: 'ACTIVE' });
        cs.insert('UserRoles', { user_id: su.id, role: 'STUDENT', effective_from: `${y}-05-01`, granted_by: SYSTEM_USER_ID, reason: 'ข้อมูลทดสอบ' });
        cs.insert('IdentityLinks', { user_id: su.id, provider: 'demo', issuer: 'cwk-demo', subject: su.id, linked_at: ctx.now, linked_via: 'DEMO_SEED', status: 'ACTIVE' });
      }
    }
    yield* flush(cs);
  }
  return { skipped: false, academic_year_id: year.id, terms: [t1.code, t2.code], classes: classes.length, students: seq, staff: staff.map((s) => ({ key: s.key, user_id: s.user.id })), guardian_users: guardianUsers, commits: writes.length };
}

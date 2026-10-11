// Idempotent bootstrap of an EMPTY installation (called by GAS adminSetup / REST setup CLI).
// Creates: school, system principal, first SYSTEM_ADMIN (INVITED) + single-use invitation bound to
// the installer's email, example rule versions (is_example = true) and default settings.
// Never creates passwords; never grants student-data roles to the bootstrap admin.

import { createContext, commit } from './context.js';
import { systemPrincipal } from './principal.js';
import { SYSTEM_USER_ID } from '../shared/uuid.js';
import { EXAMPLE_RULE_PARAMS } from '../domain/rules.js';
import { newInvitationCode, invitationHash } from './ops/auth.js';
import { addMinutesIso } from '../shared/time.js';

export const DEFAULT_SETTINGS = [
  ['ui.page_size', { value: 50 }, 'จำนวนรายการต่อหน้าเริ่มต้น'],
  ['ui.dashboard_poll_seconds', { value: 60 }, 'ความถี่ปรับข้อมูลแดชบอร์ด (วินาที) เฉพาะแท็บที่เปิด'],
  ['attendance.open_day_time', { value: '05:30' }, 'เวลาสร้างรายการรายวัน (UNKNOWN) ให้นักเรียนทุกคน'],
  ['attendance.rollcall_backdate_days', { value: 3 }, 'เช็กชื่อย้อนหลังได้กี่วัน (เกินนั้นใช้การแก้ไขข้อมูลที่มีเหตุผล)'],
  ['followup.evaluate_time', { value: '16:30' }, 'เวลาประเมินกฎติดตาม (สาย/ขาดสะสม) ประจำวัน หลังเลิกเรียน'],
  ['backup.nightly_time', { value: '01:30' }, 'เวลาสำรองข้อมูลประจำคืน (ช่วงไม่มีผู้ใช้ — การสำรองถือ lock ระหว่างคัดลอก)'],
  ['backup.retention_days', { value: 30 }, 'เก็บสำเนาสำรองกี่วัน (สำเนาเก่ากว่านี้ถูกย้ายไปถังขยะ)'],
  ['report.signature_lines', { value: ['ครูที่ปรึกษา', 'หัวหน้างานกิจการนักเรียน', 'รองผู้อำนวยการฝ่ายกิจการนักเรียน'] }, 'ช่องลงนามท้ายรายงาน (ตั้งค่าได้)'],
  ['privacy.notice_version', { value: 'DRAFT-1' }, 'เวอร์ชันประกาศความเป็นส่วนตัว (ร่าง — โรงเรียนต้องอนุมัติ)'],
  ['feature.subject_attendance', { value: false }, 'โมดูลเช็กชื่อรายคาบ (ปิด — ยังไม่ส่งมอบ)'],
  ['feature.campus_pass', { value: false }, 'โมดูลออกนอกโรงเรียน (ปิด — ยังไม่ส่งมอบ)'],
  ['feature.behavior_points', { value: false }, 'คะแนนพฤติกรรม (ปิดโดยค่าเริ่มต้น)'],
];

/**
 * @param {object} deps         ports (store, mutations, clock, ids, crypto, config)
 * @param {{school_code:string, school_name_th:string, unit_th?:string, admin_display_name:string, admin_email:string|null, rule_effective_from:string}} input
 * @returns {{created: string[], invitation_code: string|null}}
 */
export function* bootstrapInstallation(deps, input) {
  const ctx = yield* createContext(deps, { operation: 'setup.bootstrap', channel: 'EDITOR' });
  ctx.principal = systemPrincipal(SYSTEM_USER_ID);
  const created = [];
  const cs = ctx.changeSet('setup.bootstrap');
  cs.maintenanceAllowed = true;

  let school = (yield ctx.store.list('Schools', { limit: 2 })).items[0];
  if (!school) {
    school = cs.insert('Schools', { code: input.school_code, name_th: input.school_name_th, unit_th: input.unit_th || 'กลุ่มบริหารงานกิจการนักเรียน', timezone: 'Asia/Bangkok', locale: 'th-TH', brand_color: '#B91C1C' });
    created.push('Schools');
  }
  if (!(yield ctx.store.get('Users', SYSTEM_USER_ID))) {
    cs.insert('Users', { id: SYSTEM_USER_ID, school_id: school.id, user_type: 'SYSTEM', display_name: 'ระบบ (งานเบื้องหลัง)', status: 'ACTIVE' });
    created.push('Users:system');
  }
  let invitationCode = null;
  const admins = yield ctx.store.findBy('UserRoles', 'role', 'SYSTEM_ADMIN');
  if (!admins.some((r) => !r.revoked_at)) {
    const admin = cs.insert('Users', { school_id: school.id, user_type: 'STAFF', display_name: input.admin_display_name, contact_email: input.admin_email, status: 'INVITED' });
    cs.insert('UserRoles', { user_id: admin.id, role: 'SYSTEM_ADMIN', effective_from: ctx.today, granted_by: SYSTEM_USER_ID, reason: 'bootstrap ผู้ดูแลระบบคนแรก (สิทธิ์งานระบบเท่านั้น)' });
    invitationCode = newInvitationCode(ctx.crypto.randomBytes);
    cs.insert('InvitationRecords', {
      invitation_type: 'STAFF', target_user_id: admin.id, code_hash: invitationHash(invitationCode), bound_email: input.admin_email,
      expires_at: addMinutesIso(ctx.now, 24 * 60), max_attempts: 5, attempt_count: 0, status: 'PENDING',
    });
    created.push('Users:bootstrap-admin', 'InvitationRecords:bootstrap');
  }
  const rules = (yield ctx.store.list('RuleVersions', { limit: 200 })).items;
  for (const [ruleType, params] of Object.entries(EXAMPLE_RULE_PARAMS)) {
    if (rules.some((r) => r.rule_type === ruleType)) continue;
    cs.insert('RuleVersions', { school_id: school.id, rule_type: ruleType, version_no: 1, effective_from: input.rule_effective_from, effective_to: null, params_json: params, status: 'ACTIVE', is_example: true, notes_th: 'ค่าตัวอย่างจากการติดตั้ง — ต้องให้โรงเรียนกำหนดค่าจริงก่อน production' });
    created.push(`RuleVersions:${ruleType}`);
  }
  const settings = (yield ctx.store.list('Settings', { limit: 500 })).items;
  for (const [key, value, desc] of DEFAULT_SETTINGS) {
    if (settings.some((s) => s.key === key)) continue;
    cs.insert('Settings', { school_id: school.id, key, value_json: value, is_example: true, description_th: desc });
    created.push(`Settings:${key}`);
  }
  if (!cs.isEmpty) {
    cs.audit({ action: 'setup.bootstrap', entityType: 'Schools', entityId: school.id, after: { created } });
    yield* commit(ctx, cs, { created });
  }
  return { created, invitation_code: invitationCode, school_id: school.id };
}

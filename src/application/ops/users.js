// User, role, assignment and invitation management (SYSTEM_ADMIN / STUDENT_AFFAIRS per matrix).
import { op } from '../dispatcher.js';
import { obj, S, publicUser, assertVersion, notFound, searchKey } from './common.js';
import { requirePermission, scopeFor, allows } from '../authz.js';
import { commit } from '../context.js';
import { AppError } from '../../shared/errors.js';
import { addMinutesIso, dateInRange } from '../../shared/time.js';
import { newInvitationCode, invitationHash } from './auth.js';

const STAFF_ROLES = ['SYSTEM_ADMIN', 'STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF'];
const DATA_ROLES = new Set(['STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER']);

function* requireAny(ctx, actions, resource = {}) {
  let lastErr = null;
  for (const a of actions) {
    try { return yield* requirePermission(ctx, a, resource); } catch (e) { if (e.code !== 'FORBIDDEN') throw e; lastErr = e; }
  }
  throw lastErr;
}

export const userOps = [
  op({
    name: 'user.list', description_th: 'รายชื่อผู้ใช้และบทบาท', permission: 'user.read',
    input: obj({ user_type: S.enumOrNull('UserType'), status: S.enumOrNull('UserStatus'), q: S.strOrNull(100), cursor: S.cursor, limit: S.limit }),
    *handler(ctx, input) {
      scopeFor(ctx, 'user.read');
      const where = {};
      if (input.user_type) where.user_type = input.user_type;
      if (input.status) where.status = input.status;
      const page = yield ctx.store.list('Users', { where, orderBy: [['display_name', 'asc']], cursor: input.cursor, limit: input.limit || 50 });
      const q = input.q ? searchKey(input.q) : null;
      const items = [];
      for (const u of page.items) {
        if (q && !searchKey(u.display_name, u.staff_code, u.contact_email).includes(q)) continue;
        const roles = (yield ctx.store.findBy('UserRoles', 'user_id', u.id)).filter((r) => !r.revoked_at && dateInRange(ctx.today, r.effective_from, r.effective_to)).map((r) => r.role);
        items.push({ ...publicUser(u), roles });
      }
      return { items, next_cursor: page.next_cursor };
    },
  }),

  op({
    name: 'user.get', description_th: 'รายละเอียดผู้ใช้ บทบาท ขอบเขตงาน การเชื่อมบัญชี และคำเชิญ', permission: 'user.read',
    input: obj({ user_id: S.uuid }, ['user_id']),
    *handler(ctx, input) {
      scopeFor(ctx, 'user.read');
      const u = yield ctx.store.get('Users', input.user_id);
      if (!u) throw notFound('user');
      const roles = yield ctx.store.findBy('UserRoles', 'user_id', u.id);
      const assignments = yield ctx.store.findBy('StaffAssignments', 'user_id', u.id);
      const links = (yield ctx.store.findBy('IdentityLinks', 'user_id', u.id)).map((l) => ({ id: l.id, provider: l.provider, email_at_link: l.email_at_link, status: l.status, linked_at: l.linked_at }));
      const invitations = (yield ctx.store.findBy('InvitationRecords', 'target_user_id', u.id)).map((i) => ({ id: i.id, status: i.status, expires_at: i.expires_at, bound_email: i.bound_email, created_at: i.created_at }));
      return { user: { ...publicUser(u), student_id: u.student_id, guardian_id: u.guardian_id, disabled_reason: u.disabled_reason }, roles, assignments, identity_links: links, invitations };
    },
  }),

  op({
    name: 'user.createStaff', mutation: true, description_th: 'สร้างบัญชีบุคลากร (สถานะรอเปิดใช้งาน) พร้อมบทบาท', permission: 'user.manage + role.assign',
    input: obj({
      display_name: S.str(200), contact_email: { type: ['string', 'null'], format: 'email' }, staff_code: { type: ['string', 'null'], pattern: '^[0-9A-Za-z_-]{1,30}$' },
      roles: { type: 'array', minItems: 0, maxItems: 7, uniqueItems: true, items: { type: 'string', enum: STAFF_ROLES } }, effective_from: S.date,
    }, ['display_name', 'roles', 'effective_from']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'user.manage');
      if (input.roles.length) yield* requirePermission(ctx, 'role.assign');
      const school = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
      if (!school) throw new AppError('CONFIGURATION_REQUIRED', 'school missing');
      const cs = ctx.changeSet();
      const user = cs.insert('Users', { school_id: school.id, user_type: 'STAFF', display_name: input.display_name, contact_email: input.contact_email, staff_code: input.staff_code, status: 'INVITED' });
      for (const role of input.roles) {
        cs.insert('UserRoles', { user_id: user.id, role, effective_from: input.effective_from, effective_to: null, granted_by: ctx.principal.user_id, reason: 'สร้างบัญชี' });
      }
      cs.audit({ action: 'user.create', entityType: 'Users', entityId: user.id, after: { display_name: user.display_name, roles: input.roles } });
      return yield* commit(ctx, cs, { user_id: user.id });
    },
  }),

  op({
    name: 'user.setStatus', mutation: true, description_th: 'ระงับ/เปิดใช้บัญชี (มีผลทันทีกับคำขอถัดไป)', permission: 'user.manage',
    input: obj({ user_id: S.uuid, status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] }, reason: S.str(500) }, ['user_id', 'status', 'reason']),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'user.manage');
      if (input.user_id === ctx.principal.user_id) throw new AppError('FORBIDDEN', 'self', { messageTh: 'ไม่สามารถเปลี่ยนสถานะบัญชีของตนเองได้' });
      const u = yield ctx.store.get('Users', input.user_id);
      if (!u) throw notFound('user');
      if (u.user_type === 'SYSTEM') throw new AppError('FORBIDDEN', 'system user');
      assertVersion(u, env.expected_version);
      const cs = ctx.changeSet();
      const patch = input.status === 'DISABLED'
        ? { status: 'DISABLED', disabled_at: ctx.now, disabled_by: ctx.principal.user_id, disabled_reason: input.reason }
        : { status: 'ACTIVE', disabled_at: null, disabled_by: null, disabled_reason: null };
      const after = cs.update('Users', u, patch);
      cs.audit({ action: 'user.set_status', entityType: 'Users', entityId: u.id, reason: input.reason, table: 'Users', before: u, after });
      return yield* commit(ctx, cs, { user_id: u.id, status: after.status, version: after.version });
    },
  }),

  op({
    name: 'role.grant', mutation: true, description_th: 'กำหนดบทบาทพร้อมช่วงวันที่มีผล', permission: 'role.assign',
    input: obj({ user_id: S.uuid, role: S.enum('Role'), effective_from: S.date, effective_to: S.dateOrNull, reason: S.str(500) }, ['user_id', 'role', 'effective_from', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'role.assign');
      const u = yield ctx.store.get('Users', input.user_id);
      if (!u) throw notFound('user');
      if (['GUARDIAN', 'STUDENT'].includes(input.role)) {
        throw new AppError('VALIDATION_ERROR', 'guardian/student roles come from verified relationships', { messageTh: 'บทบาทผู้ปกครอง/นักเรียนกำหนดผ่านการยืนยันความสัมพันธ์และคำเชิญเท่านั้น' });
      }
      if (u.user_type !== 'STAFF') throw new AppError('VALIDATION_ERROR', 'staff roles only for staff users', { messageTh: 'กำหนดบทบาทบุคลากรได้เฉพาะบัญชีบุคลากร' });
      if (u.id === ctx.principal.user_id && (DATA_ROLES.has(input.role) || input.role === 'SYSTEM_ADMIN')) {
        throw new AppError('FORBIDDEN', 'self-escalation', { messageTh: 'ไม่สามารถเพิ่มบทบาทให้ตนเองได้ ต้องให้ผู้ดูแลอีกคนดำเนินการ (แยกหน้าที่)' });
      }
      if (input.effective_to && input.effective_to <= input.effective_from) throw new AppError('VALIDATION_ERROR', 'range', { messageTh: 'วันสิ้นสุดต้องหลังวันเริ่ม' });
      const cs = ctx.changeSet();
      const r = cs.insert('UserRoles', { user_id: u.id, role: input.role, effective_from: input.effective_from, effective_to: input.effective_to, granted_by: ctx.principal.user_id, reason: input.reason });
      cs.audit({ action: 'role.grant', entityType: 'UserRoles', entityId: r.id, reason: input.reason, after: { user_id: u.id, role: input.role, effective_from: input.effective_from, effective_to: input.effective_to } });
      return yield* commit(ctx, cs, { user_role_id: r.id });
    },
  }),

  op({
    name: 'role.revoke', mutation: true, description_th: 'เพิกถอนบทบาท (มีผลทันที)', permission: 'role.assign',
    input: obj({ user_role_id: S.uuid, reason: S.str(500) }, ['user_role_id', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'role.assign');
      const r = yield ctx.store.get('UserRoles', input.user_role_id);
      if (!r) throw notFound('role');
      if (r.revoked_at) throw new AppError('INVALID_STATE', 'already revoked');
      const cs = ctx.changeSet();
      const after = cs.update('UserRoles', r, { revoked_at: ctx.now, revoked_by: ctx.principal.user_id, effective_to: r.effective_to && r.effective_to <= ctx.today ? r.effective_to : (ctx.today > r.effective_from ? ctx.today : r.effective_from) });
      cs.audit({ action: 'role.revoke', entityType: 'UserRoles', entityId: r.id, reason: input.reason, table: 'UserRoles', before: r, after });
      return yield* commit(ctx, cs, { user_role_id: r.id });
    },
  }),

  op({
    name: 'assignment.create', mutation: true, description_th: 'กำหนดครูที่ปรึกษา/เวร/สอน/ผู้รักษาการแทน พร้อมช่วงเวลา', permission: 'user.manage | settings.business',
    input: obj({
      user_id: S.uuid, assignment_type: S.enum('AssignmentType'), class_id: S.uuidOrNull, station_id: S.uuidOrNull, weekday: { type: ['integer', 'null'], minimum: 1, maximum: 7 },
      subject_code: S.strOrNull(30), delegate_for_user_id: S.uuidOrNull, effective_from: S.date, effective_to: S.dateOrNull, notes: S.strOrNull(500),
    }, ['user_id', 'assignment_type', 'effective_from']),
    *handler(ctx, input) {
      yield* requireAny(ctx, ['user.manage', 'settings.business']);
      const u = yield ctx.store.get('Users', input.user_id);
      if (!u || u.user_type !== 'STAFF') throw new AppError('VALIDATION_ERROR', 'staff user required', { messageTh: 'ต้องเป็นบัญชีบุคลากร' });
      const need = { HOMEROOM: 'class_id', TEACHING: 'class_id', DUTY: 'station_id', DELEGATE: 'delegate_for_user_id' }[input.assignment_type];
      if (!input[need]) throw new AppError('VALIDATION_ERROR', `${need} required`, { fieldErrors: [{ field: need, code: 'REQUIRED', message_th: 'กรุณาระบุ' }] });
      if (input.effective_to && input.effective_to <= input.effective_from) throw new AppError('VALIDATION_ERROR', 'range', { messageTh: 'วันสิ้นสุดต้องหลังวันเริ่ม' });
      if (input.assignment_type === 'DELEGATE' && input.delegate_for_user_id === input.user_id) throw new AppError('VALIDATION_ERROR', 'self delegate');
      const cs = ctx.changeSet();
      const a = cs.insert('StaffAssignments', { ...input });
      cs.audit({ action: 'assignment.create', entityType: 'StaffAssignments', entityId: a.id, after: input });
      return yield* commit(ctx, cs, { assignment_id: a.id });
    },
  }),

  op({
    name: 'assignment.end', mutation: true, description_th: 'สิ้นสุดขอบเขตงาน', permission: 'user.manage | settings.business',
    input: obj({ assignment_id: S.uuid, effective_to: S.date, reason: S.str(500) }, ['assignment_id', 'effective_to', 'reason']),
    *handler(ctx, input) {
      yield* requireAny(ctx, ['user.manage', 'settings.business']);
      const a = yield ctx.store.get('StaffAssignments', input.assignment_id);
      if (!a) throw notFound('assignment');
      if (input.effective_to <= a.effective_from) throw new AppError('VALIDATION_ERROR', 'range', { messageTh: 'วันสิ้นสุดต้องหลังวันเริ่ม' });
      const cs = ctx.changeSet();
      const after = cs.update('StaffAssignments', a, { effective_to: input.effective_to });
      cs.audit({ action: 'assignment.end', entityType: 'StaffAssignments', entityId: a.id, reason: input.reason, table: 'StaffAssignments', before: a, after });
      return yield* commit(ctx, cs, { assignment_id: a.id });
    },
  }),

  op({
    name: 'invitation.create', mutation: true, rateLimitPerMinute: 30,
    description_th: 'ออกคำเชิญเปิดใช้งาน (แสดงรหัสครั้งเดียว) — บุคลากร: user.manage; ผู้ปกครอง: guardian.invite ต่อความสัมพันธ์ที่ยืนยันแล้ว; นักเรียน: student.manage',
    input: obj({ user_id: S.uuid, bound_email: { type: ['string', 'null'], format: 'email' }, valid_days: { type: ['integer', 'null'], minimum: 1, maximum: 30 } }, ['user_id']),
    *handler(ctx, input) {
      const u = yield ctx.store.get('Users', input.user_id);
      if (!u) throw notFound('user');
      if (u.status === 'DISABLED') throw new AppError('INVALID_STATE', 'disabled', { messageTh: 'บัญชีถูกระงับ' });
      if (u.user_type === 'STAFF') yield* requirePermission(ctx, 'user.manage');
      else if (u.user_type === 'GUARDIAN') {
        const links = (yield ctx.store.findBy('StudentGuardians', 'guardian_id', u.guardian_id)).filter((l) => l.status === 'ACTIVE' && dateInRange(ctx.today, l.effective_from, l.effective_to));
        if (!links.length) throw new AppError('INVALID_STATE', 'no verified relationship', { messageTh: 'ต้องยืนยันความสัมพันธ์ผู้ปกครอง-นักเรียนก่อนออกคำเชิญ' });
        let ok = false;
        for (const l of links) { if (yield* allows(ctx, 'guardian.invite', { student_id: l.student_id })) { ok = true; break; } }
        if (!ok) throw new AppError('FORBIDDEN', 'guardian.invite');
      } else if (u.user_type === 'STUDENT') yield* requirePermission(ctx, 'student.manage', { student_id: u.student_id });
      else throw new AppError('FORBIDDEN', 'system user');
      const active = (yield ctx.store.findBy('InvitationRecords', 'target_user_id', u.id)).filter((i) => i.status === 'PENDING');
      const code = newInvitationCode(ctx.crypto.randomBytes);
      const cs = ctx.changeSet();
      for (const old of active) cs.update('InvitationRecords', old, { status: 'REVOKED' });
      const inv = cs.insert('InvitationRecords', {
        invitation_type: u.user_type === 'STAFF' ? 'STAFF' : u.user_type, target_user_id: u.id, code_hash: invitationHash(code), bound_email: input.bound_email,
        expires_at: addMinutesIso(ctx.now, (input.valid_days || 7) * 1440), max_attempts: 5, attempt_count: 0, status: 'PENDING',
      });
      cs.audit({ action: 'invitation.create', entityType: 'InvitationRecords', entityId: inv.id, studentId: u.student_id || null, after: { target_user_id: u.id, bound_email: input.bound_email, expires_at: inv.expires_at } });
      // The code is returned to the requesting staff exactly once and is NOT stored in the idempotency result.
      yield* commit(ctx, cs, { invitation_id: inv.id, expires_at: inv.expires_at, code_returned_once: true });
      if (ctx.replayed) return { invitation_id: inv.id, expires_at: inv.expires_at, code: null, note_th: 'คำขอนี้เคยทำสำเร็จแล้ว รหัสแสดงได้ครั้งเดียว — ออกคำเชิญใหม่หากต้องการรหัส' };
      return { invitation_id: inv.id, expires_at: inv.expires_at, code };
    },
  }),

  op({
    name: 'invitation.revoke', mutation: true, description_th: 'ยกเลิกคำเชิญ', permission: 'user.manage | guardian.invite',
    input: obj({ invitation_id: S.uuid, reason: S.str(300) }, ['invitation_id', 'reason']),
    *handler(ctx, input) {
      const inv = yield ctx.store.get('InvitationRecords', input.invitation_id);
      if (!inv) throw notFound('invitation');
      const u = yield ctx.store.get('Users', inv.target_user_id);
      if (u.user_type === 'STAFF') yield* requirePermission(ctx, 'user.manage');
      else yield* requireAny(ctx, ['user.manage', 'guardian.manage']);
      if (inv.status !== 'PENDING') throw new AppError('INVALID_STATE', 'not pending', { messageTh: 'คำเชิญนี้ไม่อยู่ในสถานะรอใช้งาน' });
      const cs = ctx.changeSet();
      cs.update('InvitationRecords', inv, { status: 'REVOKED' });
      cs.audit({ action: 'invitation.revoke', entityType: 'InvitationRecords', entityId: inv.id, reason: input.reason });
      return yield* commit(ctx, cs, { invitation_id: inv.id });
    },
  }),

  op({
    name: 'identity.unlink', mutation: true, description_th: 'ยกเลิกการเชื่อมบัญชีผู้ให้บริการกับผู้ใช้ (เช่น บัญชีถูกยึด/เปลี่ยนผู้ปกครอง)', permission: 'user.manage',
    input: obj({ identity_link_id: S.uuid, reason: S.str(500) }, ['identity_link_id', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'user.manage');
      const l = yield ctx.store.get('IdentityLinks', input.identity_link_id);
      if (!l) throw notFound('identity link');
      if (l.status !== 'ACTIVE') throw new AppError('INVALID_STATE', 'not active');
      const cs = ctx.changeSet();
      cs.update('IdentityLinks', l, { status: 'REVOKED', revoked_at: ctx.now, revoked_by: ctx.principal.user_id });
      cs.audit({ action: 'identity.unlink', entityType: 'IdentityLinks', entityId: l.id, reason: input.reason });
      const res = yield* commit(ctx, cs, { identity_link_id: l.id });
      if (ctx.deps.identity.revokeSessions) {
        try { yield ctx.deps.identity.revokeSessions(l); } catch (_) { /* best effort; link already revoked in app */ }
      }
      return res;
    },
  }),
];

export { STAFF_ROLES };

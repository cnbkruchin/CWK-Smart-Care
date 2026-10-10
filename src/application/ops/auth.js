// Identity operations: public config, current user, invitation redemption, logout.
import { op } from '../dispatcher.js';
import { obj, S, EMPTY, publicUser } from './common.js';
import { ACTIONS, listScope } from '../../domain/permissions.js';
import { AppError } from '../../shared/errors.js';
import { sha256Hex } from '../../shared/hash.js';
import { loadSchool, commit } from '../context.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 100-bit random invitation code, e.g. "K7Q2M-9XZ4P-…" (5 groups × 4). Shown once; only the hash is stored. */
export function newInvitationCode(randomBytes) {
  const bytes = randomBytes(13);
  let bits = '';
  for (const b of bytes) bits += (b & 0xff).toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < 20; i++) out += CROCKFORD[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return out.match(/.{4}/g).join('-');
}

export function normalizeInvitationCode(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function invitationHash(code) {
  return sha256Hex(`cwk-invitation-v1|${normalizeInvitationCode(code)}`);
}

export function allowedActions(facts) {
  return Object.keys(ACTIONS).filter((a) => listScope(facts, a) !== null);
}

export const authOps = [
  op({
    name: 'app.publicConfig', auth: 'PUBLIC', description_th: 'ค่าตั้งค่าสาธารณะสำหรับหน้าเว็บ (ไม่มี secret)', input: EMPTY, rateLimitPerMinute: 60,
    *handler(ctx) {
      const c = ctx.config;
      let school = null;
      try { school = yield* loadSchool(ctx); } catch (_) { school = null; }
      return {
        env: c.env, auth_mode: c.authMode, firebase: c.firebasePublic || null, auth_persistence: c.authPersistence || 'SESSION',
        school: school ? { name_th: school.name_th, unit_th: school.unit_th, brand_color: school.brand_color, logo_file_id: school.logo_file_id } : null,
        line_enabled: !!c.lineEnabled, demo: c.authMode === 'DEMO', system_mode: c.systemMode, timezone: ctx.tz,
      };
    },
  }),

  op({
    name: 'auth.getCurrentUser', auth: 'IDENTITY', description_th: 'ข้อมูลผู้ใช้ปัจจุบัน บทบาท และเมนูที่มีสิทธิ์', input: EMPTY,
    *handler(ctx) {
      const p = ctx.principal;
      const claims = p.claims || {};
      if (!p.linked) {
        return { linked: false, email: claims.email || null, email_verified: !!claims.email_verified, user: null, roles: [], actions: [], needs: ['REDEEM_INVITATION'] };
      }
      const needs = [];
      if (claims.provider === 'firebase' && !claims.email_verified) needs.push('VERIFY_EMAIL');
      return {
        linked: true, email: claims.email || null, email_verified: !!claims.email_verified, user: publicUser(p.user), roles: [...p.roles].sort(),
        actions: allowedActions(p.facts), homeroom_class_ids: [...p.facts.homeroomClassIds], station_ids: [...p.facts.stationIds],
        linked_student_ids: [...p.facts.guardianLinks.keys()], self_student_id: p.facts.selfStudentId, needs,
      };
    },
  }),

  op({
    name: 'auth.redeemInvitation', auth: 'IDENTITY', mutation: true, rateLimitPerMinute: 10,
    description_th: 'ใช้รหัสคำเชิญผูกบัญชีผู้ให้บริการยืนยันตัวตนกับผู้ใช้ในระบบ (ครั้งเดียว มีอายุ)',
    input: obj({ code: S.str(40, 10) }, ['code']),
    *handler(ctx, input) {
      const p = ctx.principal;
      const claims = p.claims;
      if (p.linked) throw new AppError('INVALID_STATE', 'already linked', { messageTh: 'บัญชีนี้เชื่อมกับผู้ใช้ในระบบแล้ว' });
      if (claims.provider === 'firebase' && !claims.email_verified) {
        throw new AppError('FORBIDDEN', 'email not verified', { messageTh: 'กรุณายืนยันอีเมลจากลิงก์ที่ส่งไปก่อนใช้รหัสคำเชิญ' });
      }
      const hash = invitationHash(input.code);
      const invs = yield ctx.store.findBy('InvitationRecords', 'code_hash', hash);
      const inv = invs[0];
      const invalid = () => new AppError('VALIDATION_ERROR', 'invitation invalid', { messageTh: 'รหัสคำเชิญไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว', fieldErrors: [{ field: 'code', code: 'INVALID', message_th: 'รหัสคำเชิญไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว' }] });
      if (!inv || inv.status !== 'PENDING') throw invalid();
      if (inv.expires_at <= ctx.now) throw invalid();
      if (inv.attempt_count >= inv.max_attempts) throw invalid();
      const emailOk = !inv.bound_email || (claims.email && claims.email_verified && claims.email.toLowerCase() === inv.bound_email.toLowerCase());
      if (!emailOk) {
        // count the mismatch against this invitation (durable), then reject
        const cs = ctx.changeSet('auth.redeemInvitation.attempt');
        const attempts = inv.attempt_count + 1;
        cs.update('InvitationRecords', inv, { attempt_count: attempts, status: attempts >= inv.max_attempts ? 'LOCKED' : 'PENDING' });
        cs.audit({ action: 'invitation.redeem_rejected', entityType: 'InvitationRecords', entityId: inv.id, reason: 'bound email mismatch' });
        yield* commit(ctx, cs, {});
        throw new AppError('FORBIDDEN', 'email mismatch', { messageTh: 'อีเมลที่ยืนยันแล้วไม่ตรงกับคำเชิญ กรุณาติดต่อโรงเรียน' });
      }
      const user = yield ctx.store.get('Users', inv.target_user_id);
      if (!user || user.status === 'DISABLED') throw invalid();
      const existingLinks = yield ctx.store.findBy('IdentityLinks', 'user_id', user.id);
      if (existingLinks.some((l) => l.status === 'ACTIVE' && l.provider === claims.provider)) {
        throw new AppError('INVALID_STATE', 'user already linked', { messageTh: 'ผู้ใช้นี้ถูกเชื่อมกับบัญชีอื่นแล้ว กรุณาติดต่อโรงเรียน' });
      }
      const cs = ctx.changeSet();
      cs.actorId = user.id; // the redeeming person becomes the actor of their own activation
      const link = cs.insert('IdentityLinks', {
        user_id: user.id, provider: claims.provider, issuer: claims.issuer, subject: claims.subject, email_at_link: claims.email || null,
        linked_at: ctx.now, linked_via: 'INVITATION', invitation_id: inv.id, status: 'ACTIVE',
      });
      cs.update('InvitationRecords', inv, { status: 'REDEEMED', redeemed_at: ctx.now, redeemed_identity_link_id: link.id, attempt_count: inv.attempt_count + 1 });
      if (user.status === 'INVITED') cs.update('Users', user, { status: 'ACTIVE' });
      cs.audit({ action: 'invitation.redeemed', entityType: 'Users', entityId: user.id, studentId: user.student_id || null, after: { provider: claims.provider, invitation_id: inv.id } });
      return yield* commit(ctx, cs, { user_id: user.id, display_name: user.display_name });
    },
  }),

  op({
    name: 'auth.logout', auth: 'IDENTITY', description_th: 'ออกจากระบบ (ล้างผลตรวจ token ที่ server cache; client เรียก signOut ของ SDK)', input: EMPTY,
    *handler(ctx) {
      if (ctx.deps.identity.forget) yield ctx.deps.identity.forget(ctx.principal.claims);
      return { logged_out: true };
    },
  }),
];

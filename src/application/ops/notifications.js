// Notifications (MASTER_PROMPT §11): my in-app notifications, read/acknowledge/callback, the delivery
// monitor (dead-letter view) with permission-checked retry/resend/cancel, and LINE channel binding.
import { listAll } from '../queries.js';
import { op } from '../dispatcher.js';
import { obj, S, notFound, assertVersion, EMPTY } from './common.js';
import { requirePermission, allows } from '../authz.js';
import { commit, partitionsForDates } from '../context.js';
import { render } from '../services/templates.js';
import { acknowledgeRecipient, availableActions } from '../services/ack.js';
import { guardianRecipients, channelsFor } from '../services/notify.js';
import { assertTransition } from '../../domain/state-machines.js';
import { AppError } from '../../shared/errors.js';
import { addDays, addMinutesIso, diffSeconds } from '../../shared/time.js';
import { ENUMS } from '../../schema/enums.js';

const RECENT_DAYS = 180;
const LINK_TTL_MINUTES = 10;

function recentParts(ctx, days = RECENT_DAYS) {
  return partitionsForDates(ctx, [addDays(ctx.today, -days), ctx.today]);
}

function maskAddress(channel, addr) {
  if (!addr) return null;
  if (channel === 'EMAIL') { const [u, d] = String(addr).split('@'); return `${u.slice(0, 2)}***@${d || ''}`; }
  return `${String(addr).slice(0, 4)}…${String(addr).slice(-4)}`;
}

function* ownRecipient(ctx, id) {
  const rec = yield ctx.store.get('NotificationRecipients', id, { partitions: recentParts(ctx, 400) });
  if (!rec || rec.recipient_user_id !== ctx.principal.user_id) throw notFound('notification');
  return rec;
}

export const notificationOps = [
  op({
    name: 'notification.list', description_th: 'การแจ้งเตือนของฉัน (ในแอป) พร้อมสถานะรับทราบ', permission: 'notification.read_own',
    input: obj({ unread_only: { type: ['boolean', 'null'] }, limit: S.limit }),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'notification.read_own', { owner_user_id: ctx.principal.user_id });
      const parts = recentParts(ctx);
      let recs = yield ctx.store.findBy('NotificationRecipients', 'recipient_user_id', ctx.principal.user_id, { partitions: parts });
      const unread = recs.filter((r) => r.in_app_state === 'UNREAD').length;
      const pendingAck = recs.filter((r) => r.ack_state === 'PENDING_ACK').length;
      if (input.unread_only) recs = recs.filter((r) => r.in_app_state === 'UNREAD' || r.ack_state === 'PENDING_ACK');
      recs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      recs = recs.slice(0, input.limit || 50);
      const notes = yield ctx.store.getMany('Notifications', recs.map((r) => r.notification_id), { partitions: parts });
      const acks = recs.length ? (yield ctx.store.list('Acknowledgements', { where: { recipient_id: { in: recs.map((r) => r.id) } }, partitions: parts, limit: 500 })).items : [];
      const items = [];
      for (const r of recs) {
        const n = notes.get(r.notification_id);
        if (!n) continue;
        const m = render(n.notification_type, n.params_json);
        const mine = acks.filter((a) => a.recipient_id === r.id);
        items.push({
          recipient_id: r.id, notification_id: n.id, type: n.notification_type, title: m.title, body: m.body, urgency: n.urgency, created_at: r.created_at,
          in_app_state: r.in_app_state, ack_required: r.ack_required, ack_state: r.ack_state, ack_due_at: r.ack_due_at, student_id: n.student_id,
          source_entity_type: n.source_entity_type, source_entity_id: n.source_entity_id, actions: availableActions(n, r, mine),
          acknowledgements: mine.map((a) => ({ action: a.action, channel: a.channel, acted_at: a.acted_at, case_id: a.case_id })), version: r.version,
        });
      }
      return { items, unread, pending_ack: pendingAck };
    },
  }),

  op({
    name: 'notification.markRead', mutation: true, description_th: 'ทำเครื่องหมายว่าเปิดอ่านในแอปแล้ว (ไม่ใช่การรับทราบ)', permission: 'notification.read_own',
    input: obj({ recipient_ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: S.uuid } }, ['recipient_ids']),
    *handler(ctx, input) {
      const cs = ctx.changeSet();
      let changed = 0;
      for (const id of input.recipient_ids) {
        const r = yield* ownRecipient(ctx, id);
        if (r.in_app_state === 'READ') continue;
        cs.update('NotificationRecipients', r, { in_app_state: 'READ', read_at: ctx.now });
        changed++;
      }
      return yield* commit(ctx, cs, { changed });
    },
  }),

  op({
    name: 'notification.acknowledge', mutation: true, description_th: 'กดรับทราบ หรือขอให้ครูติดต่อกลับ (ผูกกับบัญชีผู้รับจริง)', permission: 'notification.acknowledge',
    input: obj({ recipient_id: S.uuid, action: { type: 'string', enum: ['ACKNOWLEDGED', 'CALLBACK_REQUESTED'] }, note: S.strOrNull(500) }, ['recipient_id', 'action']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'notification.acknowledge', { owner_user_id: ctx.principal.user_id });
      const r = yield* ownRecipient(ctx, input.recipient_id);
      const cs = ctx.changeSet();
      const res = yield* acknowledgeRecipient(ctx, cs, r, { action: input.action, channel: 'IN_APP', note: input.note });
      if (res.duplicate) return res;
      return yield* commit(ctx, cs, res);
    },
  }),

  op({
    name: 'notification.monitor', description_th: 'สถานะคิวส่งแจ้งเตือน (ตามช่องทาง/สถานะ) และรายการส่งไม่สำเร็จ', permission: 'notification.monitor',
    input: obj({ state: S.enumOrNull('DeliveryState'), channel: S.enumOrNull('Channel'), outbox_id: S.uuidOrNull, days: { type: ['integer', 'null'], minimum: 1, maximum: 400 }, limit: S.limit }),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'notification.monitor');
      const parts = recentParts(ctx, input.days || 30);
      if (input.outbox_id) {
        const row = yield ctx.store.get('NotificationOutbox', input.outbox_id, { partitions: parts });
        if (!row) throw notFound('outbox');
        const attempts = (yield ctx.store.findBy('NotificationAttempts', 'outbox_id', row.id, { partitions: parts })).sort((a, b) => a.attempt_no - b.attempt_no);
        return { row, attempts };
      }
      const counts = {};
      for (const st of ENUMS.DeliveryState.values) {
        const rows = (yield* listAll(ctx, 'NotificationOutbox', { where: { delivery_state: st }, partitions: parts }));
        for (const r of rows) {
          counts[r.channel] = counts[r.channel] || {};
          counts[r.channel][st] = (counts[r.channel][st] || 0) + 1;
        }
      }
      const state = input.state || 'FAILED_FINAL';
      let rows = (yield* listAll(ctx, 'NotificationOutbox', { where: { delivery_state: state }, partitions: parts }));
      if (input.channel) rows = rows.filter((r) => r.channel === input.channel);
      rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      rows = rows.slice(0, input.limit || 100);
      const notes = yield ctx.store.getMany('Notifications', rows.map((r) => r.notification_id), { partitions: parts });
      const users = yield ctx.store.getMany('Users', rows.map((r) => r.recipient_user_id));
      return {
        counts,
        items: rows.map((r) => {
          const n = notes.get(r.notification_id);
          const u = users.get(r.recipient_user_id);
          return {
            outbox_id: r.id, channel: r.channel, delivery_state: r.delivery_state, attempts: r.attempts, max_attempts: r.max_attempts, next_attempt_at: r.next_attempt_at,
            last_error_code: r.last_error_code, last_error_message: r.last_error_message, held_reason: r.held_reason, accepted_at: r.accepted_at, updated_at: r.updated_at,
            notification_type: n ? n.notification_type : null, recipient_name: u ? u.display_name : null, resend_of_outbox_id: r.resend_of_outbox_id, version: r.version,
            retry_same_allowed: r.delivery_state === 'FAILED_FINAL' && r.channel === 'LINE' && !!r.retry_key_created_at && diffSeconds(r.retry_key_created_at, ctx.now) < (ctx.config.lineRetryWindowHours || 12) * 3600,
          };
        }),
      };
    },
  }),

  op({
    name: 'notification.resend', mutation: true, permission: 'notification.resend',
    description_th: 'ส่งรายการที่ล้มเหลวอีกครั้ง: RETRY_SAME = retry เดิม (LINE ใช้ retry key เดิม, ไม่ส่งซ้ำถ้าเคยรับแล้ว) / RESEND_NEW = ส่งใหม่เป็นข้อความใหม่ (อาจซ้ำ)',
    input: obj({ outbox_id: S.uuid, mode: { type: 'string', enum: ['RETRY_SAME', 'RESEND_NEW'] }, reason: S.str(500, 3) }, ['outbox_id', 'mode', 'reason']),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'notification.resend');
      const parts = recentParts(ctx, 400);
      const row = yield ctx.store.get('NotificationOutbox', input.outbox_id, { partitions: parts });
      if (!row) throw notFound('outbox');
      assertVersion(row, env.expected_version);
      if (row.delivery_state !== 'FAILED_FINAL') throw new AppError('INVALID_STATE', 'not failed', { messageTh: 'ส่งซ้ำได้เฉพาะรายการที่ล้มเหลวแล้ว' });
      // the recipient must still be entitled to this message and still have the channel
      const n = yield ctx.store.get('Notifications', row.notification_id, { partitions: parts });
      const rec = yield ctx.store.get('NotificationRecipients', row.recipient_id, { partitions: parts });
      const user = yield ctx.store.get('Users', row.recipient_user_id);
      if (!n || !rec || !user || user.status !== 'ACTIVE') throw new AppError('INVALID_STATE', 'recipient inactive', { messageTh: 'ผู้รับไม่อยู่ในสถานะใช้งาน' });
      if (rec.recipient_role_context === 'GUARDIAN' && n.student_id && !(yield* guardianRecipients(ctx, n.student_id, n.notification_type)).some((r) => r.user.id === user.id)) {
        throw new AppError('INVALID_STATE', 'no longer eligible', { messageTh: 'ผู้รับไม่มีสิทธิ์รับข้อความเรื่องนักเรียนคนนี้แล้ว' });
      }
      if (!(yield* channelsFor(ctx, user)).some((c) => c.channel === row.channel)) throw new AppError('INVALID_STATE', 'channel removed', { messageTh: 'ผู้รับไม่มีช่องทางนี้แล้ว' });
      const cs = ctx.changeSet();
      let outboxId = row.id;
      if (input.mode === 'RETRY_SAME') {
        if (row.channel !== 'LINE') throw new AppError('VALIDATION_ERROR', 'retry same', { messageTh: 'อีเมลไม่มีกลไกกันส่งซ้ำ ใช้ "ส่งใหม่" และยืนยันว่ายอมรับว่าผู้รับอาจได้ข้อความซ้ำ' });
        if (!row.retry_key_created_at || diffSeconds(row.retry_key_created_at, ctx.now) >= (ctx.config.lineRetryWindowHours || 12) * 3600) throw new AppError('INVALID_STATE', 'window', { messageTh: 'เกินช่วงเวลาที่ใช้ retry key เดิมได้ ใช้ "ส่งใหม่"' });
        cs.update('NotificationOutbox', row, { delivery_state: 'RETRY_WAIT', next_attempt_at: ctx.now, max_attempts: Math.max(row.max_attempts, row.attempts + 1), held_reason: null });
      } else {
        assertTransition('Outbox', row.delivery_state, 'RESEND');
        const prior = yield ctx.store.findBy('NotificationOutbox', 'notification_id', row.notification_id, { partitions: parts });
        const n2 = prior.filter((p) => p.dedupe_key.startsWith(`${row.dedupe_key}|resend`)).length + 1;
        const fresh = cs.insert('NotificationOutbox', {
          notification_id: row.notification_id, recipient_id: row.recipient_id, recipient_user_id: row.recipient_user_id, channel: row.channel,
          dedupe_key: `${row.dedupe_key}|resend${n2}`, delivery_state: 'QUEUED', attempts: 0, max_attempts: row.max_attempts, next_attempt_at: ctx.now,
          resend_of_outbox_id: row.id, replay_blocked: false,
        });
        outboxId = fresh.id;
      }
      cs.audit({ action: `notification.${input.mode === 'RETRY_SAME' ? 'retry' : 'resend'}`, entityType: 'NotificationOutbox', entityId: row.id, reason: input.reason, after: { outbox_id: outboxId } });
      return yield* commit(ctx, cs, { outbox_id: outboxId, mode: input.mode });
    },
  }),

  op({
    name: 'notification.cancel', mutation: true, description_th: 'ยกเลิกรายการที่ยังรอส่ง (มีเหตุผล)', permission: 'notification.resend',
    input: obj({ outbox_id: S.uuid, reason: S.str(500, 3) }, ['outbox_id', 'reason']),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'notification.resend');
      const row = yield ctx.store.get('NotificationOutbox', input.outbox_id, { partitions: recentParts(ctx, 400) });
      if (!row) throw notFound('outbox');
      assertVersion(row, env.expected_version);
      assertTransition('Outbox', row.delivery_state, 'CANCEL');
      const cs = ctx.changeSet();
      cs.update('NotificationOutbox', row, { delivery_state: 'CANCELLED', held_reason: `MANUAL: ${input.reason}`.slice(0, 200) });
      cs.audit({ action: 'notification.cancel', entityType: 'NotificationOutbox', entityId: row.id, reason: input.reason });
      return yield* commit(ctx, cs, { outbox_id: row.id });
    },
  }),

  // ───────── LINE channel binding (account link; MASTER_PROMPT §11.3) ─────────
  op({
    name: 'channel.status', description_th: 'ช่องทางแจ้งเตือนของฉัน (อีเมล/LINE)', input: EMPTY,
    *handler(ctx) {
      const me = ctx.principal.user;
      const bindings = (yield ctx.store.findBy('ChannelBindings', 'user_id', me.id)).filter((b) => b.status !== 'REVOKED' || b.revoked_at > addMinutesIso(ctx.now, -30 * 24 * 60));
      const channels = yield* channelsFor(ctx, me);
      return {
        line_enabled: !!ctx.config.lineEnabled, line_add_friend_url: ctx.config.lineAddFriendUrl || null, can_bind: yield* allows(ctx, 'channel.bind', { owner_user_id: me.id }),
        email: channels.find((c) => c.channel === 'EMAIL') ? maskAddress('EMAIL', channels.find((c) => c.channel === 'EMAIL').address) : null,
        bindings: bindings.map((b) => ({ id: b.id, channel: b.channel, status: b.status, address_masked: maskAddress(b.channel, b.address), verified_at: b.verified_at, verified_via: b.verified_via, revoked_at: b.revoked_at, revoke_reason: b.revoke_reason, version: b.version })),
      };
    },
  }),

  op({
    name: 'channel.startLineLink', mutation: true, rateLimitPerMinute: 10, permission: 'channel.bind',
    description_th: 'เริ่มเชื่อม LINE (ต้องเข้าสู่ระบบแล้ว): สร้าง nonce ใช้ครั้งเดียว อายุ 10 นาที แล้วส่งไปหน้ายืนยันของ LINE',
    input: obj({ link_token: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' } }, ['link_token']),
    *handler(ctx, input) {
      const me = ctx.principal.user;
      yield* requirePermission(ctx, 'channel.bind', { owner_user_id: me.id });
      if (!ctx.config.lineEnabled) throw new AppError('CONFIGURATION_REQUIRED', 'line disabled', { messageTh: 'โรงเรียนยังไม่เปิดใช้การแจ้งเตือนทาง LINE' });
      const nonce = `${ctx.ids.uuid()}${ctx.ids.uuid()}`.replace(/-/g, '');
      const cs = ctx.changeSet();
      for (const b of (yield ctx.store.findBy('ChannelBindings', 'user_id', me.id)).filter((x) => x.channel === 'LINE' && x.status === 'PENDING')) {
        cs.update('ChannelBindings', b, { status: 'REVOKED', revoked_at: ctx.now, revoked_by: me.id, revoke_reason: 'SUPERSEDED', link_nonce_hash: null });
      }
      const b = cs.insert('ChannelBindings', { user_id: me.id, channel: 'LINE', address: null, status: 'PENDING', link_nonce_hash: ctx.crypto.sha256Hex(nonce), link_expires_at: addMinutesIso(ctx.now, LINK_TTL_MINUTES) });
      cs.audit({ action: 'channel.link_start', entityType: 'ChannelBindings', entityId: b.id });
      return yield* commit(ctx, cs, { binding_id: b.id, redirect_url: `https://access.line.me/dialog/bot/accountLink?linkToken=${encodeURIComponent(input.link_token)}&nonce=${nonce}`, expires_at: b.link_expires_at });
    },
  }),

  op({
    name: 'channel.unbind', mutation: true, description_th: 'ยกเลิกการเชื่อม LINE ของฉัน (ไม่รับข้อความทาง LINE อีก)', permission: 'channel.bind',
    input: obj({ binding_id: S.uuid }, ['binding_id']),
    *handler(ctx, input, env) {
      const b = yield ctx.store.get('ChannelBindings', input.binding_id);
      if (!b || b.user_id !== ctx.principal.user_id) throw notFound('binding');
      assertVersion(b, env.expected_version);
      if (b.status === 'REVOKED') return { binding_id: b.id, status: 'REVOKED' };
      const cs = ctx.changeSet();
      cs.update('ChannelBindings', b, { status: 'REVOKED', revoked_at: ctx.now, revoked_by: ctx.principal.user_id, revoke_reason: 'USER_UNBIND', link_nonce_hash: null });
      cs.audit({ action: 'channel.unbind', entityType: 'ChannelBindings', entityId: b.id });
      return yield* commit(ctx, cs, { binding_id: b.id, status: 'REVOKED' });
    },
  }),

  op({
    name: 'channel.revokeForUser', mutation: true, description_th: 'เจ้าหน้าที่ยกเลิกช่องทาง LINE ของผู้ใช้ (เช่น เปลี่ยนผู้ปกครอง/อุปกรณ์หาย)', permission: 'guardian.manage | user.manage',
    input: obj({ user_id: S.uuid, reason: S.str(500, 3) }, ['user_id', 'reason']),
    *handler(ctx, input) {
      const target = yield ctx.store.get('Users', input.user_id);
      if (!target) throw notFound('user');
      if (!(yield* allows(ctx, 'user.manage'))) {
        // guardian.manage is scoped to students: the target must be a guardian of a student in scope
        if (!target.guardian_id) throw new AppError('FORBIDDEN', 'not a guardian');
        const links = yield ctx.store.findBy('StudentGuardians', 'guardian_id', target.guardian_id);
        let ok = false;
        for (const l of links) if (yield* allows(ctx, 'guardian.manage', { student_id: l.student_id })) { ok = true; break; }
        if (!ok) throw new AppError('FORBIDDEN', 'out of scope');
      }
      const cs = ctx.changeSet();
      let revoked = 0;
      for (const b of (yield ctx.store.findBy('ChannelBindings', 'user_id', target.id)).filter((x) => x.status !== 'REVOKED')) {
        cs.update('ChannelBindings', b, { status: 'REVOKED', revoked_at: ctx.now, revoked_by: ctx.principal.user_id, revoke_reason: `STAFF: ${input.reason}`.slice(0, 200), link_nonce_hash: null });
        revoked++;
      }
      cs.audit({ action: 'channel.revoke', entityType: 'Users', entityId: target.id, reason: input.reason, after: { revoked } });
      return yield* commit(ctx, cs, { revoked });
    },
  }),
];

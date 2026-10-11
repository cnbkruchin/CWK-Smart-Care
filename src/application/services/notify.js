// Notification emission (MASTER_PROMPT §11.1): created inside the SAME change set as the source
// event (so nothing is announced for uncommitted work). Recipients are resolved ONLY from verified,
// effective relationships/assignments — never guessed from names. Minimal content + template version.
// Delivery (email/LINE) is performed later by the outbox worker after commit.

import { dateInRange } from '../../shared/time.js';
import { deterministicId } from '../../shared/uuid.js';
import { ruleFor } from '../context.js';
import { TEMPLATES } from './templates.js';
import { addMinutesIso } from '../../shared/time.js';

/** Guardians' user accounts allowed to receive `type` for a student (verified link + permission + preference). */
export function* guardianRecipients(ctx, studentId, type) {
  const links = (yield ctx.store.findBy('StudentGuardians', 'student_id', studentId))
    .filter((l) => l.status === 'ACTIVE' && dateInRange(ctx.today, l.effective_from, l.effective_to))
    .filter((l) => (l.permitted_actions || []).includes('RECEIVE_NOTIFICATIONS'))
    .filter((l) => !l.notification_preferences || l.notification_preferences[type] !== false);
  const out = [];
  for (const l of links) {
    for (const u of yield ctx.store.findBy('Users', 'guardian_id', l.guardian_id)) {
      if (u.status === 'ACTIVE' && u.user_type === 'GUARDIAN') out.push({ user: u, role: 'GUARDIAN' });
    }
  }
  return out;
}

export function* homeroomRecipients(ctx, classId) {
  if (!classId) return [];
  const assigns = (yield ctx.store.findBy('StaffAssignments', 'class_id', classId)).filter((a) => a.assignment_type === 'HOMEROOM' && dateInRange(ctx.today, a.effective_from, a.effective_to));
  const ids = new Set(assigns.map((a) => a.user_id));
  for (const a of assigns) {
    const delegates = (yield ctx.store.findBy('StaffAssignments', 'delegate_for_user_id', a.user_id)).filter((d) => d.assignment_type === 'DELEGATE' && dateInRange(ctx.today, d.effective_from, d.effective_to));
    for (const d of delegates) ids.add(d.user_id);
  }
  const users = yield ctx.store.getMany('Users', [...ids]);
  return [...users.values()].filter((u) => u.status === 'ACTIVE').map((u) => ({ user: u, role: 'HOMEROOM_TEACHER' }));
}

export function* roleRecipients(ctx, role) {
  const grants = (yield ctx.store.findBy('UserRoles', 'role', role)).filter((r) => !r.revoked_at && dateInRange(ctx.today, r.effective_from, r.effective_to));
  const users = yield ctx.store.getMany('Users', [...new Set(grants.map((g) => g.user_id))]);
  return [...users.values()].filter((u) => u.status === 'ACTIVE').map((u) => ({ user: u, role }));
}

/** Channels available for a user: EMAIL (contact email / verified guardian email) and LINE (ACTIVE binding). */
export function* channelsFor(ctx, user) {
  const out = [];
  if (ctx.config.emailEnabled !== false) {
    let email = user.contact_email;
    if (!email && user.guardian_id) {
      const ce = (yield ctx.store.findBy('ContactEndpoints', 'owner_id', user.guardian_id)).find((c) => c.channel === 'EMAIL' && c.status === 'ACTIVE');
      email = ce ? ce.value : null;
    }
    if (email) out.push({ channel: 'EMAIL', address: email });
  }
  if (ctx.config.lineEnabled) {
    const b = (yield ctx.store.findBy('ChannelBindings', 'user_id', user.id)).find((x) => x.channel === 'LINE' && x.status === 'ACTIVE' && x.address);
    if (b) out.push({ channel: 'LINE', address: b.address });
  }
  return out;
}

/**
 * Emit a notification inside change set `cs`.
 * @param {object} n {type, sourceEntityType, sourceEntityId, studentId, params, recipients:[{user, role}], purpose, urgency, suppressed}
 */
export function* emitNotification(ctx, cs, n) {
  const policyRule = yield* ruleFor(ctx, 'NOTIFICATION_POLICY', ctx.today, { required: false });
  const policy = policyRule ? policyRule.params_json : { ack_required_types: [], ack_timeout_hours: 24, max_attempts: 6, channels_by_type: {}, quiet_hours: null };
  const tpl = TEMPLATES[n.type];
  const unique = new Map();
  for (const r of n.recipients) if (r.user && !unique.has(r.user.id)) unique.set(r.user.id, r);
  if (!unique.size) return null;
  const notification = cs.insert('Notifications', {
    notification_type: n.type, source_entity_type: n.sourceEntityType, source_entity_id: n.sourceEntityId, source_operation_id: cs.operationId,
    student_id: n.studentId || null, template_key: tpl.key, template_version: tpl.version, params_json: n.params || {}, urgency: n.urgency || 'NORMAL',
    audience_scope: n.audience || 'USERS', suppressed: !!n.suppressed, suppress_reason: n.suppressed ? n.suppressReason || 'suppressed' : null,
  });
  const ackRequired = (policy.ack_required_types || []).includes(n.type) && !n.noAck;
  const allowed = (policy.channels_by_type || {})[n.type] || ['EMAIL'];
  for (const r of unique.values()) {
    const rec = cs.insert('NotificationRecipients', {
      notification_id: notification.id, recipient_user_id: r.user.id, recipient_role_context: r.role, in_app_state: 'UNREAD', ack_required: ackRequired,
      ack_state: ackRequired ? 'PENDING_ACK' : 'NOT_REQUIRED', ack_due_at: ackRequired ? addMinutesIso(ctx.now, (policy.ack_timeout_hours || 24) * 60) : null,
    });
    if (n.suppressed) continue;
    for (const ch of yield* channelsFor(ctx, r.user)) {
      if (!allowed.includes(ch.channel)) continue;
      const dedupe = `${n.type}|${n.sourceEntityId}|${r.user.id}|${ch.channel}|${n.purpose || 'default'}`;
      const id = deterministicId.outbox(dedupe);
      if (cs.writes.some((w) => w.table === 'NotificationOutbox' && w.record.id === id)) continue;
      if ((yield ctx.store.findBy('NotificationOutbox', 'dedupe_key', dedupe)).length) continue;
      cs.insert('NotificationOutbox', {
        id, notification_id: notification.id, recipient_id: rec.id, recipient_user_id: r.user.id, channel: ch.channel, dedupe_key: dedupe, delivery_state: 'QUEUED',
        attempts: 0, max_attempts: policy.max_attempts || 6, next_attempt_at: ctx.now, replay_blocked: false,
      });
    }
  }
  return notification;
}

export function studentShortName(s) {
  return `${s.prefix_th || ''}${s.first_name_th} ${s.last_name_th}`.trim();
}

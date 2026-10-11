// Acknowledgement and callback requests (MASTER_PROMPT §11.1, §7.6). Shared by the in-app buttons
// and LINE postback buttons; both are bound to the recipient's own identity (never a guessable URL).
// Acknowledgement is stored separately from delivery: PROVIDER_ACCEPTED never means "read".
import { requireStudent } from '../queries.js';
import { TEMPLATES } from './templates.js';
import { stageNewCase, caseEvent, defaultOwner } from './followup.js';
import { caseDedupeKey } from '../../domain/followup.js';
import { AppError } from '../../shared/errors.js';
import { addMinutesIso } from '../../shared/time.js';

export const ACK_ACTIONS = { ACK: 'ACKNOWLEDGED', CALLBACK: 'CALLBACK_REQUESTED' };

/** Actions the recipient may still take on a notification. */
export function availableActions(notification, recipient, acks) {
  const tpl = TEMPLATES[notification.notification_type];
  const done = new Set(acks.map((a) => a.action));
  const out = [];
  if (tpl.actions.includes('ACK') && !done.has('ACKNOWLEDGED') && recipient.ack_state !== 'ACKNOWLEDGED') out.push('ACKNOWLEDGED');
  if (tpl.actions.includes('CALLBACK') && notification.student_id && !done.has('CALLBACK_REQUESTED') && recipient.recipient_role_context === 'GUARDIAN') out.push('CALLBACK_REQUESTED');
  return out;
}

/**
 * Record an acknowledgement/callback for `recipient` by the current principal (must be the recipient).
 * Idempotent per (recipient, action): a repeat returns the first record.
 */
export function* acknowledgeRecipient(ctx, cs, recipient, { action, channel, note = null }) {
  if (recipient.recipient_user_id !== ctx.principal.user_id) throw new AppError('FORBIDDEN', 'not the recipient', { messageTh: 'รายการนี้ไม่ใช่การแจ้งเตือนของบัญชีนี้' });
  const acks = yield ctx.store.findBy('Acknowledgements', 'recipient_id', recipient.id);
  const existing = acks.find((a) => a.action === action);
  if (existing) return { duplicate: true, ack_id: existing.id, case_id: existing.case_id };
  const notification = yield ctx.store.get('Notifications', recipient.notification_id);
  if (!notification) throw new AppError('NOT_FOUND', 'notification');
  if (!availableActions(notification, recipient, acks).includes(action)) throw new AppError('INVALID_STATE', 'action not available', { messageTh: 'ทำรายการนี้กับการแจ้งเตือนนี้ไม่ได้' });
  let caseId = null;
  if (action === 'CALLBACK_REQUESTED') {
    const student = yield* requireStudent(ctx, notification.student_id);
    const key = caseDedupeKey('CALLBACK_REQUEST', student.id, notification.id);
    const open = (yield ctx.store.findBy('Cases', 'dedupe_key', key)).find((c) => c.status !== 'CLOSED');
    const topic = TEMPLATES[notification.notification_type].title;
    if (open) {
      caseEvent(cs, ctx, open, 'CALLBACK_REQUESTED', { data: { notification_id: notification.id, recipient_id: recipient.id }, note });
      caseId = open.id;
    } else {
      const owner = yield* defaultOwner(ctx, student.id);
      const kase = yield* stageNewCase(ctx, cs, {
        student, caseType: 'CALLBACK_REQUEST', dedupeKey: key, priority: 'HIGH', owner, dueAt: addMinutesIso(ctx.now, 24 * 60),
        summaryTh: `ผู้ปกครองขอให้ติดต่อกลับเรื่อง "${topic}"`, nextActionTh: 'โทรกลับผู้ปกครองและบันทึกผล',
        evidence: { notification_id: notification.id, notification_type: notification.notification_type, requested_by: ctx.principal.user_id, channel, note },
        notify: { type: 'CALLBACK_REQUESTED', params: { topic_th: topic } },
      });
      caseEvent(cs, ctx, kase, 'CALLBACK_REQUESTED', { data: { notification_id: notification.id, recipient_id: recipient.id }, note });
      caseId = kase.id;
    }
  }
  const ack = cs.insert('Acknowledgements', {
    recipient_id: recipient.id, notification_id: notification.id, user_id: ctx.principal.user_id, action, channel, acted_at: ctx.now, note, case_id: caseId, operation_id: cs.operationId,
  });
  const nextState = action === 'CALLBACK_REQUESTED' || recipient.ack_state === 'FOLLOW_UP_REQUIRED' ? 'FOLLOW_UP_REQUIRED' : 'ACKNOWLEDGED';
  cs.update('NotificationRecipients', recipient, { ack_state: recipient.ack_required || action === 'CALLBACK_REQUESTED' ? nextState : recipient.ack_state, in_app_state: 'READ', read_at: recipient.read_at || ctx.now });
  cs.audit({ action: `notification.${action === 'ACKNOWLEDGED' ? 'acknowledge' : 'callback'}`, entityType: 'NotificationRecipients', entityId: recipient.id, studentId: notification.student_id, after: { channel, case_id: caseId } });
  return { duplicate: false, ack_id: ack.id, case_id: caseId };
}

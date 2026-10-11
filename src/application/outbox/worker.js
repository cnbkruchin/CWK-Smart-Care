// Outbox worker (MASTER_PROMPT §11.2, DECISIONS D-011). Runs from cronTick, never sleeps to wait.
//   claim (version check + lease) → re-check recipient/channel eligibility → send OUTSIDE the lock →
//   record attempt + new state. A worker that dies after the provider accepted but before recording:
//   LINE is retried with the SAME X-Line-Retry-Key (409 = already accepted → PROVIDER_ACCEPTED);
//   email has no idempotency key → FAILED_FINAL / OUTCOME_UNKNOWN, never re-sent automatically.
// Delivery state is separate from acknowledgement; PROVIDER_ACCEPTED never means read/delivered.
import { createContext, ruleFor, partitionsForDates, loadSchool } from '../context.js';
import { systemPrincipal } from '../principal.js';
import { guardianRecipients, channelsFor } from '../services/notify.js';
import { composeEmail, composeLine } from './compose.js';
import { isAppError } from '../../shared/errors.js';
import { addSecondsIso, addDays, localPartsOf, localToUtc, hhmmToMinutes, diffSeconds } from '../../shared/time.js';
import { SYSTEM_USER_ID } from '../../shared/uuid.js';

export const OUTBOX_LEASE_SECONDS = 120;
export const ACTIVE_STATES = ['QUEUED', 'RETRY_WAIT', 'PROCESSING'];

/** Exponential backoff: 1, 2, 4 … minutes capped at 6 h, plus a stable per-row jitter (≤ 30 s). */
export function backoffSeconds(attempts, id = '') {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return Math.min(6 * 3600, 60 * 2 ** Math.max(0, attempts - 1)) + (h % 31);
}

/** End of the quiet period containing `nowIso`, or null when outside quiet hours. */
export function quietUntil(nowIso, quiet, tz) {
  if (!quiet) return null;
  const p = localPartsOf(nowIso, tz);
  const m = p.hh * 60 + p.mm;
  const s = hhmmToMinutes(quiet.start);
  const e = hhmmToMinutes(quiet.end);
  const inside = s <= e ? m >= s && m < e : m >= s || m < e;
  if (!inside) return null;
  const endDate = s > e && m >= s ? addDays(p.date, 1) : p.date;
  return localToUtc(endDate, quiet.end, tz);
}

function* sysContext(deps, operation) {
  const ctx = yield* createContext(deps, { operation, channel: 'JOB' });
  ctx.principal = systemPrincipal(SYSTEM_USER_ID);
  return ctx;
}

function* tryCommit(ctx, cs) {
  try {
    yield ctx.mutations.commit(cs.build({ result: {} }));
    return true;
  } catch (e) {
    if (isAppError(e) && ['CONFLICT', 'LOCK_TIMEOUT', 'MAINTENANCE_MODE', 'STORAGE_UNAVAILABLE'].includes(e.code)) return false;
    throw e;
  }
}

function attemptRow(cs, row, attemptNo, startedAt, now, r) {
  return cs.insert('NotificationAttempts', {
    outbox_id: row.id, attempt_no: attemptNo, started_at: startedAt, finished_at: now, result: r.result, http_status: r.http_status ?? null,
    provider_request_id: r.provider_request_id || null, error_code: r.error_code || null, error_message: r.error_message ? String(r.error_message).slice(0, 500) : null,
    retry_key: row.retry_key || null,
  });
}

/**
 * Decide whether `row` may be sent now. Returns one of
 *   {cancel: reason} | {defer: isoTime, reason} | {fail: code, message} | {send: {address, notification, recipient}}
 */
export function* checkSendable(ctx, row, policy) {
  if (row.replay_blocked) return { cancel: 'REPLAY_BLOCKED' };
  const notification = yield ctx.store.get('Notifications', row.notification_id);
  if (!notification || notification.suppressed) return { cancel: 'NOTIFICATION_SUPPRESSED' };
  const recipient = yield ctx.store.get('NotificationRecipients', row.recipient_id);
  const user = yield ctx.store.get('Users', row.recipient_user_id);
  if (!recipient || !user || user.status !== 'ACTIVE') return { cancel: 'RECIPIENT_INACTIVE' };
  // a guardian who lost the link/permission (or opted out) must not receive new messages about the student
  if (recipient.recipient_role_context === 'GUARDIAN' && notification.student_id) {
    const still = (yield* guardianRecipients(ctx, notification.student_id, notification.notification_type)).some((r) => r.user.id === user.id);
    if (!still) return { cancel: 'RECIPIENT_NO_LONGER_ELIGIBLE' };
  }
  if (row.channel === 'LINE' && !ctx.config.lineEnabled) return { cancel: 'CHANNEL_DISABLED' };
  if (row.channel === 'EMAIL' && ctx.config.emailEnabled === false) return { cancel: 'CHANNEL_DISABLED' };
  if (row.channel === 'SMS') return { cancel: 'CHANNEL_NOT_AVAILABLE' };
  const ch = (yield* channelsFor(ctx, user)).find((c) => c.channel === row.channel);
  if (!ch) return { cancel: 'CHANNEL_REMOVED' };
  // DEV/STAGING never message real people: only allowlisted test addresses are sent
  if (ctx.config.env !== 'PROD' && !(ctx.config.notifyAllowlist || []).some((a) => String(a).toLowerCase() === String(ch.address).toLowerCase())) return { cancel: 'NON_PROD_NOT_ALLOWLISTED' };
  const provider = (ctx.platform.providers || {})[row.channel];
  if (!provider) return { defer: addSecondsIso(ctx.now, 1800), reason: 'PROVIDER_NOT_CONFIGURED' };
  if (row.channel === 'LINE' && row.retry_key_created_at && diffSeconds(row.retry_key_created_at, ctx.now) > (ctx.config.lineRetryWindowHours || 12) * 3600) {
    return { fail: 'RETRY_WINDOW_EXPIRED', message: 'retry key older than the configured window; a new send must be a manual resend' };
  }
  if (notification.urgency !== 'URGENT') {
    const until = quietUntil(ctx.now, policy.quiet_hours, ctx.tz);
    if (until) return { defer: until, reason: 'QUIET_HOURS' };
  }
  if (row.channel === 'EMAIL' && provider.remainingQuota && provider.remainingQuota() <= 0) {
    return { defer: localToUtc(addDays(localPartsOf(ctx.now, ctx.tz).date, 1), '07:00', ctx.tz), reason: 'EMAIL_QUOTA' };
  }
  return { send: { address: ch.address, notification, recipient } };
}

/** PROCESSING row whose lease expired: the worker died mid-send. */
function* recoverExpired(deps, row) {
  const ctx = yield* sysContext(deps, 'outbox.recover');
  const cs = ctx.changeSet('outbox.recover');
  const r = { result: 'OUTCOME_UNKNOWN', error_code: 'LEASE_EXPIRED', error_message: 'worker stopped before recording the provider result' };
  attemptRow(cs, row, row.attempts, row.lease_until || ctx.now, ctx.now, r);
  if (row.channel === 'LINE' && row.attempts < row.max_attempts) {
    // safe to retry: the same X-Line-Retry-Key makes LINE answer 409 if the first request was accepted
    cs.update('NotificationOutbox', row, { delivery_state: 'RETRY_WAIT', next_attempt_at: ctx.now, lease_until: null, lease_owner: null, last_error_code: 'OUTCOME_UNKNOWN', last_error_message: r.error_message });
    return (yield* tryCommit(ctx, cs)) ? 'retry' : 'skipped';
  }
  cs.update('NotificationOutbox', row, { delivery_state: 'FAILED_FINAL', lease_until: null, lease_owner: null, last_error_code: 'OUTCOME_UNKNOWN', last_error_message: row.channel === 'EMAIL' ? 'email may or may not have been sent; not re-sent automatically (use resend)' : r.error_message });
  return (yield* tryCommit(ctx, cs)) ? 'failed' : 'skipped';
}

/** Deliver one claimed row; returns the final delivery_state. */
function* deliver(deps, row, plan) {
  const ctx = yield* sysContext(deps, 'outbox.send');
  const provider = ctx.platform.providers[row.channel];
  let school = null;
  try { school = yield* loadSchool(ctx); } catch (_) { school = null; }
  const startedAt = ctx.now;
  let r;
  try {
    if (row.channel === 'EMAIL') {
      const m = composeEmail({ notification: plan.notification, recipient: plan.recipient, config: ctx.config, schoolName: school && school.name_th });
      r = provider.send({ to: plan.address, subject: m.subject, body: m.body, senderName: ctx.config.emailSenderName || 'CWK Smart Care' });
    } else {
      const m = composeLine({ notification: plan.notification, recipient: plan.recipient, config: ctx.config });
      r = provider.push({ to: plan.address, messages: m.messages, retryKey: row.retry_key });
    }
    if (r && typeof r.then === 'function') r = yield r;
  } catch (e) {
    r = { result: 'OUTCOME_UNKNOWN', error_code: 'PROVIDER_EXCEPTION', error_message: String(e && e.message ? e.message : e) };
  }
  const fin = yield* sysContext(deps, 'outbox.finish');
  const latest = (yield fin.store.get('NotificationOutbox', row.id)) || row;
  const cs = fin.changeSet('outbox.finish');
  attemptRow(cs, latest, latest.attempts, startedAt, fin.now, r);
  let state;
  const patch = { lease_until: null, lease_owner: null, provider_request_id: r.provider_request_id || latest.provider_request_id || null, last_error_code: r.error_code || null, last_error_message: r.error_message ? String(r.error_message).slice(0, 500) : null };
  if (r.result === 'ACCEPTED' || r.result === 'DUPLICATE_ACCEPTED') {
    state = 'PROVIDER_ACCEPTED';
    Object.assign(patch, { accepted_at: fin.now, provider_message_id: r.provider_message_id || null, last_error_code: null, last_error_message: null });
  } else if (r.result === 'RETRYABLE_ERROR' || (r.result === 'OUTCOME_UNKNOWN' && row.channel === 'LINE')) {
    state = latest.attempts >= latest.max_attempts ? 'FAILED_FINAL' : 'RETRY_WAIT';
    if (state === 'RETRY_WAIT') patch.next_attempt_at = addSecondsIso(fin.now, r.retry_after_seconds || backoffSeconds(latest.attempts, latest.id));
  } else {
    state = 'FAILED_FINAL'; // FINAL_ERROR, or email OUTCOME_UNKNOWN (no automatic re-send)
  }
  patch.delivery_state = state;
  cs.update('NotificationOutbox', latest, patch);
  const ok = yield* tryCommit(fin, cs);
  return ok ? state : 'UNRECORDED'; // lease expiry → recoverExpired handles it next tick
}

/**
 * One dispatch pass. `deps.platform.providers` = { EMAIL?: {send, remainingQuota?}, LINE?: {push} }.
 * @returns report counts
 */
export function* dispatchOutbox(deps, { deadlineAt, owner = 'outbox', limit = 25 } = {}) {
  const report = { scanned: 0, sent: 0, retry: 0, failed: 0, cancelled: 0, deferred: 0, recovered: 0, skipped: 0, unrecorded: 0 };
  const ctx = yield* sysContext(deps, 'outbox.scan');
  const policyRule = yield* ruleFor(ctx, 'NOTIFICATION_POLICY', ctx.today, { required: false });
  const policy = policyRule ? policyRule.params_json : { quiet_hours: null };
  const parts = partitionsForDates(ctx, [addDays(ctx.today, -60), ctx.today]);
  const rows = (yield ctx.store.list('NotificationOutbox', { where: { delivery_state: { in: ACTIVE_STATES } }, partitions: parts, limit: 500 })).items
    .sort((a, b) => String(a.next_attempt_at || '').localeCompare(String(b.next_attempt_at || '')));
  let handled = 0;
  for (const row of rows) {
    if (handled >= limit || (deadlineAt && Date.now() > deadlineAt - 15000)) break;
    report.scanned++;
    if (row.delivery_state === 'PROCESSING') {
      if (row.lease_until && row.lease_until > ctx.now) { report.skipped++; continue; }
      const res = yield* recoverExpired(deps, row);
      report.recovered++;
      if (res === 'failed') report.failed++;
      continue;
    }
    if (row.next_attempt_at && row.next_attempt_at > ctx.now) continue;
    const c = yield* sysContext(deps, 'outbox.claim');
    const decision = yield* checkSendable(c, row, policy);
    const cs = c.changeSet('outbox.claim');
    if (decision.cancel) {
      cs.update('NotificationOutbox', row, { delivery_state: 'CANCELLED', held_reason: decision.cancel });
      if (yield* tryCommit(c, cs)) report.cancelled++; else report.skipped++;
      continue;
    }
    if (decision.defer) {
      cs.update('NotificationOutbox', row, { next_attempt_at: decision.defer, held_reason: decision.reason });
      if (yield* tryCommit(c, cs)) report.deferred++; else report.skipped++;
      continue;
    }
    if (decision.fail) {
      cs.update('NotificationOutbox', row, { delivery_state: 'FAILED_FINAL', last_error_code: decision.fail, last_error_message: decision.message });
      if (yield* tryCommit(c, cs)) report.failed++; else report.skipped++;
      continue;
    }
    const patch = { delivery_state: 'PROCESSING', lease_until: addSecondsIso(c.now, OUTBOX_LEASE_SECONDS), lease_owner: owner, attempts: row.attempts + 1, held_reason: null };
    if (row.channel === 'LINE' && !row.retry_key) Object.assign(patch, { retry_key: c.ids.uuid(), retry_key_created_at: c.now });
    const claimed = cs.update('NotificationOutbox', row, patch);
    if (!(yield* tryCommit(c, cs))) { report.skipped++; continue; } // someone else claimed it
    handled++;
    const state = yield* deliver(deps, claimed, decision.send);
    if (state === 'PROVIDER_ACCEPTED') report.sent++;
    else if (state === 'RETRY_WAIT') report.retry++;
    else if (state === 'FAILED_FINAL') report.failed++;
    else report.unrecorded++;
  }
  return report;
}

export const OUTBOX_TICK = {
  name: 'outbox.dispatch',
  *run(deps, { deadlineAt } = {}) {
    return yield* dispatchOutbox(deps, { deadlineAt, owner: `tick-${Date.now()}` });
  },
};

// Outbox delivery (MASTER_PROMPT §11.2, D-011): non-PROD allowlist, quiet hours, backoff and limits,
// eligibility re-check before every send, LINE retry key + 409 after a crash, email OUTCOME_UNKNOWN,
// retry vs resend, the monitor and its permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeHarness, FakeEmailProvider, FakeLineProvider } from '../helpers/app-harness.mjs';
import { backoffSeconds, quietUntil } from '../../src/application/outbox/worker.js';

const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();

function setup({ allow = [], lineEnabled = false, now = BKK('2026-06-15', '10:30') } = {}) {
  const email = new FakeEmailProvider();
  const line = new FakeLineProvider();
  const h = makeHarness({ now, config: { notifyAllowlist: allow, lineEnabled, webappUrl: 'https://script.google.com/macros/s/EXAMPLE/exec' }, extraPlatform: { providers: { EMAIL: email, LINE: line } } });
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  const classes = h.store.list('Classes', { limit: 10, orderBy: [['code', 'asc']] }).items;
  const roster = (cid) => h.store.findBy('Enrollments', 'class_id', cid).map((e) => e.student_id);
  const c1 = classes[0];
  const hr = h.store.findBy('StaffAssignments', 'class_id', c1.id).find((a) => a.assignment_type === 'HOMEROOM').user_id;
  const g = seed.guardian_users.find((x) => roster(c1.id).includes(x.student_id));
  const gEmail = h.store.get('Users', g.user_id).contact_email;
  return { h, ids, c1, hr, g, gEmail, email, line, roster };
}

/** Confirm an absence → ABSENCE_CONFIRMED to the guardian (outbox rows per channel). */
function confirmAbsence(ctx) {
  const { h, c1, hr, g } = ctx;
  h.ok(hr, 'rollcall.submit', { class_id: c1.id, school_date: '2026-06-15', marks: [{ student_id: g.student_id, mark: 'ABSENT' }] });
  h.ok(hr, 'attendance.verifyDay', { class_id: c1.id, school_date: '2026-06-15', confirm_absent_student_ids: [g.student_id] });
  return h.store.list('NotificationOutbox', { limit: 50 }).items.filter((o) => o.recipient_user_id === g.user_id);
}

function bindLine(h, userId, lineUserId) {
  h.store.seed('ChannelBindings', [{
    id: crypto.randomUUID(), user_id: userId, channel: 'LINE', address: lineUserId, status: 'ACTIVE', link_nonce_hash: null, link_expires_at: null, verified_at: h.clock.now(),
    verified_via: 'LINE_ACCOUNT_LINK', revoked_at: null, revoked_by: null, revoke_reason: null, created_at: h.clock.now(), created_by: userId, updated_at: h.clock.now(), updated_by: userId, version: 1,
  }]);
}

const dispatch = (h) => h.tick(['outbox.dispatch'])['outbox.dispatch'];
/** Overwrite a stored row in place (keeps its partition), for arranging edge cases. */
const patchRow = (h, table, id, patch) => h.store.seed(table, [{ ...h.store.get(table, id), ...patch }], h.store.partitionOf.get(table).get(id));

test('DEV never messages people outside the allowlist; allowlisted email is sent once and recorded', () => {
  const blocked = setup();
  const [row] = confirmAbsence(blocked);
  assert.equal(row.channel, 'EMAIL');
  dispatch(blocked.h);
  assert.equal(blocked.h.store.get('NotificationOutbox', row.id).delivery_state, 'CANCELLED');
  assert.equal(blocked.h.store.get('NotificationOutbox', row.id).held_reason, 'NON_PROD_NOT_ALLOWLISTED');
  assert.equal(blocked.email.sent.length, 0);

  const ok = setup({ allow: [] });
  ok.h.config.notifyAllowlist = [ok.gEmail];
  const [r2] = confirmAbsence(ok);
  const rep = dispatch(ok.h);
  assert.equal(rep.sent, 1);
  const after = ok.h.store.get('NotificationOutbox', r2.id);
  assert.equal(after.delivery_state, 'PROVIDER_ACCEPTED');
  assert.ok(after.accepted_at);
  assert.equal(ok.email.sent.length, 1);
  assert.match(ok.email.sent[0].subject, /แจ้งขาดเรียน/);
  assert.match(ok.email.sent[0].body, /page=notifications&id=/);
  assert.doesNotMatch(ok.email.sent[0].body, /ป่วย|แพทย์/, 'no medical details in templates');
  const attempts = ok.h.store.findBy('NotificationAttempts', 'outbox_id', r2.id);
  assert.deepEqual(attempts.map((a) => a.result), ['ACCEPTED']);
  // acceptance is not acknowledgement
  const rec = ok.h.store.get('NotificationRecipients', after.recipient_id);
  assert.equal(rec.ack_state, 'PENDING_ACK');
  dispatch(ok.h);
  assert.equal(ok.email.sent.length, 1, 'no second send');
});

test('quiet hours defer NORMAL messages to the end of the quiet period without consuming attempts', () => {
  const ctx = setup({ now: BKK('2026-06-15', '10:30') });
  ctx.h.config.notifyAllowlist = [ctx.gEmail];
  const [row] = confirmAbsence(ctx);
  ctx.h.clock.set(BKK('2026-06-15', '22:10'));
  dispatch(ctx.h);
  const r = ctx.h.store.get('NotificationOutbox', row.id);
  assert.equal(r.delivery_state, 'QUEUED');
  assert.equal(r.next_attempt_at, BKK('2026-06-16', '06:00'));
  assert.equal(r.held_reason, 'QUIET_HOURS');
  assert.equal(r.attempts, 0);
  ctx.h.clock.set(BKK('2026-06-16', '06:01'));
  dispatch(ctx.h);
  assert.equal(ctx.h.store.get('NotificationOutbox', row.id).delivery_state, 'PROVIDER_ACCEPTED');
  assert.equal(quietUntil(BKK('2026-06-15', '12:00'), { start: '21:00', end: '06:00' }, 'Asia/Bangkok'), null);
});

test('retryable errors back off exponentially and stop at max_attempts; final errors stop at once', () => {
  const ctx = setup();
  ctx.h.config.notifyAllowlist = [ctx.gEmail];
  const [row] = confirmAbsence(ctx);
  patchRow(ctx.h, 'NotificationOutbox', row.id, { max_attempts: 2 });
  ctx.email.queue.push({ result: 'RETRYABLE_ERROR', error_code: 'QUOTA', error_message: 'Service invoked too many times' });
  dispatch(ctx.h);
  let r = ctx.h.store.get('NotificationOutbox', row.id);
  assert.equal(r.delivery_state, 'RETRY_WAIT');
  assert.equal(Date.parse(r.next_attempt_at) - Date.parse(ctx.h.clock.now()), backoffSeconds(1, r.id) * 1000);
  dispatch(ctx.h);
  assert.equal(ctx.h.store.get('NotificationOutbox', row.id).attempts, 1, 'not due yet');
  ctx.h.clock.advance(10 * 60 * 1000);
  ctx.email.queue.push({ result: 'RETRYABLE_ERROR', error_code: 'QUOTA' });
  dispatch(ctx.h);
  r = ctx.h.store.get('NotificationOutbox', row.id);
  assert.equal(r.delivery_state, 'FAILED_FINAL');
  assert.equal(r.attempts, 2);
  assert.ok(backoffSeconds(3) >= 240 && backoffSeconds(30) <= 6 * 3600 + 30);

  const ctx2 = setup();
  ctx2.h.config.notifyAllowlist = [ctx2.gEmail];
  const [row2] = confirmAbsence(ctx2);
  ctx2.email.queue.push({ result: 'FINAL_ERROR', error_code: 'INVALID_ADDRESS' });
  dispatch(ctx2.h);
  assert.equal(ctx2.h.store.get('NotificationOutbox', row2.id).delivery_state, 'FAILED_FINAL');
});

test('LINE: worker dies after LINE accepted → retried with the SAME retry key → 409 → PROVIDER_ACCEPTED, delivered once', () => {
  const ctx = setup({ lineEnabled: true });
  bindLine(ctx.h, ctx.g.user_id, 'U00000000000000000000000000000001');
  ctx.h.config.notifyAllowlist = ['U00000000000000000000000000000001'];
  const rows = confirmAbsence(ctx);
  const lineRow = rows.find((r) => r.channel === 'LINE');
  assert.ok(lineRow, 'LINE outbox row created for the bound guardian');
  // simulate process death right after the provider accepted: the finish commit never lands
  ctx.line.onAccept = () => { ctx.h.store.failNextCommit = new Error('process died'); ctx.line.onAccept = null; };
  assert.throws(() => dispatch(ctx.h), /process died/);
  let r = ctx.h.store.get('NotificationOutbox', lineRow.id);
  assert.equal(r.delivery_state, 'PROCESSING');
  const key = r.retry_key;
  assert.ok(key);
  assert.equal(ctx.line.delivered.length, 1);
  // lease not yet expired: nobody touches it
  dispatch(ctx.h);
  assert.equal(ctx.h.store.get('NotificationOutbox', lineRow.id).delivery_state, 'PROCESSING');
  ctx.h.clock.advance(3 * 60 * 1000);
  dispatch(ctx.h); // recovery → RETRY_WAIT (OUTCOME_UNKNOWN attempt)
  r = ctx.h.store.get('NotificationOutbox', lineRow.id);
  assert.equal(r.delivery_state, 'RETRY_WAIT');
  dispatch(ctx.h); // retry with the same key
  r = ctx.h.store.get('NotificationOutbox', lineRow.id);
  assert.equal(r.delivery_state, 'PROVIDER_ACCEPTED');
  assert.equal(r.retry_key, key, 'same retry key');
  assert.equal(ctx.line.delivered.length, 1, 'LINE delivered the message only once');
  const results = ctx.h.store.findBy('NotificationAttempts', 'outbox_id', lineRow.id).sort((a, b) => a.started_at.localeCompare(b.started_at) || a.attempt_no - b.attempt_no).map((a) => a.result);
  assert.deepEqual(results, ['OUTCOME_UNKNOWN', 'DUPLICATE_ACCEPTED']);
  // the LINE message carries ack/callback postbacks bound to the recipient row, not a guessable URL
  const msg = ctx.line.delivered[0].messages;
  assert.equal(msg[1].type, 'template');
  assert.ok(msg[1].template.actions.some((a) => a.type === 'postback' && a.data === `cwk=ack&r=${r.recipient_id}`));
});

test('email: worker dies after MailApp sent → FAILED_FINAL/OUTCOME_UNKNOWN, never re-sent automatically; resend is explicit', () => {
  const ctx = setup();
  ctx.h.config.notifyAllowlist = [ctx.gEmail];
  const [row] = confirmAbsence(ctx);
  const realSend = ctx.email.send.bind(ctx.email);
  ctx.email.send = (m) => { const r = realSend(m); ctx.h.store.failNextCommit = new Error('process died'); ctx.email.send = realSend; return r; };
  assert.throws(() => dispatch(ctx.h), /process died/);
  ctx.h.clock.advance(3 * 60 * 1000);
  dispatch(ctx.h);
  let r = ctx.h.store.get('NotificationOutbox', row.id);
  assert.equal(r.delivery_state, 'FAILED_FINAL');
  assert.equal(r.last_error_code, 'OUTCOME_UNKNOWN');
  dispatch(ctx.h);
  assert.equal(ctx.email.sent.length, 1, 'no automatic re-send');
  // monitor shows it; RETRY_SAME is refused for email; RESEND_NEW creates a new outbox row
  const mon = ctx.h.ok(ctx.ids.affairs, 'notification.monitor', {});
  assert.ok(mon.items.some((x) => x.outbox_id === row.id && x.last_error_code === 'OUTCOME_UNKNOWN'));
  assert.equal(mon.counts.EMAIL.FAILED_FINAL, 1);
  assert.equal(ctx.h.call(ctx.g.user_id, 'notification.monitor', {}).error.code, 'FORBIDDEN');
  assert.equal(ctx.h.call(ctx.ids.affairs, 'notification.resend', { outbox_id: row.id, mode: 'RETRY_SAME', reason: 'ลองอีกครั้ง' }, { expectedVersion: r.version }).error.code, 'VALIDATION_ERROR');
  assert.equal(ctx.h.call(ctx.hr, 'notification.resend', { outbox_id: row.id, mode: 'RESEND_NEW', reason: 'ส่งใหม่' }, { expectedVersion: r.version }).error.code, 'FORBIDDEN');
  const res = ctx.h.ok(ctx.ids.affairs, 'notification.resend', { outbox_id: row.id, mode: 'RESEND_NEW', reason: 'ผู้ปกครองแจ้งว่าไม่ได้รับอีเมล' }, { expectedVersion: r.version });
  assert.notEqual(res.outbox_id, row.id);
  assert.equal(ctx.h.store.get('NotificationOutbox', res.outbox_id).resend_of_outbox_id, row.id);
  dispatch(ctx.h);
  assert.equal(ctx.email.sent.length, 2);
  assert.ok(ctx.h.store.list('AuditEvents', { where: { action: 'notification.resend' }, limit: 5 }).items.length === 1);
});

test('recipient eligibility is re-checked before sending: ended guardian link or revoked LINE binding cancels the message', () => {
  const ctx = setup({ lineEnabled: true });
  bindLine(ctx.h, ctx.g.user_id, 'U00000000000000000000000000000002');
  ctx.h.config.notifyAllowlist = [ctx.gEmail, 'U00000000000000000000000000000002'];
  const rows = confirmAbsence(ctx);
  assert.equal(rows.length, 2);
  // the guardian relationship ends before the worker runs
  const link = ctx.h.store.findBy('StudentGuardians', 'student_id', ctx.g.student_id).find((l) => l.guardian_id === ctx.h.store.get('Users', ctx.g.user_id).guardian_id);
  patchRow(ctx.h, 'StudentGuardians', link.id, { status: 'ENDED', effective_to: '2026-06-15' });
  dispatch(ctx.h);
  for (const r of rows) assert.equal(ctx.h.store.get('NotificationOutbox', r.id).held_reason, 'RECIPIENT_NO_LONGER_ELIGIBLE');
  assert.equal(ctx.email.sent.length + ctx.line.delivered.length, 0);

  const ctx2 = setup({ lineEnabled: true });
  bindLine(ctx2.h, ctx2.g.user_id, 'U00000000000000000000000000000003');
  ctx2.h.config.notifyAllowlist = ['U00000000000000000000000000000003'];
  const lineRow = confirmAbsence(ctx2).find((r) => r.channel === 'LINE');
  const b = ctx2.h.store.findBy('ChannelBindings', 'user_id', ctx2.g.user_id)[0];
  ctx2.h.ok(ctx2.g.user_id, 'channel.unbind', { binding_id: b.id }, { expectedVersion: b.version });
  dispatch(ctx2.h);
  assert.equal(ctx2.h.store.get('NotificationOutbox', lineRow.id).held_reason, 'CHANNEL_REMOVED');
});

test('LINE RETRY_SAME is allowed only inside the retry-key window; afterwards a send needs RESEND_NEW', () => {
  const ctx = setup({ lineEnabled: true });
  bindLine(ctx.h, ctx.g.user_id, 'U00000000000000000000000000000004');
  ctx.h.config.notifyAllowlist = ['U00000000000000000000000000000004'];
  const lineRow = confirmAbsence(ctx).find((r) => r.channel === 'LINE');
  ctx.line.queue.push({ result: 'FINAL_ERROR', http_status: 400, error_code: 'BAD_REQUEST' });
  dispatch(ctx.h);
  let r = ctx.h.store.get('NotificationOutbox', lineRow.id);
  assert.equal(r.delivery_state, 'FAILED_FINAL');
  const res = ctx.h.ok(ctx.ids.affairs, 'notification.resend', { outbox_id: r.id, mode: 'RETRY_SAME', reason: 'แก้ไขค่าตั้งแล้ว' }, { expectedVersion: r.version });
  assert.equal(res.outbox_id, r.id);
  dispatch(ctx.h);
  r = ctx.h.store.get('NotificationOutbox', lineRow.id);
  assert.equal(r.delivery_state, 'PROVIDER_ACCEPTED');
  // a row whose key is older than the window cannot be retried with the same key
  patchRow(ctx.h, 'NotificationOutbox', r.id, { delivery_state: 'FAILED_FINAL', version: r.version + 1 });
  ctx.h.clock.advance(13 * 3600 * 1000);
  const err = ctx.h.call(ctx.ids.affairs, 'notification.resend', { outbox_id: r.id, mode: 'RETRY_SAME', reason: 'ลองใหม่' }, { expectedVersion: r.version + 1 });
  assert.equal(err.error.code, 'INVALID_STATE');
});

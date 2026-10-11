// LINE webhook intake (MASTER_PROMPT §11.3–11.4, D-010): signed gateway envelopes, durable dedupe,
// account linking with a one-time nonce, identity-bound postbacks, inbound messages, unfollow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeHarness, FakeEmailProvider, FakeLineProvider } from '../helpers/app-harness.mjs';
import { intakeLineWebhook, processInboxRow } from '../../src/application/webhook/line-webhook.js';
import { envelopeSigningString } from '../../src/shared/gateway-protocol.js';
import { runSync } from '../../src/application/runtime.js';

const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
const SECRET = 'test-envelope-secret-not-real';
const KID = 'line-k1';

function setup() {
  const line = new FakeLineProvider();
  const h = makeHarness({
    now: BKK('2026-06-15', '10:30'), secrets: { CWK_LINE_WEBHOOK_SECRET: SECRET },
    config: { lineEnabled: true, lineWebhookKeyId: KID, webappUrl: 'https://script.google.com/macros/s/EXAMPLE/exec' },
    extraPlatform: { providers: { LINE: line, EMAIL: new FakeEmailProvider() } },
  });
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  const classes = h.store.list('Classes', { limit: 10, orderBy: [['code', 'asc']] }).items;
  const roster = (cid) => h.store.findBy('Enrollments', 'class_id', cid).map((e) => e.student_id);
  const c1 = classes[0];
  const hr = h.store.findBy('StaffAssignments', 'class_id', c1.id).find((a) => a.assignment_type === 'HOMEROOM').user_id;
  const guardians = seed.guardian_users;
  const g = guardians.find((x) => roster(c1.id).includes(x.student_id));
  return { h, line, ids, c1, hr, g, guardians, roster };
}

let seq = 0;
function envelope(h, event, { secret = SECRET, kid = KID, tsOffset = 0, tamper = false } = {}) {
  const nonce = event.webhookEventId;
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.parse(h.clock.now()) / 1000) + tsOffset;
  const sig = crypto.createHmac('sha256', secret).update(envelopeSigningString({ kid, ts, nonce, source: 'LINE', payloadSha256: crypto.createHash('sha256').update(payload).digest('hex') })).digest('base64');
  return JSON.stringify({ v: 1, kid, ts, nonce, source: 'LINE', payload: tamper ? payload.replace('"type"', '"type" ') : payload, sig });
}

function ev(h, type, userId, extra = {}) {
  seq++;
  return { type, webhookEventId: `01HXEVENT${String(seq).padStart(10, '0')}`, timestamp: Date.parse(h.clock.now()), source: { type: 'user', userId }, replyToken: `rt${seq}`, mode: 'active', deliveryContext: { isRedelivery: false }, ...extra };
}

const intake = (h, raw) => runSync(intakeLineWebhook, h.deps, raw);
const LINE_A = 'U1111111111111111111111111111111a';
const LINE_B = 'U2222222222222222222222222222222b';

/** Full account-link flow for `userId` from LINE user `lineUserId`. */
function link(ctx, userId, lineUserId) {
  const { h, line } = ctx;
  intake(h, envelope(h, ev(h, 'follow', lineUserId)));
  const token = line.linkTokens.filter((t) => t.lineUserId === lineUserId).pop().token;
  const start = h.ok(userId, 'channel.startLineLink', { link_token: token });
  const nonce = new URL(start.redirect_url).searchParams.get('nonce');
  intake(h, envelope(h, ev(h, 'accountLink', lineUserId, { link: { result: 'ok', nonce } })));
  return { start, nonce };
}

test('envelope: bad signature, wrong key id, stale timestamp and tampered payload are rejected; replay is stored once', () => {
  const { h } = setup();
  const e = ev(h, 'follow', LINE_A);
  assert.throws(() => intake(h, envelope(h, e, { secret: 'wrong' })), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => intake(h, envelope(h, e, { kid: 'other' })), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => intake(h, envelope(h, e, { tsOffset: -400 })), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => intake(h, envelope(h, e, { tamper: true })), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => intake(h, '{"v":1}'), (err) => err.code === 'VALIDATION_ERROR');
  assert.equal(h.store.list('WebhookInbox', { limit: 10 }).items.length, 0, 'nothing stored for rejected envelopes');
  const raw = envelope(h, e);
  assert.deepEqual(intake(h, raw), { ok: true, stored: true });
  assert.deepEqual(intake(h, raw), { ok: true, stored: true, duplicate: true });
  assert.equal(h.store.findBy('WebhookInbox', 'webhook_event_id', e.webhookEventId).length, 1);
});

test('account link: follow → link token reply; login + one-time nonce; accountLink binds; expired or reused nonce fails', () => {
  const ctx = setup();
  const { h, line, g, guardians } = ctx;
  intake(h, envelope(h, ev(h, 'follow', LINE_A)));
  assert.equal(line.linkTokens.length, 1);
  assert.match(line.replies[0].messages[0].text, /page=line-link&linkToken=LinkTok1/);
  // the browser never submits a LINE user id; it only starts the flow while logged in
  const start = h.ok(g.user_id, 'channel.startLineLink', { link_token: line.linkTokens[0].token });
  assert.match(start.redirect_url, /^https:\/\/access\.line\.me\/dialog\/bot\/accountLink\?linkToken=LinkTok1abcdef&nonce=[0-9a-f]{64}$/);
  const nonce = new URL(start.redirect_url).searchParams.get('nonce');
  const pending = h.store.findBy('ChannelBindings', 'user_id', g.user_id)[0];
  assert.equal(pending.status, 'PENDING');
  assert.notEqual(pending.link_nonce_hash, nonce, 'only the hash is stored');
  intake(h, envelope(h, ev(h, 'accountLink', LINE_A, { link: { result: 'ok', nonce } })));
  const b = h.store.get('ChannelBindings', pending.id);
  assert.deepEqual([b.status, b.address, b.verified_via, b.link_nonce_hash], ['ACTIVE', LINE_A, 'LINE_ACCOUNT_LINK', null]);
  // the same nonce cannot bind another LINE account
  intake(h, envelope(h, ev(h, 'accountLink', LINE_B, { link: { result: 'ok', nonce } })));
  assert.equal(h.store.findBy('ChannelBindings', 'address', LINE_B).length, 0);
  // an expired nonce is refused
  const other = guardians.find((x) => x.user_id !== g.user_id);
  const s2 = h.ok(other.user_id, 'channel.startLineLink', { link_token: 'LinkTokXYZ12345' });
  h.clock.advance(11 * 60 * 1000);
  intake(h, envelope(h, ev(h, 'accountLink', LINE_B, { link: { result: 'ok', nonce: new URL(s2.redirect_url).searchParams.get('nonce') } })));
  assert.equal(h.store.findBy('ChannelBindings', 'user_id', other.user_id)[0].status, 'PENDING');
  const status = h.ok(g.user_id, 'channel.status', {});
  assert.equal(status.bindings[0].status, 'ACTIVE');
  assert.ok(!status.bindings[0].address_masked.includes(LINE_A), 'address masked');
});

test('postback ACK/callback acts only as the bound user on that user\'s own notification', () => {
  const ctx = setup();
  const { h, c1, hr, g, guardians, roster } = ctx;
  link(ctx, g.user_id, LINE_A);
  const other = guardians.find((x) => x.user_id !== g.user_id && roster(c1.id).includes(x.student_id)) || guardians.find((x) => x.user_id !== g.user_id);
  link(ctx, other.user_id, LINE_B);
  h.ok(hr, 'rollcall.submit', { class_id: c1.id, school_date: '2026-06-15', marks: [{ student_id: g.student_id, mark: 'ABSENT' }] });
  h.ok(hr, 'attendance.verifyDay', { class_id: c1.id, school_date: '2026-06-15', confirm_absent_student_ids: [g.student_id] });
  const rec = h.store.findBy('NotificationRecipients', 'recipient_user_id', g.user_id).find((r) => r.ack_required);
  // another LINE user replays the postback data → ignored, nothing recorded
  intake(h, envelope(h, ev(h, 'postback', LINE_B, { postback: { data: `cwk=ack&r=${rec.id}` } })));
  assert.equal(h.store.findBy('Acknowledgements', 'recipient_id', rec.id).length, 0);
  intake(h, envelope(h, ev(h, 'postback', LINE_A, { postback: { data: `cwk=ack&r=${rec.id}` } })));
  const acks = h.store.findBy('Acknowledgements', 'recipient_id', rec.id);
  assert.equal(acks.length, 1);
  assert.deepEqual([acks[0].channel, acks[0].user_id], ['LINE', g.user_id]);
  assert.equal(h.store.get('NotificationRecipients', rec.id).ack_state, 'ACKNOWLEDGED');
  intake(h, envelope(h, ev(h, 'postback', LINE_A, { postback: { data: `cwk=callback&r=${rec.id}` } })));
  assert.equal(h.store.findBy('Cases', 'student_id', g.student_id).filter((c) => c.case_type === 'CALLBACK_REQUEST').length, 1);
});

test('inbound text from a bound guardian reaches the homeroom contact inbox; media is not processed; unfollow revokes', () => {
  const ctx = setup();
  const { h, hr, g, line } = ctx;
  link(ctx, g.user_id, LINE_A);
  intake(h, envelope(h, ev(h, 'message', LINE_A, { message: { type: 'text', id: 'm1', text: 'พรุ่งนี้ลูกขอลาไปหาหมอค่ะ' } })));
  const inbox = h.ok(hr, 'contact.inbox', {}).items;
  assert.ok(inbox.some((x) => x.student_id === g.student_id && x.channel === 'LINE' && x.summary.includes('พรุ่งนี้')));
  assert.match(line.replies.pop().messages[0].text, /ได้รับข้อความแล้ว/);
  const before = h.store.findBy('ContactLogs', 'direction', 'INBOUND').length;
  intake(h, envelope(h, ev(h, 'message', LINE_A, { message: { type: 'image', id: 'm2' } })));
  assert.equal(h.store.findBy('ContactLogs', 'direction', 'INBOUND').length, before);
  // group sources are never used
  const grp = ev(h, 'message', LINE_A, { message: { type: 'text', text: 'hi' } });
  grp.source = { type: 'group', groupId: 'Cgroup', userId: LINE_A };
  intake(h, envelope(h, grp));
  assert.equal(h.store.findBy('WebhookInbox', 'webhook_event_id', grp.webhookEventId)[0].status, 'IGNORED');
  intake(h, envelope(h, ev(h, 'unfollow', LINE_A)));
  assert.equal(h.store.findBy('ChannelBindings', 'user_id', g.user_id)[0].status, 'REVOKED');
});

test('processing failure after the durable store is retried by the tick', () => {
  const ctx = setup();
  const { h, g } = ctx;
  link(ctx, g.user_id, LINE_A);
  const e = ev(h, 'message', LINE_A, { message: { type: 'text', text: 'สวัสดีครับ' } });
  h.store.failNextCommit = null;
  // make processing fail once: the ContactLogs commit throws a retryable storage error
  const orig = h.deps.mutations.commit.bind(h.deps.mutations);
  let failed = false;
  h.deps.mutations.commit = (cs) => {
    if (!failed && cs.writes && cs.writes.some((w) => w.table === 'ContactLogs')) { failed = true; const err = new Error('Sheets unavailable'); throw err; }
    return orig(cs);
  };
  assert.deepEqual(intake(h, envelope(h, e)), { ok: true, stored: true });
  const row = h.store.findBy('WebhookInbox', 'webhook_event_id', e.webhookEventId)[0];
  assert.equal(row.status, 'FAILED');
  h.deps.mutations.commit = orig;
  h.tick(['webhook.retry']);
  assert.equal(h.store.get('WebhookInbox', row.id).status, 'PROCESSED');
  assert.equal(runSync(processInboxRow, h.deps, row.id), 'PROCESSED', 'processing is not repeated');
  assert.equal(h.store.findBy('ContactLogs', 'direction', 'INBOUND').length >= 1, true);
});

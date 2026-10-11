// LINE webhook intake on the application side (MASTER_PROMPT §11.3–11.4, DECISIONS D-010).
// The gateway verified x-line-signature on the raw body and forwards ONE event per signed envelope
// {v, kid, ts, nonce=webhookEventId, source, payload, sig}. Here we verify the envelope HMAC, clock
// skew and schema, store the event durably in WebhookInbox (dedupe on (source, webhook_event_id))
// and only then answer {ok, stored:true}. Processing runs after the durable store; failures are
// retried by the tick. Knowing the /exec URL grants nothing without the envelope key.
import { createContext, commitRaw } from '../context.js';
import { systemPrincipal, principalForBoundUser } from '../principal.js';
import { acknowledgeRecipient } from '../services/ack.js';
import { studentShortName } from '../services/notify.js';
import { webLink } from '../outbox/compose.js';
import { envelopeSigningString, withinSkew } from '../../shared/gateway-protocol.js';
import { timingSafeEqualStr } from '../../shared/hash.js';
import { AppError, isAppError } from '../../shared/errors.js';
import { addMinutesIso, dateInRange } from '../../shared/time.js';
import { SYSTEM_USER_ID } from '../../shared/uuid.js';

export const MAX_ENVELOPE_BYTES = 1024 * 1024;
const KNOWN = new Set(['message', 'follow', 'unfollow', 'postback', 'accountLink', 'join', 'leave', 'memberJoined', 'memberLeft', 'beacon', 'videoPlayComplete', 'things', 'unsend', 'membership']);

function reject(code, msg) {
  return new AppError(code, msg, { messageTh: 'คำขอ webhook ไม่ผ่านการตรวจสอบ' });
}

/** Verify the gateway envelope; returns { nonce, ts, event }. Throws UNAUTHENTICATED/VALIDATION_ERROR. */
export function verifyEnvelope(raw, { keyId, secret, crypto, nowMs }) {
  if (!keyId || !secret) throw new AppError('CONFIGURATION_REQUIRED', 'webhook envelope key not configured');
  if (typeof raw !== 'string' || raw.length > MAX_ENVELOPE_BYTES) throw reject('VALIDATION_ERROR', 'envelope size');
  let env;
  try { env = JSON.parse(raw); } catch (_) { throw reject('VALIDATION_ERROR', 'envelope json'); }
  if (!env || env.v !== 1 || typeof env.payload !== 'string' || typeof env.sig !== 'string' || typeof env.nonce !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(env.nonce)) throw reject('VALIDATION_ERROR', 'envelope shape');
  if (env.kid !== keyId) throw reject('UNAUTHENTICATED', 'unknown key id');
  if (env.source !== 'LINE') throw reject('VALIDATION_ERROR', 'source');
  if (!withinSkew(env.ts, nowMs)) throw reject('UNAUTHENTICATED', 'timestamp outside allowed skew');
  const expected = crypto.hmacSha256Base64(secret, envelopeSigningString({ kid: env.kid, ts: env.ts, nonce: env.nonce, source: env.source, payloadSha256: crypto.sha256Hex(env.payload) }));
  if (!timingSafeEqualStr(env.sig, expected)) throw reject('UNAUTHENTICATED', 'bad envelope signature');
  let event;
  try { event = JSON.parse(env.payload); } catch (_) { throw reject('VALIDATION_ERROR', 'payload json'); }
  if (!event || typeof event.type !== 'string' || event.webhookEventId !== env.nonce || typeof event.timestamp !== 'number' || !event.source || typeof event.source.type !== 'string') {
    throw reject('VALIDATION_ERROR', 'event schema');
  }
  return { nonce: env.nonce, ts: Number(env.ts), event };
}

function* sysCtx(deps, operation) {
  const ctx = yield* createContext(deps, { operation, channel: 'WEBHOOK' });
  ctx.principal = systemPrincipal(SYSTEM_USER_ID);
  return ctx;
}

/** Entry from doPost / REST: verify → store durably → process. Never throws for a stored event. */
export function* intakeLineWebhook(deps, raw) {
  const cfg = deps.config;
  const { nonce, ts, event } = verifyEnvelope(raw, { keyId: cfg.lineWebhookKeyId, secret: cfg.secret ? cfg.secret('CWK_LINE_WEBHOOK_SECRET') : null, crypto: deps.crypto, nowMs: Date.parse(deps.clock.now()) });
  const ctx = yield* sysCtx(deps, 'webhook.intake');
  const cs = ctx.changeSet('webhook.intake');
  const row = cs.insert('WebhookInbox', {
    source: 'LINE', webhook_event_id: nonce, received_at: ctx.now, envelope_ts: new Date(ts * 1000).toISOString(), event_type: event.type.slice(0, 50),
    payload_json: event, status: 'RECEIVED', attempts: 0,
  });
  try {
    yield* commitRaw(ctx, cs);
  } catch (e) {
    if (isAppError(e) && e.code === 'UNIQUE_VIOLATION') return { ok: true, stored: true, duplicate: true };
    throw e;
  }
  try { yield* processInboxRow(deps, row.id, { allowReply: true }); } catch (_) { /* recorded on the row; retried by tick */ }
  return { ok: true, stored: true };
}

function* replyBestEffort(ctx, event, text, allowReply) {
  const line = (ctx.platform.providers || {}).LINE;
  if (!allowReply || !line || !line.reply || !event.replyToken) return false;
  try { line.reply(event.replyToken, [{ type: 'text', text }]); return true; } catch (_) { return false; }
}

function* activeBinding(ctx, lineUserId) {
  if (!lineUserId) return null;
  return (yield ctx.store.findBy('ChannelBindings', 'address', lineUserId)).find((b) => b.channel === 'LINE' && b.status === 'ACTIVE') || null;
}

function parsePostback(data) {
  const out = {};
  for (const kv of String(data || '').split('&')) { const [k, v] = kv.split('='); if (k) out[k] = decodeURIComponent(v || ''); }
  return out;
}

/** Handle one stored event; returns the final status. */
export function* processInboxRow(deps, rowId, { allowReply = false } = {}) {
  const ctx = yield* sysCtx(deps, 'webhook.process');
  const row = yield ctx.store.get('WebhookInbox', rowId);
  if (!row || row.status === 'PROCESSED' || row.status === 'IGNORED') return row ? row.status : null;
  const event = row.payload_json;
  let status = 'IGNORED';
  let error = null;
  try {
    status = yield* handleEvent(deps, ctx, event, allowReply);
  } catch (e) {
    status = 'FAILED';
    error = isAppError(e) ? `${e.code}: ${e.message}` : String(e && e.message ? e.message : e);
  }
  const fin = yield* sysCtx(deps, 'webhook.finish');
  const latest = (yield fin.store.get('WebhookInbox', rowId)) || row;
  const cs = fin.changeSet('webhook.finish');
  cs.update('WebhookInbox', latest, { status, processed_at: status === 'FAILED' ? null : fin.now, attempts: latest.attempts + 1, last_error: error ? error.slice(0, 500) : null });
  yield* commitRaw(fin, cs);
  return status;
}

function* handleEvent(deps, ctx, event, allowReply) {
  if (!KNOWN.has(event.type)) return 'IGNORED';
  const src = event.source || {};
  if (src.type !== 'user' || !src.userId) return 'IGNORED'; // groups/rooms are never used for student data
  const lineUserId = src.userId;
  switch (event.type) {
    case 'follow':
    case 'message': {
      const binding = yield* activeBinding(ctx, lineUserId);
      if (!binding) return yield* offerAccountLink(ctx, event, lineUserId, allowReply);
      if (event.type === 'message') return yield* inboundMessage(deps, ctx, event, binding, allowReply);
      return 'PROCESSED';
    }
    case 'accountLink':
      return yield* completeAccountLink(ctx, event, lineUserId, allowReply);
    case 'unfollow': {
      const cs = ctx.changeSet('webhook.unfollow');
      for (const b of (yield ctx.store.findBy('ChannelBindings', 'address', lineUserId)).filter((x) => x.channel === 'LINE' && x.status === 'ACTIVE')) {
        cs.update('ChannelBindings', b, { status: 'REVOKED', revoked_at: ctx.now, revoked_by: SYSTEM_USER_ID, revoke_reason: 'LINE_UNFOLLOW' });
        cs.audit({ action: 'channel.unfollow', entityType: 'ChannelBindings', entityId: b.id });
      }
      if (!cs.isEmpty) yield* commitRaw(ctx, cs);
      return 'PROCESSED';
    }
    case 'postback':
      return yield* postback(deps, ctx, event, lineUserId, allowReply);
    default:
      return 'IGNORED';
  }
}

/** Unbound LINE user: issue a LINE link token and reply with the web link (login happens on the web). */
function* offerAccountLink(ctx, event, lineUserId, allowReply) {
  const line = (ctx.platform.providers || {}).LINE;
  if (!line || !line.issueLinkToken || !allowReply || !event.replyToken) return 'IGNORED';
  const token = line.issueLinkToken(lineUserId);
  const link = token ? webLink(ctx.config, 'line-link', null) : null;
  if (!link) {
    yield* replyBestEffort(ctx, event, 'ระบบยังไม่พร้อมเชื่อมบัญชี LINE กรุณาติดต่อโรงเรียน', allowReply);
    return 'PROCESSED';
  }
  yield* replyBestEffort(ctx, event, `เชื่อม LINE กับบัญชี CWK Smart Care ของท่าน: เปิดลิงก์นี้แล้วเข้าสู่ระบบ (ลิงก์ใช้ได้ครั้งเดียวและมีอายุสั้น)\n${link}&linkToken=${encodeURIComponent(token)}`, allowReply);
  return 'PROCESSED';
}

function* completeAccountLink(ctx, event, lineUserId, allowReply) {
  const link = event.link || {};
  if (link.result !== 'ok' || typeof link.nonce !== 'string') return 'IGNORED';
  const hash = ctx.crypto.sha256Hex(link.nonce);
  const pending = (yield ctx.store.findBy('ChannelBindings', 'link_nonce_hash', hash)).find((b) => b.channel === 'LINE' && b.status === 'PENDING');
  if (!pending || !pending.link_expires_at || pending.link_expires_at < ctx.now) {
    yield* replyBestEffort(ctx, event, 'ลิงก์เชื่อมบัญชีหมดอายุหรือไม่ถูกต้อง กรุณาเริ่มใหม่', allowReply);
    return 'IGNORED';
  }
  const user = yield ctx.store.get('Users', pending.user_id);
  const cs = ctx.changeSet('webhook.account_link');
  if (!user || user.status !== 'ACTIVE') {
    cs.update('ChannelBindings', pending, { status: 'REVOKED', revoked_at: ctx.now, revoked_by: SYSTEM_USER_ID, revoke_reason: 'USER_INACTIVE', link_nonce_hash: null });
    yield* commitRaw(ctx, cs);
    return 'IGNORED';
  }
  // one LINE account ↔ one app user: older active bindings of this LINE user or of this app user are revoked
  const others = [...(yield ctx.store.findBy('ChannelBindings', 'address', lineUserId)), ...(yield ctx.store.findBy('ChannelBindings', 'user_id', user.id))]
    .filter((b, i, arr) => b.id !== pending.id && b.channel === 'LINE' && b.status === 'ACTIVE' && arr.findIndex((x) => x.id === b.id) === i);
  for (const b of others) cs.update('ChannelBindings', b, { status: 'REVOKED', revoked_at: ctx.now, revoked_by: SYSTEM_USER_ID, revoke_reason: 'RELINKED' });
  cs.update('ChannelBindings', pending, { status: 'ACTIVE', address: lineUserId, verified_at: ctx.now, verified_via: 'LINE_ACCOUNT_LINK', link_nonce_hash: null, link_expires_at: null });
  cs.audit({ action: 'channel.link_complete', entityType: 'ChannelBindings', entityId: pending.id, after: { user_id: user.id, replaced: others.length } });
  yield* commitRaw(ctx, cs);
  yield* replyBestEffort(ctx, event, `เชื่อม LINE กับบัญชี ${user.display_name} เรียบร้อยแล้ว ท่านจะได้รับแจ้งเตือนเฉพาะเรื่องที่มีสิทธิ์`, allowReply);
  return 'PROCESSED';
}

/** ACK / callback buttons: act as the user bound to this LINE account, on that user's own recipient row. */
function* postback(deps, ctx, event, lineUserId, allowReply) {
  const data = parsePostback(event.postback && event.postback.data);
  if (data.cwk !== 'ack' && data.cwk !== 'callback') return 'IGNORED';
  const binding = yield* activeBinding(ctx, lineUserId);
  if (!binding) { yield* replyBestEffort(ctx, event, 'บัญชี LINE นี้ยังไม่ได้เชื่อมกับระบบ', allowReply); return 'IGNORED'; }
  const user = yield ctx.store.get('Users', binding.user_id);
  const actx = yield* createContext(deps, { operation: 'webhook.acknowledge', channel: 'WEBHOOK' });
  actx.principal = yield* principalForBoundUser(actx, user, 'LINE');
  const rec = /^[0-9a-f-]{36}$/.test(data.r || '') ? yield actx.store.get('NotificationRecipients', data.r) : null;
  if (!rec || rec.recipient_user_id !== user.id) { yield* replyBestEffort(ctx, event, 'ไม่พบการแจ้งเตือนนี้ในบัญชีของท่าน', allowReply); return 'IGNORED'; }
  const cs = actx.changeSet('webhook.acknowledge');
  let res;
  try {
    res = yield* acknowledgeRecipient(actx, cs, rec, { action: data.cwk === 'ack' ? 'ACKNOWLEDGED' : 'CALLBACK_REQUESTED', channel: 'LINE', note: null });
  } catch (e) {
    if (isAppError(e) && e.code === 'INVALID_STATE') { yield* replyBestEffort(ctx, event, 'ทำรายการนี้ไม่ได้แล้ว', allowReply); return 'IGNORED'; }
    throw e;
  }
  if (!res.duplicate) yield* commitRaw(actx, cs);
  yield* replyBestEffort(ctx, event, data.cwk === 'ack' ? 'บันทึกการรับทราบแล้ว ขอบคุณค่ะ/ครับ' : 'ส่งคำขอให้ครูติดต่อกลับแล้ว', allowReply);
  return 'PROCESSED';
}

/**
 * Text from a bound guardian goes to the follow-up queue of the teachers of each linked child as an
 * INBOUND contact needing a reply (ContactLogs.follow_up_required). Media is not downloaded.
 */
function* inboundMessage(deps, ctx, event, binding, allowReply) {
  const user = yield ctx.store.get('Users', binding.user_id);
  if (!user || user.user_type !== 'GUARDIAN' || !user.guardian_id) return 'IGNORED';
  const msg = event.message || {};
  if (msg.type !== 'text') { yield* replyBestEffort(ctx, event, 'ระบบรับเฉพาะข้อความตัวอักษร หากเร่งด่วนกรุณาโทรหาโรงเรียน', allowReply); return 'IGNORED'; }
  const links = (yield ctx.store.findBy('StudentGuardians', 'guardian_id', user.guardian_id)).filter((l) => l.status === 'ACTIVE' && dateInRange(ctx.today, l.effective_from, l.effective_to));
  if (!links.length) return 'IGNORED';
  const cs = ctx.changeSet('webhook.inbound');
  const at = new Date(event.timestamp).toISOString();
  for (const l of links) {
    const s = yield ctx.store.get('Students', l.student_id);
    if (!s) continue;
    const log = cs.insert('ContactLogs', {
      student_id: l.student_id, case_id: null, guardian_id: user.guardian_id, channel: 'LINE', direction: 'INBOUND', contacted_at: at < ctx.now ? at : ctx.now,
      contacted_by: user.id, outcome: 'FOLLOW_UP_NEEDED', summary: String(msg.text || '').slice(0, 1000), follow_up_required: true, next_follow_up_at: addMinutesIso(ctx.now, 24 * 60),
      supersedes_id: null, operation_id: cs.operationId,
    });
    cs.audit({ action: 'contact.inbound', entityType: 'ContactLogs', entityId: log.id, studentId: l.student_id, after: { channel: 'LINE', student: studentShortName(s) } });
  }
  yield* commitRaw(ctx, cs);
  yield* replyBestEffort(ctx, event, 'โรงเรียนได้รับข้อความแล้ว ครูจะติดต่อกลับในเวลาทำการ หากเร่งด่วนกรุณาโทรหาโรงเรียน', allowReply);
  return 'PROCESSED';
}

/** Tick: re-process events stored but not processed (e.g. failure after the durable store). */
export const WEBHOOK_TICK = {
  name: 'webhook.retry',
  *run(deps, { deadlineAt } = {}) {
    const ctx = yield* sysCtx(deps, 'webhook.scan');
    const rows = (yield ctx.store.list('WebhookInbox', { where: { status: { in: ['RECEIVED', 'FAILED'] } }, limit: 50 })).items
      .filter((r) => r.attempts < 5 && (r.status === 'FAILED' || r.received_at < addMinutesIso(ctx.now, -2)));
    const out = { retried: 0 };
    for (const r of rows) {
      if (deadlineAt && Date.now() > deadlineAt - 20000) break;
      yield* processInboxRow(deps, r.id, { allowReply: false });
      out.retried++;
    }
    return out;
  },
};

// CWK gateway request handling (MASTER_PROMPT §11.4, DECISIONS D-003/D-010). Pure node:http; no
// framework. Logs carry no bodies, tokens, signatures or LINE user IDs.
//
//   POST /line/webhook          raw body ≤ 1 MB → x-line-signature (HMAC-SHA256, channel secret)
//                               verified BEFORE parsing → one signed envelope per event → GAS /exec.
//                               200 only after GAS confirms {stored:true} for every event; else 503
//                               so LINE redelivers (enable redelivery in the LINE console).
//   POST /v1/identity/verify    HMAC-authenticated call from GAS → verifyIdToken(token, checkRevoked)
//   POST /v1/identity/revoke    HMAC-authenticated call from GAS → revokeRefreshTokens(uid)
//   GET  /healthz               liveness (no configuration details)
import crypto from 'node:crypto';
import { requestSigningString, responseSigningString, envelopeSigningString, withinSkew } from '../../src/shared/gateway-protocol.js';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmacB64 = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('base64');

/** Constant-time comparison of two base64 strings (false on length mismatch without early exit on content). */
export function safeEqualB64(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) { crypto.timingSafeEqual(y, y); return false; }
  return crypto.timingSafeEqual(x, y);
}

/** LINE signature: base64(HMAC-SHA256(channelSecret, rawBodyBytes)). */
export function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return safeEqualB64(signature, expected);
}

/** Envelope for one LINE event (the GAS side verifies it with the same signing string). */
export function buildEnvelope({ keyId, secret, nonce, payload, nowMs = Date.now() }) {
  const ts = Math.floor(nowMs / 1000);
  const sig = hmacB64(secret, envelopeSigningString({ kid: keyId, ts, nonce, source: 'LINE', payloadSha256: sha256Hex(Buffer.from(payload, 'utf8')) }));
  return { v: 1, kid: keyId, ts, nonce, source: 'LINE', payload, sig };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
  return body;
}

/** Replay cache for request nonces (per instance; requests also expire after the clock-skew window). */
class NonceCache {
  constructor(ttlMs = 10 * 60 * 1000) { this.ttl = ttlMs; this.m = new Map(); }
  seen(nonce, now = Date.now()) {
    for (const [k, exp] of this.m) { if (exp > now) break; this.m.delete(k); }
    if (this.m.has(nonce)) return true;
    this.m.set(nonce, now + this.ttl);
    return false;
  }
}

/**
 * @param {object} o
 * @param {object} o.config      loadConfig() output
 * @param {object} [o.identity]  { verify(idToken) → {ok, claims}|{ok:false,error}, revoke(uid) }
 * @param {Function} [o.fetchImpl]
 * @param {object} [o.log]       { info(obj), error(obj) }
 * @param {Function} [o.now]
 */
export function createGateway({ config, identity = null, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
  const nonces = new NonceCache();
  const logInfo = (o) => log.info(JSON.stringify({ severity: 'INFO', ...o }));
  const logError = (o) => log.error(JSON.stringify({ severity: 'ERROR', ...o }));

  async function forwardEvent(event) {
    const env = buildEnvelope({ keyId: config.line.keyId, secret: config.line.envelopeSecret, nonce: event.webhookEventId, payload: JSON.stringify(event), nowMs: now() });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.line.forwardTimeoutMs);
    try {
      // Apps Script answers POST /exec with a 302 to the content URL; fetch follows it with GET.
      const r = await fetchImpl(config.line.gasUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env), redirect: 'follow', signal: ac.signal });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { json = null; }
      return !!(r.ok && json && json.ok && json.stored);
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function lineWebhook(req, res, started) {
    if (!config.line) return send(res, 404, { ok: false });
    const raw = await readBody(req, config.maxBodyBytes);
    if (!verifyLineSignature(raw, req.headers['x-line-signature'], config.line.channelSecret)) {
      logInfo({ event: 'line_webhook_rejected', reason: 'signature', ms: now() - started });
      return send(res, 401, { ok: false });
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return send(res, 400, { ok: false }); }
    const events = Array.isArray(body && body.events) ? body.events : null;
    if (!events) return send(res, 400, { ok: false });
    if (!events.length) { logInfo({ event: 'line_webhook_verify', ms: now() - started }); return send(res, 200, { ok: true }); } // console "Verify"
    let stored = 0;
    let skipped = 0;
    for (const e of events) {
      if (!e || typeof e.webhookEventId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(e.webhookEventId)) { skipped++; continue; }
      if (await forwardEvent(e)) stored++;
    }
    const ok = stored + skipped === events.length;
    logInfo({ event: 'line_webhook', events: events.length, stored, skipped, redelivery: !!(events[0] && events[0].deliveryContext && events[0].deliveryContext.isRedelivery), status: ok ? 200 : 503, ms: now() - started });
    return ok ? send(res, 200, { ok: true }) : send(res, 503, { ok: false, retry: true });
  }

  /** HMAC request auth for GAS → gateway calls; returns parsed JSON body and the request nonce. */
  async function authenticate(req, res, path) {
    const raw = await readBody(req, 64 * 1024);
    const kid = req.headers['x-cwk-key-id'];
    const ts = req.headers['x-cwk-timestamp'];
    const nonce = req.headers['x-cwk-nonce'];
    const sig = req.headers['x-cwk-signature'];
    const fail = (why) => { logInfo({ event: 'identity_rejected', reason: why }); send(res, 401, { ok: false, error: 'UNAUTHORIZED' }); return null; };
    if (kid !== config.identity.keyId || !nonce || !/^[0-9a-fA-F-]{16,64}$/.test(String(nonce))) return fail('key/nonce');
    if (!withinSkew(ts, now())) return fail('skew');
    const expected = hmacB64(config.identity.secret, requestSigningString({ method: 'POST', path, ts, nonce, bodySha256: sha256Hex(raw) }));
    if (!safeEqualB64(sig, expected)) return fail('signature');
    if (nonces.seen(String(nonce), now())) return fail('replay');
    try { return { body: JSON.parse(raw.toString('utf8')), nonce: String(nonce) }; } catch (_) { send(res, 400, { ok: false }); return null; }
  }

  function signedSend(res, status, obj, nonce) {
    const body = JSON.stringify(obj);
    const sig = hmacB64(config.identity.secret, responseSigningString({ status, nonce, bodySha256: sha256Hex(Buffer.from(body, 'utf8')) }));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cwk-signature': sig });
    res.end(body);
  }

  async function identityVerify(req, res) {
    if (!config.identity || !identity) return send(res, 404, { ok: false });
    const a = await authenticate(req, res, '/v1/identity/verify');
    if (!a) return undefined;
    const { id_token: token, expected_project: project, expected_tenant: tenant } = a.body || {};
    if (project !== config.identity.projectId || (tenant || null) !== (config.identity.tenantId || null)) return signedSend(res, 403, { ok: false, error: 'PROJECT_MISMATCH' }, a.nonce);
    if (typeof token !== 'string' || token.length < 20 || token.length > 8192) return signedSend(res, 401, { ok: false, error: 'TOKEN_INVALID' }, a.nonce);
    let verdict;
    try { verdict = await identity.verify(token); } catch (_) { logError({ event: 'identity_backend_error' }); return signedSend(res, 503, { ok: false, error: 'BACKEND_UNAVAILABLE' }, a.nonce); }
    if (!verdict.ok) return signedSend(res, 401, { ok: false, error: verdict.error || 'TOKEN_INVALID' }, a.nonce);
    const c = verdict.claims;
    if (c.aud !== config.identity.projectId || c.iss !== `https://securetoken.google.com/${config.identity.projectId}`) return signedSend(res, 401, { ok: false, error: 'TOKEN_INVALID' }, a.nonce);
    return signedSend(res, 200, { ok: true, claims: c, checked_revoked: true }, a.nonce);
  }

  async function identityRevoke(req, res) {
    if (!config.identity || !identity) return send(res, 404, { ok: false });
    const a = await authenticate(req, res, '/v1/identity/revoke');
    if (!a) return undefined;
    const { uid, expected_project: project } = a.body || {};
    if (project !== config.identity.projectId || typeof uid !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(uid)) return signedSend(res, 400, { ok: false, error: 'BAD_REQUEST' }, a.nonce);
    try { await identity.revoke(uid); } catch (_) { logError({ event: 'identity_revoke_error' }); return signedSend(res, 503, { ok: false, error: 'BACKEND_UNAVAILABLE' }, a.nonce); }
    logInfo({ event: 'identity_revoked' });
    return signedSend(res, 200, { ok: true }, a.nonce);
  }

  return async function handle(req, res) {
    const started = now();
    const path = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
      if (req.method !== 'POST') return send(res, 405, { ok: false });
      if (path === '/line/webhook') return await lineWebhook(req, res, started);
      if (path === '/v1/identity/verify') return await identityVerify(req, res);
      if (path === '/v1/identity/revoke') return await identityRevoke(req, res);
      return send(res, 404, { ok: false });
    } catch (e) {
      if (e && e.status === 413) return send(res, 413, { ok: false });
      logError({ event: 'gateway_error', path, message: String(e && e.message ? e.message : e).slice(0, 200) });
      if (!res.headersSent) return send(res, 500, { ok: false });
      return undefined;
    }
  };
}

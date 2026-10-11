// Gateway (gateway/src/app.mjs): LINE signature on raw bytes before parsing, size limit, console
// verification, per-event envelopes accepted by the application-side verifier, 200 only after GAS
// stored every event (else 503 for redelivery); HMAC-authenticated identity endpoints with signed
// responses, skew and replay protection. Firebase is replaced by a test verifier (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createGateway, buildEnvelope, verifyLineSignature } from '../../gateway/src/app.mjs';
import { loadConfig } from '../../gateway/src/config.mjs';
import { requestSigningString, responseSigningString } from '../../src/shared/gateway-protocol.js';
import { verifyEnvelope, intakeLineWebhook } from '../../src/application/webhook/line-webhook.js';
import { nodeCrypto } from '../../src/adapters/node/ports.js';
import { makeHarness } from '../helpers/app-harness.mjs';
import { runSync } from '../../src/application/runtime.js';

const CHANNEL_SECRET = 'line-channel-secret-for-tests';
const ENV_SECRET = 'envelope-secret-for-tests';
const ID_SECRET = 'identity-secret-for-tests';
const silent = { info() {}, error() {} };

const config = loadConfig({
  CWK_GATEWAY_KEY_ID: 'gw-k1', CWK_GATEWAY_SECRET: ID_SECRET, FIREBASE_PROJECT_ID: 'cwk-test-project',
  LINE_CHANNEL_SECRET: CHANNEL_SECRET, CWK_LINE_WEBHOOK_KEY_ID: 'line-k1', CWK_LINE_WEBHOOK_SECRET: ENV_SECRET, GAS_WEBAPP_URL: 'https://script.google.com/macros/s/AKfyTESTDEPLOYMENT/exec',
});

async function withServer(opts, fn) {
  const handler = createGateway({ config, log: silent, ...opts });
  const server = http.createServer((req, res) => { handler(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

const sign = (raw) => crypto.createHmac('sha256', CHANNEL_SECRET).update(raw).digest('base64');
const lineEvent = (id, extra = {}) => ({ type: 'message', webhookEventId: id, timestamp: Date.now(), mode: 'active', source: { type: 'user', userId: 'U0123456789abcdef0123456789abcdef' }, replyToken: 'r', message: { type: 'text', id: 'm', text: 'สวัสดีค่ะ ลูกป่วย' }, deliveryContext: { isRedelivery: false }, ...extra });

function gasStub(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const out = handler(JSON.parse(init.body), init.body);
    return new Response(JSON.stringify(out.body), { status: out.status || 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('LINE: signature checked on raw bytes before parsing; bad signature/oversize rejected; console verify answered', async () => {
  const stub = gasStub(() => ({ body: { ok: true, stored: true } }));
  await withServer({ fetchImpl: stub.fetchImpl }, async (base) => {
    const raw = JSON.stringify({ destination: 'Uxxx', events: [lineEvent('01HXAAAAAAAAAAAAAAAAAAAAAA')] });
    let r = await fetch(`${base}/line/webhook`, { method: 'POST', body: raw, headers: { 'x-line-signature': sign(`${raw} `) } });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/line/webhook`, { method: 'POST', body: raw });
    assert.equal(r.status, 401, 'missing signature');
    assert.equal(stub.calls.length, 0, 'nothing forwarded');
    const big = 'x'.repeat(1024 * 1024 + 10);
    r = await fetch(`${base}/line/webhook`, { method: 'POST', body: big, headers: { 'x-line-signature': sign(big) } }).catch(() => ({ status: 413 }));
    assert.equal(r.status, 413);
    const verify = JSON.stringify({ destination: 'Uxxx', events: [] });
    r = await fetch(`${base}/line/webhook`, { method: 'POST', body: verify, headers: { 'x-line-signature': sign(verify) } });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/line/webhook`)).status, 405);
  });
  assert.equal(verifyLineSignature(Buffer.from('abc'), sign('abc'), CHANNEL_SECRET), true);
  assert.equal(verifyLineSignature(Buffer.from('abc'), 'short', CHANNEL_SECRET), false);
});

test('LINE: one signed envelope per event (nonce = webhookEventId); 200 only when GAS stored all, else 503', async () => {
  let failSecond = true;
  const stub = gasStub((env) => {
    const v = verifyEnvelope(JSON.stringify(env), { keyId: 'line-k1', secret: ENV_SECRET, crypto: nodeCrypto, nowMs: Date.now() });
    if (failSecond && v.nonce.endsWith('B')) return { status: 500, body: { ok: false } };
    return { body: { ok: true, stored: true } };
  });
  await withServer({ fetchImpl: stub.fetchImpl }, async (base) => {
    const raw = JSON.stringify({ destination: 'Uxxx', events: [lineEvent('01HXAAAAAAAAAAAAAAAAAAAAAA'), lineEvent('01HXBBBBBBBBBBBBBBBBBBBBBB')] });
    let r = await fetch(`${base}/line/webhook`, { method: 'POST', body: raw, headers: { 'x-line-signature': sign(raw) } });
    assert.equal(r.status, 503, 'GAS failed for one event → LINE should redeliver');
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].url, config.line.gasUrl);
    assert.equal(stub.calls[0].body.nonce, '01HXAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(JSON.parse(stub.calls[0].body.payload).message.text, 'สวัสดีค่ะ ลูกป่วย', 'payload is the original event (Thai text intact)');
    failSecond = false;
    r = await fetch(`${base}/line/webhook`, { method: 'POST', body: raw, headers: { 'x-line-signature': sign(raw) } });
    assert.equal(r.status, 200);
  });
});

test('gateway → application intake end to end: the envelope verifies, the event is stored once, redelivery deduped', async () => {
  const h = makeHarness({ secrets: { CWK_LINE_WEBHOOK_SECRET: ENV_SECRET }, config: { lineEnabled: true, lineWebhookKeyId: 'line-k1' } });
  h.bootstrap();
  h.clock.set(new Date().toISOString());
  const stub = gasStub((env, rawBody) => ({ body: runSync(intakeLineWebhook, h.deps, rawBody) }));
  await withServer({ fetchImpl: stub.fetchImpl }, async (base) => {
    const raw = JSON.stringify({ destination: 'Uxxx', events: [lineEvent('01HXCCCCCCCCCCCCCCCCCCCCCC', { type: 'follow' })] });
    assert.equal((await fetch(`${base}/line/webhook`, { method: 'POST', body: raw, headers: { 'x-line-signature': sign(raw) } })).status, 200);
    assert.equal((await fetch(`${base}/line/webhook`, { method: 'POST', body: raw, headers: { 'x-line-signature': sign(raw) } })).status, 200);
  });
  assert.equal(h.store.findBy('WebhookInbox', 'webhook_event_id', '01HXCCCCCCCCCCCCCCCCCCCCCC').length, 1);
  // an envelope built for another key id is refused by the application side
  const bad = buildEnvelope({ keyId: 'other', secret: ENV_SECRET, nonce: '01HXDDDDDDDDDDDDDDDDDDDDDD', payload: JSON.stringify(lineEvent('01HXDDDDDDDDDDDDDDDDDDDDDD')) });
  assert.throws(() => runSync(intakeLineWebhook, h.deps, JSON.stringify(bad)), (e) => e.code === 'UNAUTHENTICATED');
});

function signedRequest(path, body, { ts = Math.floor(Date.now() / 1000), nonce = crypto.randomUUID(), secret = ID_SECRET, kid = 'gw-k1' } = {}) {
  const payload = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(requestSigningString({ method: 'POST', path, ts, nonce, bodySha256: nodeCrypto.sha256Hex(payload) })).digest('base64');
  return { nonce, init: { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'x-cwk-key-id': kid, 'x-cwk-timestamp': String(ts), 'x-cwk-nonce': nonce, 'x-cwk-signature': sig } } };
}

async function checkResponseSignature(r, nonce) {
  const text = await r.text();
  const expected = crypto.createHmac('sha256', ID_SECRET).update(responseSigningString({ status: r.status, nonce, bodySha256: nodeCrypto.sha256Hex(text) })).digest('base64');
  assert.equal(r.headers.get('x-cwk-signature'), expected, 'response is signed for this request nonce');
  return JSON.parse(text);
}

test('identity verify: HMAC auth, skew, replay; verdicts are signed; project mismatch refused', async () => {
  const seen = [];
  const identity = {
    async verify(token) {
      seen.push(token.length);
      if (token.startsWith('revoked')) return { ok: false, error: 'TOKEN_REVOKED' };
      const now = Math.floor(Date.now() / 1000);
      return { ok: true, claims: { aud: 'cwk-test-project', iss: 'https://securetoken.google.com/cwk-test-project', sub: 'uid-1', exp: now + 3000, iat: now, email: 'teacher@example.com', email_verified: true, sign_in_provider: 'password', tenant: null, mfa: false } };
    },
    async revoke() { return true; },
  };
  await withServer({ identity }, async (base) => {
    const body = { id_token: 'x'.repeat(40), expected_project: 'cwk-test-project', expected_tenant: null };
    let q = signedRequest('/v1/identity/verify', body);
    let r = await fetch(`${base}/v1/identity/verify`, q.init);
    assert.equal(r.status, 200);
    const ok = await checkResponseSignature(r, q.nonce);
    assert.deepEqual([ok.ok, ok.checked_revoked, ok.claims.sub], [true, true, 'uid-1']);
    // replaying the exact request is refused
    r = await fetch(`${base}/v1/identity/verify`, q.init);
    assert.equal(r.status, 401);
    // wrong secret / old timestamp / unknown key id
    for (const opt of [{ secret: 'nope' }, { ts: Math.floor(Date.now() / 1000) - 600 }, { kid: 'gw-k2' }]) {
      q = signedRequest('/v1/identity/verify', body, opt);
      assert.equal((await fetch(`${base}/v1/identity/verify`, q.init)).status, 401);
    }
    // signature covers the path: a verify signature cannot be used on /revoke
    q = signedRequest('/v1/identity/verify', { uid: 'uid-1', expected_project: 'cwk-test-project' });
    assert.equal((await fetch(`${base}/v1/identity/revoke`, q.init)).status, 401);
    q = signedRequest('/v1/identity/verify', { ...body, id_token: `revoked${'x'.repeat(40)}` });
    r = await fetch(`${base}/v1/identity/verify`, q.init);
    assert.equal(r.status, 401);
    assert.equal((await checkResponseSignature(r, q.nonce)).error, 'TOKEN_REVOKED');
    q = signedRequest('/v1/identity/verify', { ...body, expected_project: 'other-project' });
    r = await fetch(`${base}/v1/identity/verify`, q.init);
    assert.equal(r.status, 403);
    q = signedRequest('/v1/identity/revoke', { uid: 'uid-1', expected_project: 'cwk-test-project' });
    r = await fetch(`${base}/v1/identity/revoke`, q.init);
    assert.equal(r.status, 200);
    assert.equal((await checkResponseSignature(r, q.nonce)).ok, true);
  });
  assert.ok(seen.length >= 2);
});

test('config: GAS target must be an Apps Script /exec URL; features stay off unless fully configured', () => {
  assert.throws(() => loadConfig({ LINE_CHANNEL_SECRET: 'a', CWK_LINE_WEBHOOK_KEY_ID: 'k', CWK_LINE_WEBHOOK_SECRET: 's', GAS_WEBAPP_URL: 'https://evil.example.com/exec' }), /Apps Script/);
  const c = loadConfig({ LINE_CHANNEL_SECRET: 'a' });
  assert.equal(c.line, null);
  assert.equal(c.identity, null);
});

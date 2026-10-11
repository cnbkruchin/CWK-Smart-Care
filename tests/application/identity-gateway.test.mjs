// Identity on Apps Script (MASTER_PROMPT §18 "Identity", DECISIONS D-003): the GatewayIdentityVerifier that GAS
// uses, talking to the REAL gateway request handler in a separate process (Firebase replaced by a token map).
// Expired, revoked, disabled, wrong-project and wrong-tenant tokens are refused; claims are re-checked locally
// (defence in depth); a forged or unsigned gateway answer is never trusted; verdicts are cached ≤ 300 s by the
// SHA-256 of the token. Unlinked identities and the deployment owner are covered in foundation/gas tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GatewayIdentityVerifier } from '../../src/adapters/gas/identity-gateway.js';
import { nodeCrypto, nodeIds, MemoryCache } from '../../src/adapters/node/ports.js';
import { responseSigningString } from '../../src/shared/gateway-protocol.js';
import { syncFetch } from '../helpers/sync-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'gas-test-1';
const SECRET = crypto.randomBytes(32).toString('base64');
const PROJECT = 'cwk-test-project';
let child;
let base;
const calls = [];

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'tests/helpers/gateway-server.mjs')], { env: { ...process.env, TEST_GW_KEY_ID: KEY, TEST_GW_SECRET: SECRET, TEST_GW_PROJECT: PROJECT }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /"port":(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on('exit', (c) => reject(new Error(`gateway exited ${c}`)));
  });
  base = `http://127.0.0.1:${port}`;
  globalThis.UrlFetchApp = {
    fetch: (url, params) => {
      calls.push(url);
      const r = syncFetch(url, params);
      return { getResponseCode: () => r.status, getContentText: () => r.body, getAllHeaders: () => r.headers };
    },
  };
});

after(async () => {
  delete globalThis.UrlFetchApp;
  if (child) await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
});

const verifier = (o = {}) => new GatewayIdentityVerifier({ gatewayUrl: base, keyId: KEY, secret: SECRET, projectId: PROJECT, crypto: nodeCrypto, cache: new MemoryCache(), ids: nodeIds, clock: null, ...o });
const token = (kind, sub = 'uid-1') => `${kind}.${sub}.${'x'.repeat(30)}`;
const refused = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

test('valid token → claims from the provider; the verdict is cached by token hash (no second gateway call)', () => {
  const v = verifier();
  const n = calls.length;
  const c = v.verifyCredential(token('valid', 'teacher-1'));
  assert.deepEqual([c.provider, c.subject, c.issuer, c.email_verified], ['firebase', 'teacher-1', `https://securetoken.google.com/${PROJECT}`, true]);
  v.verifyCredential(token('valid', 'teacher-1'));
  assert.equal(calls.length - n, 1, 'second check served from cache');
  v.forget(c);
  v.verifyCredential(token('valid', 'teacher-1'));
  assert.equal(calls.length - n, 2, 'logout drops the cached verdict');
});

test('expired, revoked, disabled, malformed and other-project tokens are refused (UNAUTHENTICATED)', () => {
  const v = verifier();
  refused(() => v.verifyCredential(token('expired')), 'UNAUTHENTICATED');
  refused(() => v.verifyCredential(token('revoked')), 'UNAUTHENTICATED');
  refused(() => v.verifyCredential(token('disabled')), 'UNAUTHENTICATED');
  refused(() => v.verifyCredential(token('garbage')), 'UNAUTHENTICATED');
  refused(() => v.verifyCredential(token('otherproject')), 'UNAUTHENTICATED');
  refused(() => v.verifyCredential('short'), 'UNAUTHENTICATED');
  refused(() => v.verifyCredential(null), 'UNAUTHENTICATED');
});

test('claims are re-checked in Apps Script: past exp and a tenant other than the configured one are refused', () => {
  refused(() => verifier().verifyCredential(token('stale')), 'UNAUTHENTICATED');
  refused(() => verifier({ tenantId: 'tenant-a' }).verifyCredential(token('tenant')), 'UNAUTHENTICATED');
  refused(() => verifier({ projectId: 'another-project' }).verifyCredential(token('valid')), 'UNAUTHENTICATED');
});

test('a wrong shared secret is refused by the gateway; a forged or unsigned answer is never trusted', () => {
  // GAS with a different secret: the gateway refuses the request and its answer does not verify for this caller
  refused(() => verifier({ secret: crypto.randomBytes(32).toString('base64') }).verifyCredential(token('valid')), 'EXTERNAL_SERVICE_ERROR');
  const real = globalThis.UrlFetchApp;
  const forged = (body, sign) => ({
    fetch: (url, params) => {
      const text = JSON.stringify(body);
      const sig = sign ? nodeCrypto.hmacSha256Base64(SECRET, responseSigningString({ status: 200, nonce: params.headers['X-CWK-Nonce'], bodySha256: nodeCrypto.sha256Hex(text) })) : 'AAAA';
      return { getResponseCode: () => 200, getContentText: () => text, getAllHeaders: () => ({ 'X-CWK-Signature': sig }) };
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const good = { ok: true, checked_revoked: true, claims: { aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'attacker', exp: now + 3000 } };
  try {
    globalThis.UrlFetchApp = forged(good, false);
    refused(() => verifier().verifyCredential(token('valid')), 'EXTERNAL_SERVICE_ERROR');
    globalThis.UrlFetchApp = forged({ ...good, checked_revoked: false }, true);
    refused(() => verifier().verifyCredential(token('valid')), 'EXTERNAL_SERVICE_ERROR');
    globalThis.UrlFetchApp = { fetch: () => { throw new Error('DNS error'); } };
    refused(() => verifier().verifyCredential(token('valid')), 'EXTERNAL_SERVICE_ERROR');
  } finally { globalThis.UrlFetchApp = real; }
});

#!/usr/bin/env node
// Test helper (not shipped): the REAL gateway request handler (gateway/src/app.mjs) in its own process, with
// Firebase replaced by a token map, so the Apps Script GatewayIdentityVerifier can call it synchronously
// (UrlFetchApp is synchronous). TEST_GW_KEY_ID, TEST_GW_SECRET, TEST_GW_PROJECT → prints {"port": n}.
import http from 'node:http';
import { createGateway } from '../../gateway/src/app.mjs';

const e = process.env;
const project = e.TEST_GW_PROJECT;
const claims = (sub, extra = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { aud: project, iss: `https://securetoken.google.com/${project}`, sub, exp: now + 3000, iat: now, email: `${sub}@example.com`, email_verified: true, sign_in_provider: 'password', tenant: null, mfa: false, ...extra };
};
// token prefix → what Firebase verifyIdToken(token, checkRevoked=true) would answer
const identity = {
  async verify(token) {
    const [kind, sub] = token.split('.');
    if (kind === 'valid') return { ok: true, claims: claims(sub) };
    if (kind === 'tenant') return { ok: true, claims: claims(sub, { tenant: 'tenant-b' }) };
    if (kind === 'stale') return { ok: true, claims: claims(sub, { exp: Math.floor(Date.now() / 1000) - 5 }) };
    if (kind === 'otherproject') return { ok: true, claims: claims(sub, { aud: 'someone-elses-project', iss: 'https://securetoken.google.com/someone-elses-project' }) };
    if (kind === 'expired') return { ok: false, error: 'TOKEN_EXPIRED' };
    if (kind === 'disabled') return { ok: false, error: 'USER_DISABLED' };
    if (kind === 'revoked') return { ok: false, error: 'TOKEN_REVOKED' };
    return { ok: false, error: 'TOKEN_INVALID' };
  },
  async revoke() { return true; },
};
const config = { port: 0, maxBodyBytes: 1024 * 1024, identity: { keyId: e.TEST_GW_KEY_ID, secret: e.TEST_GW_SECRET, projectId: project, tenantId: null }, line: null };
const handler = createGateway({ config, identity, log: { info() {}, error() {} } });
const server = http.createServer((req, res) => { handler(req, res); });
server.listen(0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

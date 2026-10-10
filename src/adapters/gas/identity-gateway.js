// IdentityVerifier for Apps Script: delegates Firebase ID token verification to the gateway
// (Firebase Admin SDK verifyIdToken(token, checkRevoked=true)) over an HMAC-authenticated
// server-to-server call, then re-checks aud/iss/exp/sub/tenant locally (DECISIONS D-003).
// Tokens are never logged; the cache key is SHA-256(token) and the cached value is the verdict only.

import { AppError } from '../../shared/errors.js';
import { requestSigningString, responseSigningString } from '../../shared/gateway-protocol.js';
import { timingSafeEqualStr } from '../../shared/hash.js';

const G = () => globalThis;
const CACHE_MAX_SECONDS = 300;

export class GatewayIdentityVerifier {
  constructor({ gatewayUrl, keyId, secret, projectId, tenantId = null, crypto, cache, ids, clock }) {
    if (!gatewayUrl || !keyId || !secret || !projectId) throw new AppError('CONFIGURATION_REQUIRED', 'identity gateway not configured', { messageTh: 'ยังไม่ได้ตั้งค่าบริการยืนยันตัวตน' });
    Object.assign(this, { gatewayUrl: gatewayUrl.replace(/\/$/, ''), keyId, secret, projectId, tenantId, crypto, cache, ids, clock });
  }

  _call(path, body) {
    const payload = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const nonce = this.ids.uuid();
    const bodySha256 = this.crypto.sha256Hex(payload);
    const signature = this.crypto.hmacSha256Base64(this.secret, requestSigningString({ method: 'POST', path, ts, nonce, bodySha256 }));
    let res;
    try {
      res = G().UrlFetchApp.fetch(this.gatewayUrl + path, {
        method: 'post', contentType: 'application/json', payload, muteHttpExceptions: true, followRedirects: false,
        headers: { 'X-CWK-Key-Id': this.keyId, 'X-CWK-Timestamp': String(ts), 'X-CWK-Nonce': nonce, 'X-CWK-Signature': signature },
      });
    } catch (e) {
      throw new AppError('EXTERNAL_SERVICE_ERROR', 'identity gateway unreachable', { messageTh: 'บริการยืนยันตัวตนไม่ตอบสนอง กรุณาลองใหม่' });
    }
    const status = res.getResponseCode();
    const text = res.getContentText();
    const headers = lowerKeys(res.getAllHeaders ? res.getAllHeaders() : res.getHeaders());
    const expected = this.crypto.hmacSha256Base64(this.secret, responseSigningString({ status, nonce, bodySha256: this.crypto.sha256Hex(text) }));
    if (!headers['x-cwk-signature'] || !timingSafeEqualStr(String(headers['x-cwk-signature']), expected)) {
      throw new AppError('EXTERNAL_SERVICE_ERROR', 'gateway response signature invalid', { retryable: false, messageTh: 'ไม่สามารถยืนยันคำตอบจากบริการยืนยันตัวตน' });
    }
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new AppError('EXTERNAL_SERVICE_ERROR', 'gateway returned non-JSON'); }
    return { status, json };
  }

  verifyCredential(token) {
    if (!token || typeof token !== 'string' || token.length < 20) throw new AppError('UNAUTHENTICATED', 'missing token');
    const key = `idv:${this.crypto.sha256Hex(token)}`;
    const hit = this.cache && this.cache.get(key);
    if (hit) {
      const c = JSON.parse(hit);
      if (c.exp * 1000 > Date.now()) return c;
    }
    const { status, json } = this._call('/v1/identity/verify', { id_token: token, expected_project: this.projectId, expected_tenant: this.tenantId });
    if (status === 401 || status === 403) throw new AppError('UNAUTHENTICATED', `token rejected: ${json && json.error}`);
    if (status !== 200 || !json || !json.ok || !json.claims) throw new AppError('EXTERNAL_SERVICE_ERROR', `gateway status ${status}`);
    const c = json.claims;
    const nowS = Date.now() / 1000;
    if (c.aud !== this.projectId) throw new AppError('UNAUTHENTICATED', 'wrong audience/project');
    if (c.iss !== `https://securetoken.google.com/${this.projectId}`) throw new AppError('UNAUTHENTICATED', 'wrong issuer');
    if (!c.sub || typeof c.sub !== 'string') throw new AppError('UNAUTHENTICATED', 'missing subject');
    if (!(c.exp > nowS)) throw new AppError('UNAUTHENTICATED', 'expired');
    if (this.tenantId && c.tenant !== this.tenantId) throw new AppError('UNAUTHENTICATED', 'wrong tenant');
    if (!json.checked_revoked) throw new AppError('EXTERNAL_SERVICE_ERROR', 'gateway did not check revocation', { retryable: false });
    const claims = {
      provider: 'firebase', issuer: c.iss, subject: c.sub, email: c.email || null, email_verified: !!c.email_verified, exp: c.exp, auth_time: c.auth_time || null,
      sign_in_provider: c.sign_in_provider || null, tenant: c.tenant || null, mfa: !!c.mfa,
    };
    if (this.cache) {
      const ttl = Math.max(1, Math.min(CACHE_MAX_SECONDS, Math.floor(c.exp - nowS)));
      this.cache.put(key, JSON.stringify(claims), ttl);
      const subKey = `idv-sub:${claims.subject}`;
      let list = [];
      try { list = JSON.parse(this.cache.get(subKey) || '[]'); } catch (_) { list = []; }
      this.cache.put(subKey, JSON.stringify([...list.filter((x) => x !== key), key].slice(-10)), CACHE_MAX_SECONDS);
    }
    return claims;
  }

  /** Logout / revocation: drop cached verdicts for this subject (Firebase token itself expires per exp). */
  forget(claims) {
    if (!this.cache || !claims) return true;
    const subKey = `idv-sub:${claims.subject}`;
    let list = [];
    try { list = JSON.parse(this.cache.get(subKey) || '[]'); } catch (_) { list = []; }
    for (const k of list) this.cache.remove(k);
    this.cache.remove(subKey);
    return true;
  }

  /** Revoke refresh tokens at the provider (account takeover response). */
  revokeSessions(link) {
    const { status, json } = this._call('/v1/identity/revoke', { uid: link.subject, expected_project: this.projectId });
    this.forget({ subject: link.subject });
    if (status !== 200 || !json.ok) throw new AppError('EXTERNAL_SERVICE_ERROR', 'revoke failed');
    return true;
  }
}

function lowerKeys(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

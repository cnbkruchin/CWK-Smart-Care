// HttpApiAdapter — upgrade path step 2 (MASTER_PROMPT §2.3, §16): the Apps Script web app keeps serving the
// UI (google.script.run) but every operation is executed by the REST backend that owns the data (single
// writer). Apps Script only forwards the RPC envelope over UrlFetchApp:
//   - the user's own credential (Firebase ID token, or DEMO credential outside PROD) travels in
//     Authorization: Bearer and is verified by the backend itself — nothing from this script (user id,
//     roles, e-mail) is sent or trusted as identity;
//   - the envelope (operation, payload, idempotency_key, expected_version, request_id) is forwarded unchanged,
//     so idempotent retries, optimistic concurrency and error codes behave exactly as on the backend;
//   - network failures and unreadable answers become STORAGE_UNAVAILABLE (retryable): the client retries with
//     the SAME idempotency key, so a request that did reach the backend is never applied twice.
// Nothing is logged except the operation, HTTP status and duration (no payloads, no tokens).
import { AppError, toErrorEnvelope } from '../../shared/errors.js';

const G = () => globalThis;

export class HttpApiAdapter {
  /**
   * @param {{baseUrl: string, env: string, fetch?: (url: string, params: object) => object, logger?: object}} o
   *   fetch defaults to UrlFetchApp.fetch (synchronous on Apps Script)
   */
  constructor({ baseUrl, env, fetch = null, logger = null }) {
    if (!baseUrl) throw new AppError('CONFIGURATION_REQUIRED', 'CWK_REST_BASE_URL is not set', { messageTh: 'ยังไม่ได้ตั้งค่า CWK_REST_BASE_URL ของระบบหลัก (REST)' });
    const https = /^https:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(baseUrl);
    const devHttp = env === 'DEV' && /^http:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(baseUrl);
    if (!https && !devHttp) throw new AppError('CONFIGURATION_REQUIRED', 'CWK_REST_BASE_URL must be https://', { messageTh: 'CWK_REST_BASE_URL ต้องเป็น https://' });
    this.url = `${baseUrl.replace(/\/$/, '')}/v1/rpc`;
    this.fetch = fetch || ((url, params) => G().UrlFetchApp.fetch(url, params));
    this.logger = logger;
  }

  _unavailable(requestId, why) {
    if (this.logger) this.logger.error({ event: 'rest_backend_unavailable', reason: why });
    return toErrorEnvelope(new AppError('STORAGE_UNAVAILABLE', why, { messageTh: 'เชื่อมต่อระบบหลักไม่ได้ ระบบยังไม่ยืนยันการบันทึก กรุณาลองใหม่ (การลองใหม่จะไม่บันทึกซ้ำ)' }), requestId);
  }

  /**
   * Forward one envelope (JSON string from google.script.run.rpc) and return the backend's response envelope.
   * @param {string} envelopeJson
   * @returns {object} response envelope
   */
  rpc(envelopeJson) {
    let env;
    try { env = JSON.parse(envelopeJson); } catch (_) { return toErrorEnvelope(new AppError('VALIDATION_ERROR', 'envelope is not JSON'), null); }
    if (!env || typeof env !== 'object' || Array.isArray(env)) return toErrorEnvelope(new AppError('VALIDATION_ERROR', 'envelope must be an object'), null);
    const requestId = typeof env.request_id === 'string' ? env.request_id : null;
    const { credential, ...body } = env;
    const headers = requestId ? { 'X-Request-Id': requestId } : {};
    if (typeof credential === 'string' && credential) headers.Authorization = `Bearer ${credential}`;
    const started = Date.now();
    let res;
    try {
      res = this.fetch(this.url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ ...body, credential: null }), headers, muteHttpExceptions: true, followRedirects: false });
    } catch (e) {
      return this._unavailable(requestId, 'fetch failed');
    }
    const status = res.getResponseCode();
    let out = null;
    try { out = JSON.parse(res.getContentText()); } catch (_) { out = null; }
    if (this.logger) this.logger.info({ event: 'rest_rpc', operation: typeof env.operation === 'string' ? env.operation.slice(0, 80) : null, status, ms: Date.now() - started });
    if (!out || typeof out.ok !== 'boolean') return this._unavailable(requestId, `unexpected response HTTP ${status}`);
    return out;
  }
}

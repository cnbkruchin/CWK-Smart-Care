// HTTP layer of the reference REST backend (MASTER_PROMPT §16). Pure node:http, no framework. Every
// operation goes through the SAME dispatcher as Apps Script (allowlist, auth, rate limit, schema,
// idempotency, authorization in the handler) — this file only adapts HTTP to the RPC envelope.
//
//   POST /v1/rpc                 envelope (openapi.yaml#/components/schemas/Envelope); the credential travels in
//                                Authorization: Bearer (GAS HttpApiAdapter forwards the user's own token)
//   POST /v1/ops/{operation}     body = payload; headers Idempotency-Key, If-Match (expected_version), X-Request-Id
//   POST /v1/webhook/line        signed gateway envelope (same protocol as GAS doPost); only when LINE is enabled
//   GET  /healthz                liveness (no configuration details)
//   GET  /readyz                 database reachable + schema version matches the code
//   GET  /, /*.js, /*.css        web starter (future-platform/web) when API_SERVE_WEB=true
//
// Logs carry method, route, status, duration and request id — never bodies, tokens or payloads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dispatch, API_VERSION, MAX_ENVELOPE_CHARS } from '../../../src/application/dispatcher.js';
import { runAsync } from '../../../src/application/runtime.js';
import { intakeLineWebhook, MAX_ENVELOPE_BYTES } from '../../../src/application/webhook/line-webhook.js';
import { AppError, toErrorEnvelope } from '../../../src/shared/errors.js';
import { refreshMode } from './deps.mjs';

/** HTTP status for each error code; the body is always the JSON envelope. */
export const HTTP_STATUS = Object.freeze({
  VALIDATION_ERROR: 400, UNSUPPORTED_SCHEMA: 400, UNAUTHENTICATED: 401, ACCOUNT_NOT_LINKED: 403, ACCOUNT_DISABLED: 403, FORBIDDEN: 403,
  NOT_FOUND: 404, UNSUPPORTED_OPERATION: 404, CONFLICT: 409, UNIQUE_VIOLATION: 409, INVALID_STATE: 409, DUPLICATE_REQUEST_MISMATCH: 409,
  PAYLOAD_TOO_LARGE: 413, INTEGRITY_ERROR: 422, RATE_LIMITED: 429, QUOTA_EXCEEDED: 429, FEATURE_DISABLED: 501, EXTERNAL_SERVICE_ERROR: 502,
  MAINTENANCE_MODE: 503, STORAGE_UNAVAILABLE: 503, LOCK_TIMEOUT: 503, CONFIGURATION_REQUIRED: 503, INTERNAL_ERROR: 500,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION = /^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/;
const ALLOW_HEADERS = 'authorization, content-type, idempotency-key, if-match, x-request-id, x-device-id';
const API_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const WEB_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { reject(new HttpError(413, 'PAYLOAD_TOO_LARGE')); req.resume(); return; }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; reject(new HttpError(413, 'PAYLOAD_TOO_LARGE')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeJsonText(buf) {
  try { return utf8.decode(buf); } catch (_) { throw new HttpError(400, 'VALIDATION_ERROR', 'body is not valid UTF-8'); }
}

function isJson(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return /^application\/json\s*(;\s*charset=utf-8\s*)?$/.test(ct);
}

/** Static files of the web starter: an allowlist built once at start-up (no path from the request reaches fs). */
export function loadWebFiles(dir) {
  const files = new Map();
  if (!dir || !fs.existsSync(dir)) return files;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && MIME[path.extname(e.name)]) files.set(`/${r}`, { body: fs.readFileSync(path.join(dir, r)), type: MIME[path.extname(e.name)] });
    }
  };
  walk('');
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}

/**
 * @param {object} o
 * @param {object} o.config  loadConfig() output
 * @param {object} o.deps    buildDeps() output
 * @param {Map} [o.webFiles] loadWebFiles() output
 */
export function createApp({ config, deps, webFiles = new Map() }) {
  const log = deps.logger;
  const allowed = new Set(config.allowedOrigins);
  const modeCache = { at: 0 };

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin) return { ok: true, headers: {} };
    const host = req.headers.host;
    // same origin (the web starter served by this backend) needs no CORS headers
    if (host && (origin === `http://${host}` || origin === `https://${host}`)) return { ok: true, headers: {} };
    if (!allowed.has(origin)) return { ok: false, headers: { vary: 'Origin' } };
    return { ok: true, headers: { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'x-request-id, retry-after' } };
  }

  function send(res, status, obj, headers = {}) {
    const body = JSON.stringify(obj);
    const extra = config.env === 'PROD' ? { 'strict-transport-security': 'max-age=31536000' } : {};
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...API_HEADERS, ...extra, ...headers });
    res.end(body);
    return status;
  }

  function sendEnvelope(res, out, headers) {
    const status = out.ok ? 200 : (HTTP_STATUS[out.error.code] || 500);
    const h = { ...headers };
    if (out.meta && out.meta.request_id) h['x-request-id'] = out.meta.request_id;
    if (!out.ok && out.error.details && out.error.details.retry_after_seconds) h['retry-after'] = String(out.error.details.retry_after_seconds);
    else if (!out.ok && out.error.code === 'MAINTENANCE_MODE') h['retry-after'] = '300';
    return send(res, status, out, h);
  }

  function bearer(req) {
    const a = req.headers.authorization;
    if (!a) return null;
    const m = /^Bearer ([^\s]{1,8192})$/.exec(a);
    if (!m) throw new HttpError(401, 'UNAUTHENTICATED', 'malformed Authorization header');
    return m[1];
  }

  async function readJson(req) {
    if (!isJson(req)) throw new HttpError(415, 'VALIDATION_ERROR', 'content-type must be application/json');
    const text = decodeJsonText(await readBody(req, config.maxBodyBytes));
    if (text.length > MAX_ENVELOPE_CHARS) throw new HttpError(413, 'PAYLOAD_TOO_LARGE');
    try { return JSON.parse(text); } catch (_) { throw new HttpError(400, 'VALIDATION_ERROR', 'body is not JSON'); }
  }

  async function runEnvelope(env) {
    await refreshMode(deps, modeCache);
    return runAsync(dispatch, deps, env, { channel: 'API' });
  }

  async function rpc(req) {
    const env = await readJson(req);
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new HttpError(400, 'VALIDATION_ERROR', 'envelope must be an object');
    const token = bearer(req);
    if (token) {
      if (env.credential) throw new HttpError(400, 'VALIDATION_ERROR', 'send the credential either in Authorization or in the envelope, not both');
      env.credential = token;
    }
    return runEnvelope(env);
  }

  async function opCall(req, operation) {
    if (!OPERATION.test(operation) || operation.length > 80) throw new HttpError(404, 'UNSUPPORTED_OPERATION');
    const payload = await readJson(req);
    const rid = req.headers['x-request-id'];
    const idem = req.headers['idempotency-key'];
    const ifMatch = req.headers['if-match'];
    if (rid !== undefined && !UUID.test(rid)) throw new HttpError(400, 'VALIDATION_ERROR', 'X-Request-Id must be a UUID');
    if (idem !== undefined && !UUID.test(idem)) throw new HttpError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be a UUID');
    let expected = null;
    if (ifMatch !== undefined) {
      const m = /^"?([1-9][0-9]{0,9})"?$/.exec(String(ifMatch).trim());
      if (!m) throw new HttpError(400, 'VALIDATION_ERROR', 'If-Match must be the expected version number');
      expected = Number(m[1]);
    }
    const device = req.headers['x-device-id'];
    return runEnvelope({
      api_version: API_VERSION, request_id: rid || crypto.randomUUID(), operation, payload, credential: bearer(req),
      idempotency_key: idem || null, expected_version: expected, client: device && UUID.test(device) ? { device_id: device } : null,
    });
  }

  async function lineWebhook(req, res) {
    const keyConfigured = !!(deps.config.lineWebhookKeyId && deps.config.secret('CWK_LINE_WEBHOOK_SECRET'));
    if (!deps.config.lineEnabled || !keyConfigured) return send(res, 404, { ok: false, error: 'WEBHOOK_DISABLED', stored: false });
    if (!isJson(req)) return send(res, 415, { ok: false, error: 'VALIDATION_ERROR', stored: false });
    const raw = decodeJsonText(await readBody(req, MAX_ENVELOPE_BYTES));
    try {
      return send(res, 200, await runAsync(intakeLineWebhook, deps, raw));
    } catch (e) {
      const code = e && e.code ? e.code : 'INTERNAL_ERROR';
      if (!e || !e.code) log.error({ event: 'webhook_error', message: String(e && e.message).slice(0, 200) });
      return send(res, HTTP_STATUS[code] || 500, { ok: false, error: code, stored: false });
    }
  }

  async function readyz(res) {
    try {
      const r = await deps.store.ready();
      return send(res, r.ok ? 200 : 503, { ok: r.ok, schema_version: r.schema_version, api_version: API_VERSION });
    } catch (_) {
      return send(res, 503, { ok: false, error: 'DATABASE_UNAVAILABLE' });
    }
  }

  function staticFile(res, p) {
    const f = webFiles.get(p);
    if (!f) return send(res, 404, { ok: false, error: 'NOT_FOUND' });
    res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-cache', 'content-security-policy': WEB_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
    res.end(f.body);
    return 200;
  }

  return async function handle(req, res) {
    const started = Date.now();
    const p = (req.url || '/').split('?')[0];
    let status = 500;
    let route = p.startsWith('/v1/ops/') ? '/v1/ops/{operation}' : p;
    let requestId = null;
    const cors = corsHeaders(req);
    try {
      if (req.method === 'OPTIONS') {
        if (!cors.ok || !cors.headers['access-control-allow-origin']) { status = send(res, 403, { ok: false, error: 'ORIGIN_NOT_ALLOWED' }, cors.headers); return; }
        res.writeHead(204, { ...cors.headers, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': ALLOW_HEADERS, 'access-control-max-age': '600' });
        res.end();
        status = 204;
        return;
      }
      if (!cors.ok) { status = send(res, 403, toErrorEnvelope(new AppError('FORBIDDEN', 'origin not allowed'), null), cors.headers); return; }
      if (req.method === 'GET') {
        if (p === '/healthz') { status = send(res, 200, { ok: true }); return; }
        if (p === '/readyz') { status = await readyz(res); return; }
        if (config.serveWeb) { route = 'static'; status = staticFile(res, p); return; }
        status = send(res, 404, { ok: false, error: 'NOT_FOUND' });
        return;
      }
      if (req.method !== 'POST') { status = send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { allow: 'GET, POST, OPTIONS' }); return; }
      if (p === '/v1/webhook/line') { status = await lineWebhook(req, res); return; }
      let out;
      if (p === '/v1/rpc') out = await rpc(req);
      else if (p.startsWith('/v1/ops/')) {
        const operation = p.slice('/v1/ops/'.length);
        route = `/v1/ops/${OPERATION.test(operation) ? operation : '?'}`;
        out = await opCall(req, operation);
      } else { status = send(res, 404, { ok: false, error: 'NOT_FOUND' }, cors.headers); return; }
      requestId = out.meta && out.meta.request_id;
      status = sendEnvelope(res, out, cors.headers);
    } catch (e) {
      if (e instanceof HttpError) {
        const env = toErrorEnvelope(new AppError(e.code, e.message), null);
        status = send(res, e.status, env, cors.headers);
      } else {
        log.error({ event: 'http_error', route, message: String(e && e.message ? e.message : e).slice(0, 200) });
        if (!res.headersSent) status = send(res, 500, toErrorEnvelope(e, null), cors.headers);
      }
    } finally {
      if (route !== '/healthz' && route !== 'static') log.info({ event: 'http', method: req.method, route, status, ms: Date.now() - started, request_id: requestId });
    }
  };
}

// Public RPC dispatcher: the ONLY entry for client calls on every transport (GAS google.script.run,
// REST /v1/rpc). Operations come from an explicit allowlist (registry); no dynamic function
// lookup, no eval. Middleware order follows ARCHITECTURE.md §3.1.

import { AppError, toErrorEnvelope, isAppError } from '../shared/errors.js';
import { validateValue, normalizeInput } from '../shared/validate.js';
import { canonicalStringify } from '../shared/canonical-json.js';
import { sha256Hex } from '../shared/hash.js';
import { isUuid } from '../shared/uuid.js';
import { createContext } from './context.js';
import { resolvePrincipal } from './principal.js';

export const API_VERSION = 'v1';
export const MAX_ENVELOPE_CHARS = 8 * 1024 * 1024; // attachments travel base64 inside the envelope (≤ 5 MB files)

const ENVELOPE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['api_version', 'request_id', 'operation', 'payload'],
  properties: {
    api_version: { type: 'string', const: API_VERSION },
    request_id: { type: 'string', format: 'uuid' },
    operation: { type: 'string', pattern: '^[a-z][A-Za-z]*\\.[a-z][A-Za-z]*$', maxLength: 80 },
    idempotency_key: { type: ['string', 'null'], format: 'uuid' },
    expected_version: { type: ['integer', 'null'], minimum: 1 },
    credential: { type: ['string', 'null'], maxLength: 8192 },
    payload: { type: 'object' },
    client: { type: ['object', 'null'] },
  },
};

/**
 * @param {object} deps    { registry, store, mutations, identity, clock, ids, crypto, config, cache, rateLimiter, metrics, logger, platform }
 * @param {string|object} raw
 * @param {{channel?: string}} [opts]
 */
export function* dispatch(deps, raw, opts = {}) {
  const started = Date.now();
  let requestId = null;
  let opName = 'unknown';
  let ok = false;
  let ctx = null;
  try {
    const env = parseEnvelope(raw);
    requestId = env.request_id;
    opName = env.operation;
    const op = deps.registry.get(env.operation);
    if (!op) throw new AppError('UNSUPPORTED_OPERATION', `operation not in allowlist: ${String(env.operation).slice(0, 80)}`);

    if (deps.config.assertSafe) deps.config.assertSafe();
    if (op.mutation && deps.config.systemMode === 'READ_ONLY' && !op.maintenanceAllowed) {
      throw new AppError('MAINTENANCE_MODE', 'read-only mode');
    }

    const payload = normalizeInput(env.payload || {});
    let attempts = 0;
    for (;;) {
      ctx = yield* createContext(deps, { request_id: requestId, operation: op.name, channel: opts.channel || 'APP' });
      if (op.auth !== 'PUBLIC') {
        if (!env.credential) throw new AppError('UNAUTHENTICATED', 'missing credential');
        const claims = yield deps.identity.verifyCredential(env.credential);
        ctx.principal = yield* resolvePrincipal(ctx, claims);
        if (op.auth === 'USER' && !ctx.principal.linked) throw new AppError('ACCOUNT_NOT_LINKED', 'identity not linked to a user');
      }
      if (deps.rateLimiter && op.rateLimitPerMinute) {
        const who = ctx.principal ? (ctx.principal.user_id || `sub:${ctx.principal.claims.subject}`) : `anon:${(env.client && env.client.device_id) || 'unknown'}`;
        if (!deps.rateLimiter.hit(`${who}|${op.name}`, op.rateLimitPerMinute)) {
          throw new AppError('RATE_LIMITED', 'rate limited', { details: { retry_after_seconds: 60 } });
        }
      }
      const errors = validateValue(op.input, payload);
      if (errors.length) throw new AppError('VALIDATION_ERROR', `invalid payload for ${op.name}`, { fieldErrors: errors });

      if (op.mutation) {
        if (op.idempotency === 'REQUIRED' && !env.idempotency_key) {
          throw new AppError('VALIDATION_ERROR', 'idempotency_key required', { fieldErrors: [{ field: 'idempotency_key', code: 'REQUIRED', message_th: 'คำขอบันทึกข้อมูลต้องมีรหัสอ้างอิง (ระบบสร้างให้อัตโนมัติ)' }] });
        }
        if (env.idempotency_key) {
          const actor = ctx.principal ? (ctx.principal.user_id || `sub:${ctx.principal.claims.subject}`) : 'anonymous';
          const scopeKey = sha256Hex(`${actor}|${op.name}|${env.idempotency_key}`);
          const requestHash = sha256Hex(canonicalStringify({ operation: op.name, payload, expected_version: env.expected_version ?? null }));
          const prior = yield* findIdempotency(ctx, scopeKey);
          if (prior) {
            if (prior.request_hash !== requestHash) throw new AppError('DUPLICATE_REQUEST_MISMATCH', 'idempotency key reused with a different payload');
            ok = true;
            return success(requestId, prior.result_json, deps, true);
          }
          ctx.idempotency = { key: env.idempotency_key, scope_key: scopeKey, request_hash: requestHash };
        }
      }
      try {
        const data = yield* op.handler(ctx, payload, { expected_version: env.expected_version ?? null, client: env.client || null });
        ok = true;
        return success(requestId, data === undefined ? null : data, deps, !!ctx.replayed);
      } catch (e) {
        if (isAppError(e) && e.code === 'CONFLICT' && attempts < (op.retryOnConflict || 0)) {
          attempts++;
          continue;
        }
        throw e;
      }
    }
  } catch (err) {
    if (!isAppError(err) && deps.logger) deps.logger.error({ request_id: requestId, operation: opName, error: String(err && err.stack ? err.stack : err).slice(0, 2000) });
    else if (deps.logger && err.code === 'INTERNAL_ERROR') deps.logger.error({ request_id: requestId, operation: opName, code: err.code, message: err.message });
    return toErrorEnvelope(err, requestId);
  } finally {
    if (deps.metrics) deps.metrics.record(opName, Date.now() - started, ok);
  }
}

function success(requestId, data, deps, replayed) {
  return { ok: true, data, meta: { request_id: requestId, server_time: deps.clock.now(), replayed: !!replayed } };
}

function parseEnvelope(raw) {
  let env = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_ENVELOPE_CHARS) throw new AppError('PAYLOAD_TOO_LARGE', 'envelope too large');
    try { env = JSON.parse(raw); } catch (_) { throw new AppError('VALIDATION_ERROR', 'envelope is not JSON'); }
  }
  if (!env || typeof env !== 'object') throw new AppError('VALIDATION_ERROR', 'envelope must be an object');
  const errs = validateValue(ENVELOPE_SCHEMA, env);
  if (errs.length) {
    // never echo the credential back
    throw new AppError('VALIDATION_ERROR', 'invalid envelope', { fieldErrors: errs.filter((e) => e.field !== 'credential') });
  }
  return env;
}

function* findIdempotency(ctx, scopeKey) {
  const rows = yield ctx.store.findBy('IdempotencyRecords', 'scope_key', scopeKey);
  return rows.find((r) => r.expires_at > ctx.now) || null;
}

// ───────── registry ─────────

/**
 * op({ name, description_th, auth: 'USER'|'IDENTITY'|'PUBLIC', input, mutation, idempotency: 'REQUIRED'|'OPTIONAL'|'NONE',
 *      rateLimitPerMinute, retryOnConflict, maintenanceAllowed, permission (doc only), output (doc only), handler })
 */
export function op(def) {
  if (!def.name || !def.handler || !def.input) throw new Error(`invalid operation definition ${def.name}`);
  return Object.freeze({
    auth: 'USER', mutation: false, idempotency: def.mutation ? 'REQUIRED' : 'NONE', rateLimitPerMinute: def.mutation ? 120 : 300,
    retryOnConflict: 0, maintenanceAllowed: false, ...def,
  });
}

export function createRegistry(ops) {
  const map = new Map();
  for (const o of ops) {
    if (map.has(o.name)) throw new Error(`duplicate operation ${o.name}`);
    map.set(o.name, o);
  }
  return { get: (name) => (typeof name === 'string' ? map.get(name) : undefined), list: () => [...map.values()], names: () => [...map.keys()] };
}

export { isUuid };

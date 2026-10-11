// Reference REST backend and GAS HttpApiAdapter — checks that need no database (part of `npm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../../future-platform/api/src/config.mjs';
import { HTTP_STATUS } from '../../future-platform/api/src/app.mjs';
import { HttpApiAdapter } from '../../src/adapters/http/http-api-adapter.js';
import { ERROR_CODES } from '../../src/shared/errors.js';

const base = { DATABASE_URL: 'postgres://u@127.0.0.1:5432/db', API_AUTH_MODE: 'DEMO', API_DEMO_PASSPHRASE: 'long-enough-pass' };

test('config: PROD refuses DEMO, insecure origins and missing Firebase settings; DEV DEMO needs a passphrase', () => {
  assert.equal(loadConfig({ ...base, API_ENV: 'DEV' }).authMode, 'DEMO');
  assert.throws(() => loadConfig({ ...base, API_ENV: 'PROD' }), (e) => e instanceof ConfigError && /DEMO authentication is refused in PROD/.test(e.message));
  assert.throws(() => loadConfig({ ...base, API_DEMO_PASSPHRASE: 'short' }), /API_DEMO_PASSPHRASE/);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: '' }), /DATABASE_URL is required/);
  const prod = { DATABASE_URL: base.DATABASE_URL, API_ENV: 'PROD', API_AUTH_MODE: 'FIREBASE', FIREBASE_PROJECT_ID: 'example-cwk', FIREBASE_WEB_API_KEY: 'public-web-key' };
  assert.equal(loadConfig({ ...prod, API_ALLOWED_ORIGINS: 'https://app.example.com' }).allowedOrigins[0], 'https://app.example.com');
  assert.throws(() => loadConfig({ ...prod, API_ALLOWED_ORIGINS: 'http://app.example.com' }), /PROD origins must be https/);
  assert.throws(() => loadConfig({ ...prod, FIREBASE_PROJECT_ID: '' }), /FIREBASE_PROJECT_ID/);
  assert.throws(() => loadConfig({ ...prod, FIREBASE_WEB_API_KEY: '' }), /FIREBASE_WEB_API_KEY/);
  assert.throws(() => loadConfig({ ...base, API_AUTH_MODE: 'DEV_HMAC' }), /API_AUTH_MODE/);
});

test('every error code has an HTTP status; client errors are 4xx and transient ones 5xx', () => {
  for (const [code, def] of Object.entries(ERROR_CODES)) {
    assert.ok(HTTP_STATUS[code], `missing HTTP status for ${code}`);
    if (['VALIDATION_ERROR', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT'].includes(code)) assert.ok(HTTP_STATUS[code] < 500);
    if (def.retryable && code !== 'RATE_LIMITED' && code !== 'QUOTA_EXCEEDED') assert.ok(HTTP_STATUS[code] >= 500, `${code} is retryable`);
  }
});

test('HttpApiAdapter: https only (http allowed in DEV), credential moves to Authorization, body unchanged otherwise', () => {
  assert.throws(() => new HttpApiAdapter({ baseUrl: null, env: 'DEV' }), /CWK_REST_BASE_URL/);
  assert.throws(() => new HttpApiAdapter({ baseUrl: 'http://api.example.com', env: 'PROD' }), /https/);
  assert.throws(() => new HttpApiAdapter({ baseUrl: 'https://api.example.com?x=1', env: 'PROD' }), /https/);
  const calls = [];
  const a = new HttpApiAdapter({
    baseUrl: 'https://api.example.com/', env: 'PROD',
    fetch: (url, params) => { calls.push({ url, params }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, data: { x: 1 }, meta: { request_id: 'r' } }) }; },
  });
  const env = { api_version: 'v1', request_id: '00000000-0000-4000-8000-000000000009', operation: 'student.search', payload: { q: 'ก' }, credential: 'token-abc', idempotency_key: null, expected_version: 3 };
  const out = a.rpc(JSON.stringify(env));
  assert.deepEqual(out.data, { x: 1 });
  assert.equal(calls[0].url, 'https://api.example.com/v1/rpc');
  assert.equal(calls[0].params.headers.Authorization, 'Bearer token-abc');
  assert.equal(calls[0].params.followRedirects, false);
  assert.equal(calls[0].params.muteHttpExceptions, true);
  const sent = JSON.parse(calls[0].params.payload);
  assert.deepEqual(sent, { ...env, credential: null });
  // no credential → no Authorization header (the backend answers UNAUTHENTICATED for protected operations)
  a.rpc(JSON.stringify({ ...env, credential: null }));
  assert.equal(calls[1].params.headers.Authorization, undefined);
  assert.equal(a.rpc('not json').error.code, 'VALIDATION_ERROR');
});

test('HttpApiAdapter: network errors, HTML error pages and non-envelopes become retryable STORAGE_UNAVAILABLE with the request id', () => {
  const env = JSON.stringify({ api_version: 'v1', request_id: '00000000-0000-4000-8000-00000000000a', operation: 'auth.getCurrentUser', payload: {}, credential: 't' });
  const throwing = new HttpApiAdapter({ baseUrl: 'https://api.example.com', env: 'PROD', fetch: () => { throw new Error('timeout'); } });
  let r = throwing.rpc(env);
  assert.equal(r.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(r.error.retryable, true);
  assert.equal(r.meta.request_id, '00000000-0000-4000-8000-00000000000a');
  const html = new HttpApiAdapter({ baseUrl: 'https://api.example.com', env: 'PROD', fetch: () => ({ getResponseCode: () => 502, getContentText: () => '<html>bad gateway</html>' }) });
  r = html.rpc(env);
  assert.equal(r.error.code, 'STORAGE_UNAVAILABLE');
  const odd = new HttpApiAdapter({ baseUrl: 'https://api.example.com', env: 'PROD', fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{"hello":1}' }) });
  assert.equal(odd.rpc(env).error.code, 'STORAGE_UNAVAILABLE');
  // backend error envelopes pass through unchanged (status codes are the backend's)
  const denied = new HttpApiAdapter({ baseUrl: 'https://api.example.com', env: 'PROD', fetch: () => ({ getResponseCode: () => 403, getContentText: () => JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message_th: 'x', retryable: false }, meta: { request_id: 'q' } }) }) });
  assert.equal(denied.rpc(env).error.code, 'FORBIDDEN');
});

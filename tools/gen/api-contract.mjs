// Generates API_CONTRACT.md and openapi.yaml from the operation allowlist (src/application/registry.js).
import { buildRegistry } from '../../src/application/registry.js';
import { ERROR_CODES } from '../../src/shared/errors.js';
import { API_VERSION } from '../../src/application/dispatcher.js';
import { toYaml } from '../lib/yaml.mjs';
import { HTTP_STATUS } from '../../future-platform/api/src/app.mjs';

export function generate() {
  const ops = buildRegistry().list().sort((a, b) => (a.name < b.name ? -1 : 1));
  const L = [];
  L.push('# API Contract — CWK Smart Care');
  L.push('');
  L.push('> สร้างอัตโนมัติจาก allowlist ใน `src/application/registry.js` (`npm run gen`). ทุก operation ผ่าน dispatcher เดียวกันทั้ง GAS (`google.script.run.rpc`) และ REST (`POST /v1/rpc` หรือ `POST /v1/ops/{operation}`)');
  L.push('');
  L.push('## Envelope');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify({ api_version: API_VERSION, request_id: 'uuid', operation: 'attendance.recordArrival', idempotency_key: 'uuid (mutations)', expected_version: null, credential: 'runtime-only (GAS) — REST uses Authorization: Bearer', payload: {}, client: { device_id: 'uuid' } }, null, 2));
  L.push('```');
  L.push('');
  L.push('Response สำเร็จ: `{ "ok": true, "data": {...}, "meta": { "request_id", "server_time", "replayed" } }`  ');
  L.push('Response ผิดพลาด: `{ "ok": false, "error": { "code", "message_th", "retryable", "field_errors": [{field, code, message_th}], "details" }, "meta": { "request_id" } }`');
  L.push('');
  L.push('- **Idempotency:** mutation ทุกตัวต้องมี `idempotency_key` (UUID) ขอบเขต (ผู้ใช้, operation, key); ส่งซ้ำ payload เดิม → คืนผลเดิม `replayed: true`; payload ต่าง → `DUPLICATE_REQUEST_MISMATCH`; เก็บ 7 วัน');
  L.push('- **Optimistic concurrency:** operation ที่แก้ไขแถวเดิมรับ `expected_version`; ไม่ตรง → `CONFLICT` พร้อม `details.current_version`');
  L.push('- **ลำดับคำตอบ:** client ต้องทิ้งคำตอบที่เก่ากว่าคำขอล่าสุดในช่องทางเดียวกัน (frontend/src/api.js `channel`)');
  L.push('- **ชนิดข้อมูล:** JSON-safe เท่านั้น — วันที่ `YYYY-MM-DD` (ค.ศ.), เวลา UTC ISO 8601, ไม่มี Date/Blob/function ดิบ');
  L.push('');
  L.push('## Error codes');
  L.push('');
  L.push('| code | HTTP (REST) | retryable | ข้อความ (ไทย) |');
  L.push('|---|---|---|---|');
  for (const [code, d] of Object.entries(ERROR_CODES)) L.push(`| ${code} | ${HTTP_STATUS[code]} | ${d.retryable ? 'ใช่' : 'ไม่'} | ${d.th} |`);
  L.push('');
  L.push('บน REST ทุกคำตอบเป็น envelope เดียวกัน; HTTP status ตามตารางนี้ (สำเร็จ = 200) และมี header `X-Request-Id`; `RATE_LIMITED`/`MAINTENANCE_MODE` มี `Retry-After` — บน Apps Script (`google.script.run`) ไม่มี HTTP status ให้ใช้ ดูที่ `error.code` เท่านั้น');
  L.push('');
  L.push(`## Operations (${ops.length})`);
  L.push('');
  L.push('| operation | auth | permission | mutation | idempotency | rate/min | คำอธิบาย |');
  L.push('|---|---|---|---|---|---|---|');
  for (const o of ops) L.push(`| \`${o.name}\` | ${o.auth} | ${o.permission || (o.auth === 'PUBLIC' ? '—' : 'ตาม handler')} | ${o.mutation ? '✔' : ''} | ${o.idempotency} | ${o.rateLimitPerMinute} | ${o.description_th || ''} |`);
  L.push('');
  L.push('## Payload schemas');
  L.push('');
  for (const o of ops) {
    L.push(`### ${o.name}`);
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(o.input, null, 2));
    L.push('```');
    L.push('');
  }
  const envelopeResponse = {
    type: 'object', required: ['ok', 'meta'],
    properties: { ok: { type: 'boolean' }, data: {}, error: { $ref: '#/components/schemas/Error' }, meta: { type: 'object', properties: { request_id: { type: ['string', 'null'] }, server_time: { type: 'string' }, replayed: { type: 'boolean' } } } },
  };
  // every response body is the envelope; the HTTP status of an error follows its code (x-cwk-http-status)
  const envelopeResponses = (okText) => ({
    200: { description: okText, content: { 'application/json': { schema: { $ref: '#/components/schemas/Response' } } } },
    default: { description: 'Error envelope (ok=false); HTTP status per error code — see components.x-cwk-http-status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Response' } } } },
  });
  const paths = {
    '/v1/rpc': {
      post: {
        operationId: 'rpc', summary: 'Generic RPC envelope (same contract as google.script.run.rpc)', security: [{ bearer: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
        responses: envelopeResponses('Envelope response (ok true/false)'),
      },
    },
    '/v1/webhook/line': {
      post: {
        operationId: 'lineWebhook', summary: 'Signed LINE event envelope from the gateway (same protocol as Apps Script doPost; 404 while LINE is disabled)', security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['v', 'kid', 'ts', 'nonce', 'source', 'payload', 'sig'] } } } },
        responses: { 200: { description: '{ok, stored:true[, duplicate]}' }, 400: { description: 'invalid envelope' }, 401: { description: 'bad signature, unknown key or clock skew' }, 404: { description: 'LINE disabled' } },
      },
    },
    '/healthz': { get: { operationId: 'healthz', summary: 'Liveness (no secrets)', responses: { 200: { description: 'alive' } } } },
    '/readyz': { get: { operationId: 'readyz', summary: 'Readiness (database reachable, schema version)', responses: { 200: { description: 'ready' }, 503: { description: 'not ready' } } } },
  };
  for (const o of ops) {
    const headers = [];
    if (o.mutation) headers.push({ name: 'Idempotency-Key', in: 'header', required: o.idempotency === 'REQUIRED', schema: { type: 'string', format: 'uuid' } });
    headers.push({ name: 'If-Match', in: 'header', required: false, description: 'expected_version', schema: { type: 'integer' } });
    paths[`/v1/ops/${o.name}`] = {
      post: {
        operationId: o.name.replace('.', '_'), summary: o.description_th || o.name, tags: [o.name.split('.')[0]],
        security: o.auth === 'PUBLIC' ? [] : [{ bearer: [] }], parameters: headers,
        requestBody: { required: true, content: { 'application/json': { schema: o.input } } },
        responses: envelopeResponses('Envelope response'),
        'x-cwk': { auth: o.auth, permission: o.permission || null, mutation: !!o.mutation, idempotency: o.idempotency, rate_limit_per_minute: o.rateLimitPerMinute },
      },
    };
  }
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'CWK Smart Care API', version: API_VERSION, description: 'Generated from src/application/registry.js — transport-independent operations; the REST reference backend (future-platform/api) serves these paths.' },
    servers: [{ url: 'http://localhost:8080', description: 'local reference backend (docker compose)' }],
    components: {
      'x-cwk-http-status': HTTP_STATUS,
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID token (verified server-side with Firebase Admin SDK)' } },
      schemas: {
        Envelope: { type: 'object', required: ['api_version', 'request_id', 'operation', 'payload'], properties: { api_version: { const: API_VERSION }, request_id: { type: 'string', format: 'uuid' }, operation: { type: 'string', enum: ops.map((o) => o.name) }, idempotency_key: { type: ['string', 'null'], format: 'uuid' }, expected_version: { type: ['integer', 'null'] }, payload: { type: 'object' } } },
        Response: envelopeResponse,
        Error: { type: 'object', properties: { code: { type: 'string', enum: Object.keys(ERROR_CODES) }, message_th: { type: 'string' }, retryable: { type: 'boolean' }, field_errors: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, code: { type: 'string' }, message_th: { type: 'string' } } } }, details: { type: ['object', 'null'] } } },
      },
    },
    paths,
  };
  return { 'API_CONTRACT.md': L.join('\n'), 'openapi.yaml': `# Generated by tools/gen/api-contract.mjs — DO NOT EDIT\n${toYaml(openapi)}\n` };
}

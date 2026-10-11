// Abuse limits and hardening checks referenced by THREAT_MODEL.md (T8, T11): envelope size, page
// size, per-operation rate limits, upload validation, and that operation errors never echo secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeHarness, PASS } from '../helpers/app-harness.mjs';
import { runSync } from '../../src/application/runtime.js';
import { dispatch, MAX_ENVELOPE_CHARS } from '../../src/application/dispatcher.js';

function setup() {
  const h = makeHarness({ now: new Date('2026-06-15T03:00:00Z').toISOString() });
  h.bootstrap();
  const seed = h.seed();
  return { h, ids: Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id])), seed };
}

test('oversized envelopes are refused before parsing (PAYLOAD_TOO_LARGE)', () => {
  const { h, ids } = setup();
  const env = JSON.stringify({ api_version: 'v1', request_id: crypto.randomUUID(), operation: 'class.list', payload: { pad: 'x'.repeat(MAX_ENVELOPE_CHARS) }, credential: h.cred(ids.affairs) });
  const r = runSync(dispatch, h.deps, env);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PAYLOAD_TOO_LARGE');
});

test('page size is capped by the schema (no unbounded lists)', () => {
  const { h, ids } = setup();
  assert.equal(h.call(ids.affairs, 'student.search', { q: null, limit: 5000 }).error.code, 'VALIDATION_ERROR');
  assert.equal(h.ok(ids.affairs, 'student.search', { q: null, limit: 200 }).items.length <= 200, true);
});

test('per-operation rate limits apply per user (report.run 10/min) and reset with time', () => {
  const { h, ids } = setup();
  let limited = null;
  for (let i = 0; i < 12; i++) {
    const r = h.call(ids.affairs, 'report.run', { code: 'R01', filter: { date: '2026-06-15' }, format: 'CSV' });
    if (!r.ok) { limited = r.error; break; }
  }
  assert.equal(limited && limited.code, 'RATE_LIMITED');
  assert.equal(limited.retryable, true);
  // another user is not affected
  assert.equal(h.call(ids.exec, 'report.run', { code: 'R01', filter: { date: '2026-06-15' }, format: 'CSV' }).ok, true);
  h.clock.advance(61 * 1000);
  assert.equal(h.call(ids.affairs, 'report.run', { code: 'R01', filter: { date: '2026-06-15' }, format: 'CSV' }).ok, true);
});

test('uploads: wrong type, mismatched content and oversize files are rejected; nothing is stored', () => {
  const { h, seed } = setup();
  const g = seed.guardian_users[0];
  const days = [{ school_date: '2026-06-16', unit: 'FULL_DAY' }];
  const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  let r = h.call(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'SICK', reason: 'ป่วย', days, attachments: [{ filename: 'x.html', mime_type: 'text/html', content_base64: html }] });
  assert.equal(r.error.code, 'VALIDATION_ERROR');
  r = h.call(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'SICK', reason: 'ป่วย', days, attachments: [{ filename: 'cert.pdf', mime_type: 'application/pdf', content_base64: html }] });
  assert.equal(r.error.code, 'VALIDATION_ERROR', 'PDF name but not PDF bytes');
  const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0x20);
  big.write('%PDF-1.4', 0);
  r = h.call(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'SICK', reason: 'ป่วย', days, attachments: [{ filename: 'cert.pdf', mime_type: 'application/pdf', content_base64: big.toString('base64') }] });
  assert.equal(r.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(h.store.list('Attachments', { limit: 10 }).items.length, 0);
  assert.equal(h.store.list('LeaveRequests', { limit: 10 }).items.length, 0);
});

test('error envelopes never echo credentials or internal messages', () => {
  const { h } = setup();
  const r = h.call(`demo:${crypto.randomUUID()}:${PASS}`, 'class.list', {}, { rawCredential: true });
  const text = JSON.stringify(r);
  assert.equal(r.ok, false);
  assert.ok(!text.includes(PASS), 'passphrase not echoed');
  assert.ok(r.error.message_th && !/stack|at \w+ \(/.test(text), 'Thai message only, no stack');
});

test('internal reads are never silently truncated at the 500-row page size (regression)', async () => {
  const { h } = setup();
  const { listAll } = await import('../../src/application/queries.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const station = h.store.list('Stations', { limit: 1 }).items[0];
  const before = h.store.count('Stations');
  const rows = Array.from({ length: 650 }, (_, i) => ({ ...station, id: crypto.randomUUID(), code: `S${String(i).padStart(4, '0')}` }));
  h.store.seed('Stations', rows);
  const all = runSync(listAll, { store: h.store }, 'Stations');
  assert.equal(all.length, before + 650);
  const filtered = runSync(listAll, { store: h.store }, 'Stations', { where: { code: { gte: 'S0600' } } });
  assert.equal(filtered.length, 50);
  // a store without the `all` option is paged through its cursor
  const paging = { list: (t, q) => { const p = h.store.list(t, { ...q, all: undefined }); return p; } };
  assert.equal(runSync(listAll, { store: paging }, 'Stations').length, before + 650);
  // the client page size stays capped
  assert.equal(h.store.list('Stations', { limit: 5000 }).items.length, 500);
  // no application code asks list() for more than one page and ignores the cursor
  const offenders = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js') && /store\.list\([^)]*limit: \d{4,}/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p); } };
  walk(path.resolve(import.meta.dirname, '../../src'));
  assert.deepEqual(offenders, []);
});

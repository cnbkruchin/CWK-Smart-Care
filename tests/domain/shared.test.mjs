import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex, hmacSha256Hex, toBase64, fromBase64, sha1Bytes, toHex, timingSafeEqualStr } from '../../src/shared/hash.js';
import { canonicalStringify, utf8Encode, utf8Decode } from '../../src/shared/canonical-json.js';
import { uuidV5, isUuid, uuidV4FromBytes, deterministicId } from '../../src/shared/uuid.js';
import { schoolDateOf, localToUtc, addDays, diffDays, isoWeekday, eachDate, isIsoDate, isIsoTimestamp, rangesOverlap, dateInRange } from '../../src/shared/time.js';
import { formatThaiDate, formatThaiDateTime, toBuddhistYear } from '../../src/shared/thai-format.js';
import { validateValue, normalizeInput } from '../../src/shared/validate.js';
import { AppError, toErrorEnvelope } from '../../src/shared/errors.js';

test('sha256/sha1/hmac match node:crypto for ASCII, Thai and binary input', () => {
  const inputs = ['', 'abc', 'โรงเรียนจุนวิทยาคม', 'x'.repeat(1000), '😀 emoji', '00123'];
  for (const s of inputs) {
    assert.equal(sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), s);
    assert.equal(toHex(sha1Bytes(s)), crypto.createHash('sha1').update(s, 'utf8').digest('hex'), s);
    assert.equal(hmacSha256Hex('key-ไทย', s), crypto.createHmac('sha256', 'key-ไทย').update(s, 'utf8').digest('hex'), s);
  }
  const longKey = 'k'.repeat(100);
  assert.equal(hmacSha256Hex(longKey, 'm'), crypto.createHmac('sha256', longKey).update('m').digest('hex'));
  const bytes = crypto.randomBytes(777);
  assert.equal(sha256Hex(new Uint8Array(bytes)), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('base64 round trip matches Buffer', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100, 257]) {
    const b = crypto.randomBytes(n);
    assert.equal(toBase64(new Uint8Array(b)), b.toString('base64'));
    assert.deepEqual(Buffer.from(fromBase64(b.toString('base64'))), b);
  }
});

test('utf8 encode/decode Thai text', () => {
  const s = 'ด.ญ. สมใจ ใจดี 00123 😀';
  assert.deepEqual(Buffer.from(utf8Encode(s)), Buffer.from(s, 'utf8'));
  assert.equal(utf8Decode(utf8Encode(s)), s);
});

test('canonical JSON sorts keys recursively and is whitespace free', () => {
  const a = canonicalStringify({ b: 1, a: { d: [3, { z: 1, y: null }], c: 'ไทย' }, u: undefined });
  assert.equal(a, '{"a":{"c":"ไทย","d":[3,{"y":null,"z":1}]},"b":1}');
  assert.equal(canonicalStringify({ x: -0 }), '{"x":0}');
  assert.throws(() => canonicalStringify({ x: NaN }));
  assert.throws(() => canonicalStringify([undefined]));
});

test('uuid v5 matches RFC 4122 reference vector and deterministic IDs are stable', () => {
  assert.equal(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  const id1 = deterministicId.dailyAttendance('11111111-1111-4111-8111-111111111111', '2026-10-10');
  const id2 = deterministicId.dailyAttendance('11111111-1111-4111-8111-111111111111', '2026-10-10');
  assert.equal(id1, id2);
  assert.ok(isUuid(id1));
  assert.notEqual(id1, deterministicId.dailyAttendance('11111111-1111-4111-8111-111111111111', '2026-10-11'));
  assert.ok(isUuid(uuidV4FromBytes(crypto.randomBytes(16))));
});

test('school date derives from Asia/Bangkok, crossing UTC midnight', () => {
  assert.equal(schoolDateOf('2026-10-09T17:00:00.000Z'), '2026-10-10'); // 00:00 BKK
  assert.equal(schoolDateOf('2026-10-09T16:59:59.999Z'), '2026-10-09'); // 23:59 BKK previous day
  assert.equal(localToUtc('2026-10-10', '08:00'), '2026-10-10T01:00:00.000Z');
  assert.equal(localToUtc('2026-10-10', '06:30'), '2026-10-09T23:30:00.000Z');
});

test('date arithmetic and half-open ranges', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(diffDays('2026-10-01', '2026-10-10'), 9);
  assert.equal(isoWeekday('2026-10-10'), 6); // Saturday
  assert.deepEqual(eachDate('2026-10-01', '2026-10-04'), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.ok(isIsoDate('2026-02-28'));
  assert.ok(!isIsoDate('2026-02-30'));
  assert.ok(!isIsoDate('2569-13-01'));
  assert.ok(isIsoTimestamp('2026-10-10T01:42:00.000Z'));
  assert.ok(!isIsoTimestamp('2026-10-10 01:42:00'));
  assert.ok(rangesOverlap('2026-01-01', '2026-02-01', '2026-01-31', null));
  assert.ok(!rangesOverlap('2026-01-01', '2026-02-01', '2026-02-01', null));
  assert.ok(dateInRange('2026-01-31', '2026-01-01', '2026-02-01'));
  assert.ok(!dateInRange('2026-02-01', '2026-01-01', '2026-02-01'));
});

test('Thai display converts CE→BE exactly once', () => {
  assert.equal(toBuddhistYear(2026), 2569);
  assert.equal(formatThaiDate('2026-10-10'), '10 ต.ค. 2569');
  assert.equal(formatThaiDate('2026-10-10', { long: true }), '10 ตุลาคม 2569');
  assert.equal(formatThaiDateTime('2026-10-10T01:42:00.000Z'), '10 ต.ค. 2569 08:42 น.');
  // 23:30 UTC on the 9th is already the 10th in Bangkok
  assert.equal(formatThaiDateTime('2026-10-09T23:30:00.000Z'), '10 ต.ค. 2569 06:30 น.');
});

test('validator reports Thai field errors and rejects unknown fields', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['student_id', 'school_date'],
    properties: { student_id: { type: 'string', format: 'uuid' }, school_date: { type: 'string', format: 'date' }, note: { type: ['string', 'null'], maxLength: 5 } },
  };
  assert.deepEqual(validateValue(schema, { student_id: '11111111-1111-4111-8111-111111111111', school_date: '2026-10-10' }), []);
  const errs = validateValue(schema, { student_id: 'x', school_date: '2026-13-01', note: 'toolong', role: 'ADMIN' });
  assert.deepEqual(errs.map((e) => `${e.field}:${e.code}`).sort(), ['note:MAX_LENGTH', 'role:UNKNOWN_FIELD', 'school_date:FORMAT', 'student_id:FORMAT']);
  assert.ok(errs.every((e) => /[ก-๙]/.test(e.message_th)));
  assert.deepEqual(normalizeInput({ a: '  x ', b: '   ', c: ['', 'y'] }), { a: 'x', b: null, c: [null, 'y'] });
});

test('error envelope never leaks internal messages', () => {
  const env = toErrorEnvelope(new Error('secret db password=xyz'), 'req-1');
  assert.equal(env.error.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(env).includes('xyz'));
  const env2 = toErrorEnvelope(new AppError('CONFLICT', 'x', { details: { current_version: 3, secret: 'no' } }), 'r');
  assert.deepEqual(env2.error.details, { current_version: 3 });
  assert.ok(timingSafeEqualStr('abc', 'abc'));
  assert.ok(!timingSafeEqualStr('abc', 'abd'));
  assert.ok(!timingSafeEqualStr('abc', 'abcd'));
});

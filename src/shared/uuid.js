// UUID helpers. Random v4 UUIDs come from the IdGenerator port (Utilities.getUuid / crypto.randomUUID).
// Deterministic v5 UUIDs (RFC 4122 §4.3, SHA-1) are used for natural-key rows such as
// DailyAttendance(student_id, school_date) so that every platform derives the same ID.

import { sha1Bytes, toHex } from './hash.js';
import { utf8Encode } from './canonical-json.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Project namespace for v5 IDs. Never change: it would change every deterministic ID. */
export const CWK_NAMESPACE = '6f1c7a52-8f3e-5b5e-9d3a-1c2b3a4d5e6f';

/** Fixed system principal used as actor for jobs/triggers (row seeded in Users). */
export const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000001';

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

function uuidToBytes(u) {
  const hex = u.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToUuid(b) {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function uuidV5(name, namespace = CWK_NAMESPACE) {
  const ns = uuidToBytes(namespace);
  const nb = utf8Encode(String(name));
  const all = new Uint8Array(ns.length + nb.length);
  all.set(ns); all.set(nb, ns.length);
  const hash = sha1Bytes(all).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return bytesToUuid(hash);
}

/** Build a v4 UUID from 16 random bytes supplied by the platform. */
export function uuidV4FromBytes(bytes) {
  const b = Uint8Array.from(bytes).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return bytesToUuid(b);
}

/** Deterministic IDs for natural keys. Inputs must already be canonical (lowercase UUIDs, YYYY-MM-DD). */
export const deterministicId = {
  dailyAttendance: (studentId, schoolDate) => uuidV5(`DailyAttendance|${studentId}|${schoolDate}`),
  rollCallSession: (classId, schoolDate) => uuidV5(`RollCallSessions|${classId}|${schoolDate}`),
  outbox: (dedupeKey) => uuidV5(`NotificationOutbox|${dedupeKey}`),
  idempotency: (scopeKey) => uuidV5(`IdempotencyRecords|${scopeKey}`),
  reconciliationTask: (dedupeKey) => uuidV5(`ReconciliationTasks|${dedupeKey}`),
};

// Temporary offline capture for the gate (MASTER_PROMPT §13): minimal event data only — local id,
// idempotency key, scanned code, station, device time, claimed user. No tokens, no student lists,
// no health data. Records are NOT successful until the server accepts them on sync.
const DB_NAME = 'cwk-offline-v1';
const STORE = 'arrivals';
export const RETENTION_HOURS = 24;

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB ไม่พร้อมใช้งานบนเบราว์เซอร์นี้')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'local_id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : out); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export async function available() {
  try { await open(); return true; } catch (_) { return false; }
}

export function queueArrival(rec) {
  return tx('readwrite', (s) => s.put({ ...rec, queued_at: new Date().toISOString() }));
}

export function pending() {
  return tx('readonly', (s) => s.getAll());
}

export async function remove(localIds) {
  await tx('readwrite', (s) => { for (const id of localIds) s.delete(id); });
}

/** Drop records past retention (shared devices): they must be re-entered via the emergency paper form. */
export async function purgeExpired() {
  const all = await pending();
  const cutoff = Date.now() - RETENTION_HOURS * 3600 * 1000;
  const expired = all.filter((r) => Date.parse(r.queued_at) < cutoff).map((r) => r.local_id);
  if (expired.length) await remove(expired);
  return expired.length;
}

export async function clearAll() {
  await tx('readwrite', (s) => s.clear());
}

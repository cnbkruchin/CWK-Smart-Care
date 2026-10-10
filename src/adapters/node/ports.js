// Node.js implementations of the small ports (clock, ids, crypto, cache, rate limiter, metrics, logger).
import crypto from 'node:crypto';

export const nodeClock = { now: () => new Date().toISOString() };

/** Deterministic clock for tests: advance manually. */
export class FixedClock {
  constructor(iso) { this.t = new Date(iso).getTime(); }
  now() { return new Date(this.t).toISOString(); }
  advance(ms) { this.t += ms; return this.now(); }
  set(iso) { this.t = new Date(iso).getTime(); }
}

export const nodeIds = { uuid: () => crypto.randomUUID() };

export const nodeCrypto = {
  sha256Hex: (data) => crypto.createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).digest('hex'),
  hmacSha256Base64: (key, data) => crypto.createHmac('sha256', key).update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)).digest('base64'),
  randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
};

export class MemoryCache {
  constructor(clock = nodeClock) { this.m = new Map(); this.clock = clock; }
  get(k) {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp < Date.parse(this.clock.now())) { this.m.delete(k); return null; }
    return e.v;
  }
  put(k, v, ttlSeconds = 600) { this.m.set(k, { v, exp: Date.parse(this.clock.now()) + ttlSeconds * 1000 }); }
  remove(k) { this.m.delete(k); }
}

/** Fixed-window rate limiter (best effort; process-local). */
export class MemoryRateLimiter {
  constructor(clock = nodeClock) { this.m = new Map(); this.clock = clock; }
  hit(key, perMinute) {
    const win = Math.floor(Date.parse(this.clock.now()) / 60000);
    const k = `${key}|${win}`;
    const n = (this.m.get(k) || 0) + 1;
    this.m.set(k, n);
    if (this.m.size > 10000) this.m.clear();
    return n <= perMinute;
  }
}

export class MetricsRecorder {
  constructor() { this.samples = new Map(); }
  record(op, ms, ok) {
    if (!this.samples.has(op)) this.samples.set(op, { ms: [], errors: 0 });
    const s = this.samples.get(op);
    s.ms.push(ms);
    if (!ok) s.errors++;
    if (s.ms.length > 5000) s.ms.shift();
  }
  summary() {
    const out = {};
    for (const [op, s] of this.samples) {
      const sorted = [...s.ms].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] || 0;
      out[op] = { count: sorted.length, errors: s.errors, p50_ms: q(0.5), p95_ms: q(0.95), max_ms: sorted[sorted.length - 1] || 0 };
    }
    return out;
  }
}

export const consoleLogger = {
  // structured, no payloads/tokens: callers pass only ids/codes
  error: (o) => console.error(JSON.stringify({ level: 'error', ...o })),
  info: (o) => console.log(JSON.stringify({ level: 'info', ...o })),
};

export const silentLogger = { error: () => {}, info: () => {} };

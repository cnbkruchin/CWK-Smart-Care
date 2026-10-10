// Apps Script implementations of small ports. Byte arrays from Utilities are Java-style signed bytes.
import { toHex } from '../../shared/hash.js';
import { toBase64 } from '../../shared/hash.js';

const G = () => globalThis;

export const gasClock = { now: () => new Date().toISOString() };
export const gasIds = { uuid: () => G().Utilities.getUuid().toLowerCase() };

const unsigned = (arr) => Uint8Array.from(arr, (b) => b & 0xff);
const signed = (u8) => Array.from(u8, (b) => (b > 127 ? b - 256 : b));

export const gasCrypto = {
  sha256Hex(data) {
    const U = G().Utilities;
    const digest = typeof data === 'string' ? U.computeDigest(U.DigestAlgorithm.SHA_256, data, U.Charset.UTF_8) : U.computeDigest(U.DigestAlgorithm.SHA_256, signed(data));
    return toHex(unsigned(digest));
  },
  hmacSha256Base64(key, data) {
    const U = G().Utilities;
    const sig = typeof data === 'string'
      ? U.computeHmacSha256Signature(data, key, U.Charset.UTF_8)
      : U.computeHmacSha256Signature(signed(data), U.newBlob(key).getBytes());
    return toBase64(unsigned(sig));
  },
  /** Utilities has no CSPRNG API; random bytes are taken from v4 UUIDs (122 random bits each). */
  randomBytes(n) {
    const out = [];
    while (out.length < n) {
      const hex = G().Utilities.getUuid().replace(/-/g, '');
      // skip version nibble (index 12) and variant nibble (index 16)
      const digits = hex.split('').filter((_, i) => i !== 12 && i !== 16);
      for (let i = 0; i + 1 < digits.length && out.length < n; i += 2) out.push(parseInt(digits[i] + digits[i + 1], 16));
    }
    return Uint8Array.from(out);
  },
};

export const gasCache = {
  get(k) { try { return G().CacheService.getScriptCache().get(k); } catch (_) { return null; } },
  put(k, v, ttl = 600) { try { if (String(v).length < 95000) G().CacheService.getScriptCache().put(k, v, Math.min(21600, ttl)); } catch (_) { /* acceleration only */ } },
  remove(k) { try { G().CacheService.getScriptCache().remove(k); } catch (_) { /* ignore */ } },
};

/** Best-effort fixed-window limiter on CacheService (non-atomic; documented in LIMITATIONS). */
export const gasRateLimiter = {
  hit(key, perMinute) {
    const win = Math.floor(Date.now() / 60000);
    const k = `rl:${win}:${key}`.slice(0, 250);
    const n = Number(gasCache.get(k) || '0') + 1;
    gasCache.put(k, String(n), 120);
    return n <= perMinute;
  },
};

export const gasLogger = {
  error: (o) => console.error(JSON.stringify(o)),
  info: (o) => console.log(JSON.stringify(o)),
};

/** Per-execution metrics, flushed to a 5-minute CacheService bucket for the metrics job. */
export function gasMetrics() {
  return {
    record(op, ms, ok, lockWaitMs = 0) {
      const bucket = Math.floor(Date.now() / 300000) * 300000;
      const k = `metrics:${bucket}`;
      let list = [];
      try { list = JSON.parse(gasCache.get(k) || '[]'); } catch (_) { list = []; }
      if (list.length < 2000) list.push([op, ms, ok ? 1 : 0, lockWaitMs]);
      gasCache.put(k, JSON.stringify(list), 3600);
    },
  };
}

// Pure-JS SHA-1 / SHA-256 / HMAC-SHA256 over small inputs (strings, records, idempotency payloads).
// These run identically in Apps Script V8, Node.js and browsers, so deterministic IDs and canonical
// checksums agree across platforms. Large binary payloads (attachments, export chunks) use the
// platform implementation through the Crypto port (Utilities.computeDigest / node:crypto) instead.
// Correctness is verified against node:crypto in tests/domain/hash.test.mjs.

import { utf8Encode } from './canonical-json.js';

function toBytes(input) {
  if (typeof input === 'string') return utf8Encode(input);
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input.map((b) => b & 0xff));
  throw new Error('hash: unsupported input');
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function pad(bytes) {
  const len = bytes.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000);
  const bitLenLo = (len * 8) >>> 0;
  const total = (((len + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLenHi);
  dv.setUint32(total - 4, bitLenLo);
  return buf;
}

export function sha256Bytes(input) {
  const buf = pad(toBytes(input));
  const dv = new DataView(buf.buffer);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15], w2 = W[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

export function sha1Bytes(input) {
  const buf = pad(toBytes(input));
  const dv = new DataView(buf.buffer);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const W = new Uint32Array(80);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16];
      W[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + W[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => odv.setUint32(i * 4, h >>> 0));
  return out;
}

export function hmacSha256Bytes(key, message) {
  let k = toBytes(key);
  if (k.length > 64) k = sha256Bytes(k);
  const block = new Uint8Array(64);
  block.set(k);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ipad[i] = block[i] ^ 0x36; opad[i] = block[i] ^ 0x5c; }
  const msg = toBytes(message);
  const inner = new Uint8Array(64 + msg.length);
  inner.set(ipad); inner.set(msg, 64);
  const innerHash = sha256Bytes(inner);
  const outer = new Uint8Array(64 + 32);
  outer.set(opad); outer.set(innerHash, 64);
  return sha256Bytes(outer);
}

export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += ((bytes[i] & 0xff) + 0x100).toString(16).slice(1);
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8) | (bytes[i + 2] & 0xff);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = ((bytes[i] & 0xff) << 16) | (rem > 1 ? (bytes[i + 1] & 0xff) << 8 : 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (rem > 1 ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

export function fromBase64(str) {
  const clean = String(str).replace(/[^A-Za-z0-9+/]/g, '');
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

export function sha256Hex(input) { return toHex(sha256Bytes(input)); }
export function hmacSha256Hex(key, message) { return toHex(hmacSha256Bytes(key, message)); }
export function hmacSha256Base64(key, message) { return toBase64(hmacSha256Bytes(key, message)); }

/** Constant-time comparison of two strings of possibly different lengths. */
export function timingSafeEqualStr(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i % (x.length || 1)) || 0) ^ (y.charCodeAt(i % (y.length || 1)) || 0);
  return diff === 0;
}

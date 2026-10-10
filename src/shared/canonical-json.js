// Canonical JSON serialization used for checksums, idempotency request hashes and portable export.
//
// Rules (documented in docs/PORTABLE_FORMAT.md §Canonical serialization):
//  1. Object keys are sorted by UTF-16 code unit order (Array.prototype.sort default) at every level.
//  2. No insignificant whitespace. Separators are "," and ":".
//  3. Strings are escaped exactly as JSON.stringify does (UTF-8 output, no \u escaping of non-ASCII).
//  4. Numbers must be finite; -0 is written as 0. Integers are written without exponent.
//  5. `undefined` object members are omitted; `undefined` in arrays is rejected.
//  6. Line records in JSONL files are terminated by a single "\n" (LF). No BOM.

export function canonicalStringify(value) {
  return write(value);
}

function write(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalStringify: non-finite number');
    if (Object.is(v, -0)) return '0';
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    const parts = [];
    for (let i = 0; i < v.length; i++) {
      if (v[i] === undefined) throw new Error('canonicalStringify: undefined in array');
      parts.push(write(v[i]));
    }
    return '[' + parts.join(',') + ']';
  }
  if (t === 'object') {
    if (typeof v.toJSON === 'function') return write(v.toJSON());
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + write(v[k])).join(',') + '}';
  }
  throw new Error('canonicalStringify: unsupported type ' + t);
}

/** Encode a JS string as UTF-8 bytes (Uint8Array) without relying on TextEncoder (absent in some GAS contexts). */
export function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] & 0xff;
    let cp;
    if (b < 0x80) { cp = b; i += 1; }
    else if (b < 0xe0) { cp = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; }
    else if (b < 0xf0) { cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
    else { cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4; }
    out += String.fromCodePoint(cp);
  }
  return out;
}

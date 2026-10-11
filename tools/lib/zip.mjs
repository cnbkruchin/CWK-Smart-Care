// Minimal ZIP support for portable packages (ZIP is a convenience for small packages only — large packages
// stay as directories/Drive folders). Reading is defensive: every entry name must be a safe package path
// (no absolute paths, "..", backslashes, drive letters), symlinks and encrypted entries are refused, and
// total size, entry count and compression ratio are bounded (zip-bomb guard). Writing produces stored
// (uncompressed) entries with CRC-32.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isSafePath } from '../../src/application/migration/format.js';

export const LIMITS = { maxEntries: 200000, maxTotalBytes: 4 * 1024 * 1024 * 1024, maxEntryBytes: 300 * 1024 * 1024, maxRatio: 200 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** List entries (central directory) with safety checks. */
export function readZipEntries(buf, limits = LIMITS) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('ZIP_INVALID', 'end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count > limits.maxEntries) throw new ZipError('ZIP_TOO_LARGE', 'too many entries');
  const entries = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new ZipError('ZIP_INVALID', 'bad central directory');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const xlen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const extAttr = buf.readUInt32LE(off + 38);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue; // directory entry
    if (!isSafePath(name)) throw new ZipError('UNSAFE_PATH', `unsafe entry name: ${name.slice(0, 120)}`);
    if (flags & 1) throw new ZipError('ZIP_UNSUPPORTED', 'encrypted entries are not supported');
    if (((extAttr >>> 16) & 0o170000) === 0o120000) throw new ZipError('SYMLINK', `symlink entry: ${name}`);
    if (method !== 0 && method !== 8) throw new ZipError('ZIP_UNSUPPORTED', `compression method ${method}`);
    if (usize > limits.maxEntryBytes) throw new ZipError('ZIP_TOO_LARGE', `entry too large: ${name}`);
    if (csize > 0 && usize / csize > limits.maxRatio) throw new ZipError('ZIP_TOO_LARGE', `suspicious compression ratio: ${name}`);
    total += usize;
    if (total > limits.maxTotalBytes) throw new ZipError('ZIP_TOO_LARGE', 'archive too large');
    entries.push({ name, method, crc, csize, usize, local });
  }
  return entries;
}

export function entryBytes(buf, e) {
  if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new ZipError('ZIP_INVALID', 'bad local header');
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const raw = buf.subarray(start, start + e.csize);
  const out = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: e.usize + 1 });
  if (out.length !== e.usize || crc32(out) !== e.crc) throw new ZipError('CHECKSUM_MISMATCH', `CRC mismatch: ${e.name}`);
  return out;
}

/** Extract into a NEW empty directory (refuses to write outside it). */
export function extractZip(zipPath, destDir, limits = LIMITS) {
  const buf = fs.readFileSync(zipPath);
  const entries = readZipEntries(buf, limits);
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(destDir).length) throw new ZipError('ZIP_DEST_NOT_EMPTY', 'destination must be empty');
  const root = path.resolve(destDir);
  for (const e of entries) {
    const abs = path.resolve(root, e.name);
    if (!abs.startsWith(root + path.sep)) throw new ZipError('UNSAFE_PATH', e.name);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fs.writeFileSync(abs, entryBytes(buf, e), { mode: 0o600 });
  }
  return { entries: entries.length, dir: root };
}

/** Write a stored ZIP from {name → Buffer}. Names are written exactly as given (tests may craft bad names). */
export function writeZip(zipPath, files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const nb = Buffer.from(name, 'utf8');
    const d = Buffer.from(data);
    const crc = crc32(d);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, d);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE((0o100600 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...locals, cd, end]), { mode: 0o600 });
}

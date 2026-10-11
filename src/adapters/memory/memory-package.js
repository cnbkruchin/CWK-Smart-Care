// In-memory PackageStore (tests). Same contract as the Drive and filesystem adapters:
//   create(name) → location;  open(location) → handle {writeText, writeBytes, readText, readBytes, exists, list}
import { utf8Encode, utf8Decode } from '../../shared/canonical-json.js';
import { isSafePath } from '../../application/migration/format.js';

export class MemoryPackageStore {
  constructor() { this.packages = new Map(); this.seq = 0; }
  create(name) {
    const location = `mem:${++this.seq}:${name}`;
    this.packages.set(location, new Map());
    return location;
  }
  open(location) {
    const files = this.packages.get(location);
    if (!files) throw Object.assign(new Error(`package not found: ${location}`), { code: 'NOT_FOUND' });
    return new MemoryPackageHandle(files);
  }
}

export class MemoryPackageHandle {
  constructor(files = new Map()) { this.files = files; }
  _check(p) { if (!isSafePath(p)) throw Object.assign(new Error(`unsafe package path: ${p}`), { code: 'UNSAFE_PATH' }); }
  writeText(p, text) { this._check(p); this.files.set(p, utf8Encode(String(text))); return { bytes: this.files.get(p).length }; }
  writeBytes(p, bytes) { this._check(p); this.files.set(p, Uint8Array.from(bytes)); return { bytes: bytes.length }; }
  readBytes(p) { this._check(p); const b = this.files.get(p); return b ? Uint8Array.from(b) : null; }
  readText(p) { const b = this.readBytes(p); return b ? utf8Decode(b) : null; }
  exists(p) { return this.files.has(p); }
  list() { return [...this.files.entries()].map(([path, b]) => ({ path, size: b.length })).sort((a, b) => (a.path < b.path ? -1 : 1)); }
  remove(p) { this.files.delete(p); }
}

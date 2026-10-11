// Filesystem PackageStore (Node: tools/migrate.mjs, synthetic fixtures, future REST backend).
// Packages are directories; every path is checked with isSafePath and resolved inside the root, so a
// manifest or index cannot point outside the package. Files are written with mode 0600 (private).
import fs from 'node:fs';
import path from 'node:path';
import { isSafePath } from '../../application/migration/format.js';

export class FsPackageStore {
  constructor(baseDir) { this.baseDir = path.resolve(baseDir); }
  create(name) {
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const dir = path.join(this.baseDir, safe);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  open(location) { return new FsPackageHandle(location); }
}

export class FsPackageHandle {
  constructor(root) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) throw Object.assign(new Error(`package directory not found: ${root}`), { code: 'NOT_FOUND' });
  }
  _abs(p) {
    if (!isSafePath(p)) throw Object.assign(new Error(`unsafe package path: ${p}`), { code: 'UNSAFE_PATH' });
    const abs = path.resolve(this.root, p);
    if (!abs.startsWith(this.root + path.sep)) throw Object.assign(new Error(`path escapes package: ${p}`), { code: 'UNSAFE_PATH' });
    return abs;
  }
  writeText(p, text) { return this.writeBytes(p, Buffer.from(String(text), 'utf8')); }
  writeBytes(p, bytes) {
    const abs = this._abs(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, Buffer.from(bytes), { mode: 0o600 });
    fs.renameSync(tmp, abs); // a crash never leaves a half-written file under the final name
    return { bytes: bytes.length };
  }
  readBytes(p) {
    const abs = this._abs(p);
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile()) return null; // symlinks and directories are not package files
      return new Uint8Array(fs.readFileSync(abs));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  readText(p) { const b = this.readBytes(p); return b ? Buffer.from(b).toString('utf8') : null; }
  exists(p) { try { return fs.lstatSync(this._abs(p)).isFile(); } catch (_) { return false; } }
  remove(p) { try { fs.unlinkSync(this._abs(p)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  list() {
    const out = [];
    const walk = (dir, rel) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        const abs = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) { out.push({ path: r, size: 0, symlink: true }); continue; }
        if (ent.isDirectory()) walk(abs, r);
        else if (ent.isFile()) out.push({ path: r, size: fs.statSync(abs).size });
      }
    };
    walk(this.root, '');
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }
}

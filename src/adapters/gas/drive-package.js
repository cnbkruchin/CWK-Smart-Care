// PackageStore on Google Drive: a package is a private folder under <root>/exports/; package paths map
// to nested sub-folders (data/<Table>/<partition>/part-00001.jsonl). Folders are looked up once per
// execution and cached. Nothing is shared — reading goes through the owner's script (editor/CLI copy).
import { isSafePath } from '../../application/migration/format.js';
import { utf8Encode, utf8Decode } from '../../shared/canonical-json.js';

const G = () => globalThis;

function firstLive(it) {
  while (it.hasNext()) {
    const f = it.next();
    if (!(f.isTrashed && f.isTrashed())) return f;
  }
  return null;
}

function child(parent, name, create) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return create ? parent.createFolder(name) : null;
}

export class DrivePackageStore {
  constructor({ rootFolderId }) { this.rootFolderId = rootFolderId; }
  create(name) {
    const root = G().DriveApp.getFolderById(this.rootFolderId);
    const exportsFolder = child(root, 'exports', true);
    return exportsFolder.createFolder(String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)).getId();
  }
  open(location) { return new DrivePackageHandle(location); }
}

export class DrivePackageHandle {
  constructor(folderId) {
    this.root = G().DriveApp.getFolderById(folderId);
    this.folders = new Map([['', this.root]]);
  }
  _dir(dirPath, create) {
    if (this.folders.has(dirPath)) return this.folders.get(dirPath);
    const parts = dirPath.split('/');
    const parent = this._dir(parts.slice(0, -1).join('/'), create);
    if (!parent) return null;
    const f = child(parent, parts[parts.length - 1], create);
    if (f) this.folders.set(dirPath, f);
    return f;
  }
  _split(p) {
    if (!isSafePath(p)) throw Object.assign(new Error(`unsafe package path: ${p}`), { code: 'UNSAFE_PATH' });
    const i = p.lastIndexOf('/');
    return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)];
  }
  writeText(p, text) { return this.writeBytes(p, utf8Encode(String(text))); }
  writeBytes(p, bytes) {
    const [dir, name] = this._split(p);
    const folder = this._dir(dir, true);
    const old = folder.getFilesByName(name);
    while (old.hasNext()) old.next().setTrashed(true);
    const blob = G().Utilities.newBlob(Array.from(bytes, (b) => (b > 127 ? b - 256 : b)), 'application/octet-stream', name);
    folder.createFile(blob);
    return { bytes: bytes.length };
  }
  readBytes(p) {
    const [dir, name] = this._split(p);
    const folder = this._dir(dir, false);
    if (!folder) return null;
    const f = firstLive(folder.getFilesByName(name));
    return f ? Uint8Array.from(f.getBlob().getBytes(), (b) => b & 0xff) : null;
  }
  readText(p) { const b = this.readBytes(p); return b ? utf8Decode(b) : null; }
  remove(p) {
    const [dir, name] = this._split(p);
    const folder = this._dir(dir, false);
    if (!folder) return;
    const it = folder.getFilesByName(name);
    while (it.hasNext()) it.next().setTrashed(true);
  }
  exists(p) {
    const [dir, name] = this._split(p);
    const folder = this._dir(dir, false);
    return !!folder && !!firstLive(folder.getFilesByName(name));
  }
  list() {
    const out = [];
    const walk = (folder, rel) => {
      const files = folder.getFiles();
      while (files.hasNext()) { const f = files.next(); if (f.isTrashed && f.isTrashed()) continue; out.push({ path: rel ? `${rel}/${f.getName()}` : f.getName(), size: f.getSize() }); }
      const subs = folder.getFolders();
      while (subs.hasNext()) { const s = subs.next(); walk(s, rel ? `${rel}/${s.getName()}` : s.getName()); }
    };
    walk(this.root, '');
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }
}

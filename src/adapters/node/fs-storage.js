// AttachmentStorage on a local/private filesystem (tools/migrate.mjs target, future REST backend, tests).
// Objects are stored by logical file ID only (never by the user's file name), mode 0600, inside `root`.
// Provider FILESYSTEM; object_key = "<2-char shard>/<logical id>". Not a public location.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class FsAttachmentStorage {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  _abs(key) {
    if (!/^[0-9a-f]{2}\/[0-9a-f-]{36}$/.test(String(key))) throw Object.assign(new Error('invalid object key'), { code: 'STORAGE_UNAVAILABLE' });
    return path.join(this.root, key);
  }
  put(logicalId, bytes) {
    if (!ID.test(logicalId)) throw Object.assign(new Error('invalid logical id'), { code: 'VALIDATION_ERROR' });
    const key = `${logicalId.slice(0, 2)}/${logicalId}`;
    const abs = this._abs(key);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, Buffer.from(bytes), { mode: 0o600 });
    fs.renameSync(tmp, abs);
    return { provider: 'FILESYSTEM', object_key: key, container: path.basename(this.root), size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  get(mapping) {
    try { return new Uint8Array(fs.readFileSync(this._abs(mapping.object_key))); } catch (e) { throw Object.assign(new Error('object missing'), { code: 'STORAGE_UNAVAILABLE' }); }
  }
  delete(mapping) { try { fs.unlinkSync(this._abs(mapping.object_key)); } catch (_) { /* already gone */ } return true; }
  metadata(mapping) {
    try {
      const b = fs.readFileSync(this._abs(mapping.object_key));
      return { size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') };
    } catch (_) { return null; }
  }
}

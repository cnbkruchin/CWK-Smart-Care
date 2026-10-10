// In-memory AttachmentStorage (tests). Mirrors the private-by-default contract of the Drive adapter.
import crypto from 'node:crypto';

export class MemoryAttachmentStorage {
  constructor() { this.objects = new Map(); this.deleted = new Set(); }
  put(logicalId, bytes, meta = {}) {
    const key = `mem/${meta.staged ? 'staging' : 'files'}/${logicalId}`;
    this.objects.set(key, Uint8Array.from(bytes));
    return { provider: 'FILESYSTEM', object_key: key, container: 'memory', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  get(mapping) {
    const b = this.objects.get(mapping.object_key);
    if (!b) throw Object.assign(new Error('object missing'), { code: 'STORAGE_UNAVAILABLE' });
    return Uint8Array.from(b);
  }
  delete(mapping) { this.objects.delete(mapping.object_key); this.deleted.add(mapping.object_key); return true; }
  metadata(mapping) {
    const b = this.objects.get(mapping.object_key);
    return b ? { size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') } : null;
  }
}

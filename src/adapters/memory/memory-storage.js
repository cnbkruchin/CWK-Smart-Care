// In-memory AttachmentStorage (tests). Mirrors the private-by-default contract of the Drive adapter.
import crypto from 'node:crypto';

export class MemoryAttachmentStorage {
  /** @param {{now: () => string}} [clock] creation times for the orphan cleanup (defaults to real time) */
  constructor(clock = null) { this.objects = new Map(); this.deleted = new Set(); this.created = new Map(); this.clock = clock; }
  put(logicalId, bytes, meta = {}) {
    const key = `mem/${meta.staged ? 'staging' : 'files'}/${logicalId}`;
    this.objects.set(key, Uint8Array.from(bytes));
    this.created.set(key, this.clock ? this.clock.now() : new Date().toISOString());
    return { provider: 'FILESYSTEM', object_key: key, container: 'memory', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  get(mapping) {
    const b = this.objects.get(mapping.object_key);
    if (!b) throw Object.assign(new Error('object missing'), { code: 'STORAGE_UNAVAILABLE' });
    return Uint8Array.from(b);
  }
  delete(mapping) { this.objects.delete(mapping.object_key); this.created.delete(mapping.object_key); this.deleted.add(mapping.object_key); return true; }
  isStaged(mapping) { return String(mapping.object_key).startsWith('mem/staging/'); }
  promote(mapping) {
    const to = mapping.object_key.replace('mem/staging/', 'mem/files/');
    this.objects.set(to, this.objects.get(mapping.object_key));
    this.created.set(to, this.created.get(mapping.object_key));
    this.objects.delete(mapping.object_key);
    this.created.delete(mapping.object_key);
    return { object_key: to, container: 'memory' };
  }
  /** Objects in the staging area, ordered by logical id: {items:[{logical_id, object_key, created_at}], next_after}. */
  listStaged({ after = null, limit = 500 } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith('mem/staging/') && (!after || k.slice(12) > after)).sort();
    const page = keys.slice(0, limit);
    return { items: page.map((k) => ({ logical_id: k.slice(12), object_key: k, created_at: this.created.get(k) })), next_after: keys.length > limit ? page[page.length - 1].slice(12) : null };
  }
  metadata(mapping) {
    const b = this.objects.get(mapping.object_key);
    return b ? { size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') } : null;
  }
}

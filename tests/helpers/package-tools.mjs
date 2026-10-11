// Test helpers for portable packages: clone a package and "re-sign" it after a deliberate edit (recompute
// chunk checksums, row counts, table digests and manifest.sha256) so tests reach the semantic checks
// (foreign keys, duplicates, schema) that sit behind the integrity checks.
import crypto from 'node:crypto';
import { MemoryPackageHandle } from '../../src/adapters/memory/memory-package.js';
import { newTableAcc, accumulate, manifestShaLine } from '../../src/application/migration/format.js';

export const sha = (d) => crypto.createHash('sha256').update(typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d)).digest('hex');

export function clonePackage(handle) {
  const files = new Map();
  for (const f of handle.list()) files.set(f.path, handle.readBytes(f.path));
  return new MemoryPackageHandle(files);
}

export function readManifest(handle) {
  return JSON.parse(handle.readText('manifest.json'));
}

export function writeManifest(handle, manifest, { sign = true } = {}) {
  const text = JSON.stringify(manifest, null, 2) + '\n';
  handle.writeText('manifest.json', text);
  if (sign) handle.writeText('manifest.sha256', manifestShaLine(sha(text)));
}

/** Recompute every checksum/count/digest from the files as they are now, then re-sign the manifest. */
export function resign(handle, mutateManifest = null) {
  const m = readManifest(handle);
  for (const t of m.tables) {
    const acc = newTableAcc();
    for (const p of t.partitions) {
      let rows = 0;
      for (const c of p.chunks) {
        const b = handle.readBytes(c.path);
        if (!b) continue;
        const text = Buffer.from(b).toString('utf8');
        const lines = text.length ? text.slice(0, -1).split('\n') : [];
        c.bytes = b.length;
        c.sha256 = sha(b);
        c.rows = lines.length;
        rows += lines.length;
        for (const l of lines) { try { accumulate(acc, t.name, JSON.parse(l), sha, l); } catch (_) { /* unparsable line keeps old digest */ } }
      }
      p.row_count = rows;
    }
    t.row_count = acc.rows;
    t.digest_all = acc.digest_all;
    t.digest_source = acc.digest_source;
  }
  if (m.attachments.index) {
    const b = handle.readBytes(m.attachments.index.path);
    if (b) { m.attachments.index.sha256 = sha(b); m.attachments.index.bytes = b.length; }
  }
  for (const f of m.files) { const b = handle.readBytes(f.path); if (b) { f.sha256 = sha(b); f.bytes = b.length; } }
  if (mutateManifest) mutateManifest(m);
  writeManifest(handle, m);
  return m;
}

/** Replace one line of a chunk of `table` (first chunk containing a line that matches `pred`). */
export function editLine(handle, table, pred, edit) {
  const m = readManifest(handle);
  const t = m.tables.find((x) => x.name === table);
  for (const p of t.partitions) for (const c of p.chunks) {
    const text = handle.readText(c.path);
    const lines = text.slice(0, -1).split('\n');
    const i = lines.findIndex((l) => pred(JSON.parse(l)));
    if (i < 0) continue;
    const out = edit(lines[i], JSON.parse(lines[i]));
    if (out === null) lines.splice(i, 1); else if (Array.isArray(out)) lines.splice(i, 1, ...out); else lines[i] = out;
    handle.writeText(c.path, lines.length ? lines.join('\n') + '\n' : '');
    return true;
  }
  return false;
}

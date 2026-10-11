// Synchronous HTTP for the Apps Script emulator's UrlFetchApp (Apps Script UrlFetchApp.fetch is synchronous):
// runs one fetch in a short-lived child process and returns {status, body, headers}. Test-only.
import { spawnSync } from 'node:child_process';

const CHILD = `
let s = '';
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', async () => {
  const q = JSON.parse(s);
  try {
    const r = await fetch(q.url, { method: q.method, headers: q.headers, body: q.body, redirect: 'manual' });
    process.stdout.write(JSON.stringify({ status: r.status, body: await r.text(), headers: Object.fromEntries(r.headers) }));
  } catch (e) { process.stdout.write(JSON.stringify({ error: String(e && e.message) })); }
});`;

/** UrlFetchApp-style params → {status, body, headers}; throws like UrlFetchApp on network errors. */
export function syncFetch(url, params = {}) {
  const headers = { ...(params.headers || {}) };
  if (params.contentType) headers['content-type'] = params.contentType;
  const r = spawnSync(process.execPath, ['-e', CHILD], { input: JSON.stringify({ url, method: (params.method || 'get').toUpperCase(), headers, body: params.payload }), encoding: 'utf8', timeout: 30000 });
  const out = JSON.parse(r.stdout || '{"error":"no output"}');
  if (out.error) throw new Error(`Exception: ${out.error}`);
  return out;
}

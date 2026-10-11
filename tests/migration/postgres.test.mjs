// tools/migrate.mjs against a REAL PostgreSQL (MASTER_PROMPT §18 "Migration", "Corruption", "Re-import"):
// export → validate → plan → import --dry-run → import --apply → reconcile, re-import idempotency, corrupt
// packages stopped before any write, conflicts never overwritten, ZIP path traversal refused, and resume
// of an interrupted load. Needs DATABASE_URL (npm run test:pg starts a disposable local cluster); without
// it every test here is reported as SKIPPED — never as passed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { generatePackage } from '../../tools/fixtures/generate-synthetic.mjs';
import { FsPackageHandle } from '../../src/adapters/node/fs-package.js';
import { resign, readManifest } from '../helpers/package-tools.mjs';
import { writeZip } from '../../tools/lib/zip.mjs';
import { runAsync } from '../../src/application/runtime.js';
import { processPackage } from '../../src/application/migration/process.js';
import { nodeIds, nodeCrypto } from '../../src/adapters/node/ports.js';
import { FsAttachmentStorage } from '../../src/adapters/node/fs-storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_URL = process.env.DATABASE_URL;
const skip = BASE_URL ? false : 'DATABASE_URL not set — run `npm run test:pg` (starts a local PostgreSQL)';
let dbUrl;
let dbName;
let work;
let pkgDir;

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/migrate.mjs'), ...args, '--quiet'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: dbUrl, ...env } });
  const last = r.stdout.trim().split('\n').pop();
  let out = null;
  try { out = JSON.parse(last); } catch (_) { /* no json */ }
  return { code: r.status, out, stderr: r.stderr };
}

async function sql(text, params = []) {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try { return (await c.query(text, params)).rows; } finally { await c.end(); }
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
  for (const f of fs.readdirSync(path.join(dst, 'reports'), { withFileTypes: true }).filter((x) => x.isFile())) fs.unlinkSync(path.join(dst, 'reports', f.name));
  return dst;
}

before(async () => {
  if (skip) return;
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-pgtest-'));
  dbName = `cwk_mig_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const u = new URL(BASE_URL);
  u.pathname = `/${dbName}`;
  dbUrl = u.toString();
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
  await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/roles.sql'), 'utf8'));
  await c.end();
  pkgDir = generatePackage(path.join(work, 'packages')).dir;
});

after(async () => {
  if (skip) return;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  fs.rmSync(work, { recursive: true, force: true });
});

test('validate → plan → dry-run → apply → reconcile PASS; re-import inserts nothing', { skip }, async () => {
  const att = path.join(work, 'attachments');
  const total = readManifest(new FsPackageHandle(pkgDir)).tables.reduce((s, t) => s + t.row_count, 0);
  let r = cli(['validate', '--input', pkgDir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.usable_for_cutover, true);
  r = cli(['plan', '--input', pkgDir, '--target', 'postgres']);
  assert.equal(r.code, 0, r.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(pkgDir, 'reports/plan.json'), 'utf8'));
  assert.equal(Object.values(plan.would_insert).reduce((s, n) => s + n, 0), total);
  r = cli(['import', '--input', pkgDir, '--target', 'postgres', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await sql('SELECT count(*)::int AS n FROM students'))[0].n, 0, 'dry run leaves the database untouched');
  r = cli(['import', '--input', pkgDir, '--target', 'postgres', '--apply']);
  assert.equal(r.code, 2, 'attachments need a private directory');
  r = cli(['import', '--input', pkgDir, '--target', 'postgres', '--apply', '--attachments-dir', att]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.inserted, total);
  assert.deepEqual((await sql("SELECT student_code FROM students WHERE student_code = '00123'")).map((x) => x.student_code), ['00123']);
  assert.equal((await sql("SELECT count(*)::int AS n FROM notification_outbox WHERE replay_blocked = false AND delivery_state NOT IN ('PROVIDER_ACCEPTED','FAILED_FINAL','CANCELLED')"))[0].n, 0);
  assert.equal((await sql("SELECT count(*)::int AS n FROM invitation_records WHERE code_hash <> 'REDACTED'"))[0].n, 0);
  const files = fs.readdirSync(att, { recursive: true }).filter((f) => !fs.statSync(path.join(att, f)).isDirectory());
  assert.equal(files.length, 1);
  assert.equal((fs.statSync(path.join(att, files[0])).mode & 0o077), 0, 'attachment stored privately (0600)');
  r = cli(['reconcile', '--input', pkgDir, '--target', 'postgres', '--attachments-dir', att]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.overall, 'PASS');
  assert.equal(r.out.ready_to_cutover, true);
  const rec = JSON.parse(fs.readFileSync(path.join(pkgDir, 'reports/reconciliation.json'), 'utf8'));
  assert.equal(rec.checks.find((c) => c.key === 'reports.totals').status, 'PASS');
  assert.equal(rec.checks.find((c) => c.key === 'postgres.foreign_keys').status, 'PASS');
  // re-import of the same package: nothing new, nothing duplicated
  const before = (await sql('SELECT count(*)::int AS n FROM attendance_events'))[0].n;
  r = cli(['import', '--input', pkgDir, '--target', 'postgres', '--apply', '--attachments-dir', att]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.inserted, 0);
  assert.equal(r.out.identical, total);
  assert.equal((await sql('SELECT count(*)::int AS n FROM attendance_events'))[0].n, before);
  assert.equal((await sql("SELECT count(*)::int AS n FROM storage_object_mappings"))[0].n, 1);
});

test('corrupt or incompatible packages stop before any write (exit 4 / 3); ZIP traversal refused', { skip }, async () => {
  const count = async () => (await sql('SELECT count(*)::int AS n FROM students'))[0].n;
  const n0 = await count();
  // flipped byte in a chunk
  const bad = copyDir(pkgDir, path.join(work, 'bad-checksum'));
  const h = new FsPackageHandle(bad);
  const chunk = readManifest(h).tables.find((t) => t.name === 'Students').partitions[0].chunks[0];
  const b = Buffer.from(h.readBytes(chunk.path));
  b[5] ^= 1;
  fs.writeFileSync(path.join(bad, chunk.path), b);
  let r = cli(['validate', '--input', bad]);
  assert.equal(r.code, 4);
  r = cli(['import', '--input', bad, '--target', 'postgres', '--apply', '--attachments-dir', path.join(work, 'att2')]);
  assert.equal(r.code, 4);
  assert.equal(await count(), n0);
  // unsupported schema version
  const v99 = copyDir(pkgDir, path.join(work, 'schema-99'));
  resign(new FsPackageHandle(v99), (m) => { m.schema_version = 99; });
  r = cli(['import', '--input', v99, '--target', 'postgres', '--dry-run']);
  assert.equal(r.code, 3);
  // ZIP: a packed copy validates; an entry escaping the package is refused
  const zip = path.join(work, 'small.zip');
  assert.equal(cli(['pack', '--input', pkgDir, '--out', zip]).code, 0);
  r = cli(['validate', '--input', zip, '--report-dir', path.join(work, 'zip-reports')]);
  assert.equal(r.code, 0, r.stderr);
  const evil = path.join(work, 'evil.zip');
  writeZip(evil, { 'manifest.json': '{}', '../../outside.txt': 'x' });
  r = cli(['validate', '--input', evil, '--report-dir', path.join(work, 'zip-reports')]);
  assert.equal(r.code, 4);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'outside.txt')));
  // a connection string on the command line is refused (shell history)
  r = cli(['validate', '--input', pkgDir, '--database-url', 'postgres://x@y/z']);
  assert.equal(r.code, 2);
});

test('least privilege: the cwk_migrator role (roles.sql) can import and reconcile; the reporting role cannot write', { skip }, async () => {
  const name = `${dbName}_lp`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const login = `cwk_mig_${crypto.randomBytes(3).toString('hex')}`;
  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
    await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/roles.sql'), 'utf8'));
    await c.query(`CREATE ROLE ${login} LOGIN IN ROLE cwk_migrator`);
    await c.query(`CREATE ROLE ${login}_rep LOGIN IN ROLE cwk_reporting`);
    const asRole = (role) => { const x = new URL(u.toString()); x.username = role; return x.toString(); };
    const pkg = copyDir(pkgDir, path.join(work, 'lp-package'));
    const att = path.join(work, 'lp-attachments');
    let r = cli(['import', '--input', pkg, '--target', 'postgres', '--apply', '--attachments-dir', att], { DATABASE_URL: '', MIGRATION_DATABASE_URL: asRole(login) });
    assert.equal(r.code, 0, r.stderr);
    r = cli(['reconcile', '--input', pkg, '--target', 'postgres', '--attachments-dir', att], { DATABASE_URL: '', MIGRATION_DATABASE_URL: asRole(login) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out.overall, 'PASS');
    // the migrator cannot rewrite business rows; the reporting role cannot write at all
    const m = new pg.Client({ connectionString: asRole(login) });
    await m.connect();
    await assert.rejects(m.query("UPDATE students SET first_name_th = 'x'"), /permission denied/);
    await m.end();
    const rep = new pg.Client({ connectionString: asRole(`${login}_rep`) });
    await rep.connect();
    assert.ok((await rep.query('SELECT count(*)::int AS n FROM students')).rows[0].n > 0);
    await assert.rejects(rep.query("INSERT INTO stations (id) VALUES ('11111111-1111-4111-8111-111111111111')"), /permission denied/);
    await rep.end();
  } finally {
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${login}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${login}_rep`).catch(() => {});
    await admin.end();
  }
});

test('conflict: a target row that differs is never overwritten (exit 5)', { skip }, async () => {
  await sql("UPDATE students SET first_name_th = 'แก้ในฐานข้อมูลใหม่' WHERE student_code = '00123'");
  const r = cli(['import', '--input', pkgDir, '--target', 'postgres', '--apply', '--attachments-dir', path.join(work, 'attachments'), '--import-id', crypto.randomUUID()]);
  assert.equal(r.code, 5);
  assert.equal((await sql("SELECT first_name_th FROM students WHERE student_code = '00123'"))[0].first_name_th, 'แก้ในฐานข้อมูลใหม่');
});

test('an interrupted load resumes from its staged checkpoint without duplicates', { skip }, async () => {
  // fresh database for this scenario
  const name = `${dbName}_r`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
    await c.query("SET TIME ZONE 'UTC'");
    const pgt = await import('../../tools/lib/pg-target.mjs');
    await pgt.ensureStaging(c);
    const importId = crypto.randomUUID();
    const handle = new FsPackageHandle(pkgDir);
    const manifest = readManifest(handle);
    const msha = crypto.createHash('sha256').update(handle.readBytes('manifest.json')).digest('hex');
    await c.query("INSERT INTO staging.cwk_import_runs (import_id, manifest_sha256, status) VALUES ($1, $2, 'LOADING')", [importId, msha]);
    const storage = new FsAttachmentStorage(path.join(work, 'att-resume'));
    const sha = (d) => crypto.createHash('sha256').update(typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d)).digest('hex');
    const clock = { now: () => new Date().toISOString() };
    let flushes = 0;
    const sink1 = new pgt.PgSink({ client: c, importId, mode: 'APPLY', storage, ids: nodeIds, clock, crypto: nodeCrypto });
    const flush = sink1.flush.bind(sink1);
    sink1.flush = async (st) => { if (++flushes === 12) throw new Error('process killed'); return flush(st); };
    await assert.rejects(runAsync(processPackage, handle, sink1, { sha256Hex: sha, failFast: true, checkpoint: sink1.checkpoint() }), /process killed/);
    const staged = (await c.query('SELECT count(*)::int AS n FROM staging.schools WHERE _import_id = $1', [importId])).rows[0].n
      + (await c.query('SELECT count(*)::int AS n FROM staging.terms WHERE _import_id = $1', [importId])).rows[0].n;
    const saved = (await c.query('SELECT state_json FROM staging.cwk_import_runs WHERE import_id = $1', [importId])).rows[0].state_json;
    assert.ok(staged > 0 && saved && saved.ti > 0, 'rows and checkpoint were committed together before the crash');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM public.schools')).rows[0].n, 0, 'nothing merged before the load completes');
    // resume with a new process: checkpoint and staged rows agree, so nothing is loaded twice
    const sink2 = new pgt.PgSink({ client: c, importId, mode: 'APPLY', storage, ids: nodeIds, clock, crypto: nodeCrypto });
    const res = await runAsync(processPackage, handle, sink2, { sha256Hex: sha, failFast: true, checkpoint: sink2.checkpoint() });
    await sink2.flush(null);
    assert.equal(res.report.ok, true, JSON.stringify(res.report.errors.slice(0, 3)));
    const merged = await pgt.mergeStaged(c, { importId, manifest, manifestSha: msha, tables: manifest.tables.map((t) => t.name), now: clock.now() });
    for (const t of manifest.tables) assert.equal(merged[t.name], t.row_count, `${t.name}: each row merged exactly once`);
  } finally {
    await c.end();
    const a2 = new pg.Client({ connectionString: BASE_URL });
    await a2.connect();
    await a2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a2.end();
  }
});

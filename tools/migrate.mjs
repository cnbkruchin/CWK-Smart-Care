#!/usr/bin/env node
// CWK portable package → PostgreSQL migration CLI (MASTER_PROMPT §15.5). Usage:
//   node tools/migrate.mjs validate  --input <package dir|package.zip> [--report-dir <dir>]
//   node tools/migrate.mjs plan      --input <package> --target postgres
//   node tools/migrate.mjs import    --input <package> --target postgres --dry-run
//   node tools/migrate.mjs import    --input <package> --target postgres --apply --attachments-dir <private dir> [--import-id <uuid>]
//   node tools/migrate.mjs reconcile --input <package> --target postgres [--attachments-dir <dir>]
//   node tools/migrate.mjs pack      --input <package dir> --out <small.zip>          (convenience, ≤ 200 MB)
// The connection string is read ONLY from the environment — MIGRATION_DATABASE_URL (cwk_migrator role) or
// DATABASE_URL — never from arguments, which end up in shell history. Exit codes: 0 ok · 1 data/validation/reconciliation failure · 2 usage ·
// 3 incompatible format/schema · 4 corruption (checksum/missing/unsafe) · 5 conflict with target data ·
// 6 target unavailable/not configured · 10 internal error.
// Reports (JSON) go to <report-dir> (default: <package>/reports/ for a directory input).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runAsync } from '../src/application/runtime.js';
import { processPackage, CORRUPTION_CODES, INCOMPATIBLE_CODES } from '../src/application/migration/process.js';
import { IndexSink } from '../src/application/migration/sinks.js';
import { reconcile } from '../src/application/migration/reconcile.js';
import { summarizeImport } from '../src/application/migration/import.js';
import { FsPackageHandle } from '../src/adapters/node/fs-package.js';
import { FsAttachmentStorage } from '../src/adapters/node/fs-storage.js';
import { nodeIds, nodeCrypto } from '../src/adapters/node/ports.js';
import { extractZip, writeZip, ZipError } from './lib/zip.mjs';

export const EXIT = { OK: 0, DATA: 1, USAGE: 2, INCOMPATIBLE: 3, CORRUPTION: 4, CONFLICT: 5, TARGET: 6, INTERNAL: 10 };
const sha = (d) => crypto.createHash('sha256').update(typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d)).digest('hex');
const clock = { now: () => new Date().toISOString() };

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { _: cmd };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw usage(`unexpected argument: ${a}`);
    const k = a.slice(2);
    if (['dry-run', 'apply', 'quiet', 'json'].includes(k)) o[k] = true;
    else o[k] = rest[++i];
  }
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && /^postgres(ql)?:\/\//i.test(v)) throw usage('connection strings must not be passed as arguments — set DATABASE_URL in the environment');
  }
  if (o['database-url'] !== undefined) throw usage('--database-url is not supported — set DATABASE_URL in the environment');
  return o;
}

function usage(msg) { return Object.assign(new Error(msg), { exitCode: EXIT.USAGE }); }

function log(o, ...a) { if (!o.quiet) process.stderr.write(a.join(' ') + '\n'); }

function openInput(o) {
  if (!o.input) throw usage('--input is required');
  const p = path.resolve(o.input);
  if (!fs.existsSync(p)) throw usage(`input not found: ${o.input}`);
  if (fs.statSync(p).isDirectory()) return { handle: new FsPackageHandle(p), dir: p, reportDir: o['report-dir'] ? path.resolve(o['report-dir']) : path.join(p, 'reports') };
  if (!p.endsWith('.zip')) throw usage('input must be a package directory or a .zip');
  const work = fs.mkdtempSync(path.join(o['work-dir'] ? path.resolve(o['work-dir']) : os.tmpdir(), 'cwk-pkg-'));
  extractZip(p, work);
  return { handle: new FsPackageHandle(work), dir: work, reportDir: o['report-dir'] ? path.resolve(o['report-dir']) : path.resolve('migration-reports'), extracted: true };
}

function writeReport(dir, name, obj) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  return file;
}

function exitFor(report) {
  if (report.ok) return EXIT.OK;
  if (report.hasCode(INCOMPATIBLE_CODES)) return EXIT.INCOMPATIBLE;
  if (report.hasCode(CORRUPTION_CODES)) return EXIT.CORRUPTION;
  if (report.errors.some((e) => e.code === 'CONFLICT')) return EXIT.CONFLICT;
  return EXIT.DATA;
}

const progress = (o, label) => (p) => log(o, `[${label}] ${p.table} (${p.table_no}/${p.tables}) chunk ${p.chunk}/${p.chunks} rows=${p.rows}`);

async function validate(o, input) {
  const res = await runAsync(processPackage, input.handle, new IndexSink(), { sha256Hex: sha, level: 'FULL', onProgress: o.quiet ? null : progress(o, 'validate') });
  const m = res.manifest;
  const usable = res.report.ok && !!m && m.completeness === 'COMPLETE' && m.mode === 'FULL_SNAPSHOT' && m.kind === 'SNAPSHOT';
  const out = { format: 'cwk-validation', level: 'FULL', validated_at: clock.now(), validated_by: 'tools/migrate.mjs', manifest_sha256: res.manifest_sha256 || null, export_id: m ? m.export_id : null, ok: res.report.ok, completeness: m ? m.completeness : null, usable_for_cutover: usable, report: res.report.toJSON() };
  return { res, out };
}

async function cmdValidate(o) {
  const input = openInput(o);
  const { res, out } = await validate(o, input);
  const file = writeReport(input.reportDir, 'validation.json', out);
  log(o, `validation ${out.ok ? 'PASSED' : 'FAILED'} — ${res.report.error_count} error(s); completeness ${out.completeness}; usable for cutover: ${out.usable_for_cutover}; report: ${file}`);
  for (const e of res.report.errors.slice(0, 10)) log(o, `  ${e.code} ${e.table || ''} ${e.path || ''} ${e.id || ''} ${e.column || ''} ${e.message || ''}`.replace(/ +/g, ' '));
  process.stdout.write(JSON.stringify({ ok: out.ok, errors: res.report.error_count, completeness: out.completeness, usable_for_cutover: out.usable_for_cutover, report: file }) + '\n');
  return exitFor(res.report);
}

async function withPg(o, fn) {
  if (o.target !== 'postgres') throw usage('--target postgres is required');
  const { connect, checkTargetSchema } = await import('./lib/pg-target.mjs');
  let client;
  try { client = await connect(); } catch (e) { const err = new Error(`cannot connect to PostgreSQL: ${e.message}`); err.exitCode = e.exitCode || EXIT.TARGET; throw err; }
  try {
    const schema = await checkTargetSchema(client);
    if (!schema.ok) throw Object.assign(new Error(`target not ready: ${schema.reason}`), { exitCode: schema.version && schema.version !== 1 ? EXIT.INCOMPATIBLE : EXIT.TARGET });
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function cmdPlanOrImport(o) {
  const mode = o._ === 'plan' ? 'PLAN' : o.apply ? 'APPLY' : o['dry-run'] ? 'DRY_RUN' : null;
  if (!mode) throw usage('import needs --dry-run or --apply');
  if (o.apply && o['dry-run']) throw usage('choose one of --dry-run / --apply');
  const input = openInput(o);
  // 1) full validation first: nothing touches the target when the package is not sound
  const { res: v, out: vout } = await validate(o, input);
  writeReport(input.reportDir, 'validation.json', vout);
  if (!v.report.ok) {
    log(o, `package validation FAILED (${v.report.error_count} errors) — nothing was written to the target`);
    for (const e of v.report.errors.slice(0, 10)) log(o, `  ${e.code} ${e.table || ''} ${e.path || ''} ${e.id || ''}`);
    return exitFor(v.report);
  }
  const manifest = v.manifest;
  if (manifest.kind !== 'SNAPSHOT') throw usage('only SNAPSHOT packages can be imported into PostgreSQL (DELTA packages go back to the source system)');
  return withPg(o, async (client) => {
    const pgt = await import('./lib/pg-target.mjs');
    let storage = null;
    if (manifest.attachments.included && manifest.attachments.files > 0) {
      if (mode === 'APPLY' && !o['attachments-dir']) throw usage('--attachments-dir (private directory) is required to import attachments');
      storage = new FsAttachmentStorage(o['attachments-dir'] || fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-att-dry-')));
    }
    const importId = o['import-id'] || (mode === 'APPLY' ? uuidFromSha(v.manifest_sha256) : nodeIds.uuid());
    const startedAt = clock.now();
    await pgt.ensureStaging(client);
    if (mode === 'APPLY') {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['cwk-import']);
      const prev = await client.query('SELECT status, manifest_sha256 FROM staging.cwk_import_runs WHERE import_id = $1', [importId]);
      if (prev.rows.length && prev.rows[0].manifest_sha256 !== v.manifest_sha256) throw Object.assign(new Error('import id belongs to another package'), { exitCode: EXIT.USAGE });
      if (!prev.rows.length) await client.query("INSERT INTO staging.cwk_import_runs (import_id, manifest_sha256, export_id, status) VALUES ($1, $2, $3, 'LOADING')", [importId, v.manifest_sha256, manifest.export_id]);
      else if (prev.rows[0].status === 'MERGED') log(o, `import ${importId} was merged before — re-running checks only (identical rows are skipped)`);
      else log(o, `resuming import ${importId} from its checkpoint`);
      if (prev.rows.length && ['MERGED', 'FAILED'].includes(prev.rows[0].status)) await client.query("UPDATE staging.cwk_import_runs SET status = 'LOADING', state_json = NULL WHERE import_id = $1", [importId]);
    }
    if (mode === 'DRY_RUN') await client.query('BEGIN');
    try {
      const sink = new pgt.PgSink({ client, importId, mode, storage, ids: nodeIds, clock, crypto: nodeCrypto });
      const res = await runAsync(processPackage, input.handle, sink, {
        sha256Hex: sha, failFast: mode === 'APPLY', checkpoint: sink.checkpoint(), onProgress: o.quiet ? null : progress(o, mode.toLowerCase()),
      });
      await sink.flush(null);
      let merged = null;
      if (res.report.ok && mode !== 'PLAN') {
        try {
          merged = await pgt.mergeStaged(client, { importId, manifest, manifestSha: v.manifest_sha256, tables: manifest.tables.map((t) => t.name), inTransaction: mode === 'DRY_RUN', now: clock.now() });
        } catch (e) {
          res.report.error('MERGE_FAILED', { message: `${e.code || ''} ${e.message}`.trim(), table: e.table || null, detail: e.detail || null });
        }
      }
      const report = summarizeImport(res, { target: 'postgres', importId, mode: mode === 'APPLY' ? 'APPLY' : mode, startedAt, finishedAt: clock.now() });
      if (merged) report.merged = merged;
      report.would_insert = mode !== 'APPLY' ? Object.fromEntries(Object.entries(res.report.tables).map(([t, x]) => [t, x.rows - x.identical - x.conflicts])) : undefined;
      if (mode === 'APPLY' && !res.report.ok) {
        // nothing was merged; drop this attempt's staged rows so the target stays clean
        await pgt.clearStaging(client, importId);
        await client.query("UPDATE staging.cwk_import_runs SET status = 'FAILED', state_json = NULL, report_json = $2, updated_at = now() WHERE import_id = $1", [importId, JSON.stringify({ errors: res.report.error_count })]);
      }
      if (mode === 'APPLY' && res.report.ok) {
        report.rows_inserted = Object.entries(merged || {}).filter(([t]) => t !== 'StorageObjectMappings').reduce((s, [, n]) => s + n, 0);
        await pgt.clearStaging(client, importId);
        await client.query("UPDATE staging.cwk_import_runs SET status = 'MERGED', report_json = $2, updated_at = now() WHERE import_id = $1", [importId, JSON.stringify({ rows_inserted: report.rows_inserted })]);
      }
      const name = mode === 'APPLY' ? 'import.json' : mode === 'DRY_RUN' ? 'import-dry-run.json' : 'plan.json';
      const file = writeReport(input.reportDir, name, report);
      const would = report.would_insert ? Object.values(report.would_insert).reduce((x, n) => x + n, 0) : null;
      log(o, `${mode} ${report.ok ? 'OK' : 'FAILED'} — ${mode === 'APPLY' ? `inserted ${report.rows_inserted}` : `would insert ${would}`}, identical ${report.rows_identical}, conflicts ${report.conflicts}, errors ${report.error_count}; report: ${file}`);
      for (const e of report.errors.slice(0, 10)) log(o, `  ${e.code} ${e.table || ''} ${e.id || ''} ${e.message || ''}`);
      process.stdout.write(JSON.stringify({ ok: report.ok, mode, import_id: importId, inserted: report.rows_inserted, would_insert: would, identical: report.rows_identical, conflicts: report.conflicts, errors: report.error_count, report: file }) + '\n');
      return exitFor(res.report);
    } finally {
      if (mode === 'DRY_RUN') await client.query('ROLLBACK').catch(() => {});
      if (mode === 'APPLY') await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['cwk-import']).catch(() => {});
    }
  });
}

function uuidFromSha(hex) {
  const h = hex.slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

async function cmdReconcile(o) {
  const input = openInput(o);
  return withPg(o, async (client) => {
    const { PgTarget } = await import('./lib/pg-target.mjs');
    const manifest = JSON.parse(input.handle.readText('manifest.json') || 'null');
    const storage = o['attachments-dir'] ? new FsAttachmentStorage(o['attachments-dir']) : null;
    const target = new PgTarget({ client, storage, crypto: nodeCrypto, clock, ids: nodeIds, timezone: manifest ? manifest.snapshot.timezone : 'Asia/Bangkok' });
    const res = await runAsync(reconcile, input.handle, target, { sha256Hex: sha, now: clock.now() });
    const file = writeReport(input.reportDir, 'reconciliation.json', res.result);
    log(o, `reconciliation ${res.result.overall} — ready to cutover: ${res.result.ready_to_cutover}; report: ${file}`);
    for (const c of res.result.checks) log(o, `  ${c.status.padEnd(7)} ${c.key} — ${c.detail_th}`);
    process.stdout.write(JSON.stringify({ overall: res.result.overall, ready_to_cutover: res.result.ready_to_cutover, failed: res.result.checks.filter((c) => c.status === 'FAIL').map((c) => c.key), report: file }) + '\n');
    return res.result.overall === 'PASS' ? EXIT.OK : EXIT.DATA;
  });
}

function cmdPack(o) {
  if (!o.input || !o.out) throw usage('pack needs --input <dir> --out <file.zip>');
  const h = new FsPackageHandle(path.resolve(o.input));
  const files = {};
  let total = 0;
  for (const f of h.list()) { if (f.symlink) continue; total += f.size; files[f.path] = Buffer.from(h.readBytes(f.path)); }
  if (total > 200 * 1024 * 1024) throw usage('package too large for ZIP — keep it as a directory (ZIP is a convenience for small packages only)');
  writeZip(path.resolve(o.out), files);
  log(o, `wrote ${o.out} (${Object.keys(files).length} files, ${total} bytes, stored)`);
  return EXIT.OK;
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try {
    o = parseArgs(argv);
    switch (o._) {
      case 'validate': return await cmdValidate(o);
      case 'plan': case 'import': return await cmdPlanOrImport(o);
      case 'reconcile': return await cmdReconcile(o);
      case 'pack': return cmdPack(o);
      default: throw usage('commands: validate | plan | import | reconcile | pack (see header of tools/migrate.mjs)');
    }
  } catch (e) {
    const code = e.exitCode || (e instanceof ZipError ? (e.code === 'UNSAFE_PATH' || e.code === 'SYMLINK' || e.code === 'CHECKSUM_MISMATCH' ? EXIT.CORRUPTION : EXIT.INCOMPATIBLE) : EXIT.INTERNAL);
    process.stderr.write(`error: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ ok: false, error: e.code || 'ERROR', message: e.message, exit_code: code }) + '\n');
    return code;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((c) => process.exit(c));

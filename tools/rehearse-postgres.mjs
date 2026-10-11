#!/usr/bin/env node
// Migration rehearsal on synthetic data (docs/MIGRATION_RUNBOOK_TH.md §3): generate a synthetic package,
// then validate → plan → import --dry-run → import --apply → reconcile against DATABASE_URL, timing every
// step. Safe for a disposable database only (refuses a database that already holds students).
//   DATABASE_URL=... node tools/rehearse-postgres.mjs [--init-schema] [--work <dir>]
// docker compose: `docker compose run --rm migrate` (see docker-compose.yml).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { main as migrate } from './migrate.mjs';
import { generatePackage } from './fixtures/generate-synthetic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const work = path.resolve(args.includes('--work') ? args[args.indexOf('--work') + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-rehearsal-')));

async function run() {
  if (!process.env.DATABASE_URL) { process.stderr.write('DATABASE_URL is required (environment only)\n'); return 6; }
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const has = (await c.query("SELECT to_regclass('public.students') AS t")).rows[0].t;
    if (!has) {
      if (!args.includes('--init-schema')) { process.stderr.write('schema missing — pass --init-schema to apply database/postgres/migrations/0001_init.sql\n'); return 6; }
      await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
      await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/roles.sql'), 'utf8'));
    } else if ((await c.query('SELECT count(*)::int AS n FROM students')).rows[0].n > 0) {
      process.stderr.write('refusing to rehearse on a database that already has students — use a disposable database\n');
      return 6;
    }
  } finally { await c.end(); }
  const steps = [];
  const time = async (name, argv) => {
    const t0 = Date.now();
    const code = await migrate([...argv, '--quiet']);
    steps.push({ step: name, exit_code: code, ms: Date.now() - t0 });
    return code;
  };
  const t0 = Date.now();
  const { dir } = generatePackage(path.join(work, 'packages'));
  steps.push({ step: 'export (synthetic, in memory)', exit_code: 0, ms: Date.now() - t0 });
  const att = path.join(work, 'attachments');
  for (const [name, argv] of [
    ['validate', ['validate', '--input', dir]],
    ['plan', ['plan', '--input', dir, '--target', 'postgres']],
    ['import --dry-run', ['import', '--input', dir, '--target', 'postgres', '--dry-run']],
    ['import --apply', ['import', '--input', dir, '--target', 'postgres', '--apply', '--attachments-dir', att]],
    ['reconcile', ['reconcile', '--input', dir, '--target', 'postgres', '--attachments-dir', att]],
  ]) {
    if (await time(name, argv) !== 0) break;
  }
  const ok = steps.every((s) => s.exit_code === 0) && steps.length === 6;
  process.stdout.write(JSON.stringify({ ok, package: dir, reports: path.join(dir, 'reports'), steps }, null, 2) + '\n');
  return ok ? 0 : 1;
}

run().then((c) => process.exit(c), (e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(10); });

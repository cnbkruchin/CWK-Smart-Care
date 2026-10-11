#!/usr/bin/env node
// Administration CLI of the reference REST backend (the counterpart of the Apps Script admin* functions).
// Connection strings come from the environment only — never from arguments (shell history).
//
//   DATABASE_OWNER_URL=… node future-platform/api/admin.mjs init-db [--app-login <role>]
//        apply database/postgres/migrations/0001_init.sql when the schema is missing, then roles.sql (idempotent).
//        --app-login creates/updates a LOGIN role in group cwk_app; its password is read from APP_LOGIN_PASSWORD.
//   DATABASE_URL=… API_ENV=… node future-platform/api/admin.mjs bootstrap --admin-email <email> [--school-code CWK]
//        [--school-name-th …] [--admin-name …] [--rule-effective-from YYYY-MM-DD]
//        first school + system user + first administrator; prints the one-time invitation code (24 h) ONCE.
//   DATABASE_URL=… API_ENV=DEV|STAGING node future-platform/api/admin.mjs seed-demo   synthetic demo data (refused in PROD)
//   DATABASE_URL=… node future-platform/api/admin.mjs set-mode NORMAL|READ_ONLY
//   DATABASE_URL=… node future-platform/api/admin.mjs status
//   DATABASE_URL=… node future-platform/api/admin.mjs export-delta --base-package <dir of the imported package> --out <dir>
//        rollback after cutover (docs/MIGRATION_RUNBOOK_TH.md §5): every row changed on THIS database after the
//        imported snapshot's high-water mark → a DELTA package for adminApplyDelta on the previous system.
//        Refused unless the database is READ_ONLY (set-mode READ_ONLY first).
// Exit codes: 0 OK, 2 usage, 3 database/schema, 10 internal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgStore } from '../../src/adapters/postgres/pg-store.js';
import { runAsync } from '../../src/application/runtime.js';
import { bootstrapInstallation } from '../../src/application/bootstrap.js';
import { seedDemoData } from '../../src/application/demo-seed.js';
import { SCHEMA_VERSION } from '../../src/schema/index.js';
import { SYSTEM_USER_ID } from '../../src/shared/uuid.js';
import { CUTOVER_SETTING } from '../../src/application/ops/migration.js';
import { buildDeps } from './src/deps.mjs';
import { exportDelta } from '../../src/application/migration/delta.js';
import { FsPackageStore } from '../../src/adapters/node/fs-package.js';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const fail = (code, message) => { process.stderr.write(`${message}\n`); process.exit(code); };

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(a);
  }
  for (const v of Object.values(o)) if (typeof v === 'string' && /^postgres(ql)?:\/\//i.test(v)) fail(2, 'connection strings are read from the environment only (DATABASE_URL / DATABASE_OWNER_URL)');
  return o;
}

/** Minimal configuration for admin commands (no HTTP settings, no identity). */
function adminConfig(env = process.env) {
  if (!env.DATABASE_URL) fail(2, 'DATABASE_URL is not set');
  return {
    env: env.API_ENV || 'DEV', authMode: 'DEMO', timezone: env.API_TIMEZONE || 'Asia/Bangkok', publicUrl: env.API_PUBLIC_URL || null,
    storageDir: env.STORAGE_DIR || './.local/storage', exportDir: env.EXPORT_DIR || './.local/exports', lineWebhookKeyId: null, lineWebhookSecret: null,
  };
}

async function initDb(o) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) fail(2, 'DATABASE_OWNER_URL (schema owner) is not set');
  const c = new pg.Client({ connectionString: url, application_name: 'cwk-admin' });
  await c.connect();
  try {
    const installed = (await c.query("SELECT to_regclass('public.schema_versions') IS NOT NULL AS t")).rows[0].t;
    let applied = false;
    if (!installed) {
      await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/migrations/0001_init.sql'), 'utf8'));
      applied = true;
    }
    const v = Number((await c.query("SELECT max(schema_version) AS v FROM schema_versions WHERE component = 'POSTGRES'")).rows[0].v);
    if (v !== SCHEMA_VERSION) fail(3, `database schema_version ${v} ≠ code ${SCHEMA_VERSION}: an upgrade migration is required (none exists for this version)`);
    await c.query(fs.readFileSync(path.join(ROOT, 'database/postgres/roles.sql'), 'utf8'));
    let login = null;
    if (typeof o['app-login'] === 'string') {
      const role = o['app-login'];
      if (!/^[a-z_][a-z0-9_]{2,40}$/.test(role)) fail(2, 'invalid role name');
      const pw = process.env.APP_LOGIN_PASSWORD;
      if (!pw || pw.length < 12) fail(2, 'APP_LOGIN_PASSWORD (≥ 12 characters) is required for --app-login');
      const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length;
      await c.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${c.escapeIdentifier(role)} LOGIN PASSWORD ${c.escapeLiteral(pw)}`);
      await c.query(`GRANT cwk_app TO ${c.escapeIdentifier(role)}`);
      login = role;
    }
    out({ ok: true, schema_applied: applied, schema_version: v, roles: 'applied', app_login: login });
  } finally {
    await c.end();
  }
}

async function withDeps(fn) {
  const config = adminConfig();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, application_name: 'cwk-admin' });
  try {
    const store = new PgStore({ pool, timezone: process.env.API_TIMEZONE || 'Asia/Bangkok' });
    const ready = await store.ready();
    if (!ready.ok) fail(3, `schema_version ${ready.schema_version} ≠ ${SCHEMA_VERSION} — run init-db first`);
    const deps = buildDeps({ config, pool, identity: { verifyCredential: () => { throw new Error('no identity in admin CLI'); } } });
    deps.config.systemMode = await store.systemMode();
    return await fn(deps, store);
  } finally {
    await pool.end();
  }
}

async function main() {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'init-db') return initDb(o);
  if (cmd === 'bootstrap') {
    const email = o['admin-email'];
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(2, '--admin-email <email> is required');
    return withDeps(async (deps) => {
      const res = await runAsync(bootstrapInstallation, deps, {
        school_code: typeof o['school-code'] === 'string' ? o['school-code'] : 'CWK', school_name_th: typeof o['school-name-th'] === 'string' ? o['school-name-th'] : 'โรงเรียนจุนวิทยาคม',
        unit_th: 'กลุ่มบริหารงานกิจการนักเรียน', admin_display_name: typeof o['admin-name'] === 'string' ? o['admin-name'] : 'ผู้ดูแลระบบคนแรก', admin_email: email,
        rule_effective_from: typeof o['rule-effective-from'] === 'string' ? o['rule-effective-from'] : '2026-01-01',
      });
      const r = { ok: true, created: res.created, school_id: res.school_id };
      if (res.invitation_code) {
        r.bootstrap_invitation_code = res.invitation_code;
        r.next_th = `เข้าสู่ระบบด้วยอีเมล ${email} (ยืนยันอีเมลแล้ว) แล้วกรอกรหัสคำเชิญนี้ภายใน 24 ชั่วโมง — รหัสแสดงครั้งเดียว`;
      }
      out(r);
    });
  }
  if (cmd === 'seed-demo') {
    if ((process.env.API_ENV || 'DEV') === 'PROD') fail(2, 'demo data is refused in PROD');
    return withDeps(async (deps) => {
      const res = await runAsync(seedDemoData, deps, { start_year_ce: Number(o['start-year'] || 2026), grades: ['M1', 'M2'], rooms_per_grade: 2, students_per_class: 10, guardian_accounts: 5 });
      out({ ok: true, ...res, note_th: 'ข้อมูลสังเคราะห์เท่านั้น — เข้าสู่ระบบ DEMO ด้วย user_id ข้างบนและ API_DEMO_PASSPHRASE' });
    });
  }
  if (cmd === 'set-mode') {
    const mode = o._[1];
    if (!['NORMAL', 'READ_ONLY'].includes(mode)) fail(2, 'set-mode NORMAL|READ_ONLY');
    return withDeps(async (deps, store) => {
      const cut = (await store.findBy('Settings', 'key', CUTOVER_SETTING))[0];
      if (mode === 'NORMAL' && cut && cut.value_json && cut.value_json.run_id && !cut.value_json.cleared_at) fail(2, 'cutover active: this database is an archive — record a rollback in the Migration Center first');
      await store.setSystemMode(mode, SYSTEM_USER_ID);
      out({ ok: true, mode });
    });
  }
  if (cmd === 'status') {
    return withDeps(async (deps, store) => {
      out({ ok: true, schema_version: await store.schemaVersion(), system_mode: await store.systemMode(), schools: await store.count('Schools'), users: await store.count('Users'), students: await store.count('Students'), jobs_queued: (await store.list('Jobs', { where: { status: 'QUEUED' }, all: true })).items.length });
    });
  }
  if (cmd === 'export-delta') {
    if (typeof o['base-package'] !== 'string' || typeof o.out !== 'string') fail(2, 'export-delta --base-package <dir> --out <dir>');
    let base;
    try { base = JSON.parse(fs.readFileSync(path.join(o['base-package'], 'manifest.json'), 'utf8')); } catch (_) { fail(2, 'cannot read manifest.json of --base-package'); }
    if (base.kind !== 'SNAPSHOT' || !base.snapshot || !base.snapshot.high_water_mark) fail(2, '--base-package must be the SNAPSHOT package this database was imported from');
    return withDeps(async (deps, store) => {
      if ((await store.systemMode()) !== 'READ_ONLY') fail(2, 'freeze first: admin.mjs set-mode READ_ONLY (no writes may happen while the delta is exported)');
      deps.config.systemMode = 'READ_ONLY';
      const ps = new FsPackageStore(o.out);
      const handle = ps.open(ps.create(`cwk-delta-${new Date().toISOString().slice(0, 10)}-${base.export_id.slice(0, 8)}`));
      const res = await runAsync(exportDelta, deps, { sinceSeq: base.snapshot.high_water_mark.change_log_seq, baseExportId: base.export_id, handle, exportId: crypto.randomUUID(), frozen: true, platformName: 'POSTGRES' });
      out({ ok: true, package: handle.root, rows: res.rows, from_seq: base.snapshot.high_water_mark.change_log_seq, to_seq: res.to_seq, completeness: res.manifest.completeness, next_th: 'อัปโหลดทั้งโฟลเดอร์ขึ้น Drive ส่วนตัวของระบบเดิม แล้วรัน adminApplyDelta แบบ DRY_RUN ก่อน APPLY (docs/MIGRATION_RUNBOOK_TH.md)' });
    });
  }
  fail(2, 'usage: admin.mjs init-db | bootstrap --admin-email <email> | seed-demo | set-mode NORMAL|READ_ONLY | status | export-delta --base-package <dir> --out <dir>');
  return undefined;
}

main().catch((e) => {
  process.stderr.write(`${e && e.code ? `${e.code}: ` : ''}${String(e && e.message ? e.message : e).slice(0, 300)}\n`);
  process.exit(e && e.code === 'STORAGE_UNAVAILABLE' ? 3 : 10);
});

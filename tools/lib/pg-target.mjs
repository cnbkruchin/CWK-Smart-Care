// PostgreSQL target for tools/migrate.mjs (MASTER_PROMPT §15.5): the same processPackage() checks as every
// other importer, with
//   - a staging schema: chunks are loaded into staging.<table> together with the resumable checkpoint in ONE
//     transaction per chunk (a crash never leaves staged rows without their checkpoint, or the reverse);
//   - ONE merge transaction into public tables in dependency order (deferred FKs checked at the end), so a
//     failed merge writes nothing;
//   - attachments copied to a private filesystem storage by logical ID with a NEW mapping row;
//   - parameterized SQL only (identifiers come from the schema module, never from the package).
// Modes: PLAN (read-only counts), DRY_RUN (load + merge inside a transaction, then ROLLBACK), APPLY.
import pg from 'pg';
import { TABLES, getTable, SCHEMA_VERSION } from '../../src/schema/index.js';
import { SQL_TABLE } from '../../src/schema/sql.js';
import { canonicalRecord, EXCLUDED_TABLES, exportTables } from '../../src/application/migration/format.js';
import { uniqueKeyOf } from '../../src/application/migration/process.js';
import { predicateColumns } from '../../src/application/migration/sinks.js';
import { uniqueKeys } from '../../src/schema/index.js';
import { SYSTEM_USER_ID } from '../../src/shared/uuid.js';
import { partitionFor } from '../../src/application/changeset.js';
import { MemoryStore } from '../../src/adapters/memory/memory-store.js';

// keep DATE/TIMESTAMP as text; canonical conversion happens in SQL (to_char) and canonicalRecord()
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => v);
pg.types.setTypeParser(1184, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

const q = (name) => `"${name.replace(/"/g, '""')}"`;
const STAGING_TABLES = [...exportTables(), 'StorageObjectMappings'];

export async function connect() {
  // the migration role (cwk_migrator, database/postgres/roles.sql) is preferred when configured
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw Object.assign(new Error('MIGRATION_DATABASE_URL / DATABASE_URL is not set (read from the environment only)'), { exitCode: 6 });
  const client = new pg.Client({ connectionString: url, application_name: 'cwk-migrate' });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}

/** SELECT list that returns canonical text for dates/timestamps (all columns, or the named ones). */
export function selectList(table, only = null) {
  const p = '';
  return getTable(table).columns.filter((c) => !only || only.includes(c.name)).map((c) => {
    if (c.type === 'ts') return `to_char(${p}${c.name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${c.name}`;
    if (c.type === 'date') return `to_char(${p}${c.name}, 'YYYY-MM-DD') AS ${c.name}`;
    return `${p}${c.name}`;
  }).join(', ');
}

function paramValue(c, v) {
  if (v === null || v === undefined) return null;
  if (c.type === 'json') return JSON.stringify(v);
  return v;
}

async function insertRows(client, schema, table, records, extra = {}) {
  if (!records.length) return 0;
  const cols = getTable(table).columns;
  const extraCols = Object.keys(extra);
  const width = cols.length + extraCols.length;
  const per = Math.max(1, Math.floor(60000 / width));
  let n = 0;
  for (let i = 0; i < records.length; i += per) {
    const slice = records.slice(i, i + per);
    const values = [];
    const tuples = slice.map((r, k) => {
      const base = k * width;
      cols.forEach((c) => values.push(paramValue(c, r[c.name])));
      extraCols.forEach((x) => values.push(extra[x]));
      return `(${Array.from({ length: width }, (_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    const sql = `INSERT INTO ${schema}.${SQL_TABLE[table]} (${[...cols.map((c) => c.name), ...extraCols].join(', ')}) VALUES ${tuples.join(', ')}`;
    const res = await client.query(sql, values);
    n += res.rowCount;
  }
  return n;
}

export async function checkTargetSchema(client) {
  const exists = await client.query("SELECT to_regclass('public.schema_versions') AS t");
  if (!exists.rows[0].t) return { ok: false, reason: 'schema not installed (run database/postgres/migrations/0001_init.sql)' };
  const v = await client.query("SELECT schema_version FROM public.schema_versions WHERE component = 'POSTGRES' ORDER BY schema_version DESC LIMIT 1");
  const version = v.rows.length ? v.rows[0].schema_version : null;
  const missing = [];
  for (const t of TABLES) {
    const r = await client.query('SELECT to_regclass($1) AS t', [`public.${SQL_TABLE[t.name]}`]);
    if (!r.rows[0].t) missing.push(t.name);
  }
  return { ok: version === SCHEMA_VERSION && !missing.length, version, missing, reason: version !== SCHEMA_VERSION ? `target schema_version ${version}, expected ${SCHEMA_VERSION}` : missing.length ? `missing tables: ${missing.join(', ')}` : null };
}

export async function ensureStaging(client) {
  // 0001_init.sql creates the staging schema; the migrator role only has USAGE+CREATE on it
  if (!(await client.query("SELECT to_regnamespace('staging') AS s")).rows[0].s) await client.query('CREATE SCHEMA staging');
  await client.query(`CREATE TABLE IF NOT EXISTS staging.cwk_import_runs (
    import_id uuid PRIMARY KEY, manifest_sha256 text NOT NULL, export_id uuid, status text NOT NULL,
    state_json jsonb, report_json jsonb, started_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  for (const t of STAGING_TABLES) {
    const st = SQL_TABLE[t];
    await client.query(`CREATE TABLE IF NOT EXISTS staging.${st} (LIKE public.${st} INCLUDING DEFAULTS)`);
    await client.query(`ALTER TABLE staging.${st} ADD COLUMN IF NOT EXISTS _import_id uuid`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${st}_import_ix ON staging.${st} (_import_id)`);
  }
}

/** processPackage sink backed by PostgreSQL (generator methods yield promises → run with runAsync). */
export class PgSink {
  constructor({ client, importId, mode, storage, ids, clock, crypto }) {
    Object.assign(this, { client, importId, pgMode: mode, storage, ids, clock, crypto });
    this.name = 'postgres';
    this.mode = 'IMPORT';
    this.conflictPolicy = 'REJECT';
    this.pending = [];
    this.pendingMappings = [];
    if (mode === 'PLAN') { this.append = function* () { return { inserted: 0 }; }; this.attachment = function* () { return { written: false }; }; }
  }
  *loadIndex(table) {
    const cols = ['id', ...predicateColumns(table).filter((c) => c !== 'id')];
    const sel = selectList(table, cols);
    let rows = (yield this.client.query(`SELECT ${sel} FROM public.${SQL_TABLE[table]}`)).rows;
    if (this.pgMode !== 'PLAN') rows = rows.concat((yield this.client.query(`SELECT ${sel} FROM staging.${SQL_TABLE[table]} WHERE _import_id = $1`, [this.importId])).rows);
    const uniques = [];
    uniqueKeys(table).forEach((u, index) => { for (const r of rows) { const key = uniqueKeyOf(u, r); if (key !== null) uniques.push({ index, key, id: r.id }); } });
    return { ids: rows.map((r) => r.id), uniques };
  }
  *existing(table, _partition, ids) {
    const res = yield this.client.query(`SELECT ${selectList(table)} FROM public.${SQL_TABLE[table]} WHERE id = ANY($1::uuid[])`, [ids]);
    return new Map(res.rows.map((r) => [r.id, canonicalRecord(table, r)]));
  }
  *terms() {
    return (yield this.client.query(`SELECT code, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date FROM public.terms`)).rows;
  }
  *append(table, _partition, records) {
    this.pending.push({ table, records });
    return { inserted: records.length };
  }
  *attachment(entry, bytes) {
    const ex = (yield this.client.query("SELECT object_key FROM public.storage_object_mappings WHERE attachment_id = $1 AND provider = 'FILESYSTEM' AND status = 'ACTIVE'", [entry.logical_id])).rows;
    for (const m of ex) { const meta = this.storage.metadata(m); if (meta && meta.sha256 === entry.sha256) return { written: false }; }
    const stored = this.storage.put(entry.logical_id, bytes, { mime: entry.mime_type });
    const now = this.clock.now();
    this.pendingMappings.push(canonicalRecord('StorageObjectMappings', {
      id: this.ids.uuid(), attachment_id: entry.logical_id, provider: stored.provider, object_key: stored.object_key, container: stored.container, status: 'ACTIVE',
      sha256_verified_at: now, created_at: now, created_by: SYSTEM_USER_ID, updated_at: now, updated_by: SYSTEM_USER_ID, version: 1,
    }));
    return { written: true };
  }
  /** Flush buffered rows to staging (+ the checkpoint state in APPLY mode) atomically. */
  async flush(state) {
    if (this.pgMode === 'PLAN') return;
    const own = this.pgMode === 'APPLY';
    if (own) await this.client.query('BEGIN');
    try {
      for (const p of this.pending) await insertRows(this.client, 'staging', p.table, p.records, { _import_id: this.importId });
      await insertRows(this.client, 'staging', 'StorageObjectMappings', this.pendingMappings, { _import_id: this.importId });
      if (own && state) await this.client.query('UPDATE staging.cwk_import_runs SET state_json = $2, updated_at = now() WHERE import_id = $1', [this.importId, JSON.stringify(state)]);
      if (own) await this.client.query('COMMIT');
    } catch (e) {
      if (own) await this.client.query('ROLLBACK');
      throw e;
    }
    this.pending = [];
    this.pendingMappings = [];
  }
  checkpoint() {
    const self = this;
    return {
      *load() {
        if (self.pgMode !== 'APPLY') return null;
        const r = yield self.client.query("SELECT state_json FROM staging.cwk_import_runs WHERE import_id = $1 AND status = 'LOADING'", [self.importId]);
        return r.rows.length ? r.rows[0].state_json : null;
      },
      *save(state) { yield self.flush(state); },
    };
  }
}

/** One transaction: staged rows → public tables (dependency order), mappings, bookkeeping row. */
export async function mergeStaged(client, { importId, manifest, manifestSha, tables, inTransaction = false, now }) {
  const counts = {};
  if (!inTransaction) await client.query('BEGIN');
  try {
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const t of tables) {
      const st = SQL_TABLE[t];
      const cols = getTable(t).columns.map((c) => c.name).join(', ');
      const res = await client.query(`INSERT INTO public.${st} (${cols}) SELECT ${cols} FROM staging.${st} WHERE _import_id = $1`, [importId]);
      counts[t] = res.rowCount;
    }
    const mcols = getTable('StorageObjectMappings').columns.map((c) => c.name).join(', ');
    const mres = await client.query(`INSERT INTO public.storage_object_mappings (${mcols}) SELECT ${mcols} FROM staging.storage_object_mappings WHERE _import_id = $1 ON CONFLICT (provider, object_key) DO NOTHING`, [importId]);
    counts.StorageObjectMappings = mres.rowCount;
    await client.query(`INSERT INTO public.migration_runs (id, run_type, mode, state, manifest_sha256, completeness, started_by, started_at, finished_at, summary_json, created_at, created_by, updated_at, updated_by, version)
      VALUES ($1, 'IMPORT_POSTGRES', $2, 'STAGED', $3, $4, $5, $6, $6, $7, $6, $5, $6, $5, 1) ON CONFLICT (id) DO NOTHING`,
    [importId, manifest.mode, manifestSha, manifest.completeness, SYSTEM_USER_ID, now, JSON.stringify({ export_id: manifest.export_id, rows: counts })]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    if (!inTransaction) await client.query('COMMIT');
  } catch (e) {
    if (!inTransaction) await client.query('ROLLBACK');
    throw e;
  }
  return counts;
}

export async function clearStaging(client, importId) {
  for (const t of STAGING_TABLES) await client.query(`DELETE FROM staging.${SQL_TABLE[t]} WHERE _import_id = $1`, [importId]);
}

// ───────── reconciliation target ─────────

export class PgTarget {
  constructor({ client, storage, crypto, clock, ids, timezone = 'Asia/Bangkok' }) {
    Object.assign(this, { client, storage, crypto, clock, ids, timezone });
    this.name = 'postgres';
    this.cache = new Map();
  }
  *rows(table) {
    if (!this.cache.has(table)) {
      const res = yield this.client.query(`SELECT ${selectList(table)} FROM public.${SQL_TABLE[table]} ORDER BY id`);
      this.cache.set(table, res.rows.map((r) => canonicalRecord(table, r)));
    }
    return this.cache.get(table);
  }
  *attachmentBytes(id) {
    const maps = (yield this.client.query("SELECT provider, object_key FROM public.storage_object_mappings WHERE attachment_id = $1 AND status = 'ACTIVE'", [id])).rows;
    if (!maps.length || !this.storage) return null;
    try { return { bytes: this.storage.get(maps[0]), mappings: maps.length }; } catch (_) { return null; }
  }
  /** A memory store seeded with the rows read back from PostgreSQL — reports run on the target's data. */
  *sampleDeps() {
    const store = new MemoryStore();
    const terms = yield* this.rows('Terms');
    for (const t of TABLES) {
      if (EXCLUDED_TABLES[t.name]) continue;
      const rows = yield* this.rows(t.name);
      for (const r of rows) store.seed(t.name, [r], t.partition === 'TERM' ? partitionFor(t.name, r, terms, this.timezone) : '*');
    }
    return { store, mutations: store, clock: this.clock, ids: this.ids, crypto: this.crypto, config: { timezone: this.timezone }, platform: {}, cache: null };
  }
  *extraChecks() {
    const checks = [];
    const orphans = [];
    for (const t of TABLES) {
      for (const c of t.columns) {
        if (!c.fk) continue;
        const r = yield this.client.query(`SELECT count(*)::int AS n FROM public.${SQL_TABLE[t.name]} c WHERE c.${c.name} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.${SQL_TABLE[c.fk]} p WHERE p.id = c.${c.name})`);
        if (r.rows[0].n) orphans.push(`${t.name}.${c.name}: ${r.rows[0].n}`);
      }
    }
    checks.push({ key: 'postgres.foreign_keys', status: orphans.length ? 'FAIL' : 'PASS', detail_th: 'ไม่มี foreign key ที่หา parent ไม่พบ (ตรวจด้วย SQL ทุกคอลัมน์)', data: { orphans } });
    const sv = yield this.client.query("SELECT schema_version FROM public.schema_versions WHERE component = 'POSTGRES'");
    checks.push({ key: 'postgres.schema_version', status: sv.rows.some((r) => r.schema_version === SCHEMA_VERSION) ? 'PASS' : 'FAIL', detail_th: `schema_version ของ PostgreSQL = ${SCHEMA_VERSION}` });
    const left = yield this.client.query("SELECT count(*)::int AS n FROM staging.cwk_import_runs WHERE status = 'LOADING'").catch(() => ({ rows: [{ n: 0 }] }));
    checks.push({ key: 'postgres.staging_clean', status: left.rows[0].n ? 'FAIL' : 'PASS', detail_th: 'ไม่มีงานนำเข้าค้างอยู่ใน staging' });
    return checks;
  }
}

export { q, STAGING_TABLES };

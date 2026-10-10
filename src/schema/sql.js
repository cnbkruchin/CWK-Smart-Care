// PostgreSQL DDL generated from the single schema source (PostgreSQL 16).
// The committed migration database/postgres/migrations/0001_init.sql is produced by
// `npm run gen` and checked for drift by `npm run check:gen` and tests.

import { TABLES, SCHEMA_VERSION, uniqueKeys } from './index.js';
import { ENUMS } from './enums.js';

export function snake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export const SQL_TABLE = Object.freeze(Object.fromEntries(TABLES.map((t) => [t.name, snake(t.name)])));

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function colType(c) {
  switch (c.type) {
    case 'uuid': return 'uuid';
    case 'string': case 'text': case 'enum': case 'hhmm': return 'text';
    case 'int': return 'integer';
    case 'decimal': return 'numeric(12,2)';
    case 'bool': return 'boolean';
    case 'date': return 'date';
    case 'ts': return 'timestamptz';
    case 'json': return 'jsonb';
    default: throw new Error(`no sql type for ${c.type}`);
  }
}

function colChecks(c) {
  const out = [];
  const n = c.name;
  if ((c.type === 'string' || c.type === 'text') && c.maxLength) out.push(`char_length(${n}) <= ${c.maxLength}`);
  if ((c.type === 'string' || c.type === 'text')) out.push(`${n} <> ''`);
  if (c.pattern) out.push(`${n} ~ ${q(c.pattern)}`);
  if (c.type === 'hhmm') out.push(`${n} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`);
  if (c.type === 'enum') out.push(`${n} IN (${ENUMS[c.enum].values.map(q).join(', ')})`);
  if (c.type === 'int' && c.min !== undefined) out.push(`${n} >= ${c.min}`);
  if (c.type === 'int' && c.max !== undefined) out.push(`${n} <= ${c.max}`);
  return out;
}

function defaultSql(c) {
  if (c.default === undefined) return '';
  if (c.type === 'bool') return ` DEFAULT ${c.default ? 'true' : 'false'}`;
  if (c.type === 'int') return ` DEFAULT ${Number(c.default)}`;
  return ` DEFAULT ${q(c.default)}`;
}

export function generateInitSql() {
  const lines = [];
  lines.push('-- CWK Smart Care — PostgreSQL schema (generated from src/schema/tables.js; DO NOT EDIT BY HAND)');
  lines.push(`-- schema_version: ${SCHEMA_VERSION}; target: PostgreSQL 16`);
  lines.push('-- Conventions: UUID primary keys, DATE school dates, TIMESTAMPTZ UTC instants, jsonb metadata,');
  lines.push('-- enum values as CHECK constraints, append-only event tables protected by trigger.');
  lines.push('');
  lines.push('BEGIN;');
  lines.push('CREATE EXTENSION IF NOT EXISTS btree_gist;');
  lines.push('CREATE SCHEMA IF NOT EXISTS staging;');
  lines.push('');
  lines.push('CREATE TABLE IF NOT EXISTS schema_migrations (');
  lines.push('  filename text PRIMARY KEY,');
  lines.push('  checksum text NOT NULL,');
  lines.push("  applied_at timestamptz NOT NULL DEFAULT now()");
  lines.push(');');
  lines.push('');
  lines.push('-- Append-only guard: UPDATE/DELETE on event tables is rejected unless a purge procedure sets cwk.allow_purge.');
  lines.push('CREATE OR REPLACE FUNCTION cwk_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$');
  lines.push('BEGIN');
  lines.push("  IF TG_OP = 'DELETE' AND current_setting('cwk.allow_purge', true) = 'on' THEN RETURN OLD; END IF;");
  lines.push("  RAISE EXCEPTION 'table % is append-only (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';");
  lines.push('END $$;');
  lines.push('');
  for (const t of TABLES) {
    const tn = SQL_TABLE[t.name];
    lines.push(`-- ${t.name}: ${t.description_th}`);
    lines.push(`CREATE TABLE ${tn} (`);
    const defs = [];
    for (const c of t.columns) {
      let d = `  ${c.name} ${colType(c)}${c.required ? ' NOT NULL' : ''}${defaultSql(c)}`;
      if (c.pk) d += ' PRIMARY KEY';
      defs.push(d);
    }
    let i = 0;
    for (const c of t.columns) {
      for (const chk of colChecks(c)) defs.push(`  CONSTRAINT ${tn}_ck${++i} CHECK (${chk})`);
    }
    for (const chk of t.checks || []) defs.push(`  CONSTRAINT ${tn}_ck${++i} CHECK (${chk})`);
    lines.push(defs.join(',\n'));
    lines.push(');');
    if (t.kind === 'EVENT') {
      lines.push(`CREATE TRIGGER ${tn}_append_only BEFORE UPDATE OR DELETE ON ${tn} FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();`);
    }
    uniqueKeys(t.name).forEach((u, k) => {
      const nnd = u.nullsNotDistinct ? ' NULLS NOT DISTINCT' : '';
      lines.push(`CREATE UNIQUE INDEX ${tn}_uq${k + 1} ON ${tn} (${u.columns.join(', ')})${nnd}${u.where ? ` WHERE ${u.where}` : ''};`);
    });
    const idx = new Set();
    for (const l of t.lookup || []) idx.add(l);
    for (const ix of t.indexes || []) idx.add(ix.join(', '));
    for (const c of t.columns) if (c.fk) idx.add(c.name);
    let k = 0;
    for (const cols of idx) lines.push(`CREATE INDEX ${tn}_ix${++k} ON ${tn} (${cols});`);
    if (t.exclusion) {
      const [from, to] = t.exclusion.range;
      lines.push(`ALTER TABLE ${tn} ADD CONSTRAINT ${tn}_no_overlap EXCLUDE USING gist (${t.exclusion.columns.map((c) => `${c} WITH =`).join(', ')}, daterange(${from}, ${to}, '[)') WITH &&);`);
    }
    lines.push('');
  }
  lines.push('-- Foreign keys (added after all tables; self-references and cycles are DEFERRABLE INITIALLY DEFERRED)');
  for (const t of TABLES) {
    const tn = SQL_TABLE[t.name];
    for (const c of t.columns) {
      if (!c.fk) continue;
      const deferrable = c.deferrable || c.fk === t.name ? ' DEFERRABLE INITIALLY DEFERRED' : '';
      lines.push(`ALTER TABLE ${tn} ADD CONSTRAINT ${tn}_${c.name}_fk FOREIGN KEY (${c.name}) REFERENCES ${SQL_TABLE[c.fk]} (id)${deferrable};`);
    }
  }
  lines.push('');
  lines.push(`INSERT INTO schema_versions (id, component, schema_version, applied_at, applied_by, description, checksum, created_at, created_by)`);
  lines.push(`VALUES ('00000000-0000-4000-8000-0000000000${String(SCHEMA_VERSION).padStart(2, '0')}', 'POSTGRES', ${SCHEMA_VERSION}, now(), 'migration 0001_init.sql', 'initial schema', NULL, now(), '00000000-0000-4000-8000-000000000001');`);
  lines.push('COMMIT;');
  lines.push('');
  return lines.join('\n');
}

/** Least-privilege roles (NOLOGIN groups). Login users are created per environment and granted one group. */
export function generateRolesSql() {
  const event = TABLES.filter((t) => t.kind === 'EVENT').map((t) => SQL_TABLE[t.name]);
  const all = TABLES.map((t) => SQL_TABLE[t.name]);
  const mutable = all.filter((t) => !event.includes(t));
  const lines = [];
  lines.push('-- CWK Smart Care — database roles (generated; idempotent). Run as a superuser/owner AFTER 0001_init.sql.');
  lines.push('-- cwk_app       : application backend (read/insert; update only mutable tables; no DELETE; no DDL)');
  lines.push('-- cwk_migrator  : migration CLI (staging schema + inserts into public; no UPDATE of business rows)');
  lines.push('-- cwk_reporting : read-only reporting');
  lines.push('DO $$ BEGIN');
  for (const r of ['cwk_app', 'cwk_migrator', 'cwk_reporting']) {
    lines.push(`  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF;`);
  }
  lines.push('END $$;');
  lines.push('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;');
  lines.push('GRANT USAGE ON SCHEMA public TO cwk_app, cwk_migrator, cwk_reporting;');
  lines.push(`GRANT SELECT, INSERT ON ${all.join(', ')} TO cwk_app;`);
  lines.push(`GRANT UPDATE ON ${mutable.join(', ')} TO cwk_app;`);
  lines.push('GRANT DELETE ON idempotency_records TO cwk_app;');
  lines.push(`GRANT SELECT ON ${all.join(', ')}, schema_migrations TO cwk_reporting;`);
  lines.push(`GRANT SELECT, INSERT ON ${all.join(', ')}, schema_migrations TO cwk_migrator;`);
  lines.push('GRANT UPDATE ON migration_runs, migration_checkpoints, storage_object_mappings, storage_catalog TO cwk_migrator;');
  lines.push('GRANT USAGE, CREATE ON SCHEMA staging TO cwk_migrator;');
  lines.push('');
  return lines.join('\n');
}

// One pass over a portable package, shared by validation and every importer (memory, Sheets, PostgreSQL):
//   manifest + manifest.sha256 → listed files → chunks (checksum, size, line count, UTF-8, canonical JSON,
//   columns, schema, partition key, high-water mark, duplicate IDs, unique keys, foreign keys, table digests)
//   → attachment index and bytes (SHA-256 of the real bytes).
// The sink decides what happens to clean records (nothing for validation; append for imports). A chunk is
// checked completely before anything from it is written, so an import never applies half a chunk.
// Resumable: progress is saved through opts.checkpoint after every chunk/attachment and the pass yields
// ({done:false}) when opts.deadlineAt is near (Apps Script 6-minute executions).
import { getTable, uniqueKeys, validateRecord, TABLE_MAP } from '../../schema/index.js';
import { canonicalStringify, utf8Decode, utf8Encode } from '../../shared/canonical-json.js';
import { validateValue } from '../../shared/validate.js';
import { evalUniquePredicate } from '../../shared/query.js';
import {
  FORMAT, FORMAT_VERSION, EXCLUDED_TABLES, MANIFEST_SCHEMA, ATTACHMENT_INDEX_SCHEMA, upgradePath, UPGRADES, isSafePath, isUnlistedOutput,
  parseManifestShaLine, newTableAcc, accumulate, recordLine,
} from './format.js';

export const CORRUPTION_CODES = new Set(['MANIFEST_SHA_MISSING', 'MANIFEST_SHA_MISMATCH', 'FILE_MISSING', 'CHECKSUM_MISMATCH', 'SIZE_MISMATCH', 'CHUNK_MISSING',
  'ROW_COUNT_MISMATCH', 'ENCODING_ERROR', 'PARSE_ERROR', 'NOT_CANONICAL', 'DIGEST_MISMATCH', 'ATTACHMENT_INDEX_MISSING', 'ATTACHMENT_FILE_MISSING',
  'ATTACHMENT_CHECKSUM_MISMATCH', 'UNSAFE_PATH', 'SYMLINK']);
export const INCOMPATIBLE_CODES = new Set(['MANIFEST_MISSING', 'MANIFEST_INVALID', 'UNSUPPORTED_FORMAT', 'INCOMPATIBLE_SCHEMA']);
const MAX_ERRORS = 500;
const MAX_DEFERRED = 5000;

export class ProcessReport {
  constructor(level) {
    Object.assign(this, { level, ok: true, fatal: false, errors: [], warnings: [], error_count: 0, checks: [], tables: {}, attachments: { files: 0, bytes: 0, verified: 0, written: 0, skipped: 0 } });
  }
  error(code, detail = {}) {
    this.ok = false;
    this.error_count++;
    if (this.errors.length < MAX_ERRORS) this.errors.push({ code, ...detail });
  }
  warn(code, detail = {}) { if (this.warnings.length < MAX_ERRORS) this.warnings.push({ code, ...detail }); }
  check(key, status, detail_th) { this.checks.push({ key, status, detail_th }); }
  table(name) {
    if (!this.tables[name]) this.tables[name] = { rows: 0, inserted: 0, identical: 0, conflicts: 0, updated: 0, errors: 0 };
    return this.tables[name];
  }
  hasCode(set) { return this.errors.some((e) => set.has(e.code)); }
  toJSON() {
    return { level: this.level, ok: this.ok, fatal: this.fatal, error_count: this.error_count, errors: this.errors, warnings: this.warnings, checks: this.checks, tables: this.tables, attachments: this.attachments };
  }
}

/** Strict UTF-8: decode, re-encode and compare, so invalid byte sequences are reported, not mangled. */
function decodeText(bytes) {
  const text = utf8Decode(bytes);
  const back = utf8Encode(text);
  if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) throw Object.assign(new Error('invalid UTF-8'), { code: 'ENCODING_ERROR' });
  return text;
}

function bytesOf(v) { return v instanceof Uint8Array ? v : v ? Uint8Array.from(v) : null; }

/**
 * Read and check manifest.json + manifest.sha256. Returns {manifest, manifest_sha256} or null (fatal errors recorded).
 * @param {object} handle  package handle
 * @param {(data:string|Uint8Array)=>string} sha256Hex
 */
export function* readManifest(handle, sha256Hex, report) {
  const raw = bytesOf(yield handle.readBytes('manifest.json'));
  if (!raw) { report.fatal = true; report.error('MANIFEST_MISSING', { path: 'manifest.json' }); return null; }
  const shaText = yield handle.readText('manifest.sha256');
  const declared = parseManifestShaLine(shaText);
  const actual = sha256Hex(raw);
  if (!declared) report.error('MANIFEST_SHA_MISSING', { path: 'manifest.sha256' });
  else if (declared !== actual) report.error('MANIFEST_SHA_MISMATCH', { path: 'manifest.sha256', expected: declared, actual });
  let manifest;
  try { manifest = JSON.parse(decodeText(raw)); } catch (e) { report.fatal = true; report.error('MANIFEST_INVALID', { path: 'manifest.json', message: 'not valid JSON' }); return null; }
  if (!manifest || manifest.format !== FORMAT) { report.fatal = true; report.error('UNSUPPORTED_FORMAT', { path: 'manifest.json', message: `format ${manifest && manifest.format}` }); return null; }
  if (!Number.isInteger(manifest.format_version) || manifest.format_version > FORMAT_VERSION) { report.fatal = true; report.error('UNSUPPORTED_FORMAT', { message: `format_version ${manifest.format_version} (supported ≤ ${FORMAT_VERSION})` }); return null; }
  if (upgradePath(manifest.schema_version) === null) { report.fatal = true; report.error('INCOMPATIBLE_SCHEMA', { message: `schema_version ${manifest.schema_version} has no supported upgrade path` }); return null; }
  const shapeErrors = validateValue(MANIFEST_SCHEMA, manifest);
  if (shapeErrors.length) {
    report.fatal = true;
    for (const e of shapeErrors.slice(0, 20)) report.error('MANIFEST_INVALID', { path: 'manifest.json', field: e.field, message: e.code });
    return null;
  }
  return { manifest, manifest_sha256: actual };
}

/** Package-level checks that do not need the data: paths, listed files, exclusions, completeness claims. */
export function* checkPackageFiles(handle, manifest, sha256Hex, report) {
  const listed = new Set(['manifest.json', 'manifest.sha256']);
  const paths = [];
  for (const t of manifest.tables) {
    if (!TABLE_MAP[t.name] || EXCLUDED_TABLES[t.name]) report.error('UNKNOWN_TABLE', { table: t.name });
    for (const p of t.partitions) for (const c of p.chunks) { paths.push(c.path); if (c.csv) paths.push(c.csv.path); }
  }
  for (const f of manifest.files) paths.push(f.path);
  if (manifest.attachments.index) paths.push(manifest.attachments.index.path);
  for (const p of paths) { if (!isSafePath(p)) report.error('UNSAFE_PATH', { path: String(p).slice(0, 200) }); listed.add(p); }
  // excluded tables: a full snapshot must exclude exactly the policy tables
  const excl = new Map(manifest.excluded_tables.map((e) => [e.name, e]));
  for (const name of Object.keys(EXCLUDED_TABLES)) if (!excl.has(name)) report.error('EXCLUSION_POLICY', { table: name, message: 'policy-excluded table not declared' });
  for (const e of manifest.excluded_tables) {
    if (e.reason === 'NOT_SELECTED' && manifest.mode !== 'PARTIAL' && manifest.kind !== 'DELTA') report.error('EXCLUSION_POLICY', { table: e.name, message: 'NOT_SELECTED only allowed in PARTIAL mode or DELTA packages' });
    if (e.reason !== 'NOT_SELECTED' && !EXCLUDED_TABLES[e.name]) report.error('EXCLUSION_POLICY', { table: e.name, message: 'excluded without policy' });
  }
  if (manifest.tables.some((t) => EXCLUDED_TABLES[t.name])) report.error('EXCLUSION_POLICY', { message: 'policy-excluded table present in data' });
  // completeness claims must be consistent with what the package says about itself
  if (manifest.completeness === 'COMPLETE') {
    if (manifest.mode === 'PARTIAL') report.error('COMPLETENESS_INVALID', { message: 'PARTIAL mode cannot be COMPLETE' });
    if (!manifest.attachments.included || manifest.attachments.missing.length) report.error('COMPLETENESS_INVALID', { message: 'attachments missing but COMPLETE' });
    if (!manifest.consistency.checked || (manifest.consistency.non_live_tables_changed || []).length || (manifest.consistency.count_mismatches || []).length) report.error('COMPLETENESS_INVALID', { message: 'consistency not proven but COMPLETE' });
  }
  // listed non-data files (schema, metadata, docs, dictionary)
  for (const f of manifest.files) {
    if (!isSafePath(f.path)) continue;
    const b = bytesOf(yield handle.readBytes(f.path));
    if (!b) { report.error('FILE_MISSING', { path: f.path }); continue; }
    if (b.length !== f.bytes) report.error('SIZE_MISMATCH', { path: f.path, expected: f.bytes, actual: b.length });
    if (sha256Hex(b) !== f.sha256) report.error('CHECKSUM_MISMATCH', { path: f.path });
  }
  // human CSV copies: integrity only
  for (const t of manifest.tables) for (const p of t.partitions) for (const c of p.chunks) {
    if (!c.csv || !isSafePath(c.csv.path)) continue;
    const b = bytesOf(yield handle.readBytes(c.csv.path));
    if (!b) report.error('FILE_MISSING', { path: c.csv.path });
    else if (sha256Hex(b) !== c.csv.sha256) report.error('CHECKSUM_MISMATCH', { path: c.csv.path });
  }
  // preflight: every chunk exists with its declared size before anything is processed or written
  const all = yield handle.list();
  const sizes = new Map(all.map((f) => [f.path, f.size]));
  for (const t of manifest.tables) for (const p of t.partitions) for (const c of p.chunks) {
    if (!isSafePath(c.path)) continue;
    if (!sizes.has(c.path)) report.error('CHUNK_MISSING', { table: t.name, path: c.path });
    else if (sizes.get(c.path) !== c.bytes) report.error('SIZE_MISMATCH', { table: t.name, path: c.path, expected: c.bytes, actual: sizes.get(c.path) });
  }
  if (manifest.attachments.index && isSafePath(manifest.attachments.index.path) && !sizes.has(manifest.attachments.index.path)) report.error('ATTACHMENT_INDEX_MISSING', { path: manifest.attachments.index.path });
  // unexpected files and symlinks
  for (const f of all) {
    if (f.symlink) { report.error('SYMLINK', { path: f.path }); continue; }
    if (listed.has(f.path) || isUnlistedOutput(f.path) || /^attachments\/batch-\d{4}\/[0-9a-f-]{36}$/.test(f.path)) continue;
    report.warn('UNLISTED_FILE', { path: f.path });
  }
}

function terms(state) { return state.terms || []; }

function partitionKeyOk(table, key, state) {
  const t = getTable(table);
  if (t.partition !== 'TERM') return key === '*';
  return key === 'UNPARTITIONED' || terms(state).some((x) => x.code === key);
}

/**
 * Index of IDs and unique keys. Hydrated lazily from the sink (the import target is the index across
 * Apps Script executions); a validation sink starts empty.
 */
class TargetIndex {
  constructor(sink) { this.sink = sink; this.ids = new Map(); this.uniques = new Map(); }
  *ensure(table) {
    if (this.ids.has(table)) return;
    const loaded = this.sink.loadIndex ? yield* this.sink.loadIndex(table) : { ids: [], uniques: [] };
    this.ids.set(table, new Set(loaded.ids));
    const u = uniqueKeys(table).map(() => new Map());
    for (const { index, key, id } of loaded.uniques || []) u[index].set(key, id);
    this.uniques.set(table, u);
  }
  has(table, id) { return this.ids.get(table).has(id); }
  add(table, rec) {
    this.ids.get(table).add(rec.id);
    uniqueKeys(table).forEach((u, i) => { const k = uniqueKeyOf(u, rec); if (k !== null) this.uniques.get(table)[i].set(k, rec.id); });
  }
  owner(table, i, key) { return this.uniques.get(table)[i].get(key) || null; }
}

export function uniqueKeyOf(u, rec) {
  if (!evalUniquePredicate(u.where, rec)) return null;
  if (!u.nullsNotDistinct && u.columns.some((c) => rec[c] === null || rec[c] === undefined)) return null;
  return u.columns.map((c) => JSON.stringify(rec[c] ?? null)).join('|');
}

function sameRecord(a, b) { return canonicalStringify(a) === canonicalStringify(b); }

/**
 * Process a package.
 * @param {object} handle   package handle (readBytes/readText/list)
 * @param {object} sink     {name, mode:'VALIDATE'|'IMPORT', conflictPolicy, loadIndex?, existing?, append?, endTable?, attachmentRows?, attachment?, finish?}
 * @param {object} opts     {sha256Hex, level?:'FULL'|'INTEGRITY', checkpoint?:{*load(), *save(state)}, deadlineAt?:number, failFast?:boolean, onProgress?:(p)=>void}
 *   level INTEGRITY checks files, checksums, canonical lines, record schema and digests but not identity,
 *   unique keys or foreign keys (those need every ID in memory) — used to re-verify a package right
 *   after a resumable Apps Script export; FULL validation runs in Node (tools/migrate.mjs) and in imports.
 * @returns {{done:boolean, report:ProcessReport, manifest, manifest_sha256}}
 */
export function* processPackage(handle, sink, opts) {
  const sha = opts.sha256Hex;
  const level = opts.level || 'FULL';
  const report = new ProcessReport(sink.mode === 'VALIDATE' ? level : 'IMPORT');
  const timeUp = () => opts.deadlineAt && Date.now() > opts.deadlineAt;
  const saved = opts.checkpoint ? yield* opts.checkpoint.load() : null;
  const m = yield* readManifest(handle, sha, report);
  if (!m) return { done: true, report, manifest: null };
  const { manifest, manifest_sha256 } = m;
  report.manifest_sha256 = manifest_sha256;
  if (saved && saved.manifest_sha256 !== manifest_sha256) {
    report.fatal = true;
    report.error('CHECKPOINT_MISMATCH', { message: 'saved progress belongs to another package' });
    return { done: true, report, manifest };
  }
  const state = saved || { manifest_sha256, phase: 'FILES', ti: 0, pi: 0, ci: 0, acc: null, deferred: [], terms: [], ai: 0, att_checked: false, tables: {}, attachments: report.attachments, errors: [] };
  if (saved) { report.tables = state.tables; report.attachments = state.attachments; for (const e of state.errors || []) report.error(e.code, e); }
  // terms already in the target (a DELTA package carries only changed rows) also define valid partition keys
  if (!saved && sink.terms) state.terms = (yield* sink.terms()).map((t) => ({ code: t.code, start_date: t.start_date, end_date: t.end_date }));
  const steps = upgradePath(manifest.schema_version);
  const upgrade = (table, rec) => steps.reduce((r, v) => UPGRADES[v](table, r), rec);
  const index = new TargetIndex(sink);
  const save = function* () {
    state.tables = report.tables;
    state.attachments = report.attachments;
    state.errors = report.errors.slice(0, 50);
    if (opts.checkpoint) yield* opts.checkpoint.save(state);
  };
  const stop = () => opts.failFast && !report.ok;

  if (state.phase === 'FILES') {
    yield* checkPackageFiles(handle, manifest, sha, report);
    if (stop()) return { done: true, report, manifest, manifest_sha256 };
    state.phase = 'TABLES';
    yield* save();
  }

  // ───────── tables ─────────
  const tables = manifest.tables;
  while (state.phase === 'TABLES' && state.ti < tables.length) {
    const tm = tables[state.ti];
    const table = tm.name;
    if (!TABLE_MAP[table]) { state.ti++; continue; }
    const tdef = getTable(table);
    const stats = report.table(table);
    yield* index.ensure(table);
    for (const c of tdef.columns) if (c.fk && !EXCLUDED_TABLES[c.fk]) yield* index.ensure(c.fk);
    if (!state.acc) state.acc = newTableAcc();
    while (state.pi < tm.partitions.length) {
      const part = tm.partitions[state.pi];
      if (!partitionKeyOk(table, part.key, state)) report.error('UNKNOWN_PARTITION', { table, partition: part.key });
      while (state.ci < part.chunks.length) {
        if (timeUp()) { yield* save(); return { done: false, report, manifest, manifest_sha256 }; }
        const chunk = part.chunks[state.ci];
        const clean = yield* processChunk({ handle, sink, sha, report, index, state, table, tdef, part, chunk, manifest, upgrade, upgrading: steps.length > 0, stats, deep: level !== 'INTEGRITY' || sink.mode !== 'VALIDATE' });
        if (stop()) { yield* save(); return { done: true, report, manifest, manifest_sha256 }; }
        if (clean.length && sink.append) {
          const res = yield* sink.append(table, part.key, clean);
          stats.inserted += res && res.inserted !== undefined ? res.inserted : clean.length;
          stats.updated += res && res.updated ? res.updated : 0;
        }
        for (const r of clean) index.add(table, r);
        for (const r of clean.indexOnly || []) index.add(table, r);
        state.ci++;
        yield* save();
        if (opts.onProgress) opts.onProgress({ phase: 'TABLES', table, table_no: state.ti + 1, tables: tables.length, chunk: state.ci, chunks: part.chunks.length, rows: stats.rows });
      }
      state.ci = 0;
      state.pi++;
    }
    // end of table: resolve deferred references whose target table is now complete
    const pos = (name) => tables.findIndex((t) => t.name === name);
    const keep = [];
    for (const d of state.deferred) {
      const tp = pos(d.target);
      if (tp >= 0 && tp > state.ti) { keep.push(d); continue; }
      if (tp < 0) { report.error(manifest.excluded_tables.some((e) => e.name === d.target && e.reason === 'NOT_SELECTED') ? 'FK_PARENT_NOT_EXPORTED' : 'FK_MISSING', { table: d.table, id: d.id, column: d.column }); continue; }
      yield* index.ensure(d.target);
      if (!index.has(d.target, d.value)) report.error('FK_MISSING', { table: d.table, id: d.id, column: d.column, message: `${d.target} ${d.value}` });
    }
    state.deferred = keep;
    if (state.acc.rows !== tm.row_count) report.error('ROW_COUNT_MISMATCH', { table, expected: tm.row_count, actual: state.acc.rows });
    if (state.acc.digest_all !== tm.digest_all || state.acc.digest_source !== tm.digest_source) report.error('DIGEST_MISMATCH', { table });
    if (sink.endTable) yield* sink.endTable(table);
    state.acc = null;
    state.pi = 0;
    state.ti++;
    yield* save();
    if (stop()) return { done: true, report, manifest, manifest_sha256 };
  }
  if (state.phase === 'TABLES') {
    for (const d of state.deferred) report.error('FK_MISSING', { table: d.table, id: d.id, column: d.column, message: `${d.target} ${d.value}` });
    state.deferred = [];
    state.phase = 'ATTACHMENTS';
    yield* save();
  }

  // ───────── attachments ─────────
  if (state.phase === 'ATTACHMENTS') {
    const done = yield* processAttachments({ handle, sink, sha, report, state, manifest, timeUp, save, stop });
    if (!done) return { done: false, report, manifest, manifest_sha256 };
    state.phase = 'DONE';
    yield* save();
  }
  if (sink.finish) yield* sink.finish(report, manifest);
  return { done: true, report, manifest, manifest_sha256 };
}

function* processChunk({ handle, sink, sha, report, index, state, table, tdef, part, chunk, manifest, upgrade, upgrading, stats, deep }) {
  const where = { table, path: chunk.path };
  if (!isSafePath(chunk.path)) { report.error('UNSAFE_PATH', where); return []; }
  const bytes = bytesOf(yield handle.readBytes(chunk.path));
  if (!bytes) { report.error('CHUNK_MISSING', where); return []; }
  if (bytes.length !== chunk.bytes) report.error('SIZE_MISMATCH', { ...where, expected: chunk.bytes, actual: bytes.length });
  if (sha(bytes) !== chunk.sha256) { report.error('CHECKSUM_MISMATCH', where); return []; }
  let text;
  try { text = decodeText(bytes); } catch (_) { report.error('ENCODING_ERROR', where); return []; }
  if (text.includes('\r') || (chunk.rows > 0 && !text.endsWith('\n'))) { report.error('ENCODING_ERROR', { ...where, message: 'lines must end with a single LF' }); return []; }
  const lines = text.length ? text.slice(0, -1).split('\n') : [];
  if (lines.length !== chunk.rows) { report.error('ROW_COUNT_MISMATCH', { ...where, expected: chunk.rows, actual: lines.length }); return []; }
  const columns = tdef.columns.map((c) => c.name);
  const colSet = new Set(columns);
  const hwm = manifest.snapshot.high_water_mark.change_log_seq;
  const before = report.error_count;
  const clean = [];
  const indexOnly = [];
  const chunkIds = new Set();
  // only IDs the index already knows can exist in the target; fetch those records for comparison
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return undefined; } });
  const known = parsed.filter((r) => r && typeof r.id === 'string' && index.has(table, r.id)).map((r) => r.id);
  const existing = known.length && sink.existing ? yield* sink.existing(table, part.key, known) : new Map();
  for (let i = 0; i < lines.length; i++) {
    const at = { ...where, line: i + 1 };
    let rec = parsed[i];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { report.error('PARSE_ERROR', at); continue; }
    if (recordLine(rec) !== lines[i]) { report.error('NOT_CANONICAL', { ...at, id: rec.id }); continue; }
    accumulate(state.acc, table, rec, sha, lines[i]);
    stats.rows++;
    const keys = Object.keys(rec);
    const unknown = keys.filter((k) => !colSet.has(k));
    const missing = columns.filter((k) => !(k in rec));
    if (unknown.length) { report.error('UNKNOWN_FIELD', { ...at, id: rec.id, column: unknown.join(',') }); continue; }
    if (missing.length && !upgrading) { report.error('MISSING_FIELD', { ...at, id: rec.id, column: missing.join(',') }); continue; }
    rec = upgrade(table, rec);
    const fe = validateRecord(table, rec);
    if (fe.length) { report.error('RECORD_INVALID', { ...at, id: rec.id, column: fe.map((e) => `${e.field}:${e.code}`).join(',') }); continue; }
    if (table === 'ChangeLog' && manifest.kind === 'SNAPSHOT' && rec.seq > hwm) { report.error('AFTER_HIGH_WATER_MARK', { ...at, id: rec.id }); continue; }
    if (table === 'Terms' && !state.terms.some((x) => x.code === rec.code)) state.terms.push({ code: rec.code, start_date: rec.start_date, end_date: rec.end_date });
    if (table === 'Attachments') (state.att_rows = state.att_rows || []).push({ id: rec.id, sha256: rec.sha256, size_bytes: rec.size_bytes, status: rec.status });
    if (!deep) { if (table === 'Attachments') clean.push(rec); continue; }
    // identity: duplicate inside the package vs already present in the target
    if (chunkIds.has(rec.id)) { report.error('DUPLICATE_ID', { ...at, id: rec.id }); continue; }
    chunkIds.add(rec.id);
    const prior = existing.get(rec.id);
    let update = false;
    if (index.has(table, rec.id)) {
      if (prior && sameRecord(prior, rec)) { stats.identical++; continue; }
      if (prior && sink.conflictPolicy === 'APPLY_NEWER' && Number.isInteger(rec.version) && Number.isInteger(prior.version) && prior.version < rec.version) {
        update = true;
      } else if (prior) {
        stats.conflicts++;
        report.error('CONFLICT', { ...at, id: rec.id, message: prior.version !== undefined ? `target version ${prior.version}, package version ${rec.version}` : 'target has a different record with this id' });
        continue;
      } else {
        report.error('DUPLICATE_ID', { ...at, id: rec.id });
        continue;
      }
    }
    // unique keys (package + target)
    let uniqueOk = true;
    uniqueKeys(table).forEach((u, ui) => {
      const k = uniqueKeyOf(u, rec);
      if (k === null) return;
      const owner = index.owner(table, ui, k);
      const inChunk = clean.find((r) => r.id !== rec.id && uniqueKeyOf(u, r) === k);
      if ((owner && owner !== rec.id) || inChunk) { uniqueOk = false; report.error('UNIQUE_VIOLATION', { ...at, id: rec.id, column: u.columns.join(',') }); }
    });
    if (!uniqueOk) continue;
    // foreign keys
    let fkOk = true;
    for (const c of tdef.columns) {
      const v = rec[c.name];
      if (!c.fk || v === null || v === undefined) continue;
      if (EXCLUDED_TABLES[c.fk]) { fkOk = false; report.error('FK_TO_EXCLUDED', { ...at, id: rec.id, column: c.name }); continue; }
      if (c.fk === table || c.deferrable) {
        if (c.fk === table && (index.has(table, v) || chunkIds.has(v))) continue;
        if (c.fk !== table && index.ids.has(c.fk) && index.has(c.fk, v)) continue;
        if (state.deferred.length >= MAX_DEFERRED) { fkOk = false; report.error('DEFERRED_OVERFLOW', { ...at, id: rec.id }); continue; }
        state.deferred.push({ table, id: rec.id, column: c.name, target: c.fk, value: v });
        continue;
      }
      if (!index.ids.has(c.fk) || !index.has(c.fk, v)) {
        fkOk = false;
        const notExported = manifest.excluded_tables.some((e) => e.name === c.fk && e.reason === 'NOT_SELECTED');
        report.error(notExported ? 'FK_PARENT_NOT_EXPORTED' : 'FK_MISSING', { ...at, id: rec.id, column: c.name });
      }
    }
    if (!fkOk) { indexOnly.push(rec); continue; } // present in the package: index it so children do not cascade errors
    clean.push(update ? { ...rec, __update_from_version: prior.version } : rec);
  }
  // self references inside this chunk are satisfied by chunkIds; drop deferred entries now resolvable
  state.deferred = state.deferred.filter((d) => !(d.table === table && d.target === table && chunkIds.has(d.value)));
  if (report.error_count > before) stats.errors += report.error_count - before;
  // a chunk with any error is not applied by importers (validation keeps counting)
  if (report.error_count > before && sink.mode !== 'VALIDATE') return [];
  clean.indexOnly = indexOnly;
  return clean;
}

function* processAttachments({ handle, sink, sha, report, state, manifest, timeUp, save, stop }) {
  const att = manifest.attachments;
  // the attachments the package itself declares (Attachments rows in data/) must match the index exactly
  const rows = state.att_rows || [];
  const expected = new Map(rows.filter((r) => r.status !== 'DELETED').map((r) => [r.id, r]));
  if (!att.included) {
    if (expected.size) report.warn('ATTACHMENTS_NOT_INCLUDED', { message: `${expected.size} files not in package` });
    return true;
  }
  if (!att.index) { report.error('ATTACHMENT_INDEX_MISSING', {}); return true; }
  const raw = bytesOf(yield handle.readBytes(att.index.path));
  if (!raw) { report.error('ATTACHMENT_INDEX_MISSING', { path: att.index.path }); return true; }
  if (sha(raw) !== att.index.sha256) { report.error('CHECKSUM_MISMATCH', { path: att.index.path }); return true; }
  let text;
  try { text = decodeText(raw); } catch (_) { report.error('ENCODING_ERROR', { path: att.index.path }); return true; }
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch (_) { report.error('ATTACHMENT_INDEX_INVALID', { path: att.index.path, line: i + 1 }); continue; }
    if (recordLine(e) !== lines[i]) { report.error('NOT_CANONICAL', { path: att.index.path, line: i + 1 }); continue; }
    const fe = validateValue(ATTACHMENT_INDEX_SCHEMA, e);
    if (fe.length || !isSafePath(e.path) || !e.path.startsWith('attachments/batch-') || e.path !== `${e.path.slice(0, e.path.lastIndexOf('/'))}/${e.logical_id}`) {
      report.error('ATTACHMENT_INDEX_INVALID', { path: att.index.path, line: i + 1, id: e.logical_id });
      continue;
    }
    entries.push(e);
  }
  if (!state.att_checked) {
    const inIndex = new Set(entries.map((e) => e.logical_id));
    const missingDeclared = new Set(att.missing.map((x) => x.logical_id));
    for (const [id] of expected) if (!inIndex.has(id) && !missingDeclared.has(id)) report.error('ATTACHMENT_NOT_IN_INDEX', { id });
    for (const e of entries) {
      const row = expected.get(e.logical_id);
      if (!row) report.error('ATTACHMENT_ORPHAN_INDEX', { id: e.logical_id });
      else if (row.sha256 !== e.sha256 || row.size_bytes !== e.size_bytes) report.error('ATTACHMENT_META_MISMATCH', { id: e.logical_id });
    }
    if (entries.length !== att.files) report.error('ROW_COUNT_MISMATCH', { path: att.index.path, expected: att.files, actual: entries.length });
    state.att_checked = true;
    yield* save();
    if (stop()) return true;
  }
  while (state.ai < entries.length) {
    if (timeUp()) { yield* save(); return false; }
    const e = entries[state.ai];
    const b = bytesOf(yield handle.readBytes(e.path));
    if (!b) report.error('ATTACHMENT_FILE_MISSING', { path: e.path, id: e.logical_id });
    else if (b.length !== e.size_bytes || sha(b) !== e.sha256) report.error('ATTACHMENT_CHECKSUM_MISMATCH', { path: e.path, id: e.logical_id });
    else {
      report.attachments.verified++;
      report.attachments.files++;
      report.attachments.bytes += b.length;
      if (sink.attachment && (report.ok || sink.mode === 'VALIDATE')) {
        const r = yield* sink.attachment(e, b);
        if (r && r.written) report.attachments.written++;
        else report.attachments.skipped++;
      }
    }
    state.ai++;
    if (state.ai % 20 === 0 || state.ai === entries.length) yield* save();
    if (stop()) return true;
  }
  return true;
}

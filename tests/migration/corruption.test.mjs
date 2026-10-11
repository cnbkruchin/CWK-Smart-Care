// Corruption (MASTER_PROMPT §18 "Corruption"): a missing chunk, a wrong checksum, an unsupported schema, a
// missing or altered attachment, a tampered manifest, unsafe paths and semantic damage hidden behind
// re-signed checksums must all stop the migration BEFORE anything is written to the target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSource, exportSource } from '../helpers/migration-fixture.mjs';
import { makeHarness } from '../helpers/app-harness.mjs';
import { clonePackage, readManifest, writeManifest, resign, editLine, sha } from '../helpers/package-tools.mjs';
import { runSync } from '../../src/application/runtime.js';
import { processPackage, CORRUPTION_CODES, INCOMPATIBLE_CODES } from '../../src/application/migration/process.js';
import { IndexSink } from '../../src/application/migration/sinks.js';
import { importIntoStore } from '../../src/application/migration/import.js';
import { recordLine } from '../../src/application/migration/format.js';

let base = null;
function fresh() {
  if (!base) base = exportSource(buildSource()).handle;
  return clonePackage(base);
}
const validate = (h) => runSync(processPackage, h, new IndexSink(), { sha256Hex: sha }).report;
const codes = (r) => [...new Set(r.errors.map((e) => e.code))];

/** Import into an empty target must refuse and leave it empty. */
function assertImportRefused(h) {
  const t = makeHarness({ now: '2026-06-16T02:00:00.000Z' });
  const res = runSync(importIntoStore, t.deps, h, { importId: 'corrupt' });
  assert.equal(res.report.ok, false);
  const n = ['Schools', 'Students', 'Users', 'AttendanceEvents', 'Attachments'].reduce((s, x) => s + t.store.count(x), 0);
  return { res, written: n };
}

const firstChunk = (h, table) => readManifest(h).tables.find((t) => t.name === table).partitions.find((p) => p.chunks.length).chunks[0];

test('the untouched package validates (control)', () => {
  const r = validate(fresh());
  assert.equal(r.ok, true, JSON.stringify(r.errors.slice(0, 3)));
});

test('missing chunk is caught by the preflight before anything is written; a flipped byte stops that chunk', () => {
  let h = fresh();
  h.remove(firstChunk(h, 'Students').path);
  let r = validate(h);
  assert.ok(codes(r).includes('CHUNK_MISSING'));
  assert.ok(r.hasCode(CORRUPTION_CODES));
  let imp = assertImportRefused(h);
  assert.equal(imp.written, 0, 'preflight: nothing written when a chunk is missing');

  h = fresh();
  const c = firstChunk(h, 'AttendanceEvents');
  const b = h.readBytes(c.path);
  b[10] = b[10] ^ 0x01;
  h.writeBytes(c.path, b);
  r = validate(h);
  assert.ok(codes(r).includes('CHECKSUM_MISMATCH'));
  imp = assertImportRefused(h);
  assert.equal(imp.res.report.tables.AttendanceEvents ? imp.res.report.tables.AttendanceEvents.inserted : 0, 0);
});

test('tampered manifest without a matching manifest.sha256 is refused', () => {
  const h = fresh();
  const m = readManifest(h);
  m.completeness = 'COMPLETE';
  m.tables[0].row_count += 1;
  writeManifest(h, m, { sign: false });
  const r = validate(h);
  assert.ok(codes(r).includes('MANIFEST_SHA_MISMATCH'));
  assertImportRefused(h);
});

test('unsupported schema/format versions are rejected outright (no upgrade path)', () => {
  let h = fresh();
  resign(h, (m) => { m.schema_version = 99; });
  let r = validate(h);
  assert.equal(r.fatal, true);
  assert.deepEqual(codes(r), ['INCOMPATIBLE_SCHEMA']);
  assert.ok(r.hasCode(INCOMPATIBLE_CODES));
  h = fresh();
  resign(h, (m) => { m.format_version = 2; });
  r = validate(h);
  assert.equal(r.fatal, true);
  assert.ok(codes(r).includes('UNSUPPORTED_FORMAT'));
});

test('unsafe paths are refused even when the manifest is re-signed', () => {
  const h = fresh();
  resign(h, (m) => { m.tables[0].partitions[0].chunks[0].path = '../outside/part-00001.jsonl'; });
  const r = validate(h);
  assert.equal(r.ok, false);
  assert.ok(codes(r).some((c) => ['UNSAFE_PATH', 'MANIFEST_INVALID'].includes(c)), codes(r).join());
  assert.throws(() => h.writeText('../escape.txt', 'x'), /unsafe/);
});

test('attachment missing or altered: checksum of the real bytes catches it', () => {
  let h = fresh();
  const idx = h.readText('attachment-index.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  h.remove(idx[0].path);
  let r = validate(h);
  assert.ok(codes(r).includes('ATTACHMENT_FILE_MISSING'));
  assertImportRefused(h);

  h = fresh();
  const bytes = h.readBytes(idx[0].path);
  bytes[bytes.length - 3] = 0x41;
  h.writeBytes(idx[0].path, bytes); // same size, different content
  r = validate(h);
  assert.ok(codes(r).includes('ATTACHMENT_CHECKSUM_MISMATCH'));
});

test('semantic damage behind re-signed checksums: non-canonical line, orphan FK, duplicate id, invalid value', () => {
  // non-canonical JSON (keys out of order) even with correct checksums
  let h = fresh();
  editLine(h, 'Classes', () => true, (line, rec) => JSON.stringify({ name_th: rec.name_th, ...rec }));
  resign(h);
  assert.ok(codes(validate(h)).includes('NOT_CANONICAL'));
  // enrollment pointing to a class that is not in the package
  h = fresh();
  editLine(h, 'Enrollments', () => true, (line, rec) => recordLine({ ...rec, class_id: '99999999-9999-4999-8999-999999999999' }));
  resign(h);
  let r = validate(h);
  assert.ok(codes(r).includes('FK_MISSING'), codes(r).join());
  let imp = assertImportRefused(h);
  assert.equal(imp.res.report.tables.Enrollments ? imp.res.report.tables.Enrollments.inserted : 0, 0, 'the damaged chunk is not applied');
  // the same student twice
  h = fresh();
  editLine(h, 'Students', () => true, (line) => [line, line]);
  resign(h);
  assert.ok(codes(validate(h)).includes('DUPLICATE_ID'));
  // a value that breaks the schema (student_code must be text; enum must be known)
  h = fresh();
  editLine(h, 'Students', () => true, (line, rec) => recordLine({ ...rec, status: 'SUSPENDED_FOREVER' }));
  resign(h);
  r = validate(h);
  assert.ok(codes(r).includes('RECORD_INVALID'));
  // ChangeLog beyond the declared high-water mark
  h = fresh();
  editLine(h, 'ChangeLog', () => true, (line, rec) => recordLine({ ...rec, seq: 999999 }));
  resign(h);
  assert.ok(codes(validate(h)).includes('AFTER_HIGH_WATER_MARK'));
});

test('completeness claims must be true: COMPLETE with missing attachments or unproven consistency is refused', () => {
  const h = fresh();
  resign(h, (m) => { m.attachments.missing = [{ logical_id: '99999999-9999-4999-8999-999999999999', reason: 'UNREADABLE' }]; });
  assert.ok(codes(validate(h)).includes('COMPLETENESS_INVALID'));
  const h2 = fresh();
  resign(h2, (m) => { m.consistency.non_live_tables_changed = ['Students']; });
  assert.ok(codes(validate(h2)).includes('COMPLETENESS_INVALID'));
});

test('unexpected files are reported; a package with an extra executable file is not silently accepted', () => {
  const h = fresh();
  h.writeText('data/Students/all/evil.sh', '#!/bin/sh\nrm -rf /\n');
  const r = validate(h);
  assert.ok(r.warnings.some((w) => w.code === 'UNLISTED_FILE' && w.path === 'data/Students/all/evil.sh'));
});

// Portable export (MASTER_PROMPT §15.2–15.3): freeze enforced by the server, canonical chunks with
// checksums, declared transforms (no secrets, no automatic replay), consistency proof, pause/resume and
// crash-resume from checkpoints, partial exports flagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSource, exportSource } from '../helpers/migration-fixture.mjs';
import { sha, readManifest } from '../helpers/package-tools.mjs';
import { runSync } from '../../src/application/runtime.js';
import { processPackage } from '../../src/application/migration/process.js';
import { IndexSink } from '../../src/application/migration/sinks.js';
import { canonicalStringify } from '../../src/shared/canonical-json.js';
import { EXCLUDED_TABLES, canonicalRecord, applyExportTransforms, recordLine } from '../../src/application/migration/format.js';
import { MemoryPackageStore } from '../../src/adapters/memory/memory-package.js';

const validate = (handle, level = 'FULL') => runSync(processPackage, handle, new IndexSink(), { sha256Hex: sha, level }).report;

function packageRecords(handle, table) {
  const m = readManifest(handle);
  const t = m.tables.find((x) => x.name === table);
  const out = [];
  for (const p of t.partitions) for (const c of p.chunks) for (const l of handle.readText(c.path).slice(0, -1).split('\n')) out.push(JSON.parse(l));
  return out;
}

test('full snapshot needs the server-enforced freeze; package holds canonical, checksummed, faithful records', () => {
  const src = buildSource();
  const { h, ids } = src;
  const refused = h.call(ids.admin, 'migration.startExport', { mode: 'FULL_SNAPSHOT', reason: 'ไม่ได้ freeze' });
  assert.equal(refused.error.code, 'INVALID_STATE');
  assert.equal(h.call(ids.affairs, 'migration.startExport', { mode: 'FULL_SNAPSHOT', reason: 'ไม่มีสิทธิ์' }).error.code, 'FORBIDDEN');
  const { run, handle } = exportSource(src);
  assert.equal(run.state, 'EXPORTED');
  assert.equal(run.completeness, 'COMPLETE');
  const m = readManifest(handle);
  // manifest.sha256 is sha256sum-compatible and covers the exact bytes (no self reference)
  assert.equal(handle.readText('manifest.sha256'), `${sha(handle.readBytes('manifest.json'))}  manifest.json\n`);
  assert.equal(run.manifest_sha256, sha(handle.readBytes('manifest.json')));
  // every chunk: checksum of bytes, canonical lines, LF only
  let rows = 0;
  for (const t of m.tables) for (const p of t.partitions) for (const c of p.chunks) {
    const b = handle.readBytes(c.path);
    assert.equal(sha(b), c.sha256, c.path);
    const text = Buffer.from(b).toString('utf8');
    assert.ok(text.endsWith('\n') && !text.includes('\r'));
    for (const l of text.slice(0, -1).split('\n')) { assert.equal(canonicalStringify(JSON.parse(l)), l); rows++; }
  }
  assert.equal(rows, m.tables.reduce((s, t) => s + t.row_count, 0));
  // every exported row equals the source row (after declared transforms only)
  for (const t of m.tables.filter((x) => !x.live && x.name !== 'ChangeLog')) {
    const got = new Map(packageRecords(handle, t.name).map((r) => [r.id, r]));
    const srcRows = h.store.list(t.name, { all: true }).items;
    assert.equal(got.size, srcRows.length, `${t.name} count`);
    for (const r of srcRows) assert.equal(recordLine(got.get(r.id)), recordLine(applyExportTransforms(t.name, canonicalRecord(t.name, r)).record), `${t.name} ${r.id}`);
  }
  // leading zeros, Thai, nulls, booleans and timestamps survive as typed values
  const zero = packageRecords(handle, 'Students').find((s) => s.id === src.zeroStudentId);
  assert.equal(zero.student_code, '00123');
  assert.equal(zero.first_name_th, 'ด.ญ. ศศิธร');
  assert.equal(zero.nickname, null);
  assert.equal(zero.birth_date, null);
  const ev = packageRecords(handle, 'AttendanceEvents')[0];
  assert.match(ev.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(typeof packageRecords(handle, 'StudentGuardians')[0].is_primary_contact, 'boolean');
  // excluded tables are not in data/ and are declared with their reason
  for (const name of Object.keys(EXCLUDED_TABLES)) {
    assert.ok(!m.tables.some((t) => t.name === name));
    assert.ok(m.excluded_tables.some((e) => e.name === name && e.reason === EXCLUDED_TABLES[name].reason));
    assert.ok(!handle.list().some((f) => f.path.startsWith(`data/${name}/`)));
  }
  // ChangeLog only up to the high-water mark
  const hwm = m.snapshot.high_water_mark.change_log_seq;
  assert.ok(packageRecords(handle, 'ChangeLog').every((e) => e.seq <= hwm));
  assert.equal(Math.max(...packageRecords(handle, 'ChangeLog').map((e) => e.seq)), hwm);
  assert.ok(m.consistency.checked && m.consistency.non_live_tables_changed.length === 0 && m.consistency.count_mismatches.length === 0);
  // the package re-validates (FULL) with zero errors
  const v = validate(handle);
  assert.equal(v.ok, true, JSON.stringify(v.errors.slice(0, 3)));
});

test('no secrets leave the system; pending messages are blocked from automatic replay; CSV copies are safe for Excel', () => {
  const src = buildSource();
  const { h } = src;
  const secretsInSource = [
    ...h.store.list('InvitationRecords', { all: true }).items.map((r) => r.code_hash),
    ...h.store.list('ChannelBindings', { all: true }).items.map((r) => r.link_nonce_hash).filter(Boolean),
  ];
  assert.ok(secretsInSource.length >= 2);
  const { handle } = exportSource(src);
  const all = handle.list().map((f) => Buffer.from(handle.readBytes(f.path)).toString('latin1')).join('\n');
  for (const s of secretsInSource) assert.ok(!all.includes(s), 'secret hash must not appear anywhere in the package');
  assert.ok(!all.includes('test-passphrase-123'));
  const inv = packageRecords(handle, 'InvitationRecords');
  assert.ok(inv.every((r) => r.code_hash === 'REDACTED' && r.status !== 'PENDING'));
  const outbox = packageRecords(handle, 'NotificationOutbox');
  assert.ok(outbox.length > 0);
  assert.ok(outbox.filter((o) => !['PROVIDER_ACCEPTED', 'FAILED_FINAL', 'CANCELLED'].includes(o.delivery_state)).every((o) => o.replay_blocked === true));
  const m = readManifest(handle);
  assert.ok(m.transforms.find((t) => t.table === 'NotificationOutbox').rows_affected > 0);
  // canonical JSONL keeps the true value; the human CSV neutralises the formula
  const log = packageRecords(handle, 'ContactLogs').find((l) => l.summary.startsWith('=1+1'));
  assert.ok(log);
  const csvRef = m.tables.find((t) => t.name === 'ContactLogs').partitions.flatMap((p) => p.chunks)[0].csv;
  const csv = handle.readText(csvRef.path);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("'=1+1"));
  assert.ok(handle.readText('csv/DATA_DICTIONARY.csv').includes('student_code'));
  // attachments: real bytes with SHA-256, index links back to the leave request
  const idx = handle.readText('attachment-index.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(idx.length, 1);
  assert.equal(sha(handle.readBytes(idx[0].path)), idx[0].sha256);
  assert.equal(idx[0].links[0].entity_type, 'LEAVE_REQUEST');
  assert.ok(!handle.list().some((f) => f.path.startsWith('attachments/index-pages/')), 'work files removed');
});

test('a source that changes after the high-water mark is detected: completeness FAILED, never COMPLETE', () => {
  const pkgs = new MemoryPackageStore();
  let src;
  const create = pkgs.create.bind(pkgs);
  pkgs.create = (name) => {
    // an operation that started before the freeze finishes after H was recorded
    const mode = src.h.config.systemMode;
    src.h.config.systemMode = 'NORMAL'; src.h.store.mode = 'NORMAL';
    src.h.ok(src.ids.affairs, 'student.update', { student_id: src.zeroStudentId, nickname: 'ฟ้า', reason: 'แก้ชื่อเล่นระหว่างส่งออก' }, { expectedVersion: src.h.store.get('Students', src.zeroStudentId).version });
    src.h.config.systemMode = mode; src.h.store.mode = mode;
    return create(name);
  };
  src = buildSource({ packageStore: pkgs });
  const { run, handle } = exportSource(src);
  assert.equal(run.completeness, 'FAILED');
  assert.equal(run.state, 'FAILED');
  const m = readManifest(handle);
  assert.ok(m.completeness_reasons.includes('SOURCE_CHANGED_DURING_SNAPSHOT'));
  assert.ok(m.consistency.non_live_tables_changed.includes('Students'));
  const v = JSON.parse(handle.readText('reports/validation.json'));
  assert.equal(v.usable_for_cutover, false);
});

test('pause and crash during export resume from checkpoints without duplicate or missing rows', () => {
  const pkgs = new MemoryPackageStore();
  let src;
  let writes = 0;
  let crashed = false;
  const open = pkgs.open.bind(pkgs);
  pkgs.open = (loc) => {
    const hnd = open(loc);
    const wt = hnd.writeText.bind(hnd);
    hnd.writeText = (p, text) => {
      if (p.startsWith('data/')) {
        writes++;
        if (writes === 5) { // operator pauses after a few chunks
          const run = src.h.store.list('MigrationRuns', { all: true }).items[0];
          src.h.ok(src.ids.admin, 'migration.pause', { run_id: run.id });
        }
        if (writes === 12 && !crashed) { crashed = true; throw new Error('simulated execution crash'); }
      }
      return wt(p, text);
    };
    return hnd;
  };
  src = buildSource({ packageStore: pkgs });
  const { h, ids } = src;
  h.ok(ids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'freeze' });
  const st = h.ok(ids.admin, 'migration.startExport', { mode: 'FULL_SNAPSHOT', reason: 'ทดสอบ resume' });
  h.runJobs();
  assert.equal(h.store.get('Jobs', st.job_id).status, 'PAUSED');
  const paused = h.ok(ids.admin, 'migration.get', { run_id: st.run_id });
  assert.equal(paused.run.state, 'SNAPSHOTTING');
  assert.ok(paused.chunks >= 4);
  h.runJobs();
  assert.equal(h.store.get('Jobs', st.job_id).status, 'PAUSED', 'a paused job is not picked up');
  h.ok(ids.admin, 'migration.resume', { run_id: st.run_id });
  h.runJobs(); // crashes once → retried with backoff
  assert.equal(h.store.get('Jobs', st.job_id).status, 'QUEUED');
  assert.match(h.store.get('Jobs', st.job_id).last_error, /simulated execution crash/);
  h.clock.advance(5 * 60 * 1000);
  h.runJobs();
  const run = h.store.get('MigrationRuns', st.run_id);
  assert.equal(run.state, 'EXPORTED');
  assert.equal(run.completeness, 'COMPLETE');
  const handle = pkgs.open(run.package_location);
  assert.equal(validate(handle).ok, true);
  const students = packageRecords(handle, 'Students');
  assert.equal(new Set(students.map((s) => s.id)).size, h.store.count('Students'));
});

test('partial export is flagged PARTIAL with missing dependencies and is not importable on its own', () => {
  const src = buildSource();
  const { h, ids } = src;
  const st = h.ok(ids.admin, 'migration.startExport', { mode: 'PARTIAL', tables: ['Students', 'Enrollments'], include_attachments: false, reason: 'ส่งให้ฝ่ายทะเบียนตรวจ' });
  assert.ok(st.missing_dependencies.some((d) => d.includes('Classes')));
  for (let i = 0; i < 5; i++) h.runJobs();
  const run = h.store.get('MigrationRuns', st.run_id);
  const handle = src.packageStore.open(run.package_location);
  const m = readManifest(handle);
  assert.equal(m.completeness, 'PARTIAL');
  assert.ok(m.completeness_reasons.some((r) => r.startsWith('MISSING_DEPENDENCIES')));
  assert.ok(m.completeness_reasons.includes('PARTIAL_MODE'));
  assert.deepEqual(m.tables.map((t) => t.name), ['Students', 'Enrollments']);
  const v = validate(handle);
  assert.ok(v.errors.some((e) => e.code === 'FK_PARENT_NOT_EXPORTED'));
  assert.equal(JSON.parse(handle.readText('reports/validation.json')).usable_for_cutover, false);
  assert.equal(h.call(ids.admin, 'migration.startExport', { mode: 'PARTIAL', tables: ['MutationJournal'], reason: 'ไม่ได้' }).error.code, 'VALIDATION_ERROR');
});

test('inventory lists every table, partition, attachment total and the export policy', () => {
  const src = buildSource();
  const inv = src.h.ok(src.ids.admin, 'migration.inventory', {});
  assert.equal(inv.schema_version, 1);
  const students = inv.tables.find((t) => t.table === 'Students');
  assert.equal(students.rows, src.h.store.count('Students'));
  assert.equal(inv.tables.find((t) => t.table === 'MutationJournal').export, 'TRANSIENT');
  assert.equal(inv.attachments.files, 1);
  assert.ok(inv.tables.find((t) => t.table === 'AttendanceEvents').partitions.some((p) => p.key === 'AY2026-T1' && p.rows > 0));
  assert.equal(src.h.call(src.ids.homeroom1, 'migration.inventory', {}).error.code, 'FORBIDDEN');
});

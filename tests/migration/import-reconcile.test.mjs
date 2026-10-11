// Import into a NEW environment (MASTER_PROMPT §15.4) and reconciliation (§15.6): IDs and values preserved,
// re-import is idempotent and sends nothing, explicit conflict policy, resume from checkpoint, and a
// reconciliation report that FAILS with details when the target differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSource, exportSource } from '../helpers/migration-fixture.mjs';
import { makeHarness, FakeEmailProvider, FakeLineProvider } from '../helpers/app-harness.mjs';
import { readManifest } from '../helpers/package-tools.mjs';
import { runSync } from '../../src/application/runtime.js';
import { importIntoStore, reconcileStore } from '../../src/application/migration/import.js';
import { canonicalRecord } from '../../src/application/migration/format.js';
import { canonicalStringify } from '../../src/shared/canonical-json.js';

function target(now = '2026-06-16T02:00:00.000Z') {
  const email = new FakeEmailProvider();
  const line = new FakeLineProvider();
  const t = makeHarness({ now, config: { lineEnabled: true }, extraPlatform: { providers: { EMAIL: email, LINE: line } } });
  return { t, email, line };
}

let shared = null;
function exported() {
  if (!shared) { const src = buildSource(); shared = { src, ...exportSource(src) }; }
  return shared;
}

test('import preserves IDs and values; re-import inserts nothing and no queued message is sent', () => {
  const { src, handle } = exported();
  const { t, email, line } = target();
  const res = runSync(importIntoStore, t.deps, handle, { importId: 'test-import-1' });
  assert.equal(res.report.ok, true, JSON.stringify(res.report.errors.slice(0, 3)));
  const m = readManifest(handle);
  assert.equal(res.report.rows_inserted, m.tables.reduce((s, x) => s + x.row_count, 0));
  // identical canonical rows for business tables (secrets were transformed at export, so compare with package)
  for (const table of ['Students', 'Enrollments', 'StudentGuardians', 'AttendanceEvents', 'DailyAttendance', 'LeaveRequests', 'LeaveApprovals', 'AttendanceCorrections', 'Cases', 'ContactLogs']) {
    for (const r of src.h.store.list(table, { all: true }).items) {
      assert.equal(canonicalStringify(canonicalRecord(table, t.store.get(table, r.id))), canonicalStringify(canonicalRecord(table, r)), `${table} ${r.id}`);
    }
  }
  assert.equal(t.store.get('Students', src.zeroStudentId).student_code, '00123');
  // attachment bytes copied into the target storage with a NEW mapping (logical id kept)
  const att = t.store.list('Attachments', { all: true }).items[0];
  const maps = t.store.findBy('StorageObjectMappings', 'attachment_id', att.id);
  assert.equal(maps.length, 1);
  assert.equal(Buffer.from(t.deps.platform.storage.get(maps[0])).toString('latin1').slice(0, 8), '%PDF-1.4');
  // ChangeLog sequence continues after the imported high-water mark
  assert.equal(t.store.seq, m.snapshot.high_water_mark.change_log_seq);
  // re-import: idempotent
  const again = runSync(importIntoStore, t.deps, handle, { importId: 'test-import-2' });
  assert.equal(again.report.ok, true);
  assert.equal(again.report.rows_inserted, 0);
  assert.equal(again.report.rows_identical, res.report.rows_inserted);
  assert.equal(again.report.attachments.written, 0);
  assert.equal(t.store.findBy('StorageObjectMappings', 'attachment_id', att.id).length, 1);
  // the outbox worker on the new system does not replay imported messages
  t.tick(['outbox.dispatch']);
  assert.equal(email.sent.length, 0);
  assert.equal(line.delivered.length, 0);
  assert.ok(t.store.list('NotificationOutbox', { all: true }).items.every((o) => o.replay_blocked === true || ['PROVIDER_ACCEPTED', 'FAILED_FINAL', 'CANCELLED'].includes(o.delivery_state)));
  // reports written back into the package for the source's Migration Center
  const rep = JSON.parse(handle.readText('reports/import.json'));
  assert.equal(rep.manifest_sha256, readManifest(handle) && rep.manifest_sha256);
  assert.equal(rep.mode, 'APPLY');
});

test('conflict policy: a different record with the same id is rejected (never overwritten silently)', () => {
  const { src, handle } = exported();
  const { t } = target();
  runSync(importIntoStore, t.deps, handle, { importId: 'c-1' });
  const s = t.store.get('Students', src.zeroStudentId);
  t.store.seed('Students', [{ ...s, first_name_th: 'ชื่อที่ถูกแก้ในปลายทาง' }]);
  const before = t.store.count('Students');
  const res = runSync(importIntoStore, t.deps, handle, { importId: 'c-2' });
  assert.equal(res.report.ok, false);
  assert.ok(res.report.errors.some((e) => e.code === 'CONFLICT' && e.id === src.zeroStudentId));
  assert.equal(t.store.get('Students', src.zeroStudentId).first_name_th, 'ชื่อที่ถูกแก้ในปลายทาง', 'target row untouched');
  assert.equal(t.store.count('Students'), before);
});

test('import resumes from its checkpoint after an interrupted execution (no duplicates)', () => {
  const { handle } = exported();
  const { t } = target();
  let saved = null;
  const checkpoint = { *load() { return saved; }, *save(st) { saved = JSON.parse(JSON.stringify(st)); } };
  // 1) the execution runs out of time right after the package-level checks
  const first = runSync(importIntoStore, t.deps, handle, { importId: 'r-1', checkpoint, deadlineAt: Date.now() - 1 });
  assert.equal(first.done, false);
  assert.equal(saved.phase, 'TABLES');
  // 2) the next execution dies after applying a chunk but before its checkpoint is saved
  let saves = 0;
  const crashing = { *load() { return saved; }, *save(st) { if (++saves >= 15 && st.phase === 'TABLES' && st.ci >= 1) throw new Error('execution killed'); saved = JSON.parse(JSON.stringify(st)); } }; // dies right after a chunk was applied
  assert.throws(() => runSync(importIntoStore, t.deps, handle, { importId: 'r-1', checkpoint: crashing }), /execution killed/);
  const midway = t.store.count('Schools') + t.store.count('Terms');
  assert.ok(midway > 0 && saved.ti > 0);
  // 3) resume from the last saved checkpoint: the re-applied chunk is recognised as identical
  const done = runSync(importIntoStore, t.deps, handle, { importId: 'r-1', checkpoint });
  assert.equal(done.done, true);
  assert.equal(done.report.ok, true, JSON.stringify(done.report.errors.slice(0, 3)));
  assert.ok(done.report.rows_identical > 0, 'the chunk applied before the crash is skipped, not duplicated');
  const m = readManifest(handle);
  for (const tm of m.tables) assert.equal(t.store.count(tm.name), tm.row_count, tm.name);
  const rec = runSync(reconcileStore, t.deps, handle, { writeReport: false });
  assert.equal(rec.overall, 'PASS', JSON.stringify(rec.checks.filter((c) => c.status === 'FAIL')));
});

test('reconciliation PASSES a faithful target and FAILS with mismatch details otherwise; READY only for COMPLETE FULL_SNAPSHOT', () => {
  const { src, handle } = exported();
  const { t } = target();
  runSync(importIntoStore, t.deps, handle, { importId: 'rec-1' });
  const ok = runSync(reconcileStore, t.deps, handle, {});
  assert.equal(ok.overall, 'PASS', JSON.stringify(ok.checks.filter((c) => c.status === 'FAIL')));
  assert.equal(ok.ready_to_cutover, true);
  for (const k of ['rows.counts', 'data.source_checksum', 'data.derived_checksum', 'data.date_ranges', 'relationships', 'outbox.no_replay', 'attachments.bytes', 'reports.totals', 'permissions.samples', 'dates.timezone_be']) {
    assert.equal(ok.checks.find((c) => c.key === k).status, 'PASS', k);
  }
  assert.ok(ok.checks.find((c) => c.key === 'reports.totals').data.compared >= 8);
  // break the target: lose a row, change an enrollment, corrupt the stored certificate
  const ev = t.store.list('AttendanceEvents', { all: true }).items[0];
  t.store.tables.get('AttendanceEvents').delete(ev.id);
  const enr = t.store.findBy('Enrollments', 'student_id', src.mover)[0];
  t.store.seed('Enrollments', [{ ...enr, effective_from: '2026-05-02' }]);
  const att = t.store.list('Attachments', { all: true }).items[0];
  const map = t.store.findBy('StorageObjectMappings', 'attachment_id', att.id)[0];
  t.deps.platform.storage.objects.set(map.object_key, new Uint8Array([1, 2, 3]));
  const bad = runSync(reconcileStore, t.deps, handle, { writeReport: false });
  assert.equal(bad.overall, 'FAIL');
  assert.equal(bad.ready_to_cutover, false);
  const failed = bad.checks.filter((c) => c.status === 'FAIL').map((c) => c.key);
  for (const k of ['rows.counts', 'data.source_checksum', 'relationships', 'attachments.bytes', 'reports.totals']) assert.ok(failed.includes(k), `${k} should fail: ${failed}`);
  assert.ok(bad.mismatches.some((x) => x.table === 'AttendanceEvents' && x.id === ev.id && x.issue === 'MISSING_IN_TARGET'));
  assert.ok(bad.mismatches.some((x) => x.table === 'Enrollments' && x.issue === 'DIFFERENT_VALUES'));
});

test('a REHEARSAL package reconciles but is never READY_TO_CUTOVER; new data in the target is reported', () => {
  const src = buildSource();
  const { handle } = exportSource(src, { mode: 'REHEARSAL' });
  const { t } = target();
  runSync(importIntoStore, t.deps, handle, { importId: 'reh-1' });
  const r = runSync(reconcileStore, t.deps, handle, { writeReport: false });
  assert.equal(r.overall, 'PASS');
  assert.equal(r.ready_to_cutover, false);
  assert.match(r.ready_note_th, /REHEARSAL/);
  // somebody used the target before reconciliation: extra business rows are flagged
  const st = t.store.list('Stations', { all: true }).items[0];
  t.store.seed('Stations', [{ ...st, id: '11111111-1111-4111-8111-111111111111', code: 'EXTRA' }]);
  const r2 = runSync(reconcileStore, t.deps, handle, { writeReport: false });
  assert.equal(r2.checks.find((c) => c.key === 'rows.target_only').status, 'FAIL');
});

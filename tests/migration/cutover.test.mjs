// Cutover and rollback (MASTER_PROMPT §15.7, §18 "Cutover", "Rollback"): the Migration state machine needs
// evidence at every step, the source becomes a read-only archive (single writer = new system; background
// jobs do not write back), and rolling back after new data exists brings the delta home — nothing is lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildSource, exportSource, BKK, PDF_BYTES } from '../helpers/migration-fixture.mjs';
import { makeHarness } from '../helpers/app-harness.mjs';
import { readManifest, sha } from '../helpers/package-tools.mjs';
import { runSync } from '../../src/application/runtime.js';
import { importIntoStore, reconcileStore } from '../../src/application/migration/import.js';
import { exportDelta, applyDelta } from '../../src/application/migration/delta.js';
import { READINESS_ITEMS } from '../../src/application/ops/migration.js';

const DOMAIN = ['AttendanceEvents', 'DailyAttendance', 'LeaveRequests', 'NotificationOutbox', 'Cases', 'Students'];
const counts = (store) => Object.fromEntries(DOMAIN.map((t) => [t, store.count(t)]));

function stagedFlow() {
  const src = buildSource();
  const { h, ids } = src;
  const { run, handle } = exportSource(src);
  h.ok(ids.admin, 'migration.validate', { run_id: run.id });
  h.runJobs();
  assert.equal(h.store.get('MigrationRuns', run.id).state, 'VALIDATED');
  // the new environment imports and reconciles; its reports land in the package's reports/ folder
  const t = makeHarness({ now: BKK('2026-06-15', '17:00') });
  const imp = runSync(importIntoStore, t.deps, handle, { importId: crypto.randomUUID(), target: 'memory' });
  assert.equal(imp.report.ok, true);
  assert.equal(h.call(ids.affairs, 'migration.recordEvidence', { run_id: run.id, kind: 'IMPORT' }).error.code, 'FORBIDDEN');
  h.ok(ids.admin, 'migration.recordEvidence', { run_id: run.id, kind: 'IMPORT' });
  return { src, run, handle, t, importedSeq: t.store.seq };
}

test('state machine: evidence for every step; a failed reconciliation never reaches CUTOVER_READY', () => {
  const { src, run, handle, t } = stagedFlow();
  const { h, ids } = src;
  assert.equal(h.store.get('MigrationRuns', run.id).state, 'STAGED');
  // a broken target reconciles FAIL → stays STAGED; markReady refused
  const s = t.store.list('Students', { all: true }).items[0];
  t.store.seed('Students', [{ ...s, last_name_th: 'ผิด' }]);
  runSync(reconcileStore, t.deps, handle, {});
  const fail = h.ok(ids.admin, 'migration.recordEvidence', { run_id: run.id, kind: 'RECONCILIATION' });
  assert.equal(fail.overall, 'FAIL');
  assert.equal(h.store.get('MigrationRuns', run.id).state, 'STAGED');
  h.ok(ids.admin, 'migration.checklist', { run_id: run.id, items: Object.fromEntries(READINESS_ITEMS.map((i) => [i.key, true])) });
  const notReady = h.call(ids.admin, 'migration.markReady', { run_id: run.id });
  assert.equal(notReady.error.code, 'INVALID_STATE');
  // fix the target, reconcile again → RECONCILED; markReady needs the full checklist
  t.store.seed('Students', [s]);
  runSync(reconcileStore, t.deps, handle, {});
  assert.equal(h.ok(ids.admin, 'migration.recordEvidence', { run_id: run.id, kind: 'RECONCILIATION' }).overall, 'PASS');
  h.ok(ids.admin, 'migration.checklist', { run_id: run.id, items: { rollback_plan: false } });
  assert.match(h.call(ids.admin, 'migration.markReady', { run_id: run.id }).error.message_th, /rollback_plan/);
  h.ok(ids.admin, 'migration.checklist', { run_id: run.id, items: { rollback_plan: true } });
  h.ok(ids.admin, 'migration.markReady', { run_id: run.id });
  assert.equal(h.store.get('MigrationRuns', run.id).state, 'CUTOVER_READY');
  // evidence from another package is refused
  const other = JSON.parse(handle.readText('reports/reconciliation.json'));
  handle.writeText('reports/reconciliation.json', JSON.stringify({ ...other, manifest_sha256: 'f'.repeat(64) }));
  assert.equal(h.call(ids.admin, 'migration.recordEvidence', { run_id: run.id, kind: 'RECONCILIATION' }).error.code, 'INTEGRITY_ERROR');
});

test('cutover: the source becomes a read-only archive — no writes from users or background jobs; mode cannot be reopened', () => {
  const { src, run, handle, t } = stagedFlow();
  const { h, ids, station } = src;
  runSync(reconcileStore, t.deps, handle, {});
  h.ok(ids.admin, 'migration.recordEvidence', { run_id: run.id, kind: 'RECONCILIATION' });
  h.ok(ids.admin, 'migration.checklist', { run_id: run.id, items: Object.fromEntries(READINESS_ITEMS.map((i) => [i.key, true])) });
  h.ok(ids.admin, 'migration.markReady', { run_id: run.id });
  assert.equal(h.call(ids.admin, 'migration.cutover', { run_id: run.id, reason: 'สลับระบบ', confirm: 'cutover' }).error.code, 'VALIDATION_ERROR');
  h.ok(ids.admin, 'migration.cutover', { run_id: run.id, reason: 'สลับไประบบใหม่ตามแผน', confirm: 'CUTOVER' });
  assert.equal(h.store.get('MigrationRuns', run.id).state, 'ACTIVE');
  assert.equal(h.config.systemMode, 'READ_ONLY');
  const reopen = h.call(ids.admin, 'system.setMode', { mode: 'NORMAL', reason: 'ลองเปิด' });
  assert.equal(reopen.error.code, 'INVALID_STATE');
  const before = counts(h.store);
  h.clock.set(BKK('2026-06-16', '07:40'));
  const write = h.call(ids.duty, 'attendance.recordArrival', { student_id: src.late, station_id: station.id, source: 'SCAN_KEYBOARD' });
  assert.equal(write.error.code, 'MAINTENANCE_MODE');
  h.clock.set(BKK('2026-06-16', '16:45'));
  h.tick();
  h.runJobs();
  assert.deepEqual(counts(h.store), before, 'no domain table changed on the archive');
  // the new system is the single writer
  t.clock.set(BKK('2026-06-16', '07:40'));
  assert.equal(t.ok(ids.duty, 'attendance.recordArrival', { student_id: src.late, station_id: station.id, source: 'SCAN_KEYBOARD' }).is_late, false);
});

test('cutover refused when the source changed after the snapshot (stale package)', () => {
  const { src, run, handle, t } = stagedFlow();
  const { h, ids } = src;
  runSync(reconcileStore, t.deps, handle, {});
  h.ok(ids.admin, 'migration.recordEvidence', { run_id: run.id, kind: 'RECONCILIATION' });
  h.ok(ids.admin, 'migration.checklist', { run_id: run.id, items: Object.fromEntries(READINESS_ITEMS.map((i) => [i.key, true])) });
  h.ok(ids.admin, 'migration.markReady', { run_id: run.id });
  h.ok(ids.admin, 'system.setMode', { mode: 'NORMAL', reason: 'เปิดใช้ชั่วคราว (ผิดแผน)' });
  h.ok(ids.affairs, 'student.update', { student_id: src.zeroStudentId, nickname: 'ฟ้า', reason: 'แก้หลังส่งออก' }, { expectedVersion: h.store.get('Students', src.zeroStudentId).version });
  h.ok(ids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'freeze อีกครั้ง' });
  const res = h.call(ids.admin, 'migration.cutover', { run_id: run.id, reason: 'สลับ', confirm: 'CUTOVER' });
  assert.equal(res.error.code, 'INVALID_STATE');
  assert.match(res.error.message_th, /Students/);
});

test('rollback after new data: the delta (rows + attachment) returns to the source before it reopens — nothing is lost', () => {
  const { src, run, handle, t, importedSeq } = stagedFlow();
  const { h, ids, station, g } = src;
  runSync(reconcileStore, t.deps, handle, {});
  h.ok(ids.admin, 'migration.recordEvidence', { run_id: run.id, kind: 'RECONCILIATION' });
  h.ok(ids.admin, 'migration.checklist', { run_id: run.id, items: Object.fromEntries(READINESS_ITEMS.map((i) => [i.key, true])) });
  h.ok(ids.admin, 'migration.markReady', { run_id: run.id });
  h.ok(ids.admin, 'migration.cutover', { run_id: run.id, reason: 'สลับระบบ', confirm: 'CUTOVER' });
  // the new system is used for a day: arrivals, a leave with a new certificate, an approval
  t.clock.set(BKK('2026-06-16', '07:45'));
  const arrival = t.ok(ids.duty, 'attendance.recordArrival', { student_id: src.late, station_id: station.id, source: 'SCAN_KEYBOARD' });
  const leave = t.ok(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'SICK', reason: 'มีไข้ (ข้อมูลใหม่หลังสลับระบบ)', days: [{ school_date: '2026-06-17', unit: 'FULL_DAY' }], attachments: [{ filename: 'cert2.pdf', mime_type: 'application/pdf', content_base64: Buffer.concat([PDF_BYTES, Buffer.from('2')]).toString('base64') }] });
  t.ok(ids.homeroom1, 'leave.decide', { leave_request_id: leave.leave_request_id, decision: 'APPROVED' });
  t.ok(ids.affairs, 'student.update', { student_id: src.zeroStudentId, nickname: 'ฟ้าใส', reason: 'แก้ในระบบใหม่' }, { expectedVersion: t.store.get('Students', src.zeroStudentId).version });
  // a problem is found → freeze the new system, export its changes since the import, bring them back
  t.ok(ids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'freeze ระบบใหม่ก่อนย้อนกลับ' });
  const loc = src.packageStore.create('delta-rollback');
  const dh = src.packageStore.open(loc);
  const d = runSync(exportDelta, t.deps, { sinceSeq: importedSeq, baseExportId: run.id, handle: dh, exportId: crypto.randomUUID(), frozen: true });
  assert.ok(d.rows > 0);
  const dm = readManifest(dh);
  assert.equal(dm.kind, 'DELTA');
  assert.equal(dm.completeness, 'COMPLETE');
  assert.ok(!dm.tables.some((x) => x.name === 'ChangeLog' && x.row_count > 0));
  // rollback without the evidence is refused
  assert.equal(h.call(ids.admin, 'migration.rollback', { run_id: run.id, case: 'NEW_DATA_RETURNED', reason: 'พบปัญหา', delta_location: loc }).error.code, 'INVALID_STATE');
  // dry run, then apply onto the (read-only) source
  const dry = runSync(applyDelta, h.deps, dh, { dryRun: true });
  assert.equal(dry.report.ok, true, JSON.stringify(dry.report.errors.slice(0, 3)));
  assert.equal(h.store.get('AttendanceEvents', arrival.event_id || arrival.id), null, 'dry run writes nothing');
  const applied = runSync(applyDelta, h.deps, dh, {});
  assert.equal(applied.report.ok, true, JSON.stringify(applied.report.errors.slice(0, 3)));
  assert.ok(applied.report.rows_inserted > 0);
  assert.ok(applied.report.rows_updated > 0, 'rows that existed before cutover are updated to the newer version');
  assert.equal(h.store.get('Students', src.zeroStudentId).nickname, 'ฟ้าใส');
  // the new data is on the source now — same ids, same values, attachment bytes included
  const newLeave = t.store.get('LeaveRequests', leave.leave_request_id);
  assert.deepEqual(h.store.get('LeaveRequests', leave.leave_request_id), newLeave);
  const att = t.store.findBy('AttachmentLinks', 'entity_id', leave.leave_request_id)[0];
  const map = h.store.findBy('StorageObjectMappings', 'attachment_id', att.attachment_id).filter((m) => m.status === 'ACTIVE')[0];
  assert.equal(sha(h.deps.platform.storage.get(map)), t.store.get('Attachments', att.attachment_id).sha256);
  // applying the same delta again changes nothing
  const again = runSync(applyDelta, h.deps, dh, {});
  assert.equal(again.report.rows_inserted + again.report.rows_updated, 0);
  // rollback recorded with evidence; the source can reopen
  h.ok(ids.admin, 'migration.rollback', { run_id: run.id, case: 'NEW_DATA_RETURNED', reason: 'ระบบใหม่ส่งแจ้งเตือนไม่ได้ ย้อนกลับก่อน', delta_location: loc });
  assert.equal(h.store.get('MigrationRuns', run.id).state, 'ROLLED_BACK');
  h.ok(ids.admin, 'system.setMode', { mode: 'NORMAL', reason: 'เปิดใช้ระบบเดิมหลังนำ delta กลับ' });
  // the imported pending message from the new system is blocked from automatic sending
  assert.ok(h.store.list('NotificationOutbox', { all: true }).items.filter((o) => o.created_at > BKK('2026-06-16', '00:00')).every((o) => o.replay_blocked === true || ['PROVIDER_ACCEPTED', 'FAILED_FINAL', 'CANCELLED'].includes(o.delivery_state)));
});

test('rollback without new data needs no delta; a conflicting change on both sides stops the delta apply', () => {
  const { src, run, handle, t, importedSeq } = stagedFlow();
  const { h, ids } = src;
  runSync(reconcileStore, t.deps, handle, {});
  h.ok(ids.admin, 'migration.recordEvidence', { run_id: run.id, kind: 'RECONCILIATION' });
  h.ok(ids.admin, 'migration.checklist', { run_id: run.id, items: Object.fromEntries(READINESS_ITEMS.map((i) => [i.key, true])) });
  h.ok(ids.admin, 'migration.markReady', { run_id: run.id });
  h.ok(ids.admin, 'migration.cutover', { run_id: run.id, reason: 'สลับ', confirm: 'CUTOVER' });
  // both systems edited the same student (must never happen with one writer — the apply refuses it)
  const sid = src.zeroStudentId;
  t.ok(ids.affairs, 'student.update', { student_id: sid, nickname: 'ระบบใหม่', reason: 'แก้ในระบบใหม่' }, { expectedVersion: t.store.get('Students', sid).version });
  const s = h.store.get('Students', sid);
  h.store.seed('Students', [{ ...s, nickname: 'ระบบเดิม', version: s.version + 1 }]);
  const dh = src.packageStore.open(src.packageStore.create('delta-conflict'));
  runSync(exportDelta, t.deps, { sinceSeq: importedSeq, baseExportId: run.id, handle: dh, exportId: crypto.randomUUID() });
  const res = runSync(applyDelta, h.deps, dh, {});
  assert.equal(res.report.ok, false);
  assert.ok(res.report.errors.some((e) => e.code === 'CONFLICT' && e.id === sid));
  assert.equal(h.store.get('Students', sid).nickname, 'ระบบเดิม', 'source row untouched');
  // no new data path
  h.store.seed('Students', [s]);
  h.ok(ids.admin, 'migration.rollback', { run_id: run.id, case: 'NO_NEW_DATA', reason: 'ยังไม่มีการใช้งานระบบใหม่' });
  assert.equal(h.store.get('MigrationRuns', run.id).state, 'ROLLED_BACK');
});

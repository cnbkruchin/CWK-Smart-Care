// Operations (MASTER_PROMPT §10.3, §14): metrics flush → OperationMetrics, backups (manual + nightly
// once per day) with restore-test records, retention of operational logs by expired term partition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/app-harness.mjs';

const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();

class FakeBackup {
  constructor() { this.calls = []; }
  snapshot(args) {
    this.calls.push(args);
    return { package_location: `folder-${this.calls.length}`, files: [{ role: 'MASTER', partition: '*' }, { role: 'PARTITION', partition: 'AY2026-T1' }], row_counts: { '*/Students': 10 }, manifest_sha256: 'a'.repeat(64), pruned: 0 };
  }
}

function setup(now = BKK('2026-06-15', '10:00')) {
  const backup = new FakeBackup();
  const h = makeHarness({ now, extraPlatform: { backup } });
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  return { h, ids, backup };
}

test('request metrics are flushed per 5-minute bucket into OperationMetrics and summarised', () => {
  const { h, ids } = setup();
  for (let i = 0; i < 5; i++) h.ok(ids.affairs, 'class.list', {});
  h.call(ids.duty, 'report.preview', { code: 'R01', filter: { date: '2026-06-15' } }); // a FORBIDDEN error
  h.clock.advance(6 * 60 * 1000);
  const out = h.tick(['ops.schedule'])['ops.schedule'];
  assert.ok(out.metrics.rows >= 2);
  const rows = h.store.list('OperationMetrics', { limit: 100 }).items;
  const cl = rows.find((r) => r.operation === 'class.list');
  assert.equal(cl.count >= 5, true);
  assert.ok(cl.p95_ms >= cl.p50_ms);
  const rp = rows.find((r) => r.operation === 'report.preview');
  assert.equal(rp.error_count, 1);
  const m = h.ok(ids.admin, 'system.metrics', { hours: 1 });
  assert.ok(m.items.some((x) => x.operation === 'report.preview' && x.error_rate === 100));
  assert.equal(h.call(ids.homeroom1, 'system.metrics', {}).error.code, 'FORBIDDEN');
  // nothing left to flush
  h.clock.advance(6 * 60 * 1000);
  assert.ok(h.tick(['ops.schedule'])['ops.schedule'].metrics.rows >= 1, 'the system.metrics calls themselves are measured');
});

test('backups: manual run, nightly once per day, restore-test record, permissions', () => {
  const { h, ids, backup } = setup(BKK('2026-06-15', '01:20'));
  assert.equal(h.call(ids.affairs, 'backup.run', {}).error.code, 'FORBIDDEN', 'backup.manage is admin-only');
  h.tick(['ops.schedule']);
  assert.equal(h.store.list('BackupRuns', { limit: 10 }).items.length, 0, 'before nightly time');
  h.clock.set(BKK('2026-06-15', '01:31'));
  h.tick(['ops.schedule']);
  h.tick(['ops.schedule']);
  h.runJobs();
  let runs = h.store.list('BackupRuns', { limit: 10 }).items;
  assert.equal(runs.length, 1, 'one nightly backup per day');
  assert.deepEqual([runs[0].backup_type, runs[0].status, runs[0].manifest_sha256.length], ['NIGHTLY_SNAPSHOT', 'SUCCEEDED', 64]);
  assert.equal(backup.calls[0].date, '2026-06-15');
  assert.equal(backup.calls[0].retentionDays, 30);
  assert.ok(Array.isArray(backup.calls[0].attachments));
  const manual = h.ok(ids.admin, 'backup.run', {});
  h.runJobs();
  runs = h.ok(ids.admin, 'backup.list', {}).items;
  assert.equal(runs.length, 2);
  assert.equal(h.store.get('BackupRuns', manual.backup_run_id).status, 'SUCCEEDED');
  h.ok(ids.admin, 'backup.recordRestoreTest', { backup_run_id: manual.backup_run_id, result: 'PASS', minutes: 42, note: 'กู้คืนไปโปรเจกต์ STAGING ใหม่ จำนวนแถวตรงกัน' });
  const b = h.store.get('BackupRuns', manual.backup_run_id);
  assert.match(b.restore_result, /^PASS · 42 นาที/);
  assert.ok(h.ok(ids.affairs, 'backup.list', {}).restore_tested, 'student affairs can view (system.health)');
  assert.equal(h.ok(ids.affairs, 'report.preview', { code: 'R12', filter: {} }).rows.length, 2, 'R12 lists backup runs');
});

test('a backup failure is recorded, not silent', () => {
  const { h, ids, backup } = setup();
  backup.snapshot = () => { throw new Error('Drive quota exceeded'); };
  const r = h.ok(ids.admin, 'backup.run', {});
  h.runJobs();
  const b = h.store.get('BackupRuns', r.backup_run_id);
  assert.equal(b.status, 'FAILED');
  assert.match(b.restore_result, /Drive quota exceeded/);
});

test('retention: only operational logs of terms that ended long enough ago can be purged, with audit', () => {
  const { h, ids } = setup(BKK('2026-06-15', '10:00'));
  h.ok(ids.affairs, 'class.list', {});
  h.ok(ids.affairs, 'student.create', { student_code: '99001', first_name_th: 'ทดสอบ', last_name_th: 'ระบบ', class_id: h.store.list('Classes', { limit: 1 }).items[0].id, effective_from: '2026-06-15' });
  const before = h.store.list('IdempotencyRecords', { partitions: ['AY2026-T1'], limit: 1000 }).items.length;
  assert.ok(before >= 1);
  // during the term: not eligible
  let p = h.ok(ids.admin, 'retention.preview', {});
  const item = p.items.find((x) => x.table === 'IdempotencyRecords' && x.partition === 'AY2026-T1');
  assert.equal(item.eligible, false);
  assert.equal(h.call(ids.admin, 'retention.purge', { table: 'IdempotencyRecords', partition: 'AY2026-T1', reason: 'ทดสอบนโยบาย' }).error.code, 'INVALID_STATE');
  assert.ok(p.not_automated_th.length >= 1, 'personal data is never purged automatically');
  // > 30 days after the term ended (2026-10-16)
  h.clock.set(BKK('2026-12-01', '10:00'));
  p = h.ok(ids.admin, 'retention.preview', {});
  assert.equal(p.items.find((x) => x.table === 'IdempotencyRecords' && x.partition === 'AY2026-T1').eligible, true);
  assert.equal(p.items.find((x) => x.table === 'OperationMetrics' && x.partition === 'AY2026-T1')?.eligible ?? false, false, 'metrics kept 1 year');
  assert.equal(h.call(ids.affairs, 'retention.purge', { table: 'IdempotencyRecords', partition: 'AY2026-T1', reason: 'ครบระยะเก็บ' }).error.code, 'FORBIDDEN');
  assert.equal(h.call(ids.admin, 'retention.purge', { table: 'Students', partition: 'AY2026-T1', reason: 'ไม่ควรได้' }).error.code, 'VALIDATION_ERROR');
  const res = h.ok(ids.admin, 'retention.purge', { table: 'IdempotencyRecords', partition: 'AY2026-T1', reason: 'ครบระยะเก็บตามนโยบาย' });
  assert.ok(res.removed >= before, `removed ${res.removed} rows (at least the ${before} counted earlier)`);
  assert.equal(h.store.list('IdempotencyRecords', { partitions: ['AY2026-T1'], limit: 1000 }).items.length, 0);
  assert.equal(h.store.list('AuditEvents', { where: { action: 'retention.purge' }, limit: 5 }).items.length, 1);
  assert.ok(h.store.list('Students', { limit: 100 }).items.length >= 11, 'student data untouched');
});

test('retention: finished jobs older than 90 days are purged on request; running/queued jobs are kept', () => {
  const { h, ids } = setup(BKK('2026-06-15', '10:00'));
  const r = h.ok(ids.admin, 'backup.run', {});
  h.runJobs();
  assert.ok(h.store.get('Jobs', h.store.get('BackupRuns', r.backup_run_id).job_id).status === 'SUCCEEDED');
  h.clock.set(BKK('2026-10-01', '10:00'));
  h.ok(ids.affairs, 'report.run', { code: 'R01', filter: { date: '2026-06-15' }, format: 'CSV' }); // queued, must stay
  const p = h.ok(ids.admin, 'retention.preview', {});
  assert.ok(p.jobs.eligible_rows >= 1);
  const res = h.ok(ids.admin, 'retention.purgeJobs', { reason: 'ครบ 90 วันตามนโยบาย' });
  assert.ok(res.removed >= 1);
  assert.ok(h.store.list('Jobs', { where: { status: 'QUEUED' }, limit: 10 }).items.length >= 1, 'queued job kept');
  assert.equal(h.store.list('Jobs', { where: { status: 'SUCCEEDED' }, limit: 10 }).items.length, 0);
});

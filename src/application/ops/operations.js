// Operations (MASTER_PROMPT §10.3, §14): backups + restore-test records, request metrics flushed to
// OperationMetrics, retention of operational logs by expired term partition (plus finished Jobs), a
// read-only view of the school's attachment retention setting (nothing deletes attachments
// automatically), and the operations tick. Everything here is audited.
import { listAll } from '../queries.js';
import { op } from '../dispatcher.js';
import { obj, S, notFound, EMPTY } from './common.js';
import { requirePermission } from '../authz.js';
import { commit, createContext, setting, partitionsForDates } from '../context.js';
import { systemPrincipal } from '../principal.js';
import { enqueueJob } from '../jobs.js';
import { AppError } from '../../shared/errors.js';
import { addDays, localPartsOf, hhmmToMinutes, addMinutesIso, diffDays } from '../../shared/time.js';
import { SYSTEM_USER_ID } from '../../shared/uuid.js';
import { getTable } from '../../schema/index.js';

/** Operational logs that may be purged by whole expired TERM partition (days after the term ends). */
export const OPERATIONAL_RETENTION = Object.freeze({
  IdempotencyRecords: 30, MutationJournal: 30, WebhookInbox: 90, OperationMetrics: 365, NotificationAttempts: 365,
});

function* sysCtx(deps, operation) {
  const ctx = yield* createContext(deps, { operation, channel: 'JOB' });
  ctx.principal = systemPrincipal(SYSTEM_USER_ID);
  return ctx;
}

function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null; }

/** Drain closed metric buckets into OperationMetrics (one row per bucket × operation). */
export function* flushMetrics(deps) {
  if (!deps.metrics || !deps.metrics.drain) return { buckets: 0, rows: 0 };
  const ctx = yield* sysCtx(deps, 'metrics.flush');
  const current = Math.floor(Date.parse(ctx.now) / 300000) * 300000;
  const buckets = deps.metrics.drain(current);
  if (!buckets.length) return { buckets: 0, rows: 0 };
  const cs = ctx.changeSet('metrics.flush');
  let rows = 0;
  for (const b of buckets) {
    const byOp = new Map();
    for (const [opName, ms, ok, lock] of b.samples || []) {
      if (!byOp.has(opName)) byOp.set(opName, { ms: [], errors: 0, lock: [] });
      const a = byOp.get(opName);
      a.ms.push(Number(ms) || 0);
      if (!ok) a.errors++;
      a.lock.push(Number(lock) || 0);
    }
    for (const [opName, a] of byOp) {
      const ms = a.ms.sort((x, y) => x - y);
      const lk = a.lock.sort((x, y) => x - y);
      cs.insert('OperationMetrics', { bucket_start: new Date(b.bucket_start_ms).toISOString(), operation: String(opName).slice(0, 100), count: ms.length, error_count: a.errors, p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), max_ms: ms[ms.length - 1], lock_wait_p95_ms: pct(lk, 0.95) });
      rows++;
    }
  }
  cs.maintenanceAllowed = true; // operational metrics keep flowing while the system is frozen (READ_ONLY)
  if (rows) yield ctx.mutations.commit(cs.build({ result: {} }));
  return { buckets: buckets.length, rows };
}

/** Job: snapshot through the platform backup port and record the result in BackupRuns. */
export function* backupSnapshotJob(ctx, job) {
  const backup = ctx.platform.backup;
  let run = yield ctx.store.get('BackupRuns', job.payload_json.run_id);
  if (!run) return { done: true, result: { skipped: 'no run' } };
  if (!backup) {
    const cs = ctx.changeSet('backup.fail');
    cs.update('BackupRuns', run, { status: 'FAILED', finished_at: ctx.now, restore_result: 'ไม่มีบริการสำรองข้อมูลในสภาพแวดล้อมนี้' });
    yield ctx.mutations.commit(cs.build({ result: {} }));
    return { done: true, result: { failed: 'NO_BACKUP_PORT' } };
  }
  const attachments = (yield* listAll(ctx, 'Attachments')).filter((a) => a.status !== 'DELETED').map((a) => ({ id: a.id, sha256: a.sha256, size_bytes: a.size_bytes, classification: a.classification }));
  const retentionDays = Number(yield* setting(ctx, 'backup.retention_days', 30));
  let res;
  try {
    res = backup.snapshot({ runId: run.id, date: ctx.today, retentionDays, attachments });
    if (res && typeof res.then === 'function') res = yield res;
  } catch (e) {
    run = yield ctx.store.get('BackupRuns', run.id);
    const cs = ctx.changeSet('backup.fail');
    cs.update('BackupRuns', run, { status: 'FAILED', finished_at: ctx.now, restore_result: `สำรองไม่สำเร็จ: ${String(e && e.message ? e.message : e).slice(0, 200)}` });
    cs.audit({ action: 'backup.failed', entityType: 'BackupRuns', entityId: run.id });
    yield ctx.mutations.commit(cs.build({ result: {} }));
    return { done: true, result: { failed: true } };
  }
  run = yield ctx.store.get('BackupRuns', run.id);
  const cs = ctx.changeSet('backup.done');
  cs.update('BackupRuns', run, { status: 'SUCCEEDED', finished_at: ctx.now, package_location: res.package_location, manifest_sha256: res.manifest_sha256, row_counts_json: res.row_counts, retention_until: addDays(ctx.today, retentionDays) });
  cs.audit({ action: 'backup.succeeded', entityType: 'BackupRuns', entityId: run.id, after: { files: res.files.length, pruned: res.pruned } });
  yield ctx.mutations.commit(cs.build({ result: {} }));
  return { done: true, result: { files: res.files.length, pruned: res.pruned } };
}

function* startBackup(ctx, cs, type) {
  const run = cs.insert('BackupRuns', { backup_type: type, status: 'RUNNING', started_at: ctx.now });
  const job = enqueueJob(cs, ctx, { job_type: 'backup.snapshot', payload: { run_id: run.id }, priority: 9, max_attempts: 1, dedupe_key: `backup|${run.id}` });
  cs.update('BackupRuns', run, { job_id: job.id });
  return { run, job };
}

/** Operational partitions eligible for purge: the term ended more than `days` ago. */
function* retentionCandidates(ctx) {
  const out = [];
  for (const [table, days] of Object.entries(OPERATIONAL_RETENTION)) {
    const parts = ctx.store.partitions ? yield ctx.store.partitions(table) : [];
    for (const p of parts) {
      if (p === '*' || p === 'UNPARTITIONED') continue;
      const term = ctx.terms.find((t) => t.code === p);
      if (!term) continue;
      const age = diffDays(term.end_date, ctx.today);
      const rows = ctx.store.count ? yield ctx.store.count(table, p) : (yield* listAll(ctx, table, { partitions: [p] })).length;
      out.push({ table, partition: p, term_end: term.end_date, keep_days: days, eligible: age > days, rows });
    }
  }
  return out;
}

export const operationsOps = [
  op({
    name: 'backup.list', description_th: 'ประวัติการสำรองข้อมูลและผลทดสอบ restore', permission: 'backup.manage | system.health',
    input: obj({ limit: S.limit }),
    *handler(ctx, input) {
      try { yield* requirePermission(ctx, 'backup.manage'); } catch (e) { if (e.code !== 'FORBIDDEN') throw e; yield* requirePermission(ctx, 'system.health'); }
      const items = (yield* listAll(ctx, 'BackupRuns')).sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, input.limit || 30);
      const ok = items.filter((b) => b.status === 'SUCCEEDED');
      return { items, last_success_at: ok.length ? ok[0].finished_at : null, restore_tested: items.some((b) => !!b.restore_tested_at) };
    },
  }),

  op({
    name: 'backup.run', mutation: true, description_th: 'สั่งสำรองข้อมูลทันที (งานเบื้องหลัง)', permission: 'backup.manage', maintenanceAllowed: true,
    input: EMPTY,
    *handler(ctx) {
      yield* requirePermission(ctx, 'backup.manage');
      const running = (yield ctx.store.list('BackupRuns', { where: { status: 'RUNNING' }, limit: 5 })).items.filter((b) => b.started_at > addMinutesIso(ctx.now, -30));
      if (running.length) throw new AppError('INVALID_STATE', 'running', { messageTh: 'มีการสำรองข้อมูลกำลังทำงานอยู่' });
      const cs = ctx.changeSet();
      cs.maintenanceAllowed = true;
      const { run, job } = yield* startBackup(ctx, cs, 'MANUAL');
      cs.audit({ action: 'backup.requested', entityType: 'BackupRuns', entityId: run.id });
      return yield* commit(ctx, cs, { backup_run_id: run.id, job_id: job.id });
    },
  }),

  op({
    name: 'backup.recordRestoreTest', mutation: true, description_th: 'บันทึกผลทดสอบ restore ไป environment ใหม่ (ผล + เวลาที่ใช้จริง)', permission: 'backup.manage',
    input: obj({ backup_run_id: S.uuid, result: { type: 'string', enum: ['PASS', 'FAIL'] }, minutes: { type: 'integer', minimum: 0, maximum: 10000 }, note: S.str(1000, 3) }, ['backup_run_id', 'result', 'minutes', 'note']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'backup.manage');
      const b = yield ctx.store.get('BackupRuns', input.backup_run_id);
      if (!b) throw notFound('backup');
      if (b.status !== 'SUCCEEDED') throw new AppError('INVALID_STATE', 'not a successful backup');
      const cs = ctx.changeSet();
      cs.update('BackupRuns', b, { restore_tested_at: ctx.now, restore_result: `${input.result} · ${input.minutes} นาที · ${input.note}`.slice(0, 500) });
      cs.audit({ action: 'backup.restore_tested', entityType: 'BackupRuns', entityId: b.id, reason: input.note, after: { result: input.result, minutes: input.minutes } });
      return yield* commit(ctx, cs, { backup_run_id: b.id });
    },
  }),

  op({
    name: 'system.metrics', description_th: 'เวลาตอบสนอง p50/p95 อัตราผิดพลาด และ lock wait ตาม operation (ช่วงล่าสุด)', permission: 'system.health',
    input: obj({ hours: { type: ['integer', 'null'], minimum: 1, maximum: 168 } }),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'system.health');
      const since = addMinutesIso(ctx.now, -60 * (input.hours || 24));
      const rows = (yield* listAll(ctx, 'OperationMetrics', { where: { bucket_start: { gte: since } }, partitions: partitionsForDates(ctx, [since.slice(0, 10), ctx.today]) }));
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.operation)) by.set(r.operation, { operation: r.operation, count: 0, errors: 0, p95_max: 0, p50_weighted: 0, lock_p95_max: 0, buckets: 0 });
        const a = by.get(r.operation);
        a.count += r.count; a.errors += r.error_count; a.buckets++;
        a.p95_max = Math.max(a.p95_max, r.p95_ms || 0); a.lock_p95_max = Math.max(a.lock_p95_max, r.lock_wait_p95_ms || 0);
        a.p50_weighted += (r.p50_ms || 0) * r.count;
      }
      const items = [...by.values()].map((a) => ({ operation: a.operation, count: a.count, error_rate: a.count ? Math.round((a.errors * 1000) / a.count) / 10 : 0, p50_ms: a.count ? Math.round(a.p50_weighted / a.count) : null, p95_ms_worst_bucket: a.p95_max, lock_wait_p95_ms_worst_bucket: a.lock_p95_max }))
        .sort((x, y) => y.count - x.count);
      return { since, items, note_th: 'p50 ถ่วงน้ำหนักตามจำนวนคำขอ; p95 แสดงค่าสูงสุดของช่วง 5 นาที (ไม่ใช่ p95 ของทั้งช่วง)' };
    },
  }),

  op({
    name: 'retention.preview', description_th: 'ตารางบันทึกระบบที่ครบระยะเก็บแล้ว (ต่อภาคเรียน) และนโยบายไฟล์แนบ', permission: 'system.maintenance',
    input: EMPTY,
    *handler(ctx) {
      yield* requirePermission(ctx, 'system.maintenance');
      const items = yield* retentionCandidates(ctx);
      const attachmentPolicy = yield* setting(ctx, 'retention.attachment_days', null);
      const jobCutoff = addMinutesIso(ctx.now, -JOBS_KEEP_DAYS * 24 * 60);
      const oldJobs = (yield* listAll(ctx, 'Jobs', { where: { status: { in: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } } })).filter((j) => (j.finished_at || j.updated_at) < jobCutoff).length;
      return {
        items, attachment_policy: attachmentPolicy, jobs: { keep_days: JOBS_KEEP_DAYS, eligible_rows: oldJobs },
        not_automated_th: ['ข้อมูลนักเรียน การมาเรียน ใบลา เรื่องติดตาม และ Audit ไม่ถูกลบอัตโนมัติ — ต้องมีนโยบายและการอนุมัติของโรงเรียน (docs/OPERATIONS_TH.md)', 'ข้อมูลที่ลบแล้วยังอยู่ในสำเนาสำรองจนกว่าสำเนานั้นหมดอายุ'],
      };
    },
  }),

  op({
    name: 'retention.purge', mutation: true, maintenanceAllowed: true, description_th: 'ล้างบันทึกระบบของภาคเรียนที่ครบระยะเก็บ (เฉพาะตารางปฏิบัติการ)', permission: 'system.maintenance',
    input: obj({ table: { type: 'string', enum: Object.keys(OPERATIONAL_RETENTION) }, partition: { type: 'string', pattern: '^AY[0-9]{4}-T[0-9]$' }, reason: S.str(500, 5) }, ['table', 'partition', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'system.maintenance');
      if (getTable(input.table).partition !== 'TERM') throw new AppError('VALIDATION_ERROR', 'not partitioned');
      const c = (yield* retentionCandidates(ctx)).find((x) => x.table === input.table && x.partition === input.partition);
      if (!c) throw notFound('partition');
      if (!c.eligible) throw new AppError('INVALID_STATE', 'not eligible', { messageTh: `ยังไม่ครบระยะเก็บ (${c.keep_days} วันหลังจบภาคเรียน ${c.term_end})` });
      if (!ctx.store.purgePartition) throw new AppError('CONFIGURATION_REQUIRED', 'store cannot purge');
      // audit first (separate commit) so the intent is recorded even if the purge is interrupted
      const cs = ctx.changeSet();
      cs.maintenanceAllowed = true;
      cs.audit({ action: 'retention.purge', entityType: input.table, reason: input.reason, after: { partition: input.partition, rows: c.rows, keep_days: c.keep_days } });
      yield* commit(ctx, cs, {});
      const removed = yield ctx.store.purgePartition(input.table, input.partition);
      return { table: input.table, partition: input.partition, removed };
    },
  }),
];

export const JOBS_KEEP_DAYS = 90;

operationsOps.push(op({
  name: 'retention.purgeJobs', mutation: true, maintenanceAllowed: true, description_th: 'ลบงานเบื้องหลังที่จบแล้วเกิน 90 วัน', permission: 'system.maintenance',
  input: obj({ reason: S.str(500, 5) }, ['reason']),
  *handler(ctx, input) {
    yield* requirePermission(ctx, 'system.maintenance');
    if (!ctx.store.purgeWhere) throw new AppError('CONFIGURATION_REQUIRED', 'store cannot purge');
    const cutoff = addMinutesIso(ctx.now, -JOBS_KEEP_DAYS * 24 * 60);
    const cs = ctx.changeSet();
    cs.maintenanceAllowed = true;
    cs.audit({ action: 'retention.purge_jobs', entityType: 'Jobs', reason: input.reason, after: { older_than: cutoff } });
    yield* commit(ctx, cs, {});
    const removed = yield ctx.store.purgeWhere('Jobs', { status: { in: ['SUCCEEDED', 'FAILED', 'CANCELLED'] }, finished_at: { lt: cutoff } });
    return { removed };
  },
}));

/** Nightly backup (setting backup.nightly_time) + metrics flush every tick. */
export const OPS_TICK = {
  name: 'ops.schedule',
  readOnlySafe: true, // metrics + nightly backup are maintenance writes, allowed while frozen
  *run(deps) {
    const out = { metrics: yield* flushMetrics(deps) };
    const ctx = yield* sysCtx(deps, 'tick.ops');
    if (deps.platform && deps.platform.backup) {
      const at = hhmmToMinutes(String(yield* setting(ctx, 'backup.nightly_time', '01:30')));
      const p = localPartsOf(ctx.now, ctx.tz);
      if (p.hh * 60 + p.mm >= at) {
        const existing = yield ctx.store.findBy('Jobs', 'dedupe_key', `nightlyBackup|${ctx.today}`);
        if (!existing.length) {
          const cs = ctx.changeSet('backup.nightly');
          cs.maintenanceAllowed = true;
          const run = cs.insert('BackupRuns', { backup_type: 'NIGHTLY_SNAPSHOT', status: 'RUNNING', started_at: ctx.now });
          const job = enqueueJob(cs, ctx, { job_type: 'backup.snapshot', payload: { run_id: run.id }, priority: 9, max_attempts: 1, dedupe_key: `nightlyBackup|${ctx.today}`, owner_user_id: SYSTEM_USER_ID });
          cs.update('BackupRuns', run, { job_id: job.id });
          yield ctx.mutations.commit(cs.build({ result: {} }));
          out.backup = true;
        }
      }
    }
    return out;
  },
};

export const OPS_JOB_HANDLERS = { 'backup.snapshot': Object.assign(backupSnapshotJob, { maintenanceAllowed: true }) };

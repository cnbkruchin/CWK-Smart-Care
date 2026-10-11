// System health (no secrets), maintenance mode, job status.
import { cutoverActive } from './migration.js';
import { listAll } from '../queries.js';
import { op } from '../dispatcher.js';
import { obj, S, EMPTY, notFound } from './common.js';
import { requirePermission, allows } from '../authz.js';
import { commit, loadRules, partitionsForDates } from '../context.js';
import { AppError } from '../../shared/errors.js';
import { selectRule } from '../../domain/rules.js';

const REQUIRED_RULES = ['SCHOOL_LATENESS', 'LEAVE_ROUTING', 'FOLLOWUP_LATE_COUNT', 'ABSENCE_VERIFICATION', 'NOTIFICATION_POLICY'];

/** Data-level readiness checks shared by GAS and REST backends. Status: OK | WARN | FAIL | REQUIRED_SETUP */
export function* dataChecks(ctx) {
  const checks = [];
  const add = (key, status, detail_th) => checks.push({ key, status, detail_th });
  const schools = yield ctx.store.list('Schools', { limit: 2 });
  add('school.configured', schools.items.length === 1 ? 'OK' : 'REQUIRED_SETUP', schools.items.length ? 'ตั้งค่าโรงเรียนแล้ว' : 'ยังไม่มีข้อมูลโรงเรียน');
  const termToday = ctx.terms.find((t) => ctx.today >= t.start_date && ctx.today < t.end_date);
  add('term.current', termToday ? 'OK' : 'WARN', termToday ? `ภาคเรียนปัจจุบัน ${termToday.code}` : 'วันนี้ไม่อยู่ในภาคเรียนใด (ตรวจปฏิทิน/ปิดภาคเรียน)');
  const rules = yield* loadRules(ctx);
  for (const rt of REQUIRED_RULES) {
    const r = selectRule(rules, rt, ctx.today);
    if (!r) add(`rule.${rt}`, 'REQUIRED_SETUP', `ยังไม่มีกฎ ${rt} ที่มีผลวันนี้`);
    else if (r.is_example) add(`rule.${rt}`, ctx.config.env === 'PROD' ? 'FAIL' : 'WARN', `กฎ ${rt} v${r.version_no} เป็นค่าตัวอย่าง — ต้องให้โรงเรียนยืนยันก่อน production`);
    else add(`rule.${rt}`, 'OK', `กฎ ${rt} v${r.version_no} (โรงเรียนยืนยันแล้ว)`);
  }
  const admins = yield ctx.store.findBy('UserRoles', 'role', 'SYSTEM_ADMIN');
  add('admin.present', admins.some((r) => !r.revoked_at) ? 'OK' : 'REQUIRED_SETUP', 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
  const failedJobs = (yield ctx.store.list('Jobs', { where: { status: 'FAILED' }, limit: 50 })).items.length;
  add('jobs.failed', failedJobs ? 'WARN' : 'OK', failedJobs ? `มีงานเบื้องหลังล้มเหลว ${failedJobs} รายการ` : 'ไม่มีงานล้มเหลว');
  // job heartbeat: RUNNING past its lease means the worker died; the next tick re-claims it
  const stuck = (yield ctx.store.list('Jobs', { where: { status: 'RUNNING' }, limit: 50 })).items.filter((j) => j.lease_until && j.lease_until < ctx.now).length;
  add('jobs.heartbeat', stuck ? 'WARN' : 'OK', stuck ? `งาน ${stuck} รายการหยุดส่งสัญญาณ (lease หมด) — จะถูกรันใหม่ในรอบถัดไป ตรวจ trigger cronTick` : 'งานที่กำลังรันส่งสัญญาณปกติ');
  // backups: last success within 2 days, and at least one restore drill recorded
  const backups = yield* listAll(ctx, 'BackupRuns');
  const lastOk = backups.filter((b) => b.status === 'SUCCEEDED').sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1))[0];
  const twoDaysAgo = new Date(Date.parse(ctx.now) - 2 * 86400000).toISOString();
  add('backup.recent', lastOk && lastOk.finished_at > twoDaysAgo ? 'OK' : 'WARN', lastOk ? `สำรองสำเร็จล่าสุด ${lastOk.finished_at}` : 'ยังไม่มีการสำรองข้อมูลที่สำเร็จ');
  add('backup.restore_tested', backups.some((b) => b.restore_tested_at) ? 'OK' : (ctx.config.env === 'PROD' ? 'FAIL' : 'WARN'), backups.some((b) => b.restore_tested_at) ? 'มีการทดสอบ restore แล้ว' : 'ยังไม่เคยทดสอบ restore ไป environment ใหม่ (ต้องทำก่อนใช้งานจริง)');
  // outbox queue age (recent partitions only)
  const recent = partitionsForDates(ctx, [new Date(Date.parse(ctx.now) - 60 * 86400000).toISOString().slice(0, 10), ctx.today]);
  const queued = (yield* listAll(ctx, 'NotificationOutbox', { where: { delivery_state: { in: ['QUEUED', 'RETRY_WAIT'] } }, partitions: recent }));
  const oldest = queued.reduce((m, o) => (!m || o.created_at < m ? o.created_at : m), null);
  const ageMin = oldest ? Math.round((Date.parse(ctx.now) - Date.parse(oldest)) / 60000) : 0;
  add('outbox.queue_age', ageMin > 60 ? 'WARN' : 'OK', queued.length ? `ค้างส่ง ${queued.length} รายการ เก่าสุด ${ageMin} นาที (รวมที่รอพ้นช่วงงดส่ง)` : 'ไม่มีรายการค้างส่ง');
  return checks;
}

export const systemOps = [
  op({
    name: 'system.health', description_th: 'สถานะระบบ (ไม่เปิดเผยความลับ)', permission: 'system.health', input: EMPTY, rateLimitPerMinute: 30,
    *handler(ctx) {
      yield* requirePermission(ctx, 'system.health');
      const checks = [];
      if (ctx.config.healthChecks) checks.push(...ctx.config.healthChecks());
      checks.push(...(yield* dataChecks(ctx)));
      let platform = null;
      if (ctx.platform.health) platform = yield ctx.platform.health({ deep: false });
      if (platform && platform.checks) checks.push(...platform.checks);
      const worst = ['FAIL', 'REQUIRED_SETUP', 'WARN', 'OK'].find((s) => checks.some((c) => c.status === s)) || 'OK';
      return { status: worst, env: ctx.config.env, system_mode: ctx.config.systemMode, server_time: ctx.now, school_date: ctx.today, checks, platform: platform ? platform.info || null : null };
    },
  }),

  op({
    name: 'system.setMode', mutation: true, maintenanceAllowed: true, description_th: 'เปิด/ปิดโหมดอ่านอย่างเดียว (server บังคับทุกช่องทาง)', permission: 'system.maintenance',
    input: obj({ mode: { type: 'string', enum: ['NORMAL', 'READ_ONLY'] }, reason: S.str(500) }, ['mode', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'system.maintenance');
      if (!ctx.platform.setSystemMode) throw new AppError('FEATURE_DISABLED', 'mode switch not supported by this backend');
      if (input.mode === 'NORMAL' && (yield* cutoverActive(ctx))) {
        throw new AppError('INVALID_STATE', 'cutover active', { messageTh: 'ระบบนี้ถูกสลับไประบบใหม่แล้ว (archive อ่านอย่างเดียว) — เปิดเขียนได้หลังบันทึกการย้อนกลับ (rollback) ในศูนย์ย้ายข้อมูลเท่านั้น' });
      }
      const before = ctx.config.systemMode;
      const cs = ctx.changeSet();
      cs.maintenanceAllowed = true;
      cs.audit({ action: 'system.set_mode', entityType: null, reason: input.reason, before: { mode: before }, after: { mode: input.mode } });
      const res = yield* commit(ctx, cs, { mode: input.mode, previous: before });
      yield ctx.platform.setSystemMode(input.mode);
      return res;
    },
  }),

  op({
    name: 'job.getStatus', description_th: 'สถานะงานเบื้องหลัง (เจ้าของงาน หรือผู้ดูแลระบบ)', input: obj({ job_id: S.uuid }, ['job_id']),
    *handler(ctx, input) {
      const j = yield ctx.store.get('Jobs', input.job_id);
      if (!j) throw notFound('job');
      const own = yield* allows(ctx, 'job.read', { owner_user_id: j.owner_user_id });
      if (!own) yield* requirePermission(ctx, 'system.health');
      return { id: j.id, job_type: j.job_type, status: j.status, progress: j.progress_json, attempts: j.attempts, last_error: j.last_error, started_at: j.started_at, finished_at: j.finished_at, result: j.result_json, next_run_at: j.next_run_at };
    },
  }),

  op({
    name: 'job.list', description_th: 'รายการงานเบื้องหลัง (ผู้ดูแลระบบ)', permission: 'system.health',
    input: obj({ status: S.enumOrNull('JobStatus'), cursor: S.cursor, limit: S.limit }),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'system.health');
      const page = yield ctx.store.list('Jobs', { where: input.status ? { status: input.status } : {}, orderBy: [['created_at', 'desc']], cursor: input.cursor, limit: input.limit || 50 });
      return { items: page.items.map((j) => ({ id: j.id, job_type: j.job_type, status: j.status, attempts: j.attempts, progress: j.progress_json, last_error: j.last_error, next_run_at: j.next_run_at, heartbeat_at: j.heartbeat_at, created_at: j.created_at })), next_cursor: page.next_cursor };
    },
  }),

  op({
    name: 'job.retry', mutation: true, description_th: 'สั่งรันงานที่ล้มเหลวอีกครั้ง', permission: 'system.maintenance',
    input: obj({ job_id: S.uuid, reason: S.str(300) }, ['job_id', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'system.maintenance');
      const j = yield ctx.store.get('Jobs', input.job_id);
      if (!j) throw notFound('job');
      if (j.status !== 'FAILED' && j.status !== 'PAUSED') throw new AppError('INVALID_STATE', 'job not failed/paused');
      const cs = ctx.changeSet();
      cs.update('Jobs', j, { status: 'QUEUED', next_run_at: ctx.now, attempts: 0, last_error: null, lease_until: null, lease_owner: null });
      cs.audit({ action: 'job.retry', entityType: 'Jobs', entityId: j.id, reason: input.reason });
      return yield* commit(ctx, cs, { job_id: j.id });
    },
  }),
];

// System health (no secrets), maintenance mode, job status.
import { op } from '../dispatcher.js';
import { obj, S, EMPTY, notFound } from './common.js';
import { requirePermission, allows } from '../authz.js';
import { commit, loadRules } from '../context.js';
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

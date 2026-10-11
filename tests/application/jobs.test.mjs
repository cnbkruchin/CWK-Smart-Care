// Durable jobs and quota failures (MASTER_PROMPT §18 "Quota/jobs", §10.3): a job cut off mid-way resumes from
// its checkpoint, a dead worker's expired lease is recovered while a live lease is never stolen, quota errors
// back off and retry without claiming success, fatal errors stop at once, and a quota failure during a user
// request is reported as an error with nothing written (the UI never shows a false success).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/app-harness.mjs';
import { runSync } from '../../src/application/runtime.js';
import { runDueJobs, enqueueJob, JOB_LEASE_SECONDS } from '../../src/application/jobs.js';
import { createContext, commit } from '../../src/application/context.js';
import { systemPrincipal } from '../../src/application/principal.js';
import { AppError } from '../../src/shared/errors.js';
import { SYSTEM_USER_ID } from '../../src/shared/uuid.js';
import { addSecondsIso } from '../../src/shared/time.js';

const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();

function withCtx(h, fn) {
  return runSync(function* () {
    const ctx = yield* createContext(h.deps, { operation: 'test', channel: 'JOB' });
    ctx.principal = systemPrincipal(SYSTEM_USER_ID);
    return yield* fn(ctx);
  });
}
const enqueue = (h, job_type, max_attempts = 5) => withCtx(h, function* (ctx) {
  const cs = ctx.changeSet('test.enqueue');
  const job = enqueueJob(cs, ctx, { job_type, payload: {}, max_attempts, owner_user_id: SYSTEM_USER_ID });
  yield* commit(ctx, cs, {});
  return job.id;
});
const run = (h, handlers, owner = 'worker-b') => runSync(runDueJobs, h.deps, handlers, { deadlineAt: Date.now() + 60000, owner });

const handlers = {
  // three chunks; each run does one chunk and checkpoints (like a job cut off by the execution time limit)
  *'test.steps'(ctx, job, { checkpoint }) {
    const n = ((job.cursor_json && job.cursor_json.n) || 0) + 1;
    yield* checkpoint({ n }, { chunks_done: n });
    return n < 3 ? { done: false } : { done: true, result: { chunks: n } };
  },
  *'test.quota'(ctx, job) {
    if (job.attempts < 3) throw new AppError('QUOTA_EXCEEDED', 'Service invoked too many times');
    return { done: true, result: { ok: true } };
  },
  *'test.fatal'() { throw new AppError('VALIDATION_ERROR', 'bad payload'); },
};

test('jobs: resume from checkpoint; an expired lease of a dead worker is recovered, a live one is not stolen', () => {
  const h = makeHarness({ now: BKK('2026-06-15', '08:00') });
  h.bootstrap();
  const id = enqueue(h, 'test.steps');
  // worker A claimed the job, saved chunk 1, then its execution was killed (lease still running)
  withCtx(h, function* (ctx) {
    const j = yield ctx.store.get('Jobs', id);
    const cs = ctx.changeSet('test.crash');
    cs.update('Jobs', j, { status: 'RUNNING', lease_owner: 'worker-a', lease_until: addSecondsIso(ctx.now, JOB_LEASE_SECONDS), attempts: 1, cursor_json: { n: 1 }, progress_json: { chunks_done: 1 }, started_at: ctx.now });
    yield* commit(ctx, cs, {});
  });
  let r = run(h, handlers);
  assert.equal(r.skipped, 1, 'live lease is respected');
  assert.equal(h.store.get('Jobs', id).lease_owner, 'worker-a');
  h.clock.advance((JOB_LEASE_SECONDS + 1) * 1000);
  r = run(h, handlers);
  assert.equal(r.claimed, 1, 'expired lease recovered');
  assert.equal(h.store.get('Jobs', id).cursor_json.n, 2, 'continues after the saved chunk (no chunk redone or skipped)');
  run(h, handlers);
  const done = h.store.get('Jobs', id);
  assert.equal(done.status, 'SUCCEEDED');
  assert.deepEqual(done.result_json, { chunks: 3 });
  assert.ok(done.attempts <= 2, 'voluntary yields do not consume attempts');
});

test('jobs: quota errors back off and retry, never marked done early; fatal errors fail at once with the reason', () => {
  const h = makeHarness({ now: BKK('2026-06-15', '08:00') });
  h.bootstrap();
  const q = enqueue(h, 'test.quota');
  const f = enqueue(h, 'test.fatal');
  run(h, handlers);
  let jq = h.store.get('Jobs', q);
  assert.equal(jq.status, 'QUEUED');
  assert.match(jq.last_error, /QUOTA_EXCEEDED/);
  assert.ok(jq.next_run_at > h.clock.now(), 'backs off');
  const jf = h.store.get('Jobs', f);
  assert.equal(jf.status, 'FAILED');
  assert.match(jf.last_error, /VALIDATION_ERROR: bad payload/);
  assert.equal(run(h, handlers).claimed, 0, 'not retried before the backoff time');
  for (let i = 0; i < 3 && h.store.get('Jobs', q).status !== 'SUCCEEDED'; i++) { h.clock.advance(61 * 60 * 1000); run(h, handlers); }
  jq = h.store.get('Jobs', q);
  assert.equal(jq.status, 'SUCCEEDED');
  assert.equal(jq.attempts, 3);
  // max attempts exhausted → FAILED, not retried forever
  const q2 = enqueue(h, 'test.quota', 2);
  for (let i = 0; i < 4; i++) { run(h, handlers); h.clock.advance(61 * 60 * 1000); }
  assert.equal(h.store.get('Jobs', q2).status, 'FAILED');
});

test('a quota failure inside a user request is an error envelope and nothing is written', () => {
  const h = makeHarness({ now: BKK('2026-06-15', '07:30') });
  h.bootstrap();
  const seed = h.seed();
  const g = seed.guardian_users[0];
  h.deps.platform.storage.put = () => { throw new AppError('QUOTA_EXCEEDED', 'Drive quota'); };
  const before = h.store.count('LeaveRequests');
  const res = h.call(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'SICK', reason: 'ป่วย', days: [{ school_date: '2026-06-16', unit: 'FULL_DAY' }], attachments: [{ filename: 'c.pdf', mime_type: 'application/pdf', content_base64: Buffer.from('%PDF-1.4\n').toString('base64') }] });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'QUOTA_EXCEEDED');
  assert.equal(res.error.retryable, true);
  assert.match(res.error.message_th, /โควตา/);
  assert.equal(h.store.count('LeaveRequests'), before, 'no leave request recorded');
});

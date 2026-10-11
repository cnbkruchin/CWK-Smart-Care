// Durable background jobs (MASTER_PROMPT §10.3): status, progress, cursor, attempts, lease,
// heartbeat, retry with backoff. Claimed through the MutationStore (version check under the
// adapter's lock/transaction), executed outside the lock, checkpointed after each chunk.

import { createContext } from './context.js';
import { systemPrincipal } from './principal.js';
import { addSecondsIso, addMinutesIso } from '../shared/time.js';
import { isAppError } from '../shared/errors.js';
import { SYSTEM_USER_ID } from '../shared/uuid.js';

export const JOB_LEASE_SECONDS = 330; // > max GAS execution (6 min) so a live worker never loses its lease

export function enqueueJob(cs, ctx, { job_type, payload = {}, dedupe_key = null, run_at = null, priority = 5, max_attempts = 5, owner_user_id = null }) {
  return cs.insert('Jobs', {
    job_type, status: 'QUEUED', priority, payload_json: payload, attempts: 0, max_attempts, next_run_at: run_at || ctx.now,
    owner_user_id: owner_user_id || (ctx.principal && ctx.principal.user_id) || SYSTEM_USER_ID, dedupe_key,
  });
}

/**
 * Run due jobs until the deadline. `handlers[job_type]` is a generator
 *   function*(ctx, job, { checkpoint(cursor, progress), timeLeftMs() }) → { done: boolean, result?: object, pause?: boolean }
 */
export function* runDueJobs(deps, handlers, { deadlineAt, owner = 'worker', limit = 5, now = null } = {}) {
  const report = { claimed: 0, succeeded: 0, yielded: 0, failed: 0, retried: 0, skipped: 0 };
  const base = yield* createContext(deps, { operation: 'jobs.run', channel: 'JOB' });
  base.principal = systemPrincipal(SYSTEM_USER_ID);
  const page = yield base.store.list('Jobs', {
    where: { status: { in: ['QUEUED', 'RUNNING'] }, next_run_at: { lte: now || base.now } },
    orderBy: [['priority', 'desc'], ['next_run_at', 'asc']], limit: 50,
  });
  for (const candidate of page.items) {
    if (report.claimed >= limit || Date.now() > deadlineAt - 20000) break;
    if (candidate.status === 'RUNNING' && candidate.lease_until && candidate.lease_until > base.now) { report.skipped++; continue; }
    const handler = handlers[candidate.job_type];
    // claim
    const claimCtx = yield* createContext(deps, { operation: 'jobs.claim', channel: 'JOB' });
    claimCtx.principal = systemPrincipal(SYSTEM_USER_ID);
    const cs = claimCtx.changeSet('jobs.claim');
    cs.maintenanceAllowed = !!(handler && handler.maintenanceAllowed);
    if (!handler) {
      cs.update('Jobs', candidate, { status: 'FAILED', last_error: `no handler for ${candidate.job_type}`, finished_at: claimCtx.now });
      try { yield claimCtx.mutations.commit(cs.build()); } catch (_) { /* ignore */ }
      report.failed++;
      continue;
    }
    let job;
    try {
      job = cs.update('Jobs', candidate, {
        status: 'RUNNING', lease_until: addSecondsIso(claimCtx.now, JOB_LEASE_SECONDS), lease_owner: owner, heartbeat_at: claimCtx.now,
        started_at: candidate.started_at || claimCtx.now, attempts: candidate.attempts + 1,
      });
      yield claimCtx.mutations.commit(cs.build());
    } catch (e) {
      if (isAppError(e) && (e.code === 'CONFLICT' || e.code === 'MAINTENANCE_MODE' || e.code === 'LOCK_TIMEOUT')) { report.skipped++; continue; }
      throw e;
    }
    report.claimed++;
    const jobCtx = yield* createContext(deps, { operation: `job.${candidate.job_type}`, channel: 'JOB' });
    jobCtx.principal = systemPrincipal(job.owner_user_id);
    jobCtx.job = job;
    let current = job;
    const checkpoint = function* (cursor, progress) {
      const c = yield* createContext(deps, { operation: 'jobs.checkpoint', channel: 'JOB' });
      c.principal = systemPrincipal(SYSTEM_USER_ID);
      const b = c.changeSet('jobs.checkpoint');
      b.maintenanceAllowed = !!handler.maintenanceAllowed;
      current = b.update('Jobs', current, { cursor_json: cursor, progress_json: progress || current.progress_json, heartbeat_at: c.now, lease_until: addSecondsIso(c.now, JOB_LEASE_SECONDS) });
      yield c.mutations.commit(b.build());
      return current;
    };
    const timeLeftMs = () => deadlineAt - Date.now();
    let outcome;
    let error = null;
    try {
      outcome = yield* handler(jobCtx, current, { checkpoint, timeLeftMs });
    } catch (e) {
      error = e;
    }
    const finCtx = yield* createContext(deps, { operation: 'jobs.finish', channel: 'JOB' });
    finCtx.principal = systemPrincipal(SYSTEM_USER_ID);
    const fin = finCtx.changeSet('jobs.finish');
    fin.maintenanceAllowed = !!handler.maintenanceAllowed;
    const latest = (yield finCtx.store.get('Jobs', current.id)) || current;
    if (error) {
      const msg = isAppError(error) ? `${error.code}: ${error.message}` : String(error && error.message ? error.message : error);
      const retry = current.attempts < current.max_attempts && (!isAppError(error) || error.retryable || error.code === 'CONFLICT');
      fin.update('Jobs', latest, {
        status: retry ? 'QUEUED' : 'FAILED', last_error: msg.slice(0, 1000), lease_until: null, lease_owner: null,
        next_run_at: retry ? addMinutesIso(finCtx.now, Math.min(60, 2 ** current.attempts)) : latest.next_run_at, finished_at: retry ? null : finCtx.now,
      });
      if (retry) report.retried++; else report.failed++;
    } else if (outcome && outcome.done) {
      fin.update('Jobs', latest, { status: 'SUCCEEDED', result_json: outcome.result || {}, lease_until: null, lease_owner: null, finished_at: finCtx.now, last_error: null });
      report.succeeded++;
    } else {
      // yielded voluntarily (time budget) — continue on next tick without consuming an attempt;
      // a handler may also ask to be parked (`pause: true`) until an operator resumes it
      fin.update('Jobs', latest, { status: outcome && outcome.pause ? 'PAUSED' : 'QUEUED', next_run_at: finCtx.now, lease_until: null, lease_owner: null, attempts: Math.max(0, latest.attempts - 1) });
      report.yielded++;
    }
    try { yield finCtx.mutations.commit(fin.build()); } catch (e) { if (!isAppError(e)) throw e; }
  }
  return report;
}

/** Enqueue unless an active job with the same dedupe_key exists (keeps user commands from failing on the partial unique key). */
export function* enqueueJobOnce(ctx, cs, spec) {
  if (spec.dedupe_key) {
    const existing = yield ctx.store.findBy('Jobs', 'dedupe_key', spec.dedupe_key);
    if (existing.some((j) => ['QUEUED', 'RUNNING', 'PAUSED'].includes(j.status))) return null;
  }
  return enqueueJob(cs, ctx, spec);
}

/** Enqueue a once-per-key job (any status) so a daily job never repeats after success; commits itself. */
export function* enqueueOnceEver(ctx, spec) {
  const existing = yield ctx.store.findBy('Jobs', 'dedupe_key', spec.dedupe_key);
  if (existing.length) return false;
  const cs = ctx.changeSet('jobs.schedule');
  enqueueJob(cs, ctx, { ...spec, owner_user_id: SYSTEM_USER_ID });
  yield ctx.mutations.commit(cs.build({ result: {} }));
  return true;
}

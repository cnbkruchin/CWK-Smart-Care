// Background worker of the reference REST backend: the same tick tasks and durable jobs as Apps Script
// cronTick (src/application/scheduler.js, jobs.js), on a Node interval. Runs as the system principal —
// no user token is stored or reused. One tick at a time across instances (PostgreSQL advisory lock).
import { runAsync } from '../../../src/application/runtime.js';
import { runDueJobs } from '../../../src/application/jobs.js';
import { JOB_HANDLERS } from '../../../src/application/registry.js';
import { tasksForMode } from '../../../src/application/scheduler.js';
import { refreshMode } from './deps.mjs';

export const TICK_BUDGET_MS = 240000; // < JOB_LEASE_SECONDS, like the GAS 4.5-minute budget

/** One tick: scheduled tasks for the current system mode, then due jobs. Returns the report. */
export async function runTick(deps, { budgetMs = TICK_BUDGET_MS, owner = `api-${process.pid}` } = {}) {
  const started = Date.now();
  const deadlineAt = started + budgetMs;
  const run = async () => {
    const report = { tasks: {} };
    const mode = await refreshMode(deps, { at: 0 });
    for (const task of tasksForMode(mode)) {
      if (Date.now() > deadlineAt - 30000) break;
      try {
        report.tasks[task.name] = await runAsync(task.run, deps, { deadlineAt, now: deps.clock.now() });
      } catch (err) {
        report.tasks[task.name] = { error: err && err.code ? err.code : 'INTERNAL_ERROR' };
        deps.logger.error({ event: 'tick_task_error', task: task.name, code: err && err.code, message: String(err && err.message).slice(0, 200) });
      }
    }
    try {
      report.tasks.jobs = await runAsync(runDueJobs, deps, JOB_HANDLERS, { deadlineAt, owner });
    } catch (err) {
      report.tasks.jobs = { error: err && err.code ? err.code : 'INTERNAL_ERROR' };
      deps.logger.error({ event: 'jobs_error', message: String(err && err.message).slice(0, 200) });
    }
    return report;
  };
  const report = deps.store.withWorkerLock ? await deps.store.withWorkerLock(run) : await run();
  report.ms = Date.now() - started;
  return report;
}

/** Interval driver; stop() waits for the running tick. */
export function startWorker(deps, { intervalSeconds = 60, budgetMs = TICK_BUDGET_MS } = {}) {
  let current = null;
  let stopped = false;
  const tick = async () => {
    if (current || stopped) return;
    current = runTick(deps, { budgetMs })
      .then((report) => deps.logger.info({ event: 'tick', ...summarize(report) }))
      .catch((err) => deps.logger.error({ event: 'tick_error', message: String(err && err.message).slice(0, 200) }))
      .finally(() => { current = null; });
  };
  const timer = setInterval(tick, Math.max(5, intervalSeconds) * 1000);
  timer.unref();
  setTimeout(tick, 1000).unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (current) await current;
    },
  };
}

function summarize(report) {
  if (report.skipped) return { skipped: 'another instance holds the worker lock', ms: report.ms };
  const tasks = {};
  for (const [k, v] of Object.entries(report.tasks || {})) tasks[k] = v && v.error ? { error: v.error } : 'done';
  return { tasks, jobs: report.tasks && report.tasks.jobs, ms: report.ms };
}

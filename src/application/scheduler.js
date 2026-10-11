// Periodic tasks run by the single background worker (GAS cronTick / Node interval), in order,
// within the caller's time budget. Each task is a generator: function*(deps, {deadlineAt, now}).
// Feature modules append their tasks through SCHEDULED_TASKS in extensions-tick.js.
import { SCHEDULED_TASKS } from './extensions-tick.js';

export const TICK_TASKS = [...SCHEDULED_TASKS];

/**
 * Tasks to run on this tick. While the system is READ_ONLY (maintenance, migration freeze, archived after
 * cutover) only tasks marked readOnlySafe run (their writes are maintenance writes); the others would only
 * fail every minute and must not touch business data anyway.
 */
export function tasksForMode(systemMode) {
  return systemMode === 'READ_ONLY' ? TICK_TASKS.filter((t) => t.readOnlySafe) : TICK_TASKS;
}

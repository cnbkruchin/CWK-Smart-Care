// Periodic tasks run by the single background worker (GAS cronTick / Node interval), in order,
// within the caller's time budget. Each task is a generator: function*(deps, {deadlineAt, now}).
// Feature modules append their tasks through SCHEDULED_TASKS in extensions-tick.js.
import { SCHEDULED_TASKS } from './extensions-tick.js';

export const TICK_TASKS = [...SCHEDULED_TASKS];

// Scheduled tasks registered by feature modules. Order matters: journal recovery runs before this
// list (GAS cronTick); jobs run after it.
import { ATTENDANCE_TICK } from './jobs/attendance-jobs.js';

export const SCHEDULED_TASKS = [ATTENDANCE_TICK];

// Scheduled tasks registered by feature modules. Order matters: journal recovery runs before this
// list (GAS cronTick); jobs run after it. Webhook retries and the outbox run every tick.
import { ATTENDANCE_TICK } from './jobs/attendance-jobs.js';
import { FOLLOWUP_TICK } from './jobs/followup-jobs.js';
import { WEBHOOK_TICK } from './webhook/line-webhook.js';
import { OUTBOX_TICK } from './outbox/worker.js';
import { OPS_TICK } from './ops/operations.js';

export const SCHEDULED_TASKS = [ATTENDANCE_TICK, WEBHOOK_TICK, FOLLOWUP_TICK, OUTBOX_TICK, OPS_TICK];

// Scheduled tasks registered by feature modules (attendance day opening, outbox dispatch,
// webhook processing, follow-up rules, metrics). Order matters: recovery runs before this list.
export const SCHEDULED_TASKS = [];

// Feature modules register their operations and job handlers here, keeping registry.js stable.
// Each entry also appears in API_CONTRACT.md (generated).
import { attendanceOps } from './ops/attendance.js';
import { leaveOps } from './ops/leave.js';
import { attachmentOps } from './ops/attachments.js';
import { profileOps } from './ops/profile.js';
import { followupOps } from './ops/followup.js';
import { notificationOps } from './ops/notifications.js';
import { ATTENDANCE_JOB_HANDLERS } from './jobs/attendance-jobs.js';
import { FOLLOWUP_JOB_HANDLERS } from './jobs/followup-jobs.js';

export const EXTRA_OPS = [...attendanceOps, ...leaveOps, ...attachmentOps, ...profileOps, ...followupOps, ...notificationOps];
export const EXTRA_JOB_HANDLERS = { ...ATTENDANCE_JOB_HANDLERS, ...FOLLOWUP_JOB_HANDLERS };

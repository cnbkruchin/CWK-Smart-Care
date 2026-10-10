// Capacity model computed from the REAL schema column counts (MASTER_PROMPT §3).
// All workload numbers are ASSUMPTIONS for planning; replace them with pilot measurements.

import { TABLES } from '../../src/schema/index.js';

export const DEFAULT_ASSUMPTIONS = Object.freeze({
  students: 1500, // สมมติ — ไม่ใช่จำนวนนักเรียนจริงของโรงเรียน
  classes: 40,
  guardians_per_student: 1.6,
  staff: 120,
  school_days_per_term: 100,
  terms_per_year: 2,
  late_rate: 0.05, // สัดส่วนนักเรียนที่ลงเวลาสายที่ประตูต่อวัน
  rollcall_exception_rate: 0.05, // ไม่พบตัว/สายในห้อง/แจ้งลา ต่อวัน
  absence_confirm_rate: 0.02,
  leave_requests_per_day: 30,
  segments_per_leave: 1.5,
  revisions_per_leave: 3,
  corrections_per_day: 5,
  cases_per_day: 4,
  contacts_per_day: 15,
  notified_guardians_per_event: 1.5,
  external_channels_per_recipient: 1.2, // LINE และ/หรือ email
  dashboard_users: 10,
  dashboard_poll_seconds: 60,
  active_hours_per_day: 10,
  gate_stations: 5,
});

const cols = (name) => TABLES.find((t) => t.name === name).columns.length;

export function computeCapacity(a = DEFAULT_ASSUMPTIONS) {
  const d = a.school_days_per_term;
  const late = a.students * a.late_rate;
  const rcEx = a.students * a.rollcall_exception_rate;
  const absent = a.students * a.absence_confirm_rate;
  const lateNotifs = late * a.notified_guardians_per_event;
  const absNotifs = absent * a.notified_guardians_per_event;
  const leaveNotifs = a.leave_requests_per_day * 3; // pending (approver) + guardian + decided
  const recipientsPerDay = lateNotifs + absNotifs + leaveNotifs + a.cases_per_day * 2;
  const outboxPerDay = recipientsPerDay * a.external_channels_per_recipient;
  const notificationsPerDay = late + absent + a.leave_requests_per_day * 3 + a.cases_per_day * 2;
  const mutationsPerDay = late /* gate */ + a.classes /* roll call */ + a.classes /* verify */ + a.leave_requests_per_day * 3
    + a.corrections_per_day + a.cases_per_day * 3 + a.contacts_per_day + Math.ceil(a.students / 200) /* open day */ + outboxPerDay /* outbox result updates */;

  // rows per TERM for partitioned tables, per YEAR for master tables
  const perTerm = {
    DailyAttendance: a.students * d,
    AttendanceEvents: (late + rcEx + absent + a.corrections_per_day) * d,
    RollCallSessions: a.classes * d,
    AttendanceCorrections: a.corrections_per_day * d,
    NotificationAttempts: outboxPerDay * 1.1 * d,
    MutationJournal: mutationsPerDay * 1.05 * d,
    IdempotencyRecords: (mutationsPerDay - outboxPerDay) * d,
    AuditEvents: (mutationsPerDay + a.contacts_per_day) * d,
    ChangeLog: mutationsPerDay * d,
    OperationMetrics: 25 * a.active_hours_per_day * d,
    Notifications: notificationsPerDay * d,
    NotificationRecipients: recipientsPerDay * d,
    NotificationOutbox: outboxPerDay * d,
    Acknowledgements: recipientsPerDay * 0.4 * d,
    WebhookInbox: recipientsPerDay * 0.5 * d,
  };
  const perYear = {
    Students: a.students * 0.35, // ผู้เข้าใหม่ต่อปี (ประมาณ ม.1 + ม.4)
    Guardians: a.students * 0.35 * a.guardians_per_student,
    StudentGuardians: a.students * 0.35 * a.guardians_per_student,
    Users: a.students * 0.35 * a.guardians_per_student * 0.8 + 10,
    IdentityLinks: a.students * 0.35 * a.guardians_per_student * 0.8 + 10,
    Enrollments: a.students * 1.05,
    Classes: a.classes,
    LeaveRequests: a.leave_requests_per_day * d * a.terms_per_year,
    LeaveSegments: a.leave_requests_per_day * a.segments_per_leave * d * a.terms_per_year,
    LeaveRevisions: a.leave_requests_per_day * a.revisions_per_leave * d * a.terms_per_year,
    LeaveApprovals: a.leave_requests_per_day * 1.5 * d * a.terms_per_year,
    Cases: a.cases_per_day * d * a.terms_per_year,
    CaseEvents: a.cases_per_day * 6 * d * a.terms_per_year,
    ContactLogs: a.contacts_per_day * d * a.terms_per_year,
    Appointments: a.cases_per_day * 0.5 * d * a.terms_per_year,
    ReconciliationTasks: (a.classes * 0.3 + 5) * d * a.terms_per_year,
    Attachments: a.leave_requests_per_day * 0.3 * d * a.terms_per_year + a.students * 0.35,
    AttachmentLinks: a.leave_requests_per_day * 0.3 * d * a.terms_per_year + a.students * 0.35,
    StorageObjectMappings: a.leave_requests_per_day * 0.3 * d * a.terms_per_year + a.students * 0.35,
    ReportRuns: 20 * d * a.terms_per_year,
  };
  const rows = [];
  for (const [t, r] of Object.entries(perTerm)) {
    const table = TABLES.find((x) => x.name === t);
    rows.push({ table: t, scope: 'term', workbook: table.workbook === 'DAILY' ? 'Daily/term' : table.workbook === 'NOTIFY' ? 'Notify/term' : 'Ops/term', rows: Math.round(r), columns: cols(t), cells: Math.round(r) * cols(t) });
  }
  for (const [t, r] of Object.entries(perYear)) rows.push({ table: t, scope: 'year', workbook: 'Master', rows: Math.round(r), columns: cols(t), cells: Math.round(r) * cols(t) });
  const sum = (wb) => rows.filter((x) => x.workbook === wb).reduce((n, x) => n + x.cells, 0);
  const totals = { 'Daily/term': sum('Daily/term'), 'Ops/term': sum('Ops/term'), 'Notify/term': sum('Notify/term'), 'Master/year': sum('Master') };
  const load = {
    mutations_per_day: Math.round(mutationsPerDay),
    outbox_per_day: Math.round(outboxPerDay),
    emails_per_day_if_all_email: Math.round(outboxPerDay),
    dashboard_rpc_per_day: Math.round(a.dashboard_users * (3600 / a.dashboard_poll_seconds) * a.active_hours_per_day * 0.3),
    gate_peak_scans_per_minute: Math.round(Math.min(late, a.gate_stations * 6)),
    trigger_ticks_per_day_1min: 1440,
  };
  return { assumptions: a, rows, totals, load };
}

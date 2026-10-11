// Student profile & timeline (MASTER_PROMPT §7.5) and role-aware dashboard summary.
import { op } from '../dispatcher.js';
import { obj, S, basicStudent, fullStudent } from './common.js';
import { requirePermission, allows, scopeFor } from '../authz.js';
import { requireStudent, getClass, enrollmentsOf } from '../queries.js';
import { computeDay, preloadDay, listAll } from '../services/attendance-core.js';
import { partitionsForDates, ruleFor } from '../context.js';
import { activeEvents } from '../../domain/attendance.js';
import { rosterForClass } from '../../domain/enrollment.js';
import { dateInRange, addDays } from '../../shared/time.js';
import { ENUMS } from '../../schema/enums.js';

export const COUNTING_NOTE_TH = [
  'มาเรียน = มีหลักฐานการมา (บันทึกที่ประตู หรือครูเช็กชื่อว่ามา/มาสาย)',
  'มาสาย (นับ) = มาถึงหลังเวลาเริ่มสาย + ช่วงผ่อนผันของกฎที่มีผลวันนั้น ไม่นับเมื่อมีข้อยกเว้นหรือใบลาครอบคลุมช่วงเช้า; หนึ่งวันนับได้ครั้งเดียว',
  'ลาทั้งวัน/บางช่วง = เฉพาะใบลาที่อนุมัติแล้ว; หน่วยวัน ครึ่งวัน และคาบ แสดงแยกกัน ไม่บวกปน',
  'ขาด (ยืนยัน) = ครูตรวจสอบและยืนยันแล้วเท่านั้น; ไม่มีข้อมูล = รอตรวจสอบ (ไม่ใช่ขาด)',
  'ตัวหาร = วันเรียนที่นักเรียนอยู่ในทะเบียน (enrollment) ของวันนั้น',
];

export function tally(rows) {
  const t = { school_days: 0, present: 0, late_counted: 0, late_raw: 0, late_minutes: 0, full_day_leave: 0, partial_leave: 0, absent_confirmed: 0, unknown: 0 };
  for (const r of rows) {
    if (!r.eligible || !r.school_day) continue;
    t.school_days++;
    if (r.presence_status === 'PRESENT') t.present++;
    if (r.presence_status === 'ON_LEAVE_FULL_DAY') t.full_day_leave++;
    if (r.presence_status === 'ABSENT_CONFIRMED') t.absent_confirmed++;
    if (r.presence_status === 'UNKNOWN') t.unknown++;
    if (r.partial_leave) t.partial_leave++;
    if (r.is_late) t.late_raw++;
    if (r.late_counted) { t.late_counted++; t.late_minutes += r.late_minutes || 0; }
  }
  return t;
}

function eventKind(e) {
  if (e.event_type === 'GATE_ARRIVAL' || e.event_type === 'ROLL_CALL_LATE') return 'late';
  if (e.event_type === 'ABSENCE_CONFIRMED' || e.event_type === 'ROLL_CALL_ABSENT') return 'absent';
  return 'event';
}

export const profileOps = [
  op({
    name: 'student.profile', description_th: 'หน้าประวัตินักเรียน: ข้อมูล สถานะล่าสุด สถิติ timeline ผู้ปกครอง ครู งานค้าง (ตามสิทธิ์)', permission: 'student.read | student.read_basic',
    input: obj({ student_id: S.uuid, from: S.dateOrNull, to: S.dateOrNull }, ['student_id']),
    *handler(ctx, input) {
      const full = yield* allows(ctx, 'student.read', { student_id: input.student_id });
      if (!full) yield* requirePermission(ctx, 'student.read_basic', { student_id: input.student_id });
      const s = yield* requireStudent(ctx, input.student_id);
      const enrs = yield* enrollmentsOf(ctx, s.id);
      const current = enrs.find((e) => dateInRange(ctx.today, e.effective_from, e.effective_to));
      const cls = current ? yield* getClass(ctx, current.class_id) : null;
      const today = (yield* computeDay(ctx, s.id, ctx.today)).computed;
      const latest = { school_date: ctx.today, presence_status: today.presence_status, presence_th: ENUMS.PresenceStatus.th[today.presence_status], verification_level: today.verification_level, verification_th: ENUMS.VerificationLevel.th[today.verification_level], arrived_at: today.arrived_at, is_late: today.is_late, late_minutes: today.late_minutes, leave_units: today.leave_units };
      if (!full) return { access: 'BASIC', student: basicStudent(s, cls), latest };
      const term = ctx.terms.find((t) => ctx.today >= t.start_date && ctx.today < t.end_date) || ctx.terms[ctx.terms.length - 1] || null;
      const from = input.from || (term ? term.start_date : addDays(ctx.today, -120));
      const to = input.to || addDays(ctx.today, 1);
      const parts = partitionsForDates(ctx, [from, addDays(to, -1)]);
      const days = (yield ctx.store.findBy('DailyAttendance', 'student_id', s.id, { partitions: parts })).filter((d) => d.school_date >= from && d.school_date < to);
      const byMonth = new Map();
      for (const d of days) { const m = d.school_date.slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(d); }
      const stats = { period: { from, to_exclusive: to, ...tally(days) }, months: [...byMonth.entries()].sort().map(([month, rows]) => ({ month, ...tally(rows) })), counting_note_th: COUNTING_NOTE_TH };
      const events = (yield ctx.store.findBy('AttendanceEvents', 'student_id', s.id, { partitions: parts })).filter((e) => e.school_date >= from && e.school_date < to);
      const activeIds = new Set(activeEvents(events).map((e) => e.id));
      const timeline = events.map((e) => ({ at: e.occurred_at, school_date: e.school_date, kind: eventKind(e), type: e.event_type, label_th: ENUMS.AttendanceEventType.th[e.event_type], source: e.source, offline: e.offline, superseded: !activeIds.has(e.id) && e.event_type !== 'EVENT_VOIDED', reason: e.reason_text, id: e.id }));
      const leaves = yield ctx.store.findBy('LeaveRequests', 'student_id', s.id);
      for (const r of leaves) timeline.push({ at: r.submitted_at || r.created_at, school_date: r.start_date, kind: 'leave', type: 'LEAVE', label_th: `${ENUMS.LeaveType.th[r.leave_type]} — ${ENUMS.LeaveStatus.th[r.status]}`, leave_request_id: r.id, status: r.status });
      const corrections = yield ctx.store.findBy('AttendanceCorrections', 'student_id', s.id);
      for (const c of corrections) timeline.push({ at: c.requested_at, school_date: c.school_date, kind: 'correction', type: 'CORRECTION', label_th: `${ENUMS.CorrectionType.th[c.correction_type]} (${ENUMS.CorrectionStatus.th[c.status]})`, reason: c.reason, id: c.id, status: c.status, correction_type: c.correction_type, version: c.version });
      let cases = [];
      let contacts = [];
      if (yield* allows(ctx, 'case.read', { student_id: s.id })) {
        cases = yield ctx.store.findBy('Cases', 'student_id', s.id);
        contacts = yield ctx.store.findBy('ContactLogs', 'student_id', s.id);
        for (const c of contacts) timeline.push({ at: c.contacted_at, kind: 'contact', type: 'CONTACT', label_th: `${ENUMS.ContactChannel.th[c.channel]}: ${ENUMS.ContactOutcome.th[c.outcome]}`, reason: c.summary, id: c.id });
        for (const c of cases) timeline.push({ at: c.created_at, kind: 'case', type: 'CASE', label_th: `เรื่องติดตาม: ${c.trigger_summary_th} (${ENUMS.CaseStatus.th[c.status]})`, id: c.id });
      } else if (yield* allows(ctx, 'case.read_summary', { student_id: s.id })) {
        cases = (yield ctx.store.findBy('Cases', 'student_id', s.id)).map((c) => ({ id: c.id, status: c.status, case_type: c.case_type, due_at: c.due_at }));
      }
      timeline.sort((a, b) => (a.at < b.at ? 1 : -1));
      let guardians = null;
      if (yield* allows(ctx, 'guardian.read_contact', { student_id: s.id })) {
        guardians = [];
        for (const l of (yield ctx.store.findBy('StudentGuardians', 'student_id', s.id)).filter((x) => x.status !== 'ENDED')) {
          const g = yield ctx.store.get('Guardians', l.guardian_id);
          const contactsG = (yield ctx.store.findBy('ContactEndpoints', 'owner_id', l.guardian_id)).filter((c) => c.status === 'ACTIVE');
          guardians.push({ link_id: l.id, relationship: l.relationship, is_primary_contact: l.is_primary_contact, contact_priority: l.contact_priority, status: l.status, name: g ? `${g.prefix_th || ''}${g.first_name_th} ${g.last_name_th}` : '', contacts: contactsG.map((c) => ({ channel: c.channel, value: c.value, label_th: c.label_th, is_primary: c.is_primary })) });
        }
      }
      const teachers = [];
      if (current) {
        for (const a of (yield ctx.store.findBy('StaffAssignments', 'class_id', current.class_id)).filter((x) => x.assignment_type === 'HOMEROOM' && dateInRange(ctx.today, x.effective_from, x.effective_to))) {
          const u = yield ctx.store.get('Users', a.user_id);
          if (u) teachers.push({ user_id: u.id, name: u.display_name, role: 'HOMEROOM_TEACHER' });
        }
      }
      const tasks = (yield ctx.store.list('ReconciliationTasks', { where: { student_id: s.id, status: 'OPEN' }, limit: 50 })).items;
      const history = [];
      for (const e of [...enrs].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))) {
        const c = yield* getClass(ctx, e.class_id);
        history.push({ class_name_th: c ? c.name_th : null, effective_from: e.effective_from, effective_to: e.effective_to, end_reason: e.end_reason });
      }
      return {
        access: 'FULL', student: fullStudent(s, cls), enrollments: history, latest, stats, timeline: timeline.slice(0, 300), guardians, teachers,
        open_tasks: tasks, cases: cases.map((c) => ({ id: c.id, status: c.status, case_type: c.case_type, priority: c.priority, due_at: c.due_at, next_action_th: c.next_action_th, owner_user_id: c.owner_user_id })),
        can: {
          correct: yield* allows(ctx, 'attendance.correct', { student_id: s.id }), request_correction: yield* allows(ctx, 'attendance.request_correction', { student_id: s.id }),
          submit_leave: yield* allows(ctx, 'leave.submit', { student_id: s.id }), manage_guardians: yield* allows(ctx, 'guardian.manage', { student_id: s.id }),
          manage_cases: yield* allows(ctx, 'case.manage', { student_id: s.id }), record_contact: yield* allows(ctx, 'case.record_contact', { student_id: s.id }),
        },
      };
    },
  }),

  op({
    name: 'dashboard.summary', description_th: 'สรุปวันนี้ตามขอบเขตสิทธิ์ (ใช้ projection เดียวกับรายงาน R01)', permission: 'attendance.read',
    input: obj({ school_date: S.dateOrNull, class_id: S.uuidOrNull }),
    *handler(ctx, input) {
      const date = input.school_date || ctx.today;
      const scope = scopeFor(ctx, 'attendance.read');
      let classIds;
      const allClasses = (yield ctx.store.list('Classes', { limit: 500 })).items;
      if (input.class_id) { yield* requirePermission(ctx, 'attendance.read', { class_id: input.class_id }); classIds = [input.class_id]; }
      else if (scope.all) classIds = allClasses.map((c) => c.id);
      else classIds = [...(scope.classIds || [])];
      const linkedOnly = !scope.all && !classIds.length && (scope.studentIds || new Set()).size;
      const enrollments = yield* listAll(ctx, 'Enrollments', { where: { effective_from: { lte: date } } });
      let roster = [];
      if (linkedOnly) roster = enrollments.filter((e) => scope.studentIds.has(e.student_id) && dateInRange(date, e.effective_from, e.effective_to));
      else for (const cid of classIds) roster = roster.concat(rosterForClass(enrollments, cid, date));
      const pre = yield* preloadDay(ctx, date, roster.map((e) => e.student_id));
      const perClass = new Map();
      const rows = [];
      for (const e of roster) {
        const { computed } = yield* computeDay(ctx, e.student_id, date, { ...pre.get(e.student_id), enrollment: e });
        rows.push(computed);
        if (!perClass.has(e.class_id)) perClass.set(e.class_id, []);
        perClass.get(e.class_id).push(computed);
      }
      const sessions = yield ctx.store.list('RollCallSessions', { where: { school_date: date }, partitions: partitionsForDates(ctx, [date]), limit: 500 });
      const submitted = new Set(sessions.items.filter((x) => x.status !== 'OPEN').map((x) => x.class_id));
      const byId = new Map(allClasses.map((c) => [c.id, c]));
      const classes = [...perClass.entries()].map(([cid, list]) => ({ class_id: cid, class_name_th: (byId.get(cid) || {}).name_th, roll_call_submitted: submitted.has(cid), ...tally(list) })).sort((a, b) => ((a.class_name_th || '') < (b.class_name_th || '') ? -1 : 1));
      const total = tally(rows);
      const openTasks = scope.all || classIds.length ? (yield ctx.store.list('ReconciliationTasks', { where: scope.all ? { status: 'OPEN' } : { status: 'OPEN', class_id: { in: classIds } }, limit: 500 })).items.length : 0;
      const rule = yield* ruleFor(ctx, 'SCHOOL_LATENESS', date, { required: false });
      return {
        school_date: date, totals: total, classes, roll_call: { classes_total: perClass.size, classes_submitted: [...perClass.keys()].filter((c) => submitted.has(c)).length },
        open_tasks: openTasks, lateness_rule: rule ? { version_no: rule.version_no, cutoff_time: rule.params_json.cutoff_time, grace_minutes: rule.params_json.grace_minutes, is_example: rule.is_example } : null,
        counting_note_th: COUNTING_NOTE_TH, students: linkedOnly ? rows.map((r) => ({ student_id: r.student_id, presence_status: r.presence_status, is_late: r.is_late, late_minutes: r.late_minutes, leave_units: r.leave_units })) : undefined,
      };
    },
  }),
];

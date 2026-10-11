// Report definitions R01–R12 (MASTER_PROMPT §12). Server-side queries, permission scope applied
// before any row is produced, and the SAME projection/tally as the dashboard (services/daily-summary).
// Each builder returns { columns, rows, totals, notes_th, scope_th } — renderers never compute numbers.
import { requirePermission, allows, scopeFor } from '../authz.js';
import { partitionsForDates, ruleFor } from '../context.js';
import { listAll } from '../services/attendance-core.js';
import { dailySummary, tally, COUNTING_NOTE_TH } from '../services/daily-summary.js';
import { studentShortName } from '../services/notify.js';
import { requireStudent, allCalendar, getClass } from '../queries.js';
import { dayInfo, termForDate } from '../../domain/calendar.js';
import { activeEvents } from '../../domain/attendance.js';
import { findEffectiveEnrollment } from '../../domain/enrollment.js';
import { AppError } from '../../shared/errors.js';
import { addDays, diffDays, dateInRange, isoWeekday, localToUtc, addMinutesIso } from '../../shared/time.js';
import { ENUMS } from '../../schema/enums.js';

const th = (e, v) => (v && ENUMS[e] && ENUMS[e].th[v]) || v || '';
const col = (key, label, type = 'text') => ({ key, label, type });
const F = {
  date: (name, label, required = true) => ({ name, type: 'date', label_th: label, required }),
  cls: { name: 'class_id', type: 'class', label_th: 'ห้อง', required: false },
  grade: { name: 'grade_level', type: 'enum', enum: 'GradeLevel', label_th: 'ระดับชั้น', required: false },
};

function badRange(msg) { return new AppError('VALIDATION_ERROR', 'range', { messageTh: msg, fieldErrors: [{ field: 'to', code: 'RANGE', message_th: msg }] }); }

/** Inclusive date list; enforces from ≤ to and a maximum span. */
export function dateList(from, to, maxDays) {
  if (!from || !to) throw badRange('ระบุวันเริ่มและวันสิ้นสุด');
  if (to < from) throw badRange('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (diffDays(from, to) + 1 > maxDays) throw badRange(`ช่วงวันที่ยาวเกิน ${maxDays} วันสำหรับรายงานนี้ — แบ่งเป็นช่วงย่อย`);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Class scope for report.view (+ optional class/grade filters). null = whole school. */
function* classScope(ctx, filter, action = 'report.view') {
  const s = scopeFor(ctx, action);
  const classes = (yield ctx.store.list('Classes', { limit: 500 })).items;
  if (filter.class_id) {
    yield* requirePermission(ctx, action, { class_id: filter.class_id });
    return { ids: new Set([filter.class_id]), classes, label: (classes.find((c) => c.id === filter.class_id) || {}).name_th || '' };
  }
  let ids = s.all ? null : new Set(s.classIds || []);
  if (filter.grade_level) ids = new Set(classes.filter((c) => c.grade_level === filter.grade_level && (!ids || ids.has(c.id))).map((c) => c.id));
  return { ids, classes, label: ids ? (filter.grade_level ? th('GradeLevel', filter.grade_level) : 'ห้องในความรับผิดชอบ') : 'ทั้งโรงเรียน' };
}

const inScope = (scope, classId) => !scope.ids || scope.ids.has(classId);

function* usersById(ctx, ids) { return yield ctx.store.getMany('Users', [...new Set(ids.filter(Boolean))]); }
function* studentsById(ctx, ids) { return yield ctx.store.getMany('Students', [...new Set(ids.filter(Boolean))]); }

/** Enrollment-at-date class lookup for many students (history-correct scope). */
function* classAt(ctx) {
  const enrollments = yield* listAll(ctx, 'Enrollments', {});
  const by = new Map();
  for (const e of enrollments) { if (!by.has(e.student_id)) by.set(e.student_id, []); by.get(e.student_id).push(e); }
  return (sid, date) => { const e = findEffectiveEnrollment(by.get(sid) || [], sid, date); return e ? e.class_id : null; };
}

// ───────────────────────── R01 ─────────────────────────
function* r01(ctx, f) {
  const scope = yield* classScope(ctx, f);
  const sum = yield* dailySummary(ctx, { date: f.date, classIds: scope.ids ? [...scope.ids] : null });
  const rule = yield* ruleFor(ctx, 'SCHOOL_LATENESS', f.date, { required: false });
  const rows = sum.classes.map((c) => ({
    class_name_th: c.class_name_th, eligible: c.school_days, present: c.present, late_counted: c.late_counted, full_day_leave: c.full_day_leave, partial_leave: c.partial_leave,
    absent_confirmed: c.absent_confirmed, unknown: c.unknown, roll_call: c.roll_call_verified ? 'ยืนยันแล้ว' : c.roll_call_submitted ? 'ส่งแล้ว' : 'ยังไม่ส่ง',
  }));
  return {
    columns: [col('class_name_th', 'ห้อง'), col('eligible', 'ผู้มีสิทธิ์มาเรียน', 'int'), col('present', 'มาแล้ว', 'int'), col('late_counted', 'ในจำนวนนี้สาย (นับ)', 'int'),
      col('full_day_leave', 'ลาทั้งวัน', 'int'), col('partial_leave', 'ลาบางช่วง', 'int'), col('absent_confirmed', 'ขาด (ยืนยัน)', 'int'), col('unknown', 'รอตรวจสอบ', 'int'), col('roll_call', 'การเช็กชื่อ')],
    rows,
    totals: { class_name_th: 'รวม', eligible: sum.totals.school_days, present: sum.totals.present, late_counted: sum.totals.late_counted, full_day_leave: sum.totals.full_day_leave, partial_leave: sum.totals.partial_leave, absent_confirmed: sum.totals.absent_confirmed, unknown: sum.totals.unknown, roll_call: `${sum.rollCall.classes_submitted}/${sum.rollCall.classes_total} ห้อง` },
    notes_th: [...COUNTING_NOTE_TH, rule ? `กฎการมาสายฉบับที่ ${rule.version_no}: เริ่มสาย ${rule.params_json.cutoff_time} ผ่อนผัน ${rule.params_json.grace_minutes} นาที${rule.is_example ? ' (ค่าตัวอย่าง — ยังไม่ใช่ค่าของโรงเรียน)' : ''}` : 'ไม่มีกฎการมาสายที่มีผลวันนี้'],
    scope_th: scope.label, rule_versions: rule ? { SCHOOL_LATENESS: rule.version_no } : {},
  };
}

// ───────────────────────── R02 ─────────────────────────
function* r02(ctx, f) {
  const scope = yield* classScope(ctx, f);
  const dates = dateList(f.from, f.to, 93);
  const stations = new Map((yield ctx.store.list('Stations', { limit: 200 })).items.map((s) => [s.id, s.name_th]));
  const out = [];
  for (const d of dates) {
    const parts = partitionsForDates(ctx, [d]);
    const rows = (yield ctx.store.findBy('DailyAttendance', 'school_date', d, { partitions: parts })).filter((r) => r.is_late && inScope(scope, r.class_id));
    if (!rows.length) continue;
    const events = yield ctx.store.findBy('AttendanceEvents', 'school_date', d, { partitions: parts });
    const byStudent = new Map();
    for (const e of events) { if (!byStudent.has(e.student_id)) byStudent.set(e.student_id, []); byStudent.get(e.student_id).push(e); }
    for (const r of rows) {
      if (f.counted_only && !r.late_counted) continue;
      const act = activeEvents(byStudent.get(r.student_id) || []);
      const arrival = act.filter((e) => e.event_type === 'GATE_ARRIVAL' || e.event_type === 'ROLL_CALL_LATE').pop() || null;
      const exempt = act.find((e) => e.event_type === 'LATENESS_EXEMPTED') || null;
      if (f.exemption_reason && (!exempt || exempt.reason_code !== f.exemption_reason)) continue;
      out.push({ r, arrival, exempt });
    }
  }
  const students = yield* studentsById(ctx, out.map((x) => x.r.student_id));
  const users = yield* usersById(ctx, out.map((x) => x.arrival && x.arrival.actor_id));
  const classes = new Map(scope.classes.map((c) => [c.id, c.name_th]));
  const rows = out.map(({ r, arrival, exempt }) => {
    const s = students.get(r.student_id);
    return {
      school_date: r.school_date, arrived_at: r.arrived_at, student_code: s ? s.student_code : '', student_name: s ? studentShortName(s) : '', class_name_th: classes.get(r.class_id) || '',
      late_minutes: r.late_minutes, counted: r.late_counted ? 'นับ' : 'ไม่นับ', exemption: exempt ? `${OPTION_LABELS_TH[exempt.reason_code] || exempt.reason_code || ''}: ${exempt.reason_text || ''}` : '',
      station: arrival && arrival.station_id ? stations.get(arrival.station_id) || '' : '', source: arrival ? th('AttendanceSource', arrival.source) + (arrival.offline ? ' (ออฟไลน์)' : '') : '',
      recorded_by: arrival && users.get(arrival.actor_id) ? users.get(arrival.actor_id).display_name : '',
    };
  }).sort((a, b) => (a.school_date + a.arrived_at < b.school_date + b.arrived_at ? -1 : 1));
  const counted = out.filter((x) => x.r.late_counted);
  return {
    columns: [col('school_date', 'วันที่', 'date'), col('arrived_at', 'เวลามาถึง', 'time'), col('student_code', 'รหัส'), col('student_name', 'ชื่อ-สกุล'), col('class_name_th', 'ห้อง'),
      col('late_minutes', 'สาย (นาที)', 'int'), col('counted', 'การนับ'), col('exemption', 'ข้อยกเว้น/เหตุผล'), col('station', 'จุดลงเวลา'), col('source', 'วิธีบันทึก'), col('recorded_by', 'ผู้บันทึก')],
    rows,
    totals: { student_name: `${new Set(out.map((x) => x.r.student_id)).size} คน`, late_minutes: counted.reduce((n, x) => n + (x.r.late_minutes || 0), 0), counted: `นับ ${counted.length} / ทั้งหมด ${out.length} ครั้ง` },
    notes_th: ['เวลามาถึงจริงแสดงเสมอ แม้ได้รับการยกเว้นหรือมีใบลาครอบคลุม (คอลัมน์ "การนับ" แสดงผลตามกฎ)', 'นาทีรวมคิดเฉพาะครั้งที่นับ'],
    scope_th: scope.label,
  };
}

// ───────────────────────── R03 ─────────────────────────
function* r03(ctx, f) {
  const scope = yield* classScope(ctx, f, 'leave.read');
  dateList(f.from, f.to, 400);
  const toEx = addDays(f.to, 1);
  let reqs = (yield ctx.store.list('LeaveRequests', { where: { start_date: { lt: toEx }, end_date: { gt: f.from } }, limit: 5000 })).items;
  if (f.status) reqs = reqs.filter((r) => r.status === f.status);
  if (f.leave_type) reqs = reqs.filter((r) => r.leave_type === f.leave_type);
  const clsAt = yield* classAt(ctx);
  reqs = reqs.filter((r) => inScope(scope, clsAt(r.student_id, r.start_date)));
  const students = yield* studentsById(ctx, reqs.map((r) => r.student_id));
  const approvals = new Map();
  for (const r of reqs) approvals.set(r.id, (yield ctx.store.findBy('LeaveApprovals', 'leave_request_id', r.id)).filter((a) => a.step_type === 'SCHOOL_APPROVAL').sort((a, b) => (a.decided_at < b.decided_at ? 1 : -1))[0] || null);
  const users = yield* usersById(ctx, [...approvals.values()].map((a) => a && a.decided_by));
  const classes = new Map(scope.classes.map((c) => [c.id, c.name_th]));
  const rows = reqs.sort((a, b) => (a.start_date < b.start_date ? -1 : 1)).map((r) => {
    const s = students.get(r.student_id);
    const a = approvals.get(r.id);
    return {
      submitted_at: r.submitted_at, student_name: s ? studentShortName(s) : '', class_name_th: classes.get(clsAt(r.student_id, r.start_date)) || '', leave_type: th('LeaveType', r.leave_type),
      period: r.start_date === addDays(r.end_date, -1) ? r.start_date : `${r.start_date} – ${addDays(r.end_date, -1)}`, units: `วัน ${r.full_day_count || 0} · ครึ่งวัน ${r.half_day_count || 0} · คาบ ${r.period_count || 0}`,
      status: th('LeaveStatus', r.status), guardian: th('GuardianConfirmation', r.guardian_confirmation_status), approver: a && users.get(a.decided_by) ? users.get(a.decided_by).display_name : (r.current_approver_role ? `รอ: ${th('Role', r.current_approver_role)}` : ''),
      retroactive: r.is_retroactive ? 'ย้อนหลัง' : '',
    };
  });
  const pending = reqs.filter((r) => ['PENDING_GUARDIAN', 'PENDING_SCHOOL', 'CANCELLATION_REQUESTED', 'RETURNED'].includes(r.status)).length;
  return {
    columns: [col('submitted_at', 'ยื่นเมื่อ', 'datetime'), col('student_name', 'นักเรียน'), col('class_name_th', 'ห้อง'), col('leave_type', 'ประเภท'), col('period', 'ช่วงวันที่'), col('units', 'จำนวน (แยกหน่วย)'),
      col('status', 'สถานะ'), col('guardian', 'ผู้ปกครองยืนยัน'), col('approver', 'ผู้อนุมัติ'), col('retroactive', 'หมายเหตุ')],
    rows, totals: { student_name: `${rows.length} ใบ`, status: `ค้างพิจารณา ${pending}` },
    notes_th: ['หน่วยวัน ครึ่งวัน และคาบนับแยก ไม่บวกปน', 'ห้องตามทะเบียน ณ วันเริ่มลา'], scope_th: scope.label,
  };
}

// ───────────────────────── R04 ─────────────────────────
function* r04(ctx, f, { profileHandler }) {
  if (!f.student_id) throw new AppError('VALIDATION_ERROR', 'student', { fieldErrors: [{ field: 'student_id', code: 'REQUIRED', message_th: 'เลือกนักเรียน' }] });
  yield* requirePermission(ctx, 'student.read', { student_id: f.student_id });
  const p = yield* profileHandler(ctx, { student_id: f.student_id, from: f.from || null, to: f.to ? addDays(f.to, 1) : null });
  if (p.access !== 'FULL') throw new AppError('FORBIDDEN', 'full profile required');
  const rows = p.timeline.map((t) => ({ at: t.at, school_date: t.school_date || '', kind: t.label_th + (t.superseded ? ' (ถูกแก้ไขแล้ว)' : ''), reason: t.reason || '', source: t.source ? th('AttendanceSource', t.source) : '' }));
  const st = p.stats.period;
  return {
    columns: [col('at', 'เวลา', 'datetime'), col('school_date', 'วันเรียน', 'date'), col('kind', 'รายการ'), col('reason', 'เหตุผล/สรุป'), col('source', 'ที่มา')],
    rows, totals: null,
    notes_th: [`${p.student.prefix_th || ''}${p.student.first_name_th} ${p.student.last_name_th} รหัส ${p.student.student_code} ห้อง ${p.student.class_name_th || '—'}`,
      `ช่วง ${st.from} ถึงก่อน ${st.to_exclusive}: วันเรียน ${st.school_days} · มา ${st.present} · สาย (นับ) ${st.late_counted} (${st.late_minutes} นาที) · ลาทั้งวัน ${st.full_day_leave} · ลาบางช่วง ${st.partial_leave} · ขาด (ยืนยัน) ${st.absent_confirmed} · รอตรวจสอบ ${st.unknown}`,
      ...COUNTING_NOTE_TH],
    scope_th: 'รายบุคคล',
  };
}

// ───────────────────────── R05 ─────────────────────────
function* r05(ctx, f) {
  const scope = yield* classScope(ctx, f, 'case.read');
  let cases = (yield ctx.store.list('Cases', { where: f.status ? { status: f.status } : { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE', 'RESOLVED'] } }, limit: 2000 })).items;
  const clsAt = yield* classAt(ctx);
  cases = cases.filter((c) => inScope(scope, clsAt(c.student_id, ctx.today)) || (!scope.ids ? true : c.owner_user_id === ctx.principal.user_id));
  if (f.overdue_only) cases = cases.filter((c) => c.due_at && c.due_at < ctx.now && c.status !== 'RESOLVED' && c.status !== 'CLOSED');
  const students = yield* studentsById(ctx, cases.map((c) => c.student_id));
  const users = yield* usersById(ctx, cases.map((c) => c.owner_user_id));
  const rules = yield ctx.store.getMany('RuleVersions', [...new Set(cases.map((c) => c.rule_version_id).filter(Boolean))]);
  const classes = new Map(scope.classes.map((c) => [c.id, c.name_th]));
  const rows = [];
  for (const c of cases) {
    const s = students.get(c.student_id);
    const last = (yield ctx.store.findBy('ContactLogs', 'case_id', c.id)).sort((a, b) => (a.contacted_at < b.contacted_at ? 1 : -1))[0];
    const rule = c.rule_version_id ? rules.get(c.rule_version_id) : null;
    rows.push({
      student_name: s ? studentShortName(s) : '', class_name_th: classes.get(clsAt(c.student_id, ctx.today)) || '', case_type: th('CaseType', c.case_type),
      rule: rule ? `${th('RuleType', rule.rule_type)} ฉบับที่ ${rule.version_no}${rule.is_example ? ' (ตัวอย่าง)' : ''}` : '—', evidence: c.trigger_summary_th, owner: c.owner_user_id && users.get(c.owner_user_id) ? users.get(c.owner_user_id).display_name : '',
      due_at: c.due_at, status: th('CaseStatus', c.status) + (c.due_at && c.due_at < ctx.now && !['RESOLVED', 'CLOSED'].includes(c.status) ? ' (เกินกำหนด)' : ''),
      last_action: last ? `${th('ContactOutcome', last.outcome)} (${last.contacted_at.slice(0, 10)})` : 'ยังไม่มีการติดต่อ',
    });
  }
  return {
    columns: [col('student_name', 'นักเรียน'), col('class_name_th', 'ห้อง'), col('case_type', 'ประเภท'), col('rule', 'เกณฑ์/เวอร์ชัน'), col('evidence', 'เหตุที่เข้าเกณฑ์'), col('owner', 'ผู้รับผิดชอบ'),
      col('due_at', 'ครบกำหนด', 'datetime'), col('status', 'สถานะ'), col('last_action', 'ผลดำเนินการล่าสุด')],
    rows, totals: { student_name: `${rows.length} เรื่อง` }, notes_th: ['ระบบนับข้อเท็จจริงตามเกณฑ์ ไม่ตัดสินพฤติกรรมหรือบทลงโทษ'], scope_th: scope.label,
  };
}

// ───────────────────────── R06 ─────────────────────────
function* r06(ctx, f) {
  const scope = yield* classScope(ctx, f, 'case.record_contact');
  dateList(f.from, f.to, 400);
  const fromTs = localToUtc(f.from, '00:00', ctx.tz);
  const toTs = localToUtc(addDays(f.to, 1), '00:00', ctx.tz);
  const clsAt = yield* classAt(ctx);
  let logs = (yield ctx.store.list('ContactLogs', { where: { contacted_at: { gte: fromTs, lt: toTs } }, limit: 5000 })).items.filter((l) => inScope(scope, clsAt(l.student_id, l.contacted_at.slice(0, 10))));
  if (f.channel) logs = logs.filter((l) => l.channel === f.channel);
  const appts = (yield ctx.store.list('Appointments', { where: { scheduled_at: { gte: fromTs, lt: toTs } }, limit: 2000 })).items.filter((a) => inScope(scope, clsAt(a.student_id, a.scheduled_at.slice(0, 10))));
  const students = yield* studentsById(ctx, [...logs.map((l) => l.student_id), ...appts.map((a) => a.student_id)]);
  const users = yield* usersById(ctx, logs.map((l) => l.contacted_by));
  const guardians = yield ctx.store.getMany('Guardians', [...new Set(logs.map((l) => l.guardian_id).filter(Boolean))]);
  const name = (sid) => (students.get(sid) ? studentShortName(students.get(sid)) : '');
  const rows = [
    ...logs.map((l) => ({ at: l.contacted_at, kind: 'ติดต่อ', student_name: name(l.student_id), guardian: l.guardian_id && guardians.get(l.guardian_id) ? `${guardians.get(l.guardian_id).first_name_th} ${guardians.get(l.guardian_id).last_name_th}` : '',
      channel: `${th('ContactChannel', l.channel)} · ${th('ContactDirection', l.direction)}`, outcome: th('ContactOutcome', l.outcome), by: users.get(l.contacted_by) ? users.get(l.contacted_by).display_name : '', summary: String(l.summary || '').slice(0, 200) })),
    ...appts.map((a) => ({ at: a.scheduled_at, kind: 'นัดหมาย', student_name: name(a.student_id), guardian: '', channel: a.location || '', outcome: th('AppointmentStatus', a.status), by: '', summary: String(a.outcome_note || a.attendees_note || '').slice(0, 200) })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));
  const reached = logs.filter((l) => ['REACHED', 'ACKNOWLEDGED', 'APPOINTMENT_MADE', 'ASSISTANCE_PROVIDED'].includes(l.outcome)).length;
  return {
    columns: [col('at', 'เวลา', 'datetime'), col('kind', 'ประเภท'), col('student_name', 'นักเรียน'), col('guardian', 'ผู้ปกครอง'), col('channel', 'ช่องทาง/สถานที่'), col('outcome', 'ผล'), col('by', 'ผู้ติดต่อ'), col('summary', 'สรุป')],
    rows, totals: { kind: `ติดต่อ ${logs.length} · นัด ${appts.length}`, outcome: `ติดต่อได้ ${reached} / ${logs.length}` }, notes_th: ['การกดปุ่มโทรไม่ถูกนับ — นับเฉพาะผลที่เจ้าหน้าที่บันทึก'], scope_th: scope.label,
  };
}

// ───────────────────────── R07 ─────────────────────────
function bucketOf(period, date, terms) {
  if (period === 'MONTH') return date.slice(0, 7);
  if (period === 'TERM') { const t = termForDate(terms, date); return t ? t.code : 'นอกภาคเรียน'; }
  return addDays(date, 1 - isoWeekday(date)); // ISO week starting Monday
}

function* r07(ctx, f) {
  const scope = yield* classScope(ctx, f);
  const dates = dateList(f.from, f.to, 200);
  const period = f.period || 'WEEK';
  const groupBy = f.group_by || 'CLASS';
  const cal = yield* allCalendar(ctx);
  const enrollments = yield* listAll(ctx, 'Enrollments', { where: { effective_from: { lte: f.to } } });
  const classes = new Map(scope.classes.map((c) => [c.id, c]));
  const groupOf = (cid) => { const c = classes.get(cid); if (!c) return null; return groupBy === 'SCHOOL' ? 'ทั้งโรงเรียน' : groupBy === 'GRADE' ? th('GradeLevel', c.grade_level) : c.name_th; };
  const agg = new Map();
  const key = (b, g) => `${b}\u0000${g}`;
  const get = (b, g) => { const k = key(b, g); if (!agg.has(k)) agg.set(k, { bucket: b, group: g, student_days: 0, present: 0, late_counted: 0, full_day_leave: 0, absent_confirmed: 0 }); return agg.get(k); };
  for (const d of dates) {
    const schoolByGrade = new Map();
    const isSchool = (grade) => { if (!schoolByGrade.has(grade)) schoolByGrade.set(grade, dayInfo({ date: d, gradeLevel: grade, terms: ctx.terms, calendarEntries: cal }).school_day); return schoolByGrade.get(grade); };
    // denominator: enrolled students in scope on a school day (explicit, independent of stored rows)
    const enrolled = new Map();
    for (const e of enrollments) {
      if (!dateInRange(d, e.effective_from, e.effective_to) || !inScope(scope, e.class_id) || !classes.has(e.class_id)) continue;
      if (!isSchool(classes.get(e.class_id).grade_level)) continue;
      enrolled.set(e.student_id, e.class_id);
    }
    if (!enrolled.size) continue;
    const b = bucketOf(period, d, ctx.terms);
    for (const cid of enrolled.values()) get(b, groupOf(cid)).student_days++;
    const rows = yield ctx.store.findBy('DailyAttendance', 'school_date', d, { partitions: partitionsForDates(ctx, [d]) });
    for (const r of rows) {
      const cid = enrolled.get(r.student_id);
      if (!cid || !r.eligible || !r.school_day) continue;
      const a = get(b, groupOf(cid));
      if (r.presence_status === 'PRESENT') a.present++;
      if (r.late_counted) a.late_counted++;
      if (r.presence_status === 'ON_LEAVE_FULL_DAY') a.full_day_leave++;
      if (r.presence_status === 'ABSENT_CONFIRMED') a.absent_confirmed++;
    }
  }
  const pct = (n, d) => (d ? Math.round((n * 1000) / d) / 10 : null);
  const rows = [...agg.values()].sort((a, b) => (a.bucket === b.bucket ? String(a.group).localeCompare(String(b.group), 'th') : a.bucket < b.bucket ? -1 : 1)).map((a) => ({
    ...a, unknown_or_missing: a.student_days - a.present - a.full_day_leave - a.absent_confirmed,
    present_rate: pct(a.present, a.student_days), late_rate: pct(a.late_counted, a.student_days), absent_rate: pct(a.absent_confirmed, a.student_days),
  }));
  const tot = rows.reduce((t, r) => { for (const k of ['student_days', 'present', 'late_counted', 'full_day_leave', 'absent_confirmed', 'unknown_or_missing']) t[k] = (t[k] || 0) + r[k]; return t; }, {});
  return {
    columns: [col('bucket', period === 'WEEK' ? 'สัปดาห์ (เริ่มจันทร์)' : period === 'MONTH' ? 'เดือน' : 'ภาคเรียน'), col('group', groupBy === 'CLASS' ? 'ห้อง' : groupBy === 'GRADE' ? 'ระดับชั้น' : 'ขอบเขต'),
      col('student_days', 'วัน-คน (ตัวหาร)', 'int'), col('present', 'มา', 'int'), col('present_rate', 'อัตรามา %', 'percent'), col('late_counted', 'สาย (นับ)', 'int'), col('late_rate', 'อัตราสาย %', 'percent'),
      col('full_day_leave', 'ลาทั้งวัน', 'int'), col('absent_confirmed', 'ขาด (ยืนยัน)', 'int'), col('absent_rate', 'อัตราขาด %', 'percent'), col('unknown_or_missing', 'รอตรวจสอบ/ไม่มีข้อมูล', 'int')],
    rows,
    totals: { bucket: 'รวม', ...tot, present_rate: pct(tot.present || 0, tot.student_days || 0), late_rate: pct(tot.late_counted || 0, tot.student_days || 0), absent_rate: pct(tot.absent_confirmed || 0, tot.student_days || 0) },
    notes_th: ['ตัวหาร "วัน-คน" = ผลรวมของจำนวนนักเรียนที่อยู่ในทะเบียนของแต่ละวันเรียน (ตามปฏิทินและระดับชั้น)', 'อัตรา = จำนวน ÷ วัน-คน × 100', ...COUNTING_NOTE_TH.slice(0, 4)],
    scope_th: scope.label,
  };
}

// ───────────────────────── R08 ─────────────────────────
function* r08(ctx, f) {
  const scope = yield* classScope(ctx, f);
  const dates = dateList(f.from, f.to, 31);
  const cal = yield* allCalendar(ctx);
  const classes = scope.classes.filter((c) => inScope(scope, c.id) && c.status !== 'INACTIVE');
  const rows = [];
  for (const d of dates) {
    const sessions = new Set((yield ctx.store.list('RollCallSessions', { where: { school_date: d }, partitions: partitionsForDates(ctx, [d]), limit: 500 })).items.filter((s) => s.status !== 'OPEN').map((s) => s.class_id));
    for (const c of classes) {
      if (!dayInfo({ date: d, gradeLevel: c.grade_level, terms: ctx.terms, calendarEntries: cal }).school_day || d > ctx.today) continue;
      if (!sessions.has(c.id)) rows.push({ category: 'ยังไม่เช็กชื่อ', detail: 'ไม่มีการส่งผลเช็กชื่อ', date: d, class_name_th: c.name_th, student: '' });
    }
  }
  const tasks = (yield ctx.store.list('ReconciliationTasks', { where: { status: 'OPEN' }, limit: 2000 })).items.filter((t) => !t.class_id ? !scope.ids : inScope(scope, t.class_id));
  const tStudents = yield* studentsById(ctx, tasks.map((t) => t.student_id));
  const cname = new Map(scope.classes.map((c) => [c.id, c.name_th]));
  for (const t of tasks) rows.push({ category: 'ข้อมูลขัดกัน/รอตรวจ', detail: `${th('ReconciliationTaskType', t.task_type)}: ${t.description_th || ''}`, date: t.school_date || '', class_name_th: cname.get(t.class_id) || '', student: t.student_id && tStudents.get(t.student_id) ? studentShortName(tStudents.get(t.student_id)) : '' });
  const clsAt = yield* classAt(ctx);
  const stale = addMinutesIso(ctx.now, -2 * 24 * 60);
  const leaves = (yield ctx.store.list('LeaveRequests', { where: { status: { in: ['PENDING_GUARDIAN', 'PENDING_SCHOOL', 'CANCELLATION_REQUESTED'] } }, limit: 2000 })).items.filter((r) => r.submitted_at < stale && inScope(scope, clsAt(r.student_id, r.start_date)));
  const lStudents = yield* studentsById(ctx, leaves.map((r) => r.student_id));
  for (const r of leaves) rows.push({ category: 'ใบลาค้างเกิน 2 วัน', detail: th('LeaveStatus', r.status), date: r.submitted_at.slice(0, 10), class_name_th: cname.get(clsAt(r.student_id, r.start_date)) || '', student: lStudents.get(r.student_id) ? studentShortName(lStudents.get(r.student_id)) : '' });
  // guardians of students in scope with no usable contact endpoint
  const links = (yield ctx.store.list('StudentGuardians', { where: { status: 'ACTIVE' }, limit: 10000 })).items.filter((l) => dateInRange(ctx.today, l.effective_from, l.effective_to) && inScope(scope, clsAt(l.student_id, ctx.today)));
  const byGuardian = new Map();
  for (const l of links) { if (!byGuardian.has(l.guardian_id)) byGuardian.set(l.guardian_id, []); byGuardian.get(l.guardian_id).push(l.student_id); }
  const endpoints = (yield ctx.store.list('ContactEndpoints', { where: { status: 'ACTIVE' }, limit: 20000 })).items;
  const withContact = new Set(endpoints.map((e) => e.owner_id));
  const gs = yield ctx.store.getMany('Guardians', [...byGuardian.keys()]);
  const gStudents = yield* studentsById(ctx, links.map((l) => l.student_id));
  for (const [gid, sids] of byGuardian) {
    if (withContact.has(gid)) continue;
    const g = gs.get(gid);
    rows.push({ category: 'ผู้ปกครองไม่มีช่องทางติดต่อ', detail: g ? `${g.first_name_th} ${g.last_name_th}` : gid, date: '', class_name_th: cname.get(clsAt(sids[0], ctx.today)) || '', student: sids.map((s) => (gStudents.get(s) ? studentShortName(gStudents.get(s)) : '')).join(', ') });
  }
  if (!scope.ids) {
    const batches = (yield ctx.store.list('ImportBatches', { limit: 200 })).items.filter((b) => (b.error_count || 0) > 0).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 10);
    for (const b of batches) rows.push({ category: 'ข้อมูลนำเข้าผิด', detail: `${b.import_type}: ผิด ${b.error_count} แถวจาก ${b.row_count} (${th('ImportStatus', b.status)})`, date: b.created_at.slice(0, 10), class_name_th: '', student: '' });
  }
  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;
  return {
    columns: [col('category', 'หมวด'), col('detail', 'รายละเอียด'), col('date', 'วันที่', 'date'), col('class_name_th', 'ห้อง'), col('student', 'นักเรียน')],
    rows, totals: { category: Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'ไม่มีรายการ' }, notes_th: ['รายการนี้ใช้ตรวจความครบถ้วนก่อนสรุปรายงานทางการ'], scope_th: scope.label,
  };
}

// ───────────────────────── R09 ─────────────────────────
function* r09(ctx, f) {
  yield* requirePermission(ctx, 'notification.monitor');
  dateList(f.from, f.to, 400);
  const parts = partitionsForDates(ctx, [f.from, f.to]);
  const fromTs = localToUtc(f.from, '00:00', ctx.tz);
  const toTs = localToUtc(addDays(f.to, 1), '00:00', ctx.tz);
  const notes = (yield ctx.store.list('Notifications', { where: { created_at: { gte: fromTs, lt: toTs } }, partitions: parts, limit: 20000 })).items;
  const ids = new Set(notes.map((n) => n.id));
  const typeOf = new Map(notes.map((n) => [n.id, n.notification_type]));
  const recs = (yield ctx.store.list('NotificationRecipients', { where: { created_at: { gte: fromTs, lt: toTs } }, partitions: parts, limit: 50000 })).items.filter((r) => ids.has(r.notification_id));
  const outbox = (yield ctx.store.list('NotificationOutbox', { where: { created_at: { gte: fromTs, lt: toTs } }, partitions: parts, limit: 50000 })).items.filter((o) => ids.has(o.notification_id));
  const by = new Map();
  const g = (t) => { if (!by.has(t)) by.set(t, { type: th('NotificationType', t), notifications: 0, recipients: 0, ack_required: 0, acknowledged: 0, pending_ack: 0, follow_up: 0, queued: 0, accepted: 0, retrying: 0, failed: 0, cancelled: 0, retried: 0 }); return by.get(t); };
  for (const n of notes) g(n.notification_type).notifications++;
  for (const r of recs) {
    const a = g(typeOf.get(r.notification_id));
    a.recipients++;
    if (r.ack_required) a.ack_required++;
    if (r.ack_state === 'ACKNOWLEDGED') a.acknowledged++;
    if (r.ack_state === 'PENDING_ACK') a.pending_ack++;
    if (r.ack_state === 'FOLLOW_UP_REQUIRED') a.follow_up++;
  }
  let oldest = null;
  for (const o of outbox) {
    const a = g(typeOf.get(o.notification_id));
    if (o.delivery_state === 'QUEUED' || o.delivery_state === 'PROCESSING') a.queued++;
    if (o.delivery_state === 'PROVIDER_ACCEPTED') a.accepted++;
    if (o.delivery_state === 'RETRY_WAIT') a.retrying++;
    if (o.delivery_state === 'FAILED_FINAL') a.failed++;
    if (o.delivery_state === 'CANCELLED') a.cancelled++;
    if (o.attempts > 1) a.retried++;
    if (['QUEUED', 'RETRY_WAIT'].includes(o.delivery_state) && (!oldest || o.created_at < oldest)) oldest = o.created_at;
  }
  const rows = [...by.values()].sort((a, b) => b.notifications - a.notifications);
  const ageMin = oldest ? Math.round((Date.parse(ctx.now) - Date.parse(oldest)) / 60000) : 0;
  return {
    columns: [col('type', 'ประเภท'), col('notifications', 'แจ้งเตือน', 'int'), col('recipients', 'ผู้รับ', 'int'), col('ack_required', 'ต้องรับทราบ', 'int'), col('acknowledged', 'รับทราบแล้ว', 'int'),
      col('pending_ack', 'รอรับทราบ', 'int'), col('follow_up', 'ต้องติดตาม', 'int'), col('queued', 'รอส่ง', 'int'), col('accepted', 'ผู้ให้บริการรับแล้ว', 'int'), col('retrying', 'รอส่งซ้ำ', 'int'),
      col('failed', 'ส่งไม่สำเร็จ', 'int'), col('cancelled', 'ยกเลิก', 'int'), col('retried', 'ส่งมากกว่า 1 ครั้ง', 'int')],
    rows, totals: { type: `อายุคิวที่ค้างนานสุด ${ageMin} นาที` },
    notes_th: ['"ผู้ให้บริการรับแล้ว" ไม่ใช่ "ผู้รับอ่านแล้ว" — การรับทราบนับเฉพาะเมื่อผู้รับกดเอง', 'ยกเลิก = ผู้รับหมดสิทธิ์/ไม่มีช่องทาง/ไม่อยู่ใน allowlist (DEV) — ดูเหตุผลในหน้า "ติดตามการส่งแจ้งเตือน"'],
    scope_th: 'ทั้งโรงเรียน',
  };
}

// ───────────────────────── R10 ─────────────────────────
function* r10(ctx, f, { leaveGetHandler }) {
  const kv = (field, value) => ({ field, value: value === null || value === undefined || value === '' ? '—' : String(value) });
  const rows = [];
  let title = '';
  if (f.form === 'LEAVE_FORM') {
    const d = yield* leaveGetHandler(ctx, { leave_request_id: f.entity_id });
    const r = d.request;
    title = 'แบบใบลา';
    rows.push(kv('นักเรียน', `${d.student.name} (${d.student.student_code})`), kv('ประเภทการลา', th('LeaveType', r.leave_type)), kv('เหตุผล', r.reason),
      kv('ช่วงวันที่', `${r.start_date} – ${addDays(r.end_date, -1)}`), ...d.segments.map((s) => kv(`วันที่ ${s.school_date}`, `${s.unit === 'PERIODS' ? `คาบ ${(s.periods || []).join(',')}` : th('LeaveUnit', s.unit)} — ${th('SegmentStatus', s.status)}`)),
      kv('ผู้ยื่น', `${d.requester_name} (${th('RequesterType', r.requester_type)})`), kv('ยื่นเมื่อ', r.submitted_at), kv('ผู้ปกครองยืนยัน', th('GuardianConfirmation', r.guardian_confirmation_status)),
      kv('ผลพิจารณาของโรงเรียน', th('SchoolApproval', r.school_approval_status)), ...d.approvals.map((a) => kv(th('ApprovalStepType', a.step_type), `${th('ApprovalDecision', a.decision)} โดย ${a.decided_by_name} ${a.decided_at}${a.comment ? ` — ${a.comment}` : ''}`)),
      kv('เอกสารแนบ', d.attachments.length ? `${d.attachments.length} ไฟล์ (ไม่แสดงเนื้อหาเอกสารสุขภาพในแบบฟอร์ม)` : 'ไม่มี'));
  } else if (f.form === 'LATE_SLIP') {
    yield* requirePermission(ctx, 'attendance.read', { student_id: f.entity_id, dates: [f.date] });
    const s = yield* requireStudent(ctx, f.entity_id);
    const p = (yield ctx.store.findBy('DailyAttendance', 'student_id', s.id, { partitions: partitionsForDates(ctx, [f.date]) })).find((x) => x.school_date === f.date);
    if (!p || !p.is_late) throw new AppError('NOT_FOUND', 'no late record', { messageTh: 'ไม่พบการมาสายของนักเรียนในวันที่เลือก' });
    const cls = p.class_id ? yield* getClass(ctx, p.class_id) : null;
    title = 'ใบบันทึกการมาสาย';
    rows.push(kv('นักเรียน', `${studentShortName(s)} (${s.student_code})`), kv('ห้อง', cls ? cls.name_th : ''), kv('วันที่', f.date), kv('เวลามาถึง', p.arrived_at), kv('สาย (นาที)', p.late_minutes),
      kv('การนับ', p.late_counted ? 'นับ' : p.lateness_exempted ? 'ไม่นับ (ได้รับการยกเว้น)' : 'ไม่นับ'), kv('สาเหตุ (ให้นักเรียน/ครูกรอก)', ''));
  } else if (f.form === 'CASE_RECORD' || f.form === 'APPOINTMENT_SLIP') {
    const kase = f.form === 'CASE_RECORD' ? yield ctx.store.get('Cases', f.entity_id) : null;
    const appt = f.form === 'APPOINTMENT_SLIP' ? yield ctx.store.get('Appointments', f.entity_id) : null;
    const c = kase || (appt && appt.case_id ? yield ctx.store.get('Cases', appt.case_id) : null);
    if (!c && !appt) throw new AppError('NOT_FOUND', 'record');
    if (c && c.owner_user_id && (yield* allows(ctx, 'case.read', { owner_user_id: c.owner_user_id }))) { /* owner */ } else yield* requirePermission(ctx, 'case.read', { student_id: (c || appt).student_id });
    const s = yield* requireStudent(ctx, (c || appt).student_id);
    if (kase) {
      title = 'บันทึกการติดตามนักเรียน';
      const contacts = (yield ctx.store.findBy('ContactLogs', 'case_id', kase.id)).sort((a, b) => (a.contacted_at < b.contacted_at ? -1 : 1));
      rows.push(kv('นักเรียน', `${studentShortName(s)} (${s.student_code})`), kv('ประเภท', th('CaseType', kase.case_type)), kv('เหตุที่เปิดเรื่อง', kase.trigger_summary_th), kv('สถานะ', th('CaseStatus', kase.status)),
        kv('ครบกำหนด', kase.due_at), ...contacts.map((x, i) => kv(`การติดต่อครั้งที่ ${i + 1}`, `${x.contacted_at} ${th('ContactChannel', x.channel)} — ${th('ContactOutcome', x.outcome)}: ${x.summary || ''}`)),
        kv('ข้อสรุป', kase.resolution_summary));
    } else {
      title = 'ใบนัดหมายผู้ปกครอง';
      rows.push(kv('นักเรียน', `${studentShortName(s)} (${s.student_code})`), kv('วันเวลานัด', appt.scheduled_at), kv('ระยะเวลา (นาที)', appt.duration_minutes), kv('สถานที่', appt.location), kv('ผู้เข้าร่วม', appt.attendees_note), kv('สถานะ', th('AppointmentStatus', appt.status)));
    }
  } else {
    throw new AppError('VALIDATION_ERROR', 'form', { fieldErrors: [{ field: 'form', code: 'REQUIRED', message_th: 'เลือกแบบฟอร์ม' }] });
  }
  return { columns: [col('field', 'รายการ'), col('value', 'ข้อมูล')], rows, totals: null, notes_th: [title], scope_th: title, title_override: title };
}

// ───────────────────────── R11 ─────────────────────────
function* r11(ctx, f) {
  yield* requirePermission(ctx, 'audit.read');
  dateList(f.from, f.to, 31);
  const parts = partitionsForDates(ctx, [f.from, f.to]);
  const fromTs = localToUtc(f.from, '00:00', ctx.tz);
  const toTs = localToUtc(addDays(f.to, 1), '00:00', ctx.tz);
  let ev;
  if (f.student_id) ev = yield ctx.store.findBy('AuditEvents', 'student_id', f.student_id, { partitions: parts });
  else if (f.actor_id) ev = yield ctx.store.findBy('AuditEvents', 'actor_id', f.actor_id, { partitions: parts });
  else ev = (yield ctx.store.list('AuditEvents', { where: { occurred_at: { gte: fromTs, lt: toTs } }, partitions: parts, limit: 5000 })).items;
  ev = ev.filter((e) => e.occurred_at >= fromTs && e.occurred_at < toTs && (!f.action || e.action.startsWith(f.action))).sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1)).slice(0, 5000);
  const users = yield* usersById(ctx, ev.map((e) => e.actor_id));
  const j = (v) => (v ? JSON.stringify(v).slice(0, 500) : '');
  const rows = ev.map((e) => ({
    occurred_at: e.occurred_at, actor: users.get(e.actor_id) ? users.get(e.actor_id).display_name : e.actor_id, roles: e.actor_roles || '', action: e.action, entity: `${e.entity_type || ''} ${e.entity_id ? e.entity_id.slice(0, 8) : ''}`.trim(),
    reason: e.reason || '', before: j(e.before_json), after: j(e.after_json), operation_id: e.operation_id || '', request_id: e.request_id || '',
  }));
  return {
    columns: [col('occurred_at', 'เวลา', 'datetime'), col('actor', 'ผู้ทำรายการ'), col('roles', 'บทบาท'), col('action', 'การกระทำ'), col('entity', 'ข้อมูล'), col('reason', 'เหตุผล'),
      col('before', 'ค่าเดิม'), col('after', 'ค่าใหม่'), col('operation_id', 'operation ID'), col('request_id', 'request ID')],
    rows, totals: { actor: `${rows.length} รายการ` },
    notes_th: ['Audit บน Google Sheets ไม่กันการแก้ไขโดยผู้ที่แก้ไขสเปรดชีตได้ — ใช้ตรวจย้อนหลัง ไม่ใช่หลักฐานแบบแก้ไขไม่ได้', 'แสดงสูงสุด 5,000 รายการต่อรายงาน — ใช้ตัวกรองให้แคบลง'],
    scope_th: 'ทั้งโรงเรียน',
  };
}

// ───────────────────────── R12 ─────────────────────────
function* r12(ctx) {
  yield* requirePermission(ctx, 'system.health');
  const backups = (yield ctx.store.list('BackupRuns', { limit: 500 })).items;
  const migrations = (yield ctx.store.list('MigrationRuns', { limit: 500 })).items;
  const rows = [
    ...backups.map((b) => ({ started_at: b.started_at, kind: th('BackupType', b.backup_type), status: th('RunStatus', b.status), finished_at: b.finished_at || '', location: b.package_location ? `${String(b.package_location).slice(0, 12)}…` : '',
      checksum: b.manifest_sha256 ? b.manifest_sha256.slice(0, 16) : '', rows: b.row_counts_json ? Object.values(b.row_counts_json).reduce((n, v) => n + (Number(v) || 0), 0) : '', restore: b.restore_tested_at ? `${b.restore_tested_at.slice(0, 10)}: ${b.restore_result || ''}` : 'ยังไม่ทดสอบ' })),
    ...migrations.map((m) => ({ started_at: m.started_at, kind: `${th('MigrationRunType', m.run_type)} (${th('MigrationMode', m.mode)})`, status: th('MigrationState', m.state), finished_at: m.finished_at || '', location: m.package_location ? `${String(m.package_location).slice(0, 12)}…` : '',
      checksum: m.manifest_sha256 ? m.manifest_sha256.slice(0, 16) : '', rows: m.summary_json && m.summary_json.total_rows ? m.summary_json.total_rows : '', restore: m.summary_json && m.summary_json.reconciliation ? String(m.summary_json.reconciliation) : '' })),
  ].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return {
    columns: [col('started_at', 'เริ่ม', 'datetime'), col('kind', 'ประเภท'), col('status', 'สถานะ'), col('finished_at', 'เสร็จ', 'datetime'), col('location', 'ที่เก็บ'), col('checksum', 'checksum (manifest)'), col('rows', 'จำนวนรายการ', 'int'), col('restore', 'ผลทดสอบ restore/reconcile')],
    rows, totals: { kind: `สำรอง ${backups.length} · ย้ายข้อมูล ${migrations.length}` }, notes_th: ['ทดสอบ restore ไป environment ใหม่อย่างน้อยหนึ่งครั้งก่อนใช้งานจริง และบันทึกเวลาที่ใช้'], scope_th: 'ทั้งโรงเรียน',
  };
}

const RANGE = [F.date('from', 'ตั้งแต่'), F.date('to', 'ถึง')];
export const REPORTS = Object.freeze({
  R01: { build: r01, permission: 'report.view', filters: [F.date('date', 'วันที่'), F.cls, F.grade] },
  R02: { build: r02, permission: 'report.view', filters: [...RANGE, F.cls, F.grade, { name: 'counted_only', type: 'bool', label_th: 'เฉพาะที่นับ' }, { name: 'exemption_reason', type: 'select', options: ['TRANSPORT_DELAY', 'WEATHER', 'SCHOOL_EVENT', 'OTHER'], label_th: 'เหตุผลการยกเว้น' }] },
  R03: { build: r03, permission: 'report.view', filters: [...RANGE, F.cls, F.grade, { name: 'status', type: 'enum', enum: 'LeaveStatus', label_th: 'สถานะ' }, { name: 'leave_type', type: 'enum', enum: 'LeaveType', label_th: 'ประเภท' }] },
  R04: { build: r04, permission: 'report.view', filters: [{ name: 'student_id', type: 'student', label_th: 'นักเรียน', required: true }, F.date('from', 'ตั้งแต่', false), F.date('to', 'ถึง', false)] },
  R05: { build: r05, permission: 'report.view', filters: [F.cls, F.grade, { name: 'status', type: 'enum', enum: 'CaseStatus', label_th: 'สถานะ' }, { name: 'overdue_only', type: 'bool', label_th: 'เฉพาะเกินกำหนด' }] },
  R06: { build: r06, permission: 'report.view', filters: [...RANGE, F.cls, F.grade, { name: 'channel', type: 'enum', enum: 'ContactChannel', label_th: 'ช่องทาง' }] },
  R07: { build: r07, permission: 'report.view', filters: [...RANGE, F.cls, F.grade, { name: 'period', type: 'select', options: ['WEEK', 'MONTH', 'TERM'], label_th: 'รอบ' }, { name: 'group_by', type: 'select', options: ['CLASS', 'GRADE', 'SCHOOL'], label_th: 'จัดกลุ่มตาม' }] },
  R08: { build: r08, permission: 'report.view', filters: [...RANGE, F.cls, F.grade] },
  R09: { build: r09, permission: 'notification.monitor', filters: RANGE },
  R10: { build: r10, permission: 'report.view', filters: [{ name: 'form', type: 'select', options: ['LEAVE_FORM', 'LATE_SLIP', 'CASE_RECORD', 'APPOINTMENT_SLIP'], label_th: 'แบบฟอร์ม', required: true }, { name: 'entity_id', type: 'uuid', label_th: 'รหัสรายการ/นักเรียน', required: true }, F.date('date', 'วันที่ (ใบมาสาย)', false)] },
  R11: { build: r11, permission: 'audit.read', filters: [...RANGE, { name: 'actor_id', type: 'uuid', label_th: 'ผู้ทำรายการ (รหัสผู้ใช้)' }, { name: 'student_id', type: 'student', label_th: 'นักเรียน' }, { name: 'action', type: 'text', label_th: 'การกระทำ (ขึ้นต้น)' }] },
  R12: { build: r12, permission: 'system.health', filters: [] },
});

export const FORM_LABELS_TH = { LEAVE_FORM: 'แบบใบลา', LATE_SLIP: 'ใบบันทึกการมาสาย', CASE_RECORD: 'บันทึกการติดตาม', APPOINTMENT_SLIP: 'ใบนัดหมาย' };
export const OPTION_LABELS_TH = { WEEK: 'รายสัปดาห์', MONTH: 'รายเดือน', TERM: 'รายภาคเรียน', CLASS: 'ห้อง', GRADE: 'ระดับชั้น', SCHOOL: 'ทั้งโรงเรียน', TRANSPORT_DELAY: 'รถรับส่งล่าช้า', WEATHER: 'สภาพอากาศ', SCHOOL_EVENT: 'กิจกรรมโรงเรียน', OTHER: 'อื่น ๆ', ...FORM_LABELS_TH };
export { tally };

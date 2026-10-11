// One definition of "today in numbers" (MASTER_PROMPT §12: reports use the same data as the dashboard).
// dashboard.summary and report R01 both call dailySummary(); rows come from the DailyAttendance
// projection computed by the same domain function (students without a stored row are computed live).
import { listAll, preloadDay, computeDay } from './attendance-core.js';
import { partitionsForDates } from '../context.js';
import { rosterForClass } from '../../domain/enrollment.js';
import { dateInRange } from '../../shared/time.js';

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

/**
 * @param {object} ctx
 * @param {{date:string, classIds:string[]|null, studentIds:Set<string>|null}} q  classIds=null → all classes
 * @returns {{date, rows, perClass: Map<classId, rows[]>, classes: object[], totals, rollCall: {classes_total, classes_submitted, submitted:Set, verified:Set}}}
 */
export function* dailySummary(ctx, { date, classIds = null, studentIds = null }) {
  const allClasses = (yield ctx.store.list('Classes', { limit: 500 })).items;
  const byId = new Map(allClasses.map((c) => [c.id, c]));
  const ids = classIds || allClasses.map((c) => c.id);
  const enrollments = yield* listAll(ctx, 'Enrollments', { where: { effective_from: { lte: date } } });
  let roster = [];
  if (studentIds) roster = enrollments.filter((e) => studentIds.has(e.student_id) && dateInRange(date, e.effective_from, e.effective_to));
  else for (const cid of ids) roster = roster.concat(rosterForClass(enrollments, cid, date));
  const pre = yield* preloadDay(ctx, date, roster.map((e) => e.student_id));
  const perClass = new Map();
  const rows = [];
  for (const e of roster) {
    const { computed } = yield* computeDay(ctx, e.student_id, date, { ...pre.get(e.student_id), enrollment: e });
    rows.push(computed);
    if (!perClass.has(e.class_id)) perClass.set(e.class_id, []);
    perClass.get(e.class_id).push(computed);
  }
  const sessions = (yield ctx.store.list('RollCallSessions', { where: { school_date: date }, partitions: partitionsForDates(ctx, [date]), limit: 500 })).items;
  const submitted = new Set(sessions.filter((x) => x.status !== 'OPEN').map((x) => x.class_id));
  const verified = new Set(sessions.filter((x) => x.status === 'VERIFIED').map((x) => x.class_id));
  const classes = [...perClass.entries()].map(([cid, list]) => {
    const c = byId.get(cid) || {};
    return { class_id: cid, class_name_th: c.name_th, grade_level: c.grade_level, roll_call_submitted: submitted.has(cid), roll_call_verified: verified.has(cid), ...tally(list) };
  }).sort((a, b) => String(a.class_name_th || '').localeCompare(String(b.class_name_th || ''), 'th'));
  return {
    date, rows, perClass, classes, totals: tally(rows),
    rollCall: { classes_total: perClass.size, classes_submitted: [...perClass.keys()].filter((c) => submitted.has(c)).length, submitted, verified },
  };
}

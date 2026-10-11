// Notification templates (versioned). Content is minimal: no medical details, no assistance notes,
// no other students' data. Rendering happens at send time from params stored with the notification.
import { formatThaiDate, formatThaiTime } from '../../shared/thai-format.js';

const T = (key, version, title, body, actions = ['ACK']) => ({ key, version, title, body, actions });

export const TEMPLATES = Object.freeze({
  LEAVE_NEW: T('leave_new', 1, 'ใบลาใหม่', (p) => `มีใบลาใหม่ของ ${p.student_name} (${p.class_name}) ${p.days_text} รอพิจารณา`, ['OPEN']),
  LEAVE_PENDING_GUARDIAN: T('leave_pending_guardian', 1, 'ใบลารอผู้ปกครองยืนยัน', (p) => `${p.student_name} ยื่นใบลา${p.leave_type_th} ${p.days_text} กรุณาเข้าสู่ระบบเพื่อยืนยัน`, ['OPEN']),
  LEAVE_PENDING_SCHOOL: T('leave_pending_school', 1, 'ใบลารออนุมัติ', (p) => `ใบลา${p.leave_type_th}ของ ${p.student_name} (${p.class_name}) ${p.days_text} รอการอนุมัติ`, ['OPEN']),
  LEAVE_DECIDED: T('leave_decided', 1, 'ผลพิจารณาใบลา', (p) => `ใบลาของ ${p.student_name} ${p.days_text}: ${p.decision_th}`, ['ACK']),
  LATE_CONFIRMED: T('late_confirmed', 1, 'แจ้งมาสาย', (p) => `${p.student_name} (${p.class_name}) มาถึงโรงเรียนเวลา ${formatThaiTime(p.arrived_at)} วันที่ ${formatThaiDate(p.school_date)} (สาย ${p.late_minutes} นาที)`, ['ACK', 'CALLBACK']),
  ABSENCE_CONFIRMED: T('absence_confirmed', 1, 'แจ้งขาดเรียน', (p) => `ครูได้ตรวจสอบแล้วว่า ${p.student_name} (${p.class_name}) ไม่มาเรียนวันที่ ${formatThaiDate(p.school_date)} โดยไม่มีใบลา กรุณากดรับทราบหรือขอให้ครูติดต่อกลับ`, ['ACK', 'CALLBACK']),
  CASE_NEW: T('case_new', 1, 'งานติดตามใหม่', (p) => `มีงานติดตามใหม่: ${p.student_name} — ${p.summary_th}`, ['OPEN']),
  CASE_OVERDUE: T('case_overdue', 1, 'งานติดตามเกินกำหนด', (p) => `งานติดตามของ ${p.student_name} เกินกำหนด (${formatThaiDate(p.due_date)})`, ['OPEN']),
  CALLBACK_REQUESTED: T('callback_requested', 1, 'ผู้ปกครองขอให้ติดต่อกลับ', (p) => `ผู้ปกครองของ ${p.student_name} ขอให้ติดต่อกลับเรื่อง ${p.topic_th}`, ['OPEN']),
  DATA_CORRECTED: T('data_corrected', 1, 'แจ้งการแก้ไขข้อมูล', (p) => `ข้อมูลการมาเรียนของ ${p.student_name} วันที่ ${formatThaiDate(p.school_date)} ได้รับการแก้ไข: ${p.change_th}`, ['ACK']),
  ROLL_CALL_REMINDER: T('roll_call_reminder', 1, 'เตือนตรวจสอบการมาเรียน', (p) => `ห้อง ${p.class_name} มีนักเรียน ${p.count} คนยังไม่ทราบสถานะวันที่ ${formatThaiDate(p.school_date)}`, ['OPEN']),
  SYSTEM: T('system', 1, 'แจ้งจากระบบ', (p) => p.text_th || '', ['OPEN']),
});

export function render(type, params) {
  const t = TEMPLATES[type];
  return { title: t.title, body: t.body(params || {}), actions: t.actions, template_key: t.key, template_version: t.version };
}

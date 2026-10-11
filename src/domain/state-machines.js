// State transition tables (MASTER_PROMPT §9). Used both to enforce transitions in services and
// to generate docs/STATE_MACHINES.md. "(new)" denotes creation.

import { AppError } from '../shared/errors.js';

const t = (from, action, roles, to, precondition_th, side_effects_th, audit = true) => ({ from, action, roles, to, precondition_th, side_effects_th, audit });

export const MACHINES = Object.freeze({
  Leave: {
    entity: 'LeaveRequests.status',
    note_th: 'สถานะรวมคำนวณจากสถานะผู้ปกครองยืนยัน (guardian_confirmation_status) และสถานะโรงเรียน (school_approval_status) ที่เก็บแยกกัน; DRAFT ใช้เก็บร่างที่หน้าจอ ไม่สร้างแถวในระยะแรก',
    transitions: [
      t(['(new)'], 'SUBMIT', ['GUARDIAN', 'STUDENT', 'HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['PENDING_GUARDIAN', 'PENDING_SCHOOL'],
        'leave.submit ตามขอบเขต; ทุกวันเป็นวันเรียนและมี enrollment; ไม่ซ้อนกับใบลาที่ยังมีผล; ย้อนหลังต้องมีเหตุผล',
        'สร้าง LeaveSegments + LeaveRevisions; แจ้งผู้ปกครอง (ถ้าต้องยืนยัน) หรือผู้อนุมัติ'),
      t(['PENDING_GUARDIAN'], 'GUARDIAN_CONFIRM', ['GUARDIAN'], ['PENDING_SCHOOL'], 'ผู้ปกครองที่มีสิทธิ์ CONFIRM_LEAVE ของนักเรียนคนนั้น', 'บันทึก LeaveApprovals ขั้นผู้ปกครอง; แจ้งผู้อนุมัติ'),
      t(['PENDING_GUARDIAN'], 'GUARDIAN_DECLINE', ['GUARDIAN'], ['REJECTED'], 'ผู้ปกครองที่มีสิทธิ์ CONFIRM_LEAVE', 'segments → REJECTED; แจ้งผู้ยื่น'),
      t(['PENDING_SCHOOL'], 'APPROVE', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['APPROVED'], 'ผู้มีอำนาจตามเส้นทางอนุมัติ (หรือผู้รักษาการแทน/กิจการนักเรียน); expected_version ตรง',
        'segments → APPROVED; คำนวณ DailyAttendance ใหม่ทุกวันที่เกี่ยวข้อง; แจ้งผลผู้ยื่นและผู้ปกครอง'),
      t(['PENDING_SCHOOL'], 'PARTIAL_APPROVE', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['PARTIALLY_APPROVED'], 'ระบุผลทุก segment; มีอย่างน้อยหนึ่งอนุมัติและหนึ่งไม่อนุมัติ', 'เหมือน APPROVE เฉพาะช่วงที่อนุมัติ'),
      t(['PENDING_SCHOOL'], 'REJECT', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['REJECTED'], 'ต้องมีเหตุผล', 'segments → REJECTED; แจ้งผล'),
      t(['PENDING_GUARDIAN', 'PENDING_SCHOOL'], 'RETURN', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['RETURNED'], 'ต้องมีเหตุผลที่ส่งกลับ', 'แจ้งผู้ยื่นให้แก้ไข'),
      t(['RETURNED'], 'RESUBMIT', ['GUARDIAN', 'STUDENT', 'HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['PENDING_GUARDIAN', 'PENDING_SCHOOL'], 'ผู้ยื่นเดิม; ตรวจซ้อน/วันเรียนใหม่', 'revision_no + 1; segments ใหม่แทนชุดเดิม (ชุดเดิมเป็น WITHDRAWN)'),
      t(['PENDING_GUARDIAN', 'PENDING_SCHOOL', 'RETURNED'], 'WITHDRAW', ['GUARDIAN', 'STUDENT', 'HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['WITHDRAWN'], 'ผู้ยื่นเดิม หรือกิจการนักเรียน', 'segments → WITHDRAWN'),
      t(['APPROVED', 'PARTIALLY_APPROVED'], 'CANCEL_REQUEST', ['GUARDIAN', 'STUDENT', 'HOMEROOM_TEACHER'], ['CANCELLATION_REQUESTED'], 'ต้องมีเหตุผล', 'แจ้งผู้อนุมัติ'),
      t(['APPROVED', 'PARTIALLY_APPROVED', 'CANCELLATION_REQUESTED'], 'CANCEL_APPROVE', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['CANCELLED'], 'ต้องมีเหตุผล; ยกเลิกโดยตรงได้เฉพาะผู้มีอำนาจ', 'segments ที่อนุมัติ → CANCELLED; คำนวณ DailyAttendance ใหม่; แจ้งผู้เกี่ยวข้อง'),
      t(['CANCELLATION_REQUESTED'], 'CANCEL_REJECT', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['APPROVED', 'PARTIALLY_APPROVED'], 'ต้องมีเหตุผล', 'คืนสถานะเดิมตาม segments'),
      t(['PENDING_GUARDIAN', 'PENDING_SCHOOL'], 'REROUTE', ['STUDENT_AFFAIRS'], ['PENDING_GUARDIAN', 'PENDING_SCHOOL'], 'ผู้พิจารณาไม่อยู่/ต้องเปลี่ยนเส้นทาง', 'เปลี่ยน current_approver_role/user; บันทึก revision'),
    ],
  },
  AttendanceDay: {
    entity: 'DailyAttendance.presence_status (projection) / RollCallSessions.status',
    note_th: 'สถานะรายวันเป็น projection จากเหตุการณ์ ไม่มีการตั้งค่าโดยตรง; การไม่มีรายการไม่ใช่การขาด',
    transitions: [
      t(['(new)'], 'GATE_ARRIVAL', ['DUTY_TEACHER', 'GATE_STAFF', 'STUDENT_AFFAIRS'], ['PRESENT'], 'ระบุตัวนักเรียนแล้ว; สแกนซ้ำคืนผลเดิม', 'ประเมินสายตามกฎวันนั้น; แจ้งผู้ปกครองเมื่อสาย'),
      t(['(new)', 'UNKNOWN'], 'ROLL_CALL_SUBMIT', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['PRESENT', 'UNKNOWN'], 'รายชื่อตาม enrollment ของวันนั้น', 'นักเรียนที่ไม่ได้ทำเครื่องหมายยกเว้น = มา (ROLL_CALL); ไม่พบตัว = ยังรอตรวจสอบ'),
      t(['UNKNOWN'], 'VERIFY_ABSENCE', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['ABSENT_CONFIRMED'], 'ไม่มีหลักฐานการมา/ลา และครูยืนยัน', 'ABSENCE_CONFIRMED event; แจ้งผู้ปกครอง "ขาดเรียน" หลังยืนยันเท่านั้น'),
      t(['PRESENT', 'ABSENT_CONFIRMED', 'UNKNOWN'], 'CORRECT', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['PRESENT', 'ABSENT_CONFIRMED', 'UNKNOWN', 'ON_LEAVE_FULL_DAY'], 'มีเหตุผล; expected version', 'event ใหม่ supersedes เดิม; คำนวณใหม่; แจ้งการแก้ไขเฉพาะผู้ได้รับผลกระทบ'),
      t(['UNKNOWN', 'PRESENT'], 'LEAVE_APPROVED', ['HOMEROOM_TEACHER', 'STUDENT_AFFAIRS'], ['ON_LEAVE_FULL_DAY', 'PRESENT'], 'ใบลาอนุมัติ', 'ถ้ามีการมาจริงด้วย สถานะ PRESENT + conflict + ReconciliationTask (คงคำอนุมัติไว้)'),
    ],
  },
  Case: {
    entity: 'Cases.status',
    note_th: 'กันเปิดซ้ำด้วย dedupe_key + cooldown; ปิดแล้วเปิดใหม่ได้ตามสิทธิ์',
    transitions: [
      t(['(new)'], 'OPEN', ['STUDENT_AFFAIRS', 'HOMEROOM_TEACHER', 'SYSTEM'], ['OPEN'], 'กฎเข้าเงื่อนไขพร้อมหลักฐาน หรือครูเปิดเอง; ไม่มีเรื่องเปิดอยู่ที่ dedupe_key เดียวกัน และพ้น cooldown', 'แจ้งเจ้าของเรื่อง (CASE_NEW)'),
      t(['OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE'], 'ASSIGN', ['STUDENT_AFFAIRS', 'HOMEROOM_TEACHER'], ['OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE'], 'ผู้รับต้องมีสิทธิ์ case.manage ต่อนักเรียน', 'CaseEvents ASSIGNED/TRANSFERRED; แจ้งผู้รับ'),
      t(['OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE'], 'RECORD_CONTACT', ['STUDENT_AFFAIRS', 'HOMEROOM_TEACHER'], ['IN_PROGRESS', 'WAITING_RESPONSE'], 'บันทึกผลการติดต่อจริง (ไม่บันทึกว่าโทรสำเร็จจนกว่าเจ้าหน้าที่บันทึกผล)', 'ContactLogs + CaseEvents; ติดต่อไม่ได้/ต้องติดตาม → รอการตอบกลับ'),
      t(['OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE'], 'RESOLVE', ['STUDENT_AFFAIRS', 'HOMEROOM_TEACHER'], ['RESOLVED'], 'มีข้อสรุป', 'CaseEvents'),
      t(['OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE', 'RESOLVED'], 'CLOSE', ['STUDENT_AFFAIRS', 'HOMEROOM_TEACHER'], ['CLOSED'], 'ต้องมี resolution_summary', 'ตั้ง cooldown_until ตามกฎ'),
      t(['CLOSED', 'RESOLVED'], 'REOPEN', ['STUDENT_AFFAIRS', 'HOMEROOM_TEACHER'], ['OPEN'], 'ต้องมีเหตุผล', 'reopened_count + 1'),
    ],
  },
  Outbox: {
    entity: 'NotificationOutbox.delivery_state',
    note_th: 'PROVIDER_ACCEPTED ไม่ใช่ READ/DELIVERED; การรับทราบเก็บแยกที่ NotificationRecipients/Acknowledgements',
    transitions: [
      t(['(new)'], 'ENQUEUE', ['SYSTEM'], ['QUEUED'], 'สร้างใน commit เดียวกับเหตุการณ์ต้นทาง; dedupe_key ไม่ซ้ำ', '-', false),
      t(['QUEUED', 'RETRY_WAIT'], 'CLAIM', ['SYSTEM'], ['PROCESSING'], 'ถึง next_attempt_at; claim ใต้ lock พร้อม lease', 'lease_until = now + lease', false),
      t(['PROCESSING'], 'PROVIDER_OK', ['SYSTEM'], ['PROVIDER_ACCEPTED'], 'HTTP 2xx หรือ LINE 409 (retry key เคยรับแล้ว)', 'NotificationAttempts', false),
      t(['PROCESSING'], 'RETRYABLE_FAILURE', ['SYSTEM'], ['RETRY_WAIT', 'FAILED_FINAL'], 'ผิดพลาดชั่วคราว; attempts < max', 'exponential backoff; LINE ใช้ retry key เดิมภายในอายุ key', false),
      t(['PROCESSING'], 'FINAL_FAILURE', ['SYSTEM'], ['FAILED_FINAL'], 'ผิดพลาดถาวร (4xx ที่ไม่ใช่ 409/429) หรือครบจำนวนครั้ง', 'แสดงใน dead-letter view', false),
      t(['PROCESSING'], 'LEASE_EXPIRED', ['SYSTEM'], ['RETRY_WAIT', 'FAILED_FINAL'], 'worker ตายระหว่างส่ง', 'LINE: retry ด้วย key เดิม; Email: FAILED_FINAL (OUTCOME_UNKNOWN) ไม่ส่งซ้ำอัตโนมัติ', false),
      t(['QUEUED', 'RETRY_WAIT'], 'CANCEL', ['SYSTEM', 'STUDENT_AFFAIRS'], ['CANCELLED'], 'ผู้รับหมดสิทธิ์/ยกเลิกช่องทาง หรือผู้ดูแลยกเลิก', 'บันทึกเหตุผล'),
      t(['FAILED_FINAL'], 'RESEND', ['STUDENT_AFFAIRS'], ['FAILED_FINAL'], 'ตรวจสิทธิ์ผู้รับอีกครั้ง', 'สร้าง outbox ใหม่ (resend_of_outbox_id) — เป็นการส่งใหม่ ไม่ใช่ retry เดิม'),
    ],
  },
  Import: {
    entity: 'ImportBatches.status',
    note_th: 'apply ทำเป็น job แบ่ง chunk ใช้ idempotency ต่อแถว รันซ้ำไม่สร้างข้อมูลซ้ำ',
    transitions: [
      t(['(new)'], 'UPLOAD', ['STUDENT_AFFAIRS'], ['UPLOADED'], 'ไฟล์ CSV/XLSX ขนาด/ชนิดถูกต้อง', '-'),
      t(['UPLOADED', 'PREVIEWED'], 'PREVIEW', ['STUDENT_AFFAIRS'], ['PREVIEWED'], 'mapping คอลัมน์', '-', false),
      t(['PREVIEWED', 'VALIDATED'], 'DRY_RUN', ['STUDENT_AFFAIRS'], ['VALIDATED'], 'ตรวจทุกแถว', 'ImportErrors; สรุปจะเพิ่ม/แก้/ข้าม/ขัดแย้ง'),
      t(['VALIDATED'], 'APPLY', ['STUDENT_AFFAIRS'], ['APPLYING'], 'dry-run ล่าสุดไม่มี error ร้ายแรง', 'สร้าง Job'),
      t(['APPLYING'], 'JOB_DONE', ['SYSTEM'], ['APPLIED', 'FAILED'], '-', 'สรุปผล'),
      t(['UPLOADED', 'PREVIEWED', 'VALIDATED'], 'CANCEL', ['STUDENT_AFFAIRS'], ['CANCELLED'], '-', '-'),
    ],
  },
  Migration: {
    entity: 'MigrationRuns.state',
    note_th: 'ห้าม READY_TO_CUTOVER/CUTOVER_READY หาก reconciliation ไม่ผ่าน; ห้าม dual-write',
    transitions: [
      t(['(new)'], 'PLAN', ['SYSTEM_ADMIN'], ['PLANNED'], 'migration.export', '-'),
      t(['PLANNED'], 'START_SNAPSHOT', ['SYSTEM_ADMIN'], ['SNAPSHOTTING'], 'FULL_SNAPSHOT ต้อง freeze ที่ server และไม่มี journal ค้าง', 'โหมดอ่านอย่างเดียว; บันทึก high-water marks'),
      t(['SNAPSHOTTING'], 'EXPORT_DONE', ['SYSTEM'], ['EXPORTED', 'FAILED'], 'ทุก chunk/attachment ครบและ checksum ถูก', 'manifest.json + manifest.sha256'),
      t(['EXPORTED'], 'VALIDATE', ['SYSTEM_ADMIN'], ['VALIDATED', 'FAILED'], 'validation ผ่านทั้งหมด (completeness = COMPLETE)', 'reports/validation.json'),
      t(['VALIDATED'], 'STAGE', ['SYSTEM_ADMIN'], ['STAGED', 'FAILED'], 'นำเข้าปลายทางใหม่/staging สำเร็จ', '-'),
      t(['STAGED'], 'RECONCILE', ['SYSTEM_ADMIN'], ['RECONCILED', 'FAILED'], 'reconciliation PASS ทุกหัวข้อ', 'reports/reconciliation.json'),
      t(['RECONCILED'], 'MARK_READY', ['SYSTEM_ADMIN'], ['CUTOVER_READY'], 'readiness checklist ครบ', '-'),
      t(['CUTOVER_READY'], 'CUTOVER', ['SYSTEM_ADMIN'], ['ACTIVE'], 'freeze ต้นทาง; snapshot/delta สุดท้าย reconcile ผ่าน', 'สลับ routing จุดเดียว; ระบบเดิม read-only'),
      t(['ACTIVE', 'CUTOVER_READY'], 'ROLLBACK', ['SYSTEM_ADMIN'], ['ROLLED_BACK'], 'ตามกรณีมี/ไม่มีข้อมูลใหม่หลัง cutover (RUNBOOK)', 'ไม่ทิ้งข้อมูลใหม่'),
      t(['PLANNED', 'SNAPSHOTTING', 'EXPORTED', 'VALIDATED', 'STAGED', 'RECONCILED', 'CUTOVER_READY'], 'CANCEL', ['SYSTEM_ADMIN'], ['CANCELLED'], '-', 'ปลด freeze ถ้าเป็น rehearsal'),
    ],
  },
});

/** Find the transition for (machine, from, action). Throws INVALID_STATE listing allowed actions. */
export function assertTransition(machineName, from, action) {
  const m = MACHINES[machineName];
  const fromKey = from == null ? '(new)' : from;
  const tr = m.transitions.find((x) => x.action === action && x.from.includes(fromKey));
  if (!tr) {
    const allowed = m.transitions.filter((x) => x.from.includes(fromKey)).map((x) => x.action);
    throw new AppError('INVALID_STATE', `${machineName}: ${action} not allowed from ${fromKey}`, {
      details: { status: fromKey, allowed_transitions: allowed },
      messageTh: 'ไม่สามารถทำรายการนี้ได้ในสถานะปัจจุบัน',
    });
  }
  return tr;
}

# State Machines

> สร้างอัตโนมัติจาก `src/domain/state-machines.js` — service ใช้ตารางเดียวกันนี้บังคับการเปลี่ยนสถานะ (`assertTransition`)

## Leave — `LeaveRequests.status`

สถานะรวมคำนวณจากสถานะผู้ปกครองยืนยัน (guardian_confirmation_status) และสถานะโรงเรียน (school_approval_status) ที่เก็บแยกกัน; DRAFT ใช้เก็บร่างที่หน้าจอ ไม่สร้างแถวในระยะแรก

| from | action | allowed role | precondition | to | audit | side effects |
|---|---|---|---|---|---|---|
| (new) | SUBMIT | GUARDIAN, STUDENT, HOMEROOM_TEACHER, STUDENT_AFFAIRS | leave.submit ตามขอบเขต; ทุกวันเป็นวันเรียนและมี enrollment; ไม่ซ้อนกับใบลาที่ยังมีผล; ย้อนหลังต้องมีเหตุผล | PENDING_GUARDIAN / PENDING_SCHOOL | ✔ | สร้าง LeaveSegments + LeaveRevisions; แจ้งผู้ปกครอง (ถ้าต้องยืนยัน) หรือผู้อนุมัติ |
| PENDING_GUARDIAN | GUARDIAN_CONFIRM | GUARDIAN | ผู้ปกครองที่มีสิทธิ์ CONFIRM_LEAVE ของนักเรียนคนนั้น | PENDING_SCHOOL | ✔ | บันทึก LeaveApprovals ขั้นผู้ปกครอง; แจ้งผู้อนุมัติ |
| PENDING_GUARDIAN | GUARDIAN_DECLINE | GUARDIAN | ผู้ปกครองที่มีสิทธิ์ CONFIRM_LEAVE | REJECTED | ✔ | segments → REJECTED; แจ้งผู้ยื่น |
| PENDING_SCHOOL | APPROVE | HOMEROOM_TEACHER, STUDENT_AFFAIRS | ผู้มีอำนาจตามเส้นทางอนุมัติ (หรือผู้รักษาการแทน/กิจการนักเรียน); expected_version ตรง | APPROVED | ✔ | segments → APPROVED; คำนวณ DailyAttendance ใหม่ทุกวันที่เกี่ยวข้อง; แจ้งผลผู้ยื่นและผู้ปกครอง |
| PENDING_SCHOOL | PARTIAL_APPROVE | HOMEROOM_TEACHER, STUDENT_AFFAIRS | ระบุผลทุก segment; มีอย่างน้อยหนึ่งอนุมัติและหนึ่งไม่อนุมัติ | PARTIALLY_APPROVED | ✔ | เหมือน APPROVE เฉพาะช่วงที่อนุมัติ |
| PENDING_SCHOOL | REJECT | HOMEROOM_TEACHER, STUDENT_AFFAIRS | ต้องมีเหตุผล | REJECTED | ✔ | segments → REJECTED; แจ้งผล |
| PENDING_GUARDIAN, PENDING_SCHOOL | RETURN | HOMEROOM_TEACHER, STUDENT_AFFAIRS | ต้องมีเหตุผลที่ส่งกลับ | RETURNED | ✔ | แจ้งผู้ยื่นให้แก้ไข |
| RETURNED | RESUBMIT | GUARDIAN, STUDENT, HOMEROOM_TEACHER, STUDENT_AFFAIRS | ผู้ยื่นเดิม; ตรวจซ้อน/วันเรียนใหม่ | PENDING_GUARDIAN / PENDING_SCHOOL | ✔ | revision_no + 1; segments ใหม่แทนชุดเดิม (ชุดเดิมเป็น WITHDRAWN) |
| PENDING_GUARDIAN, PENDING_SCHOOL, RETURNED | WITHDRAW | GUARDIAN, STUDENT, HOMEROOM_TEACHER, STUDENT_AFFAIRS | ผู้ยื่นเดิม หรือกิจการนักเรียน | WITHDRAWN | ✔ | segments → WITHDRAWN |
| APPROVED, PARTIALLY_APPROVED | CANCEL_REQUEST | GUARDIAN, STUDENT, HOMEROOM_TEACHER | ต้องมีเหตุผล | CANCELLATION_REQUESTED | ✔ | แจ้งผู้อนุมัติ |
| APPROVED, PARTIALLY_APPROVED, CANCELLATION_REQUESTED | CANCEL_APPROVE | HOMEROOM_TEACHER, STUDENT_AFFAIRS | ต้องมีเหตุผล; ยกเลิกโดยตรงได้เฉพาะผู้มีอำนาจ | CANCELLED | ✔ | segments ที่อนุมัติ → CANCELLED; คำนวณ DailyAttendance ใหม่; แจ้งผู้เกี่ยวข้อง |
| CANCELLATION_REQUESTED | CANCEL_REJECT | HOMEROOM_TEACHER, STUDENT_AFFAIRS | ต้องมีเหตุผล | APPROVED / PARTIALLY_APPROVED | ✔ | คืนสถานะเดิมตาม segments |
| PENDING_GUARDIAN, PENDING_SCHOOL | REROUTE | STUDENT_AFFAIRS | ผู้พิจารณาไม่อยู่/ต้องเปลี่ยนเส้นทาง | PENDING_GUARDIAN / PENDING_SCHOOL | ✔ | เปลี่ยน current_approver_role/user; บันทึก revision |

## AttendanceDay — `DailyAttendance.presence_status (projection) / RollCallSessions.status`

สถานะรายวันเป็น projection จากเหตุการณ์ ไม่มีการตั้งค่าโดยตรง; การไม่มีรายการไม่ใช่การขาด

| from | action | allowed role | precondition | to | audit | side effects |
|---|---|---|---|---|---|---|
| (new) | GATE_ARRIVAL | DUTY_TEACHER, GATE_STAFF, STUDENT_AFFAIRS | ระบุตัวนักเรียนแล้ว; สแกนซ้ำคืนผลเดิม | PRESENT | ✔ | ประเมินสายตามกฎวันนั้น; แจ้งผู้ปกครองเมื่อสาย |
| (new), UNKNOWN | ROLL_CALL_SUBMIT | HOMEROOM_TEACHER, STUDENT_AFFAIRS | รายชื่อตาม enrollment ของวันนั้น | PRESENT / UNKNOWN | ✔ | นักเรียนที่ไม่ได้ทำเครื่องหมายยกเว้น = มา (ROLL_CALL); ไม่พบตัว = ยังรอตรวจสอบ |
| UNKNOWN | VERIFY_ABSENCE | HOMEROOM_TEACHER, STUDENT_AFFAIRS | ไม่มีหลักฐานการมา/ลา และครูยืนยัน | ABSENT_CONFIRMED | ✔ | ABSENCE_CONFIRMED event; แจ้งผู้ปกครอง "ขาดเรียน" หลังยืนยันเท่านั้น |
| PRESENT, ABSENT_CONFIRMED, UNKNOWN | CORRECT | HOMEROOM_TEACHER, STUDENT_AFFAIRS | มีเหตุผล; expected version | PRESENT / ABSENT_CONFIRMED / UNKNOWN / ON_LEAVE_FULL_DAY | ✔ | event ใหม่ supersedes เดิม; คำนวณใหม่; แจ้งการแก้ไขเฉพาะผู้ได้รับผลกระทบ |
| UNKNOWN, PRESENT | LEAVE_APPROVED | HOMEROOM_TEACHER, STUDENT_AFFAIRS | ใบลาอนุมัติ | ON_LEAVE_FULL_DAY / PRESENT | ✔ | ถ้ามีการมาจริงด้วย สถานะ PRESENT + conflict + ReconciliationTask (คงคำอนุมัติไว้) |

## Case — `Cases.status`

กันเปิดซ้ำด้วย dedupe_key + cooldown; ปิดแล้วเปิดใหม่ได้ตามสิทธิ์

| from | action | allowed role | precondition | to | audit | side effects |
|---|---|---|---|---|---|---|
| (new) | OPEN | STUDENT_AFFAIRS, HOMEROOM_TEACHER, SYSTEM | กฎเข้าเงื่อนไขพร้อมหลักฐาน หรือครูเปิดเอง; ไม่มีเรื่องเปิดอยู่ที่ dedupe_key เดียวกัน และพ้น cooldown | OPEN | ✔ | แจ้งเจ้าของเรื่อง (CASE_NEW) |
| OPEN, IN_PROGRESS, WAITING_RESPONSE | ASSIGN | STUDENT_AFFAIRS, HOMEROOM_TEACHER | ผู้รับต้องมีสิทธิ์ case.manage ต่อนักเรียน | OPEN / IN_PROGRESS / WAITING_RESPONSE | ✔ | CaseEvents ASSIGNED/TRANSFERRED; แจ้งผู้รับ |
| OPEN, WAITING_RESPONSE | RECORD_CONTACT | STUDENT_AFFAIRS, HOMEROOM_TEACHER | บันทึกผลการติดต่อจริง | IN_PROGRESS / WAITING_RESPONSE | ✔ | ContactLogs + CaseEvents |
| OPEN, IN_PROGRESS, WAITING_RESPONSE | RESOLVE | STUDENT_AFFAIRS, HOMEROOM_TEACHER | มีข้อสรุป | RESOLVED | ✔ | CaseEvents |
| OPEN, IN_PROGRESS, WAITING_RESPONSE, RESOLVED | CLOSE | STUDENT_AFFAIRS, HOMEROOM_TEACHER | ต้องมี resolution_summary | CLOSED | ✔ | ตั้ง cooldown_until ตามกฎ |
| CLOSED, RESOLVED | REOPEN | STUDENT_AFFAIRS, HOMEROOM_TEACHER | ต้องมีเหตุผล | OPEN | ✔ | reopened_count + 1 |

## Outbox — `NotificationOutbox.delivery_state`

PROVIDER_ACCEPTED ไม่ใช่ READ/DELIVERED; การรับทราบเก็บแยกที่ NotificationRecipients/Acknowledgements

| from | action | allowed role | precondition | to | audit | side effects |
|---|---|---|---|---|---|---|
| (new) | ENQUEUE | SYSTEM | สร้างใน commit เดียวกับเหตุการณ์ต้นทาง; dedupe_key ไม่ซ้ำ | QUEUED | attempt log | - |
| QUEUED, RETRY_WAIT | CLAIM | SYSTEM | ถึง next_attempt_at; claim ใต้ lock พร้อม lease | PROCESSING | attempt log | lease_until = now + lease |
| PROCESSING | PROVIDER_OK | SYSTEM | HTTP 2xx หรือ LINE 409 (retry key เคยรับแล้ว) | PROVIDER_ACCEPTED | attempt log | NotificationAttempts |
| PROCESSING | RETRYABLE_FAILURE | SYSTEM | ผิดพลาดชั่วคราว; attempts < max | RETRY_WAIT / FAILED_FINAL | attempt log | exponential backoff; LINE ใช้ retry key เดิมภายในอายุ key |
| PROCESSING | FINAL_FAILURE | SYSTEM | ผิดพลาดถาวร (4xx ที่ไม่ใช่ 409/429) หรือครบจำนวนครั้ง | FAILED_FINAL | attempt log | แสดงใน dead-letter view |
| PROCESSING | LEASE_EXPIRED | SYSTEM | worker ตายระหว่างส่ง | RETRY_WAIT / FAILED_FINAL | attempt log | LINE: retry ด้วย key เดิม; Email: FAILED_FINAL (OUTCOME_UNKNOWN) ไม่ส่งซ้ำอัตโนมัติ |
| QUEUED, RETRY_WAIT | CANCEL | SYSTEM, STUDENT_AFFAIRS | ผู้รับหมดสิทธิ์/ยกเลิกช่องทาง หรือผู้ดูแลยกเลิก | CANCELLED | ✔ | บันทึกเหตุผล |
| FAILED_FINAL | RESEND | STUDENT_AFFAIRS | ตรวจสิทธิ์ผู้รับอีกครั้ง | FAILED_FINAL | ✔ | สร้าง outbox ใหม่ (resend_of_outbox_id) — เป็นการส่งใหม่ ไม่ใช่ retry เดิม |

## Import — `ImportBatches.status`

apply ทำเป็น job แบ่ง chunk ใช้ idempotency ต่อแถว รันซ้ำไม่สร้างข้อมูลซ้ำ

| from | action | allowed role | precondition | to | audit | side effects |
|---|---|---|---|---|---|---|
| (new) | UPLOAD | STUDENT_AFFAIRS | ไฟล์ CSV/XLSX ขนาด/ชนิดถูกต้อง | UPLOADED | ✔ | - |
| UPLOADED, PREVIEWED | PREVIEW | STUDENT_AFFAIRS | mapping คอลัมน์ | PREVIEWED | attempt log | - |
| PREVIEWED, VALIDATED | DRY_RUN | STUDENT_AFFAIRS | ตรวจทุกแถว | VALIDATED | ✔ | ImportErrors; สรุปจะเพิ่ม/แก้/ข้าม/ขัดแย้ง |
| VALIDATED | APPLY | STUDENT_AFFAIRS | dry-run ล่าสุดไม่มี error ร้ายแรง | APPLYING | ✔ | สร้าง Job |
| APPLYING | JOB_DONE | SYSTEM | - | APPLIED / FAILED | ✔ | สรุปผล |
| UPLOADED, PREVIEWED, VALIDATED | CANCEL | STUDENT_AFFAIRS | - | CANCELLED | ✔ | - |

## Migration — `MigrationRuns.state`

ห้าม READY_TO_CUTOVER/CUTOVER_READY หาก reconciliation ไม่ผ่าน; ห้าม dual-write

| from | action | allowed role | precondition | to | audit | side effects |
|---|---|---|---|---|---|---|
| (new) | PLAN | SYSTEM_ADMIN | migration.export | PLANNED | ✔ | - |
| PLANNED | START_SNAPSHOT | SYSTEM_ADMIN | FULL_SNAPSHOT ต้อง freeze ที่ server และไม่มี journal ค้าง | SNAPSHOTTING | ✔ | โหมดอ่านอย่างเดียว; บันทึก high-water marks |
| SNAPSHOTTING | EXPORT_DONE | SYSTEM | ทุก chunk/attachment ครบและ checksum ถูก | EXPORTED / FAILED | ✔ | manifest.json + manifest.sha256 |
| EXPORTED | VALIDATE | SYSTEM_ADMIN | validation ผ่านทั้งหมด (completeness = COMPLETE) | VALIDATED / FAILED | ✔ | reports/validation.json |
| VALIDATED | STAGE | SYSTEM_ADMIN | นำเข้าปลายทางใหม่/staging สำเร็จ | STAGED / FAILED | ✔ | - |
| STAGED | RECONCILE | SYSTEM_ADMIN | reconciliation PASS ทุกหัวข้อ | RECONCILED / FAILED | ✔ | reports/reconciliation.json |
| RECONCILED | MARK_READY | SYSTEM_ADMIN | readiness checklist ครบ | CUTOVER_READY | ✔ | - |
| CUTOVER_READY | CUTOVER | SYSTEM_ADMIN | freeze ต้นทาง; snapshot/delta สุดท้าย reconcile ผ่าน | ACTIVE | ✔ | สลับ routing จุดเดียว; ระบบเดิม read-only |
| ACTIVE, CUTOVER_READY | ROLLBACK | SYSTEM_ADMIN | ตามกรณีมี/ไม่มีข้อมูลใหม่หลัง cutover (RUNBOOK) | ROLLED_BACK | ✔ | ไม่ทิ้งข้อมูลใหม่ |
| PLANNED, SNAPSHOTTING, EXPORTED, VALIDATED, STAGED, RECONCILED, CUTOVER_READY | CANCEL | SYSTEM_ADMIN | - | CANCELLED | ✔ | ปลด freeze ถ้าเป็น rehearsal |

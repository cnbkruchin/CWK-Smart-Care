# CHANGELOG

บันทึกการเปลี่ยนแปลงที่มีผลต่อ schema / API contract / portable format (Semantic: schema_version เพิ่มเมื่อโครงสร้างข้อมูลเปลี่ยน)

## [Unreleased]

### ชุดที่ 4 — Follow-up, outbox, email/LINE, gateway (2026-10-11) — version 0.4.0

- schema_version 1 (ยังไม่ release): lookup/index เพิ่ม `NotificationOutbox.delivery_state`, `NotificationRecipients.ack_state`, `ContactLogs.direction`, `ContactLogs.supersedes_id`, `WebhookInbox.status`; คำอธิบาย `ContactLogs.supersedes_id` ครอบคลุมการปิดรายการติดต่อเข้า; state machine Case: RECORD_CONTACT จาก IN_PROGRESS ได้
- API v1: +23 operations (รวม 111) — case.*, contact.log/inbox, appointment.*, notification.list/markRead/acknowledge/monitor/resend/cancel, channel.status/startLineLink/unbind/revokeForUser
- jobs/ticks: `followup.evaluateDate`, `followup.schedule` (ประเมินรายวัน, เกินกำหนด, หมดเวลารับทราบ), `webhook.retry`, `outbox.dispatch`
- GAS: MailApp + LINE Messaging API providers, doPost รับเฉพาะ envelope ที่ลงลายเซ็น; Script Property ใหม่ `CWK_LINE_ADD_FRIEND_URL`; Settings เริ่มต้นใหม่ `followup.evaluate_time`, `attendance.rollcall_backdate_days`
- gateway 0.4.0 (Node 22, firebase-admin 14.4.0): `/line/webhook`, `/v1/identity/verify`, `/v1/identity/revoke`, `/healthz`
- หน้าจอ: งานติดตามและการติดต่อ, การแจ้งเตือน (+ เชื่อม LINE), ติดตามการส่งแจ้งเตือน

### ชุดที่ 3 — Daily workflows (2026-10-10) — version 0.3.0

- schema_version 1 (ยังไม่ release — ยังไม่มีการติดตั้งจริง จึงแก้ `0001_init.sql` โดยตรง): lookup/index ใหม่ `AttendanceEvents (student_id, school_date, dedupe_key)` และ `LeaveSegments (leave_request_id, student_id, school_date)`
- API v1: +31 operations (รวม 88) — attendance (lookupForGate, recordArrival, syncOffline, stationLog, rollcall.get/submit, verifyDay, correct, requestCorrection, decideCorrection, exempt, reconciliation.list/resolve, classDay), leave (submit, confirmGuardian, decide, resubmit, withdraw, requestCancel, decideCancel, reroute, addAttachment, get, list, inbox), attachment.download, student.setPhoto/photo, student.profile, dashboard.summary
- jobs: attendance.openDay, attendance.recomputeStudent, attendance.recomputeDate, attendance.unknownCheck + tick `attendance.schedule`
- พฤติกรรม: config cache ล้างอัตโนมัติเมื่อ commit แตะตารางตั้งค่า; การพิจารณาคำขอแก้ไขปิดงานตรวจสอบที่เกี่ยวข้องอัตโนมัติ
- หน้าจอ: ภาพรวมวันนี้, ลงเวลาหน้าประตู (+ ออฟไลน์), เช็กชื่อประจำวัน, แจ้งลา, พิจารณาใบลา, ประวัตินักเรียน
- ทดสอบ: `tests/ui/ui-smoke.mjs` (`npm run test:ui`, Chromium) และ GasSim รองรับเวลาคงที่ (`now`)

### ชุดที่ 2 — Data foundation (2026-10-10)

- schema_version 1 (ยังไม่ release): เพิ่ม `Guardians.external_ref` (unique ต่อโรงเรียน) และ `ImportErrors.attempt_no`
- API v1: 57 operations (auth, users/roles/assignments/invitations, students/classes/enrollments/guardians/contacts, settings/rules/calendar/periods/stations/terms, system/jobs, imports)
- Sheets adapter: MutationJournal redo log, ScriptLock, StorageCatalog partitions (Ops/Daily/Notify ต่อภาคเรียน)
- gas-dist: Code.js + Entrypoints.js (10 public functions) + App.html + appsscript.json

### ชุดที่ 1 — Foundation (2026-10-10)

- schema_version **1**: 56 ตาราง (Configuration, Identity, Student, Attendance, Leave, Follow-up, Files, Notifications, Operations) จาก `src/schema/tables.js`
- Partition ต่อภาคเรียน: Ops / Daily / Notify workbooks (DECISIONS D-005)
- Permission matrix v1 (`src/domain/permissions.js`) — 53 actions × 9 roles (166 grants)
- State machines: Leave, AttendanceDay, Case, Outbox, Import, Migration
- PostgreSQL migration `0001_init.sql` + `roles.sql` (generated)

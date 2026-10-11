# CHANGELOG

บันทึกการเปลี่ยนแปลงที่มีผลต่อ schema / API contract / portable format (Semantic: schema_version เพิ่มเมื่อโครงสร้างข้อมูลเปลี่ยน)

## [Unreleased]

### ชุดที่ 8 — ตรวจรับขั้นสุดท้าย (2026-10-11) — version 0.8.0

- **งานล้างไฟล์กำพร้า** `files.cleanupOrphans` (tick `files.schedule`, Settings ใหม่ `files.cleanup_time` 02:30): Attachments ที่ STAGED ไม่ถูกผูกเกิน 24 ชม. → DELETED; ย้ายไฟล์ที่ผูกแล้วออกจาก `staging/`; ลบ object ที่ไม่มีแถวอ้างถึง (Drive = ถังขยะ); ไม่ทำงานขณะ READ_ONLY (D-038) — ชุดก่อนหน้ามีเพียงคอมเมนต์ที่อ้างว่ามีงานนี้
- storage port (ไม่บังคับ): `listStaged`, `isStaged`, `promote` บน Drive/memory, `listStaged` บน filesystem; PgStore `onLockWait` (สังเกต lock wait)
- schema_version 1 (ไม่เปลี่ยนโครงสร้าง); API v1 ไม่เปลี่ยน (139 operations); public GAS functions 13
- ทดสอบใหม่: identity-gateway (GAS verifier ↔ gateway จริง: token หมดอายุ/ถูกเพิกถอน/ระงับ/ผิด project/tenant, คำตอบปลอม), jobs (resume, lease หมดอายุ, quota backoff, quota ระหว่างคำขอไม่บันทึก), files (ล้างไฟล์กำพร้า memory + Drive บน emulator), execute-as-owner ไม่ใช้ตัวตนเจ้าของ
- `tools/load-test.mjs` (`npm run load`): memory / REST+PostgreSQL / gas-emulator — ผลใน docs/LOAD_TEST_TH.md (พบคอขวด: แดชบอร์ดทั้งโรงเรียน)
- เอกสาร: docs/UAT_CHECKLIST_TH.md, docs/LIMITATIONS.md, docs/TEST_MATRIX.md, docs/LOAD_TEST_TH.md, docs/DELIVERY_INVENTORY.md, README_TH (ขอบเขตที่เสร็จ), ARCHITECTURE §3.4, THREAT_MODEL T8, DECISIONS D-038

### ชุดที่ 7 — Platform upgrade reference (2026-10-11) — version 0.7.0

- **REST backend อ้างอิง** `future-platform/api` (Node 22, `pg` 8.23.1, `firebase-admin` 14.4.0): `POST /v1/rpc`, `POST /v1/ops/{operation}` (Idempotency-Key, If-Match, X-Request-Id), `POST /v1/webhook/line` (ปิดจนมี LINE provider บน Node), `GET /healthz`, `GET /readyz`; HTTP status ตามรหัสข้อผิดพลาด (API_CONTRACT.md, `x-cwk-http-status` ใน openapi.yaml); CORS allowlist; worker (tick + jobs, advisory lock); admin CLI `init-db/bootstrap/seed-demo/set-mode/status/export-delta`; Dockerfile + docker-compose profile `api`
- **PostgreSQL adapter** `src/adapters/postgres` (PgStore): transaction ต่อ commit, version check, ChangeLog seq ต่อเนื่อง, idempotency, READ_ONLY ในฐานข้อมูล (Settings `system.mode`), partition เชิงตรรกะของตาราง TERM; contract test ชุดเดียวกับ memory store
- **DDL schema v1 (ยังไม่ release, schema_version ยังเป็น 1):** FK ทุกตัวใน `0001_init.sql` เป็น `DEFERRABLE INITIALLY DEFERRED` — ฐานข้อมูลที่ใช้ซ้อมจากชุดที่ 6 ให้สร้างใหม่ (ยังไม่มีฐาน PostgreSQL ใช้งานจริง)
- **GAS `HttpApiAdapter`** (ขั้นที่ 2): Script Properties `CWK_SERVICE_BACKEND=REST` + `CWK_REST_BASE_URL`; `rpc`/`doGet` ส่งต่อไป backend พร้อม credential ใน Authorization, `doPost` ตอบ WEBHOOK_DISABLED, `cronTick` ไม่ทำงาน, `admin*` ที่แตะ Sheets ปฏิเสธ — public functions ยังเป็น 13 ตัว
- **เว็บรุ่นเริ่มต้น** `future-platform/web` (ขั้นที่ 3): เข้าสู่ระบบ (Firebase REST / DEMO), เปิดใช้งานบัญชี, ค้นหานักเรียน, หน้ารายบุคคล, ลงเวลามาเรียน; รายการหน้าที่ต้องย้ายต่อใน README_TH.md
- frontend เดิม: รับ `auth_mode` `FIREBASE` (ตัวตนตรวจที่ REST backend) เหมือน `GATEWAY`
- `.env.example`: ตัวแปร API ใหม่ (`API_AUTH_MODE=FIREBASE|DEMO`, `API_DEMO_PASSPHRASE`, `FIREBASE_WEB_API_KEY`, …) แทน `DEV_HMAC`
- ทดสอบ: tests/contract, tests/api (PostgreSQL จริง), tests/api/gas-http-adapter (gas-dist บน emulator → API จริง), tests/ui/web-starter-smoke (Chromium); `npm run test:pg` รวม contract + api, `npm run test:web` ใหม่
- เอกสาร: docs/REST_BACKEND_TH.md, ARCHITECTURE §2/§4/§6.2, DECISIONS D-032–D-037, THREAT_MODEL T13–T15, MIGRATION_RUNBOOK (นำเข้า REST, ย้อนกลับด้วย `export-delta`)

### ชุดที่ 6 — Portable migration (2026-10-11) — version 0.6.0

- **portable format v1** (docs/PORTABLE_FORMAT.md, schema/portable/*.schema.json): manifest + manifest.sha256, JSONL canonical ต่อตาราง/partition/chunk, CSV สำหรับคน, ไฟล์แนบ bytes จริง + attachment-index.jsonl, metadata (config ที่ไม่ลับ, storage mapping, archive partitions, rule versions, ยอดรายงานตัวอย่าง, สิทธิ์ตัวอย่าง), schema/, docs/; table digest = ผลรวม SHA-256 mod 2²⁵⁶ (แยก source/derived); ไม่ส่งออก MutationJournal/IdempotencyRecords/StorageCatalog/StorageObjectMappings/SchemaVersions; transforms: redact คำเชิญ, ล้าง nonce LINE, `replay_blocked` ให้ outbox ที่ยังไม่ส่ง
- schema_version 1 (ไม่เปลี่ยนโครงสร้าง): ใช้ `MigrationRuns`, `MigrationCheckpoints` ที่มีอยู่; Settings key ใหม่ `migration.cutover_active`
- API v1: +14 operations (รวม 139) — migration.inventory/startExport/runs/get/packageDoc/pause/resume/cancel/validate/recordEvidence/checklist/markReady/cutover/rollback; `system.setMode` ปฏิเสธ NORMAL ขณะ cutover ACTIVE
- jobs: `migration.export` (freeze + high-water mark + พิสูจน์ความสอดคล้อง + checkpoint), `migration.validate`; job handler ขอ "พักงาน" ได้ (`{pause: true}` → PAUSED)
- GAS: public function ใหม่ `adminImportPackage`, `adminApplyDelta` (รวม 13); Script Properties `CWK_IMPORT_PACKAGE_FOLDER_ID`, `CWK_DELTA_PACKAGE_FOLDER_ID`, `CWK_DELTA_MODE`; cronTick ในโหมด READ_ONLY รันเฉพาะงานบำรุงรักษา (`tasksForMode`)
- CLI `tools/migrate.mjs` (validate/plan/import --dry-run/--apply/reconcile/pack) + staging schema ใน PostgreSQL + merge transaction เดียว; อ่าน `MIGRATION_DATABASE_URL`/`DATABASE_URL` จาก environment เท่านั้น; exit codes 0/1/2/3/4/5/6/10; `tools/rehearse-postgres.mjs`, `tools/fixtures/generate-synthetic.mjs`, `docker-compose.yml`
- **แก้ข้อบกพร่อง (D-031):** การอ่านฝั่ง server ที่ขอ `limit ≥ 1000` ถูกตัดเงียบ ๆ ที่ 500 แถว → `listAll()` (all/cursor) ในรายงาน R03/R05/R06/R08/R09/R11, งานเกินกำหนด, monitor แจ้งเตือน, health, retention, backup manifest
- หน้าจอ: ศูนย์ส่งออกและย้ายข้อมูล
- เอกสาร: PORTABLE_FORMAT, MIGRATION_RUNBOOK_TH, THREAT_MODEL T12, DECISIONS D-026–D-031

### ชุดที่ 5 — รายงานและงานปฏิบัติการ (2026-10-11) — version 0.5.0

- schema_version 1 (ไม่เปลี่ยนโครงสร้าง): ใช้ `ReportRuns`, `BackupRuns`, `OperationMetrics` ที่มีอยู่แล้ว; Settings เริ่มต้นใหม่ `backup.nightly_time` (01:30), `backup.retention_days` (30)
- API v1: +14 operations (รวม 125) — report.catalog/preview/run/rerun/runs/download/lock, backup.list/run/recordRestoreTest, system.metrics, retention.preview/purge/purgeJobs
- jobs/ticks: `report.render`, `backup.snapshot`, tick `ops.schedule` (flush metrics ทุก tick, สำรองประจำคืนวันละครั้ง)
- รายงาน R01–R12 (นิยามใน docs/REPORTS_TH.md): ดูบนจอ, CSV (UTF-8 BOM, CRLF, กันสูตร), XLSX (Drive export จริง), PDF (Docs template + หัวตารางซ้ำทุกหน้า); ล็อก + revision; ดาวน์โหลดตรวจสิทธิ์ + checksum + audit
- GAS: public function ใหม่ `adminRestoreSnapshot` (รวม 11) + Script Property `CWK_RESTORE_FROM_FOLDER_ID`; `adminSetup` สร้างแม่แบบรายงาน (`CWK_REPORT_TEMPLATE_DOC_ID`)
- System health: jobs.heartbeat, backup.recent, backup.restore_tested, outbox.queue_age
- หน้าจอ: รายงาน; สถานะระบบเพิ่ม metrics, การสำรองข้อมูล (สำรองทันที, บันทึกผลทดสอบ restore), ระยะเวลาเก็บบันทึกระบบ
- เอกสาร: THREAT_MODEL.md, docs/OPERATIONS_TH.md, docs/REPORTS_TH.md, docs/PRIVACY_NOTICE_DRAFT_TH.md (ร่าง), DECISIONS D-023–D-025

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

# BUILD_STATE — CWK Smart Care

| รายการ | ค่า |
|---|---|
| project version | 0.5.0 (ยังไม่ใช่ release) · gateway 0.4.0 (ไม่เปลี่ยนในชุดที่ 5) |
| schema version | 1 (`src/schema/tables.js`, 56 ตาราง) |
| API version | v1 (125 operations ใน allowlist) · public GAS functions 11 |
| prompt version | MASTER_PROMPT 1.0 (2026-10-10) |
| ชุดล่าสุดที่ส่งมอบ | ชุดที่ 5 — รายงานและงานปฏิบัติการ (สำรอง/restore, metrics, retention, security) |
| อัปเดตล่าสุด | 2026-10-11 |

## สมมติฐาน (แยกจากข้อมูลจริง)

| หัวข้อ | สมมติฐานที่ใช้พัฒนา | สถานะ |
|---|---|---|
| จำนวนนักเรียน | 1,500 คน (ประเมินขนาด) / ข้อมูลสังเคราะห์ใน demo | **สมมติ** |
| เวลาเริ่มสาย | 08:00 grace 0 (`is_example=true`) | **ต้องกำหนดก่อน production** — PROD health = FAIL และ Dashboard เตือนจนกว่าเปลี่ยน |
| เส้นทางอนุมัติใบลา | ≤3 วันเรียน → ครูที่ปรึกษา, ≥4 วัน/กิจกรรมโรงเรียน → กิจการนักเรียน; นักเรียนยื่นต้องให้ผู้ปกครองยืนยัน; ย้อนหลังได้ 7 วัน; ลาป่วย ≥3 วันต้องแนบเอกสาร | **ค่าตัวอย่าง** ต้องให้โรงเรียนกำหนด |
| ยืนยันขาด | เปิดงานตรวจสอบหลัง 10:00; แจ้งผู้ปกครองเมื่อครูยืนยัน | **ค่าตัวอย่าง** |
| เช็กชื่อย้อนหลัง | 3 วัน (`attendance.rollcall_backdate_days`) | ค่าเริ่มต้น ปรับได้ |
| เกณฑ์ติดตาม | สาย 3 ครั้ง/30 วันเรียน (cooldown 10), ขาดยืนยัน 3 ครั้ง/30 วันเรียน; ประเมิน 16:30 | **ค่าตัวอย่าง** ต้องให้โรงเรียนกำหนด |
| สำรองข้อมูล | ทุกคืน 01:30 (`backup.nightly_time`), เก็บ 30 วัน (`backup.retention_days`) | ค่าเริ่มต้น ปรับได้ — โรงเรียนกำหนดระยะเก็บจริง |
| ระยะเก็บบันทึกระบบ | IdempotencyRecords/MutationJournal 30 วัน, WebhookInbox 90, OperationMetrics/NotificationAttempts 365 (นับจากสิ้นภาคเรียน), Jobs ที่จบแล้ว 90 วัน | ค่าเริ่มต้นในโค้ด (D-025) |
| ระยะเก็บข้อมูลส่วนบุคคล/ไฟล์แนบ | ไม่ลบอัตโนมัติ | **ต้องให้โรงเรียนอนุมัตินโยบาย** (workflow ลบยังไม่ส่งมอบ) |
| ประกาศความเป็นส่วนตัว | ร่างใน docs/PRIVACY_NOTICE_DRAFT_TH.md | **ร่าง** — โรงเรียนต้องตรวจและอนุมัติ |
| นโยบายแจ้งเตือน | งดส่ง 21:00–06:00; ขาดเรียน/งานติดตามใหม่ต้องรับทราบใน 24 ชม.; ส่งสูงสุด 6 ครั้ง; ช่องทางต่อประเภทตาม `NOTIFICATION_POLICY` | **ค่าตัวอย่าง** |
| อายุ LINE retry key | 12 ชั่วโมง (`CWK_LINE_RETRY_WINDOW_HOURS`) | **ยังไม่ยืนยันจากหน้าเอกสาร LINE โดยตรง** ผู้ติดตั้งต้องตรวจ |
| โดเมน/บัญชี/Firebase/LINE | example.com, ค่าตัวอย่าง | ตั้งในขั้นติดตั้ง |
| เบอร์โทรสังเคราะห์ | `+999…` (รหัสประเทศสงวน ไม่ใช่เบอร์จริง) | ใช้เฉพาะ DEV/STAGING |

## Architecture decisions

DECISIONS.md D-001…D-025 (ชุดที่ 5 เพิ่ม D-023 รายงานบนจอ vs ฉบับไฟล์/ล็อก/revision, D-024 snapshot + restore ไป environment ใหม่เท่านั้น, D-025 retention เฉพาะบันทึกระบบ; ชุดที่ 4 เพิ่ม D-020 กฎติดตาม/กันซ้ำ/เปิดใหม่, D-021 การส่งออกใน DEV/STAGING, D-022 ข้อความเข้าและปุ่มตอบกลับทาง LINE; ชุดที่ 3: รายละเอียด implement: DailyAttendance เป็น projection ที่คำนวณใหม่ใน changeset เดียวกับเหตุการณ์, การแก้ไขเป็นเหตุการณ์ใหม่ที่ supersede ของเดิม, config cache ล้างอัตโนมัติเมื่อ commit แตะตารางตั้งค่า)

## File inventory

| path | สถานะ |
|---|---|
| ชุดที่ 1–2 ทั้งหมด | ✔ |
| `src/application/services/` attendance-core (computeDay/preloadDay/refreshDay/conflict tasks), notify (ผู้รับจากความสัมพันธ์ที่ยืนยันเท่านั้น), templates | ✔ ชุดที่ 3 |
| `src/application/ops/attendance.js` lookupForGate, recordArrival, syncOffline, stationLog, rollcall.get/submit, verifyDay, correct, requestCorrection, decideCorrection, exempt, reconciliation.list/resolve, classDay | ✔ ชุดที่ 3 |
| `src/application/ops/leave.js` submit, confirmGuardian, decide, resubmit, withdraw, requestCancel, decideCancel, reroute, addAttachment, get, list, inbox | ✔ ชุดที่ 3 |
| `src/application/ops/attachments.js` attachment.download, student.setPhoto, student.photo | ✔ ชุดที่ 3 |
| `src/application/ops/profile.js` student.profile, dashboard.summary | ✔ ชุดที่ 3 |
| `src/application/jobs/attendance-jobs.js` openDay, recomputeStudent, recomputeDate, unknownCheck + tick `attendance.schedule` | ✔ ชุดที่ 3 |
| `frontend/src/screens/` dashboard, gate, rollcall, leave, leave-detail, approvals, profile (+ extra.js routes) | ✔ ชุดที่ 3 |
| `frontend/src/offline.js` (IndexedDB คิวลงเวลาออฟไลน์ ≤ 24 ชม.), `frontend/src/lib/dates.js` (วันที่ตามเขตเวลาโรงเรียน) | ✔ ชุดที่ 3 |
| `gas-dist/` Code.js (~763 KB), Entrypoints.js (11 public functions), App.html (~250 KB), appsscript.json, BUILD_INFO.json | ✔ built (`npm run build`) |
| `tests/application/daily.test.mjs` (16 tests), `tests/gas/gas-runtime.test.mjs` (+ daily flows on Sheets), `tests/ui/ui-smoke.mjs` (Chromium) | ✔ ชุดที่ 3 |
| `docs/USER_GUIDE_DAILY_TH.md` | ✔ ชุดที่ 3 |
| `src/domain/followup.js` (นับตามกฎ, หน้าต่างวันเรียน, cooldown) | ✔ ชุดที่ 4 |
| `src/application/services/followup.js`, `services/ack.js` | ✔ ชุดที่ 4 |
| `src/application/ops/followup.js` case.list/get/create/update/assign/assignable/resolve/close/reopen, contact.log, contact.inbox, appointment.create/update | ✔ ชุดที่ 4 |
| `src/application/ops/notifications.js` notification.list/markRead/acknowledge/monitor/resend/cancel, channel.status/startLineLink/unbind/revokeForUser | ✔ ชุดที่ 4 |
| `src/application/outbox/` worker (claim/lease/backoff/quiet hours/allowlist/eligibility re-check/recovery), compose (อีเมล, LINE + postback) | ✔ ชุดที่ 4 |
| `src/application/webhook/line-webhook.js` (ตรวจ envelope, WebhookInbox dedupe, follow/accountLink/postback/message/unfollow, retry tick) | ✔ ชุดที่ 4 |
| `src/application/jobs/followup-jobs.js` (followup.evaluateDate, tick: ประเมินรายวัน, เกินกำหนด, หมดเวลารับทราบ) | ✔ ชุดที่ 4 |
| `src/adapters/gas/providers.js` (MailApp, LINE Messaging API ผ่าน UrlFetchApp), `extras.js` (providers + doPost intake) | ✔ ชุดที่ 4 |
| `gateway/` (Node 22: app.mjs, server.mjs, config.mjs, firebase.mjs; Dockerfile, cloudbuild.yaml, package-lock.json; firebase-admin 14.4.0) | ✔ ชุดที่ 4 |
| `frontend/src/screens/` cases, notifications (+ line-link, notify-monitor) | ✔ ชุดที่ 4 |
| `tests/application/` followup (6), outbox (7), webhook (5); `tests/gateway/gateway.test.mjs` (5); GAS emulator +1 | ✔ ชุดที่ 4 |
| `docs/GATEWAY_TH.md`, `docs/USER_GUIDE_FOLLOWUP_TH.md`, INSTALL_GAS_TH §13, ScriptProperties.example | ✔ ชุดที่ 4 |
| `src/application/services/daily-summary.js` (`dailySummary`, `tally`, นิยามการนับ — ใช้ร่วมกันระหว่าง dashboard และรายงาน) | ✔ ชุดที่ 5 |
| `src/application/reports/definitions.js` (R01–R12: ตัวกรอง สิทธิ์ ขอบเขตห้อง ช่วงวันสูงสุด), `reports/render.js` (CSV BOM/CRLF/กันสูตร, ค่า ISO vs พ.ศ., จำกัดแถว) | ✔ ชุดที่ 5 |
| `src/application/ops/reports.js` report.catalog/preview/run/rerun/runs/download/lock + job `report.render` | ✔ ชุดที่ 5 |
| `src/application/ops/operations.js` backup.list/run/recordRestoreTest, system.metrics, retention.preview/purge/purgeJobs + jobs `backup.snapshot`, tick `ops.schedule` (flush metrics, สำรองประจำคืน) | ✔ ชุดที่ 5 |
| `src/adapters/gas/report-renderer.js` (XLSX: Sheet ชั่วคราว → Drive export; PDF: Docs template + pinTableHeaderRows; `ensureReportTemplate`) | ✔ ชุดที่ 5 |
| `src/adapters/gas/backup.js` (snapshot ใต้ lock + manifest sha256 + prune; `restoreSnapshot` → `adminRestoreSnapshot`) | ✔ ชุดที่ 5 |
| stores: `purgePartition` (TERM partition), `purgeWhere` (Jobs เท่านั้น); metrics buckets 5 นาที + `drain` (GAS CacheService / Node memory) | ✔ ชุดที่ 5 |
| System health: jobs.heartbeat, backup.recent, backup.restore_tested (FAIL ใน PROD ถ้ายังไม่ทดสอบ), outbox.queue_age | ✔ ชุดที่ 5 |
| `frontend/src/screens/reports.js` (catalog, ตัวกรอง, ดูบนจอ, สร้างไฟล์, ดาวน์โหลด, ล็อก, ฉบับใหม่), health.js (+ metrics, สำรอง, retention) | ✔ ชุดที่ 5 |
| `tests/application/` reports (7), operations (5), security (5); GAS emulator +1 (PDF/XLSX/CSV + backup + restore drill); GasSim: DocumentApp/Docs API/Drive export/makeCopy/getAs | ✔ ชุดที่ 5 |
| THREAT_MODEL.md, docs/OPERATIONS_TH.md, docs/REPORTS_TH.md, docs/PRIVACY_NOTICE_DRAFT_TH.md (ร่าง), INSTALL_GAS_TH §7.1–7.2, ScriptProperties.example (`CWK_RESTORE_FROM_FOLDER_ID`) | ✔ ชุดที่ 5 |
| API_CONTRACT.md, openapi.yaml, DATA_DICTIONARY.md, 0001_init.sql | ✔ regenerated (schema ไม่เปลี่ยนในชุดที่ 5) |

## Completed requirements (สะสม)

- §4 ports/adapters/DI จุดเดียว, DATA_ADAPTER แยก SERVICE_BACKEND, generator runtime (sync GAS / async Node)
- §5 AuthProvider: GatewayIdentityVerifier (HMAC request/response, aud/iss/exp/sub/tenant, checkRevoked ต้องเป็น true, cache ≤ 300 วินาทีด้วย SHA-256 ของ token), DemoIdentityVerifier + production gate, IdentityLinks, คำเชิญครั้งเดียว/มีอายุ/ผูกอีเมล/นับครั้งผิด, สมัครบัญชีแล้วยังไม่มีสิทธิ์, ห้ามให้บทบาทตนเอง (SoD), ระงับบัญชีมีผลทันที, logout ล้าง cache
- §6 ตรวจสิทธิ์ทุก operation, search กรองก่อนแบ่งหน้า, ข้อมูลระบุตัวขั้นต่ำที่ประตู (BASIC), เอกสารสุขภาพอ่านได้เฉพาะผู้มีสิทธิ์ + audit
- §7.1 นักเรียน/ห้อง/enrollment history/ผู้ปกครองหลายคน/ช่องทางติดต่อ + นำเข้า CSV/XLSX
- §7.2 ใบลา: ทั้งวัน/ครึ่งวัน/คาบ หลายวัน, ตรวจวันเรียน+enrollment+วันซ้อน, ย้อนหลังมีเหตุผล, ผู้ปกครองยืนยันแยกจากโรงเรียนอนุมัติ, เส้นทางอนุมัติตามกฎ, อนุมัติบางช่วง, ส่งกลับ/แก้ไขส่งใหม่ (revision), ถอน, ขอยกเลิก/ยกเลิกโดยผู้มีอำนาจ, เปลี่ยนผู้พิจารณา, เอกสารแนบ (magic bytes, ≤5 MB), คำนวณการมาเรียนย้อนหลังเมื่ออนุมัติ/ยกเลิก
- §7.3 ลงเวลาสาย: เวลาเซิร์ฟเวอร์, กฎตามวันที่มีผล, ปัดนาที, สแกนซ้ำคืนรายการเดิม (dedupe ภายใต้ lock), แถวรอ/เวลาที่ระบุเอง (มีเหตุผล), ออฟไลน์ (คิวขั้นต่ำ, ตรวจซ้ำ, REVIEW เมื่อผิดปกติ), เช็กชื่อ (ค่าเริ่มต้นมา, expected_version), ยืนยันขาดรายคน, ข้อมูลขัดกัน → งานตรวจสอบ, การแก้ไขย้อนหลังเป็นเหตุการณ์ใหม่ + audit + แจ้งเฉพาะเมื่อข้อเท็จจริงที่แจ้งไปเปลี่ยน, คำขอแก้ไขจากผู้ปกครอง → ครูพิจารณา (ปิดงานตรวจสอบอัตโนมัติ), ข้อยกเว้นการนับสาย (เก็บเวลาจริง)
- §7.4 Dashboard ตามขอบเขต ใช้ projection เดียวกับรายงาน + นิยามการนับ, polling ~60 วินาทีเฉพาะเมื่อแท็บแสดงอยู่
- §7.5 หน้าประวัตินักเรียน: FULL/BASIC ตามสิทธิ์, สถิติรายภาค/รายเดือน, timeline (รายการที่ถูกแก้ยังเห็น), ผู้ปกครอง (tel:/mailto:), ประวัติห้อง, งานค้าง
- §7.6 งานติดตาม: กฎสาย/ขาดสะสม (ช่วงวันเรียน, ยกเว้น, เวอร์ชัน, หลักฐานอ้างอิง, ค่าตัวอย่างระบุชัด), case มี owner/due/priority/status/next action, กันเปิดซ้ำ + cooldown + เกณฑ์เปิดใหม่หลังปิด, บันทึกติดต่อ (ติดต่อไม่ได้ก็บันทึก; tel: ไม่ถือว่าโทรสำเร็จ), นัดหมาย, ส่งต่อเฉพาะผู้มีสิทธิ์, ปิดพร้อมข้อสรุป/เปิดใหม่, คำขอติดต่อกลับเข้าคิวครูเจ้าของเรื่อง; คะแนนพฤติกรรมยังปิด
- §11.1 การแจ้งเตือน: สร้างใน changeset เดียวกับเหตุการณ์, ผู้รับจากความสัมพันธ์ที่ยืนยัน, template มีเวอร์ชัน, เหตุการณ์บังคับครบ (ใบลา/สาย/ขาดยืนยัน/งานติดตามใหม่/เกินกำหนด/ขอติดต่อกลับ/แก้ไขข้อมูล), quiet hours, สถานะการส่งแยกจากการรับทราบ, เก็บ provider request id และเวลารับทราบจริง, หมดเวลารับทราบ → FOLLOW_UP_REQUIRED + case
- §11.2 Outbox: dedupe key, claim + lease, exponential backoff + จำกัดครั้ง, ไม่ sleep, LINE retry key เดิม + 409, ทดสอบ process ตายหลังผู้ให้บริการรับแล้ว (LINE ส่งครั้งเดียว / อีเมล OUTCOME_UNKNOWN ไม่ส่งซ้ำเอง), dead-letter view + RETRY_SAME/RESEND_NEW ที่ตรวจสิทธิ์, ตรวจสิทธิ์ผู้รับซ้ำก่อนส่ง, worker เคารพ `replay_blocked` (การนำเข้าย้ายระบบที่ตั้งค่านี้อยู่ในชุดที่ 6)
- §11.3 LINE: Messaging API (ไม่ใช้ LINE Notify), token/secret ฝั่ง server, account link ด้วย nonce ครั้งเดียว (browser ไม่ส่ง user ID), unbind/revoke/unfollow, ข้อความขั้นต่ำ, ปุ่ม postback ผูก identity, ไม่แสดง "อ่านแล้ว" จาก HTTP 200
- §11.4 Gateway: raw body + HMAC ก่อน parse, จำกัดขนาด, verify/ซ้ำ/ไม่รู้จัก, envelope ลงลายเซ็น (version/ts/nonce/kid), GAS ตรวจ HMAC/เวลา/ซ้ำ/schema แล้วบันทึกถาวรก่อนตอบ, ตอบ LINE 200 หลังบันทึกเท่านั้น (ไม่เช่นนั้น 503 → redelivery), log ไม่มีข้อมูลอ่อนไหว, secrets ใน Secret Manager
- §11.5 อีเมลผ่าน MailApp ตามโควตา; SMS ปิด (ไม่มีผู้ให้บริการ)
- §10 Sheets: StorageCatalog + partition ต่อภาคเรียน, TextFinder lookups (+ lookup ตาม school_date), batch preload รายห้อง, ScriptLock + MutationJournal + recovery, optimistic concurrency, unique/FK ใต้ lock, Jobs ถาวรพร้อม lease/checkpoint
- §13 หน้าจอ: Gate (สแกน/พิมพ์/ชื่อ/กล้องเมื่อรองรับ, Enter ยืนยัน, เสียง, ออฟไลน์), Roll Call, Leave, Approval Inbox, Profile, Dashboard, Contact/Case Inbox, การแจ้งเตือน, Notification Monitor; ภาษาไทย, ใช้ได้ที่ 375px, ป้องกันกดซ้ำ, ข้อความผิดพลาดรายช่อง, ไม่เก็บร่างลง storage
- §14 RPC allowlist, admin เฉพาะ editor + time window + owner, trigger handler ตรวจ triggerUid, health ไม่เปิดเผยความลับ, read-only mode บังคับที่ store
- §16 envelope/response/error contract, idempotency, expected_version, stale response guard, OpenAPI
- §12 รายงาน R01–R12: ดูบนจอ + CSV (UTF-8 BOM, กันสูตร) + XLSX (export จริง) + PDF (Docs template, หัวตารางซ้ำทุกหน้า, ช่องลงนาม); สร้างด้วยสิทธิ์ผู้ขอ ณ เวลาสร้าง; เก็บตัวกรอง/as_of/schema/rule versions/ผู้สร้าง; งานเบื้องหลัง + สถานะ + ล้มเหลวแสดงเหตุผล; ดาวน์โหลดตรวจสิทธิ์ + checksum + audit; ล็อก + revision; R01 ตรงกับ dashboard (ทดสอบ); R07 ตัวหาร = วัน-คน
- §14 operations: metrics → OperationMetrics (p50/p95 ต่อ operation), สำรองประจำคืนแบบ consistent + manifest + prune, restore drill ไป environment ใหม่ + บันทึกผล, retention เฉพาะบันทึกระบบ (ตาม partition) + Jobs, health checks เพิ่ม; security: envelope ≤ 8 MB, page cap, rate limit ต่อ operation/ผู้ใช้, upload validation, error ไม่ echo ความลับ
- §17 คู่มือติดตั้งฉบับแรก, คู่มือใช้งานประจำวัน, คู่มือ gateway, คู่มืองานติดตาม/แจ้งเตือน, คู่มือปฏิบัติการ (OPERATIONS_TH), นิยามรายงาน (REPORTS_TH), THREAT_MODEL, ร่างประกาศความเป็นส่วนตัว

## Pending requirements (ชุดถัดไป)

ชุดที่ 6: portable export (manifest + JSONL ต่อตาราง + ไฟล์แนบ + checksum, freeze/high-water mark), restore จาก portable package, `tools/migrate.mjs` (validate/plan/import --dry-run/--apply ผ่าน staging schema/reconcile) กับ PostgreSQL จริง, corruption tests, หน้าจอศูนย์ส่งออก/ย้ายข้อมูล, MIGRATION_RUNBOOK_TH, `replay_blocked` บน outbox ที่นำเข้า
ชุดที่ 7–8 ตาม MASTER_PROMPT §20

## Test results (Node 22.22.0, 2026-10-11)

| ชุดทดสอบ | คำสั่ง | ผล |
|---|---|---|
| domain + shared + purity + generated-freshness | `npm run test:domain` | automated pass |
| application (memory adapter): daily 16, followup 6, outbox 7, webhook 5, reports 7, operations 5, security 5 + foundation/imports | `npm run test:app` | automated pass |
| gateway (node:http จริงบน localhost; Firebase แทนด้วยตัวทดสอบ; GAS แทนด้วย intake จริงบน memory store) | `node --test tests/gateway/` | automated pass (5) |
| GAS bundle บน emulator (14 tests รวม MailApp, doPost envelope → account link, LINE push + retry key, รายงาน PDF จาก Docs template + หัวตารางปักหมุด, XLSX export, CSV, backup snapshot + restore drill) | `npm run test:gas` | automated pass **(emulator — ไม่ใช่ Apps Script จริง; Docs/Drive export จำลองพฤติกรรมเท่านั้น ไม่ได้ตรวจหน้าตา PDF/XLSX จริง)** |
| รวม | `npm test` | **137 pass / 0 fail** |
| UI smoke (gas-dist/App.html ใน Chromium 141 headless, dispatcher จริงบน memory store) | `npm run test:ui` | **29/29 automated pass** — ชุดที่ 5 เพิ่ม: R01 บนจอมีแถวรวมตรงกับ dashboard ทุกช่อง, ดาวน์โหลด CSV (BOM + หัวคอลัมน์ไทย), หน้าสถานะระบบแสดง metrics/สำรอง/retention |
| PostgreSQL DDL | `tools/pg-local.mjs` + psql | manual verified (2026-10-11, PG 16): `0001_init.sql` + `roles.sql` บน cluster ใหม่ — 57 ตาราง (ไฟล์ไม่เปลี่ยนในชุดที่ 5 — `gen-docs --check` ยืนยัน) |
| firebase-admin 14.4.0 API (initializeApp/getApps/applicationDefault, getAuth().verifyIdToken/revokeRefreshTokens/tenantManager) | ติดตั้งใน scratchpad + node -e | manual verified (มีฟังก์ชันจริง; token ผิดรูปแบบได้ code `auth/argument-error`) — **ยังไม่ได้ตรวจ token จริงกับโปรเจกต์ Firebase** |
| Apps Script จริง / Firebase จริง / LINE จริง / Cloud Run จริง | — | **not run** — blocked by configuration (ยังไม่มีบัญชีโรงเรียน, โปรเจกต์ Firebase, LINE OA) — ทำตาม docs/GATEWAY_TH.md §9 |
| PDF ภาษาไทย/เลขหน้า/หัวตารางซ้ำบน Google Docs จริง, XLSX ที่เปิดใน Excel, เวลาสร้างรายงาน/สำรองบน Apps Script จริง, restore drill จริง | — | **not run** — blocked by configuration (ต้องใช้บัญชี Google ของโรงเรียน) — รายการตรวจใน docs/OPERATIONS_TH.md §4 และ docs/REPORTS_TH.md |
| generated files / gas-dist freshness | `npm run check:gen`, `node tools/build-gas.mjs --check` | automated pass (66 files; gas-dist up to date) |
| secret scan ของไฟล์ที่เปลี่ยน (API key รูปแบบ Google, private key, token, อีเมลจริง) | grep patterns | manual verified — ไม่พบ |
| กล้อง/เครื่องสแกน/IndexedDB บนอุปกรณ์โรงเรียน, screen reader, มือถือจริง | — | **not run** |

## Known issues / ข้อจำกัด

- พฤติกรรม apostrophe/TextFinder ของ Sheets จริงต้องยืนยันด้วย `adminSelfTest()` (D-007)
- rate limit บน CacheService เป็น best effort (ไม่ atomic)
- ผู้อ่านที่ไม่ถือ lock อาจเห็นผลบางส่วนของ operation ที่ process ตายกลางทางจนกว่า recovery จะรัน (D-006)
- เอกสารทางการบางส่วนตรวจผ่าน web search เท่านั้น (DECISIONS ท้ายไฟล์)
- Gate: เวลาแถวรอใช้วันที่ของโรงเรียน (Asia/Bangkok) แต่ไม่ตรวจว่าเวลาที่ระบุไม่อยู่ในอนาคต ฝั่งเซิร์ฟเวอร์เป็นผู้ตรวจ (MANUAL_TIME/QUEUE_BATCH)
- งาน openDay บน Sheets สำหรับ 1,500 คนยังไม่ได้วัดเวลาจริงบน Apps Script (ออกแบบเป็น job มี checkpoint; ต้องวัดใน UAT)
- LINE: เวลาที่ LINE รอ webhook เทียบกับเวลาที่ GAS ใช้บันทึกยังไม่ได้วัด — ถ้าช้ากว่า LINE จะส่งซ้ำ (dedupe แล้ว แต่ reply token อาจหมดอายุ) (docs/GATEWAY_TH.md §8)
- ถ้านโยบาย Workspace ไม่อนุญาต web app แบบ Anyone gateway จะส่ง webhook เข้า GAS ไม่ได้ — ยังไม่มีโหมด pull (ไม่ส่งมอบในชุดนี้)
- รายการติดต่อเข้าจาก LINE สร้างหนึ่งรายการต่อบุตรหลานที่เชื่อมโยง (ผู้ปกครองหลายบุตรจะเห็นข้อความเดียวกันในหลายห้อง) — ตั้งใจเพื่อไม่ตกหล่น (D-022)
- outbox scan อ่านเฉพาะ partition 60 วันล่าสุด: รายการค้างจากภาคเรียนเก่ากว่านั้นจะไม่ถูกส่ง (ตั้งใจ — ไม่ส่งข้อความเก่าย้อนหลัง)
- Dashboard และรายงานนับจาก projection ที่คำนวณสด (preload รายห้อง) — ช่วงวันยาว/ทั้งโรงเรียนอาจช้าบน Sheets จึงจำกัดช่วงวันต่อรายงานและให้ไฟล์ใหญ่เป็นงานเบื้องหลัง; เวลาจริงต้องวัดใน UAT
- เลขหน้าในรายงาน PDF ต้องแทรกเองครั้งเดียวในแม่แบบ (Docs API ไม่มีคำสั่ง) — INSTALL_GAS_TH §7.1
- สำรองประจำคืนไม่คัดลอกไฟล์แนบ (เก็บเพียงรายการพร้อม sha256) — ชุดส่งออกแบบ portable (ชุดที่ 6) รวมไฟล์แนบ
- metrics บน CacheService เป็น best effort (อาจหายเมื่อ cache ถูกล้างก่อน flush)
- ยังไม่มี workflow ลบข้อมูลส่วนบุคคลตามนโยบายโรงเรียน (ไม่ส่งมอบในระยะแรก — D-025)

## Next exact task

ชุดที่ 6 — `docs/PORTABLE_FORMAT.md` + `schema/portable/manifest.schema.json`; export job (`migration.export`: freeze ด้วย READ_ONLY หรือ high-water mark จาก ChangeLog seq, JSONL แบ่ง chunk ต่อตาราง + sha256, ไฟล์แนบ + manifest) บน GAS และ memory; restore จาก portable package ไป Sheets ใหม่; `tools/migrate.mjs` (validate, plan, import --dry-run/--apply ผ่าน staging schema ใน PostgreSQL, reconcile นับแถว/checksum/FK) ทดสอบกับ PostgreSQL จริงผ่าน `tools/pg-local.mjs`; corruption tests (checksum ผิด, ไฟล์หาย, FK ขาด, schema version ไม่รองรับ); outbox ที่นำเข้าตั้ง `replay_blocked`; หน้าจอศูนย์ส่งออก/ย้ายข้อมูล; `docs/MIGRATION_RUNBOOK_TH.md`

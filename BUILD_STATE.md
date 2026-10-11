# BUILD_STATE — CWK Smart Care

| รายการ | ค่า |
|---|---|
| project version | 0.8.0 (ยังไม่ใช่ release — ส่งมอบโค้ดครบ 8 ชุด; ยังไม่ผ่าน UAT บน deployment จริง) · REST API `cwk-api` 0.7.0 · gateway 0.4.0 (ไม่เปลี่ยนตั้งแต่ชุดที่ 4) · portable format v1 |
| schema version | 1 (`src/schema/tables.js`, 56 ตาราง; DDL ชุดที่ 7: FK ทุกตัว DEFERRABLE — ยังไม่ release) |
| API version | v1 (139 operations ใน allowlist) · public GAS functions 13 |
| prompt version | MASTER_PROMPT 1.0 (2026-10-10) |
| ชุดล่าสุดที่ส่งมอบ | ชุดที่ 8 — ตรวจรับขั้นสุดท้าย (test matrix §18, UAT checklist, ทดสอบโหลด, LIMITATIONS, inventory, ล้างไฟล์กำพร้า) — ครบทุกชุดตาม §20 |
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

DECISIONS.md D-001…D-038 (ชุดที่ 8 เพิ่ม D-038 ล้างไฟล์กำพร้า; ชุดที่ 7 เพิ่ม D-032 PostgreSQL adapter, D-033 HTTP layer, D-034 ตัวตนบน REST/การส่ง credential จาก GAS, D-035 worker, D-036 ความสามารถที่ REST ยังไม่มี, D-037 เว็บรุ่นเริ่มต้น; ชุดที่ 6 เพิ่ม D-026 รูปแบบ package, D-027 snapshot ที่พิสูจน์ความสอดคล้อง, D-028 แกนตรวจเดียว/ปลายทางใหม่เท่านั้น/staging+merge, D-029 reconciliation ด้วยตัวอย่างธุรกิจ, D-030 cutover/rollback, D-031 แก้การอ่านข้อมูลที่ถูกตัดที่ 500 แถว; ชุดที่ 5 เพิ่ม D-023 รายงานบนจอ vs ฉบับไฟล์/ล็อก/revision, D-024 snapshot + restore ไป environment ใหม่เท่านั้น, D-025 retention เฉพาะบันทึกระบบ; ชุดที่ 4 เพิ่ม D-020 กฎติดตาม/กันซ้ำ/เปิดใหม่, D-021 การส่งออกใน DEV/STAGING, D-022 ข้อความเข้าและปุ่มตอบกลับทาง LINE; ชุดที่ 3: รายละเอียด implement: DailyAttendance เป็น projection ที่คำนวณใหม่ใน changeset เดียวกับเหตุการณ์, การแก้ไขเป็นเหตุการณ์ใหม่ที่ supersede ของเดิม, config cache ล้างอัตโนมัติเมื่อ commit แตะตารางตั้งค่า)

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
| `gas-dist/` Code.js (986,484 ไบต์), Entrypoints.js (13 public functions), App.html (275,325 ไบต์), appsscript.json, BUILD_INFO.json | ✔ built (`npm run build`, ชุดที่ 8) |
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
| `src/application/migration/` format (นโยบายส่งออก, transforms, canonical/digest, manifest schema), export (job + inventory + พิสูจน์ความสอดคล้อง), process (แกนตรวจ/นำเข้า resumable), sinks, import, reconcile, samples (ยอด R01–R07 + fingerprint สิทธิ์), delta (rollback), docs-bundle (generated) | ✔ ชุดที่ 6 |
| `src/application/ops/migration.js` migration.inventory/startExport/runs/get/packageDoc/pause/resume/cancel/validate/recordEvidence/checklist/markReady/cutover/rollback + jobs `migration.export`, `migration.validate` | ✔ ชุดที่ 6 |
| `src/adapters/gas/drive-package.js`, `src/adapters/node/fs-package.js`, `src/adapters/node/fs-storage.js`, `src/adapters/memory/memory-package.js`; store import contract (`importColumns`, `importAppend`, `importUpdate`) ใน MemoryStore และ SheetsStore | ✔ ชุดที่ 6 |
| GAS: `adminImportPackage`, `adminApplyDelta` (public functions 13); platform packageStore/journalStatus/maxChangeSeq | ✔ ชุดที่ 6 |
| `tools/migrate.mjs` (validate/plan/import --dry-run/--apply/reconcile/pack), `tools/lib/pg-target.mjs` (staging + merge + reconcile target), `tools/lib/zip.mjs`, `tools/rehearse-postgres.mjs`, `tools/fixtures/generate-synthetic.mjs`, `tools/gen/portable.mjs`, `docker-compose.yml` | ✔ ชุดที่ 6 |
| `frontend/src/screens/migration.js` (ศูนย์ส่งออกและย้ายข้อมูล) | ✔ ชุดที่ 6 |
| `tests/migration/` portable (6), import-reconcile (5), corruption (9), cutover (5), postgres (5, ต้องมี PostgreSQL); GAS emulator +1; security +1 (กันการอ่านถูกตัด); `tests/helpers/migration-fixture.mjs`, `package-tools.mjs` | ✔ ชุดที่ 6 |
| docs/PORTABLE_FORMAT.md, docs/MIGRATION_RUNBOOK_TH.md, schema/portable/*.schema.json, THREAT_MODEL T12, INSTALL_GAS_TH §7.3, OPERATIONS_TH §7.1, ARCHITECTURE §6.1, README_TH | ✔ ชุดที่ 6 |
| API_CONTRACT.md, openapi.yaml, DATA_DICTIONARY.md, 0001_init.sql | ✔ regenerated (ชุดที่ 7: HTTP status ต่อรหัสข้อผิดพลาด, `/v1/webhook/line`, FK deferrable) |
| `src/adapters/postgres/` pg-store.js (PgStore: reads canonical, commit = transaction, idempotency/ChangeLog advisory locks, READ_ONLY ในฐานข้อมูล, partition เชิงตรรกะ, worker lock), sql-codec.js (WHERE/ORDER BY แบบ parameterized + COLLATE "C", แปลง error ของ PostgreSQL) | ✔ ชุดที่ 7 |
| `future-platform/api/` server.mjs, admin.mjs (init-db/bootstrap/seed-demo/set-mode/status/export-delta), src/{config,identity,deps,app,worker}.mjs, package.json + package-lock.json (pg 8.23.1, firebase-admin 14.4.0), Dockerfile (+ .dockerignore) | ✔ ชุดที่ 7 |
| `src/adapters/http/http-api-adapter.js` + `src/entry/gas-main.js` โหมด `CWK_SERVICE_BACKEND=REST` (rpc/doGet ส่งต่อ, doPost/cronTick/admin* ปฏิเสธ) | ✔ ชุดที่ 7 |
| `future-platform/web/` index.html, styles.css, app.js, api.js, auth.js, README_TH.md (หน้าที่มี/ที่ต้องย้าย) | ✔ ชุดที่ 7 |
| `docker-compose.yml` profile `api` (api-init + api) | ✔ ชุดที่ 7 (ไฟล์เท่านั้น — ยังไม่ได้รัน) |
| `tests/contract/store-contract.test.mjs` (8 × memory + 8 × PostgreSQL), `tests/api/` api (11), gas-http-adapter (4), unit (4); `tests/ui/web-starter-smoke.mjs`; helpers api-server, pg-api-fixture, sync-fetch | ✔ ชุดที่ 7 |
| docs/REST_BACKEND_TH.md, ARCHITECTURE §2/§4/§6.2, DECISIONS D-032–D-037, THREAT_MODEL T13–T15, MIGRATION_RUNBOOK §6.5/§8, README_TH, .env.example, ScriptProperties.example (`CWK_REST_BASE_URL`) | ✔ ชุดที่ 7 |
| `src/application/jobs/files-jobs.js` (งาน `files.cleanupOrphans` + tick `files.schedule`), storage `listStaged`/`isStaged`/`promote` (Drive, memory, filesystem), Settings `files.cleanup_time`, PgStore `onLockWait` | ✔ ชุดที่ 8 |
| `tests/application/` files (1), identity-gateway (4), jobs (3); GAS emulator +2 (Drive cleanup, execute-as-owner); helpers `gateway-server.mjs`; GasSim `getDateCreated` | ✔ ชุดที่ 8 |
| `tools/load-test.mjs` (`npm run load`: memory / rest / gas-emulator) | ✔ ชุดที่ 8 |
| docs/UAT_CHECKLIST_TH.md, docs/LIMITATIONS.md, docs/TEST_MATRIX.md, docs/LOAD_TEST_TH.md, docs/DELIVERY_INVENTORY.md; README_TH (ขอบเขตที่เสร็จ), ARCHITECTURE §3.4, THREAT_MODEL T8, DECISIONS D-038 | ✔ ชุดที่ 8 |

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
- §15 ศูนย์ส่งออกและย้ายข้อมูล: inventory, ส่งออก FULL_SNAPSHOT/REHEARSAL/PARTIAL เป็นงานเบื้องหลังมี checkpoint (หยุดชั่วคราว/ทำต่อ/ยกเลิก), package ตาม PORTABLE_FORMAT (manifest + sha256, JSONL canonical, CSV กันสูตร + data dictionary, ไฟล์แนบ bytes จริง + index, metadata, schema, docs), freeze ที่ server + high-water mark + พิสูจน์ความสอดคล้อง, ไม่มี secrets, outbox `replay_blocked`, ตรวจ package (FULL/INTEGRITY), นำเข้า Sheets ชุดใหม่ (adminImportPackage) และ PostgreSQL (CLI: staging + merge transaction เดียว, resume, idempotent, conflict ไม่เขียนทับ, ปฏิเสธ schema ไม่รองรับ, ZIP ปลอดภัย, role cwk_migrator), reconciliation ครบ §15.6 (จำนวน/ID/checksum แยก derived/partition/ช่วงวัน+พ.ศ./ความสัมพันธ์/outbox/ไฟล์แนบ/ยอด R01–R07/สิทธิ์ตัวอย่าง/FK SQL), state machine + หลักฐาน + readiness checklist + cutover (archive อ่านอย่างเดียว) + rollback (DELTA + APPLY_NEWER ไม่ทิ้งข้อมูลใหม่)
- §10.3/§14 งานตามเวลาใน READ_ONLY รันเฉพาะงานบำรุงรักษา; การอ่านทั้งหมดฝั่ง server ไม่ถูกตัดที่ 500 แถว (D-031)
- §2.3/§16 เส้นทางอัปเกรด: REST backend อ้างอิงใช้ dispatcher/operations/jobs เดิมทั้งหมด (139 operations ผ่าน contract เดียว), PostgreSQL unit of work = transaction เดียว (outbox ใน transaction), constraint เป็นการบังคับเพิ่ม, credential ของ app (`cwk_app`) แยกจาก migration (`cwk_migrator`) และ owner (DDL), OpenAPI + health/readiness + contract tests, ตรวจตัวตนซ้ำที่ backend; GAS HttpApiAdapter ส่ง credential ของผู้ใช้ให้ backend ตรวจ (ไม่เชื่อ user_id จาก GAS, ไม่ dual-write) ใช้ได้กับทุก operation; เว็บรุ่นเริ่มต้นมี login + รายชื่อนักเรียน + หน้ารายบุคคล + ลงเวลาสายครบหนึ่งกระบวนการ พร้อมรายการหน้าที่ต้องย้าย; Docker Compose (ไฟล์); ส่งออกจาก PostgreSQL ใช้ package format เดียวกัน; rollback DELTA จาก PostgreSQL ด้วย `admin.mjs export-delta`
- §18 test matrix ครบทุกกลุ่ม (docs/TEST_MATRIX.md) รวม Identity ฝั่ง GAS ↔ gateway จริง, Files/orphan cleanup, Quota/jobs; ทดสอบโหลดตามสมมติฐาน §3 พร้อม p50/p95, error rate, lock wait, queue latency, quota impact แยกผลเครื่องพัฒนาออกจาก Apps Script จริง (docs/LOAD_TEST_TH.md); UAT checklist ทุกบทบาทพร้อมผลที่คาดหวัง; LIMITATIONS; delivery inventory ตาม §19
- §17 คู่มือติดตั้งฉบับแรก, คู่มือใช้งานประจำวัน, คู่มือ gateway, คู่มืองานติดตาม/แจ้งเตือน, คู่มือปฏิบัติการ (OPERATIONS_TH), นิยามรายงาน (REPORTS_TH), THREAT_MODEL, ร่างประกาศความเป็นส่วนตัว

## Pending requirements

ไม่มีงานเขียนโค้ดค้างตามขอบเขตบังคับของ MASTER_PROMPT §20 (ชุดที่ 1–8) — สิ่งที่ยังต้องทำเป็นงานบน deployment จริงของโรงเรียน (ไม่สามารถทำได้ในสภาพแวดล้อมพัฒนา) และงานต่อยอดที่ระบุว่าไม่ส่งมอบใน docs/LIMITATIONS.md §2:
- UAT ทุกหมวดใน docs/UAT_CHECKLIST_TH.md บน STAGING ด้วยบัญชีโรงเรียน (Apps Script, Firebase, LINE, Cloud Run จริง)
- วัดโหลดบน Apps Script จริง (docs/LOAD_TEST_TH.md §5) และเวลาต่อคนที่ประตู (เป้าหมาย 10–15 วินาที)
- โรงเรียนกำหนดค่าธุรกิจ/ประกาศความเป็นส่วนตัว/นโยบายเก็บข้อมูล (BUILD_STATE "สมมติฐาน")
- แก้คอขวดแดชบอร์ดทั้งโรงเรียน (cache ต่อขอบเขต) ก่อนเพิ่มผู้ใช้แดชบอร์ดช่วงเช้า หากผลวัดจริงยืนยัน

## Test results (Node 22.22.0, PostgreSQL 16, 2026-10-11 — รันใหม่ทั้งหมดในชุดที่ 8)

| ชุดทดสอบ | คำสั่ง | ผล |
|---|---|---|
| domain + shared + purity + generated-freshness | `npm run test:domain` | automated pass |
| application (memory adapter): daily 16, followup 6, outbox 7, webhook 5, reports 7, operations 5, security 6 + foundation/imports | `npm run test:app` | automated pass |
| migration (memory): portable 6, import-reconcile 5, corruption 9, cutover/rollback 5 | `node --test tests/migration/` | automated pass (25) |
| PostgreSQL 16 จริง (cluster ชั่วคราวจาก `tools/pg-local.mjs`): migration 30 (CLI validate→plan→dry-run→apply→reconcile PASS, นำเข้าซ้ำ, package เสีย exit 4/3, ZIP traversal, roles, conflict exit 5, resume) + store contract 16 (memory 8 + PgStore 8) + REST API 11 + GAS→REST 4 + unit 4 | `CWK_PG_PORT=… npm run test:pg` | **65/65 automated pass** — ใน `npm test` ปกติ 28 รายการที่ต้องใช้ PostgreSQL แสดงเป็น **skipped** |
| REST API บน PostgreSQL (API ต่อด้วย role ในกลุ่ม `cwk_app`): health/readiness/routing/CSP, ตัวตนตรวจที่ backend, arrival end-to-end + idempotent replay + mismatch 409 + scoped reads + If-Match 409, CORS/415/400/413, READ_ONLY บังคับทุก instance, งาน CSV ผ่าน worker (PDF = FAILED ไม่มี renderer), LINE webhook (ปิด/เก็บครั้งเดียว/ลายเซ็นผิด 401), ส่งออกจาก PostgreSQL → ตรวจ FULL → นำเข้า → กระทบยอด PASS, rollback: package → PostgreSQL → ข้อมูลใหม่ผ่าน API → `admin.mjs export-delta` → applyDelta กลับต้นทาง, admin CLI, process `server.mjs` (exit 2/3, tick, SIGTERM, log ไม่มีความลับ) | ส่วนหนึ่งของ `npm run test:pg` | **11/11 automated pass** |
| GAS → REST (gas-dist ที่ build จริงบน emulator, `CWK_SERVICE_BACKEND=REST`, UrlFetchApp → API จริงใน process แยก): credential ใน Authorization, ตรวจที่ backend, search/profile/lookup/arrival/replay/CONFLICT, doGet ใช้ public config ของ backend, ไม่สร้าง spreadsheet, cronTick/doPost/adminSetup ปฏิเสธ, backend ล่ม → STORAGE_UNAVAILABLE | ส่วนหนึ่งของ `npm run test:pg` | **4/4 automated pass (emulator — ไม่ใช่ Apps Script/UrlFetchApp จริง)** |
| เว็บรุ่นเริ่มต้นใน Chromium headless + REST API + PostgreSQL (DEMO): รหัสผิดถูกปฏิเสธ, เมนูตามสิทธิ์, ลงเวลา (เวลา server 08:05 = สาย 5 นาที, 1 แถวใน PostgreSQL, สแกนซ้ำแสดงบันทึกแล้ว), ประตูเห็นข้อมูลระบุตัวเท่านั้น, ค้นหา → ประวัติเต็ม, ผู้ปกครองเปิดนักเรียนอื่นไม่ได้, ไม่มี JS error/CSP violation | `CWK_PG_PORT=… npm run test:web` | **12/12 automated pass** — ไม่ได้ทดสอบ Firebase sign-in จริง |
| ซ้อมย้ายครบขั้นด้วยข้อมูลสังเคราะห์ | `DATABASE_URL=… node tools/rehearse-postgres.mjs --init-schema` | manual verified (2026-10-11, PG 16 local): 6 ขั้น exit 0 — เวลาบนเครื่องพัฒนา ไม่ใช่ตัวแทนของโรงเรียน |
| docker compose (postgres + migrate, profile api) และ build image `future-platform/api/Dockerfile` | `docker compose …` | **not run** — ไม่มี Docker ใน environment พัฒนา |
| gateway (node:http จริงบน localhost; Firebase แทนด้วยตัวทดสอบ; GAS แทนด้วย intake จริงบน memory store) | `node --test tests/gateway/` | automated pass (5) |
| GAS bundle บน emulator (17 tests รวม ล้างไฟล์กำพร้าบน Drive, execute-as-owner, (โหมด GAS ปกติ; โหมด REST อยู่ในแถว GAS → REST) ส่งออก portable package ใน Drive (freeze, INTEGRITY), adminImportPackage ลงโปรเจกต์ใหม่ + reconcile PASS + ปฏิเสธนำเข้าซ้ำ, หลักฐานกลับต้นทาง → RECONCILED, MailApp, doPost envelope → account link, LINE push + retry key, รายงาน PDF จาก Docs template + หัวตารางปักหมุด, XLSX export, CSV, backup snapshot + restore drill) | `npm run test:gas` | automated pass **(emulator — ไม่ใช่ Apps Script จริง; Docs/Drive export จำลองพฤติกรรมเท่านั้น ไม่ได้ตรวจหน้าตา PDF/XLSX จริง)** |
| รวม | `npm test` | **186 pass / 0 fail / 28 skipped (PostgreSQL — รันด้วย npm run test:pg)** — ชุดที่ 8 เพิ่ม identity-gateway 4, jobs 3, files 1, GAS emulator 2 |
| ทดสอบโหลดช่วงพีค 1,500 คน / 5 จุด / 10 แดชบอร์ด (ข้อมูลสังเคราะห์) | `npm run load -- --target memory\|rest\|gas-emulator` | automated run บนเครื่องพัฒนา: 0 error ทั้ง 3 เป้าหมาย, ไม่มีบันทึกซ้ำ; REST+PostgreSQL พร้อมกันจริง recordArrival p95 217 ms, dashboard.summary p95 3,443 ms (คอขวด), ChangeLog lock wait p95 22 ms; memory queue latency p95 1.6 นาทีจำลอง — **ไม่ใช่ผลบน Apps Script** (docs/LOAD_TEST_TH.md) |
| ซ้อมย้ายข้อมูลครบขั้น (ชุดที่ 8, DDL สุดท้าย) | `DATABASE_URL=… node tools/rehearse-postgres.mjs --init-schema` | manual verified 2026-10-11 (PG 16 local): 6 ขั้น exit 0, `sha256sum -c manifest.sha256` OK, reconciliation PASS 16/16 checks, ready_to_cutover true |
| UI smoke (gas-dist/App.html ใน Chromium 141 headless, dispatcher จริงบน memory store) | `npm run test:ui` | **33/33 automated pass** (รันใหม่หลังแก้ main.js ชุดที่ 7) — ชุดที่ 6 เพิ่ม: ศูนย์ย้ายข้อมูลแสดง inventory, ปฏิเสธส่งออกก่อน freeze, ส่งออกเป็นงานเบื้องหลังจนส่งออกแล้ว/ครบถ้วน, ดาวน์โหลด RUNBOOK จาก package; ชุดที่ 5 เพิ่ม: R01 บนจอมีแถวรวมตรงกับ dashboard ทุกช่อง, ดาวน์โหลด CSV (BOM + หัวคอลัมน์ไทย), หน้าสถานะระบบแสดง metrics/สำรอง/retention |
| PostgreSQL DDL | `tools/pg-local.mjs` + test:pg | automated: `0001_init.sql` (FK deferrable ชุดที่ 7) + `roles.sql` ติดตั้งบนฐานข้อมูลใหม่ทุกครั้งที่ทดสอบ (PG 16) |
| firebase-admin 14.4.0 API (initializeApp/getApps/applicationDefault, getAuth().verifyIdToken/revokeRefreshTokens/tenantManager) | ติดตั้งใน scratchpad + node -e | manual verified (มีฟังก์ชันจริง; token ผิดรูปแบบได้ code `auth/argument-error`) — **ยังไม่ได้ตรวจ token จริงกับโปรเจกต์ Firebase** |
| Apps Script จริง / Firebase จริง (รวม `FirebaseIdentityVerifier` ของ REST และ Firebase REST sign-in ของเว็บรุ่นเริ่มต้น) / LINE จริง / Cloud Run หรือเครื่องจริงของ REST backend | — | **not run** — blocked by configuration (ยังไม่มีบัญชีโรงเรียน, โปรเจกต์ Firebase, LINE OA) — ทำตาม docs/GATEWAY_TH.md §9 |
| ส่งออก/นำเข้า/กระทบยอดบน Apps Script + Drive จริง (เวลา, ขนาด package, โควตา), ดาวน์โหลดโฟลเดอร์ Drive เป็น ZIP แล้วนำเข้า PostgreSQL ของโรงเรียน | — | **not run** — blocked by configuration (ต้องใช้บัญชี Google ของโรงเรียน) — ทำตาม docs/MIGRATION_RUNBOOK_TH.md §3 |
| PDF ภาษาไทย/เลขหน้า/หัวตารางซ้ำบน Google Docs จริง, XLSX ที่เปิดใน Excel, เวลาสร้างรายงาน/สำรองบน Apps Script จริง, restore drill จริง | — | **not run** — blocked by configuration (ต้องใช้บัญชี Google ของโรงเรียน) — รายการตรวจใน docs/OPERATIONS_TH.md §4 และ docs/REPORTS_TH.md |
| generated files / gas-dist freshness | `npm run check:gen`, `node tools/build-gas.mjs --check` | automated pass (69 files; gas-dist up to date) |
| เอกสาร Firebase Auth REST API (endpoint ของเว็บรุ่นเริ่มต้น) | WebFetch / curl | **blocked by configuration** — network policy ปิด firebase.google.com ในสภาพแวดล้อมพัฒนา (D-037) |
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
- **แก้แล้วในชุดที่ 6 (D-031):** ชุดที่ 3–5 อ่านข้อมูลบางจุดด้วย `list(..., limit ≥ 1000)` ซึ่งถูกตัดที่ 500 แถวโดยไม่แจ้ง (รายงาน R03/R05/R06/R08/R09/R11, งานแจ้งเตือนเกินกำหนด, monitor, health, retention, backup manifest) — ผลของรุ่นก่อน 0.6.0 อาจนับขาดเมื่อข้อมูลเกิน 500 รายการ
- การตรวจ package บน Apps Script เป็นระดับ INTEGRITY (checksum/canonical/schema/digest) — การตรวจ ID ซ้ำ/unique/FK ทั้งชุดทำใน Node (`tools/migrate.mjs validate`) และขณะนำเข้า (ปลายทางเป็น index)
- reconcile บน Apps Script (adminImportPackage) อ่านทุกตารางในหน่วยความจำและไม่แบ่ง execution — ชุดข้อมูลใหญ่อาจเกิน 6 นาที: ใช้ `tools/migrate.mjs reconcile` แทน; เวลาจริงยังไม่ได้วัด
- reconcile ฝั่ง PostgreSQL โหลดข้อมูลกลับเข้าหน่วยความจำเพื่อคำนวณยอดรายงาน — ใช้หน่วยความจำตามขนาดข้อมูลของโรงเรียน (ยังไม่ได้วัดกับข้อมูลจริง)
- **ส่งมอบแล้วในชุดที่ 7:** DELTA export จาก PostgreSQL (`admin.mjs export-delta`) — ทดสอบ rollback กลับต้นทางแล้ว; บน Sheets ชุดใหม่ยังไม่มีคำสั่ง editor สำเร็จรูป
- Code.js 986,484 ไบต์: ขีดจำกัดขนาดโปรเจกต์ Apps Script ยังไม่ได้ตรวจกับ deployment จริง
- REST backend (D-036): ไม่มีการส่งอีเมล/LINE, PDF/XLSX, นำเข้า XLSX, สำรองในแอป — ตอบรหัสข้อผิดพลาดชัดเจน; ต้องเพิ่ม provider/renderer ก่อนใช้ REST เป็นระบบหลัก
- **คอขวดจากทดสอบโหลด:** `dashboard.summary` ทั้งโรงเรียนคำนวณสดทุกครั้ง — REST p95 3.4 วินาทีเมื่อแข่งกับการสแกน (docs/LOAD_TEST_TH.md §3) — ยังไม่ได้แก้ในชุดนี้ (ต้องยืนยันด้วยผลวัดจริงก่อนเลือกวิธี cache)
- **แก้แล้วในชุดที่ 8 (D-038):** ชุดที่ 2–7 อ้างในคอมเมนต์ว่ามีงานล้างไฟล์กำพร้า แต่ยังไม่มีงานจริง และไฟล์ที่ผูกแล้วค้างใน Drive `staging/` — ตอนนี้มีงาน `files.cleanupOrphans` + ทดสอบ
- REST `list` ใช้ cursor แบบ offset (อาจเห็นซ้ำ/ข้ามหนึ่งแถวบนจอเมื่อมีข้อมูลเข้าใหม่ระหว่างเปิดหน้า); ChangeLog lock เดียวทั้งระบบจำกัด throughput การเขียน; partition เชิงตรรกะยังไม่มี index — ยังไม่ได้วัดโหลด (ชุดที่ 8)
- ขั้นที่ 2 (GAS → REST): ทุกคำขอผ่าน UrlFetchApp — latency และโควตา UrlFetch ยังไม่ได้วัดบน Apps Script จริง
- เว็บรุ่นเริ่มต้นเก็บ token ในหน่วยความจำเท่านั้น (รีโหลด = เข้าสู่ระบบใหม่) — ตั้งใจ (D-037)
- contract test ของ store ครอบคลุม memory + PostgreSQL; SheetsStore ทดสอบผ่านชุด GAS emulator แยกต่างหาก (ยังไม่ได้รัน contract suite เดียวกันบน emulator)

## Next exact task

ส่งมอบครบทุกชุดตาม §20 แล้ว — งานถัดไปเป็นของผู้ติดตั้ง/โรงเรียน: ติดตั้ง STAGING ตาม docs/INSTALL_GAS_TH.md (§0 ตรวจเอกสารและโควตาปัจจุบันก่อน) → ตั้ง gateway ตาม docs/GATEWAY_TH.md → ทำ docs/UAT_CHECKLIST_TH.md หมวด A ก่อน แล้ว B–F → วัดโหลดตาม docs/LOAD_TEST_TH.md §5 → บันทึกผลกลับใน BUILD_STATE (Test results: แยกแถว "Apps Script จริง") — ถ้าพบข้อบกพร่องให้แก้เป็นชุดย่อยต่อจาก 0.8.0 พร้อมทดสอบอัตโนมัติที่จำลองกรณีนั้น

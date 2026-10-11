# BUILD_STATE — CWK Smart Care

| รายการ | ค่า |
|---|---|
| project version | 0.3.0 (ยังไม่ใช่ release) |
| schema version | 1 (`src/schema/tables.js`, 56 ตาราง) |
| API version | v1 (88 operations ใน allowlist) |
| prompt version | MASTER_PROMPT 1.0 (2026-10-10) |
| ชุดล่าสุดที่ส่งมอบ | ชุดที่ 3 — Daily workflows |
| อัปเดตล่าสุด | 2026-10-10 |

## สมมติฐาน (แยกจากข้อมูลจริง)

| หัวข้อ | สมมติฐานที่ใช้พัฒนา | สถานะ |
|---|---|---|
| จำนวนนักเรียน | 1,500 คน (ประเมินขนาด) / ข้อมูลสังเคราะห์ใน demo | **สมมติ** |
| เวลาเริ่มสาย | 08:00 grace 0 (`is_example=true`) | **ต้องกำหนดก่อน production** — PROD health = FAIL และ Dashboard เตือนจนกว่าเปลี่ยน |
| เส้นทางอนุมัติใบลา | ≤3 วันเรียน → ครูที่ปรึกษา, ≥4 วัน/กิจกรรมโรงเรียน → กิจการนักเรียน; นักเรียนยื่นต้องให้ผู้ปกครองยืนยัน; ย้อนหลังได้ 7 วัน; ลาป่วย ≥3 วันต้องแนบเอกสาร | **ค่าตัวอย่าง** ต้องให้โรงเรียนกำหนด |
| ยืนยันขาด | เปิดงานตรวจสอบหลัง 10:00; แจ้งผู้ปกครองเมื่อครูยืนยัน | **ค่าตัวอย่าง** |
| เช็กชื่อย้อนหลัง | 3 วัน (`attendance.rollcall_backdate_days`) | ค่าเริ่มต้น ปรับได้ |
| เกณฑ์ติดตาม/นโยบายแจ้งเตือน | ค่าตัวอย่างใน `EXAMPLE_RULE_PARAMS` | ต้องให้โรงเรียนกำหนด |
| โดเมน/บัญชี/Firebase/LINE | example.com, ค่าตัวอย่าง | ตั้งในขั้นติดตั้ง |
| เบอร์โทรสังเคราะห์ | `+999…` (รหัสประเทศสงวน ไม่ใช่เบอร์จริง) | ใช้เฉพาะ DEV/STAGING |

## Architecture decisions

DECISIONS.md D-001…D-019 (ไม่มีการเปลี่ยน decision ในชุดที่ 3; รายละเอียด implement: DailyAttendance เป็น projection ที่คำนวณใหม่ใน changeset เดียวกับเหตุการณ์, การแก้ไขเป็นเหตุการณ์ใหม่ที่ supersede ของเดิม, config cache ล้างอัตโนมัติเมื่อ commit แตะตารางตั้งค่า)

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
| `gas-dist/` Code.js (~556 KB), Entrypoints.js, App.html (~201 KB), appsscript.json, BUILD_INFO.json | ✔ built (`npm run build`) |
| `tests/application/daily.test.mjs` (16 tests), `tests/gas/gas-runtime.test.mjs` (+ daily flows on Sheets), `tests/ui/ui-smoke.mjs` (Chromium) | ✔ ชุดที่ 3 |
| `docs/USER_GUIDE_DAILY_TH.md` | ✔ ชุดที่ 3 |
| API_CONTRACT.md, openapi.yaml, DATA_DICTIONARY.md, 0001_init.sql | ✔ regenerated |

## Completed requirements (สะสม)

- §4 ports/adapters/DI จุดเดียว, DATA_ADAPTER แยก SERVICE_BACKEND, generator runtime (sync GAS / async Node)
- §5 AuthProvider: GatewayIdentityVerifier (HMAC request/response, aud/iss/exp/sub/tenant, checkRevoked ต้องเป็น true, cache ≤ 300 วินาทีด้วย SHA-256 ของ token), DemoIdentityVerifier + production gate, IdentityLinks, คำเชิญครั้งเดียว/มีอายุ/ผูกอีเมล/นับครั้งผิด, สมัครบัญชีแล้วยังไม่มีสิทธิ์, ห้ามให้บทบาทตนเอง (SoD), ระงับบัญชีมีผลทันที, logout ล้าง cache
- §6 ตรวจสิทธิ์ทุก operation, search กรองก่อนแบ่งหน้า, ข้อมูลระบุตัวขั้นต่ำที่ประตู (BASIC), เอกสารสุขภาพอ่านได้เฉพาะผู้มีสิทธิ์ + audit
- §7.1 นักเรียน/ห้อง/enrollment history/ผู้ปกครองหลายคน/ช่องทางติดต่อ + นำเข้า CSV/XLSX
- §7.2 ใบลา: ทั้งวัน/ครึ่งวัน/คาบ หลายวัน, ตรวจวันเรียน+enrollment+วันซ้อน, ย้อนหลังมีเหตุผล, ผู้ปกครองยืนยันแยกจากโรงเรียนอนุมัติ, เส้นทางอนุมัติตามกฎ, อนุมัติบางช่วง, ส่งกลับ/แก้ไขส่งใหม่ (revision), ถอน, ขอยกเลิก/ยกเลิกโดยผู้มีอำนาจ, เปลี่ยนผู้พิจารณา, เอกสารแนบ (magic bytes, ≤5 MB), คำนวณการมาเรียนย้อนหลังเมื่ออนุมัติ/ยกเลิก
- §7.3 ลงเวลาสาย: เวลาเซิร์ฟเวอร์, กฎตามวันที่มีผล, ปัดนาที, สแกนซ้ำคืนรายการเดิม (dedupe ภายใต้ lock), แถวรอ/เวลาที่ระบุเอง (มีเหตุผล), ออฟไลน์ (คิวขั้นต่ำ, ตรวจซ้ำ, REVIEW เมื่อผิดปกติ), เช็กชื่อ (ค่าเริ่มต้นมา, expected_version), ยืนยันขาดรายคน, ข้อมูลขัดกัน → งานตรวจสอบ, การแก้ไขย้อนหลังเป็นเหตุการณ์ใหม่ + audit + แจ้งเฉพาะเมื่อข้อเท็จจริงที่แจ้งไปเปลี่ยน, คำขอแก้ไขจากผู้ปกครอง → ครูพิจารณา (ปิดงานตรวจสอบอัตโนมัติ), ข้อยกเว้นการนับสาย (เก็บเวลาจริง)
- §7.4 Dashboard ตามขอบเขต ใช้ projection เดียวกับรายงาน + นิยามการนับ, polling ~60 วินาทีเฉพาะเมื่อแท็บแสดงอยู่
- §7.5 หน้าประวัตินักเรียน: FULL/BASIC ตามสิทธิ์, สถิติรายภาค/รายเดือน, timeline (รายการที่ถูกแก้ยังเห็น), ผู้ปกครอง (tel:/mailto:), ประวัติห้อง, งานค้าง
- §8 การแจ้งเตือน: สร้างใน changeset เดียวกับเหตุการณ์, ผู้รับจากความสัมพันธ์ที่ยืนยัน/การมอบหมายเท่านั้น, dedupe key, template มีเวอร์ชัน — **การส่งออกนอกระบบยังไม่ส่งมอบ (ชุดที่ 4)**
- §10 Sheets: StorageCatalog + partition ต่อภาคเรียน, TextFinder lookups (+ lookup ตาม school_date), batch preload รายห้อง, ScriptLock + MutationJournal + recovery, optimistic concurrency, unique/FK ใต้ lock, Jobs ถาวรพร้อม lease/checkpoint
- §13 หน้าจอ: Gate (สแกน/พิมพ์/ชื่อ/กล้องเมื่อรองรับ, Enter ยืนยัน, เสียง, ออฟไลน์), Roll Call, Leave, Approval Inbox, Profile, Dashboard; ภาษาไทย, ใช้ได้ที่ 375px, ป้องกันกดซ้ำ, ข้อความผิดพลาดรายช่อง, ไม่เก็บร่างลง storage
- §14 RPC allowlist, admin เฉพาะ editor + time window + owner, trigger handler ตรวจ triggerUid, health ไม่เปิดเผยความลับ, read-only mode บังคับที่ store
- §16 envelope/response/error contract, idempotency, expected_version, stale response guard, OpenAPI
- §17 คู่มือติดตั้งฉบับแรก, คู่มือใช้งานประจำวัน

## Pending requirements (ชุดถัดไป)

ชุดที่ 4: เรื่องติดตาม (cases, contact logs, appointments, กฎติดตามสาย/ขาดสะสม + cooldown), outbox worker (claim/lease/backoff), ตัวส่งอีเมล (MailApp) และ LINE, notification.list/acknowledge/monitor/resend, Node gateway (/line/webhook, /v1/identity/verify|revoke), การเชื่อมบัญชี LINE, docs/GATEWAY_TH.md, หน้าจอ Contact/Case Inbox และ Notification Monitor
ชุดที่ 5–8 ตาม MASTER_PROMPT §20

## Test results (Node 22.22.0, 2026-10-10)

| ชุดทดสอบ | คำสั่ง | ผล |
|---|---|---|
| domain + shared + purity + generated-freshness | `npm run test:domain` | automated pass |
| application (memory adapter) รวม daily 16 tests | `npm run test:app` | automated pass |
| GAS bundle บน emulator (12 tests รวม daily flows บน Sheets: gate dedupe, partition ภาคเรียน, roll call, dashboard, leave approve) | `npm run test:gas` | automated pass **(emulator — ไม่ใช่ Apps Script จริง)** |
| รวม | `npm test` | **95 pass / 0 fail** |
| UI smoke (gas-dist/App.html ใน Chromium headless 141, dispatcher จริงบน memory store, เวลาเครื่องต่างเขตจากโรงเรียน) | `npm run test:ui` | **19/19 automated pass** — gate scan+Enter, dashboard, roll call submit + verify, guardian leave (375px ไม่มี horizontal scroll), profile, correction request/decision, approval, exemption, ไม่มี JS/console error |
| PostgreSQL DDL | `tools/pg-local.mjs` + psql | manual verified (2026-10-10, PG 16): `0001_init.sql` ที่ regenerate ในชุดที่ 3 + `roles.sql` apply บน cluster ใหม่สำเร็จ — 57 ตาราง (56 + schema_migrations), index ใหม่ `(student_id, school_date)` ของ attendance_events/leave_segments |
| Apps Script จริง / Firebase / gateway จริง | — | **not run** — blocked by configuration (ยังไม่มีบัญชีโรงเรียน/โปรเจกต์ Firebase) |
| กล้อง BarcodeDetector / เครื่องสแกนจริง / IndexedDB บนอุปกรณ์โรงเรียน | — | **not run** — ต้องทดสอบกับอุปกรณ์จริงใน UAT |
| ผู้ใช้ screen reader / อุปกรณ์มือถือจริง | — | **not run** |

## Known issues / ข้อจำกัด

- พฤติกรรม apostrophe/TextFinder ของ Sheets จริงต้องยืนยันด้วย `adminSelfTest()` (D-007)
- rate limit บน CacheService เป็น best effort (ไม่ atomic)
- ผู้อ่านที่ไม่ถือ lock อาจเห็นผลบางส่วนของ operation ที่ process ตายกลางทางจนกว่า recovery จะรัน (D-006)
- เอกสารทางการบางส่วนตรวจผ่าน web search เท่านั้น (DECISIONS ท้ายไฟล์)
- Gate: เวลาแถวรอใช้วันที่ของโรงเรียน (Asia/Bangkok) แต่ไม่ตรวจว่าเวลาที่ระบุไม่อยู่ในอนาคต ฝั่งเซิร์ฟเวอร์เป็นผู้ตรวจ (MANUAL_TIME/QUEUE_BATCH)
- งาน openDay บน Sheets สำหรับ 1,500 คนยังไม่ได้วัดเวลาจริงบน Apps Script (ออกแบบเป็น job มี checkpoint; ต้องวัดใน UAT)
- Dashboard นับจาก projection ที่คำนวณสด (preload รายห้อง) — ห้องจำนวนมากอาจช้าบน Sheets; ชุดที่ 5 จะเพิ่ม snapshot/รายงาน

## Next exact task

ชุดที่ 4 — `src/application/ops/followup.js` (case.create/update/assign/close, contact.log, appointment.*), กฎติดตาม FOLLOWUP_LATE_COUNT/FOLLOWUP_ABSENCE (dedupe + cooldown) เป็น job หลังเหตุการณ์, `src/application/outbox/` worker (claim + lease + backoff, OUTCOME_UNKNOWN), `src/adapters/gas/mail.js` + LINE provider ผ่าน gateway, notification.list/acknowledge/monitor/resend, `gateway/` (Node: signature verify, identity verify/revoke, forward envelope ไป doPost, WebhookInbox), docs/GATEWAY_TH.md, หน้าจอ cases/notifications, tests

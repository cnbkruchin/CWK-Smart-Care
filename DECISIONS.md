# DECISIONS — Architecture Decision Records

รูปแบบ: บริบท → ทางเลือก → การตัดสินใจ → ผลที่ตามมา · สถานะ: Accepted เว้นแต่ระบุ
การตัดสินใจทั้งหมดอ้างอิง MASTER_PROMPT (เวอร์ชันพรอมต์ 1.0, 2026-10-10)

---

## D-001 แพลตฟอร์มระยะแรก: Google Apps Script + Google Sheets + Google Drive

- **บริบท:** ข้อกำหนดบังคับให้ข้อมูลกิจการนักเรียนระยะแรกอยู่บน GAS + Sheets และไฟล์แนบบน Drive
- **การตัดสินใจ:** UI = HtmlService SPA, server = Apps Script V8, ข้อมูล = Sheets (master + workbook รายภาคเรียน), ไฟล์ = Drive แบบ private ผ่าน `AttachmentStorage` port, งานเบื้องหลัง = installable time-driven trigger ตัวเดียว (`cronTick`) + ตาราง Jobs ถาวร
- **ผลที่ตามมา:** ไม่มี Firestore/ฐานข้อมูลอื่นในระยะแรก; Firebase ใช้เฉพาะบัญชีผู้ใช้ (D-003)

## D-002 Source เป็น ES modules + build เป็นไฟล์ GAS จริง

- **บริบท:** ต้องใช้ domain/application code ร่วมกับ Node REST backend และห้ามวาง `import/export` ลง .gs
- **ทางเลือก:** (ก) เขียน .gs แยก (ซ้ำโค้ด) (ข) TypeScript + clasp transpile (ค) ES modules + esbuild bundle
- **การตัดสินใจ:** (ค) — `tools/build-gas.mjs` ใช้ esbuild 0.28.2 bundle `src/entry/gas-main.js` เป็น IIFE ที่สร้าง global object เดียว `CWK` (target ES2019) ใน `gas-dist/Code.js` และมี `gas-dist/Entrypoints.js` ประกาศเฉพาะฟังก์ชันสาธารณะที่อนุญาต; frontend bundle ฝังเป็น `gas-dist/App.html`
- **ผลที่ตามมา:** ไม่มีชื่อ global ชนกัน; test `tests/gas/surface.test.mjs` ตรวจว่า top-level functions ใน gas-dist ตรงกับ allowlist

## D-003 Identity: Firebase Authentication / Google Identity Platform + verification gateway

- **บริบท:** ต้องยืนยันตัวตนฝั่ง server จริง ผู้ปกครองอยู่นอกโดเมนโรงเรียน; `Session.getActiveUser()` ใช้ไม่ได้ทุก deployment; GAS ไม่มีฟังก์ชันตรวจลายเซ็น RS256 (มีแต่การ*สร้าง*ลายเซ็น RSA) และ Firebase Admin SDK ไม่รันใน GAS
- **ทางเลือก:** (ก) decode JWT ใน GAS — **ห้าม** (ข) tokeninfo/accounts:lookup REST จาก GAS — ตรวจ revocation/disabled ได้จำกัดและต้องพิสูจน์คุณสมบัติเทียบเท่า (ค) gateway Node.js + Firebase Admin SDK
- **การตัดสินใจ:** (ค) — browser ใช้ Firebase JS SDK (email/password + email verification + password reset; แอปไม่เก็บรหัสผ่าน) ส่ง ID token ใน RPC envelope (runtime เท่านั้น); GAS เรียก `POST {gateway}/v1/identity/verify` แบบ server-to-server ที่ลงลายเซ็น HMAC (key id, timestamp, nonce); gateway เรียก `verifyIdToken(token, checkRevoked=true)` ตรวจ signature, `iss`, `aud`, `exp`, `sub`, revoked และ disabled แล้วตอบผลที่ลงลายเซ็นกลับ; GAS ตรวจลายเซ็นคำตอบ nonce และ aud/iss/exp ซ้ำ
- **Cache:** GAS เก็บ*ผลตรวจ*ใน CacheService ≤ 300 วินาที (key = SHA-256 ของ token ไม่เก็บ token) เพื่อเร่งความเร็ว — ไม่ใช่ที่เก็บสิทธิ์ถาวร; บทบาทและสถานะบัญชีอ่านจาก Sheets ทุกคำขอ
- **ช่วงเวลาที่สิทธิ์เก่าอาจยังมีผล:** (1) token ถูก revoke/บัญชีถูก disable ที่ Firebase: ≤ 5 นาที (อายุ cache) (2) ระงับบัญชีในแอป (Users.status = DISABLED) หรือเพิกถอนบทบาท: มีผลทันทีที่คำขอถัดไป (3) ID token หมดอายุตาม `exp` (Firebase ~1 ชั่วโมง)
- **ผลที่ตามมา:** ต้องมีบริการ gateway (ค่าใช้จ่ายดู docs/COSTS_TH.md); ถ้ายังไม่มี gateway เปิดได้เฉพาะ DEMO mode ใน DEV/STAGING; production gate ปฏิเสธทุกคำขอเมื่อ `CWK_ENV=PROD` แต่ `CWK_AUTH_MODE≠GATEWAY`
- **ยังไม่ส่งมอบ:** Google Workspace sign-in adapter และ LINE Login — เป็น adapter เพิ่มหลังทดสอบ origin/popup/redirect ใน sandbox จริง (docs/LIMITATIONS.md)

## D-004 Authorization: RBAC + data scope + effective dates ที่ server ทุก operation

- `src/domain/permissions.js` เป็น matrix เดียว (PERMISSIONS.md สร้างจากไฟล์นี้); facts (บทบาทที่มีผล, ห้องที่ปรึกษา/สอน/รักษาการแทน, ความสัมพันธ์ผู้ปกครองที่ยืนยัน) โหลดจาก repository ทุกคำขอ
- รายการ/ค้นหาใช้ `listScope()` กรอง*ก่อน* pagination; ห้ามโหลดทั้งโรงเรียนไป browser
- SYSTEM_ADMIN แยกจากงานข้อมูล (ไม่มี `student.read`)

## D-005 Partition และ StorageCatalog

- **การตัดสินใจ:** Master workbook (config, identity, students, leave, cases, files, jobs) + workbook ต่อภาคเรียน 3 ชุด: **Ops** (AttendanceEvents, RollCallSessions, AttendanceCorrections, MutationJournal, IdempotencyRecords, AuditEvents, ChangeLog, OperationMetrics), **Daily** (DailyAttendance), **Notify** (Notifications, NotificationRecipients, NotificationOutbox, NotificationAttempts, Acknowledgements, WebhookInbox)
- **เหตุผล:** `docs/CAPACITY.md` คำนวณจากจำนวนคอลัมน์จริง: เดิมที่รวม notifications ไว้ใน master ทำให้ master โต ~5 ล้านเซลล์/ปี (เกิน 10 ล้านใน ~2 ปี) จึงแยก Notify ต่อภาคเรียน; Daily ~51% ต่อภาคเรียนภายใต้สมมติฐาน 1,500 คน 100 วัน
- partition key = `Terms.code`; StorageCatalog map (logical_table, partition_key) → (workbook_id, sheet_name); repository เป็นผู้เลือก partition

## D-006 Atomicity บน Sheets: MutationJournal (redo log) + ScriptLock

- **บริบท:** SpreadsheetApp ไม่มี transaction หลาย range/หลาย workbook; Sheets API `spreadsheets.batchUpdate` atomic เฉพาะภายใน request เดียวของ spreadsheet เดียว และมีโควตาต่อผู้ใช้ต่อนาที (สคริปต์รันในบัญชีเจ้าของ = ผู้ใช้คนเดียว)
- **การตัดสินใจ:** ทุก mutation ผ่าน `MutationStore.commit` ใต้ `LockService.getScriptLock()` (timeout 10 วินาที → `LOCK_TIMEOUT` retryable): ตรวจ idempotency → ตรวจ expected version/unique ใต้ lock → เขียน journal `PREPARED` (write-set ทั้งหมด, แบ่ง part ≤ 45,000 ตัวอักษร) → apply ทุกการเขียน → `SpreadsheetApp.flush()` → `COMMITTED` → ปล่อย lock ใน finally
- **Recovery:** ก่อน commit ทุกครั้งและใน `cronTick` จะ roll-forward รายการ `PREPARED` ที่ค้าง (การเขียนเป็น "ตั้งค่าแถว id=X เป็น version v" จึงทำซ้ำได้); ถ้าพบแถวถูกแก้นอกระบบจนไม่ตรง → `RECOVERY_REQUIRED` ให้ผู้ดูแลตรวจ
- **ข้อจำกัดที่ยอมรับ:** ผู้อ่านที่ไม่ถือ lock อาจเห็นผลบางส่วนของ operation ที่ process ตายกลางทาง จนกว่า recovery จะเติมให้ครบ (ไม่เกินรอบ trigger ถัดไป); worker แจ้งเตือนรัน recovery ก่อน claim จึงไม่ส่งข้อความของ operation ที่ไม่ครบ; ScriptLock ไม่ครอบคลุมการแก้ Sheet ด้วยมือหรือโปรเจกต์อื่น
- **Sheets API batchUpdate:** เก็บเป็นทางเลือก adapter ในอนาคตเมื่อย้ายสคริปต์ไป standard Cloud project และยืนยันโควตา

## D-007 การแทนค่าเซลล์: ข้อความนำหน้าด้วย apostrophe

- เขียนผ่าน `Range.setValues` โดยค่า string ทุกตัวนำหน้า `'` เพื่อบังคับเป็นข้อความ (รักษา `00123`, ไม่ตีความ `=`/`+`/`-`/`@` เป็นสูตร/ตัวเลข); อ่านด้วย `getValues()`
- อ้างอิงพฤติกรรม Sheets ที่ quote prefix ไม่ถูกเก็บเป็นส่วนของค่า — **ต้องยืนยันบนบัญชีจริงด้วย `adminSelfTest()`** ก่อนนำเข้าข้อมูลจริง (รายการ UAT)
- emulator ที่ใช้ทดสอบใน Node จำลองพฤติกรรมนี้ตามสมมติฐานเดียวกัน (ไม่ใช่หลักฐานแทน GAS จริง)

## D-008 DailyAttendance เป็น projection แบบ dense ID คงที่

- id = UUIDv5(student_id|school_date); job `attendance.openDay` สร้างแถว UNKNOWN ให้ทุกคนที่มีสิทธิ์มาเรียนตอนเช้า (ทีละ ≤ 200 คนต่อ mutation); ทุกคำสั่งที่เปลี่ยน input คำนวณ projection ใหม่และเขียนใน commit เดียวกันพร้อม expected version
- รายงานใช้ projection เดียวกับ dashboard และเติมนักเรียนที่ยังไม่มีแถวด้วยฟังก์ชัน projection เดียวกัน (กรณี job ไม่ได้รัน)

## D-009 การเช็กชื่อเก็บเฉพาะข้อยกเว้น

- `RollCallSessions` ต่อห้องต่อวัน (ผู้ส่ง เวลา roster hash) + AttendanceEvents เฉพาะ ไม่พบตัว/สายในห้อง/แจ้งลา/แก้กลับเป็นมา; นักเรียนในรายชื่อตาม enrollment วันนั้นที่ไม่มีข้อยกเว้น = มาตามการเช็กชื่อ
- ลดจำนวนแถวเหตุการณ์ ~20 เท่าโดยยังสร้าง projection ใหม่ได้ครบ

## D-010 LINE webhook gateway (Cloud Run, Node.js)

- เอกสาร Web Apps ของ GAS ไม่ระบุ request headers ใน `doPost(e)` จึงตรวจ `x-line-signature` ใน GAS ไม่ได้
- gateway: อ่าน raw body (จำกัด 1 MB) → HMAC-SHA256(channel secret) เทียบแบบ constant-time ก่อน parse → แยกทีละ event → ส่ง envelope `{v, kid, ts, nonce=webhookEventId, payload(สตริง JSON เดิม), sig}` ไป GAS `/exec` → GAS ตรวจ HMAC, เวลา ±300 วินาที, dedupe ด้วย `WebhookInbox(source, webhook_event_id)`, schema แล้วบันทึกถาวรก่อนตอบ `{ok:true, stored:true}`
- gateway ตอบ LINE 200 **หลัง** GAS ยืนยันบันทึกเท่านั้น; ถ้า GAS ล้มเหลวตอบ 503 และพึ่ง *webhook redelivery* ของ LINE (ต้องเปิดใน LINE Developers Console) — ไม่มี queue เสริมในระยะแรก
- gateway เดียวกันให้บริการ identity verification แต่แยก endpoint, secret และ key id

## D-011 Outbox และความหมายของการส่ง

- outbox เขียนใน commit เดียวกับเหตุการณ์ (journal), dedupe_key = `type|source_entity|recipient|channel|purpose`
- LINE: `X-Line-Retry-Key` คงที่ต่อ outbox row ตั้งแต่ครั้งแรก; 409 = เคยรับแล้ว → PROVIDER_ACCEPTED; ยืนยันจากผลค้นหาเอกสารว่า key ป้องกันซ้ำแต่ไม่รับประกันการส่งถึง (อายุของ key ยังไม่ได้ยืนยันจากหน้าเอกสารตรง → ตั้ง retry window เริ่มต้น 12 ชั่วโมงและให้ผู้ติดตั้งตรวจ)
- Email (MailApp) ไม่มี idempotency key: ถ้า lease หมดระหว่างส่ง (ไม่ทราบผล) → `FAILED_FINAL` + `OUTCOME_UNKNOWN` ไม่ส่งซ้ำอัตโนมัติ; เจ้าหน้าที่กด resend ได้ (สร้างการส่งใหม่)
- PROVIDER_ACCEPTED ≠ อ่านแล้ว; การรับทราบเก็บแยก

## D-012 การย้ายข้อมูล: maintenance snapshot + portable JSONL + PostgreSQL อ้างอิง

- full snapshot ต้อง freeze ที่ server (`CWK_SYSTEM_MODE=READ_ONLY` ตรวจใน dispatcher และ MutationStore) รอ in-flight ด้วยการถือ ScriptLock + recovery journal ก่อนบันทึก high-water marks
- package = manifest + JSONL canonical (checksum ต่อ chunk) + attachments (bytes จริง + SHA-256) + csv (กัน formula injection) + reports
- CLI `tools/migrate.mjs` (validate / plan / import --dry-run / import --apply / reconcile) ลง staging schema ก่อน merge; PostgreSQL 16 เป็นปลายทางอ้างอิง

## D-013 REST backend อ้างอิง: Node.js (node:http) + pg + application layer เดิม

- ใช้ application services ชุดเดียวกับ GAS ผ่าน port; PostgreSQL MutationStore = transaction เดียว (outbox ใน transaction)
- ไม่ใช้ web framework เพื่อลด dependency; OpenAPI + contract tests
- GAS `HttpApiAdapter` (SERVICE_BACKEND=REST) ส่ง credential ของผู้ใช้ต่อให้ backend ตรวจเอง — GAS ไม่เขียนข้อมูลเมื่อใช้ REST (writer เดียว)

## D-014 Application layer แบบ generator (sync บน GAS / async บน Node)

- **บริบท:** SpreadsheetApp เป็น synchronous, `google.script.run` ต้องได้ค่าคืนทันที (คืน Promise ไม่ได้) ขณะที่ `pg` เป็น asynchronous
- **การตัดสินใจ:** service เขียนเป็น generator (`function*`) และ `yield` ผลของ port; `runSync` ใช้บน GAS, `runAsync` ใช้บน Node — โค้ดกฎธุรกิจชุดเดียว
- **ผลที่ตามมา:** ผู้ดูแลต้องเข้าใจรูปแบบ `yield` แทน `await` (อธิบายใน ARCHITECTURE.md §5)

## D-015 Frontend

- HtmlService SPA แบบ vanilla JS (bundle ด้วย esbuild) — ไม่มี framework เพื่อลดขนาดและข้อจำกัด sandbox; render ด้วย DOM API/textContent (กัน XSS)
- Firebase JS SDK **compat 10.14.1** โหลดจาก `https://www.gstatic.com/firebasejs/10.14.1/` (Apache-2.0) — พึ่ง CDN ของ Google ที่ระบุเวอร์ชัน; ต้องทดสอบใน sandbox iframe จริง
- `future-platform/web`: starter แบบ vanilla ES modules (ไม่ใช้ React/Next.js เพื่อไม่ต้องมี build chain เพิ่ม) แสดงการเปลี่ยน transport/auth; รายการหน้าที่ยังต้องย้ายระบุใน README ของ starter

## D-016 เอกสาร PDF/XLSX/การนำเข้า XLSX

- PDF: Google Docs template (สร้างโดย setup) → เติมตาราง → pin header rows ด้วย Docs advanced service (`pinTableHeaderRows`) → `getAs('application/pdf')`; เลขหน้าอยู่ใน footer ของ template (ผู้ติดตั้งแทรก page number ครั้งเดียวตามคู่มือ — Docs API ไม่มีคำสั่งแทรก page number); ไม่ใช้ HTML→PDF
- XLSX export: สร้าง spreadsheet ชั่วคราวแล้ว export ผ่าน Drive (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) แล้วลบไฟล์ชั่วคราว — ต่างจาก CSV ที่เปลี่ยนนามสกุล
- XLSX import: แปลงด้วย Drive advanced service (upload with conversion เป็น Google Sheets ชั่วคราว) แล้วอ่านค่า; CSV ใช้ `Utilities.parseCsv`; ฝั่ง Node ใช้ parser RFC 4180 ของโครงการ (ไม่มี dependency)

## D-017 เวลา

- Asia/Bangkok ใช้ offset คงที่ +07:00 (ไม่มี DST ตั้งแต่ 1920) ใน domain; appsscript.json `timeZone = Asia/Bangkok`; ทุก spreadsheet ตั้ง timezone เดียวกันใน setup

## D-018 Deployment: Execute as owner + Who has access ตามนโยบาย + in-app auth

- ผู้ปกครองนอกโดเมนจึงใช้ "Execute as: Me" (สิทธิ์อ่าน Sheets อยู่ที่บัญชีเจ้าของ ผู้ใช้ไม่ต้องมีสิทธิ์ Sheet) และ "Who has access: Anyone" — **การเปิดหน้าได้ไม่ใช่สิทธิ์อ่านข้อมูล** ทุก RPC ต้องผ่าน auth ของแอป
- ถ้านโยบาย Workspace ห้าม "Anyone" ต้องเลือกช่องทางที่ผู้ดูแลองค์กรอนุญาต (docs/INSTALL_GAS_TH.md §9–10) ห้ามเลี่ยงด้วยการปิด auth

## D-019 Offline ชั่วคราว

- IndexedDB เก็บเหตุการณ์ขั้นต่ำ (local UUID, idempotency key, รหัสที่สแกน, station, เวลาเครื่อง, claimed user) ไม่เก็บ token/รายชื่อทั้งโรงเรียน
- sync ใช้ token ปัจจุบัน ตรวจสิทธิ์ใหม่ ตรวจ clock drift (> 10 นาทีหรือเวลาอนาคต → review) และ idempotency key เดิม; ผู้ส่งที่ server ยืนยันเก็บแยกจาก claimed user

## D-020 กฎติดตาม: เวลาประเมิน การกันซ้ำ และการเปิดใหม่ (ชุดที่ 4)

- ประเมินเป็น job ประจำวันหลังเลิกเรียน (`followup.evaluate_time`) เฉพาะนักเรียนที่มีสาย (นับ) หรือขาด (ยืนยัน) ในวันนั้น + เก็บตกวันเรียนก่อนหน้าถ้า tick ไม่ได้รันหลังเลิกเรียน — ไม่ประเมินทุกครั้งที่มีเหตุการณ์ เพื่อลด quota และไม่แจ้งเตือนกลางวันซ้ำ ๆ
- dedupe_key = `ประเภท|student_id` + partial unique (status ≠ CLOSED) → มีเรื่องจากกฎเดียวกันเปิดได้เรื่องเดียว แม้ job รันพร้อมกัน
- ปิดเรื่องแล้ว: `cooldown_until` = วันเรียนที่ N หลังวันปิด และนับเฉพาะข้อเท็จจริง **หลัง**วันปิด (`since_date`) — เปิดใหม่ด้วยมือได้ (`case.reopen`) ถ้าไม่มีเรื่องประเภทเดียวกันเปิดอยู่
- หลักฐานเก็บใน `trigger_evidence_json` (รายการ DailyAttendance ที่นับ, ช่วงวัน, เกณฑ์, ระบุว่าเป็นค่าตัวอย่างหรือไม่) ณ เวลาที่เปิด — การแก้ไขย้อนหลังภายหลังไม่ปิดเรื่องอัตโนมัติ ให้ครูพิจารณา

## D-021 การส่งออกนอกระบบใน DEV/STAGING

- `env ≠ PROD` → ส่งออกได้เฉพาะที่อยู่ใน `CWK_NOTIFY_ALLOWLIST` (เทียบแบบไม่สนตัวพิมพ์); ว่าง = ไม่ส่งเลย รายการอื่นเป็น CANCELLED (`NON_PROD_NOT_ALLOWLISTED`) — ข้อความในแอปยังสร้างตามปกติ
- PROD ต้องไม่มี allowlist (production gate ปฏิเสธ)

## D-022 ข้อความเข้าและปุ่มตอบกลับทาง LINE

- ปุ่ม ACK/CALLBACK เป็น postback `cwk=ack|callback&r=<recipient_id>`; ระบบหา `ChannelBindings` ACTIVE ของ LINE user ผู้กด แล้วทำรายการ **ในนามผู้ใช้นั้น** และเฉพาะเมื่อ recipient เป็นของผู้ใช้นั้น — ข้อมูล postback ที่ถูกคัดลอกไปใช้โดย LINE user อื่นจะถูกเพิกเฉย
- ข้อความตัวอักษรจากผู้ปกครองที่ผูกบัญชี → `ContactLogs` INBOUND (follow_up_required) ต่อบุตรหลานที่เชื่อมโยงทุกคน เพราะไม่รู้ว่าข้อความหมายถึงคนใด; ตอบกลับ/ปิดด้วยบันทึกที่อ้าง `supersedes_id`
- ไม่ดาวน์โหลดสื่อ (รูป/ไฟล์) และไม่ประมวลผล event จากกลุ่ม/ห้องแชต — ลดการเก็บข้อมูลอ่อนไหวโดยไม่จำเป็น
- ประมวลผล event ทันทีหลังบันทึกถาวร (เพื่อใช้ reply token ที่อายุสั้น); ถ้าล้มเหลว tick ประมวลผลซ้ำ (≤ 5 ครั้ง) โดยไม่ตอบกลับ

## D-023 รายงาน: ดูบนจอ vs ฉบับไฟล์ (ชุดที่ 5)

- `report.preview` คำนวณสด ไม่บันทึก (จำกัด 500 แถว แสดงว่าตัด) — ใช้ดูเร็ว; ไฟล์ CSV/XLSX/PDF สร้างผ่าน `report.run` เป็น `ReportRuns` + งาน `report.render` เบื้องหลัง เพื่อไม่ให้ RPC เกิน 6 นาที
- งานสร้างไฟล์รันด้วยสิทธิ์ของ**ผู้ขอ** (`principalForBoundUser`) ณ เวลาสร้าง — สิทธิ์ที่ถูกถอนก่อนงานรันมีผลทันที; ดาวน์โหลดตรวจสิทธิ์ใหม่ + checksum ทุกครั้งและบันทึก audit
- ทุกฉบับเก็บ ตัวกรอง, `as_of`, schema version, เวอร์ชันกฎ และผู้สร้าง; ฉบับที่**ล็อก**แล้วไม่เปลี่ยน — "สร้างฉบับใหม่" ได้ revision ใหม่ ฉบับเดิมเป็น SUPERSEDED (ยังดาวน์โหลดได้) — ไม่แก้ไฟล์เดิมทับ
- ค่าในไฟล์ข้อมูล (CSV/XLSX) ใช้ ISO ค.ศ. ตามเวลาท้องถิ่น (นำไปคำนวณต่อได้); PDF และหน้าจอใช้ พ.ศ.; CSV ใส่ `'` หน้าข้อความที่ขึ้นต้น `= + - @ TAB CR`
- จำกัดแถวต่อรูปแบบ (CSV 100,000 / XLSX 50,000 / PDF 2,000) และช่วงวันต่อรายงาน — เกินแล้วตอบ `VALIDATION_ERROR` พร้อมจำนวนแถวและคำแนะนำให้ใช้ตัวกรองแคบลง แทนที่จะตัดเงียบ ๆ (บนจอแสดง 500 แถวแรกพร้อมแจ้งว่าตัด)
- XLSX สร้างจาก Google Sheet ชั่วคราว (Plain text) แล้ว export เป็น .xlsx จริง; PDF จาก Docs template ที่ปักหมุดหัวตาราง — ไม่ใช้ไลบรารี JS ภายนอกบน GAS

## D-024 สำรองข้อมูลแบบ snapshot และ restore ไป environment ใหม่เท่านั้น

- สำรองประจำคืน: คัดลอกทุก workbook (master + partition) **ภายใต้ ScriptLock** เพื่อให้ได้ภาพข้อมูลที่สอดคล้องกัน + `manifest.json` (sha256 ของ manifest เก็บใน `BackupRuns`) + `config.json` (เฉพาะค่าที่ไม่ใช่ความลับ) + รายการไฟล์แนบ; ลบชุดเก่าเกิน `backup.retention_days`
- ไฟล์แนบไม่ถูกคัดลอกในชุดประจำคืน (อยู่ในโฟลเดอร์เดิมซึ่งไม่ถูกลบโดยระบบ) — ชุดส่งออกแบบ portable (ชุดที่ 6) รวมไฟล์แนบ
- `adminRestoreSnapshot` ปฏิเสธเมื่อ environment มี `CWK_MASTER_SPREADSHEET_ID` อยู่แล้ว — ไม่มีการ restore ทับระบบจริง; การกู้ระบบจริงคือสลับไปใช้ environment ที่ restore และตรวจแล้ว (OPERATIONS_TH §4, §6)
- PROD แสดง FAIL ใน System Health จนกว่าจะมีบันทึกผลทดสอบ restore — ทำให้การ "มีสำรองแต่ไม่เคยลองกู้" มองเห็นได้

## D-025 Retention: ล้างเฉพาะบันทึกระบบ ไม่ลบข้อมูลส่วนบุคคลอัตโนมัติ

- ล้างเป็น**ทั้ง partition ภาคเรียน**ที่ครบระยะของตารางบันทึกระบบ (IdempotencyRecords 30 วัน, MutationJournal 30, WebhookInbox 90, OperationMetrics 365, NotificationAttempts 365 — นับจากวันสิ้นภาคเรียน) และงาน `Jobs` ที่เสร็จแล้วเกิน 90 วัน — ต้องกดยืนยันโดย SYSTEM_ADMIN และบันทึก audit; ไม่ลบทีละแถวกระจัดกระจายใน Sheets
- ข้อมูลนักเรียน/ผู้ปกครอง/การมาเรียน/การลา/การติดตาม/Audit **ไม่ลบอัตโนมัติ** จนกว่าโรงเรียนจะอนุมัตินโยบายการลบ (workflow ลบข้อมูลส่วนบุคคลยังไม่ส่งมอบ — LIMITATIONS)

---

## เอกสารทางการที่ตรวจ (2026-10-10)

สภาพแวดล้อมพัฒนามี network policy ปิดการเข้าถึง developers.google.com, developers.line.biz และ gstatic.com โดยตรง จึงตรวจผ่าน web search เท่านั้น:

| เอกสาร | สถานะการตรวจ | ข้อเท็จจริงที่ใช้ |
|---|---|---|
| Apps Script quotas | ผ่านผลค้นหา (ข้อความจากหน้าเอกสาร) | 6 นาที/execution; simultaneous executions 30/user, 1,000/script; triggers 20/user/script; trigger total runtime/day 90 นาที (consumer) / 6 ชม. (Workspace) ยืนยันจากแหล่งรองเท่านั้น → **ต้องตรวจหน้าโควตาก่อนติดตั้ง** |
| LINE retry requests | ผ่านผลค้นหา | `X-Line-Retry-Key` = UUID; ใช้กับ push/multicast/narrowcast/broadcast; ส่งซ้ำหลังรับแล้วได้ 409 พร้อม `x-line-accepted-request-id`; ไม่รับประกันการส่งถึง; **อายุ key ยังไม่ยืนยัน** |
| LINE webhook signature, account linking, LINE Notify termination | ตามความรู้ก่อนหน้า (ยังไม่ได้เปิดหน้าเอกสาร) | HMAC-SHA256 ด้วย channel secret บน raw body, Base64; link token → accountLink event + nonce; LINE Notify ยุติบริการแล้ว (ไม่ใช้) |
| Firebase verifyIdToken / Admin SDK | ตามความรู้ก่อนหน้า | `verifyIdToken(idToken, true)` ตรวจ revoked/disabled; npm registry แสดง firebase-admin 14.5.0 เป็นรุ่นล่าสุด (2026-10-10); gateway ตรึง 14.4.0 ซึ่งเป็นรุ่นที่ติดตั้งและตรวจ API จริงใน scratchpad |
| HtmlService / Web Apps / Session / LockService / triggers / batchUpdate / JDBC | ตามความรู้ก่อนหน้า | ระบุเป็นสมมติฐานใน docs/LIMITATIONS.md และมีรายการทดสอบบน deployment จริง |

รายการที่ "ตามความรู้ก่อนหน้า" ต้องตรวจซ้ำโดยผู้ติดตั้งตาม checklist ใน docs/INSTALL_GAS_TH.md §0

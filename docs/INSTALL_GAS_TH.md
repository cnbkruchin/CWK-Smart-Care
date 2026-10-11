# คู่มือติดตั้ง CWK Smart Care บน Google Apps Script

> สำหรับครู/ผู้ดูแลระบบของโรงเรียน · ทำตามลำดับ · ห้ามใส่รหัสลับจริงในแชตหรือในไฟล์ที่ commit
> สถานะ: ขั้นตอนนี้ทดสอบกับ emulator ในเครื่องพัฒนาแล้ว แต่ **ยังไม่ได้ทดสอบบนบัญชี Google ของโรงเรียนจริง** — ทุกขั้นที่มีเครื่องหมาย 🧪 คือรายการตรวจรับที่ต้องบันทึกผลใน docs/UAT_CHECKLIST_TH.md

## 0. ตรวจเอกสารและโควตาปัจจุบันก่อนเริ่ม (บันทึกวันที่ที่ตรวจ)

- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas) — ชนิดบัญชี (Google Workspace for Education / บัญชีทั่วไป) กำหนดโควตา trigger runtime/วัน, อีเมล/วัน, UrlFetch/วัน
- [Web Apps](https://developers.google.com/apps-script/guides/web) — การตั้ง Execute as / Who has access
- [LINE Messaging API retry](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/) — อายุของ retry key (ปรับ `CWK_LINE_RETRY_WINDOW_HOURS` ให้น้อยกว่า)
- ตัวเลขที่ระบบอ้างอิง (ตรวจ 2026-10-10 ผ่านผลค้นหา): 6 นาที/execution, simultaneous 30/user, 1,000/script, trigger 20/user/script, trigger total runtime 90 นาที/วัน (บัญชีทั่วไป) หรือ 6 ชั่วโมง/วัน (Workspace) — **แนะนำให้ใช้บัญชี Google Workspace ของโรงเรียน**

## 1. เตรียมบัญชีและเจ้าของระบบ

1. ใช้บัญชี Google ของ**โรงเรียน** (ไม่ใช่บัญชีส่วนตัวครู) เป็นเจ้าของสคริปต์ ไฟล์ Sheets และโฟลเดอร์ Drive
2. กำหนดผู้รับผิดชอบระบบอย่างน้อย 2 คน (เจ้าของหลัก/สำรอง) — ผู้ที่แก้ไขสคริปต์ได้จะอ่าน Script Properties (รวมรหัสลับ) ได้ จึงต้องจำกัดรายชื่อ editor
3. บันทึกรายชื่อผู้มีสิทธิ์ใน docs/OPERATIONS_TH.md §เจ้าของระบบ

## 2. แยก DEV / STAGING / PROD

สร้าง **3 โปรเจกต์ Apps Script แยกกัน** (แต่ละโปรเจกต์มี Script Properties, Sheets, Drive folder, deployment และ trigger ของตัวเอง) และใช้ Firebase project แยกกันอย่างน้อย DEV กับ PROD

| ค่า | DEV | STAGING | PROD |
|---|---|---|---|
| `CWK_ENV` | DEV | STAGING | PROD |
| `CWK_AUTH_MODE` | DEMO หรือ GATEWAY | GATEWAY | **GATEWAY (บังคับ)** |
| ข้อมูล | สังเคราะห์ (adminSeedDemo) | สังเคราะห์/ข้อมูลที่ได้รับอนุญาต | ข้อมูลจริง |
| `CWK_NOTIFY_ALLOWLIST` | อีเมลทดสอบ | อีเมลทดสอบ | **ว่าง** |

ระบบปฏิเสธทุกคำขอเมื่อ PROD ตั้งค่าไม่ปลอดภัย (production gate ใน `src/adapters/gas/config.js`)

## 3. ตั้งค่า Identity Provider (Firebase Authentication / Google Identity Platform)

1. สร้าง Firebase project (หรือ Identity Platform) ต่อ environment → Authentication → Sign-in method → เปิด **Email/Password**
2. Templates: ตั้งภาษาไทยของอีเมลยืนยันและรีเซ็ตรหัสผ่าน
3. Settings → Authorized domains: เพิ่ม `script.google.com` และ `*.googleusercontent.com` ที่ใช้แสดงหน้าเว็บ 🧪 (ทดสอบ sign-in/verify/reset จากหน้า /exec จริง)
4. Google Cloud Console → APIs & Services → Credentials: จำกัด **API key** ของเว็บ (HTTP referrers) ให้เฉพาะโดเมนที่ใช้ — API key เป็นค่าสาธารณะ ไม่ใช่การป้องกันข้อมูล
5. สำหรับบัญชีผู้ดูแล: เปิด MFA (Identity Platform รองรับ SMS/TOTP MFA ตามแพ็กเกจ) 🧪
6. Deploy **gateway** (ดู docs/GATEWAY_TH.md) และจดค่า URL, key id, shared secret

ค่าที่ได้: `CWK_FIREBASE_PROJECT_ID`, `CWK_FIREBASE_WEB_API_KEY`, `CWK_FIREBASE_AUTH_DOMAIN`, (`CWK_FIREBASE_TENANT_ID` ถ้าใช้ tenant), `CWK_GATEWAY_URL`, `CWK_GATEWAY_KEY_ID`, `CWK_GATEWAY_SECRET`

> ยังไม่มี gateway? ใช้ `CWK_AUTH_MODE=DEMO` ได้เฉพาะ DEV/STAGING เพื่อทดลองระบบ — ห้ามใช้กับข้อมูลจริง

## 4–5. สร้างโปรเจกต์และใส่โค้ด

### ทางเลือก A: Apps Script Editor (ไม่ใช้ command line)

1. เปิด https://script.google.com → New project → ตั้งชื่อ `CWK Smart Care (PROD)`
2. Project Settings → ติ๊ก "Show appsscript.json manifest file in editor"
3. คัดลอกไฟล์จากโฟลเดอร์ `gas-dist/` ของ release ทีละไฟล์ (ชื่อไฟล์ต้องตรง):
   | ไฟล์ใน gas-dist | สร้างใน Editor เป็น |
   |---|---|
   | `Code.js` | Script ชื่อ `Code` (แทนที่เนื้อหาเดิมทั้งหมด) |
   | `Entrypoints.js` | Script ชื่อ `Entrypoints` |
   | `App.html` | HTML ชื่อ `App` |
   | `appsscript.json` | แทนเนื้อหา manifest |
4. ตรวจว่า Code อยู่ลำดับก่อน Entrypoints (ไม่บังคับ แต่ช่วยอ่านง่าย)

### ทางเลือก B: Git + clasp

```bash
npm ci && npm run build           # สร้าง gas-dist/ จาก src/
npx @google/clasp login
cp .clasp.json.example .clasp.json # ใส่ scriptId ของโปรเจกต์ (ไม่ commit ไฟล์นี้)
npx @google/clasp push            # rootDir = gas-dist
```

## 6. Script Properties และ Google services

1. Project Settings → Script properties → ใส่ค่าตาม `ScriptProperties.example` (ค่าที่ขึ้นต้น [SECRET] ใส่ค่าจริงที่นี่เท่านั้น)
2. Services (Advanced): เปิด **Drive API (v3)** และ **Google Docs API (v1)** — appsscript.json ระบุไว้แล้ว
3. Scopes ที่ระบบขอ (ใน appsscript.json) และเหตุผล:
   | scope | ใช้ทำอะไร |
   |---|---|
   | spreadsheets | อ่าน/เขียนข้อมูลใน Sheets |
   | drive | สร้างโฟลเดอร์/ไฟล์แนบ/ไฟล์ส่งออก, แปลง XLSX |
   | documents | สร้างรายงาน PDF จาก Docs template |
   | script.external_request | เรียก gateway, LINE API |
   | script.send_mail | ส่งอีเมลแจ้งเตือน |
   | script.scriptapp | ติดตั้ง trigger |
   | userinfo.email | ตรวจตัวเจ้าของสคริปต์ในฟังก์ชัน admin (ไม่ใช้ระบุตัวผู้ใช้เว็บ) |

## 7. รัน setup (idempotent — ไม่ลบข้อมูลเดิม)

1. Script properties: ตั้ง `CWK_ADMIN_TASKS_ENABLED_UNTIL` = เวลา UTC ไม่เกิน 2 ชั่วโมงข้างหน้า เช่น `2026-10-10T05:00:00Z` (ปลดล็อกฟังก์ชัน admin ชั่วคราว)
2. Editor → เลือกฟังก์ชัน `adminSetup` → Run → อนุญาตสิทธิ์
3. ผลใน Execution log: สร้างโฟลเดอร์ Drive แบบ private, master spreadsheet, ทุกชีต, StorageCatalog, ผู้ใช้ระบบ, ผู้ดูแลคนแรก (สิทธิ์งานระบบเท่านั้น) และ **รหัสคำเชิญครั้งเดียว (อายุ 24 ชม. ผูกกับอีเมลของผู้รัน)**
4. รัน `adminSelfTest` — ต้องได้ `cell_encoding.ok: true` (ตรวจว่า `00123`, `=1+1`, `+66…`, ภาษาไทย อ่านกลับได้ตรง) 🧪 บันทึกผลเป็นหลักฐาน
5. (DEV/STAGING) รัน `adminSeedDemo` เพื่อสร้างข้อมูลสังเคราะห์
6. ลบหรือทำให้ `CWK_ADMIN_TASKS_ENABLED_UNTIL` หมดอายุหลังทำเสร็จ

การอัปเกรด schema ในอนาคต: สำรองข้อมูล (docs/OPERATIONS_TH.md) → รัน `adminSetup` ของเวอร์ชันใหม่ (เพิ่มเฉพาะชีต/คอลัมน์ใหม่ตาม migration) → `adminSchemaCheck` → ตรวจรับ; ห้ามลบชีตเพื่อสร้างใหม่

### 7.1 แม่แบบรายงาน PDF (ทำครั้งเดียว)

`adminSetup` สร้าง Google Docs แม่แบบรายงาน (A4, ฟอนต์ Sarabun, ตัวแทน `{{title}}` `{{table}}` ฯลฯ) ในโฟลเดอร์ระบบ และบันทึก id ไว้ที่ `CWK_REPORT_TEMPLATE_DOC_ID`

1. เปิดแม่แบบจาก Drive → ดับเบิลคลิกส่วนท้ายกระดาษ (footer) → **แทรก → หมายเลขหน้า** (Apps Script/Docs API ไม่มีคำสั่งแทรกเลขหน้า จึงต้องทำด้วยมือครั้งเดียว)
2. แก้หัวกระดาษ/ตราโรงเรียนได้ แต่**ห้ามลบตัวแทน** `{{...}}` — ถ้าลบ รายงาน PDF จะขาดส่วนนั้น
3. ห้ามแชร์แม่แบบแบบ "ทุกคนที่มีลิงก์"
4. 🧪 สร้างรายงาน R01 เป็น PDF จากหน้า "รายงาน" → ตรวจภาษาไทย หัวตารางซ้ำทุกหน้า เลขหน้า และช่องลงนาม (รายละเอียด docs/REPORTS_TH.md)

### 7.2 การสำรองและทดสอบ restore

- cronTick สำรองข้อมูลทุกคืนตามค่า `backup.nightly_time` (ค่าเริ่มต้น 01:30) เก็บ `backup.retention_days` วัน — ดูผลที่ "สถานะระบบ → การสำรองข้อมูล"
- ทดสอบ restore ไป **environment ใหม่** ด้วยฟังก์ชัน `adminRestoreSnapshot` และ Script Property `CWK_RESTORE_FROM_FOLDER_ID` ตามขั้นตอนใน docs/OPERATIONS_TH.md §4 — ระบบปฏิเสธการ restore ทับ environment ที่มีข้อมูลแล้ว
- PROD: หน้า "สถานะระบบ" แสดง FAIL ที่ `backup.restore_tested` จนกว่าจะบันทึกผลทดสอบ restore อย่างน้อยหนึ่งครั้ง

## 8. เขตเวลา

- appsscript.json ตั้ง `Asia/Bangkok`; setup ตั้ง timezone ของทุก spreadsheet เป็น Asia/Bangkok
- 🧪 ทดสอบลงเวลาช่วง 06:00–07:00 น. (ข้ามวัน UTC) ว่าวันเรียนถูกต้อง

## 9. Execute as และสิทธิ์อ่าน Sheets

| ตัวเลือก | ผล | เลือกใช้ |
|---|---|---|
| Execute as: **Me (เจ้าของ)** | สคริปต์อ่าน/เขียน Sheets ด้วยบัญชีเจ้าของ ผู้ใช้เว็บไม่ต้องมีสิทธิ์ในไฟล์ Sheets เลย | ✔ (ผู้ปกครองอยู่นอกโดเมน) |
| Execute as: User accessing | ผู้ใช้แต่ละคนต้องมีสิทธิ์แก้ไข Sheets → เปิดข้อมูลดิบให้ทุกคน | ✖ |

ผลที่ตามมา: `Session.getActiveUser()` ไม่ใช่ตัวตนของผู้ใช้เว็บ ระบบจึงใช้ Firebase token + gateway เท่านั้น

## 10. Who has access

- ต้องการให้ผู้ปกครองที่ไม่มีบัญชี Google ใช้ได้: **Anyone** (ไม่ต้องลงชื่อ Google) — การเปิดหน้าได้**ไม่ใช่**สิทธิ์อ่านข้อมูล ทุก RPC ต้องผ่าน token และสิทธิ์ของแอป
- ถ้านโยบาย Google Workspace ของโรงเรียนไม่อนุญาต "Anyone": ให้ผู้ดูแลองค์กรเลือกช่องทางที่อนุญาต (เช่น ใช้ REST backend ตาม ARCHITECTURE §6) — ห้ามเลี่ยงด้วยการปิด authentication 🧪

## 11. Deployment

1. Deploy → New deployment → Web app → Execute as: Me → Who has access: ตามข้อ 10 → Deploy
2. ใช้ URL ที่ลงท้าย `/exec` เท่านั้นสำหรับผู้ใช้จริง (`/dev` ใช้โค้ดล่าสุดที่ยังไม่ deploy และเปิดได้เฉพาะ editor)
3. ใส่ URL ใน `CWK_WEBAPP_URL`
4. ทุกครั้งที่อัปเดตโค้ด: Deploy → Manage deployments → Edit → New version (URL เดิม) และบันทึกเลขเวอร์ชันใน CHANGELOG
5. ย้อนกลับ: เลือกเวอร์ชันก่อนหน้าใน Manage deployments — **ตรวจ schema compatibility ก่อน** (เวอร์ชันเก่าต้องรองรับ schema_version ปัจจุบัน ดู CHANGELOG)

## 12. Trigger

1. รัน `adminInstallTriggers` (ภายในช่วงเวลา admin) — สร้าง `cronTick` ตัวเดียว ทุก `CWK_TICK_MINUTES` นาที; รันซ้ำไม่สร้างซ้ำ
2. Trigger ทำงานด้วยบัญชีผู้ที่รันคำสั่ง — ต้องเป็นบัญชีเจ้าของระบบของโรงเรียน
3. เปลี่ยนเจ้าของระบบ: เจ้าของใหม่ต้องรัน `adminInstallTriggers` และเจ้าของเดิมลบ trigger ของตน (Triggers ในเมนูซ้าย)
4. 🧪 ตรวจ Executions ว่า cronTick รันสำเร็จและใช้เวลาไม่เกิน ~5 วินาทีเมื่อไม่มีงาน

## 13. การแจ้งเตือน: อีเมล LINE และ gateway (เปิดภายหลังได้)

1. **อีเมล** (ใช้ได้ทันที): `CWK_EMAIL_ENABLED=true`, `CWK_EMAIL_SENDER_NAME`, `CWK_WEBAPP_URL` (ลิงก์ในข้อความ) — ส่งด้วย MailApp ตามโควตาของบัญชีเจ้าของ (ตรวจโควตาปัจจุบันตามข้อ 0) ระบบเลื่อนการส่งเมื่อโควตาหมด และไม่ส่งซ้ำเองเมื่อไม่ทราบผล
2. **DEV/STAGING**: ใส่เฉพาะอีเมล/LINE user ID ของผู้ทดสอบใน `CWK_NOTIFY_ALLOWLIST` — รายการอื่นถูกยกเลิกพร้อมเหตุผล `NON_PROD_NOT_ALLOWLISTED` (ไม่ส่งหาผู้ปกครองจริงระหว่างพัฒนา) PROD ต้องว่าง
3. **ช่วงเวลางดส่ง/การรับทราบ/ช่องทางต่อประเภท**: ตั้งในกฎ `NOTIFICATION_POLICY` (หน้า "ตั้งค่า") — ค่าเริ่มต้นเป็นตัวอย่าง (งดส่ง 21:00–06:00, ขาดเรียนต้องรับทราบใน 24 ชม.)
4. **LINE + gateway**: ทำตาม docs/GATEWAY_TH.md (deploy gateway, ตั้งค่า LINE console, Script Properties `CWK_LINE_*`) — ตั้งผู้รับทดสอบก่อนเปิดส่งจริงเสมอ
5. 🧪 หน้า "ติดตามการส่งแจ้งเตือน" ต้องแสดงรายการที่ส่ง/ล้มเหลว และ cronTick รอบถัดไปส่งรายการที่รอได้

## 14. นำเข้าข้อมูลจริง

1. ตั้งปีการศึกษา ภาคเรียน คาบเรียน จุดลงเวลา ปฏิทิน (หน้า "ตั้งค่า")
2. สร้างกฎเวอร์ชันจริงแทนค่าตัวอย่าง (เวลาเริ่มสาย เกณฑ์ติดตาม เส้นทางอนุมัติ) — หน้า "สถานะระบบ" จะแสดง FAIL ใน PROD จนกว่าจะเปลี่ยน
3. ศูนย์นำเข้าข้อมูล: ห้องเรียน → นักเรียน → ผู้ปกครอง → บุคลากร — ทุกครั้งต้อง dry-run และตรวจข้อผิดพลาดรายแถว
4. ตรวจความสัมพันธ์ผู้ปกครอง-นักเรียน และ enrollment ตัวอย่างอย่างน้อย 5% ของแต่ละห้อง 🧪

## 15. ทดสอบก่อนเปิดใช้งาน

ทำตาม docs/UAT_CHECKLIST_TH.md ครบทุกบทบาท รายงาน สิทธิ์ไฟล์ สำรอง/restore และสถานการณ์อินเทอร์เน็ตขัดข้อง

## 16. Pilot

เปิดใช้ 1–2 ห้อง + จุดลงเวลา 1 จุด 2 สัปดาห์ เก็บเวลาต่อการสแกน (หน้า "สถานะระบบ") และปัญหาที่พบ ก่อนขยายทั้งโรงเรียน (เกณฑ์ใน docs/CAPACITY.md)

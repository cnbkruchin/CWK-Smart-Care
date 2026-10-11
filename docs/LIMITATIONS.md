# LIMITATIONS — ข้อจำกัดที่ทราบ, dependency และสิ่งที่ยังไม่ได้ทดสอบ (CWK Smart Care 0.8.0)

> เอกสารนี้แยก **สิ่งที่พิสูจน์แล้ว** (มีการทดสอบอัตโนมัติ — docs/TEST_MATRIX.md) ออกจาก **สิ่งที่ยังไม่ได้ทดสอบ** และ **สิ่งที่ไม่ได้ส่งมอบ** อย่างตรงไปตรงมา
> ระบบ **ยังไม่พร้อมเปิดใช้งานจริง** จนกว่าจะผ่าน docs/UAT_CHECKLIST_TH.md บน deployment จริงของโรงเรียน (MASTER_PROMPT §21)

## 1. ยังไม่ได้ทดสอบบนบริการจริง (blocked by configuration — ต้องใช้บัญชี/โปรเจกต์ของโรงเรียน)

| รายการ | สิ่งที่ทดสอบแล้วแทน | ต้องทำ |
|---|---|---|
| Apps Script + Google Sheets/Drive/Docs จริง (HtmlService sandbox, LockService, trigger, โควตา, เวลาทำงาน) | gas-dist ที่ build จริงบน emulator (`tests/gas-sim`) — emulator ไม่มี latency, โควตา, execution พร้อมกัน และจำลองพฤติกรรม Docs/Drive export เท่านั้น | UAT ทุกหมวด, `adminSelfTest`, LOAD_TEST §5 |
| Firebase Authentication จริง (gateway `verifyIdToken(checkRevoked)`, REST `FirebaseIdentityVerifier`, sign-in ของหน้าเว็บ) | gateway จริงกับตัวแทน Firebase; DEMO; API ของ firebase-admin 14.4.0 ตรวจว่ามีฟังก์ชันจริง (ชุดที่ 4) | UAT B7.1, G3 |
| LINE Messaging API / webhook จริง | gateway + intake จริงกับลายเซ็นที่สร้างในการทดสอบ, provider จำลองที่มีพฤติกรรม retry key/409 | UAT B7.5, C2 — ตรวจอายุ `X-Line-Retry-Key` กับเอกสาร LINE (ยังไม่ยืนยัน) |
| Cloud Run (gateway) และเครื่องจริงของ REST backend | process จริงบนเครื่องพัฒนา | deploy + log review (UAT F4, G1) |
| `docker compose` และ build image | ตรวจไฟล์เท่านั้น — ไม่มี Docker ในสภาพแวดล้อมพัฒนา | `docker compose --profile api up --build` |
| PDF ภาษาไทย/เลขหน้า/หัวตารางซ้ำ, XLSX ใน Excel | emulator ตรวจลำดับคำสั่ง Docs/Drive และ CSV bytes | UAT D1–D2 |
| อุปกรณ์หน้างาน (เครื่องสแกน, กล้อง, IndexedDB บนมือถือ), screen reader | Chromium headless | UAT B1, B4 |
| เวลาและโหลดบน Apps Script จริง (p50/p95, lock wait, quota) | memory / REST+PostgreSQL / emulator (docs/LOAD_TEST_TH.md) | LOAD_TEST §5 — เป้าหมาย 10–15 วินาที/คนยังไม่ได้วัด |
| ส่งออก/นำเข้า/กระทบยอด/restore บน Drive จริง (เวลา, ขนาด, โควตา) | emulator + PostgreSQL จริง + ข้อมูลสังเคราะห์ | MIGRATION_RUNBOOK §3, UAT E2–E3 |
| เอกสารทางการ (โควตา Apps Script, LINE, Firebase REST) | ตรวจผ่านผลค้นหาหรือความรู้เดิม — network policy ของสภาพแวดล้อมพัฒนาปิดเว็บเอกสาร (DECISIONS ท้ายไฟล์, D-037) | ผู้ติดตั้งตรวจซ้ำตาม INSTALL_GAS_TH §0 |

## 2. ไม่ได้ส่งมอบ (ระบุชัด — ไม่มีโค้ดปลอมแทน)

- โมดูลเสริมที่ปิดไว้: ลงเวลารายวิชา (`feature.subject_attendance`), ออกนอกโรงเรียน/กลับเข้า (`feature.campus_pass`, MASTER_PROMPT §7.7), คะแนนพฤติกรรม (`feature.behavior_points`) — DATA_DICTIONARY §8
- SMS (ไม่มีผู้ให้บริการ), Google Workspace sign-in และ LINE Login (DECISIONS D-003)
- workflow ลบข้อมูลส่วนบุคคลตามนโยบายโรงเรียน (D-025 — retention อัตโนมัติล้างเฉพาะบันทึกระบบ)
- malware scanner สำหรับไฟล์แนบ (ตรวจชนิด/magic bytes/ขนาดเท่านั้น), audit แบบแก้ไขไม่ได้ (immutable)
- โหมด pull ของ webhook เมื่อนโยบาย Workspace ไม่อนุญาต web app แบบ Anyone
- REST backend: ส่งอีเมล/LINE, PDF/XLSX, นำเข้า XLSX, สำรองในแอป (D-036); เว็บรุ่นเริ่มต้นมีเพียง 5 หน้าจอ (future-platform/web/README_TH.md)
- คำสั่ง editor สำเร็จรูปสำหรับส่งออก DELTA จาก Sheets ชุดใหม่ (มีฟังก์ชัน `exportDelta` ที่ทดสอบแล้ว; จาก PostgreSQL มีคำสั่ง `admin.mjs export-delta`)
- ไฟล์ ZIP ส่งมอบใน repository (ZIP สร้างจาก git แยกต่างหาก — docs/DELIVERY_INVENTORY.md)

## 3. ข้อจำกัดของแพลตฟอร์มและการออกแบบ (ทราบแล้ว)

| เรื่อง | ผล | อ้างอิง |
|---|---|---|
| Sheets ไม่มี transaction | MutationJournal + ScriptLock + recovery; ผู้อ่านที่ไม่ถือ lock อาจเห็นผลบางส่วนจนกว่า recovery รัน | D-006 |
| writer project เดียว | ทุกการเขียนผ่าน ScriptLock ของโปรเจกต์เดียว → throughput จำกัด; ต้องวัด lock wait | CAPACITY, LOAD_TEST |
| ขีดจำกัด 10 ล้านเซลล์/สเปรดชีต | แบ่ง workbook ตามภาคเรียน; health เตือนที่ 6/8 ล้าน | CAPACITY |
| audit บน Sheets แก้ได้โดยผู้แก้ไขสเปรดชีต/สคริปต์ | ใช้ตรวจย้อนหลังเท่านั้น; จำกัด editor | THREAT_MODEL |
| rate limit / metrics บน CacheService | best effort (ไม่ atomic, อาจหายก่อน flush) | THREAT_MODEL T11 |
| Execute as owner | ทุกคำขอรันในบัญชีเจ้าของ → ตัวตนมาจาก token เท่านั้น (ทดสอบแล้ว); โควตาเป็นของบัญชีเจ้าของ | INSTALL_GAS_TH |
| ผู้ปกครองนอกโดเมน | ต้อง deploy แบบ Anyone (การเข้าถึงข้อมูลยังต้องผ่าน auth ของแอป) — ถ้านโยบาย Workspace ไม่อนุญาต ให้ผู้ดูแลองค์กรเลือกช่องทางที่อนุญาต (เช่น REST backend) ห้ามปิด authentication | INSTALL_GAS_TH §10 |
| MailApp | ไม่มี idempotency → อีเมลที่ผลไม่แน่นอนไม่ส่งซ้ำอัตโนมัติ (OUTCOME_UNKNOWN) | D-011 |
| ไฟล์แนบเขียนก่อน commit | ไฟล์กำพร้าถูกล้างหลัง 24 ชม. โดยงานประจำวัน (ไม่ทำงานขณะอ่านอย่างเดียว) | D-038 |
| สำรองประจำคืน | ไม่คัดลอก bytes ไฟล์แนบ (เก็บรายการ + sha256); portable package รวม bytes | OPERATIONS_TH |
| ตรวจ package บน Apps Script | ระดับ INTEGRITY; FULL (ID/unique/FK ทั้งชุด) ทำใน Node และตอนนำเข้า; reconcile บน GAS อาจเกิน 6 นาทีกับข้อมูลใหญ่ | PORTABLE_FORMAT, MIGRATION_RUNBOOK |
| Code.js ≈ 980 KB | ขีดจำกัดขนาดโปรเจกต์ Apps Script ยังไม่ได้ตรวจกับ deployment จริง | BUILD_STATE |
| **แดชบอร์ดทั้งโรงเรียน** | คำนวณสดจาก projection ทุกครั้ง — คอขวดที่พบจากการทดสอบโหลด (REST p95 3.4 วินาทีเมื่อแข่งกับการสแกน) | LOAD_TEST §3 |
| REST: cursor แบบ offset, ChangeLog lock เดียว, partition เชิงตรรกะไม่มี index, rate limit ในหน่วยความจำ | ดู docs/REST_BACKEND_TH.md §11 | D-032 |
| เว็บรุ่นเริ่มต้น: token ในหน่วยความจำ | รีโหลด = เข้าสู่ระบบใหม่ (ตั้งใจ) | D-037 |

## 4. ค่าที่โรงเรียนต้องกำหนด (ปัจจุบันเป็นค่าตัวอย่าง `is_example`)

เวลาเริ่มสาย/ผ่อนผัน/การปัดนาที, เส้นทางอนุมัติใบลาและจำนวนวันย้อนหลัง, เกณฑ์เปิดเรื่องติดตาม, เวลายืนยันขาด, ปฏิทินและคาบเรียน, ระยะเก็บข้อมูลส่วนบุคคล/ไฟล์แนบ, ประกาศความเป็นส่วนตัว, จำนวนนักเรียนจริง (ใช้ 1,500 เป็นสมมติฐาน) — BUILD_STATE "สมมติฐาน"

## 5. Dependencies

| dependency | รุ่น | ใช้ที่ | หมายเหตุ |
|---|---|---|---|
| Node.js | ≥ 22 (ทดสอบ 22.22.0) | build, tests, gateway, REST API, CLI | |
| esbuild | 0.28.2 (dev) | bundle gas-dist | |
| pg | 8.23.1 | migration CLI, REST API | lockfile ใน root และ future-platform/api |
| firebase-admin | 14.4.0 | gateway, REST API (โหมด FIREBASE) | npm แสดง 14.5.0 เป็นรุ่นล่าสุด ณ 2026-10-10 — ตรึงรุ่นที่ตรวจแล้ว |
| Firebase JS SDK (compat) | 10.14.1 จาก www.gstatic.com | หน้าเว็บหลักบน Apps Script | พึ่ง CDN ของ Google ที่ระบุรุ่น (D-015) |
| PostgreSQL | 16 (ทดสอบ) | ปลายทางอ้างอิง | |
| Playwright + Chromium | ติดตั้งแยก (global) | test:ui, test:web | ไม่อยู่ใน dependency ของโครงการ |
| บริการ Google | Apps Script (V8), Sheets, Drive (+ Drive advanced service), Docs (+ Docs advanced service), MailApp, UrlFetchApp, CacheService, LockService, PropertiesService | ระยะแรก | scopes ใน gas-dist/appsscript.json |
| LINE Messaging API, Cloud Run | — | การแจ้งเตือน LINE, gateway | เปิดภายหลังเมื่อพร้อม |

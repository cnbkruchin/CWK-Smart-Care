# CWK Smart Care

ระบบแจ้งลา ลงเวลาสาย ติดตามการมาเรียน และดูแลช่วยเหลือนักเรียน — โรงเรียนจุนวิทยาคม อำเภอจุน จังหวัดพะเยา (กลุ่มบริหารงานกิจการนักเรียน)

> สถานะ (0.8.0): **ส่งมอบโค้ดครบ 8 ชุดตามขอบเขตระยะแรกและชุดย้ายข้อมูล** — ผลทดสอบจริงใน [BUILD_STATE.md](BUILD_STATE.md), ข้อจำกัดใน [docs/LIMITATIONS.md](docs/LIMITATIONS.md)
> **ยังไม่พร้อมเปิดใช้งานจริงกับโรงเรียน** จนกว่าจะผ่าน UAT บน deployment จริงตาม [docs/UAT_CHECKLIST_TH.md](docs/UAT_CHECKLIST_TH.md) (ยังไม่ได้ทดสอบบน Apps Script / Firebase / LINE จริง) และโรงเรียนกำหนดค่าธุรกิจที่ยังเป็นค่าตัวอย่าง

## ภาพรวม

- ระยะแรก: Google Apps Script (HtmlService + V8) + Google Sheets (ข้อมูล) + Google Drive (ไฟล์แนบ private)
- บัญชีผู้ใช้: Firebase Authentication / Google Identity Platform (email/password) ตรวจ token ฝั่ง server ผ่าน gateway ที่ใช้ Firebase Admin SDK
- แจ้งเตือน: ในแอป + อีเมล (เริ่มต้น), LINE Official Account Messaging API (เปิดภายหลังผ่าน webhook gateway ที่ตรวจลายเซ็น)
- ย้ายข้อมูล: portable package (JSONL + checksum + ไฟล์แนบ) → PostgreSQL อ้างอิงพร้อม migration CLI และ reconciliation
- เส้นทางอัปเกรด: GAS → REST backend อ้างอิง (Node.js + PostgreSQL, `future-platform/api`) ผ่าน GAS HttpApiAdapter → เว็บใหม่ (`future-platform/web` รุ่นเริ่มต้น) (ARCHITECTURE.md §6, docs/REST_BACKEND_TH.md)

## ขอบเขตที่เสร็จ (โค้ด + การทดสอบอัตโนมัติ)

| ส่วน | สิ่งที่ใช้งานได้ |
|---|---|
| ตัวตนและสิทธิ์ | Firebase Authentication ผ่าน gateway (ตรวจ token ซ้ำ), คำเชิญครั้งเดียว, บทบาท × ขอบเขตข้อมูล, SoD, DEMO เฉพาะ DEV/STAGING |
| งานประจำวัน | ลงเวลาที่ประตู (สแกน/ค้นหา/ออฟไลน์), เช็กชื่อ, ยืนยันขาด, ใบลา + อนุมัติ + เอกสารแนบ, แก้ไขย้อนหลัง, หน้าประวัตินักเรียน, Dashboard |
| ติดตามและแจ้งเตือน | เรื่องติดตาม/การติดต่อ/นัดหมาย, outbox ในแอป + อีเมล + LINE (เปิดเมื่อพร้อม), รับทราบ, webhook gateway |
| รายงานและปฏิบัติการ | R01–R12 (จอ/CSV/XLSX/PDF), สำรอง/restore drill, metrics, retention, ล้างไฟล์กำพร้า, สถานะระบบ |
| ย้ายข้อมูล | ศูนย์ส่งออก, portable package, ตรวจ/นำเข้า Sheets ชุดใหม่ และ PostgreSQL, กระทบยอด, cutover/rollback |
| เส้นทางอัปเกรด | REST backend อ้างอิง (Node + PostgreSQL), GAS HttpApiAdapter, เว็บรุ่นเริ่มต้น |
| ตรวจรับ | test matrix ตาม §18, UAT checklist ทุกบทบาท, ผลทดสอบโหลด (เครื่องพัฒนา), inventory การส่งมอบ |

## เอกสาร

| เอกสาร | เนื้อหา |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | ชั้นระบบ trust boundaries data flow capability matrix |
| [DECISIONS.md](DECISIONS.md) | เหตุผลการตัดสินใจ (identity, partition, atomicity, gateway, migration) |
| [DATA_DICTIONARY.md](DATA_DICTIONARY.md) | schema 56 ตาราง ชนิดข้อมูล constraint enum sensitivity retention |
| [PERMISSIONS.md](PERMISSIONS.md) | action × role × scope |
| [docs/STATE_MACHINES.md](docs/STATE_MACHINES.md) | การเปลี่ยนสถานะใบลา การมาเรียน เรื่องติดตาม outbox import migration |
| [docs/CAPACITY.md](docs/CAPACITY.md) | ประเมินแถว/เซลล์จาก schema จริง |
| [docs/INSTALL_GAS_TH.md](docs/INSTALL_GAS_TH.md) | ติดตั้งบน Apps Script (Editor/clasp, scopes, deployment, trigger, รายงาน, สำรอง, ย้ายข้อมูล) |
| [docs/GATEWAY_TH.md](docs/GATEWAY_TH.md) | gateway: Firebase token และ LINE webhook |
| [docs/USER_GUIDE_DAILY_TH.md](docs/USER_GUIDE_DAILY_TH.md), [docs/USER_GUIDE_FOLLOWUP_TH.md](docs/USER_GUIDE_FOLLOWUP_TH.md) | คู่มือผู้ใช้งานประจำวัน / งานติดตามและแจ้งเตือน |
| [docs/REPORTS_TH.md](docs/REPORTS_TH.md) | นิยามรายงาน R01–R12 และรูปแบบไฟล์ |
| [docs/OPERATIONS_TH.md](docs/OPERATIONS_TH.md) | เจ้าของระบบ งานประจำ สำรอง/restore retention เหตุขัดข้อง |
| [THREAT_MODEL.md](THREAT_MODEL.md) | ภัยคุกคาม มาตรการ และการทดสอบที่อ้างถึง |
| [docs/PORTABLE_FORMAT.md](docs/PORTABLE_FORMAT.md) | รูปแบบ package ย้ายข้อมูล (manifest, JSONL, checksum, สิ่งที่ไม่ส่งออก) |
| [docs/MIGRATION_RUNBOOK_TH.md](docs/MIGRATION_RUNBOOK_TH.md) | ซ้อมย้าย freeze ส่งออก นำเข้า กระทบยอด cutover และ rollback |
| [docs/REST_BACKEND_TH.md](docs/REST_BACKEND_TH.md) | REST backend อ้างอิง + PostgreSQL, admin CLI, HttpApiAdapter (ขั้นที่ 2), เว็บรุ่นเริ่มต้น (ขั้นที่ 3), สิ่งที่ยังไม่ส่งมอบ |
| [future-platform/web/README_TH.md](future-platform/web/README_TH.md) | หน้าที่เว็บรุ่นเริ่มต้นมี และหน้าที่ยังต้องย้าย |
| [API_CONTRACT.md](API_CONTRACT.md), [openapi.yaml](openapi.yaml) | operation ทั้งหมด, envelope, รหัสข้อผิดพลาด + HTTP status (สร้างจาก registry) |
| [docs/UAT_CHECKLIST_TH.md](docs/UAT_CHECKLIST_TH.md) | ตรวจรับทุกบทบาทบน deployment จริง พร้อมผลที่คาดหวัง |
| [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md) | กลุ่มทดสอบบังคับ §18 → ชื่อทดสอบจริง และสิ่งที่ต้องทำบน deployment จริง |
| [docs/LOAD_TEST_TH.md](docs/LOAD_TEST_TH.md) | ผลทดสอบโหลดช่วงพีค (memory / REST+PostgreSQL / emulator — ไม่ใช่ Apps Script จริง) |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | ข้อจำกัด, dependency, สิ่งที่ยังไม่ได้ทดสอบ/ไม่ได้ส่งมอบ |
| [docs/DELIVERY_INVENTORY.md](docs/DELIVERY_INVENTORY.md) | รายการไฟล์ส่งมอบตาม §19 และวิธีประกอบโครงการ |
| [docs/PRIVACY_NOTICE_DRAFT_TH.md](docs/PRIVACY_NOTICE_DRAFT_TH.md) | ร่างประกาศความเป็นส่วนตัว (โรงเรียนต้องตรวจและอนุมัติ) |
| [BUILD_STATE.md](BUILD_STATE.md) | ความคืบหน้า ผลทดสอบ งานถัดไป |

## เริ่มต้นสำหรับนักพัฒนา

```bash
npm ci                 # Node.js ≥ 22
npm run test:domain    # pure domain tests
npm run gen            # สร้าง DATA_DICTIONARY/PERMISSIONS/JSON Schema/SQL ใหม่จาก source
npm run check:gen      # ตรวจว่าไฟล์ที่ generate ตรงกับ source
npm run build          # สร้าง gas-dist/ (Code.js, Entrypoints.js, App.html) สำหรับวางใน Apps Script
npm test               # ทดสอบทั้งหมดที่ไม่ต้องใช้ฐานข้อมูล/เบราว์เซอร์ (การทดสอบ PostgreSQL แสดงเป็น skipped)
npm run test:pg        # PostgreSQL จริง (cluster ชั่วคราว): ย้ายข้อมูล, store contract, REST API, GAS → REST
npm run test:web       # เว็บรุ่นเริ่มต้นกับ REST API + PostgreSQL ใน Chromium (ต้องมี Playwright)
npm run api            # REST backend อ้างอิง (ตั้ง environment ตาม .env.example / docs/REST_BACKEND_TH.md §3)
npm run test:ui        # smoke test หน้าจอใน Chromium (ต้องมี Playwright)
npm run load -- --target memory                 # ทดสอบโหลดช่วงพีค (ดู docs/LOAD_TEST_TH.md สำหรับ rest/gas-emulator)
npm run fixtures -- --out ./tmp/packages       # package ข้อมูลสังเคราะห์
DATABASE_URL=… npm run rehearse:pg -- --init-schema   # ซ้อมย้ายครบขั้นกับฐานข้อมูลทิ้งได้
```

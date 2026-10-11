# CWK Smart Care

ระบบแจ้งลา ลงเวลาสาย ติดตามการมาเรียน และดูแลช่วยเหลือนักเรียน — โรงเรียนจุนวิทยาคม อำเภอจุน จังหวัดพะเยา (กลุ่มบริหารงานกิจการนักเรียน)

> สถานะ: **อยู่ระหว่างพัฒนา** — ดูความคืบหน้าและผลทดสอบจริงใน [BUILD_STATE.md](BUILD_STATE.md)
> ยังไม่พร้อมเปิดใช้งานจริงกับโรงเรียน จนกว่าจะผ่าน UAT บน deployment จริงตาม docs/UAT_CHECKLIST_TH.md

## ภาพรวม

- ระยะแรก: Google Apps Script (HtmlService + V8) + Google Sheets (ข้อมูล) + Google Drive (ไฟล์แนบ private)
- บัญชีผู้ใช้: Firebase Authentication / Google Identity Platform (email/password) ตรวจ token ฝั่ง server ผ่าน gateway ที่ใช้ Firebase Admin SDK
- แจ้งเตือน: ในแอป + อีเมล (เริ่มต้น), LINE Official Account Messaging API (เปิดภายหลังผ่าน webhook gateway ที่ตรวจลายเซ็น)
- ย้ายข้อมูล: portable package (JSONL + checksum + ไฟล์แนบ) → PostgreSQL อ้างอิงพร้อม migration CLI และ reconciliation
- เส้นทางอัปเกรด: GAS → REST backend (Node.js + PostgreSQL) → frontend ใหม่ (ARCHITECTURE.md §6)

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
npm run test:pg        # ทดสอบการย้ายข้อมูลกับ PostgreSQL จริง (เปิด cluster ชั่วคราวในเครื่อง)
npm run test:ui        # smoke test หน้าจอใน Chromium (ต้องมี Playwright)
npm run fixtures -- --out ./tmp/packages       # package ข้อมูลสังเคราะห์
DATABASE_URL=… npm run rehearse:pg -- --init-schema   # ซ้อมย้ายครบขั้นกับฐานข้อมูลทิ้งได้
```

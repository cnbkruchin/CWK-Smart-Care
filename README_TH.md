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
| [BUILD_STATE.md](BUILD_STATE.md) | ความคืบหน้า ผลทดสอบ งานถัดไป |

## เริ่มต้นสำหรับนักพัฒนา

```bash
npm ci                 # Node.js ≥ 22
npm run test:domain    # pure domain tests
npm run gen            # สร้าง DATA_DICTIONARY/PERMISSIONS/JSON Schema/SQL ใหม่จาก source
npm run check:gen      # ตรวจว่าไฟล์ที่ generate ตรงกับ source
```

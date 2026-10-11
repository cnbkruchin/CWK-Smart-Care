# เว็บรุ่นเริ่มต้น (future-platform/web) — ขั้นที่ 3 ของเส้นทางอัปเกรด

หน้าเว็บนี้แสดงการเปลี่ยน **transport** (HTTPS → REST backend แทน `google.script.run`), **auth** (Firebase Authentication REST API ตรงจากเบราว์เซอร์ หรือ DEMO นอก PROD) และ **storage** (ไฟล์แนบอยู่ที่ backend — เว็บไม่รู้ตำแหน่ง) โดยกฎธุรกิจทั้งหมดอยู่ที่ backend เหมือนเดิม
**ไม่ใช่ frontend ครบทั้งระบบ** — งานส่วนใหญ่ยังใช้หน้าเว็บหลัก (`frontend/src` บน Apps Script หรือผ่าน HttpApiAdapter)

## มีแล้ว

| หน้า | operation ที่ใช้ |
|---|---|
| เข้าสู่ระบบ (Firebase email/password: เข้าสู่ระบบ สมัคร ลืมรหัสผ่าน · DEMO) | `app.publicConfig`, `auth.getCurrentUser` |
| เปิดใช้งานบัญชี (ยืนยันอีเมล, ใช้รหัสคำเชิญ) | `auth.redeemInvitation` |
| ค้นหานักเรียน (ตามขอบเขตสิทธิ์, โหลดเพิ่ม) | `student.search` |
| หน้ารายบุคคล (ข้อมูลระบุตัว หรือเต็มตามบทบาท, สถิติ, เหตุการณ์ล่าสุด) | `student.profile` |
| ลงเวลามาเรียน (เลือกจุด → รหัส → บัตรระบุตัว → ยืนยัน → ผลจากเวลา server; สแกนซ้ำแสดงว่าบันทึกแล้ว) | `station.list`, `attendance.lookupForGate`, `attendance.recordArrival` |

## ยังต้องย้าย (เทียบกับ `frontend/src/screens`)

| กลุ่ม | หน้าจอเดิม |
|---|---|
| งานประจำวัน | หน้าแรกตามบทบาท (`home.js`), เช็กชื่อ/ยืนยันรายวัน (`rollcall.js`), สแกนกล้อง + คิวออฟไลน์ (`gate.js` ส่วน camera/IndexedDB), แก้ไข/คำขอแก้เวลา |
| การลา | ยื่นใบลา + ไฟล์แนบ (`leave.js`), รายละเอียด/อนุมัติ (`leave-detail.js`, `approvals.js`) |
| ติดตามช่วยเหลือ | เรื่องติดตาม การติดต่อ นัดหมาย (`cases.js`) |
| แจ้งเตือน | กล่องแจ้งเตือน, รับทราบ, ผูก LINE (`notifications.js`) |
| รายงาน/แดชบอร์ด | `dashboard.js`, `reports.js` (บน REST ใช้ได้เฉพาะ CSV — PDF/XLSX ยังไม่มี renderer) |
| ผู้ดูแล | ผู้ใช้/บทบาท/คำเชิญ (`users.js`), นักเรียน/ห้อง/ผู้ปกครอง (`students.js`), นำเข้า (`imports.js`), ตั้งค่า (`settings.js`), สุขภาพระบบ (`health.js`), ศูนย์ย้ายข้อมูล (`migration.js`), โปรไฟล์ (`profile.js`) |
| คุณภาพ | การเข้าถึง (ทดสอบ screen reader จริง), PWA/ออฟไลน์, การจำการเข้าสู่ระบบข้ามการรีโหลด (ตอนนี้ token อยู่ในหน่วยความจำเท่านั้นโดยตั้งใจ) |

ทางเลือกที่สั้นกว่า: ย้ายหน้าจอเดิมใน `frontend/src` มาใช้ตรง ๆ — `frontend/src/api.js` มี `HttpTransport` อยู่แล้ว และ `main.js` รับ `auth_mode` `FIREBASE` จาก backend; งานที่เหลือคือ build แยกสำหรับเว็บ (esbuild), CSP/hosting และทดสอบทุกหน้าใหม่

## ความปลอดภัย

- DOM สร้างด้วย `textContent` เท่านั้น (ข้อมูลไม่กลายเป็น HTML); CSP `script-src 'self'` ไม่มี inline script
- token อยู่ในหน่วยความจำเท่านั้น ส่งใน `Authorization` ไม่อยู่ใน URL/storage/cookie
- mutation ใช้ idempotency key ต่อการกระทำ (ลองใหม่ไม่บันทึกซ้ำ) และทิ้งคำตอบที่เก่ากว่าคำขอล่าสุด

ทดสอบ: `npm run test:web` (tests/ui/web-starter-smoke.mjs — PostgreSQL ชั่วคราว + Chromium)

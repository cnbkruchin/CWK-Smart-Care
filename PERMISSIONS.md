# Permissions — action × role × data scope

> สร้างอัตโนมัติจาก `src/domain/permissions.js` (`npm run gen`). Server ตรวจสิทธิ์ทุก operation รวมการค้นหา รายงาน export และไฟล์แนบ — ไม่เชื่อ role/user_id ที่ client ส่งมา

## ขอบเขตข้อมูล (scope)

| scope | ความหมาย |
|---|---|
| SCHOOL | นักเรียนทั้งโรงเรียน |
| SCHOOL_BASIC | นักเรียนทุกคน เฉพาะข้อมูลระบุตัว (ชื่อ รหัส ห้อง รูป) สำหรับงานประตู |
| CLASS:HOMEROOM | นักเรียนที่อยู่ในห้องที่เป็นครูที่ปรึกษา (ตาม enrollment ของวันที่เกี่ยวข้อง) รวมการรักษาการแทนที่มีผล |
| CLASS:TEACHING | นักเรียนในห้องที่สอน |
| LINKED(x) | นักเรียนที่มีความสัมพันธ์ผู้ปกครองที่เจ้าหน้าที่ยืนยัน (ACTIVE) ยังมีผล และให้สิทธิ์ x |
| SELF | ข้อมูลของนักเรียนเอง |
| OWN | ทรัพยากรของผู้ใช้เอง (คำขอที่ตนยื่น การแจ้งเตือนของตน งานของตน) |
| SYSTEM | งานระบบ ไม่รวมสิทธิ์ดูข้อมูลนักเรียน |

## Matrix

| action | คำอธิบาย | SYSTEM_ADMIN | STUDENT_AFFAIRS | EXECUTIVE | HOMEROOM_TEACHER | SUBJECT_TEACHER | DUTY_TEACHER | GATE_STAFF | GUARDIAN | STUDENT |
|---|---|---|---|---|---|---|---|---|---|---|
| `self.read` | ดูข้อมูลบัญชีของตนเอง | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN |
| `student.read` | ดูข้อมูลนักเรียนและประวัติ | — | SCHOOL | SCHOOL | CLASS:HOMEROOM | — | — | — | LINKED(VIEW_ATTENDANCE) | SELF |
| `student.read_basic` | ดูข้อมูลระบุตัว (ชื่อ รหัส ห้อง รูป) เพื่อลงเวลา | — | SCHOOL | SCHOOL | CLASS:HOMEROOM | CLASS:TEACHING | SCHOOL_BASIC | SCHOOL_BASIC | LINKED(VIEW_ATTENDANCE) | SELF |
| `student.search` | ค้นหานักเรียน | — | SCHOOL | SCHOOL | CLASS:HOMEROOM | CLASS:TEACHING | SCHOOL_BASIC | SCHOOL_BASIC | — | — |
| `student.manage` | เพิ่ม/แก้ไขนักเรียน ห้อง และการลงทะเบียน | — | SCHOOL | — | — | — | — | — | — | — |
| `guardian.read_contact` | ดูข้อมูลติดต่อผู้ปกครอง | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | — | — |
| `guardian.manage` | เพิ่ม/ยืนยัน/เปลี่ยนผู้ปกครอง เบอร์ และความสัมพันธ์ | — | SCHOOL | — | — | — | — | — | — | — |
| `guardian.invite` | ออกคำเชิญผู้ปกครองที่ยืนยันความสัมพันธ์แล้ว | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | — | — |
| `attendance.record` | ลงเวลามาถึง | — | SCHOOL | — | — | — | SCHOOL_BASIC | SCHOOL_BASIC | — | — |
| `attendance.read` | ดูข้อมูลการมาเรียน | — | SCHOOL | SCHOOL | CLASS:HOMEROOM | CLASS:TEACHING | — | — | LINKED(VIEW_ATTENDANCE) | SELF |
| `attendance.read_station` | ดูรายการลงเวลาของจุดลงเวลาวันนี้ | — | SCHOOL | — | — | — | SCHOOL_BASIC | SCHOOL_BASIC | — | — |
| `attendance.rollcall` | เช็กชื่อประจำวัน | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | — | — |
| `attendance.verify` | ยืนยันการขาดเรียน/ตรวจสอบรายวัน | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | — | — |
| `attendance.correct` | แก้ไขข้อมูลการมาเรียนย้อนหลัง (มีเหตุผล) | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | — | — |
| `attendance.request_correction` | ร้องขอแก้ไขข้อมูลการมาเรียน | — | — | — | — | — | — | — | LINKED(VIEW_ATTENDANCE) | SELF |
| `attendance.exempt` | รับรองข้อยกเว้นการนับสาย (เช่น รถโรงเรียนล่าช้า) | — | SCHOOL | — | — | — | — | — | — | — |
| `attendance.reconcile` | ปิดงานตรวจสอบข้อมูลขัดกัน | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | — | — |
| `leave.submit` | แจ้งลา | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | LINKED(SUBMIT_LEAVE) | SELF |
| `leave.read` | ดูใบลา | — | SCHOOL | SCHOOL | CLASS:HOMEROOM | CLASS:TEACHING | — | — | LINKED(VIEW_ATTENDANCE) | SELF |
| `leave.confirm_guardian` | ผู้ปกครองยืนยันใบลา | — | — | — | — | — | — | — | LINKED(CONFIRM_LEAVE) | — |
| `leave.approve` | พิจารณาใบลา (ตามเส้นทางอนุมัติ) | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | — | — |
| `leave.withdraw` | ถอนคำขอลา | — | SCHOOL | — | OWN | — | — | — | OWN | OWN |
| `leave.cancel` | ขอยกเลิก/ยกเลิกใบลาที่อนุมัติแล้ว | — | SCHOOL | — | — | — | — | — | LINKED(SUBMIT_LEAVE) | SELF |
| `attachment.upload` | อัปโหลดไฟล์ | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN |
| `attachment.read` | ดาวน์โหลดไฟล์ทั่วไปที่เกี่ยวข้อง | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | LINKED(VIEW_DOCUMENTS) | SELF |
| `attachment.read_sensitive` | ดาวน์โหลดเอกสารอ่อนไหว (เช่น ใบรับรองแพทย์) | — | SCHOOL | — | CLASS:HOMEROOM | — | — | — | OWN | OWN |
| `case.read` | ดูรายละเอียดเรื่องติดตาม | — | SCHOOL | — | CLASS:HOMEROOM, OWN | — | — | — | — | — |
| `case.read_summary` | ดูสรุปเรื่องติดตาม | — | SCHOOL | SCHOOL | CLASS:HOMEROOM | — | — | — | LINKED(VIEW_CASE_SUMMARY) | — |
| `case.manage` | เปิด/มอบหมาย/ส่งต่อ/ปิดเรื่องติดตาม | — | SCHOOL | — | CLASS:HOMEROOM, OWN | — | — | — | — | — |
| `case.record_contact` | บันทึกการติดต่อและนัดหมาย | — | SCHOOL | — | CLASS:HOMEROOM, OWN | — | — | — | — | — |
| `notification.read_own` | ดูการแจ้งเตือนของตน | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN |
| `notification.acknowledge` | รับทราบ/ขอให้ติดต่อกลับ | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN |
| `notification.monitor` | ดูสถานะคิวแจ้งเตือนและรายการส่งไม่สำเร็จ | SYSTEM | SCHOOL | — | — | — | — | — | — | — |
| `notification.resend` | ส่งการแจ้งเตือนใหม่ | — | SCHOOL | — | — | — | — | — | — | — |
| `channel.bind` | เชื่อมช่องทาง LINE ของตน | — | OWN | — | OWN | — | — | — | OWN | OWN |
| `report.view` | ดูรายงาน | — | SCHOOL | SCHOOL | CLASS:HOMEROOM | — | — | — | — | — |
| `report.export` | ส่งออกรายงาน (CSV/XLSX/PDF) | — | SCHOOL | SCHOOL | CLASS:HOMEROOM | — | — | — | — | — |
| `report.lock` | ล็อกรอบรายงาน | — | SCHOOL | — | — | — | — | — | — | — |
| `audit.read` | ดู audit log | SYSTEM | SCHOOL | — | — | — | — | — | — | — |
| `import.manage` | นำเข้าข้อมูล | — | SCHOOL | — | — | — | — | — | — | — |
| `migration.export` | ส่งออก portable snapshot ทั้งระบบ | SYSTEM | — | — | — | — | — | — | — | — |
| `migration.validate` | ตรวจ package ย้ายข้อมูล | SYSTEM | — | — | — | — | — | — | — | — |
| `migration.import` | นำเข้า package ลง staging/ปลายทางใหม่ | SYSTEM | — | — | — | — | — | — | — | — |
| `migration.cutover` | เปลี่ยนสถานะ cutover/rollback | SYSTEM | — | — | — | — | — | — | — | — |
| `backup.manage` | สำรอง/ทดสอบ restore | SYSTEM | — | — | — | — | — | — | — | — |
| `settings.business` | ตั้งค่าธุรกิจ (กฎ ปฏิทิน คาบ จุดลงเวลา) | — | SCHOOL | — | — | — | — | — | — | — |
| `settings.system` | ตั้งค่าระบบ (โหมดอ่านอย่างเดียว feature flags งานเบื้องหลัง) | SYSTEM | — | — | — | — | — | — | — | — |
| `user.read` | ดูรายชื่อผู้ใช้และบทบาท | SYSTEM | SCHOOL | — | — | — | — | — | — | — |
| `user.manage` | สร้าง/ระงับบัญชีบุคลากรและออกคำเชิญ | SYSTEM | — | — | — | — | — | — | — | — |
| `role.assign` | กำหนด/เพิกถอนบทบาท | SYSTEM | — | — | — | — | — | — | — | — |
| `system.health` | ดูสถานะระบบ | SYSTEM | SCHOOL | — | — | — | — | — | — | — |
| `system.maintenance` | สั่งงานบำรุงรักษา (อ่านอย่างเดียว กู้รายการค้าง) | SYSTEM | — | — | — | — | — | — | — | — |
| `job.read` | ดูสถานะงานเบื้องหลัง | OWN, SYSTEM | OWN | OWN | OWN | OWN | OWN | OWN | OWN | OWN |

## ตัวอย่างข้อห้ามที่มี automated test (tests/domain/permissions.test.mjs, tests/application/*)

- ผู้ปกครองของนักเรียน A อ่าน/ค้นหา/ดาวน์โหลด/แจ้งลาให้นักเรียน B ไม่ได้ แม้แก้ payload หรือเรียก RPC ตรง
- ครูเวร/เจ้าหน้าที่ประตูเห็นเฉพาะข้อมูลระบุตัว ไม่มี `report.export` หรือ `migration.export`
- SYSTEM_ADMIN ไม่มีสิทธิ์ดูข้อมูลนักเรียน/เอกสารลับ เว้นแต่ได้รับบทบาทงานข้อมูลเพิ่ม (เช่น STUDENT_AFFAIRS)
- EXECUTIVE ไม่มีสิทธิ์แก้ไขย้อนหลัง (`attendance.correct`) หรืออนุมัติใบลา
- ครูประจำวิชาไม่เห็นเอกสารสุขภาพ (`attachment.read_sensitive`) และข้อมูลติดต่อผู้ปกครอง
- นักเรียน/ผู้ปกครองกำหนด role หรือ student_id ที่จะเข้าถึงเองไม่ได้ — ความสัมพันธ์มาจากเจ้าหน้าที่ยืนยันและคำเชิญเท่านั้น
- การสมัครบัญชีกับผู้ให้บริการยืนยันตัวตนสำเร็จ ยังไม่มีบทบาทใด ๆ จนกว่าจะใช้คำเชิญ

# API Contract — CWK Smart Care

> สร้างอัตโนมัติจาก allowlist ใน `src/application/registry.js` (`npm run gen`). ทุก operation ผ่าน dispatcher เดียวกันทั้ง GAS (`google.script.run.rpc`) และ REST (`POST /v1/rpc` หรือ `POST /v1/ops/{operation}`)

## Envelope

```json
{
  "api_version": "v1",
  "request_id": "uuid",
  "operation": "attendance.recordArrival",
  "idempotency_key": "uuid (mutations)",
  "expected_version": null,
  "credential": "runtime-only (GAS) — REST uses Authorization: Bearer",
  "payload": {},
  "client": {
    "device_id": "uuid"
  }
}
```

Response สำเร็จ: `{ "ok": true, "data": {...}, "meta": { "request_id", "server_time", "replayed" } }`  
Response ผิดพลาด: `{ "ok": false, "error": { "code", "message_th", "retryable", "field_errors": [{field, code, message_th}], "details" }, "meta": { "request_id" } }`

- **Idempotency:** mutation ทุกตัวต้องมี `idempotency_key` (UUID) ขอบเขต (ผู้ใช้, operation, key); ส่งซ้ำ payload เดิม → คืนผลเดิม `replayed: true`; payload ต่าง → `DUPLICATE_REQUEST_MISMATCH`; เก็บ 7 วัน
- **Optimistic concurrency:** operation ที่แก้ไขแถวเดิมรับ `expected_version`; ไม่ตรง → `CONFLICT` พร้อม `details.current_version`
- **ลำดับคำตอบ:** client ต้องทิ้งคำตอบที่เก่ากว่าคำขอล่าสุดในช่องทางเดียวกัน (frontend/src/api.js `channel`)
- **ชนิดข้อมูล:** JSON-safe เท่านั้น — วันที่ `YYYY-MM-DD` (ค.ศ.), เวลา UTC ISO 8601, ไม่มี Date/Blob/function ดิบ

## Error codes

| code | retryable | ข้อความ (ไทย) |
|---|---|---|
| UNAUTHENTICATED | ไม่ | กรุณาเข้าสู่ระบบใหม่ |
| ACCOUNT_NOT_LINKED | ไม่ | บัญชีนี้ยังไม่ได้เชื่อมกับผู้ใช้ในระบบ กรุณาใช้รหัสคำเชิญจากโรงเรียน |
| ACCOUNT_DISABLED | ไม่ | บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อโรงเรียน |
| FORBIDDEN | ไม่ | คุณไม่มีสิทธิ์ทำรายการนี้ |
| NOT_FOUND | ไม่ | ไม่พบข้อมูลที่ต้องการ หรือคุณไม่มีสิทธิ์เข้าถึง |
| VALIDATION_ERROR | ไม่ | ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบช่องที่แจ้งเตือน |
| CONFLICT | ไม่ | ข้อมูลถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนทำรายการอีกครั้ง |
| UNIQUE_VIOLATION | ไม่ | มีข้อมูลนี้อยู่แล้วในระบบ |
| INVALID_STATE | ไม่ | ไม่สามารถทำรายการนี้ได้ในสถานะปัจจุบัน |
| DUPLICATE_REQUEST_MISMATCH | ไม่ | คำขอซ้ำใช้รหัสอ้างอิงเดิมแต่ข้อมูลต่างกัน ระบบไม่บันทึกซ้ำ |
| MAINTENANCE_MODE | ใช่ | ระบบอยู่ระหว่างปรับปรุง (อ่านอย่างเดียว) กรุณาลองใหม่ภายหลัง |
| RATE_LIMITED | ใช่ | มีการเรียกใช้งานถี่เกินไป กรุณารอสักครู่ |
| QUOTA_EXCEEDED | ใช่ | ระบบใช้โควตาบริการเกินกำหนด กรุณาลองใหม่ภายหลัง |
| STORAGE_UNAVAILABLE | ใช่ | ระบบจัดเก็บข้อมูลไม่พร้อมใช้งานชั่วคราว ข้อมูลยังไม่ถูกบันทึก |
| LOCK_TIMEOUT | ใช่ | มีผู้ใช้งานพร้อมกันจำนวนมาก ข้อมูลยังไม่ถูกบันทึก กรุณาลองใหม่ |
| CONFIGURATION_REQUIRED | ไม่ | ระบบยังตั้งค่าไม่ครบ กรุณาติดต่อผู้ดูแลระบบ |
| FEATURE_DISABLED | ไม่ | ฟังก์ชันนี้ยังไม่เปิดใช้งาน |
| PAYLOAD_TOO_LARGE | ไม่ | ข้อมูลหรือไฟล์มีขนาดเกินกำหนด |
| UNSUPPORTED_OPERATION | ไม่ | ไม่รองรับคำสั่งนี้ |
| UNSUPPORTED_SCHEMA | ไม่ | รูปแบบข้อมูลหรือเวอร์ชัน schema ไม่รองรับ |
| INTEGRITY_ERROR | ไม่ | ข้อมูลไม่สมบูรณ์หรือ checksum ไม่ตรงกัน |
| EXTERNAL_SERVICE_ERROR | ใช่ | บริการภายนอกขัดข้อง ระบบจะลองใหม่อัตโนมัติ |
| INTERNAL_ERROR | ใช่ | เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่ หากยังพบปัญหาให้แจ้งรหัสอ้างอิงต่อผู้ดูแลระบบ |

## Operations (139)

| operation | auth | permission | mutation | idempotency | rate/min | คำอธิบาย |
|---|---|---|---|---|---|---|
| `academicYear.create` | USER | settings.business | ✔ | REQUIRED | 120 | สร้างปีการศึกษา |
| `app.publicConfig` | PUBLIC | — |  | NONE | 60 | ค่าตั้งค่าสาธารณะสำหรับหน้าเว็บ (ไม่มี secret) |
| `appointment.create` | USER | case.record_contact | ✔ | REQUIRED | 120 | นัดหมายผู้ปกครอง/นักเรียน |
| `appointment.update` | USER | case.record_contact | ✔ | REQUIRED | 120 | บันทึกผลนัดหมาย/เลื่อน/ยกเลิก |
| `assignment.create` | USER | user.manage | settings.business | ✔ | REQUIRED | 120 | กำหนดครูที่ปรึกษา/เวร/สอน/ผู้รักษาการแทน พร้อมช่วงเวลา |
| `assignment.end` | USER | user.manage | settings.business | ✔ | REQUIRED | 120 | สิ้นสุดขอบเขตงาน |
| `attachment.download` | USER | attachment.read | attachment.read_sensitive |  | NONE | 60 | ดาวน์โหลดไฟล์ (ตรวจสิทธิ์ทุกครั้ง; เอกสารอ่อนไหวบันทึก audit) |
| `attendance.classDay` | USER | attendance.read |  | NONE | 300 | สรุปรายวันของห้อง (projection เดียวกับรายงาน) |
| `attendance.correct` | USER | attendance.correct | ✔ | REQUIRED | 120 | แก้ไขข้อมูลการมาเรียนย้อนหลัง (เหตุผล + audit + เหตุการณ์ใหม่ supersede เดิม) แล้วคำนวณใหม่และแจ้งเฉพาะผู้ได้รับผลกระทบ |
| `attendance.decideCorrection` | USER | attendance.correct | ✔ | REQUIRED | 120 | พิจารณาคำขอแก้ไข: ไม่อนุมัติ หรืออนุมัติพร้อมระบุการแก้ไข |
| `attendance.exempt` | USER | attendance.exempt | ✔ | REQUIRED | 120 | รับรองข้อยกเว้นการนับสาย (เช่น รถโรงเรียนล่าช้า) — แสดงทั้งเหตุการณ์จริงและผลการยกเว้น |
| `attendance.lookupForGate` | USER | student.read_basic |  | NONE | 600 | ค้นหานักเรียนด้วยรหัส/บัตรเพื่อตรวจตัวบุคคลที่ประตู (ข้อมูลระบุตัวเท่านั้น) |
| `attendance.recordArrival` | USER | attendance.record | ✔ | REQUIRED | 600 | บันทึกเวลามาถึงโรงเรียน (เวลา server; สแกนซ้ำคืนผลเดิม; เวลาระบุเองต้องมีเหตุผล) |
| `attendance.requestCorrection` | USER | attendance.request_correction | ✔ | REQUIRED | 120 | นักเรียน/ผู้ปกครองร้องขอแก้ไขข้อมูลการมาเรียน (เข้าคิวครูพิจารณา) |
| `attendance.stationLog` | USER | attendance.read_station |  | NONE | 300 | รายการลงเวลาวันนี้ของจุดลงเวลา |
| `attendance.syncOffline` | USER | attendance.record | ✔ | REQUIRED | 30 | ส่งรายการที่บันทึกขณะออฟไลน์ (ตรวจสิทธิ์ปัจจุบัน เวลาเครื่อง และใช้ idempotency key เดิม; รายการผิดปกติเข้าคิวตรวจ) |
| `attendance.verifyDay` | USER | attendance.verify | ✔ | REQUIRED | 120 | ครูยืนยันขาดเรียนรายคน (หลังตรวจสอบแล้ว) — แจ้งผู้ปกครองว่า "ขาดเรียน" เฉพาะรายการที่ยืนยัน |
| `auth.getCurrentUser` | IDENTITY | ตาม handler |  | NONE | 300 | ข้อมูลผู้ใช้ปัจจุบัน บทบาท และเมนูที่มีสิทธิ์ |
| `auth.logout` | IDENTITY | ตาม handler |  | NONE | 300 | ออกจากระบบ (ล้างผลตรวจ token ที่ server cache; client เรียก signOut ของ SDK) |
| `auth.redeemInvitation` | IDENTITY | ตาม handler | ✔ | REQUIRED | 10 | ใช้รหัสคำเชิญผูกบัญชีผู้ให้บริการยืนยันตัวตนกับผู้ใช้ในระบบ (ครั้งเดียว มีอายุ) |
| `backup.list` | USER | backup.manage | system.health |  | NONE | 300 | ประวัติการสำรองข้อมูลและผลทดสอบ restore |
| `backup.recordRestoreTest` | USER | backup.manage | ✔ | REQUIRED | 120 | บันทึกผลทดสอบ restore ไป environment ใหม่ (ผล + เวลาที่ใช้จริง) |
| `backup.run` | USER | backup.manage | ✔ | REQUIRED | 120 | สั่งสำรองข้อมูลทันที (งานเบื้องหลัง) |
| `calendar.set` | USER | settings.business | ✔ | REQUIRED | 120 | กำหนดวันหยุด/วันพิเศษ (ทับค่าเริ่มต้นจันทร์–ศุกร์) |
| `case.assign` | USER | case.manage | ✔ | REQUIRED | 120 | มอบหมาย/ส่งต่อผู้รับผิดชอบ (ผู้รับต้องมีสิทธิ์ดูแลนักเรียน) |
| `case.assignable` | USER | case.manage |  | NONE | 300 | รายชื่อผู้ที่รับมอบหมายเรื่องของนักเรียนคนนี้ได้ |
| `case.close` | USER | case.manage | ✔ | REQUIRED | 120 | ปิดเรื่องพร้อมข้อสรุป (เรื่องที่มาจากกฎจะมีช่วงพักก่อนเปิดใหม่) |
| `case.create` | USER | case.manage | ✔ | REQUIRED | 120 | ครูเปิดเรื่องติดตามเอง (ระบุเหตุผลเชิงข้อเท็จจริง ไม่ตัดสินพฤติกรรม) |
| `case.get` | USER | case.read |  | NONE | 300 | รายละเอียดเรื่องติดตาม: หลักฐานที่เข้ากฎ บันทึกการติดต่อ นัดหมาย และประวัติ |
| `case.list` | USER | case.read |  | NONE | 300 | รายการเรื่องติดตามตามขอบเขต (ของฉัน/ห้องที่ปรึกษา/ทั้งโรงเรียน) |
| `case.reopen` | USER | case.manage | ✔ | REQUIRED | 120 | เปิดเรื่องที่ปิด/แก้ไขแล้วอีกครั้ง (ต้องมีเหตุผล) |
| `case.resolve` | USER | case.manage | ✔ | REQUIRED | 120 | บันทึกว่าแก้ไขแล้ว (รอปิดเรื่อง) |
| `case.update` | USER | case.manage | ✔ | REQUIRED | 120 | ปรับความสำคัญ กำหนดเวลา และสิ่งที่ต้องทำต่อ |
| `channel.revokeForUser` | USER | guardian.manage | user.manage | ✔ | REQUIRED | 120 | เจ้าหน้าที่ยกเลิกช่องทาง LINE ของผู้ใช้ (เช่น เปลี่ยนผู้ปกครอง/อุปกรณ์หาย) |
| `channel.startLineLink` | USER | channel.bind | ✔ | REQUIRED | 10 | เริ่มเชื่อม LINE (ต้องเข้าสู่ระบบแล้ว): สร้าง nonce ใช้ครั้งเดียว อายุ 10 นาที แล้วส่งไปหน้ายืนยันของ LINE |
| `channel.status` | USER | ตาม handler |  | NONE | 300 | ช่องทางแจ้งเตือนของฉัน (อีเมล/LINE) |
| `channel.unbind` | USER | channel.bind | ✔ | REQUIRED | 120 | ยกเลิกการเชื่อม LINE ของฉัน (ไม่รับข้อความทาง LINE อีก) |
| `class.create` | USER | settings.business | ✔ | REQUIRED | 120 | สร้างห้องเรียน |
| `class.list` | USER | ตาม handler |  | NONE | 300 | รายชื่อห้องเรียน (ข้อมูลไม่อ่อนไหว) |
| `contact.add` | USER | guardian.manage | ✔ | REQUIRED | 120 | เพิ่มช่องทางติดต่อผู้ปกครอง (เจ้าหน้าที่ยืนยัน) |
| `contact.disable` | USER | guardian.manage | ✔ | REQUIRED | 120 | ยกเลิกช่องทางติดต่อ (มี audit) |
| `contact.inbox` | USER | case.record_contact |  | NONE | 300 | ข้อความ/คำขอติดต่อจากผู้ปกครองที่รอครูตอบกลับ (ตามขอบเขต) |
| `contact.log` | USER | case.record_contact | ✔ | REQUIRED | 120 | บันทึกผลการติดต่อ (โทร/LINE/พบตัว) — ติดต่อไม่ได้ก็ต้องบันทึก |
| `dashboard.summary` | USER | attendance.read |  | NONE | 300 | สรุปวันนี้ตามขอบเขตสิทธิ์ (ใช้ projection เดียวกับรายงาน R01) |
| `enrollment.change` | USER | student.manage | ✔ | REQUIRED | 120 | ย้ายห้อง เลื่อนชั้น ย้ายออก พ้นสภาพ จบการศึกษา (มีวันที่มีผล) |
| `guardian.create` | USER | guardian.manage | ✔ | REQUIRED | 120 | เพิ่มผู้ปกครองและช่องทางติดต่อ (เจ้าหน้าที่ยืนยัน) |
| `guardian.createAccount` | USER | guardian.manage | ✔ | REQUIRED | 120 | สร้างบัญชีผู้ปกครอง (ยังไม่มีสิทธิ์จนใช้คำเชิญ) |
| `guardian.endLink` | USER | guardian.manage | ✔ | REQUIRED | 120 | สิ้นสุดความสัมพันธ์ (เช่น เปลี่ยนผู้ปกครอง) — ผู้ปกครองหมดสิทธิ์เห็นข้อมูลและไม่ได้รับข้อความใหม่ |
| `guardian.link` | USER | guardian.manage | ✔ | REQUIRED | 120 | ผูกผู้ปกครองกับนักเรียน (เจ้าหน้าที่ยืนยันตัวตนแล้ว) พร้อมสิทธิ์และการรับแจ้ง |
| `guardian.listForStudent` | USER | guardian.read_contact |  | NONE | 300 | ผู้ปกครองและช่องทางติดต่อของนักเรียน |
| `guardian.search` | USER | guardian.manage |  | NONE | 300 | ค้นหาผู้ปกครอง (ชื่อ/รหัสที่โรงเรียนรับรอง) |
| `guardian.updateLink` | USER | guardian.manage | ✔ | REQUIRED | 120 | แก้ไขสิทธิ์/การรับแจ้ง/ลำดับติดต่อของความสัมพันธ์ (มี audit) |
| `identity.unlink` | USER | user.manage | ✔ | REQUIRED | 120 | ยกเลิกการเชื่อมบัญชีผู้ให้บริการกับผู้ใช้ (เช่น บัญชีถูกยึด/เปลี่ยนผู้ปกครอง) |
| `import.apply` | USER | import.manage | ✔ | REQUIRED | 120 | เริ่มนำเข้าจริงเป็นงานเบื้องหลัง (แบ่งชุด resume ได้ รันซ้ำไม่สร้างซ้ำ) |
| `import.dryRun` | USER | import.manage | ✔ | REQUIRED | 120 | ตรวจทุกแถวและสรุปผลที่จะเกิด (เพิ่ม/แก้/ข้าม/ขัดแย้ง/ผิดพลาด) โดยไม่แก้ข้อมูลจริง |
| `import.get` | USER | import.manage |  | NONE | 300 | สถานะชุดนำเข้าและข้อผิดพลาดรายแถว |
| `import.list` | USER | import.manage |  | NONE | 300 | ประวัติการนำเข้า |
| `import.preview` | USER | import.manage |  | NONE | 300 | ดูตัวอย่างหลัง mapping (ไม่บันทึกข้อมูล) |
| `import.template` | USER | import.manage |  | NONE | 300 | ไฟล์ตัวอย่าง CSV (UTF-8 BOM) ของการนำเข้าแต่ละชนิด |
| `import.upload` | USER | import.manage | ✔ | REQUIRED | 10 | อัปโหลดไฟล์นำเข้า (CSV/XLSX ≤ 5 MB, ≤ 5,000 แถว) |
| `invitation.create` | USER | ตาม handler | ✔ | REQUIRED | 30 | ออกคำเชิญเปิดใช้งาน (แสดงรหัสครั้งเดียว) — บุคลากร: user.manage; ผู้ปกครอง: guardian.invite ต่อความสัมพันธ์ที่ยืนยันแล้ว; นักเรียน: student.manage |
| `invitation.revoke` | USER | user.manage | guardian.invite | ✔ | REQUIRED | 120 | ยกเลิกคำเชิญ |
| `job.getStatus` | USER | ตาม handler |  | NONE | 300 | สถานะงานเบื้องหลัง (เจ้าของงาน หรือผู้ดูแลระบบ) |
| `job.list` | USER | system.health |  | NONE | 300 | รายการงานเบื้องหลัง (ผู้ดูแลระบบ) |
| `job.retry` | USER | system.maintenance | ✔ | REQUIRED | 120 | สั่งรันงานที่ล้มเหลวอีกครั้ง |
| `leave.addAttachment` | USER | leave.submit | leave.approve | ✔ | REQUIRED | 120 | แนบเอกสารเพิ่ม (เช่น ใบรับรองแพทย์) ให้ใบลา |
| `leave.confirmGuardian` | USER | leave.confirm_guardian | ✔ | REQUIRED | 120 | ผู้ปกครองยืนยัน/ไม่ยืนยันใบลาที่นักเรียนยื่น (แยกจากการอนุมัติของโรงเรียน) |
| `leave.decide` | USER | leave.approve | ✔ | REQUIRED | 120 | โรงเรียนพิจารณาใบลา: อนุมัติ / อนุมัติบางช่วง / ไม่อนุมัติ / ส่งกลับแก้ไข (ตามเส้นทางอนุมัติ หรือผู้รักษาการแทน) |
| `leave.decideCancel` | USER | leave.approve | ✔ | REQUIRED | 120 | พิจารณาการยกเลิกใบลา (หรือยกเลิกโดยตรงโดยผู้มีอำนาจ) — คำนวณการมาเรียนใหม่ |
| `leave.get` | USER | leave.read |  | NONE | 300 | รายละเอียดใบลา ช่วงลา ผลพิจารณา ประวัติ และเอกสาร (ตามสิทธิ์) |
| `leave.inbox` | USER | leave.approve | leave.confirm_guardian |  | NONE | 300 | งานที่รอฉันพิจารณา (ผู้ปกครองยืนยัน / โรงเรียนอนุมัติ / ขอยกเลิก) |
| `leave.list` | USER | leave.read |  | NONE | 300 | รายการใบลาตามขอบเขตสิทธิ์ |
| `leave.requestCancel` | USER | leave.cancel | ✔ | REQUIRED | 120 | ขอยกเลิกใบลาที่อนุมัติแล้ว (ต้องมีผู้มีอำนาจพิจารณา) |
| `leave.reroute` | USER | leave.approve (STUDENT_AFFAIRS) | ✔ | REQUIRED | 120 | เปลี่ยนผู้พิจารณา (ผู้พิจารณาไม่อยู่/ส่งต่อ) โดยกลุ่มงานกิจการนักเรียน |
| `leave.resubmit` | USER | leave.submit | ✔ | REQUIRED | 120 | แก้ไขและส่งใบลาที่ถูกส่งกลับ (revision ใหม่; ช่วงเดิมถูกถอน) |
| `leave.submit` | USER | leave.submit | ✔ | REQUIRED | 30 | ยื่นใบลา (ทั้งวัน/ครึ่งวัน/บางคาบ หลายวัน) พร้อมเอกสาร — ตรวจวันซ้อน วันหยุด และ enrollment |
| `leave.withdraw` | USER | leave.withdraw | ✔ | REQUIRED | 120 | ถอนคำขอลาที่ยังไม่ได้ข้อยุติ |
| `migration.cancel` | USER | migration.export | ✔ | REQUIRED | 120 | ยกเลิกงาน (ไฟล์ที่ส่งออกแล้วยังอยู่ แต่ใช้ย้ายระบบไม่ได้) |
| `migration.checklist` | USER | migration.cutover | ✔ | REQUIRED | 120 | บันทึก readiness checklist ก่อนสลับระบบ |
| `migration.cutover` | USER | migration.cutover | ✔ | REQUIRED | 120 | สลับระบบ: ระบบนี้กลายเป็น archive อ่านอย่างเดียวถาวร (ห้าม dual-write) — routing ไประบบใหม่ทำตาม RUNBOOK |
| `migration.get` | USER | migration.export |  | NONE | 300 | รายละเอียดงาน: checkpoint ผลตรวจ package หลักฐานนำเข้า/กระทบยอด และ checklist |
| `migration.inventory` | USER | migration.export |  | NONE | 300 | รายการข้อมูลทั้งหมด: ตาราง partition จำนวนรายการ ไฟล์แนบ schema version ขนาดประมาณการ และตารางที่ไม่ส่งออก |
| `migration.markReady` | USER | migration.cutover | ✔ | REQUIRED | 120 | ยืนยันพร้อมสลับระบบ (ต้องกระทบยอดผ่าน + checklist ครบ + package ครบถ้วน) |
| `migration.packageDoc` | USER | migration.export |  | NONE | 300 | ดาวน์โหลดคู่มือที่แนบใน package (ตรงกับ schema/app version ของ package นั้น) |
| `migration.pause` | USER | migration.export | ✔ | REQUIRED | 120 | หยุดงานส่งออกชั่วคราวอย่างปลอดภัย (หยุดหลัง chunk ปัจจุบัน) |
| `migration.recordEvidence` | USER | migration.import | ✔ | REQUIRED | 120 | อ่านหลักฐานจากปลายทางใน package (reports/import.json → STAGED, reports/reconciliation.json → RECONCILED เมื่อผ่านทุกหัวข้อ) |
| `migration.resume` | USER | migration.export | ✔ | REQUIRED | 120 | ทำงานส่งออกต่อจาก checkpoint ล่าสุด |
| `migration.rollback` | USER | migration.cutover | ✔ | REQUIRED | 120 | ย้อนกลับมาใช้ระบบนี้: กรณีไม่มีข้อมูลใหม่ หรือมีข้อมูลใหม่ที่นำ delta กลับมาแล้ว (ตรวจหลักฐาน) — ไม่ทิ้งข้อมูลใหม่ |
| `migration.runs` | USER | migration.export |  | NONE | 300 | งานส่งออก/ย้ายข้อมูลทั้งหมด พร้อมสถานะงานเบื้องหลัง |
| `migration.startExport` | USER | migration.export | ✔ | REQUIRED | 120 | เริ่มส่งออก portable package (งานเบื้องหลัง): ภาพรวมทั้งระบบ/ซ้อมย้าย ต้องเปิดโหมดอ่านอย่างเดียวก่อน; บางส่วนระบุตาราง (ใช้ย้ายระบบทั้งชุดไม่ได้) |
| `migration.validate` | USER | migration.validate | ✔ | REQUIRED | 120 | ตรวจ package ซ้ำ (checksum, schema, ข้อมูล) เป็นงานเบื้องหลัง → ผ่าน = VALIDATED |
| `notification.acknowledge` | USER | notification.acknowledge | ✔ | REQUIRED | 120 | กดรับทราบ หรือขอให้ครูติดต่อกลับ (ผูกกับบัญชีผู้รับจริง) |
| `notification.cancel` | USER | notification.resend | ✔ | REQUIRED | 120 | ยกเลิกรายการที่ยังรอส่ง (มีเหตุผล) |
| `notification.list` | USER | notification.read_own |  | NONE | 300 | การแจ้งเตือนของฉัน (ในแอป) พร้อมสถานะรับทราบ |
| `notification.markRead` | USER | notification.read_own | ✔ | REQUIRED | 120 | ทำเครื่องหมายว่าเปิดอ่านในแอปแล้ว (ไม่ใช่การรับทราบ) |
| `notification.monitor` | USER | notification.monitor |  | NONE | 300 | สถานะคิวส่งแจ้งเตือน (ตามช่องทาง/สถานะ) และรายการส่งไม่สำเร็จ |
| `notification.resend` | USER | notification.resend | ✔ | REQUIRED | 120 | ส่งรายการที่ล้มเหลวอีกครั้ง: RETRY_SAME = retry เดิม (LINE ใช้ retry key เดิม, ไม่ส่งซ้ำถ้าเคยรับแล้ว) / RESEND_NEW = ส่งใหม่เป็นข้อความใหม่ (อาจซ้ำ) |
| `period.create` | USER | settings.business | ✔ | REQUIRED | 120 | กำหนดคาบเรียนพร้อมวันที่มีผล |
| `reconciliation.list` | USER | attendance.reconcile |  | NONE | 300 | งานตรวจสอบข้อมูลขัดกัน/ยังไม่ทราบสถานะ ตามขอบเขต |
| `reconciliation.resolve` | USER | attendance.reconcile | ✔ | REQUIRED | 120 | ปิดงานตรวจสอบพร้อมบันทึกข้อสรุป |
| `report.catalog` | USER | report.view | notification.monitor | audit.read | system.health |  | NONE | 300 | รายงานที่บัญชีนี้ใช้ได้ พร้อมตัวกรองและรูปแบบไฟล์ |
| `report.download` | USER | report.export |  | NONE | 30 | ดาวน์โหลดไฟล์รายงาน (ตรวจสิทธิ์อีกครั้งทุกครั้ง) |
| `report.lock` | USER | report.lock | ✔ | REQUIRED | 120 | ล็อกรายงานเป็นฉบับทางการ (แก้ไขข้อมูลภายหลังต้องออกฉบับใหม่ ฉบับนี้ไม่เปลี่ยน) |
| `report.preview` | USER | ตามรายงาน |  | NONE | 30 | แสดงรายงานบนจอ (ไม่เกิน 500 แถว) — ใช้ projection เดียวกับแดชบอร์ด |
| `report.rerun` | USER | report.export | ✔ | REQUIRED | 120 | สร้างรายงานฉบับใหม่ด้วยตัวกรองเดิม (revision) — ฉบับเดิมยังเก็บไว้ |
| `report.run` | USER | report.export + สิทธิ์ของรายงาน | ✔ | REQUIRED | 10 | สร้างไฟล์รายงาน (CSV/XLSX/PDF) เป็นงานเบื้องหลัง |
| `report.runs` | USER | report.export | report.lock |  | NONE | 300 | รายการไฟล์รายงานที่สร้าง (ของฉัน หรือทั้งหมดสำหรับผู้ล็อกรายงานได้) |
| `retention.preview` | USER | system.maintenance |  | NONE | 300 | ตารางบันทึกระบบที่ครบระยะเก็บแล้ว (ต่อภาคเรียน) และนโยบายไฟล์แนบ |
| `retention.purge` | USER | system.maintenance | ✔ | REQUIRED | 120 | ล้างบันทึกระบบของภาคเรียนที่ครบระยะเก็บ (เฉพาะตารางปฏิบัติการ) |
| `retention.purgeJobs` | USER | system.maintenance | ✔ | REQUIRED | 120 | ลบงานเบื้องหลังที่จบแล้วเกิน 90 วัน |
| `role.grant` | USER | role.assign | ✔ | REQUIRED | 120 | กำหนดบทบาทพร้อมช่วงวันที่มีผล |
| `role.revoke` | USER | role.assign | ✔ | REQUIRED | 120 | เพิกถอนบทบาท (มีผลทันที) |
| `rollcall.get` | USER | attendance.rollcall | attendance.read |  | NONE | 300 | รายชื่อเช็กชื่อประจำวันตาม enrollment ของวันนั้น พร้อมข้อมูลประตูและใบลา |
| `rollcall.submit` | USER | attendance.rollcall | ✔ | REQUIRED | 120 | ส่งผลเช็กชื่อ (ระบุเฉพาะนักเรียนที่ไม่ใช่ "มา"; ส่งซ้ำได้ก่อนยืนยัน) |
| `rule.activate` | USER | settings.business | ✔ | REQUIRED | 120 | เปิดใช้กฎ (ห้ามช่วงซ้อนกับเวอร์ชันที่ใช้งาน; ต้องปิดเวอร์ชันเดิมก่อน) — ไม่คำนวณย้อนหลังอัตโนมัติ |
| `rule.createVersion` | USER | settings.business | ✔ | REQUIRED | 120 | สร้างกฎเวอร์ชันใหม่ (ร่าง) พร้อมตรวจ schema ของพารามิเตอร์ |
| `rule.setEnd` | USER | settings.business | ✔ | REQUIRED | 120 | กำหนดวันสิ้นสุดของกฎที่ใช้งาน (เก็บกฎเดิมไว้อธิบายผลคำนวณเดิม) |
| `school.update` | USER | settings.business | ✔ | REQUIRED | 120 | แก้ไขข้อมูลโรงเรียน (ชื่อ หน่วยงาน สี ตรา) |
| `setting.set` | USER | settings.business | ✔ | REQUIRED | 120 | ตั้งค่าธุรกิจที่ไม่ลับ |
| `settings.overview` | USER | settings.business | system.health |  | NONE | 300 | ค่าตั้งค่าธุรกิจทั้งหมด (ไม่รวม secrets) |
| `station.create` | USER | settings.business | ✔ | REQUIRED | 120 | เพิ่มจุดลงเวลา |
| `station.list` | USER | ตาม handler |  | NONE | 300 | จุดลงเวลา |
| `student.create` | USER | student.manage | ✔ | REQUIRED | 120 | เพิ่มนักเรียนพร้อมห้องเรียนที่มีผล |
| `student.createAccount` | USER | student.manage | ✔ | REQUIRED | 120 | สร้างบัญชีนักเรียน (รอเปิดใช้งานด้วยคำเชิญ) |
| `student.get` | USER | student.read | student.read_basic |  | NONE | 300 | ข้อมูลนักเรียน (เต็ม หรือเฉพาะระบุตัวตามสิทธิ์) |
| `student.listMine` | USER | ตาม handler |  | NONE | 300 | นักเรียนที่ผู้ปกครองดูแล/ตนเอง (ตามความสัมพันธ์ที่ยืนยัน) |
| `student.photo` | USER | student.read_basic |  | NONE | 600 | รูปนักเรียนสำหรับตรวจตัวบุคคล (ข้อมูลระบุตัว) |
| `student.profile` | USER | student.read | student.read_basic |  | NONE | 300 | หน้าประวัตินักเรียน: ข้อมูล สถานะล่าสุด สถิติ timeline ผู้ปกครอง ครู งานค้าง (ตามสิทธิ์) |
| `student.search` | USER | student.search |  | NONE | 240 | ค้นหานักเรียนตามสิทธิ์ (กรองที่ server ก่อนแบ่งหน้า) |
| `student.setPhoto` | USER | student.manage | ✔ | REQUIRED | 120 | ตั้งรูปนักเรียน (ใช้ตรวจตัวบุคคลที่ประตู; ระบบย่อรูปที่เครื่องก่อนส่ง) |
| `student.update` | USER | student.manage | ✔ | REQUIRED | 120 | แก้ไขข้อมูลนักเรียน (มี audit และ version) |
| `system.health` | USER | system.health |  | NONE | 30 | สถานะระบบ (ไม่เปิดเผยความลับ) |
| `system.metrics` | USER | system.health |  | NONE | 300 | เวลาตอบสนอง p50/p95 อัตราผิดพลาด และ lock wait ตาม operation (ช่วงล่าสุด) |
| `system.setMode` | USER | system.maintenance | ✔ | REQUIRED | 120 | เปิด/ปิดโหมดอ่านอย่างเดียว (server บังคับทุกช่องทาง) |
| `term.create` | USER | settings.business | ✔ | REQUIRED | 120 | สร้างภาคเรียน (สร้าง partition workbook ให้อัตโนมัติบน Sheets) |
| `user.createStaff` | USER | user.manage + role.assign | ✔ | REQUIRED | 120 | สร้างบัญชีบุคลากร (สถานะรอเปิดใช้งาน) พร้อมบทบาท |
| `user.get` | USER | user.read |  | NONE | 300 | รายละเอียดผู้ใช้ บทบาท ขอบเขตงาน การเชื่อมบัญชี และคำเชิญ |
| `user.list` | USER | user.read |  | NONE | 300 | รายชื่อผู้ใช้และบทบาท |
| `user.setStatus` | USER | user.manage | ✔ | REQUIRED | 120 | ระงับ/เปิดใช้บัญชี (มีผลทันทีกับคำขอถัดไป) |

## Payload schemas

### academicYear.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "start_year_ce",
    "start_date",
    "end_date"
  ],
  "properties": {
    "start_year_ce": {
      "type": "integer",
      "minimum": 2000,
      "maximum": 2200
    },
    "start_date": {
      "type": "string",
      "format": "date"
    },
    "end_date": {
      "type": "string",
      "format": "date"
    }
  }
}
```

### app.publicConfig

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### appointment.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case_id",
    "scheduled_at"
  ],
  "properties": {
    "case_id": {
      "type": "string",
      "format": "uuid"
    },
    "scheduled_at": {
      "type": "string",
      "format": "timestamp"
    },
    "duration_minutes": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 5,
      "maximum": 600
    },
    "location": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 200
    },
    "attendees_note": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    }
  }
}
```

### appointment.update

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "appointment_id",
    "status"
  ],
  "properties": {
    "appointment_id": {
      "type": "string",
      "format": "uuid"
    },
    "status": {
      "type": "string",
      "enum": [
        "SCHEDULED",
        "COMPLETED",
        "NO_SHOW",
        "CANCELLED",
        "RESCHEDULED"
      ]
    },
    "outcome_note": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 2000
    },
    "scheduled_at": {
      "type": [
        "string",
        "null"
      ],
      "format": "timestamp"
    }
  }
}
```

### assignment.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "user_id",
    "assignment_type",
    "effective_from"
  ],
  "properties": {
    "user_id": {
      "type": "string",
      "format": "uuid"
    },
    "assignment_type": {
      "type": "string",
      "enum": [
        "HOMEROOM",
        "DUTY",
        "TEACHING",
        "DELEGATE"
      ]
    },
    "class_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "station_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "weekday": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 7
    },
    "subject_code": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 30
    },
    "delegate_for_user_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "effective_from": {
      "type": "string",
      "format": "date"
    },
    "effective_to": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "notes": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    }
  }
}
```

### assignment.end

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "assignment_id",
    "effective_to",
    "reason"
  ],
  "properties": {
    "assignment_id": {
      "type": "string",
      "format": "uuid"
    },
    "effective_to": {
      "type": "string",
      "format": "date"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### attachment.download

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "attachment_id"
  ],
  "properties": {
    "attachment_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### attendance.classDay

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "class_id",
    "school_date"
  ],
  "properties": {
    "class_id": {
      "type": "string",
      "format": "uuid"
    },
    "school_date": {
      "type": "string",
      "format": "date"
    }
  }
}
```

### attendance.correct

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "school_date",
    "correction_type",
    "reason"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "school_date": {
      "type": "string",
      "format": "date"
    },
    "correction_type": {
      "type": "string",
      "enum": [
        "VOID_EVENT",
        "AMEND_ARRIVAL_TIME",
        "ADD_ARRIVAL",
        "CHANGE_ROLL_CALL_MARK",
        "EXEMPT_LATENESS"
      ]
    },
    "target_event_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "new_arrived_at": {
      "type": [
        "string",
        "null"
      ],
      "format": "timestamp"
    },
    "new_mark": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "PRESENT",
        "ABSENT",
        "LATE",
        "LEAVE_REPORTED",
        null
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 5,
      "maxLength": 1000
    },
    "correction_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    }
  }
}
```

### attendance.decideCorrection

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "correction_id",
    "decision",
    "decision_note"
  ],
  "properties": {
    "correction_id": {
      "type": "string",
      "format": "uuid"
    },
    "decision": {
      "type": "string",
      "enum": [
        "APPLY",
        "REJECT"
      ]
    },
    "decision_note": {
      "type": "string",
      "minLength": 2,
      "maxLength": 1000
    },
    "target_event_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "new_arrived_at": {
      "type": [
        "string",
        "null"
      ],
      "format": "timestamp"
    },
    "new_mark": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "PRESENT",
        "ABSENT",
        "LATE",
        "LEAVE_REPORTED",
        null
      ]
    }
  }
}
```

### attendance.exempt

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "school_date",
    "student_ids",
    "reason_code",
    "reason_text"
  ],
  "properties": {
    "school_date": {
      "type": "string",
      "format": "date"
    },
    "student_ids": {
      "type": "array",
      "minItems": 1,
      "maxItems": 200,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "format": "uuid"
      }
    },
    "reason_code": {
      "type": "string",
      "enum": [
        "TRANSPORT_DELAY",
        "WEATHER",
        "SCHOOL_EVENT",
        "OTHER"
      ]
    },
    "reason_text": {
      "type": "string",
      "minLength": 5,
      "maxLength": 500
    }
  }
}
```

### attendance.lookupForGate

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "code": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 64
    },
    "student_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    }
  }
}
```

### attendance.recordArrival

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "station_id",
    "source"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "station_id": {
      "type": "string",
      "format": "uuid"
    },
    "source": {
      "type": "string",
      "enum": [
        "SCAN_KEYBOARD",
        "SCAN_CAMERA",
        "SEARCH_CODE",
        "SEARCH_NAME",
        "MANUAL_TIME",
        "QUEUE_BATCH"
      ]
    },
    "arrived_at": {
      "type": [
        "string",
        "null"
      ],
      "format": "timestamp"
    },
    "reason_code": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "TRANSPORT_DELAY",
        "HEALTH",
        "FAMILY",
        "WEATHER",
        "OTHER",
        null
      ]
    },
    "reason_text": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    }
  }
}
```

### attendance.requestCorrection

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "school_date",
    "correction_type",
    "requested_text"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "school_date": {
      "type": "string",
      "format": "date"
    },
    "correction_type": {
      "type": "string",
      "enum": [
        "VOID_EVENT",
        "AMEND_ARRIVAL_TIME",
        "ADD_ARRIVAL",
        "CHANGE_ROLL_CALL_MARK",
        "EXEMPT_LATENESS"
      ]
    },
    "requested_text": {
      "type": "string",
      "minLength": 5,
      "maxLength": 1000
    }
  }
}
```

### attendance.stationLog

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "station_id"
  ],
  "properties": {
    "station_id": {
      "type": "string",
      "format": "uuid"
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### attendance.syncOffline

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "station_id",
    "records"
  ],
  "properties": {
    "station_id": {
      "type": "string",
      "format": "uuid"
    },
    "records": {
      "type": "array",
      "minItems": 1,
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "local_id",
          "idempotency_key",
          "student_code",
          "captured_at"
        ],
        "properties": {
          "local_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "idempotency_key": {
            "type": "string",
            "format": "uuid"
          },
          "student_code": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
          },
          "captured_at": {
            "type": "string",
            "format": "timestamp"
          },
          "claimed_user_id": {
            "type": [
              "string",
              "null"
            ],
            "format": "uuid"
          }
        }
      }
    }
  }
}
```

### attendance.verifyDay

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "class_id",
    "school_date",
    "confirm_absent_student_ids"
  ],
  "properties": {
    "class_id": {
      "type": "string",
      "format": "uuid"
    },
    "school_date": {
      "type": "string",
      "format": "date"
    },
    "confirm_absent_student_ids": {
      "type": "array",
      "maxItems": 200,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "format": "uuid"
      }
    },
    "note": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    }
  }
}
```

### auth.getCurrentUser

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### auth.logout

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### auth.redeemInvitation

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "code"
  ],
  "properties": {
    "code": {
      "type": "string",
      "minLength": 10,
      "maxLength": 40
    }
  }
}
```

### backup.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### backup.recordRestoreTest

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "backup_run_id",
    "result",
    "minutes",
    "note"
  ],
  "properties": {
    "backup_run_id": {
      "type": "string",
      "format": "uuid"
    },
    "result": {
      "type": "string",
      "enum": [
        "PASS",
        "FAIL"
      ]
    },
    "minutes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 10000
    },
    "note": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1000
    }
  }
}
```

### backup.run

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### calendar.set

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "calendar_date",
    "day_type"
  ],
  "properties": {
    "calendar_date": {
      "type": "string",
      "format": "date"
    },
    "day_type": {
      "type": "string",
      "enum": [
        "SCHOOL_DAY",
        "HOLIDAY",
        "NO_SCHOOL",
        "EXAM_DAY",
        "ACTIVITY_DAY"
      ]
    },
    "applies_to_level": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "M1",
        "M2",
        "M3",
        "M4",
        "M5",
        "M6",
        null
      ]
    },
    "title_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 200
    }
  }
}
```

### case.assign

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case_id",
    "owner_user_id",
    "reason"
  ],
  "properties": {
    "case_id": {
      "type": "string",
      "format": "uuid"
    },
    "owner_user_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    }
  }
}
```

### case.assignable

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### case.close

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case_id",
    "resolution_summary"
  ],
  "properties": {
    "case_id": {
      "type": "string",
      "format": "uuid"
    },
    "resolution_summary": {
      "type": "string",
      "minLength": 5,
      "maxLength": 2000
    }
  }
}
```

### case.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "summary_th",
    "priority"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "summary_th": {
      "type": "string",
      "minLength": 5,
      "maxLength": 1000
    },
    "priority": {
      "type": "string",
      "enum": [
        "LOW",
        "NORMAL",
        "HIGH",
        "URGENT"
      ]
    },
    "next_action_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    },
    "due_at": {
      "type": [
        "string",
        "null"
      ],
      "format": "timestamp"
    },
    "owner_user_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    }
  }
}
```

### case.get

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case_id"
  ],
  "properties": {
    "case_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### case.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "status": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "OPEN",
        "IN_PROGRESS",
        "WAITING_RESPONSE",
        "RESOLVED",
        "CLOSED",
        "ACTIVE",
        null
      ]
    },
    "mine": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "student_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "overdue_only": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### case.reopen

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case_id",
    "reason"
  ],
  "properties": {
    "case_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1000
    }
  }
}
```

### case.resolve

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case_id",
    "note"
  ],
  "properties": {
    "case_id": {
      "type": "string",
      "format": "uuid"
    },
    "note": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1000
    }
  }
}
```

### case.update

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case_id"
  ],
  "properties": {
    "case_id": {
      "type": "string",
      "format": "uuid"
    },
    "priority": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "LOW",
        "NORMAL",
        "HIGH",
        "URGENT",
        null
      ]
    },
    "due_at": {
      "type": [
        "string",
        "null"
      ],
      "format": "timestamp"
    },
    "next_action_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    },
    "note": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 1000
    }
  }
}
```

### channel.revokeForUser

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "user_id",
    "reason"
  ],
  "properties": {
    "user_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    }
  }
}
```

### channel.startLineLink

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "link_token"
  ],
  "properties": {
    "link_token": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_-]{8,128}$"
    }
  }
}
```

### channel.status

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### channel.unbind

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "binding_id"
  ],
  "properties": {
    "binding_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### class.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "academic_year_id",
    "grade_level",
    "room_no"
  ],
  "properties": {
    "academic_year_id": {
      "type": "string",
      "format": "uuid"
    },
    "grade_level": {
      "type": "string",
      "enum": [
        "M1",
        "M2",
        "M3",
        "M4",
        "M5",
        "M6"
      ]
    },
    "room_no": {
      "type": "string",
      "pattern": "^[0-9A-Za-z]{1,10}$"
    }
  }
}
```

### class.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "academic_year_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    }
  }
}
```

### contact.add

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "guardian_id",
    "channel",
    "value",
    "reason"
  ],
  "properties": {
    "guardian_id": {
      "type": "string",
      "format": "uuid"
    },
    "channel": {
      "type": "string",
      "enum": [
        "PHONE",
        "EMAIL"
      ]
    },
    "value": {
      "type": "string",
      "minLength": 1,
      "maxLength": 254
    },
    "label_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "is_primary": {
      "type": "boolean"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  }
}
```

### contact.disable

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "contact_id",
    "reason"
  ],
  "properties": {
    "contact_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  }
}
```

### contact.inbox

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### contact.log

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "channel",
    "direction",
    "outcome",
    "summary",
    "follow_up_required"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "case_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "guardian_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "channel": {
      "type": "string",
      "enum": [
        "PHONE",
        "EMAIL",
        "LINE",
        "SMS",
        "IN_PERSON",
        "OTHER"
      ]
    },
    "direction": {
      "type": "string",
      "enum": [
        "OUTBOUND",
        "INBOUND"
      ]
    },
    "outcome": {
      "type": "string",
      "enum": [
        "REACHED",
        "NO_ANSWER",
        "ACKNOWLEDGED",
        "APPOINTMENT_MADE",
        "FOLLOW_UP_NEEDED",
        "WRONG_CONTACT",
        "ASSISTANCE_PROVIDED"
      ]
    },
    "summary": {
      "type": "string",
      "minLength": 3,
      "maxLength": 2000
    },
    "contacted_at": {
      "type": [
        "string",
        "null"
      ],
      "format": "timestamp"
    },
    "follow_up_required": {
      "type": "boolean"
    },
    "next_follow_up_at": {
      "type": [
        "string",
        "null"
      ],
      "format": "timestamp"
    },
    "handles_contact_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    }
  }
}
```

### dashboard.summary

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "school_date": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "class_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    }
  }
}
```

### enrollment.change

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "effective_date",
    "reason",
    "note"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "effective_date": {
      "type": "string",
      "format": "date"
    },
    "reason": {
      "type": "string",
      "enum": [
        "CLASS_CHANGE",
        "PROMOTION",
        "TRANSFER_OUT",
        "GRADUATION",
        "WITHDRAWAL",
        "CORRECTION"
      ]
    },
    "new_class_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "roll_no": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    },
    "note": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### guardian.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "first_name_th",
    "last_name_th"
  ],
  "properties": {
    "external_ref": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^[0-9A-Za-z_-]{1,40}$"
    },
    "prefix_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 30
    },
    "first_name_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "last_name_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "contacts": {
      "type": "array",
      "maxItems": 5,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "channel",
          "value"
        ],
        "properties": {
          "channel": {
            "type": "string",
            "enum": [
              "PHONE",
              "EMAIL"
            ]
          },
          "value": {
            "type": "string",
            "minLength": 1,
            "maxLength": 254
          },
          "label_th": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 100
          },
          "is_primary": {
            "type": "boolean"
          }
        }
      }
    }
  }
}
```

### guardian.createAccount

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "guardian_id"
  ],
  "properties": {
    "guardian_id": {
      "type": "string",
      "format": "uuid"
    },
    "contact_email": {
      "type": [
        "string",
        "null"
      ],
      "format": "email"
    }
  }
}
```

### guardian.endLink

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "link_id",
    "effective_to",
    "reason"
  ],
  "properties": {
    "link_id": {
      "type": "string",
      "format": "uuid"
    },
    "effective_to": {
      "type": "string",
      "format": "date"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### guardian.link

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "guardian_id",
    "relationship",
    "is_primary_contact",
    "contact_priority",
    "verification_method",
    "effective_from"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "guardian_id": {
      "type": "string",
      "format": "uuid"
    },
    "relationship": {
      "type": "string",
      "enum": [
        "FATHER",
        "MOTHER",
        "GRANDPARENT",
        "SIBLING",
        "RELATIVE",
        "LEGAL_GUARDIAN",
        "OTHER"
      ]
    },
    "relationship_note": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 200
    },
    "is_primary_contact": {
      "type": "boolean"
    },
    "contact_priority": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9
    },
    "permitted_actions": {
      "type": "array",
      "minItems": 0,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "enum": [
          "VIEW_ATTENDANCE",
          "SUBMIT_LEAVE",
          "CONFIRM_LEAVE",
          "RECEIVE_NOTIFICATIONS",
          "VIEW_CASE_SUMMARY",
          "VIEW_DOCUMENTS"
        ]
      }
    },
    "notification_preferences": {
      "type": [
        "object",
        "null"
      ]
    },
    "verification_method": {
      "type": "string",
      "enum": [
        "IN_PERSON",
        "DOCUMENT",
        "PHONE_CALLBACK",
        "SCHOOL_RECORD"
      ]
    },
    "effective_from": {
      "type": "string",
      "format": "date"
    }
  }
}
```

### guardian.listForStudent

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### guardian.search

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "q"
  ],
  "properties": {
    "q": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### guardian.updateLink

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "link_id",
    "reason"
  ],
  "properties": {
    "link_id": {
      "type": "string",
      "format": "uuid"
    },
    "is_primary_contact": {
      "type": "boolean"
    },
    "contact_priority": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9
    },
    "permitted_actions": {
      "type": "array",
      "minItems": 0,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "enum": [
          "VIEW_ATTENDANCE",
          "SUBMIT_LEAVE",
          "CONFIRM_LEAVE",
          "RECEIVE_NOTIFICATIONS",
          "VIEW_CASE_SUMMARY",
          "VIEW_DOCUMENTS"
        ]
      }
    },
    "notification_preferences": {
      "type": "object"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### identity.unlink

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "identity_link_id",
    "reason"
  ],
  "properties": {
    "identity_link_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### import.apply

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "batch_id"
  ],
  "properties": {
    "batch_id": {
      "type": "string",
      "format": "uuid"
    },
    "accept_skipping_conflicts": {
      "type": "boolean"
    }
  }
}
```

### import.dryRun

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "batch_id",
    "mapping"
  ],
  "properties": {
    "batch_id": {
      "type": "string",
      "format": "uuid"
    },
    "mapping": {
      "type": "object"
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "date_format": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "ISO",
            "DMY_BE",
            "DMY_CE",
            null
          ]
        },
        "default_effective_from": {
          "type": [
            "string",
            "null"
          ],
          "format": "date"
        },
        "update_existing": {
          "type": [
            "boolean",
            "null"
          ]
        }
      }
    }
  }
}
```

### import.get

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "batch_id"
  ],
  "properties": {
    "batch_id": {
      "type": "string",
      "format": "uuid"
    },
    "attempt_no": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1
    }
  }
}
```

### import.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "cursor": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### import.preview

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "batch_id",
    "mapping"
  ],
  "properties": {
    "batch_id": {
      "type": "string",
      "format": "uuid"
    },
    "mapping": {
      "type": "object"
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "date_format": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "ISO",
            "DMY_BE",
            "DMY_CE",
            null
          ]
        },
        "default_effective_from": {
          "type": [
            "string",
            "null"
          ],
          "format": "date"
        },
        "update_existing": {
          "type": [
            "boolean",
            "null"
          ]
        }
      }
    }
  }
}
```

### import.template

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "import_type"
  ],
  "properties": {
    "import_type": {
      "type": "string",
      "enum": [
        "STUDENTS",
        "CLASSES",
        "ENROLLMENTS",
        "GUARDIANS",
        "STAFF",
        "CALENDAR"
      ]
    }
  }
}
```

### import.upload

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "import_type",
    "file"
  ],
  "properties": {
    "import_type": {
      "type": "string",
      "enum": [
        "STUDENTS",
        "CLASSES",
        "ENROLLMENTS",
        "GUARDIANS",
        "STAFF",
        "CALENDAR"
      ]
    },
    "file": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "filename",
        "content_base64"
      ],
      "properties": {
        "filename": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "mime_type": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 100
        },
        "content_base64": {
          "type": "string",
          "minLength": 4
        }
      }
    }
  }
}
```

### invitation.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "user_id"
  ],
  "properties": {
    "user_id": {
      "type": "string",
      "format": "uuid"
    },
    "bound_email": {
      "type": [
        "string",
        "null"
      ],
      "format": "email"
    },
    "valid_days": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 30
    }
  }
}
```

### invitation.revoke

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "invitation_id",
    "reason"
  ],
  "properties": {
    "invitation_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  }
}
```

### job.getStatus

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "job_id"
  ],
  "properties": {
    "job_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### job.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "status": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "QUEUED",
        "RUNNING",
        "PAUSED",
        "SUCCEEDED",
        "FAILED",
        "CANCELLED",
        null
      ]
    },
    "cursor": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### job.retry

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "job_id",
    "reason"
  ],
  "properties": {
    "job_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  }
}
```

### leave.addAttachment

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id",
    "file"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    },
    "file": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "filename",
        "content_base64"
      ],
      "properties": {
        "filename": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "mime_type": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 100
        },
        "content_base64": {
          "type": "string",
          "minLength": 4
        }
      }
    }
  }
}
```

### leave.confirmGuardian

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id",
    "decision"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    },
    "decision": {
      "type": "string",
      "enum": [
        "CONFIRMED",
        "DECLINED"
      ]
    },
    "comment": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 1000
    }
  }
}
```

### leave.decide

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id",
    "decision"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    },
    "decision": {
      "type": "string",
      "enum": [
        "APPROVED",
        "PARTIALLY_APPROVED",
        "REJECTED",
        "RETURNED"
      ]
    },
    "segment_decisions": {
      "type": [
        "object",
        "null"
      ]
    },
    "comment": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 1000
    }
  }
}
```

### leave.decideCancel

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id",
    "approve",
    "reason"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    },
    "approve": {
      "type": "boolean"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1000
    }
  }
}
```

### leave.get

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### leave.inbox

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### leave.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "student_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "status": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "DRAFT",
        "SUBMITTED",
        "PENDING_GUARDIAN",
        "PENDING_SCHOOL",
        "RETURNED",
        "APPROVED",
        "PARTIALLY_APPROVED",
        "REJECTED",
        "WITHDRAWN",
        "CANCELLATION_REQUESTED",
        "CANCELLED",
        null
      ]
    },
    "from": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "to": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "cursor": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### leave.requestCancel

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id",
    "reason"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1000
    }
  }
}
```

### leave.reroute

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id",
    "approver_role",
    "reason"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    },
    "approver_role": {
      "type": "string",
      "enum": [
        "HOMEROOM_TEACHER",
        "STUDENT_AFFAIRS"
      ]
    },
    "approver_user_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    }
  }
}
```

### leave.resubmit

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id",
    "leave_type",
    "reason",
    "days"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    },
    "leave_type": {
      "type": "string",
      "enum": [
        "SICK",
        "PERSONAL",
        "SCHOOL_ACTIVITY",
        "OTHER"
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1000
    },
    "days": {
      "type": "array",
      "minItems": 1,
      "maxItems": 31,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "school_date",
          "unit"
        ],
        "properties": {
          "school_date": {
            "type": "string",
            "format": "date"
          },
          "unit": {
            "type": "string",
            "enum": [
              "FULL_DAY",
              "HALF_DAY_AM",
              "HALF_DAY_PM",
              "PERIODS"
            ]
          },
          "periods": {
            "type": [
              "array",
              "null"
            ],
            "maxItems": 20,
            "uniqueItems": true,
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 20
            }
          }
        }
      }
    },
    "retroactive_reason": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 1000
    }
  }
}
```

### leave.submit

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "leave_type",
    "reason",
    "days"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "leave_type": {
      "type": "string",
      "enum": [
        "SICK",
        "PERSONAL",
        "SCHOOL_ACTIVITY",
        "OTHER"
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 1000
    },
    "days": {
      "type": "array",
      "minItems": 1,
      "maxItems": 31,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "school_date",
          "unit"
        ],
        "properties": {
          "school_date": {
            "type": "string",
            "format": "date"
          },
          "unit": {
            "type": "string",
            "enum": [
              "FULL_DAY",
              "HALF_DAY_AM",
              "HALF_DAY_PM",
              "PERIODS"
            ]
          },
          "periods": {
            "type": [
              "array",
              "null"
            ],
            "maxItems": 20,
            "uniqueItems": true,
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 20
            }
          }
        }
      }
    },
    "retroactive_reason": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 1000
    },
    "attachments": {
      "type": "array",
      "maxItems": 3,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "filename",
          "content_base64"
        ],
        "properties": {
          "filename": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "mime_type": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 100
          },
          "content_base64": {
            "type": "string",
            "minLength": 4
          }
        }
      }
    }
  }
}
```

### leave.withdraw

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "leave_request_id"
  ],
  "properties": {
    "leave_request_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    }
  }
}
```

### migration.cancel

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id",
    "reason"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    }
  }
}
```

### migration.checklist

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id",
    "items"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    },
    "items": {
      "type": "object",
      "additionalProperties": {
        "type": "boolean"
      },
      "maxProperties": 20
    }
  }
}
```

### migration.cutover

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id",
    "reason",
    "confirm"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    },
    "confirm": {
      "type": "string",
      "const": "CUTOVER"
    }
  }
}
```

### migration.get

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### migration.inventory

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### migration.markReady

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### migration.packageDoc

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id",
    "name"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    },
    "name": {
      "type": "string",
      "enum": [
        "PORTABLE_FORMAT.md",
        "MIGRATION_RUNBOOK_TH.md"
      ]
    }
  }
}
```

### migration.pause

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### migration.recordEvidence

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id",
    "kind"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    },
    "kind": {
      "type": "string",
      "enum": [
        "IMPORT",
        "RECONCILIATION"
      ]
    }
  }
}
```

### migration.resume

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### migration.rollback

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id",
    "case",
    "reason"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    },
    "case": {
      "type": "string",
      "enum": [
        "NO_NEW_DATA",
        "NEW_DATA_RETURNED"
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    },
    "delta_location": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 300
    }
  }
}
```

### migration.runs

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### migration.startExport

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "mode",
    "reason"
  ],
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "FULL_SNAPSHOT",
        "REHEARSAL",
        "PARTIAL"
      ]
    },
    "tables": {
      "type": [
        "array",
        "null"
      ],
      "maxItems": 80,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "maxLength": 60
      }
    },
    "include_attachments": {
      "type": "boolean"
    },
    "include_csv": {
      "type": "boolean"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    }
  }
}
```

### migration.validate

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### notification.acknowledge

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "recipient_id",
    "action"
  ],
  "properties": {
    "recipient_id": {
      "type": "string",
      "format": "uuid"
    },
    "action": {
      "type": "string",
      "enum": [
        "ACKNOWLEDGED",
        "CALLBACK_REQUESTED"
      ]
    },
    "note": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    }
  }
}
```

### notification.cancel

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "outbox_id",
    "reason"
  ],
  "properties": {
    "outbox_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    }
  }
}
```

### notification.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "unread_only": {
      "type": [
        "boolean",
        "null"
      ]
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### notification.markRead

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "recipient_ids"
  ],
  "properties": {
    "recipient_ids": {
      "type": "array",
      "minItems": 1,
      "maxItems": 100,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "format": "uuid"
      }
    }
  }
}
```

### notification.monitor

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "state": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "QUEUED",
        "PROCESSING",
        "PROVIDER_ACCEPTED",
        "RETRY_WAIT",
        "FAILED_FINAL",
        "CANCELLED",
        null
      ]
    },
    "channel": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "EMAIL",
        "LINE",
        "SMS",
        null
      ]
    },
    "outbox_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "days": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 400
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### notification.resend

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "outbox_id",
    "mode",
    "reason"
  ],
  "properties": {
    "outbox_id": {
      "type": "string",
      "format": "uuid"
    },
    "mode": {
      "type": "string",
      "enum": [
        "RETRY_SAME",
        "RESEND_NEW"
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 3,
      "maxLength": 500
    }
  }
}
```

### period.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "period_no",
    "label_th",
    "session",
    "start_time",
    "end_time",
    "effective_from"
  ],
  "properties": {
    "period_no": {
      "type": "integer",
      "minimum": 0,
      "maximum": 20
    },
    "label_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 50
    },
    "session": {
      "type": "string",
      "enum": [
        "AM",
        "PM"
      ]
    },
    "start_time": {
      "type": "string",
      "format": "hhmm"
    },
    "end_time": {
      "type": "string",
      "format": "hhmm"
    },
    "effective_from": {
      "type": "string",
      "format": "date"
    },
    "effective_to": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "applies_to_level": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "M1",
        "M2",
        "M3",
        "M4",
        "M5",
        "M6",
        null
      ]
    }
  }
}
```

### reconciliation.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "status": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "OPEN",
        "RESOLVED",
        "DISMISSED",
        null
      ]
    },
    "class_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "cursor": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### reconciliation.resolve

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "task_id",
    "status",
    "resolution_note"
  ],
  "properties": {
    "task_id": {
      "type": "string",
      "format": "uuid"
    },
    "status": {
      "type": "string",
      "enum": [
        "RESOLVED",
        "DISMISSED"
      ]
    },
    "resolution_note": {
      "type": "string",
      "minLength": 2,
      "maxLength": 1000
    }
  }
}
```

### report.catalog

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### report.download

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### report.lock

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    },
    "note": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    }
  }
}
```

### report.preview

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "code"
  ],
  "properties": {
    "code": {
      "type": "string",
      "enum": [
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R07",
        "R08",
        "R09",
        "R10",
        "R11",
        "R12"
      ]
    },
    "filter": {
      "type": "object",
      "maxProperties": 20,
      "additionalProperties": {
        "type": [
          "string",
          "boolean",
          "null"
        ],
        "maxLength": 100
      }
    }
  }
}
```

### report.rerun

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_id"
  ],
  "properties": {
    "run_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### report.run

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "code",
    "format"
  ],
  "properties": {
    "code": {
      "type": "string",
      "enum": [
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R07",
        "R08",
        "R09",
        "R10",
        "R11",
        "R12"
      ]
    },
    "filter": {
      "type": "object",
      "maxProperties": 20,
      "additionalProperties": {
        "type": [
          "string",
          "boolean",
          "null"
        ],
        "maxLength": 100
      }
    },
    "format": {
      "type": "string",
      "enum": [
        "CSV",
        "XLSX",
        "PDF"
      ]
    }
  }
}
```

### report.runs

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "code": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R07",
        "R08",
        "R09",
        "R10",
        "R11",
        "R12",
        null
      ]
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### retention.preview

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### retention.purge

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "table",
    "partition",
    "reason"
  ],
  "properties": {
    "table": {
      "type": "string",
      "enum": [
        "IdempotencyRecords",
        "MutationJournal",
        "WebhookInbox",
        "OperationMetrics",
        "NotificationAttempts"
      ]
    },
    "partition": {
      "type": "string",
      "pattern": "^AY[0-9]{4}-T[0-9]$"
    },
    "reason": {
      "type": "string",
      "minLength": 5,
      "maxLength": 500
    }
  }
}
```

### retention.purgeJobs

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "reason"
  ],
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 5,
      "maxLength": 500
    }
  }
}
```

### role.grant

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "user_id",
    "role",
    "effective_from",
    "reason"
  ],
  "properties": {
    "user_id": {
      "type": "string",
      "format": "uuid"
    },
    "role": {
      "type": "string",
      "enum": [
        "SYSTEM_ADMIN",
        "STUDENT_AFFAIRS",
        "EXECUTIVE",
        "HOMEROOM_TEACHER",
        "SUBJECT_TEACHER",
        "DUTY_TEACHER",
        "GATE_STAFF",
        "GUARDIAN",
        "STUDENT"
      ]
    },
    "effective_from": {
      "type": "string",
      "format": "date"
    },
    "effective_to": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### role.revoke

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "user_role_id",
    "reason"
  ],
  "properties": {
    "user_role_id": {
      "type": "string",
      "format": "uuid"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### rollcall.get

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "class_id",
    "school_date"
  ],
  "properties": {
    "class_id": {
      "type": "string",
      "format": "uuid"
    },
    "school_date": {
      "type": "string",
      "format": "date"
    }
  }
}
```

### rollcall.submit

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "class_id",
    "school_date",
    "marks"
  ],
  "properties": {
    "class_id": {
      "type": "string",
      "format": "uuid"
    },
    "school_date": {
      "type": "string",
      "format": "date"
    },
    "marks": {
      "type": "array",
      "maxItems": 200,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "student_id",
          "mark"
        ],
        "properties": {
          "student_id": {
            "type": "string",
            "format": "uuid"
          },
          "mark": {
            "type": "string",
            "enum": [
              "PRESENT",
              "ABSENT",
              "LATE",
              "LEAVE_REPORTED"
            ]
          }
        }
      }
    }
  }
}
```

### rule.activate

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "rule_id",
    "confirm_school_policy"
  ],
  "properties": {
    "rule_id": {
      "type": "string",
      "format": "uuid"
    },
    "confirm_school_policy": {
      "type": "boolean"
    }
  }
}
```

### rule.createVersion

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "rule_type",
    "effective_from",
    "params_json"
  ],
  "properties": {
    "rule_type": {
      "type": "string",
      "enum": [
        "SCHOOL_LATENESS",
        "PERIOD_LATENESS",
        "FOLLOWUP_LATE_COUNT",
        "FOLLOWUP_ABSENCE_COUNT",
        "LEAVE_ROUTING",
        "ABSENCE_VERIFICATION",
        "NOTIFICATION_POLICY"
      ]
    },
    "effective_from": {
      "type": "string",
      "format": "date"
    },
    "effective_to": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "params_json": {
      "type": "object"
    },
    "notes_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 2000
    }
  }
}
```

### rule.setEnd

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "rule_id",
    "effective_to",
    "reason"
  ],
  "properties": {
    "rule_id": {
      "type": "string",
      "format": "uuid"
    },
    "effective_to": {
      "type": "string",
      "format": "date"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### school.update

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "name_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "unit_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 200
    },
    "brand_color": {
      "type": "string",
      "pattern": "^#[0-9A-Fa-f]{6}$"
    },
    "logo_file_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    }
  }
}
```

### setting.set

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "key"
  ],
  "properties": {
    "key": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_.]*$",
      "maxLength": 100
    },
    "value": {},
    "description_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    }
  }
}
```

### settings.overview

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### station.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "code",
    "name_th",
    "station_type"
  ],
  "properties": {
    "code": {
      "type": "string",
      "pattern": "^[0-9A-Za-z_-]{1,30}$"
    },
    "name_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "station_type": {
      "type": "string",
      "enum": [
        "GATE",
        "OFFICE",
        "CLASSROOM"
      ]
    }
  }
}
```

### station.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### student.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_code",
    "first_name_th",
    "last_name_th",
    "class_id",
    "effective_from"
  ],
  "properties": {
    "student_code": {
      "type": "string",
      "pattern": "^[0-9A-Za-z-]{1,20}$",
      "maxLength": 20,
      "x-pattern-th": "รหัสนักเรียนใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ และ -"
    },
    "prefix_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 30
    },
    "first_name_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "last_name_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "first_name_en": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "last_name_en": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "nickname": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 50
    },
    "gender": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "MALE",
        "FEMALE",
        "OTHER",
        "UNSPECIFIED",
        null
      ]
    },
    "birth_date": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "class_id": {
      "type": "string",
      "format": "uuid"
    },
    "effective_from": {
      "type": "string",
      "format": "date"
    },
    "roll_no": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### student.createAccount

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "contact_email": {
      "type": [
        "string",
        "null"
      ],
      "format": "email"
    }
  }
}
```

### student.get

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### student.listMine

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### student.photo

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### student.profile

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "from": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "to": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    }
  }
}
```

### student.search

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "q": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "class_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "status": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "ACTIVE",
        "TRANSFERRED_OUT",
        "GRADUATED",
        "WITHDRAWN",
        "SUSPENDED",
        null
      ]
    },
    "cursor": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### student.setPhoto

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "file"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "file": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "filename",
        "content_base64"
      ],
      "properties": {
        "filename": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "mime_type": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 100
        },
        "content_base64": {
          "type": "string",
          "minLength": 4,
          "maxLength": 1500000
        }
      }
    }
  }
}
```

### student.update

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "student_id",
    "reason"
  ],
  "properties": {
    "student_id": {
      "type": "string",
      "format": "uuid"
    },
    "prefix_th": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 30
    },
    "first_name_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "last_name_th": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "first_name_en": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "last_name_en": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "nickname": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 50
    },
    "gender": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "MALE",
        "FEMALE",
        "OTHER",
        "UNSPECIFIED",
        null
      ]
    },
    "birth_date": {
      "type": [
        "string",
        "null"
      ],
      "format": "date"
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### system.health

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {}
}
```

### system.metrics

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "hours": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 168
    }
  }
}
```

### system.setMode

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "mode",
    "reason"
  ],
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "NORMAL",
        "READ_ONLY"
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

### term.create

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "academic_year_id",
    "term_no",
    "start_date",
    "end_date"
  ],
  "properties": {
    "academic_year_id": {
      "type": "string",
      "format": "uuid"
    },
    "term_no": {
      "type": "integer",
      "minimum": 1,
      "maximum": 3
    },
    "start_date": {
      "type": "string",
      "format": "date"
    },
    "end_date": {
      "type": "string",
      "format": "date"
    }
  }
}
```

### user.createStaff

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "display_name",
    "roles",
    "effective_from"
  ],
  "properties": {
    "display_name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "contact_email": {
      "type": [
        "string",
        "null"
      ],
      "format": "email"
    },
    "staff_code": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^[0-9A-Za-z_-]{1,30}$"
    },
    "roles": {
      "type": "array",
      "minItems": 0,
      "maxItems": 7,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "enum": [
          "SYSTEM_ADMIN",
          "STUDENT_AFFAIRS",
          "EXECUTIVE",
          "HOMEROOM_TEACHER",
          "SUBJECT_TEACHER",
          "DUTY_TEACHER",
          "GATE_STAFF"
        ]
      }
    },
    "effective_from": {
      "type": "string",
      "format": "date"
    }
  }
}
```

### user.get

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "user_id"
  ],
  "properties": {
    "user_id": {
      "type": "string",
      "format": "uuid"
    }
  }
}
```

### user.list

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [],
  "properties": {
    "user_type": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "STAFF",
        "GUARDIAN",
        "STUDENT",
        "SYSTEM",
        null
      ]
    },
    "status": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "INVITED",
        "ACTIVE",
        "DISABLED",
        null
      ]
    },
    "q": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "cursor": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 500
    },
    "limit": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

### user.setStatus

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "user_id",
    "status",
    "reason"
  ],
  "properties": {
    "user_id": {
      "type": "string",
      "format": "uuid"
    },
    "status": {
      "type": "string",
      "enum": [
        "ACTIVE",
        "DISABLED"
      ]
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

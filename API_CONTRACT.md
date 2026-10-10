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

## Operations (57)

| operation | auth | permission | mutation | idempotency | rate/min | คำอธิบาย |
|---|---|---|---|---|---|---|
| `academicYear.create` | USER | settings.business | ✔ | REQUIRED | 120 | สร้างปีการศึกษา |
| `app.publicConfig` | PUBLIC | — |  | NONE | 60 | ค่าตั้งค่าสาธารณะสำหรับหน้าเว็บ (ไม่มี secret) |
| `assignment.create` | USER | user.manage | settings.business | ✔ | REQUIRED | 120 | กำหนดครูที่ปรึกษา/เวร/สอน/ผู้รักษาการแทน พร้อมช่วงเวลา |
| `assignment.end` | USER | user.manage | settings.business | ✔ | REQUIRED | 120 | สิ้นสุดขอบเขตงาน |
| `auth.getCurrentUser` | IDENTITY | ตาม handler |  | NONE | 300 | ข้อมูลผู้ใช้ปัจจุบัน บทบาท และเมนูที่มีสิทธิ์ |
| `auth.logout` | IDENTITY | ตาม handler |  | NONE | 300 | ออกจากระบบ (ล้างผลตรวจ token ที่ server cache; client เรียก signOut ของ SDK) |
| `auth.redeemInvitation` | IDENTITY | ตาม handler | ✔ | REQUIRED | 10 | ใช้รหัสคำเชิญผูกบัญชีผู้ให้บริการยืนยันตัวตนกับผู้ใช้ในระบบ (ครั้งเดียว มีอายุ) |
| `calendar.set` | USER | settings.business | ✔ | REQUIRED | 120 | กำหนดวันหยุด/วันพิเศษ (ทับค่าเริ่มต้นจันทร์–ศุกร์) |
| `class.create` | USER | settings.business | ✔ | REQUIRED | 120 | สร้างห้องเรียน |
| `class.list` | USER | ตาม handler |  | NONE | 300 | รายชื่อห้องเรียน (ข้อมูลไม่อ่อนไหว) |
| `contact.add` | USER | guardian.manage | ✔ | REQUIRED | 120 | เพิ่มช่องทางติดต่อผู้ปกครอง (เจ้าหน้าที่ยืนยัน) |
| `contact.disable` | USER | guardian.manage | ✔ | REQUIRED | 120 | ยกเลิกช่องทางติดต่อ (มี audit) |
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
| `period.create` | USER | settings.business | ✔ | REQUIRED | 120 | กำหนดคาบเรียนพร้อมวันที่มีผล |
| `role.grant` | USER | role.assign | ✔ | REQUIRED | 120 | กำหนดบทบาทพร้อมช่วงวันที่มีผล |
| `role.revoke` | USER | role.assign | ✔ | REQUIRED | 120 | เพิกถอนบทบาท (มีผลทันที) |
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
| `student.search` | USER | student.search |  | NONE | 240 | ค้นหานักเรียนตามสิทธิ์ (กรองที่ server ก่อนแบ่งหน้า) |
| `student.update` | USER | student.manage | ✔ | REQUIRED | 120 | แก้ไขข้อมูลนักเรียน (มี audit และ version) |
| `system.health` | USER | system.health |  | NONE | 30 | สถานะระบบ (ไม่เปิดเผยความลับ) |
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

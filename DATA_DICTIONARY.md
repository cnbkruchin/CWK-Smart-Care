# Data Dictionary — CWK Smart Care

> สร้างอัตโนมัติจาก `src/schema/tables.js` และ `src/schema/enums.js` ด้วย `npm run gen` — ห้ามแก้ไขไฟล์นี้ด้วยมือ  
> schema_version: **1** · ตารางทั้งหมด 56 ตาราง · JSON Schema อยู่ที่ `schema/tables/*.schema.json` · SQL อยู่ที่ `database/postgres/migrations/0001_init.sql`

## 1. หลักการข้อมูล

- **ID ภายใน** เป็น UUID เสมอ ไม่ใช้เลขแถว ชื่อ หรือเบอร์โทรเป็น primary key; ตารางที่มี natural key (เช่น DailyAttendance, RollCallSessions, NotificationOutbox, IdempotencyRecords) ใช้ UUIDv5 ที่คำนวณได้เหมือนกันทุกแพลตฟอร์ม
- **student_code** เป็น business key แบบ string ไม่ซ้ำภายในโรงเรียน รักษาเลขศูนย์นำหน้า (เช่น `00123`)
- **วันที่** เก็บเป็น ค.ศ. `YYYY-MM-DD`; **timestamp** เก็บ UTC ISO 8601 พร้อมมิลลิวินาที `YYYY-MM-DDTHH:mm:ss.sssZ`; `school_date` อนุมานด้วยเขตเวลา Asia/Bangkok (UTC+7 คงที่ ไม่มี DST) แยกจาก timestamp; แปลงเป็น พ.ศ. เฉพาะชั้นแสดงผล
- **ช่วงเวลา** ใช้ half-open `[start, end)` ทั้งระบบ (`effective_to`/`end_date` ไม่รวม; ค่าว่าง = ไม่มีกำหนดสิ้นสุด)
- **enum** เก็บค่าคงที่ภาษาอังกฤษ ไม่ใช้ข้อความภาษาไทยเป็นรหัส
- **ความสัมพันธ์** ใช้ตาราง (เช่น StudentGuardians) ไม่เก็บหลายค่าคั่น comma ในเซลล์; json ใช้เฉพาะ metadata/config ที่มี schema
- **ตารางที่แก้ไขได้** มี `created_at, created_by, updated_at, updated_by, version` (optimistic concurrency) และสถานะ/ฟิลด์ lifecycle ตามชนิดข้อมูล
- **ตาราง event/audit (kind = EVENT)** เป็น append-only การแก้ไขใช้แถวใหม่ที่อ้าง `supersedes_*` แทนการลบ/เขียนทับ (PostgreSQL บังคับด้วย trigger)
- **projection** (DailyAttendance) สร้างใหม่ได้จากข้อมูลต้นทาง ไม่ใช้สูตรใน Sheet
- **created_by/updated_by** อ้าง Users แบบ soft reference (ไม่บังคับ FK) เพื่อให้ระบบ/งานเบื้องหลังบันทึกได้ด้วย system principal `00000000-0000-4000-8000-000000000001` และหลีกเลี่ยงวงอ้างอิง

## 2. การแทนค่า (canonical JSON ↔ Google Sheets ↔ PostgreSQL)

| ชนิด | canonical JSON (portable/API) | Google Sheets cell | PostgreSQL |
|---|---|---|---|
| null (ไม่มีค่า) | `null` | เซลล์ว่าง | `NULL` |
| string/text/enum/hhmm/uuid | string | ข้อความนำหน้าด้วย `'` เสมอ (บังคับเป็นข้อความ: รักษา `00123`, กัน `=`/`+`/`-`/`@` ถูกตีความเป็นสูตร) | `text`/`uuid` + CHECK |
| empty string | **ไม่อนุญาต** — normalize เป็น `null` ที่ชั้น validation (Sheets แยกไม่ได้ระหว่างว่างกับ "") | — | CHECK `<> ''` |
| int | number (integer) | ตัวเลข | `integer` |
| bool | `true`/`false` | TRUE/FALSE (boolean) | `boolean` |
| date | `"2026-10-10"` | ข้อความ `'2026-10-10` | `date` |
| timestamp | `"2026-10-10T01:42:00.000Z"` | ข้อความ ISO | `timestamptz` |
| json | object/array | ข้อความ JSON (≤ 45,000 ตัวอักษร ต่ำกว่าขีดจำกัด 50,000 ต่อเซลล์) | `jsonb` |

การตรวจ round-trip ของการแทนค่าใน Sheets จริงทำได้ด้วยฟังก์ชัน editor `adminSelfTest()` (ดู docs/INSTALL_GAS_TH.md) — ผลบน Apps Script จริงยังเป็นรายการ UAT ที่ต้องทำบนบัญชีโรงเรียน

## 3. ระดับความอ่อนไหวและ retention

| sensitivity | ความหมาย |
|---|---|
| PUBLIC | เปิดเผยได้ภายในโรงเรียน (ชื่อห้อง ปฏิทิน) |
| INTERNAL | ข้อมูลการทำงานภายใน |
| PERSONAL | ข้อมูลส่วนบุคคล ต้องตรวจสิทธิ์ตามขอบเขตนักเรียน |
| SENSITIVE | ข้อมูลอ่อนไหว (สุขภาพ การช่วยเหลือ audit) เข้าถึงเฉพาะสิทธิ์เฉพาะ |
| SECRET | ค่าตรวจสอบความลับ (hash ของคำเชิญ/nonce) ไม่ export ไม่แสดง |

รหัส retention เป็น **ค่าเสนอเริ่มต้น** ที่โรงเรียนต้องยืนยันตามนโยบาย (ดู docs/OPERATIONS_TH.md §Retention): `1Y`, `2Y`, `30D`, `30D_AFTER_COMMIT`, `90D`, `ACADEMIC_YEAR_PLUS_2Y`, `ACCOUNT_LIFETIME_PLUS_1Y`, `AUDIT_5Y`, `BY_CLASSIFICATION`, `ENROLLMENT_PLUS_5Y`, `PERMANENT`, `TERM_PLUS_1Y`

## 4. ลำดับ dependency (สำหรับ import/restore)

1. Schools
2. AcademicYears
3. Terms
4. SchoolCalendar
5. Periods
6. Settings
7. Guardians
8. Students
9. Users
10. RuleVersions
11. SchemaVersions
12. StorageCatalog
13. InvitationRecords
14. IdentityLinks
15. UserRoles
16. Classes
17. Stations
18. StaffAssignments
19. Enrollments
20. StudentGuardians
21. ContactEndpoints
22. LeaveRequests
23. RollCallSessions
24. AttendanceEvents
25. DailyAttendance
26. AttendanceCorrections
27. ReconciliationTasks
28. LeaveApprovals
29. LeaveSegments
30. LeaveRevisions
31. Cases
32. CaseEvents
33. ContactLogs
34. Appointments
35. Attachments
36. AttachmentLinks
37. StorageObjectMappings
38. Notifications
39. NotificationRecipients
40. NotificationOutbox
41. NotificationAttempts
42. Acknowledgements
43. ChannelBindings
44. WebhookInbox
45. MutationJournal
46. IdempotencyRecords
47. AuditEvents
48. Jobs
49. ImportBatches
50. ImportErrors
51. MigrationRuns
52. MigrationCheckpoints
53. BackupRuns
54. ChangeLog
55. ReportRuns
56. OperationMetrics

## 5. Partition และ workbook (Google Sheets adapter)

| ตาราง | partition | คอลัมน์ที่ใช้คำนวณ | workbook |
|---|---|---|---|
| Schools | NONE | - | Master |
| AcademicYears | NONE | - | Master |
| Terms | NONE | - | Master |
| SchoolCalendar | NONE | - | Master |
| Periods | NONE | - | Master |
| Settings | NONE | - | Master |
| RuleVersions | NONE | - | Master |
| SchemaVersions | NONE | - | Master |
| StorageCatalog | NONE | - | Master |
| Users | NONE | - | Master |
| IdentityLinks | NONE | - | Master |
| UserRoles | NONE | - | Master |
| StaffAssignments | NONE | - | Master |
| InvitationRecords | NONE | - | Master |
| Stations | NONE | - | Master |
| Students | NONE | - | Master |
| Classes | NONE | - | Master |
| Enrollments | NONE | - | Master |
| Guardians | NONE | - | Master |
| StudentGuardians | NONE | - | Master |
| ContactEndpoints | NONE | - | Master |
| AttendanceEvents | TERM | school_date | Ops (ต่อภาคเรียน) |
| DailyAttendance | TERM | school_date | Daily (ต่อภาคเรียน) |
| RollCallSessions | TERM | school_date | Ops (ต่อภาคเรียน) |
| AttendanceCorrections | TERM | school_date | Ops (ต่อภาคเรียน) |
| ReconciliationTasks | NONE | - | Master |
| LeaveRequests | NONE | - | Master |
| LeaveSegments | NONE | - | Master |
| LeaveRevisions | NONE | - | Master |
| LeaveApprovals | NONE | - | Master |
| Cases | NONE | - | Master |
| CaseEvents | NONE | - | Master |
| ContactLogs | NONE | - | Master |
| Appointments | NONE | - | Master |
| Attachments | NONE | - | Master |
| AttachmentLinks | NONE | - | Master |
| StorageObjectMappings | NONE | - | Master |
| Notifications | TERM | created_at | Notify (ต่อภาคเรียน) |
| NotificationRecipients | TERM | created_at | Notify (ต่อภาคเรียน) |
| NotificationOutbox | TERM | created_at | Notify (ต่อภาคเรียน) |
| NotificationAttempts | TERM | started_at | Notify (ต่อภาคเรียน) |
| Acknowledgements | TERM | acted_at | Notify (ต่อภาคเรียน) |
| ChannelBindings | NONE | - | Master |
| WebhookInbox | TERM | received_at | Notify (ต่อภาคเรียน) |
| MutationJournal | TERM | prepared_at | Ops (ต่อภาคเรียน) |
| IdempotencyRecords | TERM | created_at | Ops (ต่อภาคเรียน) |
| AuditEvents | TERM | occurred_at | Ops (ต่อภาคเรียน) |
| Jobs | NONE | - | Master |
| ImportBatches | NONE | - | Master |
| ImportErrors | NONE | - | Master |
| MigrationRuns | NONE | - | Master |
| MigrationCheckpoints | NONE | - | Master |
| BackupRuns | NONE | - | Master |
| ChangeLog | TERM | committed_at | Ops (ต่อภาคเรียน) |
| ReportRuns | NONE | - | Master |
| OperationMetrics | TERM | bucket_start | Ops (ต่อภาคเรียน) |

Partition key = รหัสภาคเรียน (`Terms.code` เช่น `AY2026-T1`); วันที่นอกภาคเรียนเข้าภาคเรียนล่าสุดก่อนหน้า; StorageCatalog เป็นผู้ map ไป workbook/sheet; ประเมินขนาดด้วย `npm run capacity` (docs/CAPACITY.md)

## 6. ตาราง

### กลุ่ม Configuration

#### Schools (`schools`)

ข้อมูลโรงเรียน (ระยะแรก single-school แต่เก็บ school_id เพื่อจัดขอบเขต)

- kind: **CONFIG** · partition: **NONE** · sensitivity: **PUBLIC** · retention: `PERMANENT`
- unique: (code)
- lookup/index (access pattern): by id — getById (ทุกคำขอ, cache ได้)

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| code | string(30) | ✔ |  |  |
| name_th | string(200) | ✔ |  |  |
| name_en | string(200) |  |  |  |
| unit_th | string(200) |  |  | หน่วยงาน เช่น กลุ่มบริหารงานกิจการนักเรียน |
| timezone | string(40) | ✔ | default "Asia/Bangkok" |  |
| locale | string(10) | ✔ | default "th-TH" |  |
| logo_file_id | uuid |  |  | Attachments.id ของตราโรงเรียน (soft reference); ว่าง = แสดงชื่อโรงเรียน |
| brand_color | string(7) |  | pattern `^#[0-9A-Fa-f]{6}$`; default "#B91C1C" | สีหลัก (ค่าตัวอย่าง ไม่ใช่สีอัตลักษณ์ที่รับรอง) |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### AcademicYears (`academic_years`)

ปีการศึกษา ช่วง [start_date, end_date)

- kind: **CONFIG** · partition: **NONE** · sensitivity: **PUBLIC** · retention: `PERMANENT`
- unique: (school_id, start_year_ce)
- checks: `start_date < end_date`
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| start_year_ce | int | ✔ | ≥ 2000; ≤ 2200 | ปี ค.ศ. ที่เริ่มปีการศึกษา (แสดงผลเป็น พ.ศ.) |
| label_th | string(100) | ✔ |  |  |
| start_date | date | ✔ |  |  |
| end_date | date | ✔ |  | วันสิ้นสุดแบบไม่รวม (exclusive) |
| status | enum `YearStatus` | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### Terms (`terms`)

ภาคเรียน และ partition key ของข้อมูลปฏิบัติการ

- kind: **CONFIG** · partition: **NONE** · sensitivity: **PUBLIC** · retention: `PERMANENT`
- unique: (code); (academic_year_id, term_no)
- checks: `start_date < end_date`
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| academic_year_id | uuid | ✔ | FK → AcademicYears.id |  |
| term_no | int | ✔ | ≥ 1; ≤ 3 |  |
| code | string(20) | ✔ | pattern `^AY\d{4}-T[1-3]$` | เช่น AY2026-T1 ใช้เป็น partition key |
| start_date | date | ✔ |  |  |
| end_date | date | ✔ |  | exclusive |
| status | enum `YearStatus` | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### SchoolCalendar (`school_calendar`)

ข้อยกเว้นปฏิทิน (ค่าเริ่มต้น: จันทร์–ศุกร์ในภาคเรียนเป็นวันเรียน) ใช้ applies_to_level ว่าง = ทุกระดับ

- kind: **CONFIG** · partition: **NONE** · sensitivity: **PUBLIC** · retention: `PERMANENT`
- unique: (school_id, calendar_date, applies_to_level) NULLS NOT DISTINCT
- lookup/index (access pattern): calendar_date

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| calendar_date | date | ✔ |  |  |
| day_type | enum `DayType` | ✔ |  |  |
| applies_to_level | enum `GradeLevel` |  |  | ว่าง = ทุกระดับชั้น |
| title_th | string(200) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### Periods (`periods`)

คาบเรียนพร้อมวันที่มีผล

- kind: **CONFIG** · partition: **NONE** · sensitivity: **PUBLIC** · retention: `PERMANENT`
- unique: (school_id, period_no, effective_from, applies_to_level) NULLS NOT DISTINCT
- checks: `start_time < end_time`; `effective_to IS NULL OR effective_from < effective_to`
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| period_no | int | ✔ | ≥ 0; ≤ 20 |  |
| label_th | string(50) | ✔ |  |  |
| session | enum `DaySession` | ✔ |  |  |
| start_time | hhmm | ✔ |  |  |
| end_time | hhmm | ✔ |  |  |
| effective_from | date | ✔ |  |  |
| effective_to | date |  |  |  |
| applies_to_level | enum `GradeLevel` |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### Settings (`settings`)

Business settings ที่ไม่ลับ (แยกจาก Script Properties / secrets)

- kind: **CONFIG** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `PERMANENT`
- unique: (school_id, key)
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| key | string(100) | ✔ | pattern `^[a-z][a-z0-9_.]*$` |  |
| value_json | json | ✔ |  |  |
| is_example | bool | ✔ | default false | TRUE = ค่าตัวอย่างที่ต้องยืนยันก่อน production |
| description_th | string(500) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### RuleVersions (`rule_versions`)

กฎธุรกิจแบบมีเวอร์ชันและวันที่มีผล (เวลาเริ่มสาย เกณฑ์ติดตาม เส้นทางอนุมัติ ฯลฯ)

- kind: **CONFIG** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `PERMANENT`
- unique: (school_id, rule_type, version_no)
- checks: `effective_to IS NULL OR effective_from < effective_to`
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| rule_type | enum `RuleType` | ✔ |  |  |
| version_no | int | ✔ | ≥ 1 |  |
| effective_from | date | ✔ |  |  |
| effective_to | date |  |  |  |
| params_json | json | ✔ |  |  |
| status | enum `RuleStatus` | ✔ |  |  |
| is_example | bool | ✔ | default true | TRUE = ค่าตัวอย่าง ห้ามใช้ใน production จนกว่าโรงเรียนยืนยัน |
| approved_by | uuid |  | FK → Users.id |  |
| approved_at | timestamp (UTC) |  |  |  |
| notes_th | text |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### SchemaVersions (`schema_versions`)

ประวัติการติดตั้ง/อัปเกรด schema (append-only)

- kind: **EVENT** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `PERMANENT`
- unique: (component, schema_version)
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| component | enum `SchemaComponent` | ✔ |  |  |
| schema_version | int | ✔ | ≥ 1 |  |
| applied_at | timestamp (UTC) | ✔ |  |  |
| applied_by | string(200) | ✔ |  |  |
| description | string(500) |  |  |  |
| checksum | string(64) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### StorageCatalog (`storage_catalog`)

แผนที่ logical table + partition → workbook/sheet (Sheets adapter); ปลายทางอื่นเก็บเป็น metadata

- kind: **CONFIG** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `PERMANENT`
- unique: (logical_table, partition_key)
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| logical_table | string(60) | ✔ |  |  |
| partition_key | string(30) | ✔ |  | "*" = ไม่แบ่ง partition, หรือรหัสภาคเรียน เช่น AY2026-T1 |
| workbook_id | string(100) |  |  | Spreadsheet ID (ไม่ใช่ secret แต่ไม่ฝังในโค้ด) |
| sheet_name | string(100) | ✔ |  |  |
| schema_version | int | ✔ | ≥ 1 |  |
| status | enum `StorageStatus` | ✔ |  |  |
| row_count | int |  | ≥ 0 |  |
| cell_count | int |  | ≥ 0 |  |
| measured_at | timestamp (UTC) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

### กลุ่ม Identity

#### Users (`users`)

บัญชีผู้ใช้ของแอป (UUID อิสระจากผู้ให้บริการยืนยันตัวตน); สร้างบัญชีแล้วยังไม่มีสิทธิ์จนผ่านคำเชิญและบทบาท

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ACCOUNT_LIFETIME_PLUS_1Y`
- unique: (school_id, staff_code)
- lookup/index (access pattern): student_id, guardian_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| user_type | enum `UserType` | ✔ |  |  |
| display_name | string(200) | ✔ |  |  |
| contact_email | string(254) |  |  | อีเมลติดต่อ (ไม่ใช่หลักฐานยืนยันตัวตน) |
| staff_code | string(30) |  |  |  |
| student_id | uuid |  | FK → Students.id | สำหรับบัญชีนักเรียน (กำหนดโดยเจ้าหน้าที่เท่านั้น) |
| guardian_id | uuid |  | FK → Guardians.id | สำหรับบัญชีผู้ปกครอง (กำหนดโดยเจ้าหน้าที่เท่านั้น) |
| status | enum `UserStatus` | ✔ |  |  |
| disabled_at | timestamp (UTC) |  |  |  |
| disabled_by | uuid |  | FK → Users.id |  |
| disabled_reason | string(500) |  |  |  |
| last_login_at | timestamp (UTC) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### IdentityLinks (`identity_links`)

การผูก (provider, issuer, subject) กับ Users.id — ไม่เก็บรหัสผ่านหรือ token

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ACCOUNT_LIFETIME_PLUS_1Y`
- unique: (provider, issuer, subject) WHERE status = 'ACTIVE'
- lookup/index (access pattern): subject, user_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| user_id | uuid | ✔ | FK → Users.id |  |
| provider | enum `IdentityProvider` | ✔ |  |  |
| issuer | string(300) | ✔ |  |  |
| subject | string(200) | ✔ |  |  |
| email_at_link | string(254) |  |  | อีเมลที่ provider ยืนยันขณะผูก (ข้อมูลประกอบ) |
| linked_at | timestamp (UTC) | ✔ |  |  |
| linked_via | enum `LinkedVia` | ✔ |  |  |
| invitation_id | uuid |  | FK → InvitationRecords.id |  |
| status | enum `LinkStatus` | ✔ |  |  |
| revoked_at | timestamp (UTC) |  |  |  |
| revoked_by | uuid |  | FK → Users.id |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### UserRoles (`user_roles`)

บทบาทพร้อมช่วงวันที่มีผล [effective_from, effective_to) — คนเดียวมีหลายบทบาทได้

- kind: **ENTITY** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `ACCOUNT_LIFETIME_PLUS_1Y`
- unique: —
- checks: `effective_to IS NULL OR effective_from < effective_to`
- lookup/index (access pattern): user_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| user_id | uuid | ✔ | FK → Users.id |  |
| role | enum `Role` | ✔ |  |  |
| effective_from | date | ✔ |  |  |
| effective_to | date |  |  |  |
| granted_by | uuid | ✔ | FK → Users.id |  |
| revoked_at | timestamp (UTC) |  |  |  |
| revoked_by | uuid |  | FK → Users.id |  |
| reason | string(500) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### StaffAssignments (`staff_assignments`)

ขอบเขตงานของบุคลากร: ครูที่ปรึกษา เวรประจำจุด สอน ผู้รักษาการแทน พร้อมช่วงเวลาที่มีผล

- kind: **ENTITY** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `ACADEMIC_YEAR_PLUS_2Y`
- unique: —
- checks: `effective_to IS NULL OR effective_from < effective_to`
- lookup/index (access pattern): user_id, class_id, delegate_for_user_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| user_id | uuid | ✔ | FK → Users.id |  |
| assignment_type | enum `AssignmentType` | ✔ |  |  |
| class_id | uuid |  | FK → Classes.id |  |
| station_id | uuid |  | FK → Stations.id |  |
| weekday | int |  | ≥ 1; ≤ 7 | วันในสัปดาห์สำหรับเวร (1=จันทร์); ว่าง = ทุกวัน |
| subject_code | string(30) |  |  |  |
| delegate_for_user_id | uuid |  | FK → Users.id | สำหรับ DELEGATE: รักษาการแทนผู้ใด |
| effective_from | date | ✔ |  |  |
| effective_to | date |  |  |  |
| notes | string(500) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### InvitationRecords (`invitation_records`)

คำเชิญเปิดใช้งาน ใช้ได้ครั้งเดียว มีอายุ เก็บเฉพาะ hash ของรหัส (ไม่ export)

- kind: **ENTITY** · partition: **NONE** · sensitivity: **SECRET** · retention: `1Y`
- unique: —
- lookup/index (access pattern): target_user_id, code_hash

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| invitation_type | enum `InvitationType` | ✔ |  |  |
| target_user_id | uuid | ✔ | FK → Users.id |  |
| code_hash | string(64) | ✔ | SECRET (ไม่ export) | SHA-256 ของรหัสคำเชิญ (รหัสจริงแสดงครั้งเดียว) |
| bound_email | string(254) |  |  | ถ้ากำหนด ต้องตรงกับอีเมลที่ provider ยืนยันแล้ว |
| expires_at | timestamp (UTC) | ✔ |  |  |
| max_attempts | int | ✔ | ≥ 1; ≤ 20 |  |
| attempt_count | int | ✔ | ≥ 0 |  |
| status | enum `InvitationStatus` | ✔ |  |  |
| redeemed_at | timestamp (UTC) |  |  |  |
| redeemed_identity_link_id | uuid |  | FK → IdentityLinks.id (deferrable) | วงอ้างอิงกับ IdentityLinks.invitation_id → FK แบบ DEFERRABLE |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

### กลุ่ม Attendance

#### Stations (`stations`)

จุดลงเวลา/สถานี

- kind: **CONFIG** · partition: **NONE** · sensitivity: **PUBLIC** · retention: `PERMANENT`
- unique: (school_id, code)
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| code | string(30) | ✔ |  |  |
| name_th | string(200) | ✔ |  |  |
| station_type | enum `StationType` | ✔ |  |  |
| status | enum `RecordStatus` | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### AttendanceEvents (`attendance_events`)

เหตุการณ์ข้อเท็จจริงการมาเรียน (append-only) การแก้ไขใช้ supersedes_event_id; การเช็กชื่อเก็บเฉพาะรายการที่ไม่ใช่ "มา" ตามรายชื่อ

- kind: **EVENT** · partition: **TERM** (school_date) · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: (dedupe_key)
- lookup/index (access pattern): student_id, school_date, dedupe_key, student_id+school_date, school_date+event_type

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| student_id | uuid | ✔ | FK → Students.id |  |
| school_date | date | ✔ |  |  |
| event_type | enum `AttendanceEventType` | ✔ |  |  |
| occurred_at | timestamp (UTC) | ✔ |  | เวลาที่เกิดจริง เช่น เวลามาถึง |
| recorded_at | timestamp (UTC) | ✔ |  | เวลาที่ server บันทึก |
| captured_at | timestamp (UTC) |  |  | เวลาเครื่องขณะบันทึกออฟไลน์ (อ้างโดยอุปกรณ์) |
| synced_at | timestamp (UTC) |  |  |  |
| source | enum `AttendanceSource` | ✔ |  |  |
| offline | bool | ✔ | default false |  |
| station_id | uuid |  | FK → Stations.id |  |
| actor_id | uuid | ✔ | FK → Users.id | ผู้บันทึกที่ server ยืนยันตัวตน |
| claimed_actor_id | uuid |  |  | ผู้บันทึกที่อุปกรณ์อ้าง (offline) ไม่ใช่หลักฐานสิทธิ์ |
| reason_code | string(40) |  |  |  |
| reason_text | string(500) |  |  |  |
| linked_leave_id | uuid |  | FK → LeaveRequests.id |  |
| supersedes_event_id | uuid |  | FK → AttendanceEvents.id |  |
| roll_call_session_id | uuid |  | FK → RollCallSessions.id |  |
| class_id | uuid |  | FK → Classes.id |  |
| dedupe_key | string(200) |  |  | กันบันทึกซ้ำ เช่น ARR\|student\|date |
| operation_id | uuid | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### DailyAttendance (`daily_attendance`)

สรุปรายวันต่อคน (projection สร้างใหม่ได้จาก AttendanceEvents, RollCallSessions, LeaveSegments, Enrollments, ปฏิทินและกฎ) id = UUIDv5(student_id|school_date)

- kind: **PROJECTION** · partition: **TERM** (school_date) · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: (student_id, school_date)
- lookup/index (access pattern): school_date, student_id, school_date+class_id, school_date+presence_status

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | UUIDv5 จาก student_id\|school_date |
| student_id | uuid | ✔ | FK → Students.id |  |
| school_date | date | ✔ |  |  |
| class_id | uuid |  | FK → Classes.id |  |
| school_day | bool | ✔ |  |  |
| eligible | bool | ✔ |  |  |
| presence_status | enum `PresenceStatus` | ✔ |  |  |
| verification_level | enum `VerificationLevel` | ✔ |  |  |
| is_late | bool | ✔ |  |  |
| late_minutes | int |  | ≥ 0 |  |
| late_counted | bool | ✔ |  |  |
| lateness_exempted | bool | ✔ |  |  |
| arrival_event_id | uuid |  | FK → AttendanceEvents.id |  |
| arrived_at | timestamp (UTC) |  |  |  |
| roll_call_mark | enum `RollCallMark` | ✔ |  |  |
| roll_call_session_id | uuid |  | FK → RollCallSessions.id |  |
| full_day_leave | bool | ✔ |  |  |
| partial_leave | bool | ✔ |  |  |
| leave_units | string(100) |  |  | เช่น AM, PM, P1,P2 |
| leave_request_ids | json |  |  |  |
| confirmed_absence | bool | ✔ |  |  |
| has_conflict | bool | ✔ |  |  |
| conflicts | json |  |  |  |
| evidence_refs | json |  |  |  |
| calculated_rule_version_id | uuid |  | FK → RuleVersions.id |  |
| projection_version | int | ✔ | ≥ 1 |  |
| computed_at | timestamp (UTC) | ✔ |  |  |
| verified_by | uuid |  | FK → Users.id |  |
| verified_at | timestamp (UTC) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### RollCallSessions (`roll_call_sessions`)

การเช็กชื่อประจำวันรายห้อง (ผู้ยืนยันและแหล่งข้อมูล) id = UUIDv5(class_id|school_date); นักเรียนในรายชื่อที่ไม่มีเหตุการณ์ยกเว้น = มาตามการเช็กชื่อ

- kind: **ENTITY** · partition: **TERM** (school_date) · sensitivity: **INTERNAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: (class_id, school_date)
- lookup/index (access pattern): school_date

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | UUIDv5 จาก class_id\|school_date |
| class_id | uuid | ✔ | FK → Classes.id |  |
| school_date | date | ✔ |  |  |
| status | enum `RollCallStatus` | ✔ |  |  |
| roster_count | int | ✔ | ≥ 0 |  |
| roster_hash | string(64) | ✔ |  | SHA-256 ของรายชื่อ student_id ที่เช็ก (ตรวจว่ารายชื่อไม่เปลี่ยน) |
| absent_count | int |  | ≥ 0 |  |
| late_count | int |  | ≥ 0 |  |
| leave_reported_count | int |  | ≥ 0 |  |
| submitted_by | uuid |  | FK → Users.id |  |
| submitted_at | timestamp (UTC) |  |  |  |
| verified_by | uuid |  | FK → Users.id |  |
| verified_at | timestamp (UTC) |  |  |  |
| source | string(20) | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### AttendanceCorrections (`attendance_corrections`)

คำขอ/การแก้ไขข้อมูลการมาเรียนย้อนหลัง พร้อมเหตุผล ค่าเดิม/ใหม่ และผู้อนุมัติ

- kind: **ENTITY** · partition: **TERM** (school_date) · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- lookup/index (access pattern): student_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| student_id | uuid | ✔ | FK → Students.id |  |
| school_date | date | ✔ |  |  |
| target_event_id | uuid |  | FK → AttendanceEvents.id |  |
| correction_type | enum `CorrectionType` | ✔ |  |  |
| requested_by | uuid | ✔ | FK → Users.id |  |
| requested_at | timestamp (UTC) | ✔ |  |  |
| reason | string(1000) | ✔ |  |  |
| requested_change | json | ✔ |  |  |
| status | enum `CorrectionStatus` | ✔ |  |  |
| decided_by | uuid |  | FK → Users.id |  |
| decided_at | timestamp (UTC) |  |  |  |
| decision_note | string(1000) |  |  |  |
| resulting_event_id | uuid |  | FK → AttendanceEvents.id |  |
| before_json | json |  |  |  |
| after_json | json |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### ReconciliationTasks (`reconciliation_tasks`)

งานตรวจสอบเมื่อข้อมูลขัดกันหรือยังไม่ทราบสถานะ (ระบบไม่ตัดสินเอง)

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `TERM_PLUS_1Y`
- unique: (dedupe_key)
- lookup/index (access pattern): dedupe_key, assigned_to, class_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| task_type | enum `ReconciliationTaskType` | ✔ |  |  |
| student_id | uuid |  | FK → Students.id |  |
| class_id | uuid |  | FK → Classes.id |  |
| school_date | date |  |  |  |
| evidence_refs | json | ✔ |  |  |
| description_th | string(1000) | ✔ |  |  |
| assigned_to | uuid |  | FK → Users.id |  |
| assigned_role | enum `Role` |  |  |  |
| due_at | timestamp (UTC) |  |  |  |
| status | enum `TaskStatus` | ✔ |  |  |
| resolution_note | string(1000) |  |  |  |
| resolved_by | uuid |  | FK → Users.id |  |
| resolved_at | timestamp (UTC) |  |  |  |
| dedupe_key | string(200) | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

### กลุ่ม Student

#### Students (`students`)

นักเรียน; student_code เป็น business key แบบ string (รักษาเลขศูนย์นำหน้า)

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: (school_id, student_code)
- lookup/index (access pattern): student_code, search_name, status — getById; findByCode (สแกนประตู); search_name prefix (ค้นหาชื่อ); list ตามห้องผ่าน Enrollments

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| student_code | string(20) | ✔ | pattern `^[0-9A-Za-z-]{1,20}$` |  |
| prefix_th | string(30) |  |  |  |
| first_name_th | string(100) | ✔ |  |  |
| last_name_th | string(100) | ✔ |  |  |
| first_name_en | string(100) |  |  |  |
| last_name_en | string(100) |  |  |  |
| nickname | string(50) |  |  |  |
| gender | enum `Gender` |  |  |  |
| birth_date | date |  | sensitivity SENSITIVE | ไม่บังคับ |
| photo_file_id | uuid |  |  | Attachments.id รูปถ่าย (soft reference) |
| status | enum `StudentStatus` | ✔ |  |  |
| status_effective_date | date |  |  |  |
| search_name | string(300) |  | derived (สร้างใหม่ได้) | ค่าค้นหาที่ normalize (ตัดช่องว่าง/ตัวพิมพ์เล็ก) สร้างใหม่ได้จากชื่อจริง ไม่ใช้แทนชื่อ |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### Classes (`classes`)

ห้องเรียนรายปีการศึกษา

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PUBLIC** · retention: `PERMANENT`
- unique: (academic_year_id, code)
- lookup/index (access pattern): academic_year_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| academic_year_id | uuid | ✔ | FK → AcademicYears.id |  |
| grade_level | enum `GradeLevel` | ✔ |  |  |
| room_no | string(10) | ✔ |  |  |
| code | string(20) | ✔ |  | เช่น M1/1 |
| name_th | string(50) | ✔ |  |  |
| status | enum `RecordStatus` | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### Enrollments (`enrollments`)

ประวัติการอยู่ห้อง [effective_from, effective_to) ห้ามช่วงซ้อนกันต่อนักเรียน; ย้ายห้อง/เลื่อนชั้น/ย้ายออกปิดช่วงเดิมแล้วเปิดช่วงใหม่

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- checks: `effective_to IS NULL OR effective_from < effective_to`
- exclusion: ห้ามช่วง [effective_from, effective_to) ซ้อนกันต่อ student_id
- lookup/index (access pattern): student_id, class_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| student_id | uuid | ✔ | FK → Students.id |  |
| class_id | uuid | ✔ | FK → Classes.id |  |
| academic_year_id | uuid | ✔ | FK → AcademicYears.id |  |
| effective_from | date | ✔ |  |  |
| effective_to | date |  |  |  |
| end_reason | enum `EnrollmentEndReason` |  |  |  |
| roll_no | int |  | ≥ 1; ≤ 200 |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### Guardians (`guardians`)

ผู้ปกครอง (หนึ่งคนดูแลนักเรียนได้หลายคน)

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: (school_id, external_ref)
- lookup/index (access pattern): external_ref, search_name

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| school_id | uuid | ✔ | FK → Schools.id |  |
| external_ref | string(40) |  | pattern `^[0-9A-Za-z_-]{1,40}$` | รหัสผู้ปกครองที่โรงเรียนรับรอง (ใช้รวมข้อมูลพี่น้อง) — ห้ามรวมด้วยชื่อเหมือนกัน |
| prefix_th | string(30) |  |  |  |
| first_name_th | string(100) | ✔ |  |  |
| last_name_th | string(100) | ✔ |  |  |
| search_name | string(300) |  | derived (สร้างใหม่ได้) |  |
| status | enum `RecordStatus` | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### StudentGuardians (`student_guardians`)

ความสัมพันธ์นักเรียน-ผู้ปกครองที่เจ้าหน้าที่ยืนยัน พร้อมสิทธิ์และช่วงเวลาที่มีผล

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: (student_id, guardian_id, effective_from)
- checks: `effective_to IS NULL OR effective_from < effective_to`; `status <> 'ACTIVE' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)`
- lookup/index (access pattern): student_id, guardian_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| student_id | uuid | ✔ | FK → Students.id |  |
| guardian_id | uuid | ✔ | FK → Guardians.id |  |
| relationship | enum `Relationship` | ✔ |  |  |
| relationship_note | string(200) |  |  |  |
| is_primary_contact | bool | ✔ | default false |  |
| contact_priority | int | ✔ | ≥ 1; ≤ 9 |  |
| permitted_actions | json | ✔ |  | รายการสิทธิ์ เช่น ["VIEW_ATTENDANCE","SUBMIT_LEAVE"] |
| notification_preferences | json | ✔ |  | เช่น {"LATE_CONFIRMED":true,"ABSENCE_CONFIRMED":true} |
| status | enum `GuardianLinkStatus` | ✔ |  |  |
| verified_by | uuid |  | FK → Users.id |  |
| verified_at | timestamp (UTC) |  |  |  |
| verification_method | enum `VerificationMethod` |  |  |  |
| effective_from | date | ✔ |  |  |
| effective_to | date |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### ContactEndpoints (`contact_endpoints`)

ช่องทางติดต่อ (เบอร์โทรเก็บเป็น string) การแก้ไขต้องยืนยันโดยเจ้าหน้าที่และมี audit

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- lookup/index (access pattern): owner_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| owner_type | enum `ContactOwnerType` | ✔ |  |  |
| owner_id | uuid | ✔ |  | Guardians.id / Users.id / Students.id ตาม owner_type (polymorphic) |
| channel | enum `ContactChannel` | ✔ |  |  |
| value | string(254) | ✔ |  |  |
| label_th | string(100) |  |  |  |
| is_primary | bool | ✔ | default false |  |
| verified_at | timestamp (UTC) |  |  |  |
| verified_by | uuid |  | FK → Users.id |  |
| status | enum `RecordStatus` | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

### กลุ่ม Leave

#### LeaveRequests (`leave_requests`)

ใบลา: สถานะรวม + สถานะผู้ปกครองยืนยัน + สถานะโรงเรียนอนุมัติ แยกกัน; ช่วงวันที่ [start_date, end_date)

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- checks: `start_date < end_date`
- lookup/index (access pattern): student_id, current_approver_user_id, status, student_id+start_date

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| student_id | uuid | ✔ | FK → Students.id |  |
| requester_user_id | uuid | ✔ | FK → Users.id |  |
| requester_type | enum `RequesterType` | ✔ |  |  |
| leave_type | enum `LeaveType` | ✔ |  |  |
| start_date | date | ✔ |  |  |
| end_date | date | ✔ |  | exclusive |
| reason | string(1000) | ✔ |  |  |
| status | enum `LeaveStatus` | ✔ |  |  |
| guardian_confirmation_status | enum `GuardianConfirmation` | ✔ |  |  |
| school_approval_status | enum `SchoolApproval` | ✔ |  |  |
| route_rule_version_id | uuid |  | FK → RuleVersions.id |  |
| current_approver_role | enum `Role` |  |  |  |
| current_approver_user_id | uuid |  | FK → Users.id |  |
| is_retroactive | bool | ✔ |  |  |
| retroactive_reason | string(1000) |  |  |  |
| school_days_count | int | ✔ | ≥ 0 | จำนวนวันเรียนที่เกี่ยวข้อง (นับวัน) |
| full_day_count | int | ✔ | ≥ 0 |  |
| half_day_count | int | ✔ | ≥ 0 |  |
| period_count | int | ✔ | ≥ 0 | หน่วยคาบ แยกจากหน่วยวัน |
| revision_no | int | ✔ | ≥ 1 |  |
| submitted_at | timestamp (UTC) |  |  |  |
| decided_at | timestamp (UTC) |  |  |  |
| cancelled_at | timestamp (UTC) |  |  |  |
| attachment_required | bool | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### LeaveSegments (`leave_segments`)

ช่วงลารายวันเรียน (อนุมัติแยกช่วงได้) หน่วยวัน/ครึ่งวัน/คาบไม่บวกปนกัน

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- lookup/index (access pattern): leave_request_id, student_id, school_date, student_id+school_date

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| leave_request_id | uuid | ✔ | FK → LeaveRequests.id |  |
| student_id | uuid | ✔ | FK → Students.id |  |
| school_date | date | ✔ |  |  |
| unit | enum `LeaveUnit` | ✔ |  |  |
| periods | json |  |  | รายการคาบเมื่อ unit = PERIODS เช่น [1,2] |
| status | enum `SegmentStatus` | ✔ |  |  |
| decision_id | uuid |  | FK → LeaveApprovals.id |  |
| usage_status | enum `SegmentUsage` | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### LeaveRevisions (`leave_revisions`)

ประวัติทุกการเปลี่ยนแปลงใบลา (append-only ห้ามเขียนทับเหตุผล/ผู้อนุมัติเดิม)

- kind: **EVENT** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- lookup/index (access pattern): leave_request_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| leave_request_id | uuid | ✔ | FK → LeaveRequests.id |  |
| revision_no | int | ✔ | ≥ 1 |  |
| action | enum `LeaveAction` | ✔ |  |  |
| actor_id | uuid | ✔ | FK → Users.id |  |
| acted_at | timestamp (UTC) | ✔ |  |  |
| from_status | enum `LeaveStatus` |  |  |  |
| to_status | enum `LeaveStatus` | ✔ |  |  |
| snapshot_json | json | ✔ |  |  |
| comment | string(1000) |  |  |  |
| operation_id | uuid | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### LeaveApprovals (`leave_approvals`)

การตัดสินแต่ละขั้น (ผู้ปกครองยืนยัน / โรงเรียนอนุมัติ / พิจารณายกเลิก) append-only

- kind: **EVENT** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- lookup/index (access pattern): leave_request_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| leave_request_id | uuid | ✔ | FK → LeaveRequests.id |  |
| step_no | int | ✔ | ≥ 1 |  |
| step_type | enum `ApprovalStepType` | ✔ |  |  |
| decision | enum `ApprovalDecision` | ✔ |  |  |
| decided_by | uuid | ✔ | FK → Users.id |  |
| decided_at | timestamp (UTC) | ✔ |  |  |
| acting_for_user_id | uuid |  | FK → Users.id | กรณีผู้รักษาการแทน |
| approver_role | enum `Role` |  |  |  |
| comment | string(1000) |  |  |  |
| segment_decisions_json | json |  |  |  |
| revision_no | int | ✔ | ≥ 1 |  |
| operation_id | uuid | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

### กลุ่ม Follow-up

#### Cases (`cases`)

เรื่องติดตาม/ดูแลช่วยเหลือ มีผู้รับผิดชอบ กำหนดเวลา และการ dedupe

- kind: **ENTITY** · partition: **NONE** · sensitivity: **SENSITIVE** · retention: `ENROLLMENT_PLUS_5Y`
- unique: (dedupe_key) WHERE status NOT IN ('CLOSED')
- lookup/index (access pattern): student_id, owner_user_id, dedupe_key, status+due_at

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| student_id | uuid | ✔ | FK → Students.id |  |
| case_type | enum `CaseType` | ✔ |  |  |
| rule_version_id | uuid |  | FK → RuleVersions.id |  |
| trigger_summary_th | string(1000) | ✔ |  |  |
| trigger_evidence_json | json | ✔ |  |  |
| dedupe_key | string(200) |  |  |  |
| status | enum `CaseStatus` | ✔ |  |  |
| priority | enum `Priority` | ✔ |  |  |
| owner_user_id | uuid |  | FK → Users.id |  |
| due_at | timestamp (UTC) |  |  |  |
| next_action_th | string(500) |  |  |  |
| next_appointment_at | timestamp (UTC) |  |  |  |
| resolution_summary | string(2000) |  |  |  |
| closed_at | timestamp (UTC) |  |  |  |
| closed_by | uuid |  | FK → Users.id |  |
| reopened_count | int | ✔ | ≥ 0 |  |
| cooldown_until | timestamp (UTC) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### CaseEvents (`case_events`)

ประวัติเรื่องติดตาม (append-only)

- kind: **EVENT** · partition: **NONE** · sensitivity: **SENSITIVE** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- lookup/index (access pattern): case_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| case_id | uuid | ✔ | FK → Cases.id |  |
| event_type | enum `CaseEventType` | ✔ |  |  |
| actor_id | uuid | ✔ | FK → Users.id |  |
| occurred_at | timestamp (UTC) | ✔ |  |  |
| data_json | json |  |  |  |
| note | string(2000) |  |  |  |
| operation_id | uuid | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### ContactLogs (`contact_logs`)

บันทึกการติดต่อ (การกดปุ่มโทรไม่ถือว่าโทรสำเร็จจนบันทึกผล)

- kind: **EVENT** · partition: **NONE** · sensitivity: **SENSITIVE** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- lookup/index (access pattern): student_id, case_id, supersedes_id, direction

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| student_id | uuid | ✔ | FK → Students.id |  |
| case_id | uuid |  | FK → Cases.id |  |
| guardian_id | uuid |  | FK → Guardians.id |  |
| channel | enum `ContactChannel` | ✔ |  |  |
| direction | enum `ContactDirection` | ✔ |  |  |
| contacted_at | timestamp (UTC) | ✔ |  |  |
| contacted_by | uuid | ✔ | FK → Users.id |  |
| outcome | enum `ContactOutcome` | ✔ |  |  |
| summary | string(2000) |  |  |  |
| follow_up_required | bool | ✔ |  |  |
| next_follow_up_at | timestamp (UTC) |  |  |  |
| supersedes_id | uuid |  | FK → ContactLogs.id | รายการก่อนหน้าที่บันทึกนี้แก้ไขแทน หรือรายการติดต่อเข้า (INBOUND) ที่บันทึกนี้ตอบกลับ/ปิดแล้ว |
| operation_id | uuid | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### Appointments (`appointments`)

นัดหมาย

- kind: **ENTITY** · partition: **NONE** · sensitivity: **SENSITIVE** · retention: `ENROLLMENT_PLUS_5Y`
- unique: —
- lookup/index (access pattern): case_id, student_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| case_id | uuid |  | FK → Cases.id |  |
| student_id | uuid | ✔ | FK → Students.id |  |
| scheduled_at | timestamp (UTC) | ✔ |  |  |
| duration_minutes | int |  | ≥ 5; ≤ 600 |  |
| location | string(200) |  |  |  |
| attendees_note | string(500) |  |  |  |
| status | enum `AppointmentStatus` | ✔ |  |  |
| outcome_note | string(2000) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

### กลุ่ม Files

#### Attachments (`attachments`)

ไฟล์แนบเชิงตรรกะ (logical_file_id = id) ไม่ผูกกับ Drive URL; provider object อยู่ใน StorageObjectMappings

- kind: **ENTITY** · partition: **NONE** · sensitivity: **SENSITIVE** · retention: `BY_CLASSIFICATION`
- unique: —
- lookup/index (access pattern): status+uploaded_at

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | logical file ID |
| school_id | uuid | ✔ | FK → Schools.id |  |
| original_filename | string(255) | ✔ |  |  |
| mime_type | string(100) | ✔ |  |  |
| size_bytes | int | ✔ | ≥ 0 |  |
| sha256 | string(64) | ✔ | pattern `^[0-9a-f]{64}$` |  |
| classification | enum `FileClassification` | ✔ |  |  |
| status | enum `FileStatus` | ✔ |  |  |
| uploaded_by | uuid | ✔ | FK → Users.id |  |
| uploaded_at | timestamp (UTC) | ✔ |  |  |
| linked_at | timestamp (UTC) |  |  |  |
| deleted_at | timestamp (UTC) |  |  |  |
| deleted_by | uuid |  | FK → Users.id |  |
| retention_until | date |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### AttachmentLinks (`attachment_links`)

ความสัมพันธ์ไฟล์ ↔ entity

- kind: **ENTITY** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `BY_CLASSIFICATION`
- unique: —
- lookup/index (access pattern): attachment_id, entity_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| attachment_id | uuid | ✔ | FK → Attachments.id |  |
| entity_type | enum `EntityType` | ✔ |  |  |
| entity_id | uuid | ✔ |  | polymorphic reference ตาม entity_type |
| purpose | string(50) | ✔ |  |  |
| linked_by | uuid | ✔ | FK → Users.id |  |
| linked_at | timestamp (UTC) | ✔ |  |  |
| unlinked_at | timestamp (UTC) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### StorageObjectMappings (`storage_object_mappings`)

logical file ID → provider object (Drive file ID / path) เปลี่ยนเมื่อย้ายที่เก็บ

- kind: **ENTITY** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `BY_CLASSIFICATION`
- unique: (provider, object_key)
- lookup/index (access pattern): attachment_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| attachment_id | uuid | ✔ | FK → Attachments.id |  |
| provider | enum `StorageProvider` | ✔ |  |  |
| object_key | string(500) | ✔ |  |  |
| container | string(300) |  |  |  |
| status | enum `StorageStatus` | ✔ |  |  |
| sha256_verified_at | timestamp (UTC) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

### กลุ่ม Notifications

#### Notifications (`notifications`)

การแจ้งเตือนที่สร้างจากเหตุการณ์ที่ commit แล้ว (เนื้อหาขั้นต่ำ + template version)

- kind: **EVENT** · partition: **TERM** (created_at) · sensitivity: **PERSONAL** · retention: `TERM_PLUS_1Y`
- unique: —
- lookup/index (access pattern): source_entity_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| notification_type | enum `NotificationType` | ✔ |  |  |
| source_entity_type | string(40) | ✔ |  |  |
| source_entity_id | uuid | ✔ |  |  |
| source_operation_id | uuid | ✔ |  |  |
| student_id | uuid |  | FK → Students.id |  |
| template_key | string(60) | ✔ |  |  |
| template_version | int | ✔ | ≥ 1 |  |
| params_json | json | ✔ |  |  |
| urgency | enum `Urgency` | ✔ |  |  |
| audience_scope | string(40) | ✔ |  |  |
| suppressed | bool | ✔ |  |  |
| suppress_reason | string(200) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### NotificationRecipients (`notification_recipients`)

ผู้รับ (resolve จากความสัมพันธ์ที่ยืนยันแล้ว) = กล่องแจ้งเตือนในแอป และสถานะการรับทราบ

- kind: **ENTITY** · partition: **TERM** (created_at) · sensitivity: **PERSONAL** · retention: `TERM_PLUS_1Y`
- unique: (notification_id, recipient_user_id)
- lookup/index (access pattern): recipient_user_id, notification_id, ack_state

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| notification_id | uuid | ✔ | FK → Notifications.id |  |
| recipient_user_id | uuid | ✔ | FK → Users.id |  |
| recipient_role_context | enum `Role` | ✔ |  |  |
| in_app_state | enum `InAppState` | ✔ |  |  |
| read_at | timestamp (UTC) |  |  |  |
| ack_required | bool | ✔ |  |  |
| ack_state | enum `AckState` | ✔ |  |  |
| ack_due_at | timestamp (UTC) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### NotificationOutbox (`notification_outbox`)

คิวส่งภายนอก (email/LINE/SMS) แยก delivery state ออกจากการรับทราบ; dedupe_key กันส่งซ้ำ

- kind: **ENTITY** · partition: **TERM** (created_at) · sensitivity: **PERSONAL** · retention: `TERM_PLUS_1Y`
- unique: (dedupe_key)
- lookup/index (access pattern): dedupe_key, notification_id, delivery_state, delivery_state+next_attempt_at

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | UUIDv5 จาก dedupe_key |
| notification_id | uuid | ✔ | FK → Notifications.id |  |
| recipient_id | uuid | ✔ | FK → NotificationRecipients.id |  |
| recipient_user_id | uuid | ✔ | FK → Users.id |  |
| channel | enum `Channel` | ✔ |  |  |
| dedupe_key | string(300) | ✔ |  |  |
| delivery_state | enum `DeliveryState` | ✔ |  |  |
| attempts | int | ✔ | ≥ 0 |  |
| max_attempts | int | ✔ | ≥ 1 |  |
| next_attempt_at | timestamp (UTC) |  |  |  |
| lease_until | timestamp (UTC) |  |  |  |
| lease_owner | string(100) |  |  |  |
| retry_key | uuid |  |  | X-Line-Retry-Key ใช้ค่าเดิมตลอดการ retry ของการส่งเดียวกัน |
| retry_key_created_at | timestamp (UTC) |  |  |  |
| provider_request_id | string(200) |  |  |  |
| provider_message_id | string(200) |  |  |  |
| last_error_code | string(60) |  |  |  |
| last_error_message | string(500) |  |  |  |
| accepted_at | timestamp (UTC) |  |  |  |
| resend_of_outbox_id | uuid |  | FK → NotificationOutbox.id |  |
| held_reason | string(60) |  |  |  |
| replay_blocked | bool | ✔ | default false | TRUE สำหรับรายการจากการย้ายข้อมูล ห้ามส่งย้อนหลังอัตโนมัติ |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### NotificationAttempts (`notification_attempts`)

ผลการเรียกผู้ให้บริการแต่ละครั้ง (append-only)

- kind: **EVENT** · partition: **TERM** (started_at) · sensitivity: **INTERNAL** · retention: `TERM_PLUS_1Y`
- unique: —
- lookup/index (access pattern): outbox_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| outbox_id | uuid | ✔ | FK → NotificationOutbox.id |  |
| attempt_no | int | ✔ | ≥ 1 |  |
| started_at | timestamp (UTC) | ✔ |  |  |
| finished_at | timestamp (UTC) |  |  |  |
| result | enum `AttemptResult` | ✔ |  |  |
| http_status | int |  |  |  |
| provider_request_id | string(200) |  |  |  |
| error_code | string(60) |  |  |  |
| error_message | string(500) |  |  |  |
| retry_key | uuid |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### Acknowledgements (`acknowledgements`)

การกดรับทราบ/ขอให้ติดต่อกลับจริงของผู้รับ (ผูก identity และ notification)

- kind: **EVENT** · partition: **TERM** (acted_at) · sensitivity: **PERSONAL** · retention: `TERM_PLUS_1Y`
- unique: (recipient_id, action)
- lookup/index (access pattern): recipient_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| recipient_id | uuid | ✔ | FK → NotificationRecipients.id |  |
| notification_id | uuid | ✔ | FK → Notifications.id |  |
| user_id | uuid | ✔ | FK → Users.id |  |
| action | enum `AckAction` | ✔ |  |  |
| channel | enum `AckChannel` | ✔ |  |  |
| acted_at | timestamp (UTC) | ✔ |  |  |
| note | string(1000) |  |  |  |
| case_id | uuid |  | FK → Cases.id |  |
| operation_id | uuid | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### ChannelBindings (`channel_bindings`)

การผูกช่องทาง LINE/อีเมลกับบัญชีแอป (แยกจากการยืนยันความสัมพันธ์ผู้ปกครอง-นักเรียน)

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `ACCOUNT_LIFETIME_PLUS_1Y`
- unique: (channel, address) WHERE status = 'ACTIVE'
- lookup/index (access pattern): user_id, address, link_nonce_hash

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| user_id | uuid | ✔ | FK → Users.id |  |
| channel | enum `Channel` | ✔ |  |  |
| address | string(254) |  |  | LINE userId / อีเมล (ว่างระหว่าง PENDING) |
| status | enum `BindingStatus` | ✔ |  |  |
| link_nonce_hash | string(64) |  | SECRET (ไม่ export) | SHA-256 ของ nonce สำหรับ LINE account link |
| link_expires_at | timestamp (UTC) |  |  |  |
| verified_at | timestamp (UTC) |  |  |  |
| verified_via | enum `BindingVerifiedVia` |  |  |  |
| revoked_at | timestamp (UTC) |  |  |  |
| revoked_by | uuid |  | FK → Users.id |  |
| revoke_reason | string(300) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### WebhookInbox (`webhook_inbox`)

เหตุการณ์ webhook ที่ผ่านการตรวจลายเซ็นจาก gateway แล้ว บันทึกถาวรก่อนตอบรับ (dedupe ด้วย webhook_event_id)

- kind: **ENTITY** · partition: **TERM** (received_at) · sensitivity: **PERSONAL** · retention: `90D`
- unique: (source, webhook_event_id)
- lookup/index (access pattern): webhook_event_id, status, status

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| source | string(20) | ✔ |  |  |
| webhook_event_id | string(100) | ✔ |  |  |
| received_at | timestamp (UTC) | ✔ |  |  |
| envelope_ts | timestamp (UTC) | ✔ |  |  |
| event_type | string(40) | ✔ |  |  |
| payload_json | json | ✔ |  |  |
| status | enum `WebhookStatus` | ✔ |  |  |
| processed_at | timestamp (UTC) |  |  |  |
| attempts | int | ✔ | ≥ 0 |  |
| last_error | string(500) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

### กลุ่ม Operations

#### MutationJournal (`mutation_journal`)

redo journal ของ Sheets adapter: PREPARED → COMMITTED; recovery ทำซ้ำได้อย่างปลอดภัย (ไม่ export ข้อมูลในเซลล์ writes_json เกินจำเป็น)

- kind: **OPERATIONAL** · partition: **TERM** (prepared_at) · sensitivity: **SENSITIVE** · retention: `30D_AFTER_COMMIT`
- unique: (operation_id, part_no)
- lookup/index (access pattern): operation_id, status

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| operation_id | uuid | ✔ |  |  |
| operation | string(80) | ✔ |  |  |
| actor_id | uuid | ✔ | FK → Users.id |  |
| request_id | uuid |  |  |  |
| status | enum `JournalStatus` | ✔ |  |  |
| part_no | int | ✔ | ≥ 1 |  |
| part_count | int | ✔ | ≥ 1 |  |
| writes_json | text | ✔ |  |  |
| prepared_at | timestamp (UTC) | ✔ |  |  |
| committed_at | timestamp (UTC) |  |  |  |
| recovered_at | timestamp (UTC) |  |  |  |
| recovery_attempts | int | ✔ | ≥ 0 |  |
| last_error | string(500) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### IdempotencyRecords (`idempotency_records`)

ผลของคำสั่งตาม (actor, operation, idempotency_key) เพื่อคืนผลเดิมเมื่อส่งซ้ำ

- kind: **OPERATIONAL** · partition: **TERM** (created_at) · sensitivity: **INTERNAL** · retention: `30D`
- unique: (scope_key)
- lookup/index (access pattern): scope_key

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | UUIDv5 จาก scope_key |
| scope_key | string(64) | ✔ |  |  |
| actor_id | uuid | ✔ | FK → Users.id |  |
| operation | string(80) | ✔ |  |  |
| idempotency_key | string(100) | ✔ |  |  |
| request_hash | string(64) | ✔ |  |  |
| result_json | json | ✔ |  |  |
| operation_id | uuid | ✔ |  |  |
| expires_at | timestamp (UTC) | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### AuditEvents (`audit_events`)

Audit (append-only) ใคร ทำอะไร เมื่อใด เหตุผล ค่าเดิม/ใหม่ (ปิดบังฟิลด์อ่อนไหว) — ไม่ tamper-proof เมื่อผู้แก้ไข Sheet ยังแก้ได้

- kind: **EVENT** · partition: **TERM** (occurred_at) · sensitivity: **SENSITIVE** · retention: `AUDIT_5Y`
- unique: —
- lookup/index (access pattern): entity_id, actor_id, student_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| occurred_at | timestamp (UTC) | ✔ |  |  |
| actor_id | uuid | ✔ | FK → Users.id |  |
| actor_roles | string(200) |  |  |  |
| action | string(80) | ✔ |  |  |
| entity_type | string(40) |  |  |  |
| entity_id | uuid |  |  |  |
| student_id | uuid |  | FK → Students.id |  |
| operation_id | uuid |  |  |  |
| request_id | uuid |  |  |  |
| channel | enum `AuditChannel` | ✔ |  |  |
| reason | string(1000) |  |  |  |
| before_json | json |  |  |  |
| after_json | json |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### Jobs (`jobs`)

งานเบื้องหลังถาวร: lease, cursor/checkpoint, retry (ไม่ใช้ CacheService)

- kind: **OPERATIONAL** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `90D`
- unique: (dedupe_key) WHERE status IN ('QUEUED','RUNNING','PAUSED')
- lookup/index (access pattern): dedupe_key, owner_user_id, status+next_run_at

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| job_type | string(60) | ✔ |  |  |
| status | enum `JobStatus` | ✔ |  |  |
| priority | int | ✔ | ≥ 0; ≤ 9 |  |
| payload_json | json | ✔ |  |  |
| progress_json | json |  |  |  |
| cursor_json | json |  |  |  |
| attempts | int | ✔ | ≥ 0 |  |
| max_attempts | int | ✔ | ≥ 1 |  |
| next_run_at | timestamp (UTC) | ✔ |  |  |
| lease_until | timestamp (UTC) |  |  |  |
| lease_owner | string(100) |  |  |  |
| heartbeat_at | timestamp (UTC) |  |  |  |
| last_error | string(1000) |  |  |  |
| owner_user_id | uuid | ✔ | FK → Users.id |  |
| started_at | timestamp (UTC) |  |  |  |
| finished_at | timestamp (UTC) |  |  |  |
| result_json | json |  |  |  |
| dedupe_key | string(200) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### ImportBatches (`import_batches`)

ชุดนำเข้า CSV/XLSX พร้อม mapping, dry-run และผลลัพธ์

- kind: **ENTITY** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `1Y`
- unique: —
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| import_type | enum `ImportType` | ✔ |  |  |
| source_attachment_id | uuid |  | FK → Attachments.id |  |
| source_format | enum `SourceFormat` | ✔ |  |  |
| mapping_json | json |  |  |  |
| status | enum `ImportStatus` | ✔ |  |  |
| dry_run_summary_json | json |  |  |  |
| row_count | int |  | ≥ 0 |  |
| valid_count | int |  | ≥ 0 |  |
| error_count | int |  | ≥ 0 |  |
| applied_count | int |  | ≥ 0 |  |
| job_id | uuid |  | FK → Jobs.id |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### ImportErrors (`import_errors`)

ข้อผิดพลาดรายแถวของการนำเข้า

- kind: **EVENT** · partition: **NONE** · sensitivity: **PERSONAL** · retention: `1Y`
- unique: —
- lookup/index (access pattern): import_batch_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| import_batch_id | uuid | ✔ | FK → ImportBatches.id |  |
| attempt_no | int | ✔ | ≥ 1 | ครั้งที่ตรวจ (dry-run) ของชุดนำเข้า |
| row_no | int | ✔ | ≥ 1 |  |
| column_name | string(100) |  |  |  |
| error_code | string(60) | ✔ |  |  |
| message_th | string(500) | ✔ |  |  |
| raw_value_redacted | string(200) |  |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### MigrationRuns (`migration_runs`)

งานส่งออก/นำเข้า/กระทบยอด/สลับระบบ พร้อม state machine

- kind: **ENTITY** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `PERMANENT`
- unique: —
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| run_type | enum `MigrationRunType` | ✔ |  |  |
| mode | enum `MigrationMode` | ✔ |  |  |
| state | enum `MigrationState` | ✔ |  |  |
| snapshot_id | uuid |  |  |  |
| package_location | string(300) |  |  |  |
| manifest_sha256 | string(64) |  |  |  |
| completeness | enum `Completeness` |  |  |  |
| scope_json | json |  |  |  |
| high_water_marks_json | json |  |  |  |
| started_by | uuid | ✔ | FK → Users.id |  |
| started_at | timestamp (UTC) | ✔ |  |  |
| finished_at | timestamp (UTC) |  |  |  |
| summary_json | json |  |  |  |
| job_id | uuid |  | FK → Jobs.id |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### MigrationCheckpoints (`migration_checkpoints`)

checkpoint ราย table/partition/chunk สำหรับ resume

- kind: **ENTITY** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `PERMANENT`
- unique: —
- lookup/index (access pattern): migration_run_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| migration_run_id | uuid | ✔ | FK → MigrationRuns.id |  |
| step | string(40) | ✔ |  |  |
| table_name | string(60) |  |  |  |
| partition_key | string(30) |  |  |  |
| cursor_json | json |  |  |  |
| rows_done | int | ✔ | ≥ 0 |  |
| chunk_no | int |  | ≥ 0 |  |
| chunk_sha256 | string(64) |  |  |  |
| status | enum `RunStatus` | ✔ |  |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### BackupRuns (`backup_runs`)

ประวัติการสำรองข้อมูลและผลทดสอบ restore

- kind: **ENTITY** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `PERMANENT`
- unique: —
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| backup_type | enum `BackupType` | ✔ |  |  |
| status | enum `RunStatus` | ✔ |  |  |
| started_at | timestamp (UTC) | ✔ |  |  |
| finished_at | timestamp (UTC) |  |  |  |
| package_location | string(300) |  |  |  |
| manifest_sha256 | string(64) |  |  |  |
| row_counts_json | json |  |  |  |
| retention_until | date |  |  |  |
| restore_tested_at | timestamp (UTC) |  |  |  |
| restore_result | string(1000) |  |  |  |
| migration_run_id | uuid |  | FK → MigrationRuns.id |  |
| job_id | uuid |  | FK → Jobs.id |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### ChangeLog (`change_log`)

ลำดับการเปลี่ยนแปลงต่อ operation (insert/update/tombstone) สำหรับ incremental export/delta; seq เพิ่มขึ้นเสมอ

- kind: **EVENT** · partition: **TERM** (committed_at) · sensitivity: **INTERNAL** · retention: `1Y`
- unique: (seq)
- lookup/index (access pattern): operation_id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| seq | int | ✔ | ≥ 1 |  |
| operation_id | uuid | ✔ |  |  |
| operation | string(80) | ✔ |  |  |
| committed_at | timestamp (UTC) | ✔ |  |  |
| changes_json | json | ✔ |  | [{table, id, op: INSERT\|UPDATE\|TOMBSTONE, version}] |
| actor_id | uuid | ✔ | FK → Users.id |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

#### ReportRuns (`report_runs`)

การออกรายงาน: filter, as_of, schema/rule version, ผู้สร้าง, การล็อกรอบ และ revision

- kind: **ENTITY** · partition: **NONE** · sensitivity: **INTERNAL** · retention: `2Y`
- unique: —
- lookup/index (access pattern): report_code+as_of

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| report_code | enum `ReportCode` | ✔ |  |  |
| filter_json | json | ✔ |  |  |
| as_of | timestamp (UTC) | ✔ |  |  |
| schema_version | int | ✔ | ≥ 1 |  |
| rule_versions_json | json |  |  |  |
| status | enum `ReportStatus` | ✔ |  |  |
| output_format | enum `OutputFormat` | ✔ |  |  |
| output_attachment_id | uuid |  | FK → Attachments.id |  |
| row_count | int |  | ≥ 0 |  |
| totals_json | json |  |  |  |
| locked | bool | ✔ |  |  |
| locked_by | uuid |  | FK → Users.id |  |
| locked_at | timestamp (UTC) |  |  |  |
| supersedes_run_id | uuid |  | FK → ReportRuns.id |  |
| superseded_by_run_id | uuid |  | FK → ReportRuns.id |  |
| requested_by | uuid | ✔ | FK → Users.id |  |
| job_id | uuid |  | FK → Jobs.id |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาสร้าง (UTC) |
| created_by | uuid | ✔ |  | ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK) |
| updated_at | timestamp (UTC) | ✔ |  | เวลาแก้ไขล่าสุด (UTC) |
| updated_by | uuid | ✔ |  | ผู้แก้ไขล่าสุด |
| version | int | ✔ | ≥ 1 | row version สำหรับ optimistic concurrency |

#### OperationMetrics (`operation_metrics`)

สถิติเวลา p50/p95 ต่อ operation ต่อช่วงเวลา (สำหรับ pilot และเกณฑ์ย้ายระบบ)

- kind: **EVENT** · partition: **TERM** (bucket_start) · sensitivity: **INTERNAL** · retention: `1Y`
- unique: —
- lookup/index (access pattern): by id

| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |
|---|---|---|---|---|
| id | uuid | ✔ | PK | รหัสภายใน (UUID) |
| bucket_start | timestamp (UTC) | ✔ |  |  |
| operation | string(80) | ✔ |  |  |
| count | int | ✔ | ≥ 0 |  |
| error_count | int | ✔ | ≥ 0 |  |
| p50_ms | int |  | ≥ 0 |  |
| p95_ms | int |  | ≥ 0 |  |
| max_ms | int |  | ≥ 0 |  |
| lock_wait_p95_ms | int |  | ≥ 0 |  |
| created_at | timestamp (UTC) | ✔ |  | เวลาบันทึก (UTC) |
| created_by | uuid | ✔ |  | ผู้บันทึก (ยืนยันโดย server) |

## 7. Enumerations

- **Role**: `SYSTEM_ADMIN` ผู้ดูแลระบบ (งานเทคนิค) · `STUDENT_AFFAIRS` กลุ่มบริหารงานกิจการนักเรียน · `EXECUTIVE` ผู้บริหาร · `HOMEROOM_TEACHER` ครูที่ปรึกษา · `SUBJECT_TEACHER` ครูประจำวิชา · `DUTY_TEACHER` ครูเวร · `GATE_STAFF` เจ้าหน้าที่ประตู · `GUARDIAN` ผู้ปกครอง · `STUDENT` นักเรียน
- **UserType**: `STAFF` บุคลากร · `GUARDIAN` ผู้ปกครอง · `STUDENT` นักเรียน · `SYSTEM` ระบบ
- **UserStatus**: `INVITED` รอเปิดใช้งาน · `ACTIVE` ใช้งาน · `DISABLED` ระงับ
- **RecordStatus**: `ACTIVE` ใช้งาน · `INACTIVE` ไม่ใช้งาน
- **YearStatus**: `PLANNED` วางแผน · `ACTIVE` ใช้งาน · `CLOSED` ปิดแล้ว
- **DayType**: `SCHOOL_DAY` วันเรียน · `HOLIDAY` วันหยุด · `NO_SCHOOL` งดการเรียน · `EXAM_DAY` วันสอบ · `ACTIVITY_DAY` วันกิจกรรม
- **DaySession**: `AM` ช่วงเช้า · `PM` ช่วงบ่าย
- **RuleType**: `SCHOOL_LATENESS` เกณฑ์มาสายเข้าโรงเรียน · `PERIOD_LATENESS` เกณฑ์สายเข้าคาบ (โมดูลต่อยอด) · `FOLLOWUP_LATE_COUNT` เกณฑ์ติดตามจากจำนวนครั้งที่สาย · `FOLLOWUP_ABSENCE_COUNT` เกณฑ์ติดตามจากจำนวนวันขาดที่ยืนยัน · `LEAVE_ROUTING` เส้นทางอนุมัติใบลา · `ABSENCE_VERIFICATION` เวลาตรวจสอบการขาดเรียน · `NOTIFICATION_POLICY` นโยบายการแจ้งเตือน
- **RuleStatus**: `DRAFT` ร่าง · `ACTIVE` ใช้งาน · `RETIRED` เลิกใช้
- **StorageStatus**: `ACTIVE` ใช้งาน · `READONLY` อ่านอย่างเดียว · `ARCHIVED` จัดเก็บถาวร
- **IdentityProvider**: `firebase` Firebase Authentication / Identity Platform · `google-workspace` Google Workspace (ยังไม่เปิดใช้) · `demo` บัญชีทดสอบ (DEV เท่านั้น)
- **LinkStatus**: `ACTIVE` ใช้งาน · `REVOKED` เพิกถอน
- **LinkedVia**: `INVITATION` คำเชิญ · `BOOTSTRAP` ติดตั้งระบบ · `ADMIN` ผู้ดูแลผูกบัญชี · `DEMO_SEED` ข้อมูลทดสอบ
- **AssignmentType**: `HOMEROOM` ครูที่ปรึกษา · `DUTY` เวรประจำจุด · `TEACHING` สอนประจำวิชา · `DELEGATE` ผู้รักษาการแทน
- **InvitationType**: `STAFF` บุคลากร · `GUARDIAN` ผู้ปกครอง · `STUDENT` นักเรียน
- **InvitationStatus**: `PENDING` รอใช้งาน · `REDEEMED` ใช้แล้ว · `EXPIRED` หมดอายุ · `REVOKED` ยกเลิก · `LOCKED` ล็อกเพราะกรอกผิดหลายครั้ง
- **StationType**: `GATE` ประตู/จุดลงเวลา · `OFFICE` ห้องกิจการนักเรียน · `CLASSROOM` ห้องเรียน
- **StudentStatus**: `ACTIVE` กำลังศึกษา · `TRANSFERRED_OUT` ย้ายออก · `GRADUATED` จบการศึกษา · `WITHDRAWN` พ้นสภาพ/ลาออก · `SUSPENDED` พักการเรียน
- **Gender**: `MALE` ชาย · `FEMALE` หญิง · `OTHER` อื่น ๆ · `UNSPECIFIED` ไม่ระบุ
- **GradeLevel**: `M1` ม.1 · `M2` ม.2 · `M3` ม.3 · `M4` ม.4 · `M5` ม.5 · `M6` ม.6
- **EnrollmentEndReason**: `CLASS_CHANGE` ย้ายห้อง · `PROMOTION` เลื่อนชั้น · `TRANSFER_OUT` ย้ายออก · `GRADUATION` จบการศึกษา · `WITHDRAWAL` พ้นสภาพ/ลาออก · `CORRECTION` แก้ไขข้อมูลผิด
- **Relationship**: `FATHER` บิดา · `MOTHER` มารดา · `GRANDPARENT` ปู่ย่าตายาย · `SIBLING` พี่น้อง · `RELATIVE` ญาติ · `LEGAL_GUARDIAN` ผู้ปกครองตามกฎหมาย · `OTHER` อื่น ๆ
- **GuardianLinkStatus**: `PENDING_VERIFICATION` รอเจ้าหน้าที่ยืนยัน · `ACTIVE` ยืนยันแล้ว · `ENDED` สิ้นสุด
- **VerificationMethod**: `IN_PERSON` พบตัวที่โรงเรียน · `DOCUMENT` ตรวจเอกสาร · `PHONE_CALLBACK` โทรกลับยืนยันเบอร์ที่โรงเรียนมี · `SCHOOL_RECORD` ทะเบียนนักเรียน
- **GuardianPermission**: `VIEW_ATTENDANCE` ดูการมาเรียน · `SUBMIT_LEAVE` แจ้งลา · `CONFIRM_LEAVE` ยืนยันใบลา · `RECEIVE_NOTIFICATIONS` รับการแจ้งเตือน · `VIEW_CASE_SUMMARY` ดูสรุปการติดตาม · `VIEW_DOCUMENTS` ดูเอกสารที่ตนส่ง
- **ContactOwnerType**: `GUARDIAN` ผู้ปกครอง · `STAFF` บุคลากร · `STUDENT` นักเรียน
- **ContactChannel**: `PHONE` โทรศัพท์ · `EMAIL` อีเมล · `LINE` LINE · `SMS` SMS · `IN_PERSON` พบตัว · `OTHER` อื่น ๆ
- **AttendanceEventType**: `GATE_ARRIVAL` ลงเวลามาถึงโรงเรียน · `CLASSROOM_ENTERED` เข้าห้องเรียน · `ROLL_CALL_PRESENT` เช็กชื่อ: มา · `ROLL_CALL_ABSENT` เช็กชื่อ: ไม่พบตัว · `ROLL_CALL_LATE` เช็กชื่อ: มาสาย (ไม่มีบันทึกที่ประตู) · `ROLL_CALL_LEAVE_REPORTED` เช็กชื่อ: แจ้งลาด้วยวาจา รอใบลา · `ABSENCE_CONFIRMED` ยืนยันขาดเรียน · `LATENESS_EXEMPTED` ยกเว้นการนับสาย · `EVENT_VOIDED` ยกเลิกรายการ (แก้ไข)
- **AttendanceSource**: `SCAN_KEYBOARD` เครื่องสแกนแบบคีย์บอร์ด · `SCAN_CAMERA` สแกนด้วยกล้อง · `SEARCH_CODE` ค้นหารหัส · `SEARCH_NAME` ค้นหาชื่อ · `MANUAL_TIME` ครูระบุเวลาเอง · `QUEUE_BATCH` เวลามาถึงของแถวรอ · `OFFLINE_SYNC` บันทึกขณะออฟไลน์ · `ROLL_CALL` การเช็กชื่อ · `IMPORT` นำเข้า · `CORRECTION` การแก้ไข · `SYSTEM` ระบบ
- **PresenceStatus**: `PRESENT` มาเรียน · `ABSENT_CONFIRMED` ขาดเรียน (ยืนยันแล้ว) · `ON_LEAVE_FULL_DAY` ลาทั้งวัน · `UNKNOWN` รอตรวจสอบ · `NOT_ELIGIBLE` ไม่อยู่ในทะเบียนวันนั้น · `NON_SCHOOL_DAY` ไม่ใช่วันเรียน
- **VerificationLevel**: `NONE` ยังไม่มีหลักฐาน · `GATE_RECORD` บันทึกที่ประตู · `ROLL_CALL` ครูเช็กชื่อ · `VERIFIED` ครูยืนยันแล้ว
- **RollCallMark**: `PRESENT` มา · `ABSENT` ไม่พบตัว · `LATE` มาสาย · `LEAVE_REPORTED` แจ้งลา · `NOT_MARKED` ยังไม่เช็กชื่อ
- **RollCallStatus**: `OPEN` กำลังเช็กชื่อ · `SUBMITTED` ส่งแล้ว · `VERIFIED` ยืนยันแล้ว
- **CorrectionType**: `VOID_EVENT` ยกเลิกรายการ · `AMEND_ARRIVAL_TIME` แก้เวลามาถึง · `ADD_ARRIVAL` เพิ่มรายการมาถึง · `CHANGE_ROLL_CALL_MARK` แก้ผลเช็กชื่อ · `EXEMPT_LATENESS` ยกเว้นการนับสาย
- **CorrectionStatus**: `PENDING` รอพิจารณา · `APPLIED` แก้ไขแล้ว · `REJECTED` ไม่อนุมัติ
- **ReconciliationTaskType**: `UNKNOWN_STATUS` นักเรียนยังไม่ทราบสถานะ · `CONFLICT_LEAVE_PRESENCE` มีใบลาแต่พบการมาเรียน · `CONFLICT_ROLLCALL_GATE` เช็กชื่อไม่พบตัวแต่มีบันทึกประตู · `OFFLINE_REVIEW` ตรวจรายการออฟไลน์ · `IMPORT_REVIEW` ตรวจข้อมูลนำเข้า · `LEAVE_REPORTED_NO_REQUEST` แจ้งลาด้วยวาจาแต่ยังไม่มีใบลา · `DATA_QUALITY` คุณภาพข้อมูล
- **TaskStatus**: `OPEN` รอดำเนินการ · `RESOLVED` แก้ไขแล้ว · `DISMISSED` ไม่ต้องดำเนินการ
- **LeaveType**: `SICK` ลาป่วย · `PERSONAL` ลากิจ · `SCHOOL_ACTIVITY` กิจกรรมโรงเรียน (ไม่นับเป็นการลาส่วนตัว) · `OTHER` อื่น ๆ
- **LeaveUnit**: `FULL_DAY` ทั้งวัน · `HALF_DAY_AM` ครึ่งวันเช้า · `HALF_DAY_PM` ครึ่งวันบ่าย · `PERIODS` บางคาบ
- **LeaveStatus**: `DRAFT` ร่าง · `SUBMITTED` ส่งแล้ว · `PENDING_GUARDIAN` รอผู้ปกครองยืนยัน · `PENDING_SCHOOL` รอโรงเรียนอนุมัติ · `RETURNED` ส่งกลับแก้ไข · `APPROVED` อนุมัติ · `PARTIALLY_APPROVED` อนุมัติบางช่วง · `REJECTED` ไม่อนุมัติ · `WITHDRAWN` ถอนคำขอ · `CANCELLATION_REQUESTED` ขอยกเลิก · `CANCELLED` ยกเลิกแล้ว
- **GuardianConfirmation**: `NOT_REQUIRED` ไม่ต้องยืนยัน · `PENDING` รอยืนยัน · `CONFIRMED` ยืนยันแล้ว · `DECLINED` ผู้ปกครองไม่ยืนยัน
- **SchoolApproval**: `NOT_STARTED` ยังไม่เริ่ม · `PENDING` รออนุมัติ · `APPROVED` อนุมัติ · `PARTIALLY_APPROVED` อนุมัติบางช่วง · `REJECTED` ไม่อนุมัติ · `RETURNED` ส่งกลับแก้ไข
- **RequesterType**: `GUARDIAN` ผู้ปกครอง · `STUDENT` นักเรียน · `STAFF` บุคลากรแจ้งแทน
- **SegmentStatus**: `REQUESTED` ขอลา · `APPROVED` อนุมัติ · `REJECTED` ไม่อนุมัติ · `WITHDRAWN` ถอน · `CANCELLED` ยกเลิก
- **SegmentUsage**: `NOT_EVALUATED` ยังไม่ประเมิน · `USED` ใช้ตามคำขอ · `ATTENDED_ANYWAY` มีหลักฐานว่ามาเรียน · `PARTIALLY_USED` ใช้บางส่วน
- **LeaveAction**: `CREATE` สร้าง · `SUBMIT` ส่งคำขอ · `GUARDIAN_CONFIRM` ผู้ปกครองยืนยัน · `GUARDIAN_DECLINE` ผู้ปกครองไม่ยืนยัน · `APPROVE` อนุมัติ · `PARTIAL_APPROVE` อนุมัติบางช่วง · `REJECT` ไม่อนุมัติ · `RETURN` ส่งกลับแก้ไข · `RESUBMIT` ส่งใหม่หลังแก้ไข · `WITHDRAW` ถอนคำขอ · `CANCEL_REQUEST` ขอยกเลิก · `CANCEL_APPROVE` อนุมัติการยกเลิก · `CANCEL_REJECT` ไม่อนุมัติการยกเลิก · `REROUTE` เปลี่ยนผู้พิจารณา
- **ApprovalStepType**: `GUARDIAN_CONFIRMATION` ผู้ปกครองยืนยัน · `SCHOOL_APPROVAL` โรงเรียนอนุมัติ · `CANCELLATION_DECISION` พิจารณาการยกเลิก
- **ApprovalDecision**: `CONFIRMED` ยืนยัน · `DECLINED` ไม่ยืนยัน · `APPROVED` อนุมัติ · `PARTIALLY_APPROVED` อนุมัติบางช่วง · `REJECTED` ไม่อนุมัติ · `RETURNED` ส่งกลับแก้ไข
- **CaseType**: `RULE_LATE_COUNT` สายเกินเกณฑ์ · `RULE_ABSENCE_COUNT` ขาดเกินเกณฑ์ · `MANUAL` เปิดโดยครู · `CALLBACK_REQUEST` ผู้ปกครองขอให้ติดต่อกลับ · `ACK_TIMEOUT` ไม่ได้รับการรับทราบตามเวลา
- **CaseStatus**: `OPEN` เปิด · `IN_PROGRESS` กำลังดำเนินการ · `WAITING_RESPONSE` รอการตอบกลับ · `RESOLVED` แก้ไขแล้ว (รอปิด) · `CLOSED` ปิดเรื่อง
- **Priority**: `LOW` ต่ำ · `NORMAL` ปกติ · `HIGH` สูง · `URGENT` เร่งด่วน
- **CaseEventType**: `OPENED` เปิดเรื่อง · `ASSIGNED` มอบหมาย · `NOTE` บันทึก · `CONTACT_LOGGED` บันทึกการติดต่อ · `APPOINTMENT_SET` นัดหมาย · `STATUS_CHANGED` เปลี่ยนสถานะ · `TRANSFERRED` ส่งต่อ · `CLOSED` ปิดเรื่อง · `REOPENED` เปิดใหม่ · `CALLBACK_REQUESTED` ขอให้ติดต่อกลับ
- **ContactDirection**: `OUTBOUND` โรงเรียนติดต่อ · `INBOUND` ผู้ปกครองติดต่อมา
- **ContactOutcome**: `REACHED` ติดต่อได้ · `NO_ANSWER` ติดต่อไม่ได้ · `ACKNOWLEDGED` ผู้ปกครองรับทราบแล้ว · `APPOINTMENT_MADE` นัดหมายแล้ว · `FOLLOW_UP_NEEDED` ต้องติดตามต่อ · `WRONG_CONTACT` ข้อมูลติดต่อไม่ถูกต้อง · `ASSISTANCE_PROVIDED` ให้ความช่วยเหลือแล้ว
- **AppointmentStatus**: `SCHEDULED` นัดแล้ว · `COMPLETED` พบแล้ว · `NO_SHOW` ไม่มาตามนัด · `CANCELLED` ยกเลิก · `RESCHEDULED` เลื่อนนัด
- **FileClassification**: `GENERAL` ทั่วไป · `MEDICAL` เอกสารสุขภาพ (อ่อนไหว) · `PHOTO` รูปถ่ายนักเรียน · `REPORT` รายงาน · `EXPORT` ไฟล์ส่งออก · `IMPORT_SOURCE` ไฟล์นำเข้า
- **FileStatus**: `STAGED` อัปโหลดแล้วยังไม่ผูก · `ACTIVE` ใช้งาน · `DELETED` ลบแล้ว · `QUARANTINED` กักตรวจ
- **EntityType**: `STUDENT` นักเรียน · `LEAVE_REQUEST` ใบลา · `CASE` เรื่องติดตาม · `CONTACT_LOG` บันทึกการติดต่อ · `IMPORT_BATCH` ชุดนำเข้า · `REPORT_RUN` รายงาน · `ATTENDANCE_CORRECTION` คำขอแก้ไขการมาเรียน · `SCHOOL` โรงเรียน · `MIGRATION_RUN` งานย้ายข้อมูล · `BACKUP_RUN` การสำรองข้อมูล
- **StorageProvider**: `GOOGLE_DRIVE` Google Drive · `FILESYSTEM` ระบบไฟล์ (ทดสอบ) · `OBJECT_STORAGE` Object storage
- **NotificationType**: `LEAVE_NEW` ใบลาใหม่ · `LEAVE_PENDING_GUARDIAN` ใบลารอผู้ปกครองยืนยัน · `LEAVE_PENDING_SCHOOL` ใบลารออนุมัติ · `LEAVE_DECIDED` ผลพิจารณาใบลา · `LATE_CONFIRMED` มาสาย · `ABSENCE_CONFIRMED` ขาดเรียน (ยืนยันแล้ว) · `CASE_NEW` งานติดตามใหม่ · `CASE_OVERDUE` งานติดตามเกินกำหนด · `CALLBACK_REQUESTED` ขอให้ติดต่อกลับ · `DATA_CORRECTED` แจ้งการแก้ไขข้อมูลสำคัญ · `ROLL_CALL_REMINDER` เตือนตรวจสอบการมาเรียน · `SYSTEM` แจ้งจากระบบ
- **Urgency**: `NORMAL` ปกติ · `URGENT` เร่งด่วน
- **InAppState**: `UNREAD` ยังไม่อ่าน · `READ` เปิดอ่านในแอปแล้ว
- **AckState**: `NOT_REQUIRED` ไม่ต้องรับทราบ · `PENDING_ACK` รอรับทราบ · `ACKNOWLEDGED` รับทราบแล้ว · `FOLLOW_UP_REQUIRED` ต้องติดตาม
- **Channel**: `EMAIL` อีเมล · `LINE` LINE · `SMS` SMS
- **DeliveryState**: `QUEUED` รอส่ง · `PROCESSING` กำลังส่ง · `PROVIDER_ACCEPTED` ผู้ให้บริการรับคำขอแล้ว (ไม่ใช่การอ่าน) · `RETRY_WAIT` รอส่งซ้ำ · `FAILED_FINAL` ส่งไม่สำเร็จ · `CANCELLED` ยกเลิกการส่ง
- **AttemptResult**: `ACCEPTED` รับคำขอแล้ว · `DUPLICATE_ACCEPTED` คำขอเดิมเคยรับแล้ว (409) · `RETRYABLE_ERROR` ผิดพลาดชั่วคราว · `FINAL_ERROR` ผิดพลาดถาวร · `OUTCOME_UNKNOWN` ไม่ทราบผล · `SKIPPED` ข้ามการส่ง
- **AckAction**: `ACKNOWLEDGED` รับทราบ · `CALLBACK_REQUESTED` ขอให้ติดต่อกลับ
- **AckChannel**: `IN_APP` ในแอป · `LINE` LINE
- **BindingStatus**: `PENDING` รอยืนยัน · `ACTIVE` ใช้งาน · `REVOKED` ยกเลิก
- **BindingVerifiedVia**: `LINE_ACCOUNT_LINK` LINE account link · `IDP_VERIFIED_EMAIL` อีเมลที่ผู้ให้บริการยืนยันตัวตนยืนยันแล้ว · `STAFF_VERIFIED` เจ้าหน้าที่ยืนยัน
- **WebhookStatus**: `RECEIVED` รับแล้ว · `PROCESSED` ประมวลผลแล้ว · `IGNORED` ไม่ต้องประมวลผล · `FAILED` ล้มเหลว
- **JournalStatus**: `PREPARED` เตรียมบันทึก · `COMMITTED` บันทึกครบ · `RECOVERY_REQUIRED` ต้องกู้คืนด้วยผู้ดูแล · `ABORTED` ยกเลิก
- **JobStatus**: `QUEUED` รอทำงาน · `RUNNING` กำลังทำงาน · `PAUSED` หยุดชั่วคราว · `SUCCEEDED` สำเร็จ · `FAILED` ล้มเหลว · `CANCELLED` ยกเลิก
- **ImportType**: `STUDENTS` นักเรียน · `CLASSES` ห้องเรียน · `ENROLLMENTS` การลงทะเบียนห้อง · `GUARDIANS` ผู้ปกครองและความสัมพันธ์ · `STAFF` บุคลากรและบทบาท · `CALENDAR` ปฏิทินโรงเรียน
- **SourceFormat**: `CSV` CSV · `XLSX` XLSX
- **ImportStatus**: `UPLOADED` อัปโหลดแล้ว · `PREVIEWED` ดูตัวอย่างแล้ว · `VALIDATED` ตรวจแล้ว · `APPLYING` กำลังนำเข้า · `APPLIED` นำเข้าแล้ว · `FAILED` ล้มเหลว · `CANCELLED` ยกเลิก
- **MigrationRunType**: `EXPORT` ส่งออก · `VALIDATE` ตรวจ package · `IMPORT_SHEETS` นำเข้า Sheets ชุดใหม่ · `IMPORT_POSTGRES` นำเข้า PostgreSQL · `RECONCILE` กระทบยอด · `CUTOVER` สลับระบบ · `ROLLBACK` ย้อนกลับ
- **MigrationMode**: `FULL_SNAPSHOT` ภาพรวมทั้งระบบ (freeze) · `PARTIAL` บางส่วน (ใช้ย้ายระบบทั้งชุดไม่ได้) · `REPORT_EXPORT` ส่งออกเพื่อรายงาน · `REHEARSAL` ซ้อมย้าย
- **MigrationState**: `PLANNED` วางแผน · `SNAPSHOTTING` กำลังส่งออก · `EXPORTED` ส่งออกแล้ว · `VALIDATED` ตรวจผ่าน · `STAGED` นำเข้าพื้นที่พักแล้ว · `RECONCILED` กระทบยอดผ่าน · `CUTOVER_READY` พร้อมสลับระบบ · `ACTIVE` ระบบใหม่ใช้งาน · `ROLLED_BACK` ย้อนกลับแล้ว · `FAILED` ล้มเหลว · `CANCELLED` ยกเลิก
- **Completeness**: `COMPLETE` ครบถ้วน · `PARTIAL` ไม่ครบ · `FAILED` ล้มเหลว
- **BackupType**: `NIGHTLY_SNAPSHOT` สำรองประจำคืน · `MANUAL` สำรองด้วยผู้ดูแล
- **RunStatus**: `RUNNING` กำลังทำงาน · `SUCCEEDED` สำเร็จ · `FAILED` ล้มเหลว
- **ReportCode**: `R01` การมาเรียนประจำวัน · `R02` มาสาย · `R03` การลา · `R04` ประวัติรายบุคคล · `R05` ผู้เรียนที่ควรติดตาม · `R06` การติดต่อผู้ปกครอง · `R07` แนวโน้ม · `R08` งานค้าง/คุณภาพข้อมูล · `R09` การแจ้งเตือน · `R10` แบบฟอร์มรายกรณี · `R11` Audit · `R12` การสำรอง/ย้ายข้อมูล
- **ReportStatus**: `QUEUED` รอสร้าง · `RUNNING` กำลังสร้าง · `READY` พร้อม · `FAILED` ล้มเหลว · `SUPERSEDED` ถูกแทนที่ด้วยฉบับใหม่
- **OutputFormat**: `JSON` แสดงบนจอ · `CSV` CSV · `XLSX` XLSX · `PDF` PDF
- **AuditChannel**: `APP` แอป · `JOB` งานเบื้องหลัง · `WEBHOOK` Webhook · `EDITOR` Apps Script Editor · `MIGRATION` ย้ายข้อมูล · `API` REST API
- **SchemaComponent**: `SHEETS` Google Sheets · `POSTGRES` PostgreSQL

## 8. โมดูลเสริม (ปิดไว้ — ยังไม่ส่งมอบ)

- `feature.subject_attendance`: ต้องเพิ่มตาราง Subjects, TeachingAssignments, SubjectAttendance — ต้องมี รายวิชา ตารางเรียน roster รายคาบ และกฎสายเข้าคาบ (PERIOD_LATENESS)
- `feature.campus_pass`: ต้องเพิ่มตาราง CampusPasses, CampusPassEvents — ต้องมี ผู้อนุมัติ ผู้รับนักเรียน จุดตรวจ เวลาออก/กลับ และ gate confirmation
- `feature.behavior_points`: ต้องเพิ่มตาราง BehaviorPolicies, BehaviorPointEvents — ต้องมี ระเบียบโรงเรียนที่อนุมัติแล้ว ห้ามตัดคะแนนอัตโนมัติจากจำนวนสาย

// Single source of truth for the domain schema. Everything else is generated or validated from it:
//   - DATA_DICTIONARY.md, schema/*.schema.json            (tools/gen-docs.mjs)
//   - database/postgres/migrations/0001_init.sql           (tools/gen-docs.mjs → sql generator)
//   - Sheets headers, cell encoding and drift checks       (src/adapters/gas/sheets-*.js)
//   - portable export/import validation                     (src/application/migration/*)
// Schema changes require a new SCHEMA_VERSION and a migration step (see CHANGELOG.md).
//
// Column types: uuid | string | text | int | decimal | bool | date | ts | hhmm | enum | json
// Sensitivity: PUBLIC < INTERNAL < PERSONAL < SENSITIVE < SECRET (SECRET is never exported).

export const SCHEMA_VERSION = 1;

const ENTITY_META = [
  { name: 'created_at', type: 'ts', required: true, description_th: 'เวลาสร้าง (UTC)' },
  { name: 'created_by', type: 'uuid', required: true, description_th: 'ผู้สร้าง (Users.id; อ้างอิงแบบ soft ไม่บังคับ FK)' },
  { name: 'updated_at', type: 'ts', required: true, description_th: 'เวลาแก้ไขล่าสุด (UTC)' },
  { name: 'updated_by', type: 'uuid', required: true, description_th: 'ผู้แก้ไขล่าสุด' },
  { name: 'version', type: 'int', required: true, min: 1, description_th: 'row version สำหรับ optimistic concurrency' },
];
const EVENT_META = [
  { name: 'created_at', type: 'ts', required: true, description_th: 'เวลาบันทึก (UTC)' },
  { name: 'created_by', type: 'uuid', required: true, description_th: 'ผู้บันทึก (ยืนยันโดย server)' },
];

const id = (desc = 'รหัสภายใน (UUID)') => ({ name: 'id', type: 'uuid', required: true, pk: true, description_th: desc });
const fk = (name, ref, opts = {}) => ({ name, type: 'uuid', fk: ref, ...opts });
const en = (name, enumName, opts = {}) => ({ name, type: 'enum', enum: enumName, ...opts });
const str = (name, maxLength, opts = {}) => ({ name, type: 'string', maxLength, ...opts });
const txt = (name, opts = {}) => ({ name, type: 'text', maxLength: 5000, ...opts });
const int = (name, opts = {}) => ({ name, type: 'int', ...opts });
const bool = (name, opts = {}) => ({ name, type: 'bool', ...opts });
const date = (name, opts = {}) => ({ name, type: 'date', ...opts });
const ts = (name, opts = {}) => ({ name, type: 'ts', ...opts });
const hhmm = (name, opts = {}) => ({ name, type: 'hhmm', ...opts });
const json = (name, opts = {}) => ({ name, type: 'json', maxLength: 45000, ...opts });

const R = { required: true };

export const TABLES = [
  // ───────────────────────── Configuration ─────────────────────────
  {
    name: 'Schools', group: 'Configuration', kind: 'CONFIG', partition: 'NONE', sensitivity: 'PUBLIC', retention: 'PERMANENT',
    description_th: 'ข้อมูลโรงเรียน (ระยะแรก single-school แต่เก็บ school_id เพื่อจัดขอบเขต)',
    columns: [id(), str('code', 30, R), str('name_th', 200, R), str('name_en', 200), str('unit_th', 200, { description_th: 'หน่วยงาน เช่น กลุ่มบริหารงานกิจการนักเรียน' }),
      str('timezone', 40, { ...R, default: 'Asia/Bangkok' }), str('locale', 10, { ...R, default: 'th-TH' }),
      { name: 'logo_file_id', type: 'uuid', description_th: 'Attachments.id ของตราโรงเรียน (soft reference); ว่าง = แสดงชื่อโรงเรียน' },
      str('brand_color', 7, { pattern: '^#[0-9A-Fa-f]{6}$', default: '#B91C1C', description_th: 'สีหลัก (ค่าตัวอย่าง ไม่ใช่สีอัตลักษณ์ที่รับรอง)' }),
      ...ENTITY_META],
    unique: [['code']], accessPatterns: ['getById (ทุกคำขอ, cache ได้)'],
  },
  {
    name: 'AcademicYears', group: 'Configuration', kind: 'CONFIG', partition: 'NONE', sensitivity: 'PUBLIC', retention: 'PERMANENT',
    description_th: 'ปีการศึกษา ช่วง [start_date, end_date)',
    columns: [id(), fk('school_id', 'Schools', R), int('start_year_ce', { ...R, min: 2000, max: 2200, description_th: 'ปี ค.ศ. ที่เริ่มปีการศึกษา (แสดงผลเป็น พ.ศ.)' }),
      str('label_th', 100, R), date('start_date', R), date('end_date', { ...R, description_th: 'วันสิ้นสุดแบบไม่รวม (exclusive)' }), en('status', 'YearStatus', R), ...ENTITY_META],
    unique: [['school_id', 'start_year_ce']], checks: ['start_date < end_date'],
  },
  {
    name: 'Terms', group: 'Configuration', kind: 'CONFIG', partition: 'NONE', sensitivity: 'PUBLIC', retention: 'PERMANENT',
    description_th: 'ภาคเรียน และ partition key ของข้อมูลปฏิบัติการ',
    columns: [id(), fk('academic_year_id', 'AcademicYears', R), int('term_no', { ...R, min: 1, max: 3 }),
      str('code', 20, { ...R, pattern: '^AY\\d{4}-T[1-3]$', description_th: 'เช่น AY2026-T1 ใช้เป็น partition key' }),
      date('start_date', R), date('end_date', { ...R, description_th: 'exclusive' }), en('status', 'YearStatus', R), ...ENTITY_META],
    unique: [['code'], ['academic_year_id', 'term_no']], checks: ['start_date < end_date'],
  },
  {
    name: 'SchoolCalendar', group: 'Configuration', kind: 'CONFIG', partition: 'NONE', sensitivity: 'PUBLIC', retention: 'PERMANENT',
    description_th: 'ข้อยกเว้นปฏิทิน (ค่าเริ่มต้น: จันทร์–ศุกร์ในภาคเรียนเป็นวันเรียน) ใช้ applies_to_level ว่าง = ทุกระดับ',
    columns: [id(), fk('school_id', 'Schools', R), date('calendar_date', R), en('day_type', 'DayType', R),
      en('applies_to_level', 'GradeLevel', { description_th: 'ว่าง = ทุกระดับชั้น' }), str('title_th', 200), ...ENTITY_META],
    unique: [{ columns: ['school_id', 'calendar_date', 'applies_to_level'], nullsNotDistinct: true }], lookup: ['calendar_date'],
  },
  {
    name: 'Periods', group: 'Configuration', kind: 'CONFIG', partition: 'NONE', sensitivity: 'PUBLIC', retention: 'PERMANENT',
    description_th: 'คาบเรียนพร้อมวันที่มีผล',
    columns: [id(), fk('school_id', 'Schools', R), int('period_no', { ...R, min: 0, max: 20 }), str('label_th', 50, R), en('session', 'DaySession', R),
      hhmm('start_time', R), hhmm('end_time', R), date('effective_from', R), date('effective_to'), en('applies_to_level', 'GradeLevel'), ...ENTITY_META],
    unique: [{ columns: ['school_id', 'period_no', 'effective_from', 'applies_to_level'], nullsNotDistinct: true }], checks: ['start_time < end_time', 'effective_to IS NULL OR effective_from < effective_to'],
  },
  {
    name: 'Settings', group: 'Configuration', kind: 'CONFIG', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'PERMANENT',
    description_th: 'Business settings ที่ไม่ลับ (แยกจาก Script Properties / secrets)',
    columns: [id(), fk('school_id', 'Schools', R), str('key', 100, { ...R, pattern: '^[a-z][a-z0-9_.]*$' }), json('value_json', R),
      bool('is_example', { ...R, default: false, description_th: 'TRUE = ค่าตัวอย่างที่ต้องยืนยันก่อน production' }), str('description_th', 500), ...ENTITY_META],
    unique: [['school_id', 'key']],
  },
  {
    name: 'RuleVersions', group: 'Configuration', kind: 'CONFIG', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'PERMANENT',
    description_th: 'กฎธุรกิจแบบมีเวอร์ชันและวันที่มีผล (เวลาเริ่มสาย เกณฑ์ติดตาม เส้นทางอนุมัติ ฯลฯ)',
    columns: [id(), fk('school_id', 'Schools', R), en('rule_type', 'RuleType', R), int('version_no', { ...R, min: 1 }),
      date('effective_from', R), date('effective_to'), json('params_json', R), en('status', 'RuleStatus', R),
      bool('is_example', { ...R, default: true, description_th: 'TRUE = ค่าตัวอย่าง ห้ามใช้ใน production จนกว่าโรงเรียนยืนยัน' }),
      fk('approved_by', 'Users'), ts('approved_at'), txt('notes_th'), ...ENTITY_META],
    unique: [['school_id', 'rule_type', 'version_no']], checks: ['effective_to IS NULL OR effective_from < effective_to'],
  },
  {
    name: 'SchemaVersions', group: 'Configuration', kind: 'EVENT', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'PERMANENT',
    description_th: 'ประวัติการติดตั้ง/อัปเกรด schema (append-only)',
    columns: [id(), en('component', 'SchemaComponent', R), int('schema_version', { ...R, min: 1 }), ts('applied_at', R), str('applied_by', 200, R),
      str('description', 500), str('checksum', 64), ...EVENT_META],
    unique: [['component', 'schema_version']],
  },
  {
    name: 'StorageCatalog', group: 'Configuration', kind: 'CONFIG', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'PERMANENT',
    description_th: 'แผนที่ logical table + partition → workbook/sheet (Sheets adapter); ปลายทางอื่นเก็บเป็น metadata',
    columns: [id(), str('logical_table', 60, R), str('partition_key', 30, { ...R, description_th: '"*" = ไม่แบ่ง partition, หรือรหัสภาคเรียน เช่น AY2026-T1' }),
      str('workbook_id', 100, { description_th: 'Spreadsheet ID (ไม่ใช่ secret แต่ไม่ฝังในโค้ด)' }), str('sheet_name', 100, R), int('schema_version', { ...R, min: 1 }),
      en('status', 'StorageStatus', R), int('row_count', { min: 0 }), int('cell_count', { min: 0 }), ts('measured_at'), ...ENTITY_META],
    unique: [['logical_table', 'partition_key']],
  },

  // ───────────────────────── Identity ─────────────────────────
  {
    name: 'Users', group: 'Identity', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ACCOUNT_LIFETIME_PLUS_1Y',
    description_th: 'บัญชีผู้ใช้ของแอป (UUID อิสระจากผู้ให้บริการยืนยันตัวตน); สร้างบัญชีแล้วยังไม่มีสิทธิ์จนผ่านคำเชิญและบทบาท',
    columns: [id(), fk('school_id', 'Schools', R), en('user_type', 'UserType', R), str('display_name', 200, R),
      str('contact_email', 254, { description_th: 'อีเมลติดต่อ (ไม่ใช่หลักฐานยืนยันตัวตน)' }), str('staff_code', 30),
      fk('student_id', 'Students', { description_th: 'สำหรับบัญชีนักเรียน (กำหนดโดยเจ้าหน้าที่เท่านั้น)' }),
      fk('guardian_id', 'Guardians', { description_th: 'สำหรับบัญชีผู้ปกครอง (กำหนดโดยเจ้าหน้าที่เท่านั้น)' }),
      en('status', 'UserStatus', R), ts('disabled_at'), fk('disabled_by', 'Users'), str('disabled_reason', 500), ts('last_login_at'), ...ENTITY_META],
    unique: [['school_id', 'staff_code']], lookup: ['student_id', 'guardian_id'],
  },
  {
    name: 'IdentityLinks', group: 'Identity', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ACCOUNT_LIFETIME_PLUS_1Y',
    description_th: 'การผูก (provider, issuer, subject) กับ Users.id — ไม่เก็บรหัสผ่านหรือ token',
    columns: [id(), fk('user_id', 'Users', R), en('provider', 'IdentityProvider', R), str('issuer', 300, R), str('subject', 200, R),
      str('email_at_link', 254, { description_th: 'อีเมลที่ provider ยืนยันขณะผูก (ข้อมูลประกอบ)' }), ts('linked_at', R), en('linked_via', 'LinkedVia', R),
      fk('invitation_id', 'InvitationRecords'), en('status', 'LinkStatus', R), ts('revoked_at'), fk('revoked_by', 'Users'), ...ENTITY_META],
    unique: [{ columns: ['provider', 'issuer', 'subject'], where: "status = 'ACTIVE'" }], lookup: ['subject', 'user_id'],
  },
  {
    name: 'UserRoles', group: 'Identity', kind: 'ENTITY', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'ACCOUNT_LIFETIME_PLUS_1Y',
    description_th: 'บทบาทพร้อมช่วงวันที่มีผล [effective_from, effective_to) — คนเดียวมีหลายบทบาทได้',
    columns: [id(), fk('user_id', 'Users', R), en('role', 'Role', R), date('effective_from', R), date('effective_to'), fk('granted_by', 'Users', R),
      ts('revoked_at'), fk('revoked_by', 'Users'), str('reason', 500), ...ENTITY_META],
    lookup: ['user_id'], checks: ['effective_to IS NULL OR effective_from < effective_to'],
  },
  {
    name: 'StaffAssignments', group: 'Identity', kind: 'ENTITY', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'ACADEMIC_YEAR_PLUS_2Y',
    description_th: 'ขอบเขตงานของบุคลากร: ครูที่ปรึกษา เวรประจำจุด สอน ผู้รักษาการแทน พร้อมช่วงเวลาที่มีผล',
    columns: [id(), fk('user_id', 'Users', R), en('assignment_type', 'AssignmentType', R), fk('class_id', 'Classes'), fk('station_id', 'Stations'),
      int('weekday', { min: 1, max: 7, description_th: 'วันในสัปดาห์สำหรับเวร (1=จันทร์); ว่าง = ทุกวัน' }), str('subject_code', 30),
      fk('delegate_for_user_id', 'Users', { description_th: 'สำหรับ DELEGATE: รักษาการแทนผู้ใด' }),
      date('effective_from', R), date('effective_to'), str('notes', 500), ...ENTITY_META],
    lookup: ['user_id', 'class_id', 'delegate_for_user_id'], checks: ['effective_to IS NULL OR effective_from < effective_to'],
  },
  {
    name: 'InvitationRecords', group: 'Identity', kind: 'ENTITY', partition: 'NONE', sensitivity: 'SECRET', retention: '1Y',
    description_th: 'คำเชิญเปิดใช้งาน ใช้ได้ครั้งเดียว มีอายุ เก็บเฉพาะ hash ของรหัส (ไม่ export)',
    columns: [id(), en('invitation_type', 'InvitationType', R), fk('target_user_id', 'Users', R),
      { name: 'code_hash', type: 'string', maxLength: 64, required: true, secret: true, description_th: 'SHA-256 ของรหัสคำเชิญ (รหัสจริงแสดงครั้งเดียว)' },
      str('bound_email', 254, { description_th: 'ถ้ากำหนด ต้องตรงกับอีเมลที่ provider ยืนยันแล้ว' }),
      ts('expires_at', R), int('max_attempts', { ...R, min: 1, max: 20 }), int('attempt_count', { ...R, min: 0 }), en('status', 'InvitationStatus', R),
      ts('redeemed_at'), fk('redeemed_identity_link_id', 'IdentityLinks', { deferrable: true, description_th: 'วงอ้างอิงกับ IdentityLinks.invitation_id → FK แบบ DEFERRABLE' }), ...ENTITY_META],
    lookup: ['target_user_id', 'code_hash'],
  },

  // ───────────────────────── Student ─────────────────────────
  {
    name: 'Stations', group: 'Attendance', kind: 'CONFIG', partition: 'NONE', sensitivity: 'PUBLIC', retention: 'PERMANENT',
    description_th: 'จุดลงเวลา/สถานี',
    columns: [id(), fk('school_id', 'Schools', R), str('code', 30, R), str('name_th', 200, R), en('station_type', 'StationType', R), en('status', 'RecordStatus', R), ...ENTITY_META],
    unique: [['school_id', 'code']],
  },
  {
    name: 'Students', group: 'Student', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'นักเรียน; student_code เป็น business key แบบ string (รักษาเลขศูนย์นำหน้า)',
    columns: [id(), fk('school_id', 'Schools', R), str('student_code', 20, { ...R, pattern: '^[0-9A-Za-z-]{1,20}$' }),
      str('prefix_th', 30), str('first_name_th', 100, R), str('last_name_th', 100, R), str('first_name_en', 100), str('last_name_en', 100), str('nickname', 50),
      en('gender', 'Gender'), date('birth_date', { sensitivity: 'SENSITIVE', description_th: 'ไม่บังคับ' }),
      { name: 'photo_file_id', type: 'uuid', description_th: 'Attachments.id รูปถ่าย (soft reference)' },
      en('status', 'StudentStatus', R), date('status_effective_date'),
      str('search_name', 300, { derived: true, description_th: 'ค่าค้นหาที่ normalize (ตัดช่องว่าง/ตัวพิมพ์เล็ก) สร้างใหม่ได้จากชื่อจริง ไม่ใช้แทนชื่อ' }),
      ...ENTITY_META],
    unique: [['school_id', 'student_code']], lookup: ['student_code'], indexes: [['search_name'], ['status']],
    accessPatterns: ['getById', 'findByCode (สแกนประตู)', 'search_name prefix (ค้นหาชื่อ)', 'list ตามห้องผ่าน Enrollments'],
  },
  {
    name: 'Classes', group: 'Student', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PUBLIC', retention: 'PERMANENT',
    description_th: 'ห้องเรียนรายปีการศึกษา',
    columns: [id(), fk('school_id', 'Schools', R), fk('academic_year_id', 'AcademicYears', R), en('grade_level', 'GradeLevel', R), str('room_no', 10, R),
      str('code', 20, { ...R, description_th: 'เช่น M1/1' }), str('name_th', 50, R), en('status', 'RecordStatus', R), ...ENTITY_META],
    unique: [['academic_year_id', 'code']], lookup: ['academic_year_id'],
  },
  {
    name: 'Enrollments', group: 'Student', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'ประวัติการอยู่ห้อง [effective_from, effective_to) ห้ามช่วงซ้อนกันต่อนักเรียน; ย้ายห้อง/เลื่อนชั้น/ย้ายออกปิดช่วงเดิมแล้วเปิดช่วงใหม่',
    columns: [id(), fk('student_id', 'Students', R), fk('class_id', 'Classes', R), fk('academic_year_id', 'AcademicYears', R),
      date('effective_from', R), date('effective_to'), en('end_reason', 'EnrollmentEndReason'), int('roll_no', { min: 1, max: 200 }), ...ENTITY_META],
    lookup: ['student_id', 'class_id'], checks: ['effective_to IS NULL OR effective_from < effective_to'],
    exclusion: { columns: ['student_id'], range: ['effective_from', 'effective_to'] },
  },
  {
    name: 'Guardians', group: 'Student', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'ผู้ปกครอง (หนึ่งคนดูแลนักเรียนได้หลายคน)',
    columns: [id(), fk('school_id', 'Schools', R), str('external_ref', 40, { pattern: '^[0-9A-Za-z_-]{1,40}$', description_th: 'รหัสผู้ปกครองที่โรงเรียนรับรอง (ใช้รวมข้อมูลพี่น้อง) — ห้ามรวมด้วยชื่อเหมือนกัน' }),
      str('prefix_th', 30), str('first_name_th', 100, R), str('last_name_th', 100, R),
      str('search_name', 300, { derived: true }), en('status', 'RecordStatus', R), ...ENTITY_META],
    unique: [['school_id', 'external_ref']], lookup: ['external_ref'], indexes: [['search_name']],
  },
  {
    name: 'StudentGuardians', group: 'Student', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'ความสัมพันธ์นักเรียน-ผู้ปกครองที่เจ้าหน้าที่ยืนยัน พร้อมสิทธิ์และช่วงเวลาที่มีผล',
    columns: [id(), fk('student_id', 'Students', R), fk('guardian_id', 'Guardians', R), en('relationship', 'Relationship', R), str('relationship_note', 200),
      bool('is_primary_contact', { ...R, default: false }), int('contact_priority', { ...R, min: 1, max: 9 }),
      json('permitted_actions', { ...R, items: { enum: 'GuardianPermission' }, description_th: 'รายการสิทธิ์ เช่น ["VIEW_ATTENDANCE","SUBMIT_LEAVE"]' }),
      json('notification_preferences', { ...R, description_th: 'เช่น {"LATE_CONFIRMED":true,"ABSENCE_CONFIRMED":true}' }),
      en('status', 'GuardianLinkStatus', R), fk('verified_by', 'Users'), ts('verified_at'), en('verification_method', 'VerificationMethod'),
      date('effective_from', R), date('effective_to'), ...ENTITY_META],
    unique: [['student_id', 'guardian_id', 'effective_from']], lookup: ['student_id', 'guardian_id'],
    checks: ['effective_to IS NULL OR effective_from < effective_to', "status <> 'ACTIVE' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)"],
  },
  {
    name: 'ContactEndpoints', group: 'Student', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'ช่องทางติดต่อ (เบอร์โทรเก็บเป็น string) การแก้ไขต้องยืนยันโดยเจ้าหน้าที่และมี audit',
    columns: [id(), en('owner_type', 'ContactOwnerType', R), { name: 'owner_id', type: 'uuid', required: true, description_th: 'Guardians.id / Users.id / Students.id ตาม owner_type (polymorphic)' },
      en('channel', 'ContactChannel', R), str('value', 254, R), str('label_th', 100), bool('is_primary', { ...R, default: false }),
      ts('verified_at'), fk('verified_by', 'Users'), en('status', 'RecordStatus', R), ...ENTITY_META],
    lookup: ['owner_id'],
  },

  // ───────────────────────── Attendance (partitioned by term) ─────────────────────────
  {
    name: 'AttendanceEvents', group: 'Attendance', kind: 'EVENT', partition: 'TERM', partitionColumn: 'school_date', workbook: 'OPS', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'เหตุการณ์ข้อเท็จจริงการมาเรียน (append-only) การแก้ไขใช้ supersedes_event_id; การเช็กชื่อเก็บเฉพาะรายการที่ไม่ใช่ "มา" ตามรายชื่อ',
    columns: [id(), fk('student_id', 'Students', R), date('school_date', R), en('event_type', 'AttendanceEventType', R),
      ts('occurred_at', { ...R, description_th: 'เวลาที่เกิดจริง เช่น เวลามาถึง' }), ts('recorded_at', { ...R, description_th: 'เวลาที่ server บันทึก' }),
      ts('captured_at', { description_th: 'เวลาเครื่องขณะบันทึกออฟไลน์ (อ้างโดยอุปกรณ์)' }), ts('synced_at'), en('source', 'AttendanceSource', R), bool('offline', { ...R, default: false }),
      fk('station_id', 'Stations'), fk('actor_id', 'Users', { ...R, description_th: 'ผู้บันทึกที่ server ยืนยันตัวตน' }),
      { name: 'claimed_actor_id', type: 'uuid', description_th: 'ผู้บันทึกที่อุปกรณ์อ้าง (offline) ไม่ใช่หลักฐานสิทธิ์' },
      str('reason_code', 40), str('reason_text', 500), fk('linked_leave_id', 'LeaveRequests'), fk('supersedes_event_id', 'AttendanceEvents'),
      fk('roll_call_session_id', 'RollCallSessions'), fk('class_id', 'Classes'),
      str('dedupe_key', 200, { description_th: 'กันบันทึกซ้ำ เช่น ARR|student|date' }), { name: 'operation_id', type: 'uuid', required: true }, ...EVENT_META],
    unique: [['dedupe_key']], lookup: ['student_id', 'dedupe_key'], indexes: [['student_id', 'school_date'], ['school_date', 'event_type']],
  },
  {
    name: 'DailyAttendance', group: 'Attendance', kind: 'PROJECTION', partition: 'TERM', partitionColumn: 'school_date', workbook: 'DAILY', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'สรุปรายวันต่อคน (projection สร้างใหม่ได้จาก AttendanceEvents, RollCallSessions, LeaveSegments, Enrollments, ปฏิทินและกฎ) id = UUIDv5(student_id|school_date)',
    columns: [id('UUIDv5 จาก student_id|school_date'), fk('student_id', 'Students', R), date('school_date', R), fk('class_id', 'Classes'),
      bool('school_day', R), bool('eligible', R), en('presence_status', 'PresenceStatus', R), en('verification_level', 'VerificationLevel', R),
      bool('is_late', R), int('late_minutes', { min: 0 }), bool('late_counted', R), bool('lateness_exempted', R),
      fk('arrival_event_id', 'AttendanceEvents'), ts('arrived_at'), en('roll_call_mark', 'RollCallMark', R), fk('roll_call_session_id', 'RollCallSessions'),
      bool('full_day_leave', R), bool('partial_leave', R), str('leave_units', 100, { description_th: 'เช่น AM, PM, P1,P2' }), json('leave_request_ids'),
      bool('confirmed_absence', R), bool('has_conflict', R), json('conflicts'), json('evidence_refs'),
      fk('calculated_rule_version_id', 'RuleVersions'), int('projection_version', { ...R, min: 1 }), ts('computed_at', R),
      fk('verified_by', 'Users'), ts('verified_at'), ...ENTITY_META],
    unique: [['student_id', 'school_date']], lookup: ['school_date', 'student_id'], indexes: [['school_date', 'class_id'], ['school_date', 'presence_status']],
  },
  {
    name: 'RollCallSessions', group: 'Attendance', kind: 'ENTITY', partition: 'TERM', partitionColumn: 'school_date', workbook: 'OPS', sensitivity: 'INTERNAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'การเช็กชื่อประจำวันรายห้อง (ผู้ยืนยันและแหล่งข้อมูล) id = UUIDv5(class_id|school_date); นักเรียนในรายชื่อที่ไม่มีเหตุการณ์ยกเว้น = มาตามการเช็กชื่อ',
    columns: [id('UUIDv5 จาก class_id|school_date'), fk('class_id', 'Classes', R), date('school_date', R), en('status', 'RollCallStatus', R),
      int('roster_count', { ...R, min: 0 }), str('roster_hash', 64, { ...R, description_th: 'SHA-256 ของรายชื่อ student_id ที่เช็ก (ตรวจว่ารายชื่อไม่เปลี่ยน)' }),
      int('absent_count', { min: 0 }), int('late_count', { min: 0 }), int('leave_reported_count', { min: 0 }),
      fk('submitted_by', 'Users'), ts('submitted_at'), fk('verified_by', 'Users'), ts('verified_at'), str('source', 20, R), ...ENTITY_META],
    unique: [['class_id', 'school_date']], lookup: ['school_date'],
  },
  {
    name: 'AttendanceCorrections', group: 'Attendance', kind: 'ENTITY', partition: 'TERM', partitionColumn: 'school_date', workbook: 'OPS', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'คำขอ/การแก้ไขข้อมูลการมาเรียนย้อนหลัง พร้อมเหตุผล ค่าเดิม/ใหม่ และผู้อนุมัติ',
    columns: [id(), fk('student_id', 'Students', R), date('school_date', R), fk('target_event_id', 'AttendanceEvents'), en('correction_type', 'CorrectionType', R),
      fk('requested_by', 'Users', R), ts('requested_at', R), str('reason', 1000, R), json('requested_change', R), en('status', 'CorrectionStatus', R),
      fk('decided_by', 'Users'), ts('decided_at'), str('decision_note', 1000), fk('resulting_event_id', 'AttendanceEvents'),
      json('before_json'), json('after_json'), ...ENTITY_META],
    lookup: ['student_id'],
  },
  {
    name: 'ReconciliationTasks', group: 'Attendance', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'TERM_PLUS_1Y',
    description_th: 'งานตรวจสอบเมื่อข้อมูลขัดกันหรือยังไม่ทราบสถานะ (ระบบไม่ตัดสินเอง)',
    columns: [id(), en('task_type', 'ReconciliationTaskType', R), fk('student_id', 'Students'), fk('class_id', 'Classes'), date('school_date'),
      json('evidence_refs', R), str('description_th', 1000, R), fk('assigned_to', 'Users'), en('assigned_role', 'Role'), ts('due_at'),
      en('status', 'TaskStatus', R), str('resolution_note', 1000), fk('resolved_by', 'Users'), ts('resolved_at'), str('dedupe_key', 200, R), ...ENTITY_META],
    unique: [['dedupe_key']], lookup: ['dedupe_key', 'assigned_to', 'class_id'],
  },

  // ───────────────────────── Leave ─────────────────────────
  {
    name: 'LeaveRequests', group: 'Leave', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'ใบลา: สถานะรวม + สถานะผู้ปกครองยืนยัน + สถานะโรงเรียนอนุมัติ แยกกัน; ช่วงวันที่ [start_date, end_date)',
    columns: [id(), fk('student_id', 'Students', R), fk('requester_user_id', 'Users', R), en('requester_type', 'RequesterType', R),
      en('leave_type', 'LeaveType', R), date('start_date', R), date('end_date', { ...R, description_th: 'exclusive' }), str('reason', 1000, R),
      en('status', 'LeaveStatus', R), en('guardian_confirmation_status', 'GuardianConfirmation', R), en('school_approval_status', 'SchoolApproval', R),
      fk('route_rule_version_id', 'RuleVersions'), en('current_approver_role', 'Role'), fk('current_approver_user_id', 'Users'),
      bool('is_retroactive', R), str('retroactive_reason', 1000), int('school_days_count', { ...R, min: 0, description_th: 'จำนวนวันเรียนที่เกี่ยวข้อง (นับวัน)' }),
      int('full_day_count', { ...R, min: 0 }), int('half_day_count', { ...R, min: 0 }), int('period_count', { ...R, min: 0, description_th: 'หน่วยคาบ แยกจากหน่วยวัน' }),
      int('revision_no', { ...R, min: 1 }), ts('submitted_at'), ts('decided_at'), ts('cancelled_at'), bool('attachment_required', R), ...ENTITY_META],
    lookup: ['student_id', 'current_approver_user_id'], indexes: [['status'], ['student_id', 'start_date']], checks: ['start_date < end_date'],
  },
  {
    name: 'LeaveSegments', group: 'Leave', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'ช่วงลารายวันเรียน (อนุมัติแยกช่วงได้) หน่วยวัน/ครึ่งวัน/คาบไม่บวกปนกัน',
    columns: [id(), fk('leave_request_id', 'LeaveRequests', R), fk('student_id', 'Students', R), date('school_date', R), en('unit', 'LeaveUnit', R),
      json('periods', { description_th: 'รายการคาบเมื่อ unit = PERIODS เช่น [1,2]' }), en('status', 'SegmentStatus', R), fk('decision_id', 'LeaveApprovals'),
      en('usage_status', 'SegmentUsage', R), ...ENTITY_META],
    lookup: ['leave_request_id', 'student_id'], indexes: [['student_id', 'school_date']],
  },
  {
    name: 'LeaveRevisions', group: 'Leave', kind: 'EVENT', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'ประวัติทุกการเปลี่ยนแปลงใบลา (append-only ห้ามเขียนทับเหตุผล/ผู้อนุมัติเดิม)',
    columns: [id(), fk('leave_request_id', 'LeaveRequests', R), int('revision_no', { ...R, min: 1 }), en('action', 'LeaveAction', R), fk('actor_id', 'Users', R),
      ts('acted_at', R), en('from_status', 'LeaveStatus'), en('to_status', 'LeaveStatus', R), json('snapshot_json', R), str('comment', 1000),
      { name: 'operation_id', type: 'uuid', required: true }, ...EVENT_META],
    lookup: ['leave_request_id'],
  },
  {
    name: 'LeaveApprovals', group: 'Leave', kind: 'EVENT', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'การตัดสินแต่ละขั้น (ผู้ปกครองยืนยัน / โรงเรียนอนุมัติ / พิจารณายกเลิก) append-only',
    columns: [id(), fk('leave_request_id', 'LeaveRequests', R), int('step_no', { ...R, min: 1 }), en('step_type', 'ApprovalStepType', R), en('decision', 'ApprovalDecision', R),
      fk('decided_by', 'Users', R), ts('decided_at', R), fk('acting_for_user_id', 'Users', { description_th: 'กรณีผู้รักษาการแทน' }), en('approver_role', 'Role'),
      str('comment', 1000), json('segment_decisions_json'), int('revision_no', { ...R, min: 1 }), { name: 'operation_id', type: 'uuid', required: true }, ...EVENT_META],
    lookup: ['leave_request_id'],
  },

  // ───────────────────────── Follow-up ─────────────────────────
  {
    name: 'Cases', group: 'Follow-up', kind: 'ENTITY', partition: 'NONE', sensitivity: 'SENSITIVE', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'เรื่องติดตาม/ดูแลช่วยเหลือ มีผู้รับผิดชอบ กำหนดเวลา และการ dedupe',
    columns: [id(), fk('student_id', 'Students', R), en('case_type', 'CaseType', R), fk('rule_version_id', 'RuleVersions'), str('trigger_summary_th', 1000, R),
      json('trigger_evidence_json', R), str('dedupe_key', 200), en('status', 'CaseStatus', R), en('priority', 'Priority', R), fk('owner_user_id', 'Users'),
      ts('due_at'), str('next_action_th', 500), ts('next_appointment_at'), str('resolution_summary', 2000), ts('closed_at'), fk('closed_by', 'Users'),
      int('reopened_count', { ...R, min: 0 }), ts('cooldown_until'), ...ENTITY_META],
    unique: [{ columns: ['dedupe_key'], where: "status NOT IN ('CLOSED')" }], lookup: ['student_id', 'owner_user_id', 'dedupe_key'], indexes: [['status', 'due_at']],
  },
  {
    name: 'CaseEvents', group: 'Follow-up', kind: 'EVENT', partition: 'NONE', sensitivity: 'SENSITIVE', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'ประวัติเรื่องติดตาม (append-only)',
    columns: [id(), fk('case_id', 'Cases', R), en('event_type', 'CaseEventType', R), fk('actor_id', 'Users', R), ts('occurred_at', R), json('data_json'), str('note', 2000),
      { name: 'operation_id', type: 'uuid', required: true }, ...EVENT_META],
    lookup: ['case_id'],
  },
  {
    name: 'ContactLogs', group: 'Follow-up', kind: 'EVENT', partition: 'NONE', sensitivity: 'SENSITIVE', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'บันทึกการติดต่อ (การกดปุ่มโทรไม่ถือว่าโทรสำเร็จจนบันทึกผล)',
    columns: [id(), fk('student_id', 'Students', R), fk('case_id', 'Cases'), fk('guardian_id', 'Guardians'), en('channel', 'ContactChannel', R), en('direction', 'ContactDirection', R),
      ts('contacted_at', R), fk('contacted_by', 'Users', R), en('outcome', 'ContactOutcome', R), str('summary', 2000), bool('follow_up_required', R), ts('next_follow_up_at'),
      fk('supersedes_id', 'ContactLogs'), { name: 'operation_id', type: 'uuid', required: true }, ...EVENT_META],
    lookup: ['student_id', 'case_id'],
  },
  {
    name: 'Appointments', group: 'Follow-up', kind: 'ENTITY', partition: 'NONE', sensitivity: 'SENSITIVE', retention: 'ENROLLMENT_PLUS_5Y',
    description_th: 'นัดหมาย',
    columns: [id(), fk('case_id', 'Cases'), fk('student_id', 'Students', R), ts('scheduled_at', R), int('duration_minutes', { min: 5, max: 600 }), str('location', 200),
      str('attendees_note', 500), en('status', 'AppointmentStatus', R), str('outcome_note', 2000), ...ENTITY_META],
    lookup: ['case_id', 'student_id'],
  },

  // ───────────────────────── Files ─────────────────────────
  {
    name: 'Attachments', group: 'Files', kind: 'ENTITY', partition: 'NONE', sensitivity: 'SENSITIVE', retention: 'BY_CLASSIFICATION',
    description_th: 'ไฟล์แนบเชิงตรรกะ (logical_file_id = id) ไม่ผูกกับ Drive URL; provider object อยู่ใน StorageObjectMappings',
    columns: [id('logical file ID'), fk('school_id', 'Schools', R), str('original_filename', 255, R), str('mime_type', 100, R), int('size_bytes', { ...R, min: 0 }),
      str('sha256', 64, { ...R, pattern: '^[0-9a-f]{64}$' }), en('classification', 'FileClassification', R), en('status', 'FileStatus', R),
      fk('uploaded_by', 'Users', R), ts('uploaded_at', R), ts('linked_at'), ts('deleted_at'), fk('deleted_by', 'Users'), date('retention_until'), ...ENTITY_META],
    indexes: [['status', 'uploaded_at']],
  },
  {
    name: 'AttachmentLinks', group: 'Files', kind: 'ENTITY', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'BY_CLASSIFICATION',
    description_th: 'ความสัมพันธ์ไฟล์ ↔ entity',
    columns: [id(), fk('attachment_id', 'Attachments', R), en('entity_type', 'EntityType', R), { name: 'entity_id', type: 'uuid', required: true, description_th: 'polymorphic reference ตาม entity_type' },
      str('purpose', 50, R), fk('linked_by', 'Users', R), ts('linked_at', R), ts('unlinked_at'), ...ENTITY_META],
    lookup: ['attachment_id', 'entity_id'],
  },
  {
    name: 'StorageObjectMappings', group: 'Files', kind: 'ENTITY', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'BY_CLASSIFICATION',
    description_th: 'logical file ID → provider object (Drive file ID / path) เปลี่ยนเมื่อย้ายที่เก็บ',
    columns: [id(), fk('attachment_id', 'Attachments', R), en('provider', 'StorageProvider', R), str('object_key', 500, R), str('container', 300),
      en('status', 'StorageStatus', R), ts('sha256_verified_at'), ...ENTITY_META],
    unique: [['provider', 'object_key']], lookup: ['attachment_id'],
  },

  // ───────────────────────── Notifications ─────────────────────────
  {
    name: 'Notifications', group: 'Notifications', kind: 'EVENT', partition: 'TERM', partitionColumn: 'created_at', workbook: 'NOTIFY', sensitivity: 'PERSONAL', retention: 'TERM_PLUS_1Y',
    description_th: 'การแจ้งเตือนที่สร้างจากเหตุการณ์ที่ commit แล้ว (เนื้อหาขั้นต่ำ + template version)',
    columns: [id(), en('notification_type', 'NotificationType', R), str('source_entity_type', 40, R), { name: 'source_entity_id', type: 'uuid', required: true },
      { name: 'source_operation_id', type: 'uuid', required: true }, fk('student_id', 'Students'), str('template_key', 60, R), int('template_version', { ...R, min: 1 }),
      json('params_json', R), en('urgency', 'Urgency', R), str('audience_scope', 40, R), bool('suppressed', R), str('suppress_reason', 200), ...EVENT_META],
    lookup: ['source_entity_id'],
  },
  {
    name: 'NotificationRecipients', group: 'Notifications', kind: 'ENTITY', partition: 'TERM', partitionColumn: 'created_at', workbook: 'NOTIFY', sensitivity: 'PERSONAL', retention: 'TERM_PLUS_1Y',
    description_th: 'ผู้รับ (resolve จากความสัมพันธ์ที่ยืนยันแล้ว) = กล่องแจ้งเตือนในแอป และสถานะการรับทราบ',
    columns: [id(), fk('notification_id', 'Notifications', R), fk('recipient_user_id', 'Users', R), en('recipient_role_context', 'Role', R),
      en('in_app_state', 'InAppState', R), ts('read_at'), bool('ack_required', R), en('ack_state', 'AckState', R), ts('ack_due_at'), ...ENTITY_META],
    unique: [['notification_id', 'recipient_user_id']], lookup: ['recipient_user_id', 'notification_id'],
  },
  {
    name: 'NotificationOutbox', group: 'Notifications', kind: 'ENTITY', partition: 'TERM', partitionColumn: 'created_at', workbook: 'NOTIFY', sensitivity: 'PERSONAL', retention: 'TERM_PLUS_1Y',
    description_th: 'คิวส่งภายนอก (email/LINE/SMS) แยก delivery state ออกจากการรับทราบ; dedupe_key กันส่งซ้ำ',
    columns: [id('UUIDv5 จาก dedupe_key'), fk('notification_id', 'Notifications', R), fk('recipient_id', 'NotificationRecipients', R), fk('recipient_user_id', 'Users', R),
      en('channel', 'Channel', R), str('dedupe_key', 300, R), en('delivery_state', 'DeliveryState', R), int('attempts', { ...R, min: 0 }), int('max_attempts', { ...R, min: 1 }),
      ts('next_attempt_at'), ts('lease_until'), str('lease_owner', 100), { name: 'retry_key', type: 'uuid', description_th: 'X-Line-Retry-Key ใช้ค่าเดิมตลอดการ retry ของการส่งเดียวกัน' },
      ts('retry_key_created_at'), str('provider_request_id', 200), str('provider_message_id', 200), str('last_error_code', 60), str('last_error_message', 500),
      ts('accepted_at'), fk('resend_of_outbox_id', 'NotificationOutbox'), str('held_reason', 60), bool('replay_blocked', { ...R, default: false, description_th: 'TRUE สำหรับรายการจากการย้ายข้อมูล ห้ามส่งย้อนหลังอัตโนมัติ' }), ...ENTITY_META],
    unique: [['dedupe_key']], lookup: ['dedupe_key', 'notification_id'], indexes: [['delivery_state', 'next_attempt_at']],
  },
  {
    name: 'NotificationAttempts', group: 'Notifications', kind: 'EVENT', partition: 'TERM', partitionColumn: 'started_at', workbook: 'NOTIFY', sensitivity: 'INTERNAL', retention: 'TERM_PLUS_1Y',
    description_th: 'ผลการเรียกผู้ให้บริการแต่ละครั้ง (append-only)',
    columns: [id(), fk('outbox_id', 'NotificationOutbox', R), int('attempt_no', { ...R, min: 1 }), ts('started_at', R), ts('finished_at'), en('result', 'AttemptResult', R),
      int('http_status'), str('provider_request_id', 200), str('error_code', 60), str('error_message', 500), { name: 'retry_key', type: 'uuid' }, ...EVENT_META],
    lookup: ['outbox_id'],
  },
  {
    name: 'Acknowledgements', group: 'Notifications', kind: 'EVENT', partition: 'TERM', partitionColumn: 'acted_at', workbook: 'NOTIFY', sensitivity: 'PERSONAL', retention: 'TERM_PLUS_1Y',
    description_th: 'การกดรับทราบ/ขอให้ติดต่อกลับจริงของผู้รับ (ผูก identity และ notification)',
    columns: [id(), fk('recipient_id', 'NotificationRecipients', R), fk('notification_id', 'Notifications', R), fk('user_id', 'Users', R), en('action', 'AckAction', R),
      en('channel', 'AckChannel', R), ts('acted_at', R), str('note', 1000), fk('case_id', 'Cases'), { name: 'operation_id', type: 'uuid', required: true }, ...EVENT_META],
    unique: [['recipient_id', 'action']], lookup: ['recipient_id'],
  },
  {
    name: 'ChannelBindings', group: 'Notifications', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: 'ACCOUNT_LIFETIME_PLUS_1Y',
    description_th: 'การผูกช่องทาง LINE/อีเมลกับบัญชีแอป (แยกจากการยืนยันความสัมพันธ์ผู้ปกครอง-นักเรียน)',
    columns: [id(), fk('user_id', 'Users', R), en('channel', 'Channel', R), str('address', 254, { description_th: 'LINE userId / อีเมล (ว่างระหว่าง PENDING)' }),
      en('status', 'BindingStatus', R), { name: 'link_nonce_hash', type: 'string', maxLength: 64, secret: true, description_th: 'SHA-256 ของ nonce สำหรับ LINE account link' },
      ts('link_expires_at'), ts('verified_at'), en('verified_via', 'BindingVerifiedVia'), ts('revoked_at'), fk('revoked_by', 'Users'), str('revoke_reason', 300), ...ENTITY_META],
    unique: [{ columns: ['channel', 'address'], where: "status = 'ACTIVE'" }], lookup: ['user_id', 'address', 'link_nonce_hash'],
  },
  {
    name: 'WebhookInbox', group: 'Notifications', kind: 'ENTITY', partition: 'TERM', partitionColumn: 'received_at', workbook: 'NOTIFY', sensitivity: 'PERSONAL', retention: '90D',
    description_th: 'เหตุการณ์ webhook ที่ผ่านการตรวจลายเซ็นจาก gateway แล้ว บันทึกถาวรก่อนตอบรับ (dedupe ด้วย webhook_event_id)',
    columns: [id(), str('source', 20, R), str('webhook_event_id', 100, R), ts('received_at', R), ts('envelope_ts', R), str('event_type', 40, R), json('payload_json', R),
      en('status', 'WebhookStatus', R), ts('processed_at'), int('attempts', { ...R, min: 0 }), str('last_error', 500), ...ENTITY_META],
    unique: [['source', 'webhook_event_id']], lookup: ['webhook_event_id'], indexes: [['status']],
  },

  // ───────────────────────── Operations ─────────────────────────
  {
    name: 'MutationJournal', group: 'Operations', kind: 'OPERATIONAL', partition: 'TERM', partitionColumn: 'prepared_at', workbook: 'OPS', sensitivity: 'SENSITIVE', retention: '30D_AFTER_COMMIT',
    description_th: 'redo journal ของ Sheets adapter: PREPARED → COMMITTED; recovery ทำซ้ำได้อย่างปลอดภัย (ไม่ export ข้อมูลในเซลล์ writes_json เกินจำเป็น)',
    columns: [id(), { name: 'operation_id', type: 'uuid', required: true }, str('operation', 80, R), fk('actor_id', 'Users', R), { name: 'request_id', type: 'uuid' },
      en('status', 'JournalStatus', R), int('part_no', { ...R, min: 1 }), int('part_count', { ...R, min: 1 }), { name: 'writes_json', type: 'text', maxLength: 45000, required: true },
      ts('prepared_at', R), ts('committed_at'), ts('recovered_at'), int('recovery_attempts', { ...R, min: 0 }), str('last_error', 500), ...ENTITY_META],
    unique: [['operation_id', 'part_no']], lookup: ['operation_id'], indexes: [['status']],
  },
  {
    name: 'IdempotencyRecords', group: 'Operations', kind: 'OPERATIONAL', partition: 'TERM', partitionColumn: 'created_at', workbook: 'OPS', sensitivity: 'INTERNAL', retention: '30D',
    description_th: 'ผลของคำสั่งตาม (actor, operation, idempotency_key) เพื่อคืนผลเดิมเมื่อส่งซ้ำ',
    columns: [id('UUIDv5 จาก scope_key'), str('scope_key', 64, R), fk('actor_id', 'Users', R), str('operation', 80, R), str('idempotency_key', 100, R),
      str('request_hash', 64, R), json('result_json', R), { name: 'operation_id', type: 'uuid', required: true }, ts('expires_at', R), ...EVENT_META],
    unique: [['scope_key']], lookup: ['scope_key'],
  },
  {
    name: 'AuditEvents', group: 'Operations', kind: 'EVENT', partition: 'TERM', partitionColumn: 'occurred_at', workbook: 'OPS', sensitivity: 'SENSITIVE', retention: 'AUDIT_5Y',
    description_th: 'Audit (append-only) ใคร ทำอะไร เมื่อใด เหตุผล ค่าเดิม/ใหม่ (ปิดบังฟิลด์อ่อนไหว) — ไม่ tamper-proof เมื่อผู้แก้ไข Sheet ยังแก้ได้',
    columns: [id(), ts('occurred_at', R), fk('actor_id', 'Users', R), str('actor_roles', 200), str('action', 80, R), str('entity_type', 40), { name: 'entity_id', type: 'uuid' },
      fk('student_id', 'Students'), { name: 'operation_id', type: 'uuid' }, { name: 'request_id', type: 'uuid' }, en('channel', 'AuditChannel', R), str('reason', 1000),
      json('before_json'), json('after_json'), ...EVENT_META],
    lookup: ['entity_id', 'actor_id', 'student_id'],
  },
  {
    name: 'Jobs', group: 'Operations', kind: 'OPERATIONAL', partition: 'NONE', sensitivity: 'INTERNAL', retention: '90D',
    description_th: 'งานเบื้องหลังถาวร: lease, cursor/checkpoint, retry (ไม่ใช้ CacheService)',
    columns: [id(), str('job_type', 60, R), en('status', 'JobStatus', R), int('priority', { ...R, min: 0, max: 9 }), json('payload_json', R), json('progress_json'),
      json('cursor_json'), int('attempts', { ...R, min: 0 }), int('max_attempts', { ...R, min: 1 }), ts('next_run_at', R), ts('lease_until'), str('lease_owner', 100), ts('heartbeat_at'),
      str('last_error', 1000), fk('owner_user_id', 'Users', R), ts('started_at'), ts('finished_at'), json('result_json'), str('dedupe_key', 200), ...ENTITY_META],
    unique: [{ columns: ['dedupe_key'], where: "status IN ('QUEUED','RUNNING','PAUSED')" }], lookup: ['dedupe_key', 'owner_user_id'], indexes: [['status', 'next_run_at']],
  },
  {
    name: 'ImportBatches', group: 'Operations', kind: 'ENTITY', partition: 'NONE', sensitivity: 'PERSONAL', retention: '1Y',
    description_th: 'ชุดนำเข้า CSV/XLSX พร้อม mapping, dry-run และผลลัพธ์',
    columns: [id(), en('import_type', 'ImportType', R), fk('source_attachment_id', 'Attachments'), en('source_format', 'SourceFormat', R), json('mapping_json'),
      en('status', 'ImportStatus', R), json('dry_run_summary_json'), int('row_count', { min: 0 }), int('valid_count', { min: 0 }), int('error_count', { min: 0 }),
      int('applied_count', { min: 0 }), fk('job_id', 'Jobs'), ...ENTITY_META],
  },
  {
    name: 'ImportErrors', group: 'Operations', kind: 'EVENT', partition: 'NONE', sensitivity: 'PERSONAL', retention: '1Y',
    description_th: 'ข้อผิดพลาดรายแถวของการนำเข้า',
    columns: [id(), fk('import_batch_id', 'ImportBatches', R), int('attempt_no', { ...R, min: 1, description_th: 'ครั้งที่ตรวจ (dry-run) ของชุดนำเข้า' }), int('row_no', { ...R, min: 1 }), str('column_name', 100), str('error_code', 60, R), str('message_th', 500, R),
      str('raw_value_redacted', 200), ...EVENT_META],
    lookup: ['import_batch_id'],
  },
  {
    name: 'MigrationRuns', group: 'Operations', kind: 'ENTITY', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'PERMANENT',
    description_th: 'งานส่งออก/นำเข้า/กระทบยอด/สลับระบบ พร้อม state machine',
    columns: [id(), en('run_type', 'MigrationRunType', R), en('mode', 'MigrationMode', R), en('state', 'MigrationState', R), { name: 'snapshot_id', type: 'uuid' },
      str('package_location', 300), str('manifest_sha256', 64), en('completeness', 'Completeness'), json('scope_json'), json('high_water_marks_json'),
      fk('started_by', 'Users', R), ts('started_at', R), ts('finished_at'), json('summary_json'), fk('job_id', 'Jobs'), ...ENTITY_META],
  },
  {
    name: 'MigrationCheckpoints', group: 'Operations', kind: 'ENTITY', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'PERMANENT',
    description_th: 'checkpoint ราย table/partition/chunk สำหรับ resume',
    columns: [id(), fk('migration_run_id', 'MigrationRuns', R), str('step', 40, R), str('table_name', 60), str('partition_key', 30), json('cursor_json'),
      int('rows_done', { ...R, min: 0 }), int('chunk_no', { min: 0 }), str('chunk_sha256', 64), en('status', 'RunStatus', R), ...ENTITY_META],
    lookup: ['migration_run_id'],
  },
  {
    name: 'BackupRuns', group: 'Operations', kind: 'ENTITY', partition: 'NONE', sensitivity: 'INTERNAL', retention: 'PERMANENT',
    description_th: 'ประวัติการสำรองข้อมูลและผลทดสอบ restore',
    columns: [id(), en('backup_type', 'BackupType', R), en('status', 'RunStatus', R), ts('started_at', R), ts('finished_at'), str('package_location', 300), str('manifest_sha256', 64),
      json('row_counts_json'), date('retention_until'), ts('restore_tested_at'), str('restore_result', 1000), fk('migration_run_id', 'MigrationRuns'), fk('job_id', 'Jobs'), ...ENTITY_META],
  },
  {
    name: 'ChangeLog', group: 'Operations', kind: 'EVENT', partition: 'TERM', partitionColumn: 'committed_at', workbook: 'OPS', sensitivity: 'INTERNAL', retention: '1Y',
    description_th: 'ลำดับการเปลี่ยนแปลงต่อ operation (insert/update/tombstone) สำหรับ incremental export/delta; seq เพิ่มขึ้นเสมอ',
    columns: [id(), int('seq', { ...R, min: 1 }), { name: 'operation_id', type: 'uuid', required: true }, str('operation', 80, R), ts('committed_at', R),
      json('changes_json', { ...R, description_th: '[{table, id, op: INSERT|UPDATE|TOMBSTONE, version}]' }), fk('actor_id', 'Users', R), ...EVENT_META],
    unique: [['seq']], lookup: ['operation_id'],
  },
  {
    name: 'ReportRuns', group: 'Operations', kind: 'ENTITY', partition: 'NONE', sensitivity: 'INTERNAL', retention: '2Y',
    description_th: 'การออกรายงาน: filter, as_of, schema/rule version, ผู้สร้าง, การล็อกรอบ และ revision',
    columns: [id(), en('report_code', 'ReportCode', R), json('filter_json', R), ts('as_of', R), int('schema_version', { ...R, min: 1 }), json('rule_versions_json'),
      en('status', 'ReportStatus', R), en('output_format', 'OutputFormat', R), fk('output_attachment_id', 'Attachments'), int('row_count', { min: 0 }), json('totals_json'),
      bool('locked', R), fk('locked_by', 'Users'), ts('locked_at'), fk('supersedes_run_id', 'ReportRuns'), fk('superseded_by_run_id', 'ReportRuns'),
      fk('requested_by', 'Users', R), fk('job_id', 'Jobs'), ...ENTITY_META],
    indexes: [['report_code', 'as_of']],
  },
  {
    name: 'OperationMetrics', group: 'Operations', kind: 'EVENT', partition: 'TERM', partitionColumn: 'bucket_start', workbook: 'OPS', sensitivity: 'INTERNAL', retention: '1Y',
    description_th: 'สถิติเวลา p50/p95 ต่อ operation ต่อช่วงเวลา (สำหรับ pilot และเกณฑ์ย้ายระบบ)',
    columns: [id(), ts('bucket_start', R), str('operation', 80, R), int('count', { ...R, min: 0 }), int('error_count', { ...R, min: 0 }),
      int('p50_ms', { min: 0 }), int('p95_ms', { min: 0 }), int('max_ms', { min: 0 }), int('lock_wait_p95_ms', { min: 0 }), ...EVENT_META],
  },
];

/** Optional modules (feature flags OFF). Not created by setup; listed for planning (MASTER_PROMPT §8.2). */
export const OPTIONAL_MODULES = [
  { flag: 'feature.subject_attendance', tables: ['Subjects', 'TeachingAssignments', 'SubjectAttendance'], needs_th: 'รายวิชา ตารางเรียน roster รายคาบ และกฎสายเข้าคาบ (PERIOD_LATENESS)' },
  { flag: 'feature.campus_pass', tables: ['CampusPasses', 'CampusPassEvents'], needs_th: 'ผู้อนุมัติ ผู้รับนักเรียน จุดตรวจ เวลาออก/กลับ และ gate confirmation' },
  { flag: 'feature.behavior_points', tables: ['BehaviorPolicies', 'BehaviorPointEvents'], needs_th: 'ระเบียบโรงเรียนที่อนุมัติแล้ว ห้ามตัดคะแนนอัตโนมัติจากจำนวนสาย' },
];

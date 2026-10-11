-- CWK Smart Care — PostgreSQL schema (generated from src/schema/tables.js; DO NOT EDIT BY HAND)
-- schema_version: 1; target: PostgreSQL 16
-- Conventions: UUID primary keys, DATE school dates, TIMESTAMPTZ UTC instants, jsonb metadata,
-- enum values as CHECK constraints, append-only event tables protected by trigger.

BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS staging;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only guard: UPDATE/DELETE on event tables is rejected unless a purge procedure sets cwk.allow_purge.
CREATE OR REPLACE FUNCTION cwk_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('cwk.allow_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'table % is append-only (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';
END $$;

-- Schools: ข้อมูลโรงเรียน (ระยะแรก single-school แต่เก็บ school_id เพื่อจัดขอบเขต)
CREATE TABLE schools (
  id uuid NOT NULL PRIMARY KEY,
  code text NOT NULL,
  name_th text NOT NULL,
  name_en text,
  unit_th text,
  timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  locale text NOT NULL DEFAULT 'th-TH',
  logo_file_id uuid,
  brand_color text DEFAULT '#B91C1C',
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT schools_ck1 CHECK (char_length(code) <= 30),
  CONSTRAINT schools_ck2 CHECK (code <> ''),
  CONSTRAINT schools_ck3 CHECK (char_length(name_th) <= 200),
  CONSTRAINT schools_ck4 CHECK (name_th <> ''),
  CONSTRAINT schools_ck5 CHECK (char_length(name_en) <= 200),
  CONSTRAINT schools_ck6 CHECK (name_en <> ''),
  CONSTRAINT schools_ck7 CHECK (char_length(unit_th) <= 200),
  CONSTRAINT schools_ck8 CHECK (unit_th <> ''),
  CONSTRAINT schools_ck9 CHECK (char_length(timezone) <= 40),
  CONSTRAINT schools_ck10 CHECK (timezone <> ''),
  CONSTRAINT schools_ck11 CHECK (char_length(locale) <= 10),
  CONSTRAINT schools_ck12 CHECK (locale <> ''),
  CONSTRAINT schools_ck13 CHECK (char_length(brand_color) <= 7),
  CONSTRAINT schools_ck14 CHECK (brand_color <> ''),
  CONSTRAINT schools_ck15 CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT schools_ck16 CHECK (version >= 1)
);
CREATE UNIQUE INDEX schools_uq1 ON schools (code);

-- AcademicYears: ปีการศึกษา ช่วง [start_date, end_date)
CREATE TABLE academic_years (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  start_year_ce integer NOT NULL,
  label_th text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT academic_years_ck1 CHECK (start_year_ce >= 2000),
  CONSTRAINT academic_years_ck2 CHECK (start_year_ce <= 2200),
  CONSTRAINT academic_years_ck3 CHECK (char_length(label_th) <= 100),
  CONSTRAINT academic_years_ck4 CHECK (label_th <> ''),
  CONSTRAINT academic_years_ck5 CHECK (status IN ('PLANNED', 'ACTIVE', 'CLOSED')),
  CONSTRAINT academic_years_ck6 CHECK (version >= 1),
  CONSTRAINT academic_years_ck7 CHECK (start_date < end_date)
);
CREATE UNIQUE INDEX academic_years_uq1 ON academic_years (school_id, start_year_ce);
CREATE INDEX academic_years_ix1 ON academic_years (school_id);

-- Terms: ภาคเรียน และ partition key ของข้อมูลปฏิบัติการ
CREATE TABLE terms (
  id uuid NOT NULL PRIMARY KEY,
  academic_year_id uuid NOT NULL,
  term_no integer NOT NULL,
  code text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT terms_ck1 CHECK (term_no >= 1),
  CONSTRAINT terms_ck2 CHECK (term_no <= 3),
  CONSTRAINT terms_ck3 CHECK (char_length(code) <= 20),
  CONSTRAINT terms_ck4 CHECK (code <> ''),
  CONSTRAINT terms_ck5 CHECK (code ~ '^AY\d{4}-T[1-3]$'),
  CONSTRAINT terms_ck6 CHECK (status IN ('PLANNED', 'ACTIVE', 'CLOSED')),
  CONSTRAINT terms_ck7 CHECK (version >= 1),
  CONSTRAINT terms_ck8 CHECK (start_date < end_date)
);
CREATE UNIQUE INDEX terms_uq1 ON terms (code);
CREATE UNIQUE INDEX terms_uq2 ON terms (academic_year_id, term_no);
CREATE INDEX terms_ix1 ON terms (academic_year_id);

-- SchoolCalendar: ข้อยกเว้นปฏิทิน (ค่าเริ่มต้น: จันทร์–ศุกร์ในภาคเรียนเป็นวันเรียน) ใช้ applies_to_level ว่าง = ทุกระดับ
CREATE TABLE school_calendar (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  calendar_date date NOT NULL,
  day_type text NOT NULL,
  applies_to_level text,
  title_th text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT school_calendar_ck1 CHECK (day_type IN ('SCHOOL_DAY', 'HOLIDAY', 'NO_SCHOOL', 'EXAM_DAY', 'ACTIVITY_DAY')),
  CONSTRAINT school_calendar_ck2 CHECK (applies_to_level IN ('M1', 'M2', 'M3', 'M4', 'M5', 'M6')),
  CONSTRAINT school_calendar_ck3 CHECK (char_length(title_th) <= 200),
  CONSTRAINT school_calendar_ck4 CHECK (title_th <> ''),
  CONSTRAINT school_calendar_ck5 CHECK (version >= 1)
);
CREATE UNIQUE INDEX school_calendar_uq1 ON school_calendar (school_id, calendar_date, applies_to_level) NULLS NOT DISTINCT;
CREATE INDEX school_calendar_ix1 ON school_calendar (calendar_date);
CREATE INDEX school_calendar_ix2 ON school_calendar (school_id);

-- Periods: คาบเรียนพร้อมวันที่มีผล
CREATE TABLE periods (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  period_no integer NOT NULL,
  label_th text NOT NULL,
  session text NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  applies_to_level text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT periods_ck1 CHECK (period_no >= 0),
  CONSTRAINT periods_ck2 CHECK (period_no <= 20),
  CONSTRAINT periods_ck3 CHECK (char_length(label_th) <= 50),
  CONSTRAINT periods_ck4 CHECK (label_th <> ''),
  CONSTRAINT periods_ck5 CHECK (session IN ('AM', 'PM')),
  CONSTRAINT periods_ck6 CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT periods_ck7 CHECK (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT periods_ck8 CHECK (applies_to_level IN ('M1', 'M2', 'M3', 'M4', 'M5', 'M6')),
  CONSTRAINT periods_ck9 CHECK (version >= 1),
  CONSTRAINT periods_ck10 CHECK (start_time < end_time),
  CONSTRAINT periods_ck11 CHECK (effective_to IS NULL OR effective_from < effective_to)
);
CREATE UNIQUE INDEX periods_uq1 ON periods (school_id, period_no, effective_from, applies_to_level) NULLS NOT DISTINCT;
CREATE INDEX periods_ix1 ON periods (school_id);

-- Settings: Business settings ที่ไม่ลับ (แยกจาก Script Properties / secrets)
CREATE TABLE settings (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  key text NOT NULL,
  value_json jsonb NOT NULL,
  is_example boolean NOT NULL DEFAULT false,
  description_th text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT settings_ck1 CHECK (char_length(key) <= 100),
  CONSTRAINT settings_ck2 CHECK (key <> ''),
  CONSTRAINT settings_ck3 CHECK (key ~ '^[a-z][a-z0-9_.]*$'),
  CONSTRAINT settings_ck4 CHECK (char_length(description_th) <= 500),
  CONSTRAINT settings_ck5 CHECK (description_th <> ''),
  CONSTRAINT settings_ck6 CHECK (version >= 1)
);
CREATE UNIQUE INDEX settings_uq1 ON settings (school_id, key);
CREATE INDEX settings_ix1 ON settings (school_id);

-- RuleVersions: กฎธุรกิจแบบมีเวอร์ชันและวันที่มีผล (เวลาเริ่มสาย เกณฑ์ติดตาม เส้นทางอนุมัติ ฯลฯ)
CREATE TABLE rule_versions (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  rule_type text NOT NULL,
  version_no integer NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  params_json jsonb NOT NULL,
  status text NOT NULL,
  is_example boolean NOT NULL DEFAULT true,
  approved_by uuid,
  approved_at timestamptz,
  notes_th text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT rule_versions_ck1 CHECK (rule_type IN ('SCHOOL_LATENESS', 'PERIOD_LATENESS', 'FOLLOWUP_LATE_COUNT', 'FOLLOWUP_ABSENCE_COUNT', 'LEAVE_ROUTING', 'ABSENCE_VERIFICATION', 'NOTIFICATION_POLICY')),
  CONSTRAINT rule_versions_ck2 CHECK (version_no >= 1),
  CONSTRAINT rule_versions_ck3 CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  CONSTRAINT rule_versions_ck4 CHECK (char_length(notes_th) <= 5000),
  CONSTRAINT rule_versions_ck5 CHECK (notes_th <> ''),
  CONSTRAINT rule_versions_ck6 CHECK (version >= 1),
  CONSTRAINT rule_versions_ck7 CHECK (effective_to IS NULL OR effective_from < effective_to)
);
CREATE UNIQUE INDEX rule_versions_uq1 ON rule_versions (school_id, rule_type, version_no);
CREATE INDEX rule_versions_ix1 ON rule_versions (school_id);
CREATE INDEX rule_versions_ix2 ON rule_versions (approved_by);

-- SchemaVersions: ประวัติการติดตั้ง/อัปเกรด schema (append-only)
CREATE TABLE schema_versions (
  id uuid NOT NULL PRIMARY KEY,
  component text NOT NULL,
  schema_version integer NOT NULL,
  applied_at timestamptz NOT NULL,
  applied_by text NOT NULL,
  description text,
  checksum text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT schema_versions_ck1 CHECK (component IN ('SHEETS', 'POSTGRES')),
  CONSTRAINT schema_versions_ck2 CHECK (schema_version >= 1),
  CONSTRAINT schema_versions_ck3 CHECK (char_length(applied_by) <= 200),
  CONSTRAINT schema_versions_ck4 CHECK (applied_by <> ''),
  CONSTRAINT schema_versions_ck5 CHECK (char_length(description) <= 500),
  CONSTRAINT schema_versions_ck6 CHECK (description <> ''),
  CONSTRAINT schema_versions_ck7 CHECK (char_length(checksum) <= 64),
  CONSTRAINT schema_versions_ck8 CHECK (checksum <> '')
);
CREATE TRIGGER schema_versions_append_only BEFORE UPDATE OR DELETE ON schema_versions FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE UNIQUE INDEX schema_versions_uq1 ON schema_versions (component, schema_version);

-- StorageCatalog: แผนที่ logical table + partition → workbook/sheet (Sheets adapter); ปลายทางอื่นเก็บเป็น metadata
CREATE TABLE storage_catalog (
  id uuid NOT NULL PRIMARY KEY,
  logical_table text NOT NULL,
  partition_key text NOT NULL,
  workbook_id text,
  sheet_name text NOT NULL,
  schema_version integer NOT NULL,
  status text NOT NULL,
  row_count integer,
  cell_count integer,
  measured_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT storage_catalog_ck1 CHECK (char_length(logical_table) <= 60),
  CONSTRAINT storage_catalog_ck2 CHECK (logical_table <> ''),
  CONSTRAINT storage_catalog_ck3 CHECK (char_length(partition_key) <= 30),
  CONSTRAINT storage_catalog_ck4 CHECK (partition_key <> ''),
  CONSTRAINT storage_catalog_ck5 CHECK (char_length(workbook_id) <= 100),
  CONSTRAINT storage_catalog_ck6 CHECK (workbook_id <> ''),
  CONSTRAINT storage_catalog_ck7 CHECK (char_length(sheet_name) <= 100),
  CONSTRAINT storage_catalog_ck8 CHECK (sheet_name <> ''),
  CONSTRAINT storage_catalog_ck9 CHECK (schema_version >= 1),
  CONSTRAINT storage_catalog_ck10 CHECK (status IN ('ACTIVE', 'READONLY', 'ARCHIVED')),
  CONSTRAINT storage_catalog_ck11 CHECK (row_count >= 0),
  CONSTRAINT storage_catalog_ck12 CHECK (cell_count >= 0),
  CONSTRAINT storage_catalog_ck13 CHECK (version >= 1)
);
CREATE UNIQUE INDEX storage_catalog_uq1 ON storage_catalog (logical_table, partition_key);

-- Users: บัญชีผู้ใช้ของแอป (UUID อิสระจากผู้ให้บริการยืนยันตัวตน); สร้างบัญชีแล้วยังไม่มีสิทธิ์จนผ่านคำเชิญและบทบาท
CREATE TABLE users (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  user_type text NOT NULL,
  display_name text NOT NULL,
  contact_email text,
  staff_code text,
  student_id uuid,
  guardian_id uuid,
  status text NOT NULL,
  disabled_at timestamptz,
  disabled_by uuid,
  disabled_reason text,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT users_ck1 CHECK (user_type IN ('STAFF', 'GUARDIAN', 'STUDENT', 'SYSTEM')),
  CONSTRAINT users_ck2 CHECK (char_length(display_name) <= 200),
  CONSTRAINT users_ck3 CHECK (display_name <> ''),
  CONSTRAINT users_ck4 CHECK (char_length(contact_email) <= 254),
  CONSTRAINT users_ck5 CHECK (contact_email <> ''),
  CONSTRAINT users_ck6 CHECK (char_length(staff_code) <= 30),
  CONSTRAINT users_ck7 CHECK (staff_code <> ''),
  CONSTRAINT users_ck8 CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED')),
  CONSTRAINT users_ck9 CHECK (char_length(disabled_reason) <= 500),
  CONSTRAINT users_ck10 CHECK (disabled_reason <> ''),
  CONSTRAINT users_ck11 CHECK (version >= 1)
);
CREATE UNIQUE INDEX users_uq1 ON users (school_id, staff_code);
CREATE INDEX users_ix1 ON users (student_id);
CREATE INDEX users_ix2 ON users (guardian_id);
CREATE INDEX users_ix3 ON users (school_id);
CREATE INDEX users_ix4 ON users (disabled_by);

-- IdentityLinks: การผูก (provider, issuer, subject) กับ Users.id — ไม่เก็บรหัสผ่านหรือ token
CREATE TABLE identity_links (
  id uuid NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  email_at_link text,
  linked_at timestamptz NOT NULL,
  linked_via text NOT NULL,
  invitation_id uuid,
  status text NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT identity_links_ck1 CHECK (provider IN ('firebase', 'google-workspace', 'demo')),
  CONSTRAINT identity_links_ck2 CHECK (char_length(issuer) <= 300),
  CONSTRAINT identity_links_ck3 CHECK (issuer <> ''),
  CONSTRAINT identity_links_ck4 CHECK (char_length(subject) <= 200),
  CONSTRAINT identity_links_ck5 CHECK (subject <> ''),
  CONSTRAINT identity_links_ck6 CHECK (char_length(email_at_link) <= 254),
  CONSTRAINT identity_links_ck7 CHECK (email_at_link <> ''),
  CONSTRAINT identity_links_ck8 CHECK (linked_via IN ('INVITATION', 'BOOTSTRAP', 'ADMIN', 'DEMO_SEED')),
  CONSTRAINT identity_links_ck9 CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT identity_links_ck10 CHECK (version >= 1)
);
CREATE UNIQUE INDEX identity_links_uq1 ON identity_links (provider, issuer, subject) WHERE status = 'ACTIVE';
CREATE INDEX identity_links_ix1 ON identity_links (subject);
CREATE INDEX identity_links_ix2 ON identity_links (user_id);
CREATE INDEX identity_links_ix3 ON identity_links (invitation_id);
CREATE INDEX identity_links_ix4 ON identity_links (revoked_by);

-- UserRoles: บทบาทพร้อมช่วงวันที่มีผล [effective_from, effective_to) — คนเดียวมีหลายบทบาทได้
CREATE TABLE user_roles (
  id uuid NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL,
  role text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  granted_by uuid NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  reason text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT user_roles_ck1 CHECK (role IN ('SYSTEM_ADMIN', 'STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF', 'GUARDIAN', 'STUDENT')),
  CONSTRAINT user_roles_ck2 CHECK (char_length(reason) <= 500),
  CONSTRAINT user_roles_ck3 CHECK (reason <> ''),
  CONSTRAINT user_roles_ck4 CHECK (version >= 1),
  CONSTRAINT user_roles_ck5 CHECK (effective_to IS NULL OR effective_from < effective_to)
);
CREATE INDEX user_roles_ix1 ON user_roles (user_id);
CREATE INDEX user_roles_ix2 ON user_roles (granted_by);
CREATE INDEX user_roles_ix3 ON user_roles (revoked_by);

-- StaffAssignments: ขอบเขตงานของบุคลากร: ครูที่ปรึกษา เวรประจำจุด สอน ผู้รักษาการแทน พร้อมช่วงเวลาที่มีผล
CREATE TABLE staff_assignments (
  id uuid NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL,
  assignment_type text NOT NULL,
  class_id uuid,
  station_id uuid,
  weekday integer,
  subject_code text,
  delegate_for_user_id uuid,
  effective_from date NOT NULL,
  effective_to date,
  notes text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT staff_assignments_ck1 CHECK (assignment_type IN ('HOMEROOM', 'DUTY', 'TEACHING', 'DELEGATE')),
  CONSTRAINT staff_assignments_ck2 CHECK (weekday >= 1),
  CONSTRAINT staff_assignments_ck3 CHECK (weekday <= 7),
  CONSTRAINT staff_assignments_ck4 CHECK (char_length(subject_code) <= 30),
  CONSTRAINT staff_assignments_ck5 CHECK (subject_code <> ''),
  CONSTRAINT staff_assignments_ck6 CHECK (char_length(notes) <= 500),
  CONSTRAINT staff_assignments_ck7 CHECK (notes <> ''),
  CONSTRAINT staff_assignments_ck8 CHECK (version >= 1),
  CONSTRAINT staff_assignments_ck9 CHECK (effective_to IS NULL OR effective_from < effective_to)
);
CREATE INDEX staff_assignments_ix1 ON staff_assignments (user_id);
CREATE INDEX staff_assignments_ix2 ON staff_assignments (class_id);
CREATE INDEX staff_assignments_ix3 ON staff_assignments (delegate_for_user_id);
CREATE INDEX staff_assignments_ix4 ON staff_assignments (station_id);

-- InvitationRecords: คำเชิญเปิดใช้งาน ใช้ได้ครั้งเดียว มีอายุ เก็บเฉพาะ hash ของรหัส (ไม่ export)
CREATE TABLE invitation_records (
  id uuid NOT NULL PRIMARY KEY,
  invitation_type text NOT NULL,
  target_user_id uuid NOT NULL,
  code_hash text NOT NULL,
  bound_email text,
  expires_at timestamptz NOT NULL,
  max_attempts integer NOT NULL,
  attempt_count integer NOT NULL,
  status text NOT NULL,
  redeemed_at timestamptz,
  redeemed_identity_link_id uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT invitation_records_ck1 CHECK (invitation_type IN ('STAFF', 'GUARDIAN', 'STUDENT')),
  CONSTRAINT invitation_records_ck2 CHECK (char_length(code_hash) <= 64),
  CONSTRAINT invitation_records_ck3 CHECK (code_hash <> ''),
  CONSTRAINT invitation_records_ck4 CHECK (char_length(bound_email) <= 254),
  CONSTRAINT invitation_records_ck5 CHECK (bound_email <> ''),
  CONSTRAINT invitation_records_ck6 CHECK (max_attempts >= 1),
  CONSTRAINT invitation_records_ck7 CHECK (max_attempts <= 20),
  CONSTRAINT invitation_records_ck8 CHECK (attempt_count >= 0),
  CONSTRAINT invitation_records_ck9 CHECK (status IN ('PENDING', 'REDEEMED', 'EXPIRED', 'REVOKED', 'LOCKED')),
  CONSTRAINT invitation_records_ck10 CHECK (version >= 1)
);
CREATE INDEX invitation_records_ix1 ON invitation_records (target_user_id);
CREATE INDEX invitation_records_ix2 ON invitation_records (code_hash);
CREATE INDEX invitation_records_ix3 ON invitation_records (redeemed_identity_link_id);

-- Stations: จุดลงเวลา/สถานี
CREATE TABLE stations (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  code text NOT NULL,
  name_th text NOT NULL,
  station_type text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT stations_ck1 CHECK (char_length(code) <= 30),
  CONSTRAINT stations_ck2 CHECK (code <> ''),
  CONSTRAINT stations_ck3 CHECK (char_length(name_th) <= 200),
  CONSTRAINT stations_ck4 CHECK (name_th <> ''),
  CONSTRAINT stations_ck5 CHECK (station_type IN ('GATE', 'OFFICE', 'CLASSROOM')),
  CONSTRAINT stations_ck6 CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT stations_ck7 CHECK (version >= 1)
);
CREATE UNIQUE INDEX stations_uq1 ON stations (school_id, code);
CREATE INDEX stations_ix1 ON stations (school_id);

-- Students: นักเรียน; student_code เป็น business key แบบ string (รักษาเลขศูนย์นำหน้า)
CREATE TABLE students (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  student_code text NOT NULL,
  prefix_th text,
  first_name_th text NOT NULL,
  last_name_th text NOT NULL,
  first_name_en text,
  last_name_en text,
  nickname text,
  gender text,
  birth_date date,
  photo_file_id uuid,
  status text NOT NULL,
  status_effective_date date,
  search_name text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT students_ck1 CHECK (char_length(student_code) <= 20),
  CONSTRAINT students_ck2 CHECK (student_code <> ''),
  CONSTRAINT students_ck3 CHECK (student_code ~ '^[0-9A-Za-z-]{1,20}$'),
  CONSTRAINT students_ck4 CHECK (char_length(prefix_th) <= 30),
  CONSTRAINT students_ck5 CHECK (prefix_th <> ''),
  CONSTRAINT students_ck6 CHECK (char_length(first_name_th) <= 100),
  CONSTRAINT students_ck7 CHECK (first_name_th <> ''),
  CONSTRAINT students_ck8 CHECK (char_length(last_name_th) <= 100),
  CONSTRAINT students_ck9 CHECK (last_name_th <> ''),
  CONSTRAINT students_ck10 CHECK (char_length(first_name_en) <= 100),
  CONSTRAINT students_ck11 CHECK (first_name_en <> ''),
  CONSTRAINT students_ck12 CHECK (char_length(last_name_en) <= 100),
  CONSTRAINT students_ck13 CHECK (last_name_en <> ''),
  CONSTRAINT students_ck14 CHECK (char_length(nickname) <= 50),
  CONSTRAINT students_ck15 CHECK (nickname <> ''),
  CONSTRAINT students_ck16 CHECK (gender IN ('MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED')),
  CONSTRAINT students_ck17 CHECK (status IN ('ACTIVE', 'TRANSFERRED_OUT', 'GRADUATED', 'WITHDRAWN', 'SUSPENDED')),
  CONSTRAINT students_ck18 CHECK (char_length(search_name) <= 300),
  CONSTRAINT students_ck19 CHECK (search_name <> ''),
  CONSTRAINT students_ck20 CHECK (version >= 1)
);
CREATE UNIQUE INDEX students_uq1 ON students (school_id, student_code);
CREATE INDEX students_ix1 ON students (student_code);
CREATE INDEX students_ix2 ON students (search_name);
CREATE INDEX students_ix3 ON students (status);
CREATE INDEX students_ix4 ON students (school_id);

-- Classes: ห้องเรียนรายปีการศึกษา
CREATE TABLE classes (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  grade_level text NOT NULL,
  room_no text NOT NULL,
  code text NOT NULL,
  name_th text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT classes_ck1 CHECK (grade_level IN ('M1', 'M2', 'M3', 'M4', 'M5', 'M6')),
  CONSTRAINT classes_ck2 CHECK (char_length(room_no) <= 10),
  CONSTRAINT classes_ck3 CHECK (room_no <> ''),
  CONSTRAINT classes_ck4 CHECK (char_length(code) <= 20),
  CONSTRAINT classes_ck5 CHECK (code <> ''),
  CONSTRAINT classes_ck6 CHECK (char_length(name_th) <= 50),
  CONSTRAINT classes_ck7 CHECK (name_th <> ''),
  CONSTRAINT classes_ck8 CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT classes_ck9 CHECK (version >= 1)
);
CREATE UNIQUE INDEX classes_uq1 ON classes (academic_year_id, code);
CREATE INDEX classes_ix1 ON classes (academic_year_id);
CREATE INDEX classes_ix2 ON classes (school_id);

-- Enrollments: ประวัติการอยู่ห้อง [effective_from, effective_to) ห้ามช่วงซ้อนกันต่อนักเรียน; ย้ายห้อง/เลื่อนชั้น/ย้ายออกปิดช่วงเดิมแล้วเปิดช่วงใหม่
CREATE TABLE enrollments (
  id uuid NOT NULL PRIMARY KEY,
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  end_reason text,
  roll_no integer,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT enrollments_ck1 CHECK (end_reason IN ('CLASS_CHANGE', 'PROMOTION', 'TRANSFER_OUT', 'GRADUATION', 'WITHDRAWAL', 'CORRECTION')),
  CONSTRAINT enrollments_ck2 CHECK (roll_no >= 1),
  CONSTRAINT enrollments_ck3 CHECK (roll_no <= 200),
  CONSTRAINT enrollments_ck4 CHECK (version >= 1),
  CONSTRAINT enrollments_ck5 CHECK (effective_to IS NULL OR effective_from < effective_to)
);
CREATE INDEX enrollments_ix1 ON enrollments (student_id);
CREATE INDEX enrollments_ix2 ON enrollments (class_id);
CREATE INDEX enrollments_ix3 ON enrollments (academic_year_id);
ALTER TABLE enrollments ADD CONSTRAINT enrollments_no_overlap EXCLUDE USING gist (student_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&);

-- Guardians: ผู้ปกครอง (หนึ่งคนดูแลนักเรียนได้หลายคน)
CREATE TABLE guardians (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  external_ref text,
  prefix_th text,
  first_name_th text NOT NULL,
  last_name_th text NOT NULL,
  search_name text,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT guardians_ck1 CHECK (char_length(external_ref) <= 40),
  CONSTRAINT guardians_ck2 CHECK (external_ref <> ''),
  CONSTRAINT guardians_ck3 CHECK (external_ref ~ '^[0-9A-Za-z_-]{1,40}$'),
  CONSTRAINT guardians_ck4 CHECK (char_length(prefix_th) <= 30),
  CONSTRAINT guardians_ck5 CHECK (prefix_th <> ''),
  CONSTRAINT guardians_ck6 CHECK (char_length(first_name_th) <= 100),
  CONSTRAINT guardians_ck7 CHECK (first_name_th <> ''),
  CONSTRAINT guardians_ck8 CHECK (char_length(last_name_th) <= 100),
  CONSTRAINT guardians_ck9 CHECK (last_name_th <> ''),
  CONSTRAINT guardians_ck10 CHECK (char_length(search_name) <= 300),
  CONSTRAINT guardians_ck11 CHECK (search_name <> ''),
  CONSTRAINT guardians_ck12 CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT guardians_ck13 CHECK (version >= 1)
);
CREATE UNIQUE INDEX guardians_uq1 ON guardians (school_id, external_ref);
CREATE INDEX guardians_ix1 ON guardians (external_ref);
CREATE INDEX guardians_ix2 ON guardians (search_name);
CREATE INDEX guardians_ix3 ON guardians (school_id);

-- StudentGuardians: ความสัมพันธ์นักเรียน-ผู้ปกครองที่เจ้าหน้าที่ยืนยัน พร้อมสิทธิ์และช่วงเวลาที่มีผล
CREATE TABLE student_guardians (
  id uuid NOT NULL PRIMARY KEY,
  student_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  relationship text NOT NULL,
  relationship_note text,
  is_primary_contact boolean NOT NULL DEFAULT false,
  contact_priority integer NOT NULL,
  permitted_actions jsonb NOT NULL,
  notification_preferences jsonb NOT NULL,
  status text NOT NULL,
  verified_by uuid,
  verified_at timestamptz,
  verification_method text,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT student_guardians_ck1 CHECK (relationship IN ('FATHER', 'MOTHER', 'GRANDPARENT', 'SIBLING', 'RELATIVE', 'LEGAL_GUARDIAN', 'OTHER')),
  CONSTRAINT student_guardians_ck2 CHECK (char_length(relationship_note) <= 200),
  CONSTRAINT student_guardians_ck3 CHECK (relationship_note <> ''),
  CONSTRAINT student_guardians_ck4 CHECK (contact_priority >= 1),
  CONSTRAINT student_guardians_ck5 CHECK (contact_priority <= 9),
  CONSTRAINT student_guardians_ck6 CHECK (status IN ('PENDING_VERIFICATION', 'ACTIVE', 'ENDED')),
  CONSTRAINT student_guardians_ck7 CHECK (verification_method IN ('IN_PERSON', 'DOCUMENT', 'PHONE_CALLBACK', 'SCHOOL_RECORD')),
  CONSTRAINT student_guardians_ck8 CHECK (version >= 1),
  CONSTRAINT student_guardians_ck9 CHECK (effective_to IS NULL OR effective_from < effective_to),
  CONSTRAINT student_guardians_ck10 CHECK (status <> 'ACTIVE' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX student_guardians_uq1 ON student_guardians (student_id, guardian_id, effective_from);
CREATE INDEX student_guardians_ix1 ON student_guardians (student_id);
CREATE INDEX student_guardians_ix2 ON student_guardians (guardian_id);
CREATE INDEX student_guardians_ix3 ON student_guardians (verified_by);

-- ContactEndpoints: ช่องทางติดต่อ (เบอร์โทรเก็บเป็น string) การแก้ไขต้องยืนยันโดยเจ้าหน้าที่และมี audit
CREATE TABLE contact_endpoints (
  id uuid NOT NULL PRIMARY KEY,
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  channel text NOT NULL,
  value text NOT NULL,
  label_th text,
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  verified_by uuid,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT contact_endpoints_ck1 CHECK (owner_type IN ('GUARDIAN', 'STAFF', 'STUDENT')),
  CONSTRAINT contact_endpoints_ck2 CHECK (channel IN ('PHONE', 'EMAIL', 'LINE', 'SMS', 'IN_PERSON', 'OTHER')),
  CONSTRAINT contact_endpoints_ck3 CHECK (char_length(value) <= 254),
  CONSTRAINT contact_endpoints_ck4 CHECK (value <> ''),
  CONSTRAINT contact_endpoints_ck5 CHECK (char_length(label_th) <= 100),
  CONSTRAINT contact_endpoints_ck6 CHECK (label_th <> ''),
  CONSTRAINT contact_endpoints_ck7 CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT contact_endpoints_ck8 CHECK (version >= 1)
);
CREATE INDEX contact_endpoints_ix1 ON contact_endpoints (owner_id);
CREATE INDEX contact_endpoints_ix2 ON contact_endpoints (verified_by);

-- AttendanceEvents: เหตุการณ์ข้อเท็จจริงการมาเรียน (append-only) การแก้ไขใช้ supersedes_event_id; การเช็กชื่อเก็บเฉพาะรายการที่ไม่ใช่ "มา" ตามรายชื่อ
CREATE TABLE attendance_events (
  id uuid NOT NULL PRIMARY KEY,
  student_id uuid NOT NULL,
  school_date date NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  captured_at timestamptz,
  synced_at timestamptz,
  source text NOT NULL,
  offline boolean NOT NULL DEFAULT false,
  station_id uuid,
  actor_id uuid NOT NULL,
  claimed_actor_id uuid,
  reason_code text,
  reason_text text,
  linked_leave_id uuid,
  supersedes_event_id uuid,
  roll_call_session_id uuid,
  class_id uuid,
  dedupe_key text,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT attendance_events_ck1 CHECK (event_type IN ('GATE_ARRIVAL', 'CLASSROOM_ENTERED', 'ROLL_CALL_PRESENT', 'ROLL_CALL_ABSENT', 'ROLL_CALL_LATE', 'ROLL_CALL_LEAVE_REPORTED', 'ABSENCE_CONFIRMED', 'LATENESS_EXEMPTED', 'EVENT_VOIDED')),
  CONSTRAINT attendance_events_ck2 CHECK (source IN ('SCAN_KEYBOARD', 'SCAN_CAMERA', 'SEARCH_CODE', 'SEARCH_NAME', 'MANUAL_TIME', 'QUEUE_BATCH', 'OFFLINE_SYNC', 'ROLL_CALL', 'IMPORT', 'CORRECTION', 'SYSTEM')),
  CONSTRAINT attendance_events_ck3 CHECK (char_length(reason_code) <= 40),
  CONSTRAINT attendance_events_ck4 CHECK (reason_code <> ''),
  CONSTRAINT attendance_events_ck5 CHECK (char_length(reason_text) <= 500),
  CONSTRAINT attendance_events_ck6 CHECK (reason_text <> ''),
  CONSTRAINT attendance_events_ck7 CHECK (char_length(dedupe_key) <= 200),
  CONSTRAINT attendance_events_ck8 CHECK (dedupe_key <> '')
);
CREATE TRIGGER attendance_events_append_only BEFORE UPDATE OR DELETE ON attendance_events FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE UNIQUE INDEX attendance_events_uq1 ON attendance_events (dedupe_key);
CREATE INDEX attendance_events_ix1 ON attendance_events (student_id);
CREATE INDEX attendance_events_ix2 ON attendance_events (school_date);
CREATE INDEX attendance_events_ix3 ON attendance_events (dedupe_key);
CREATE INDEX attendance_events_ix4 ON attendance_events (student_id, school_date);
CREATE INDEX attendance_events_ix5 ON attendance_events (school_date, event_type);
CREATE INDEX attendance_events_ix6 ON attendance_events (station_id);
CREATE INDEX attendance_events_ix7 ON attendance_events (actor_id);
CREATE INDEX attendance_events_ix8 ON attendance_events (linked_leave_id);
CREATE INDEX attendance_events_ix9 ON attendance_events (supersedes_event_id);
CREATE INDEX attendance_events_ix10 ON attendance_events (roll_call_session_id);
CREATE INDEX attendance_events_ix11 ON attendance_events (class_id);

-- DailyAttendance: สรุปรายวันต่อคน (projection สร้างใหม่ได้จาก AttendanceEvents, RollCallSessions, LeaveSegments, Enrollments, ปฏิทินและกฎ) id = UUIDv5(student_id|school_date)
CREATE TABLE daily_attendance (
  id uuid NOT NULL PRIMARY KEY,
  student_id uuid NOT NULL,
  school_date date NOT NULL,
  class_id uuid,
  school_day boolean NOT NULL,
  eligible boolean NOT NULL,
  presence_status text NOT NULL,
  verification_level text NOT NULL,
  is_late boolean NOT NULL,
  late_minutes integer,
  late_counted boolean NOT NULL,
  lateness_exempted boolean NOT NULL,
  arrival_event_id uuid,
  arrived_at timestamptz,
  roll_call_mark text NOT NULL,
  roll_call_session_id uuid,
  full_day_leave boolean NOT NULL,
  partial_leave boolean NOT NULL,
  leave_units text,
  leave_request_ids jsonb,
  confirmed_absence boolean NOT NULL,
  has_conflict boolean NOT NULL,
  conflicts jsonb,
  evidence_refs jsonb,
  calculated_rule_version_id uuid,
  projection_version integer NOT NULL,
  computed_at timestamptz NOT NULL,
  verified_by uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT daily_attendance_ck1 CHECK (presence_status IN ('PRESENT', 'ABSENT_CONFIRMED', 'ON_LEAVE_FULL_DAY', 'UNKNOWN', 'NOT_ELIGIBLE', 'NON_SCHOOL_DAY')),
  CONSTRAINT daily_attendance_ck2 CHECK (verification_level IN ('NONE', 'GATE_RECORD', 'ROLL_CALL', 'VERIFIED')),
  CONSTRAINT daily_attendance_ck3 CHECK (late_minutes >= 0),
  CONSTRAINT daily_attendance_ck4 CHECK (roll_call_mark IN ('PRESENT', 'ABSENT', 'LATE', 'LEAVE_REPORTED', 'NOT_MARKED')),
  CONSTRAINT daily_attendance_ck5 CHECK (char_length(leave_units) <= 100),
  CONSTRAINT daily_attendance_ck6 CHECK (leave_units <> ''),
  CONSTRAINT daily_attendance_ck7 CHECK (projection_version >= 1),
  CONSTRAINT daily_attendance_ck8 CHECK (version >= 1)
);
CREATE UNIQUE INDEX daily_attendance_uq1 ON daily_attendance (student_id, school_date);
CREATE INDEX daily_attendance_ix1 ON daily_attendance (school_date);
CREATE INDEX daily_attendance_ix2 ON daily_attendance (student_id);
CREATE INDEX daily_attendance_ix3 ON daily_attendance (school_date, class_id);
CREATE INDEX daily_attendance_ix4 ON daily_attendance (school_date, presence_status);
CREATE INDEX daily_attendance_ix5 ON daily_attendance (class_id);
CREATE INDEX daily_attendance_ix6 ON daily_attendance (arrival_event_id);
CREATE INDEX daily_attendance_ix7 ON daily_attendance (roll_call_session_id);
CREATE INDEX daily_attendance_ix8 ON daily_attendance (calculated_rule_version_id);
CREATE INDEX daily_attendance_ix9 ON daily_attendance (verified_by);

-- RollCallSessions: การเช็กชื่อประจำวันรายห้อง (ผู้ยืนยันและแหล่งข้อมูล) id = UUIDv5(class_id|school_date); นักเรียนในรายชื่อที่ไม่มีเหตุการณ์ยกเว้น = มาตามการเช็กชื่อ
CREATE TABLE roll_call_sessions (
  id uuid NOT NULL PRIMARY KEY,
  class_id uuid NOT NULL,
  school_date date NOT NULL,
  status text NOT NULL,
  roster_count integer NOT NULL,
  roster_hash text NOT NULL,
  absent_count integer,
  late_count integer,
  leave_reported_count integer,
  submitted_by uuid,
  submitted_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  source text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT roll_call_sessions_ck1 CHECK (status IN ('OPEN', 'SUBMITTED', 'VERIFIED')),
  CONSTRAINT roll_call_sessions_ck2 CHECK (roster_count >= 0),
  CONSTRAINT roll_call_sessions_ck3 CHECK (char_length(roster_hash) <= 64),
  CONSTRAINT roll_call_sessions_ck4 CHECK (roster_hash <> ''),
  CONSTRAINT roll_call_sessions_ck5 CHECK (absent_count >= 0),
  CONSTRAINT roll_call_sessions_ck6 CHECK (late_count >= 0),
  CONSTRAINT roll_call_sessions_ck7 CHECK (leave_reported_count >= 0),
  CONSTRAINT roll_call_sessions_ck8 CHECK (char_length(source) <= 20),
  CONSTRAINT roll_call_sessions_ck9 CHECK (source <> ''),
  CONSTRAINT roll_call_sessions_ck10 CHECK (version >= 1)
);
CREATE UNIQUE INDEX roll_call_sessions_uq1 ON roll_call_sessions (class_id, school_date);
CREATE INDEX roll_call_sessions_ix1 ON roll_call_sessions (school_date);
CREATE INDEX roll_call_sessions_ix2 ON roll_call_sessions (class_id);
CREATE INDEX roll_call_sessions_ix3 ON roll_call_sessions (submitted_by);
CREATE INDEX roll_call_sessions_ix4 ON roll_call_sessions (verified_by);

-- AttendanceCorrections: คำขอ/การแก้ไขข้อมูลการมาเรียนย้อนหลัง พร้อมเหตุผล ค่าเดิม/ใหม่ และผู้อนุมัติ
CREATE TABLE attendance_corrections (
  id uuid NOT NULL PRIMARY KEY,
  student_id uuid NOT NULL,
  school_date date NOT NULL,
  target_event_id uuid,
  correction_type text NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  reason text NOT NULL,
  requested_change jsonb NOT NULL,
  status text NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  resulting_event_id uuid,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT attendance_corrections_ck1 CHECK (correction_type IN ('VOID_EVENT', 'AMEND_ARRIVAL_TIME', 'ADD_ARRIVAL', 'CHANGE_ROLL_CALL_MARK', 'EXEMPT_LATENESS')),
  CONSTRAINT attendance_corrections_ck2 CHECK (char_length(reason) <= 1000),
  CONSTRAINT attendance_corrections_ck3 CHECK (reason <> ''),
  CONSTRAINT attendance_corrections_ck4 CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED')),
  CONSTRAINT attendance_corrections_ck5 CHECK (char_length(decision_note) <= 1000),
  CONSTRAINT attendance_corrections_ck6 CHECK (decision_note <> ''),
  CONSTRAINT attendance_corrections_ck7 CHECK (version >= 1)
);
CREATE INDEX attendance_corrections_ix1 ON attendance_corrections (student_id);
CREATE INDEX attendance_corrections_ix2 ON attendance_corrections (target_event_id);
CREATE INDEX attendance_corrections_ix3 ON attendance_corrections (requested_by);
CREATE INDEX attendance_corrections_ix4 ON attendance_corrections (decided_by);
CREATE INDEX attendance_corrections_ix5 ON attendance_corrections (resulting_event_id);

-- ReconciliationTasks: งานตรวจสอบเมื่อข้อมูลขัดกันหรือยังไม่ทราบสถานะ (ระบบไม่ตัดสินเอง)
CREATE TABLE reconciliation_tasks (
  id uuid NOT NULL PRIMARY KEY,
  task_type text NOT NULL,
  student_id uuid,
  class_id uuid,
  school_date date,
  evidence_refs jsonb NOT NULL,
  description_th text NOT NULL,
  assigned_to uuid,
  assigned_role text,
  due_at timestamptz,
  status text NOT NULL,
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT reconciliation_tasks_ck1 CHECK (task_type IN ('UNKNOWN_STATUS', 'CONFLICT_LEAVE_PRESENCE', 'CONFLICT_ROLLCALL_GATE', 'OFFLINE_REVIEW', 'IMPORT_REVIEW', 'LEAVE_REPORTED_NO_REQUEST', 'DATA_QUALITY')),
  CONSTRAINT reconciliation_tasks_ck2 CHECK (char_length(description_th) <= 1000),
  CONSTRAINT reconciliation_tasks_ck3 CHECK (description_th <> ''),
  CONSTRAINT reconciliation_tasks_ck4 CHECK (assigned_role IN ('SYSTEM_ADMIN', 'STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF', 'GUARDIAN', 'STUDENT')),
  CONSTRAINT reconciliation_tasks_ck5 CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  CONSTRAINT reconciliation_tasks_ck6 CHECK (char_length(resolution_note) <= 1000),
  CONSTRAINT reconciliation_tasks_ck7 CHECK (resolution_note <> ''),
  CONSTRAINT reconciliation_tasks_ck8 CHECK (char_length(dedupe_key) <= 200),
  CONSTRAINT reconciliation_tasks_ck9 CHECK (dedupe_key <> ''),
  CONSTRAINT reconciliation_tasks_ck10 CHECK (version >= 1)
);
CREATE UNIQUE INDEX reconciliation_tasks_uq1 ON reconciliation_tasks (dedupe_key);
CREATE INDEX reconciliation_tasks_ix1 ON reconciliation_tasks (dedupe_key);
CREATE INDEX reconciliation_tasks_ix2 ON reconciliation_tasks (assigned_to);
CREATE INDEX reconciliation_tasks_ix3 ON reconciliation_tasks (class_id);
CREATE INDEX reconciliation_tasks_ix4 ON reconciliation_tasks (student_id);
CREATE INDEX reconciliation_tasks_ix5 ON reconciliation_tasks (resolved_by);

-- LeaveRequests: ใบลา: สถานะรวม + สถานะผู้ปกครองยืนยัน + สถานะโรงเรียนอนุมัติ แยกกัน; ช่วงวันที่ [start_date, end_date)
CREATE TABLE leave_requests (
  id uuid NOT NULL PRIMARY KEY,
  student_id uuid NOT NULL,
  requester_user_id uuid NOT NULL,
  requester_type text NOT NULL,
  leave_type text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL,
  status text NOT NULL,
  guardian_confirmation_status text NOT NULL,
  school_approval_status text NOT NULL,
  route_rule_version_id uuid,
  current_approver_role text,
  current_approver_user_id uuid,
  is_retroactive boolean NOT NULL,
  retroactive_reason text,
  school_days_count integer NOT NULL,
  full_day_count integer NOT NULL,
  half_day_count integer NOT NULL,
  period_count integer NOT NULL,
  revision_no integer NOT NULL,
  submitted_at timestamptz,
  decided_at timestamptz,
  cancelled_at timestamptz,
  attachment_required boolean NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT leave_requests_ck1 CHECK (requester_type IN ('GUARDIAN', 'STUDENT', 'STAFF')),
  CONSTRAINT leave_requests_ck2 CHECK (leave_type IN ('SICK', 'PERSONAL', 'SCHOOL_ACTIVITY', 'OTHER')),
  CONSTRAINT leave_requests_ck3 CHECK (char_length(reason) <= 1000),
  CONSTRAINT leave_requests_ck4 CHECK (reason <> ''),
  CONSTRAINT leave_requests_ck5 CHECK (status IN ('DRAFT', 'SUBMITTED', 'PENDING_GUARDIAN', 'PENDING_SCHOOL', 'RETURNED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLATION_REQUESTED', 'CANCELLED')),
  CONSTRAINT leave_requests_ck6 CHECK (guardian_confirmation_status IN ('NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'DECLINED')),
  CONSTRAINT leave_requests_ck7 CHECK (school_approval_status IN ('NOT_STARTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'RETURNED')),
  CONSTRAINT leave_requests_ck8 CHECK (current_approver_role IN ('SYSTEM_ADMIN', 'STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF', 'GUARDIAN', 'STUDENT')),
  CONSTRAINT leave_requests_ck9 CHECK (char_length(retroactive_reason) <= 1000),
  CONSTRAINT leave_requests_ck10 CHECK (retroactive_reason <> ''),
  CONSTRAINT leave_requests_ck11 CHECK (school_days_count >= 0),
  CONSTRAINT leave_requests_ck12 CHECK (full_day_count >= 0),
  CONSTRAINT leave_requests_ck13 CHECK (half_day_count >= 0),
  CONSTRAINT leave_requests_ck14 CHECK (period_count >= 0),
  CONSTRAINT leave_requests_ck15 CHECK (revision_no >= 1),
  CONSTRAINT leave_requests_ck16 CHECK (version >= 1),
  CONSTRAINT leave_requests_ck17 CHECK (start_date < end_date)
);
CREATE INDEX leave_requests_ix1 ON leave_requests (student_id);
CREATE INDEX leave_requests_ix2 ON leave_requests (current_approver_user_id);
CREATE INDEX leave_requests_ix3 ON leave_requests (status);
CREATE INDEX leave_requests_ix4 ON leave_requests (student_id, start_date);
CREATE INDEX leave_requests_ix5 ON leave_requests (requester_user_id);
CREATE INDEX leave_requests_ix6 ON leave_requests (route_rule_version_id);

-- LeaveSegments: ช่วงลารายวันเรียน (อนุมัติแยกช่วงได้) หน่วยวัน/ครึ่งวัน/คาบไม่บวกปนกัน
CREATE TABLE leave_segments (
  id uuid NOT NULL PRIMARY KEY,
  leave_request_id uuid NOT NULL,
  student_id uuid NOT NULL,
  school_date date NOT NULL,
  unit text NOT NULL,
  periods jsonb,
  status text NOT NULL,
  decision_id uuid,
  usage_status text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT leave_segments_ck1 CHECK (unit IN ('FULL_DAY', 'HALF_DAY_AM', 'HALF_DAY_PM', 'PERIODS')),
  CONSTRAINT leave_segments_ck2 CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED')),
  CONSTRAINT leave_segments_ck3 CHECK (usage_status IN ('NOT_EVALUATED', 'USED', 'ATTENDED_ANYWAY', 'PARTIALLY_USED')),
  CONSTRAINT leave_segments_ck4 CHECK (version >= 1)
);
CREATE INDEX leave_segments_ix1 ON leave_segments (leave_request_id);
CREATE INDEX leave_segments_ix2 ON leave_segments (student_id);
CREATE INDEX leave_segments_ix3 ON leave_segments (school_date);
CREATE INDEX leave_segments_ix4 ON leave_segments (student_id, school_date);
CREATE INDEX leave_segments_ix5 ON leave_segments (decision_id);

-- LeaveRevisions: ประวัติทุกการเปลี่ยนแปลงใบลา (append-only ห้ามเขียนทับเหตุผล/ผู้อนุมัติเดิม)
CREATE TABLE leave_revisions (
  id uuid NOT NULL PRIMARY KEY,
  leave_request_id uuid NOT NULL,
  revision_no integer NOT NULL,
  action text NOT NULL,
  actor_id uuid NOT NULL,
  acted_at timestamptz NOT NULL,
  from_status text,
  to_status text NOT NULL,
  snapshot_json jsonb NOT NULL,
  comment text,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT leave_revisions_ck1 CHECK (revision_no >= 1),
  CONSTRAINT leave_revisions_ck2 CHECK (action IN ('CREATE', 'SUBMIT', 'GUARDIAN_CONFIRM', 'GUARDIAN_DECLINE', 'APPROVE', 'PARTIAL_APPROVE', 'REJECT', 'RETURN', 'RESUBMIT', 'WITHDRAW', 'CANCEL_REQUEST', 'CANCEL_APPROVE', 'CANCEL_REJECT', 'REROUTE')),
  CONSTRAINT leave_revisions_ck3 CHECK (from_status IN ('DRAFT', 'SUBMITTED', 'PENDING_GUARDIAN', 'PENDING_SCHOOL', 'RETURNED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLATION_REQUESTED', 'CANCELLED')),
  CONSTRAINT leave_revisions_ck4 CHECK (to_status IN ('DRAFT', 'SUBMITTED', 'PENDING_GUARDIAN', 'PENDING_SCHOOL', 'RETURNED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLATION_REQUESTED', 'CANCELLED')),
  CONSTRAINT leave_revisions_ck5 CHECK (char_length(comment) <= 1000),
  CONSTRAINT leave_revisions_ck6 CHECK (comment <> '')
);
CREATE TRIGGER leave_revisions_append_only BEFORE UPDATE OR DELETE ON leave_revisions FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE INDEX leave_revisions_ix1 ON leave_revisions (leave_request_id);
CREATE INDEX leave_revisions_ix2 ON leave_revisions (actor_id);

-- LeaveApprovals: การตัดสินแต่ละขั้น (ผู้ปกครองยืนยัน / โรงเรียนอนุมัติ / พิจารณายกเลิก) append-only
CREATE TABLE leave_approvals (
  id uuid NOT NULL PRIMARY KEY,
  leave_request_id uuid NOT NULL,
  step_no integer NOT NULL,
  step_type text NOT NULL,
  decision text NOT NULL,
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL,
  acting_for_user_id uuid,
  approver_role text,
  comment text,
  segment_decisions_json jsonb,
  revision_no integer NOT NULL,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT leave_approvals_ck1 CHECK (step_no >= 1),
  CONSTRAINT leave_approvals_ck2 CHECK (step_type IN ('GUARDIAN_CONFIRMATION', 'SCHOOL_APPROVAL', 'CANCELLATION_DECISION')),
  CONSTRAINT leave_approvals_ck3 CHECK (decision IN ('CONFIRMED', 'DECLINED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'RETURNED')),
  CONSTRAINT leave_approvals_ck4 CHECK (approver_role IN ('SYSTEM_ADMIN', 'STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF', 'GUARDIAN', 'STUDENT')),
  CONSTRAINT leave_approvals_ck5 CHECK (char_length(comment) <= 1000),
  CONSTRAINT leave_approvals_ck6 CHECK (comment <> ''),
  CONSTRAINT leave_approvals_ck7 CHECK (revision_no >= 1)
);
CREATE TRIGGER leave_approvals_append_only BEFORE UPDATE OR DELETE ON leave_approvals FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE INDEX leave_approvals_ix1 ON leave_approvals (leave_request_id);
CREATE INDEX leave_approvals_ix2 ON leave_approvals (decided_by);
CREATE INDEX leave_approvals_ix3 ON leave_approvals (acting_for_user_id);

-- Cases: เรื่องติดตาม/ดูแลช่วยเหลือ มีผู้รับผิดชอบ กำหนดเวลา และการ dedupe
CREATE TABLE cases (
  id uuid NOT NULL PRIMARY KEY,
  student_id uuid NOT NULL,
  case_type text NOT NULL,
  rule_version_id uuid,
  trigger_summary_th text NOT NULL,
  trigger_evidence_json jsonb NOT NULL,
  dedupe_key text,
  status text NOT NULL,
  priority text NOT NULL,
  owner_user_id uuid,
  due_at timestamptz,
  next_action_th text,
  next_appointment_at timestamptz,
  resolution_summary text,
  closed_at timestamptz,
  closed_by uuid,
  reopened_count integer NOT NULL,
  cooldown_until timestamptz,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT cases_ck1 CHECK (case_type IN ('RULE_LATE_COUNT', 'RULE_ABSENCE_COUNT', 'MANUAL', 'CALLBACK_REQUEST', 'ACK_TIMEOUT')),
  CONSTRAINT cases_ck2 CHECK (char_length(trigger_summary_th) <= 1000),
  CONSTRAINT cases_ck3 CHECK (trigger_summary_th <> ''),
  CONSTRAINT cases_ck4 CHECK (char_length(dedupe_key) <= 200),
  CONSTRAINT cases_ck5 CHECK (dedupe_key <> ''),
  CONSTRAINT cases_ck6 CHECK (status IN ('OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE', 'RESOLVED', 'CLOSED')),
  CONSTRAINT cases_ck7 CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT cases_ck8 CHECK (char_length(next_action_th) <= 500),
  CONSTRAINT cases_ck9 CHECK (next_action_th <> ''),
  CONSTRAINT cases_ck10 CHECK (char_length(resolution_summary) <= 2000),
  CONSTRAINT cases_ck11 CHECK (resolution_summary <> ''),
  CONSTRAINT cases_ck12 CHECK (reopened_count >= 0),
  CONSTRAINT cases_ck13 CHECK (version >= 1)
);
CREATE UNIQUE INDEX cases_uq1 ON cases (dedupe_key) WHERE status NOT IN ('CLOSED');
CREATE INDEX cases_ix1 ON cases (student_id);
CREATE INDEX cases_ix2 ON cases (owner_user_id);
CREATE INDEX cases_ix3 ON cases (dedupe_key);
CREATE INDEX cases_ix4 ON cases (status, due_at);
CREATE INDEX cases_ix5 ON cases (rule_version_id);
CREATE INDEX cases_ix6 ON cases (closed_by);

-- CaseEvents: ประวัติเรื่องติดตาม (append-only)
CREATE TABLE case_events (
  id uuid NOT NULL PRIMARY KEY,
  case_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  data_json jsonb,
  note text,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT case_events_ck1 CHECK (event_type IN ('OPENED', 'ASSIGNED', 'NOTE', 'CONTACT_LOGGED', 'APPOINTMENT_SET', 'STATUS_CHANGED', 'TRANSFERRED', 'CLOSED', 'REOPENED', 'CALLBACK_REQUESTED')),
  CONSTRAINT case_events_ck2 CHECK (char_length(note) <= 2000),
  CONSTRAINT case_events_ck3 CHECK (note <> '')
);
CREATE TRIGGER case_events_append_only BEFORE UPDATE OR DELETE ON case_events FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE INDEX case_events_ix1 ON case_events (case_id);
CREATE INDEX case_events_ix2 ON case_events (actor_id);

-- ContactLogs: บันทึกการติดต่อ (การกดปุ่มโทรไม่ถือว่าโทรสำเร็จจนบันทึกผล)
CREATE TABLE contact_logs (
  id uuid NOT NULL PRIMARY KEY,
  student_id uuid NOT NULL,
  case_id uuid,
  guardian_id uuid,
  channel text NOT NULL,
  direction text NOT NULL,
  contacted_at timestamptz NOT NULL,
  contacted_by uuid NOT NULL,
  outcome text NOT NULL,
  summary text,
  follow_up_required boolean NOT NULL,
  next_follow_up_at timestamptz,
  supersedes_id uuid,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT contact_logs_ck1 CHECK (channel IN ('PHONE', 'EMAIL', 'LINE', 'SMS', 'IN_PERSON', 'OTHER')),
  CONSTRAINT contact_logs_ck2 CHECK (direction IN ('OUTBOUND', 'INBOUND')),
  CONSTRAINT contact_logs_ck3 CHECK (outcome IN ('REACHED', 'NO_ANSWER', 'ACKNOWLEDGED', 'APPOINTMENT_MADE', 'FOLLOW_UP_NEEDED', 'WRONG_CONTACT', 'ASSISTANCE_PROVIDED')),
  CONSTRAINT contact_logs_ck4 CHECK (char_length(summary) <= 2000),
  CONSTRAINT contact_logs_ck5 CHECK (summary <> '')
);
CREATE TRIGGER contact_logs_append_only BEFORE UPDATE OR DELETE ON contact_logs FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE INDEX contact_logs_ix1 ON contact_logs (student_id);
CREATE INDEX contact_logs_ix2 ON contact_logs (case_id);
CREATE INDEX contact_logs_ix3 ON contact_logs (supersedes_id);
CREATE INDEX contact_logs_ix4 ON contact_logs (direction);
CREATE INDEX contact_logs_ix5 ON contact_logs (guardian_id);
CREATE INDEX contact_logs_ix6 ON contact_logs (contacted_by);

-- Appointments: นัดหมาย
CREATE TABLE appointments (
  id uuid NOT NULL PRIMARY KEY,
  case_id uuid,
  student_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  duration_minutes integer,
  location text,
  attendees_note text,
  status text NOT NULL,
  outcome_note text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT appointments_ck1 CHECK (duration_minutes >= 5),
  CONSTRAINT appointments_ck2 CHECK (duration_minutes <= 600),
  CONSTRAINT appointments_ck3 CHECK (char_length(location) <= 200),
  CONSTRAINT appointments_ck4 CHECK (location <> ''),
  CONSTRAINT appointments_ck5 CHECK (char_length(attendees_note) <= 500),
  CONSTRAINT appointments_ck6 CHECK (attendees_note <> ''),
  CONSTRAINT appointments_ck7 CHECK (status IN ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED')),
  CONSTRAINT appointments_ck8 CHECK (char_length(outcome_note) <= 2000),
  CONSTRAINT appointments_ck9 CHECK (outcome_note <> ''),
  CONSTRAINT appointments_ck10 CHECK (version >= 1)
);
CREATE INDEX appointments_ix1 ON appointments (case_id);
CREATE INDEX appointments_ix2 ON appointments (student_id);

-- Attachments: ไฟล์แนบเชิงตรรกะ (logical_file_id = id) ไม่ผูกกับ Drive URL; provider object อยู่ใน StorageObjectMappings
CREATE TABLE attachments (
  id uuid NOT NULL PRIMARY KEY,
  school_id uuid NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  classification text NOT NULL,
  status text NOT NULL,
  uploaded_by uuid NOT NULL,
  uploaded_at timestamptz NOT NULL,
  linked_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid,
  retention_until date,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT attachments_ck1 CHECK (char_length(original_filename) <= 255),
  CONSTRAINT attachments_ck2 CHECK (original_filename <> ''),
  CONSTRAINT attachments_ck3 CHECK (char_length(mime_type) <= 100),
  CONSTRAINT attachments_ck4 CHECK (mime_type <> ''),
  CONSTRAINT attachments_ck5 CHECK (size_bytes >= 0),
  CONSTRAINT attachments_ck6 CHECK (char_length(sha256) <= 64),
  CONSTRAINT attachments_ck7 CHECK (sha256 <> ''),
  CONSTRAINT attachments_ck8 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT attachments_ck9 CHECK (classification IN ('GENERAL', 'MEDICAL', 'PHOTO', 'REPORT', 'EXPORT', 'IMPORT_SOURCE')),
  CONSTRAINT attachments_ck10 CHECK (status IN ('STAGED', 'ACTIVE', 'DELETED', 'QUARANTINED')),
  CONSTRAINT attachments_ck11 CHECK (version >= 1)
);
CREATE INDEX attachments_ix1 ON attachments (status, uploaded_at);
CREATE INDEX attachments_ix2 ON attachments (school_id);
CREATE INDEX attachments_ix3 ON attachments (uploaded_by);
CREATE INDEX attachments_ix4 ON attachments (deleted_by);

-- AttachmentLinks: ความสัมพันธ์ไฟล์ ↔ entity
CREATE TABLE attachment_links (
  id uuid NOT NULL PRIMARY KEY,
  attachment_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  purpose text NOT NULL,
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL,
  unlinked_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT attachment_links_ck1 CHECK (entity_type IN ('STUDENT', 'LEAVE_REQUEST', 'CASE', 'CONTACT_LOG', 'IMPORT_BATCH', 'REPORT_RUN', 'ATTENDANCE_CORRECTION', 'SCHOOL', 'MIGRATION_RUN', 'BACKUP_RUN')),
  CONSTRAINT attachment_links_ck2 CHECK (char_length(purpose) <= 50),
  CONSTRAINT attachment_links_ck3 CHECK (purpose <> ''),
  CONSTRAINT attachment_links_ck4 CHECK (version >= 1)
);
CREATE INDEX attachment_links_ix1 ON attachment_links (attachment_id);
CREATE INDEX attachment_links_ix2 ON attachment_links (entity_id);
CREATE INDEX attachment_links_ix3 ON attachment_links (linked_by);

-- StorageObjectMappings: logical file ID → provider object (Drive file ID / path) เปลี่ยนเมื่อย้ายที่เก็บ
CREATE TABLE storage_object_mappings (
  id uuid NOT NULL PRIMARY KEY,
  attachment_id uuid NOT NULL,
  provider text NOT NULL,
  object_key text NOT NULL,
  container text,
  status text NOT NULL,
  sha256_verified_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT storage_object_mappings_ck1 CHECK (provider IN ('GOOGLE_DRIVE', 'FILESYSTEM', 'OBJECT_STORAGE')),
  CONSTRAINT storage_object_mappings_ck2 CHECK (char_length(object_key) <= 500),
  CONSTRAINT storage_object_mappings_ck3 CHECK (object_key <> ''),
  CONSTRAINT storage_object_mappings_ck4 CHECK (char_length(container) <= 300),
  CONSTRAINT storage_object_mappings_ck5 CHECK (container <> ''),
  CONSTRAINT storage_object_mappings_ck6 CHECK (status IN ('ACTIVE', 'READONLY', 'ARCHIVED')),
  CONSTRAINT storage_object_mappings_ck7 CHECK (version >= 1)
);
CREATE UNIQUE INDEX storage_object_mappings_uq1 ON storage_object_mappings (provider, object_key);
CREATE INDEX storage_object_mappings_ix1 ON storage_object_mappings (attachment_id);

-- Notifications: การแจ้งเตือนที่สร้างจากเหตุการณ์ที่ commit แล้ว (เนื้อหาขั้นต่ำ + template version)
CREATE TABLE notifications (
  id uuid NOT NULL PRIMARY KEY,
  notification_type text NOT NULL,
  source_entity_type text NOT NULL,
  source_entity_id uuid NOT NULL,
  source_operation_id uuid NOT NULL,
  student_id uuid,
  template_key text NOT NULL,
  template_version integer NOT NULL,
  params_json jsonb NOT NULL,
  urgency text NOT NULL,
  audience_scope text NOT NULL,
  suppressed boolean NOT NULL,
  suppress_reason text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT notifications_ck1 CHECK (notification_type IN ('LEAVE_NEW', 'LEAVE_PENDING_GUARDIAN', 'LEAVE_PENDING_SCHOOL', 'LEAVE_DECIDED', 'LATE_CONFIRMED', 'ABSENCE_CONFIRMED', 'CASE_NEW', 'CASE_OVERDUE', 'CALLBACK_REQUESTED', 'DATA_CORRECTED', 'ROLL_CALL_REMINDER', 'SYSTEM')),
  CONSTRAINT notifications_ck2 CHECK (char_length(source_entity_type) <= 40),
  CONSTRAINT notifications_ck3 CHECK (source_entity_type <> ''),
  CONSTRAINT notifications_ck4 CHECK (char_length(template_key) <= 60),
  CONSTRAINT notifications_ck5 CHECK (template_key <> ''),
  CONSTRAINT notifications_ck6 CHECK (template_version >= 1),
  CONSTRAINT notifications_ck7 CHECK (urgency IN ('NORMAL', 'URGENT')),
  CONSTRAINT notifications_ck8 CHECK (char_length(audience_scope) <= 40),
  CONSTRAINT notifications_ck9 CHECK (audience_scope <> ''),
  CONSTRAINT notifications_ck10 CHECK (char_length(suppress_reason) <= 200),
  CONSTRAINT notifications_ck11 CHECK (suppress_reason <> '')
);
CREATE TRIGGER notifications_append_only BEFORE UPDATE OR DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE INDEX notifications_ix1 ON notifications (source_entity_id);
CREATE INDEX notifications_ix2 ON notifications (student_id);

-- NotificationRecipients: ผู้รับ (resolve จากความสัมพันธ์ที่ยืนยันแล้ว) = กล่องแจ้งเตือนในแอป และสถานะการรับทราบ
CREATE TABLE notification_recipients (
  id uuid NOT NULL PRIMARY KEY,
  notification_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  recipient_role_context text NOT NULL,
  in_app_state text NOT NULL,
  read_at timestamptz,
  ack_required boolean NOT NULL,
  ack_state text NOT NULL,
  ack_due_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT notification_recipients_ck1 CHECK (recipient_role_context IN ('SYSTEM_ADMIN', 'STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF', 'GUARDIAN', 'STUDENT')),
  CONSTRAINT notification_recipients_ck2 CHECK (in_app_state IN ('UNREAD', 'READ')),
  CONSTRAINT notification_recipients_ck3 CHECK (ack_state IN ('NOT_REQUIRED', 'PENDING_ACK', 'ACKNOWLEDGED', 'FOLLOW_UP_REQUIRED')),
  CONSTRAINT notification_recipients_ck4 CHECK (version >= 1)
);
CREATE UNIQUE INDEX notification_recipients_uq1 ON notification_recipients (notification_id, recipient_user_id);
CREATE INDEX notification_recipients_ix1 ON notification_recipients (recipient_user_id);
CREATE INDEX notification_recipients_ix2 ON notification_recipients (notification_id);
CREATE INDEX notification_recipients_ix3 ON notification_recipients (ack_state);

-- NotificationOutbox: คิวส่งภายนอก (email/LINE/SMS) แยก delivery state ออกจากการรับทราบ; dedupe_key กันส่งซ้ำ
CREATE TABLE notification_outbox (
  id uuid NOT NULL PRIMARY KEY,
  notification_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  channel text NOT NULL,
  dedupe_key text NOT NULL,
  delivery_state text NOT NULL,
  attempts integer NOT NULL,
  max_attempts integer NOT NULL,
  next_attempt_at timestamptz,
  lease_until timestamptz,
  lease_owner text,
  retry_key uuid,
  retry_key_created_at timestamptz,
  provider_request_id text,
  provider_message_id text,
  last_error_code text,
  last_error_message text,
  accepted_at timestamptz,
  resend_of_outbox_id uuid,
  held_reason text,
  replay_blocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT notification_outbox_ck1 CHECK (channel IN ('EMAIL', 'LINE', 'SMS')),
  CONSTRAINT notification_outbox_ck2 CHECK (char_length(dedupe_key) <= 300),
  CONSTRAINT notification_outbox_ck3 CHECK (dedupe_key <> ''),
  CONSTRAINT notification_outbox_ck4 CHECK (delivery_state IN ('QUEUED', 'PROCESSING', 'PROVIDER_ACCEPTED', 'RETRY_WAIT', 'FAILED_FINAL', 'CANCELLED')),
  CONSTRAINT notification_outbox_ck5 CHECK (attempts >= 0),
  CONSTRAINT notification_outbox_ck6 CHECK (max_attempts >= 1),
  CONSTRAINT notification_outbox_ck7 CHECK (char_length(lease_owner) <= 100),
  CONSTRAINT notification_outbox_ck8 CHECK (lease_owner <> ''),
  CONSTRAINT notification_outbox_ck9 CHECK (char_length(provider_request_id) <= 200),
  CONSTRAINT notification_outbox_ck10 CHECK (provider_request_id <> ''),
  CONSTRAINT notification_outbox_ck11 CHECK (char_length(provider_message_id) <= 200),
  CONSTRAINT notification_outbox_ck12 CHECK (provider_message_id <> ''),
  CONSTRAINT notification_outbox_ck13 CHECK (char_length(last_error_code) <= 60),
  CONSTRAINT notification_outbox_ck14 CHECK (last_error_code <> ''),
  CONSTRAINT notification_outbox_ck15 CHECK (char_length(last_error_message) <= 500),
  CONSTRAINT notification_outbox_ck16 CHECK (last_error_message <> ''),
  CONSTRAINT notification_outbox_ck17 CHECK (char_length(held_reason) <= 60),
  CONSTRAINT notification_outbox_ck18 CHECK (held_reason <> ''),
  CONSTRAINT notification_outbox_ck19 CHECK (version >= 1)
);
CREATE UNIQUE INDEX notification_outbox_uq1 ON notification_outbox (dedupe_key);
CREATE INDEX notification_outbox_ix1 ON notification_outbox (dedupe_key);
CREATE INDEX notification_outbox_ix2 ON notification_outbox (notification_id);
CREATE INDEX notification_outbox_ix3 ON notification_outbox (delivery_state);
CREATE INDEX notification_outbox_ix4 ON notification_outbox (delivery_state, next_attempt_at);
CREATE INDEX notification_outbox_ix5 ON notification_outbox (recipient_id);
CREATE INDEX notification_outbox_ix6 ON notification_outbox (recipient_user_id);
CREATE INDEX notification_outbox_ix7 ON notification_outbox (resend_of_outbox_id);

-- NotificationAttempts: ผลการเรียกผู้ให้บริการแต่ละครั้ง (append-only)
CREATE TABLE notification_attempts (
  id uuid NOT NULL PRIMARY KEY,
  outbox_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  result text NOT NULL,
  http_status integer,
  provider_request_id text,
  error_code text,
  error_message text,
  retry_key uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT notification_attempts_ck1 CHECK (attempt_no >= 1),
  CONSTRAINT notification_attempts_ck2 CHECK (result IN ('ACCEPTED', 'DUPLICATE_ACCEPTED', 'RETRYABLE_ERROR', 'FINAL_ERROR', 'OUTCOME_UNKNOWN', 'SKIPPED')),
  CONSTRAINT notification_attempts_ck3 CHECK (char_length(provider_request_id) <= 200),
  CONSTRAINT notification_attempts_ck4 CHECK (provider_request_id <> ''),
  CONSTRAINT notification_attempts_ck5 CHECK (char_length(error_code) <= 60),
  CONSTRAINT notification_attempts_ck6 CHECK (error_code <> ''),
  CONSTRAINT notification_attempts_ck7 CHECK (char_length(error_message) <= 500),
  CONSTRAINT notification_attempts_ck8 CHECK (error_message <> '')
);
CREATE TRIGGER notification_attempts_append_only BEFORE UPDATE OR DELETE ON notification_attempts FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE INDEX notification_attempts_ix1 ON notification_attempts (outbox_id);

-- Acknowledgements: การกดรับทราบ/ขอให้ติดต่อกลับจริงของผู้รับ (ผูก identity และ notification)
CREATE TABLE acknowledgements (
  id uuid NOT NULL PRIMARY KEY,
  recipient_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL,
  channel text NOT NULL,
  acted_at timestamptz NOT NULL,
  note text,
  case_id uuid,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT acknowledgements_ck1 CHECK (action IN ('ACKNOWLEDGED', 'CALLBACK_REQUESTED')),
  CONSTRAINT acknowledgements_ck2 CHECK (channel IN ('IN_APP', 'LINE')),
  CONSTRAINT acknowledgements_ck3 CHECK (char_length(note) <= 1000),
  CONSTRAINT acknowledgements_ck4 CHECK (note <> '')
);
CREATE TRIGGER acknowledgements_append_only BEFORE UPDATE OR DELETE ON acknowledgements FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE UNIQUE INDEX acknowledgements_uq1 ON acknowledgements (recipient_id, action);
CREATE INDEX acknowledgements_ix1 ON acknowledgements (recipient_id);
CREATE INDEX acknowledgements_ix2 ON acknowledgements (notification_id);
CREATE INDEX acknowledgements_ix3 ON acknowledgements (user_id);
CREATE INDEX acknowledgements_ix4 ON acknowledgements (case_id);

-- ChannelBindings: การผูกช่องทาง LINE/อีเมลกับบัญชีแอป (แยกจากการยืนยันความสัมพันธ์ผู้ปกครอง-นักเรียน)
CREATE TABLE channel_bindings (
  id uuid NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL,
  channel text NOT NULL,
  address text,
  status text NOT NULL,
  link_nonce_hash text,
  link_expires_at timestamptz,
  verified_at timestamptz,
  verified_via text,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT channel_bindings_ck1 CHECK (channel IN ('EMAIL', 'LINE', 'SMS')),
  CONSTRAINT channel_bindings_ck2 CHECK (char_length(address) <= 254),
  CONSTRAINT channel_bindings_ck3 CHECK (address <> ''),
  CONSTRAINT channel_bindings_ck4 CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  CONSTRAINT channel_bindings_ck5 CHECK (char_length(link_nonce_hash) <= 64),
  CONSTRAINT channel_bindings_ck6 CHECK (link_nonce_hash <> ''),
  CONSTRAINT channel_bindings_ck7 CHECK (verified_via IN ('LINE_ACCOUNT_LINK', 'IDP_VERIFIED_EMAIL', 'STAFF_VERIFIED')),
  CONSTRAINT channel_bindings_ck8 CHECK (char_length(revoke_reason) <= 300),
  CONSTRAINT channel_bindings_ck9 CHECK (revoke_reason <> ''),
  CONSTRAINT channel_bindings_ck10 CHECK (version >= 1)
);
CREATE UNIQUE INDEX channel_bindings_uq1 ON channel_bindings (channel, address) WHERE status = 'ACTIVE';
CREATE INDEX channel_bindings_ix1 ON channel_bindings (user_id);
CREATE INDEX channel_bindings_ix2 ON channel_bindings (address);
CREATE INDEX channel_bindings_ix3 ON channel_bindings (link_nonce_hash);
CREATE INDEX channel_bindings_ix4 ON channel_bindings (revoked_by);

-- WebhookInbox: เหตุการณ์ webhook ที่ผ่านการตรวจลายเซ็นจาก gateway แล้ว บันทึกถาวรก่อนตอบรับ (dedupe ด้วย webhook_event_id)
CREATE TABLE webhook_inbox (
  id uuid NOT NULL PRIMARY KEY,
  source text NOT NULL,
  webhook_event_id text NOT NULL,
  received_at timestamptz NOT NULL,
  envelope_ts timestamptz NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL,
  processed_at timestamptz,
  attempts integer NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT webhook_inbox_ck1 CHECK (char_length(source) <= 20),
  CONSTRAINT webhook_inbox_ck2 CHECK (source <> ''),
  CONSTRAINT webhook_inbox_ck3 CHECK (char_length(webhook_event_id) <= 100),
  CONSTRAINT webhook_inbox_ck4 CHECK (webhook_event_id <> ''),
  CONSTRAINT webhook_inbox_ck5 CHECK (char_length(event_type) <= 40),
  CONSTRAINT webhook_inbox_ck6 CHECK (event_type <> ''),
  CONSTRAINT webhook_inbox_ck7 CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
  CONSTRAINT webhook_inbox_ck8 CHECK (attempts >= 0),
  CONSTRAINT webhook_inbox_ck9 CHECK (char_length(last_error) <= 500),
  CONSTRAINT webhook_inbox_ck10 CHECK (last_error <> ''),
  CONSTRAINT webhook_inbox_ck11 CHECK (version >= 1)
);
CREATE UNIQUE INDEX webhook_inbox_uq1 ON webhook_inbox (source, webhook_event_id);
CREATE INDEX webhook_inbox_ix1 ON webhook_inbox (webhook_event_id);
CREATE INDEX webhook_inbox_ix2 ON webhook_inbox (status);

-- MutationJournal: redo journal ของ Sheets adapter: PREPARED → COMMITTED; recovery ทำซ้ำได้อย่างปลอดภัย (ไม่ export ข้อมูลในเซลล์ writes_json เกินจำเป็น)
CREATE TABLE mutation_journal (
  id uuid NOT NULL PRIMARY KEY,
  operation_id uuid NOT NULL,
  operation text NOT NULL,
  actor_id uuid NOT NULL,
  request_id uuid,
  status text NOT NULL,
  part_no integer NOT NULL,
  part_count integer NOT NULL,
  writes_json text NOT NULL,
  prepared_at timestamptz NOT NULL,
  committed_at timestamptz,
  recovered_at timestamptz,
  recovery_attempts integer NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT mutation_journal_ck1 CHECK (char_length(operation) <= 80),
  CONSTRAINT mutation_journal_ck2 CHECK (operation <> ''),
  CONSTRAINT mutation_journal_ck3 CHECK (status IN ('PREPARED', 'COMMITTED', 'RECOVERY_REQUIRED', 'ABORTED')),
  CONSTRAINT mutation_journal_ck4 CHECK (part_no >= 1),
  CONSTRAINT mutation_journal_ck5 CHECK (part_count >= 1),
  CONSTRAINT mutation_journal_ck6 CHECK (char_length(writes_json) <= 45000),
  CONSTRAINT mutation_journal_ck7 CHECK (writes_json <> ''),
  CONSTRAINT mutation_journal_ck8 CHECK (recovery_attempts >= 0),
  CONSTRAINT mutation_journal_ck9 CHECK (char_length(last_error) <= 500),
  CONSTRAINT mutation_journal_ck10 CHECK (last_error <> ''),
  CONSTRAINT mutation_journal_ck11 CHECK (version >= 1)
);
CREATE UNIQUE INDEX mutation_journal_uq1 ON mutation_journal (operation_id, part_no);
CREATE INDEX mutation_journal_ix1 ON mutation_journal (operation_id);
CREATE INDEX mutation_journal_ix2 ON mutation_journal (status);
CREATE INDEX mutation_journal_ix3 ON mutation_journal (actor_id);

-- IdempotencyRecords: ผลของคำสั่งตาม (actor, operation, idempotency_key) เพื่อคืนผลเดิมเมื่อส่งซ้ำ
CREATE TABLE idempotency_records (
  id uuid NOT NULL PRIMARY KEY,
  scope_key text NOT NULL,
  actor_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  result_json jsonb NOT NULL,
  operation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT idempotency_records_ck1 CHECK (char_length(scope_key) <= 64),
  CONSTRAINT idempotency_records_ck2 CHECK (scope_key <> ''),
  CONSTRAINT idempotency_records_ck3 CHECK (char_length(operation) <= 80),
  CONSTRAINT idempotency_records_ck4 CHECK (operation <> ''),
  CONSTRAINT idempotency_records_ck5 CHECK (char_length(idempotency_key) <= 100),
  CONSTRAINT idempotency_records_ck6 CHECK (idempotency_key <> ''),
  CONSTRAINT idempotency_records_ck7 CHECK (char_length(request_hash) <= 64),
  CONSTRAINT idempotency_records_ck8 CHECK (request_hash <> '')
);
CREATE UNIQUE INDEX idempotency_records_uq1 ON idempotency_records (scope_key);
CREATE INDEX idempotency_records_ix1 ON idempotency_records (scope_key);
CREATE INDEX idempotency_records_ix2 ON idempotency_records (actor_id);

-- AuditEvents: Audit (append-only) ใคร ทำอะไร เมื่อใด เหตุผล ค่าเดิม/ใหม่ (ปิดบังฟิลด์อ่อนไหว) — ไม่ tamper-proof เมื่อผู้แก้ไข Sheet ยังแก้ได้
CREATE TABLE audit_events (
  id uuid NOT NULL PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor_id uuid NOT NULL,
  actor_roles text,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  student_id uuid,
  operation_id uuid,
  request_id uuid,
  channel text NOT NULL,
  reason text,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT audit_events_ck1 CHECK (char_length(actor_roles) <= 200),
  CONSTRAINT audit_events_ck2 CHECK (actor_roles <> ''),
  CONSTRAINT audit_events_ck3 CHECK (char_length(action) <= 80),
  CONSTRAINT audit_events_ck4 CHECK (action <> ''),
  CONSTRAINT audit_events_ck5 CHECK (char_length(entity_type) <= 40),
  CONSTRAINT audit_events_ck6 CHECK (entity_type <> ''),
  CONSTRAINT audit_events_ck7 CHECK (channel IN ('APP', 'JOB', 'WEBHOOK', 'EDITOR', 'MIGRATION', 'API')),
  CONSTRAINT audit_events_ck8 CHECK (char_length(reason) <= 1000),
  CONSTRAINT audit_events_ck9 CHECK (reason <> '')
);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE INDEX audit_events_ix1 ON audit_events (entity_id);
CREATE INDEX audit_events_ix2 ON audit_events (actor_id);
CREATE INDEX audit_events_ix3 ON audit_events (student_id);

-- Jobs: งานเบื้องหลังถาวร: lease, cursor/checkpoint, retry (ไม่ใช้ CacheService)
CREATE TABLE jobs (
  id uuid NOT NULL PRIMARY KEY,
  job_type text NOT NULL,
  status text NOT NULL,
  priority integer NOT NULL,
  payload_json jsonb NOT NULL,
  progress_json jsonb,
  cursor_json jsonb,
  attempts integer NOT NULL,
  max_attempts integer NOT NULL,
  next_run_at timestamptz NOT NULL,
  lease_until timestamptz,
  lease_owner text,
  heartbeat_at timestamptz,
  last_error text,
  owner_user_id uuid NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  result_json jsonb,
  dedupe_key text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT jobs_ck1 CHECK (char_length(job_type) <= 60),
  CONSTRAINT jobs_ck2 CHECK (job_type <> ''),
  CONSTRAINT jobs_ck3 CHECK (status IN ('QUEUED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  CONSTRAINT jobs_ck4 CHECK (priority >= 0),
  CONSTRAINT jobs_ck5 CHECK (priority <= 9),
  CONSTRAINT jobs_ck6 CHECK (attempts >= 0),
  CONSTRAINT jobs_ck7 CHECK (max_attempts >= 1),
  CONSTRAINT jobs_ck8 CHECK (char_length(lease_owner) <= 100),
  CONSTRAINT jobs_ck9 CHECK (lease_owner <> ''),
  CONSTRAINT jobs_ck10 CHECK (char_length(last_error) <= 1000),
  CONSTRAINT jobs_ck11 CHECK (last_error <> ''),
  CONSTRAINT jobs_ck12 CHECK (char_length(dedupe_key) <= 200),
  CONSTRAINT jobs_ck13 CHECK (dedupe_key <> ''),
  CONSTRAINT jobs_ck14 CHECK (version >= 1)
);
CREATE UNIQUE INDEX jobs_uq1 ON jobs (dedupe_key) WHERE status IN ('QUEUED','RUNNING','PAUSED');
CREATE INDEX jobs_ix1 ON jobs (dedupe_key);
CREATE INDEX jobs_ix2 ON jobs (owner_user_id);
CREATE INDEX jobs_ix3 ON jobs (status, next_run_at);

-- ImportBatches: ชุดนำเข้า CSV/XLSX พร้อม mapping, dry-run และผลลัพธ์
CREATE TABLE import_batches (
  id uuid NOT NULL PRIMARY KEY,
  import_type text NOT NULL,
  source_attachment_id uuid,
  source_format text NOT NULL,
  mapping_json jsonb,
  status text NOT NULL,
  dry_run_summary_json jsonb,
  row_count integer,
  valid_count integer,
  error_count integer,
  applied_count integer,
  job_id uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT import_batches_ck1 CHECK (import_type IN ('STUDENTS', 'CLASSES', 'ENROLLMENTS', 'GUARDIANS', 'STAFF', 'CALENDAR')),
  CONSTRAINT import_batches_ck2 CHECK (source_format IN ('CSV', 'XLSX')),
  CONSTRAINT import_batches_ck3 CHECK (status IN ('UPLOADED', 'PREVIEWED', 'VALIDATED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED')),
  CONSTRAINT import_batches_ck4 CHECK (row_count >= 0),
  CONSTRAINT import_batches_ck5 CHECK (valid_count >= 0),
  CONSTRAINT import_batches_ck6 CHECK (error_count >= 0),
  CONSTRAINT import_batches_ck7 CHECK (applied_count >= 0),
  CONSTRAINT import_batches_ck8 CHECK (version >= 1)
);
CREATE INDEX import_batches_ix1 ON import_batches (source_attachment_id);
CREATE INDEX import_batches_ix2 ON import_batches (job_id);

-- ImportErrors: ข้อผิดพลาดรายแถวของการนำเข้า
CREATE TABLE import_errors (
  id uuid NOT NULL PRIMARY KEY,
  import_batch_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  row_no integer NOT NULL,
  column_name text,
  error_code text NOT NULL,
  message_th text NOT NULL,
  raw_value_redacted text,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT import_errors_ck1 CHECK (attempt_no >= 1),
  CONSTRAINT import_errors_ck2 CHECK (row_no >= 1),
  CONSTRAINT import_errors_ck3 CHECK (char_length(column_name) <= 100),
  CONSTRAINT import_errors_ck4 CHECK (column_name <> ''),
  CONSTRAINT import_errors_ck5 CHECK (char_length(error_code) <= 60),
  CONSTRAINT import_errors_ck6 CHECK (error_code <> ''),
  CONSTRAINT import_errors_ck7 CHECK (char_length(message_th) <= 500),
  CONSTRAINT import_errors_ck8 CHECK (message_th <> ''),
  CONSTRAINT import_errors_ck9 CHECK (char_length(raw_value_redacted) <= 200),
  CONSTRAINT import_errors_ck10 CHECK (raw_value_redacted <> '')
);
CREATE TRIGGER import_errors_append_only BEFORE UPDATE OR DELETE ON import_errors FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE INDEX import_errors_ix1 ON import_errors (import_batch_id);

-- MigrationRuns: งานส่งออก/นำเข้า/กระทบยอด/สลับระบบ พร้อม state machine
CREATE TABLE migration_runs (
  id uuid NOT NULL PRIMARY KEY,
  run_type text NOT NULL,
  mode text NOT NULL,
  state text NOT NULL,
  snapshot_id uuid,
  package_location text,
  manifest_sha256 text,
  completeness text,
  scope_json jsonb,
  high_water_marks_json jsonb,
  started_by uuid NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  summary_json jsonb,
  job_id uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT migration_runs_ck1 CHECK (run_type IN ('EXPORT', 'VALIDATE', 'IMPORT_SHEETS', 'IMPORT_POSTGRES', 'RECONCILE', 'CUTOVER', 'ROLLBACK')),
  CONSTRAINT migration_runs_ck2 CHECK (mode IN ('FULL_SNAPSHOT', 'PARTIAL', 'REPORT_EXPORT', 'REHEARSAL')),
  CONSTRAINT migration_runs_ck3 CHECK (state IN ('PLANNED', 'SNAPSHOTTING', 'EXPORTED', 'VALIDATED', 'STAGED', 'RECONCILED', 'CUTOVER_READY', 'ACTIVE', 'ROLLED_BACK', 'FAILED', 'CANCELLED')),
  CONSTRAINT migration_runs_ck4 CHECK (char_length(package_location) <= 300),
  CONSTRAINT migration_runs_ck5 CHECK (package_location <> ''),
  CONSTRAINT migration_runs_ck6 CHECK (char_length(manifest_sha256) <= 64),
  CONSTRAINT migration_runs_ck7 CHECK (manifest_sha256 <> ''),
  CONSTRAINT migration_runs_ck8 CHECK (completeness IN ('COMPLETE', 'PARTIAL', 'FAILED')),
  CONSTRAINT migration_runs_ck9 CHECK (version >= 1)
);
CREATE INDEX migration_runs_ix1 ON migration_runs (started_by);
CREATE INDEX migration_runs_ix2 ON migration_runs (job_id);

-- MigrationCheckpoints: checkpoint ราย table/partition/chunk สำหรับ resume
CREATE TABLE migration_checkpoints (
  id uuid NOT NULL PRIMARY KEY,
  migration_run_id uuid NOT NULL,
  step text NOT NULL,
  table_name text,
  partition_key text,
  cursor_json jsonb,
  rows_done integer NOT NULL,
  chunk_no integer,
  chunk_sha256 text,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT migration_checkpoints_ck1 CHECK (char_length(step) <= 40),
  CONSTRAINT migration_checkpoints_ck2 CHECK (step <> ''),
  CONSTRAINT migration_checkpoints_ck3 CHECK (char_length(table_name) <= 60),
  CONSTRAINT migration_checkpoints_ck4 CHECK (table_name <> ''),
  CONSTRAINT migration_checkpoints_ck5 CHECK (char_length(partition_key) <= 30),
  CONSTRAINT migration_checkpoints_ck6 CHECK (partition_key <> ''),
  CONSTRAINT migration_checkpoints_ck7 CHECK (rows_done >= 0),
  CONSTRAINT migration_checkpoints_ck8 CHECK (chunk_no >= 0),
  CONSTRAINT migration_checkpoints_ck9 CHECK (char_length(chunk_sha256) <= 64),
  CONSTRAINT migration_checkpoints_ck10 CHECK (chunk_sha256 <> ''),
  CONSTRAINT migration_checkpoints_ck11 CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT migration_checkpoints_ck12 CHECK (version >= 1)
);
CREATE INDEX migration_checkpoints_ix1 ON migration_checkpoints (migration_run_id);

-- BackupRuns: ประวัติการสำรองข้อมูลและผลทดสอบ restore
CREATE TABLE backup_runs (
  id uuid NOT NULL PRIMARY KEY,
  backup_type text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  package_location text,
  manifest_sha256 text,
  row_counts_json jsonb,
  retention_until date,
  restore_tested_at timestamptz,
  restore_result text,
  migration_run_id uuid,
  job_id uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT backup_runs_ck1 CHECK (backup_type IN ('NIGHTLY_SNAPSHOT', 'MANUAL')),
  CONSTRAINT backup_runs_ck2 CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT backup_runs_ck3 CHECK (char_length(package_location) <= 300),
  CONSTRAINT backup_runs_ck4 CHECK (package_location <> ''),
  CONSTRAINT backup_runs_ck5 CHECK (char_length(manifest_sha256) <= 64),
  CONSTRAINT backup_runs_ck6 CHECK (manifest_sha256 <> ''),
  CONSTRAINT backup_runs_ck7 CHECK (char_length(restore_result) <= 1000),
  CONSTRAINT backup_runs_ck8 CHECK (restore_result <> ''),
  CONSTRAINT backup_runs_ck9 CHECK (version >= 1)
);
CREATE INDEX backup_runs_ix1 ON backup_runs (migration_run_id);
CREATE INDEX backup_runs_ix2 ON backup_runs (job_id);

-- ChangeLog: ลำดับการเปลี่ยนแปลงต่อ operation (insert/update/tombstone) สำหรับ incremental export/delta; seq เพิ่มขึ้นเสมอ
CREATE TABLE change_log (
  id uuid NOT NULL PRIMARY KEY,
  seq integer NOT NULL,
  operation_id uuid NOT NULL,
  operation text NOT NULL,
  committed_at timestamptz NOT NULL,
  changes_json jsonb NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT change_log_ck1 CHECK (seq >= 1),
  CONSTRAINT change_log_ck2 CHECK (char_length(operation) <= 80),
  CONSTRAINT change_log_ck3 CHECK (operation <> '')
);
CREATE TRIGGER change_log_append_only BEFORE UPDATE OR DELETE ON change_log FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();
CREATE UNIQUE INDEX change_log_uq1 ON change_log (seq);
CREATE INDEX change_log_ix1 ON change_log (operation_id);
CREATE INDEX change_log_ix2 ON change_log (actor_id);

-- ReportRuns: การออกรายงาน: filter, as_of, schema/rule version, ผู้สร้าง, การล็อกรอบ และ revision
CREATE TABLE report_runs (
  id uuid NOT NULL PRIMARY KEY,
  report_code text NOT NULL,
  filter_json jsonb NOT NULL,
  as_of timestamptz NOT NULL,
  schema_version integer NOT NULL,
  rule_versions_json jsonb,
  status text NOT NULL,
  output_format text NOT NULL,
  output_attachment_id uuid,
  row_count integer,
  totals_json jsonb,
  locked boolean NOT NULL,
  locked_by uuid,
  locked_at timestamptz,
  supersedes_run_id uuid,
  superseded_by_run_id uuid,
  requested_by uuid NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  version integer NOT NULL,
  CONSTRAINT report_runs_ck1 CHECK (report_code IN ('R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12')),
  CONSTRAINT report_runs_ck2 CHECK (schema_version >= 1),
  CONSTRAINT report_runs_ck3 CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'SUPERSEDED')),
  CONSTRAINT report_runs_ck4 CHECK (output_format IN ('JSON', 'CSV', 'XLSX', 'PDF')),
  CONSTRAINT report_runs_ck5 CHECK (row_count >= 0),
  CONSTRAINT report_runs_ck6 CHECK (version >= 1)
);
CREATE INDEX report_runs_ix1 ON report_runs (report_code, as_of);
CREATE INDEX report_runs_ix2 ON report_runs (output_attachment_id);
CREATE INDEX report_runs_ix3 ON report_runs (locked_by);
CREATE INDEX report_runs_ix4 ON report_runs (supersedes_run_id);
CREATE INDEX report_runs_ix5 ON report_runs (superseded_by_run_id);
CREATE INDEX report_runs_ix6 ON report_runs (requested_by);
CREATE INDEX report_runs_ix7 ON report_runs (job_id);

-- OperationMetrics: สถิติเวลา p50/p95 ต่อ operation ต่อช่วงเวลา (สำหรับ pilot และเกณฑ์ย้ายระบบ)
CREATE TABLE operation_metrics (
  id uuid NOT NULL PRIMARY KEY,
  bucket_start timestamptz NOT NULL,
  operation text NOT NULL,
  count integer NOT NULL,
  error_count integer NOT NULL,
  p50_ms integer,
  p95_ms integer,
  max_ms integer,
  lock_wait_p95_ms integer,
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  CONSTRAINT operation_metrics_ck1 CHECK (char_length(operation) <= 80),
  CONSTRAINT operation_metrics_ck2 CHECK (operation <> ''),
  CONSTRAINT operation_metrics_ck3 CHECK (count >= 0),
  CONSTRAINT operation_metrics_ck4 CHECK (error_count >= 0),
  CONSTRAINT operation_metrics_ck5 CHECK (p50_ms >= 0),
  CONSTRAINT operation_metrics_ck6 CHECK (p95_ms >= 0),
  CONSTRAINT operation_metrics_ck7 CHECK (max_ms >= 0),
  CONSTRAINT operation_metrics_ck8 CHECK (lock_wait_p95_ms >= 0)
);
CREATE TRIGGER operation_metrics_append_only BEFORE UPDATE OR DELETE ON operation_metrics FOR EACH ROW EXECUTE FUNCTION cwk_forbid_mutation();

-- Foreign keys (added after all tables). All are DEFERRABLE INITIALLY DEFERRED: checked at COMMIT, so the
-- order of writes inside one unit of work (change set, migration merge) never matters; self-references and
-- the IdentityLinks <-> InvitationRecords cycle need this anyway.
ALTER TABLE academic_years ADD CONSTRAINT academic_years_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE terms ADD CONSTRAINT terms_academic_year_id_fk FOREIGN KEY (academic_year_id) REFERENCES academic_years (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE school_calendar ADD CONSTRAINT school_calendar_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE periods ADD CONSTRAINT periods_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE settings ADD CONSTRAINT settings_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE rule_versions ADD CONSTRAINT rule_versions_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE rule_versions ADD CONSTRAINT rule_versions_approved_by_fk FOREIGN KEY (approved_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE users ADD CONSTRAINT users_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE users ADD CONSTRAINT users_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE users ADD CONSTRAINT users_guardian_id_fk FOREIGN KEY (guardian_id) REFERENCES guardians (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE users ADD CONSTRAINT users_disabled_by_fk FOREIGN KEY (disabled_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE identity_links ADD CONSTRAINT identity_links_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE identity_links ADD CONSTRAINT identity_links_invitation_id_fk FOREIGN KEY (invitation_id) REFERENCES invitation_records (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE identity_links ADD CONSTRAINT identity_links_revoked_by_fk FOREIGN KEY (revoked_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_granted_by_fk FOREIGN KEY (granted_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_revoked_by_fk FOREIGN KEY (revoked_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE staff_assignments ADD CONSTRAINT staff_assignments_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE staff_assignments ADD CONSTRAINT staff_assignments_class_id_fk FOREIGN KEY (class_id) REFERENCES classes (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE staff_assignments ADD CONSTRAINT staff_assignments_station_id_fk FOREIGN KEY (station_id) REFERENCES stations (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE staff_assignments ADD CONSTRAINT staff_assignments_delegate_for_user_id_fk FOREIGN KEY (delegate_for_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE invitation_records ADD CONSTRAINT invitation_records_target_user_id_fk FOREIGN KEY (target_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE invitation_records ADD CONSTRAINT invitation_records_redeemed_identity_link_id_fk FOREIGN KEY (redeemed_identity_link_id) REFERENCES identity_links (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE stations ADD CONSTRAINT stations_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE students ADD CONSTRAINT students_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE classes ADD CONSTRAINT classes_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE classes ADD CONSTRAINT classes_academic_year_id_fk FOREIGN KEY (academic_year_id) REFERENCES academic_years (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_class_id_fk FOREIGN KEY (class_id) REFERENCES classes (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_academic_year_id_fk FOREIGN KEY (academic_year_id) REFERENCES academic_years (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE guardians ADD CONSTRAINT guardians_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE student_guardians ADD CONSTRAINT student_guardians_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE student_guardians ADD CONSTRAINT student_guardians_guardian_id_fk FOREIGN KEY (guardian_id) REFERENCES guardians (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE student_guardians ADD CONSTRAINT student_guardians_verified_by_fk FOREIGN KEY (verified_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE contact_endpoints ADD CONSTRAINT contact_endpoints_verified_by_fk FOREIGN KEY (verified_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_station_id_fk FOREIGN KEY (station_id) REFERENCES stations (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_actor_id_fk FOREIGN KEY (actor_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_linked_leave_id_fk FOREIGN KEY (linked_leave_id) REFERENCES leave_requests (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_supersedes_event_id_fk FOREIGN KEY (supersedes_event_id) REFERENCES attendance_events (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_roll_call_session_id_fk FOREIGN KEY (roll_call_session_id) REFERENCES roll_call_sessions (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_class_id_fk FOREIGN KEY (class_id) REFERENCES classes (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE daily_attendance ADD CONSTRAINT daily_attendance_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE daily_attendance ADD CONSTRAINT daily_attendance_class_id_fk FOREIGN KEY (class_id) REFERENCES classes (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE daily_attendance ADD CONSTRAINT daily_attendance_arrival_event_id_fk FOREIGN KEY (arrival_event_id) REFERENCES attendance_events (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE daily_attendance ADD CONSTRAINT daily_attendance_roll_call_session_id_fk FOREIGN KEY (roll_call_session_id) REFERENCES roll_call_sessions (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE daily_attendance ADD CONSTRAINT daily_attendance_calculated_rule_version_id_fk FOREIGN KEY (calculated_rule_version_id) REFERENCES rule_versions (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE daily_attendance ADD CONSTRAINT daily_attendance_verified_by_fk FOREIGN KEY (verified_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE roll_call_sessions ADD CONSTRAINT roll_call_sessions_class_id_fk FOREIGN KEY (class_id) REFERENCES classes (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE roll_call_sessions ADD CONSTRAINT roll_call_sessions_submitted_by_fk FOREIGN KEY (submitted_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE roll_call_sessions ADD CONSTRAINT roll_call_sessions_verified_by_fk FOREIGN KEY (verified_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_target_event_id_fk FOREIGN KEY (target_event_id) REFERENCES attendance_events (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_requested_by_fk FOREIGN KEY (requested_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_decided_by_fk FOREIGN KEY (decided_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_resulting_event_id_fk FOREIGN KEY (resulting_event_id) REFERENCES attendance_events (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE reconciliation_tasks ADD CONSTRAINT reconciliation_tasks_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE reconciliation_tasks ADD CONSTRAINT reconciliation_tasks_class_id_fk FOREIGN KEY (class_id) REFERENCES classes (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE reconciliation_tasks ADD CONSTRAINT reconciliation_tasks_assigned_to_fk FOREIGN KEY (assigned_to) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE reconciliation_tasks ADD CONSTRAINT reconciliation_tasks_resolved_by_fk FOREIGN KEY (resolved_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_requester_user_id_fk FOREIGN KEY (requester_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_route_rule_version_id_fk FOREIGN KEY (route_rule_version_id) REFERENCES rule_versions (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_current_approver_user_id_fk FOREIGN KEY (current_approver_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_segments ADD CONSTRAINT leave_segments_leave_request_id_fk FOREIGN KEY (leave_request_id) REFERENCES leave_requests (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_segments ADD CONSTRAINT leave_segments_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_segments ADD CONSTRAINT leave_segments_decision_id_fk FOREIGN KEY (decision_id) REFERENCES leave_approvals (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_revisions ADD CONSTRAINT leave_revisions_leave_request_id_fk FOREIGN KEY (leave_request_id) REFERENCES leave_requests (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_revisions ADD CONSTRAINT leave_revisions_actor_id_fk FOREIGN KEY (actor_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_approvals ADD CONSTRAINT leave_approvals_leave_request_id_fk FOREIGN KEY (leave_request_id) REFERENCES leave_requests (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_approvals ADD CONSTRAINT leave_approvals_decided_by_fk FOREIGN KEY (decided_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE leave_approvals ADD CONSTRAINT leave_approvals_acting_for_user_id_fk FOREIGN KEY (acting_for_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cases ADD CONSTRAINT cases_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cases ADD CONSTRAINT cases_rule_version_id_fk FOREIGN KEY (rule_version_id) REFERENCES rule_versions (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cases ADD CONSTRAINT cases_owner_user_id_fk FOREIGN KEY (owner_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cases ADD CONSTRAINT cases_closed_by_fk FOREIGN KEY (closed_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE case_events ADD CONSTRAINT case_events_case_id_fk FOREIGN KEY (case_id) REFERENCES cases (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE case_events ADD CONSTRAINT case_events_actor_id_fk FOREIGN KEY (actor_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE contact_logs ADD CONSTRAINT contact_logs_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE contact_logs ADD CONSTRAINT contact_logs_case_id_fk FOREIGN KEY (case_id) REFERENCES cases (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE contact_logs ADD CONSTRAINT contact_logs_guardian_id_fk FOREIGN KEY (guardian_id) REFERENCES guardians (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE contact_logs ADD CONSTRAINT contact_logs_contacted_by_fk FOREIGN KEY (contacted_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE contact_logs ADD CONSTRAINT contact_logs_supersedes_id_fk FOREIGN KEY (supersedes_id) REFERENCES contact_logs (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE appointments ADD CONSTRAINT appointments_case_id_fk FOREIGN KEY (case_id) REFERENCES cases (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE appointments ADD CONSTRAINT appointments_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attachments ADD CONSTRAINT attachments_school_id_fk FOREIGN KEY (school_id) REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attachments ADD CONSTRAINT attachments_uploaded_by_fk FOREIGN KEY (uploaded_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attachments ADD CONSTRAINT attachments_deleted_by_fk FOREIGN KEY (deleted_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attachment_links ADD CONSTRAINT attachment_links_attachment_id_fk FOREIGN KEY (attachment_id) REFERENCES attachments (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attachment_links ADD CONSTRAINT attachment_links_linked_by_fk FOREIGN KEY (linked_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE storage_object_mappings ADD CONSTRAINT storage_object_mappings_attachment_id_fk FOREIGN KEY (attachment_id) REFERENCES attachments (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notifications ADD CONSTRAINT notifications_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notification_recipients ADD CONSTRAINT notification_recipients_notification_id_fk FOREIGN KEY (notification_id) REFERENCES notifications (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notification_recipients ADD CONSTRAINT notification_recipients_recipient_user_id_fk FOREIGN KEY (recipient_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_notification_id_fk FOREIGN KEY (notification_id) REFERENCES notifications (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_recipient_id_fk FOREIGN KEY (recipient_id) REFERENCES notification_recipients (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_recipient_user_id_fk FOREIGN KEY (recipient_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_resend_of_outbox_id_fk FOREIGN KEY (resend_of_outbox_id) REFERENCES notification_outbox (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE notification_attempts ADD CONSTRAINT notification_attempts_outbox_id_fk FOREIGN KEY (outbox_id) REFERENCES notification_outbox (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acknowledgements ADD CONSTRAINT acknowledgements_recipient_id_fk FOREIGN KEY (recipient_id) REFERENCES notification_recipients (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acknowledgements ADD CONSTRAINT acknowledgements_notification_id_fk FOREIGN KEY (notification_id) REFERENCES notifications (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acknowledgements ADD CONSTRAINT acknowledgements_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acknowledgements ADD CONSTRAINT acknowledgements_case_id_fk FOREIGN KEY (case_id) REFERENCES cases (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE channel_bindings ADD CONSTRAINT channel_bindings_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE channel_bindings ADD CONSTRAINT channel_bindings_revoked_by_fk FOREIGN KEY (revoked_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE mutation_journal ADD CONSTRAINT mutation_journal_actor_id_fk FOREIGN KEY (actor_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_actor_id_fk FOREIGN KEY (actor_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_id_fk FOREIGN KEY (actor_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_student_id_fk FOREIGN KEY (student_id) REFERENCES students (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE jobs ADD CONSTRAINT jobs_owner_user_id_fk FOREIGN KEY (owner_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_source_attachment_id_fk FOREIGN KEY (source_attachment_id) REFERENCES attachments (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_job_id_fk FOREIGN KEY (job_id) REFERENCES jobs (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE import_errors ADD CONSTRAINT import_errors_import_batch_id_fk FOREIGN KEY (import_batch_id) REFERENCES import_batches (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE migration_runs ADD CONSTRAINT migration_runs_started_by_fk FOREIGN KEY (started_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE migration_runs ADD CONSTRAINT migration_runs_job_id_fk FOREIGN KEY (job_id) REFERENCES jobs (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE migration_checkpoints ADD CONSTRAINT migration_checkpoints_migration_run_id_fk FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_migration_run_id_fk FOREIGN KEY (migration_run_id) REFERENCES migration_runs (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_job_id_fk FOREIGN KEY (job_id) REFERENCES jobs (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE change_log ADD CONSTRAINT change_log_actor_id_fk FOREIGN KEY (actor_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_output_attachment_id_fk FOREIGN KEY (output_attachment_id) REFERENCES attachments (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_locked_by_fk FOREIGN KEY (locked_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_supersedes_run_id_fk FOREIGN KEY (supersedes_run_id) REFERENCES report_runs (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_superseded_by_run_id_fk FOREIGN KEY (superseded_by_run_id) REFERENCES report_runs (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_requested_by_fk FOREIGN KEY (requested_by) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_job_id_fk FOREIGN KEY (job_id) REFERENCES jobs (id) DEFERRABLE INITIALLY DEFERRED;

INSERT INTO schema_versions (id, component, schema_version, applied_at, applied_by, description, checksum, created_at, created_by)
VALUES ('00000000-0000-4000-8000-000000000001', 'POSTGRES', 1, now(), 'migration 0001_init.sql', 'initial schema', NULL, now(), '00000000-0000-4000-8000-000000000001');
COMMIT;

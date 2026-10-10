# CHANGELOG

บันทึกการเปลี่ยนแปลงที่มีผลต่อ schema / API contract / portable format (Semantic: schema_version เพิ่มเมื่อโครงสร้างข้อมูลเปลี่ยน)

## [Unreleased]

### ชุดที่ 2 — Data foundation (2026-10-10)

- schema_version 1 (ยังไม่ release): เพิ่ม `Guardians.external_ref` (unique ต่อโรงเรียน) และ `ImportErrors.attempt_no`
- API v1: 57 operations (auth, users/roles/assignments/invitations, students/classes/enrollments/guardians/contacts, settings/rules/calendar/periods/stations/terms, system/jobs, imports)
- Sheets adapter: MutationJournal redo log, ScriptLock, StorageCatalog partitions (Ops/Daily/Notify ต่อภาคเรียน)
- gas-dist: Code.js + Entrypoints.js (10 public functions) + App.html + appsscript.json

### ชุดที่ 1 — Foundation (2026-10-10)

- schema_version **1**: 56 ตาราง (Configuration, Identity, Student, Attendance, Leave, Follow-up, Files, Notifications, Operations) จาก `src/schema/tables.js`
- Partition ต่อภาคเรียน: Ops / Daily / Notify workbooks (DECISIONS D-005)
- Permission matrix v1 (`src/domain/permissions.js`) — 53 actions × 9 roles (166 grants)
- State machines: Leave, AttendanceDay, Case, Outbox, Import, Migration
- PostgreSQL migration `0001_init.sql` + `roles.sql` (generated)

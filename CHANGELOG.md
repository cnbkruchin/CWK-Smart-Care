# CHANGELOG

บันทึกการเปลี่ยนแปลงที่มีผลต่อ schema / API contract / portable format (Semantic: schema_version เพิ่มเมื่อโครงสร้างข้อมูลเปลี่ยน)

## [Unreleased]

### ชุดที่ 1 — Foundation (2026-10-10)

- schema_version **1**: 56 ตาราง (Configuration, Identity, Student, Attendance, Leave, Follow-up, Files, Notifications, Operations) จาก `src/schema/tables.js`
- Partition ต่อภาคเรียน: Ops / Daily / Notify workbooks (DECISIONS D-005)
- Permission matrix v1 (`src/domain/permissions.js`) — 53 actions × 9 roles (166 grants)
- State machines: Leave, AttendanceDay, Case, Outbox, Import, Migration
- PostgreSQL migration `0001_init.sql` + `roles.sql` (generated)

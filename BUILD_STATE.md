# BUILD_STATE — CWK Smart Care

| รายการ | ค่า |
|---|---|
| project version | 0.1.0 (ยังไม่ใช่ release) |
| schema version | 1 (`src/schema/tables.js`) |
| prompt version | MASTER_PROMPT 1.0 (2026-10-10) |
| ชุดล่าสุดที่ส่งมอบ | ชุดที่ 1 — Foundation |
| อัปเดตล่าสุด | 2026-10-10 |

## สมมติฐาน (แยกจากข้อมูลจริง)

| หัวข้อ | สมมติฐานที่ใช้พัฒนา | สถานะ |
|---|---|---|
| จำนวนนักเรียน | 1,500 คน (ทดสอบ) | **สมมติ** — ไม่ใช่จำนวนจริง |
| เวลาเริ่มสาย | 08:00 grace 0 (ค่าตัวอย่าง `is_example=true`) | **ต้องกำหนดก่อน production** |
| เกณฑ์ติดตาม | สาย 3 ครั้งใน 30 วันเรียน (ตัวอย่าง) | ต้องให้โรงเรียนกำหนด |
| เส้นทางอนุมัติลา | ≤3 วันเรียน ครูที่ปรึกษา, ≥4 วัน/กิจกรรมโรงเรียน กิจการนักเรียน; นักเรียนยื่นเองต้องผู้ปกครองยืนยัน; ย้อนหลังได้ 7 วัน (ตัวอย่าง) | ต้องให้โรงเรียนกำหนด |
| ภาคเรียน | ตัวอย่าง AY2026-T1/T2 ใน fixtures | ตั้งค่าจริงในระบบ |
| โดเมน/บัญชี/Firebase project/LINE channel | ไม่มี — ใช้ example.com และค่าตัวอย่าง | ตั้งค่าในขั้นติดตั้ง |
| สีแบรนด์ | #B91C1C ตัวอย่าง | ไม่ใช่สีอัตลักษณ์ที่รับรอง |
| ระดับชั้น | ม.1–ม.6 | ปรับ enum ได้ด้วย schema migration |

## Architecture decisions

ดู DECISIONS.md (D-001 … D-019) — สรุป: GAS+Sheets+Drive, ES modules→esbuild, Firebase Auth + Node gateway verify (checkRevoked), RBAC+scope, partition ต่อภาคเรียน (Ops/Daily/Notify), MutationJournal + ScriptLock, apostrophe cell encoding, dense DailyAttendance projection, roll call exceptions-only, LINE gateway + envelope HMAC, outbox semantics, maintenance snapshot migration, Node REST + PostgreSQL reference, generator-based services

## File inventory (ชุดที่ 1)

| path | สถานะ |
|---|---|
| README_TH.md, BUILD_STATE.md, ARCHITECTURE.md, DECISIONS.md, CHANGELOG.md | ✔ |
| DATA_DICTIONARY.md, PERMISSIONS.md, docs/STATE_MACHINES.md, docs/CAPACITY.md | ✔ generated (`npm run gen`) |
| schema/tables/*.schema.json (56), schema/enums.json, schema/dependency-order.json | ✔ generated |
| database/postgres/migrations/0001_init.sql, database/postgres/roles.sql | ✔ generated, applied to PostgreSQL 16.15 locally |
| src/shared/* (errors, canonical-json, hash, uuid, time, thai-format, validate) | ✔ |
| src/schema/* (enums, tables, index, sql) | ✔ |
| src/domain/* (permissions, rules, calendar, lateness, enrollment, leave, attendance, state-machines) | ✔ |
| tools/gen-docs.mjs, tools/gen/capacity.mjs, tools/lib/capacity-model.mjs, tools/capacity.mjs, tools/pg-local.mjs | ✔ |
| tests/domain/*.test.mjs, tests/fixtures/domain-fixtures.mjs | ✔ |
| ScriptProperties.example, .env.example, package.json, package-lock.json | ✔ |

## Completed requirements (ชุดที่ 1)

- §3 ค่าตั้งต้น/การประเมินขนาดจาก schema จริง (docs/CAPACITY.md) — ผลนำไปสู่การแยก Notify workbook
- §4 ชั้นสถาปัตยกรรม, ports ที่กำหนด (เอกสาร), capability matrix, กฎ purity มี test
- §5 decision ด้าน identity (D-003) — ยังไม่มีโค้ด adapter (ชุดที่ 2)
- §6 permission matrix ระดับ action พร้อม scope และ test
- §8 schema 56 ตาราง + data dictionary + JSON Schema + PostgreSQL DDL (FK, unique, partial unique, check, exclusion, append-only trigger, roles)
- §9 state transition tables + กฎการนับ (lateness, leave units, projection, mixed day, missing data = UNKNOWN)

## Pending requirements (ชุดถัดไป)

ชุดที่ 2–8 ตาม MASTER_PROMPT §20 (ดูหัวข้อ "งานถัดไป")

## Test results

| ชุดทดสอบ | คำสั่ง | ผล (2026-10-10, Node 22.22.0) |
|---|---|---|
| domain + shared + purity | `npm run test:domain` | automated **pass 47 / fail 0** |
| PostgreSQL DDL apply | `node tools/pg-local.mjs start` + `psql -f 0001_init.sql` + `roles.sql` | manual verified บน PostgreSQL 16.15 (57 tables) |
| generated docs drift | `npm run check:gen` | pass |
| GAS runtime จริง | — | **not run** (ยังไม่มีโค้ด GAS ในชุดนี้) |

## Known issues

- เอกสารทางการบางรายการตรวจได้ผ่าน web search เท่านั้น (network policy) — ดู DECISIONS.md ท้ายไฟล์
- Daily workbook ~51% ของขีดจำกัดเซลล์ต่อภาคเรียนภายใต้สมมติฐาน 1,500 คน — เฝ้าระวังใน pilot

## Next exact task

ชุดที่ 2 — Data foundation: `src/application` (runner, ChangeSet, MutationStore port, dispatcher + operation registry), `src/adapters/memory`, `src/adapters/gas` (Sheets TableStore + MutationJournal + ScriptLock, config/secrets, cache, gateway IdentityVerifier, Drive storage), GAS emulator สำหรับ test, setup/migrations แบบ idempotent, invitations/identity links, import นักเรียน/ห้อง/enrollment/ผู้ปกครอง (CSV/XLSX dry-run), `tools/build-gas.mjs` + `gas-dist/`

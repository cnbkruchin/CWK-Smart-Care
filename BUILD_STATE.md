# BUILD_STATE — CWK Smart Care

| รายการ | ค่า |
|---|---|
| project version | 0.2.0 (ยังไม่ใช่ release) |
| schema version | 1 (`src/schema/tables.js`, 56 ตาราง) |
| API version | v1 (57 operations ใน allowlist) |
| prompt version | MASTER_PROMPT 1.0 (2026-10-10) |
| ชุดล่าสุดที่ส่งมอบ | ชุดที่ 2 — Data foundation |
| อัปเดตล่าสุด | 2026-10-10 |

## สมมติฐาน (แยกจากข้อมูลจริง)

| หัวข้อ | สมมติฐานที่ใช้พัฒนา | สถานะ |
|---|---|---|
| จำนวนนักเรียน | 1,500 คน (ประเมินขนาด) / ข้อมูลสังเคราะห์ใน demo | **สมมติ** |
| เวลาเริ่มสาย | 08:00 grace 0 (`is_example=true`) | **ต้องกำหนดก่อน production** — PROD health = FAIL จนกว่าเปลี่ยน |
| เกณฑ์ติดตาม/เส้นทางอนุมัติ/นโยบายแจ้งเตือน | ค่าตัวอย่างใน `EXAMPLE_RULE_PARAMS` | ต้องให้โรงเรียนกำหนด |
| โดเมน/บัญชี/Firebase/LINE | example.com, ค่าตัวอย่าง | ตั้งในขั้นติดตั้ง |
| เบอร์โทรสังเคราะห์ | `+999…` (รหัสประเทศสงวน ไม่ใช่เบอร์จริง) | ใช้เฉพาะ DEV/STAGING |

## Architecture decisions

DECISIONS.md D-001…D-019 (ไม่มีการเปลี่ยนในชุดที่ 2; เพิ่มรายละเอียดการ implement ใน ARCHITECTURE.md)

## File inventory

| path | สถานะ |
|---|---|
| ชุดที่ 1 ทั้งหมด (docs, schema, domain) | ✔ |
| `src/application/` runtime, context, changeset, dispatcher, principal, authz, queries, files, jobs, bootstrap, demo-seed, registry, scheduler | ✔ |
| `src/application/ops/` auth, users, students, settings, system, imports (57 operations) | ✔ |
| `src/application/imports/` definitions, planner | ✔ |
| `src/application/identity/demo.js` | ✔ (DEV/STAGING เท่านั้น) |
| `src/adapters/memory/` store + storage | ✔ (อ้างอิง semantics/test) |
| `src/adapters/node/ports.js` | ✔ |
| `src/adapters/gas/` sheets-codec, sheets-store (journal), config, ports, identity-gateway, drive-storage, setup, extras | ✔ |
| `src/entry/` gas-main, gas-entrypoints, appsscript.json | ✔ |
| `gas-dist/` Code.js (349 KB), Entrypoints.js, App.html, appsscript.json, BUILD_INFO.json | ✔ built (`npm run build`) |
| `frontend/src/` main, app, api (GasRpc/Http transports), auth (Firebase compat 10.14.1 / Demo), ui, styles, screens: login, home, students, users, settings, imports, health | ✔ |
| `tools/` build-gas, gen-docs (+ gen/api-contract, gen/capacity), pg-local, capacity, lib/yaml | ✔ |
| API_CONTRACT.md, openapi.yaml | ✔ generated |
| docs/INSTALL_GAS_TH.md | ✔ ฉบับแรก (อ้างถึง GATEWAY_TH/OPERATIONS_TH/UAT ซึ่งจะส่งมอบในชุดถัดไป) |
| tests/application, tests/gas (+ gas-sim emulator), tests/helpers | ✔ |

## Completed requirements (สะสม)

- §4 ports/adapters/DI จุดเดียว, DATA_ADAPTER แยก SERVICE_BACKEND, generator runtime (sync GAS / async Node)
- §5 AuthProvider: GatewayIdentityVerifier (HMAC request/response, aud/iss/exp/sub/tenant, checkRevoked ต้องเป็น true, cache ≤ 300 วินาทีด้วย SHA-256 ของ token), DemoIdentityVerifier + production gate, IdentityLinks, คำเชิญครั้งเดียว/มีอายุ/ผูกอีเมล/นับครั้งผิด, สมัครบัญชีแล้วยังไม่มีสิทธิ์, ห้ามให้บทบาทตนเอง (SoD), ระงับบัญชีมีผลทันที, logout ล้าง cache
- §6 ตรวจสิทธิ์ทุก operation, search กรองก่อนแบ่งหน้า
- §7.1 นักเรียน/ห้อง/enrollment history/ผู้ปกครองหลายคน/ช่องทางติดต่อ + นำเข้า CSV/XLSX (mapping, preview, dry-run, error รายแถว, job, resume, idempotent) — XLSX ผ่าน Drive conversion (ไม่ได้ทดสอบบน GAS จริง)
- §10 Sheets: StorageCatalog + partition ต่อภาคเรียน (สร้าง workbook อัตโนมัติ), TextFinder lookups, batch reads/writes, header drift check, ScriptLock + MutationJournal + recovery, optimistic concurrency, unique/FK ใต้ lock, Jobs ถาวรพร้อม lease/checkpoint
- §14 RPC allowlist, admin เฉพาะ editor + time window + owner, trigger handler ตรวจ triggerUid, health ไม่เปิดเผยความลับ, read-only mode บังคับที่ store
- §16 envelope/response/error contract, idempotency, expected_version, stale response guard, OpenAPI
- §17 คู่มือติดตั้งฉบับแรก

## Pending requirements (ชุดถัดไป)

ชุดที่ 3: ลงเวลาสาย (gate + offline), เช็กชื่อ, ยืนยันขาด, ใบลา/อนุมัติ/ยกเลิก/ย้อนหลัง, correction flow, ข้อยกเว้น (รถล่าช้า), หน้าประวัตินักเรียน/timeline, reconciliation tasks, openDay/recompute jobs, หน้าจอ Dashboard/Gate/Roll Call/Leave/Approval/Profile
ชุดที่ 4–8 ตาม MASTER_PROMPT §20

## Test results (Node 22.22.0, 2026-10-10)

| ชุดทดสอบ | คำสั่ง | ผล |
|---|---|---|
| domain + shared + purity + generated-freshness | `npm run test:domain` | automated pass |
| application (memory adapter) | `npm run test:app` | automated pass |
| GAS bundle บน emulator | `npm run test:gas` | automated pass **(emulator — ไม่ใช่ Apps Script จริง)** |
| รวม | `npm test` | **78 pass / 0 fail** |
| PostgreSQL DDL | `tools/pg-local.mjs` + psql | manual verified (ชุดที่ 1) |
| Apps Script จริง / Firebase / gateway จริง | — | **not run** — blocked by configuration (ยังไม่มีบัญชีโรงเรียน/โปรเจกต์ Firebase) |
| XLSX import บน GAS | — | **not run** (emulator ไม่แปลง XLSX) |

## Known issues / ข้อจำกัด

- พฤติกรรม apostrophe/TextFinder ของ Sheets จริงต้องยืนยันด้วย `adminSelfTest()` (D-007)
- rate limit บน CacheService เป็น best effort (ไม่ atomic)
- ผู้อ่านที่ไม่ถือ lock อาจเห็นผลบางส่วนของ operation ที่ process ตายกลางทางจนกว่า recovery จะรัน (D-006)
- เอกสารทางการบางส่วนตรวจผ่าน web search เท่านั้น (DECISIONS ท้ายไฟล์)

## Next exact task

ชุดที่ 3 — `src/application/ops/attendance.js` (lookupForGate, recordArrival + queue/manual time, syncOffline, rollCall.get/submit, verifyDay, correct/requestCorrection/decideCorrection, exempt, reconciliation tasks), `ops/leave.js` (submit/confirmGuardian/decide/return/resubmit/withdraw/cancel/reroute/inbox/list/get + attachments), `ops/profile.js` (student profile + timeline), jobs `attendance.openDay`/`recomputeStudent`/`recomputeDate`, tick tasks, frontend screens gate/rollcall/leave/approvals/profile/dashboard, tests

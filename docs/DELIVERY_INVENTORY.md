# Delivery inventory — CWK Smart Care 0.8.0 (MASTER_PROMPT §19)

> 317 ไฟล์ใน repository (ไม่รวม `node_modules`) · ไม่มี credentials จริง ไม่มีข้อมูลนักเรียนจริง (ข้อมูลทดสอบทั้งหมดสังเคราะห์, อีเมล `example.com`, เบอร์ `+999…`)
> ตรวจซ้ำได้: `git ls-files | wc -l` และคำสั่งในคอลัมน์ "ตรวจด้วย"

## 1. รายการบังคับตาม §19

| §19 | ตำแหน่งจริง | สถานะ | ตรวจด้วย |
|---|---|---|---|
| README_TH.md | `README_TH.md` | ✔ | — |
| BUILD_STATE.md | `BUILD_STATE.md` | ✔ | — |
| ARCHITECTURE.md | `ARCHITECTURE.md` | ✔ | — |
| DECISIONS.md | `DECISIONS.md` (D-001–D-038) | ✔ | — |
| DATA_DICTIONARY.md + schema/ | `DATA_DICTIONARY.md`, `schema/tables/*.schema.json` (56), `schema/enums.json`, `schema/portable/*.schema.json`, `schema/dependency-order.json` | ✔ generated | `npm run check:gen` |
| PERMISSIONS.md | `PERMISSIONS.md` | ✔ generated | `npm run check:gen` |
| src/domain/ | 9 ไฟล์ (เวลา/สาย, ปฏิทิน, enrollment, ลา, projection, permissions, state machines, กฎติดตาม) — ไม่อ้าง API แพลตฟอร์ม | ✔ | `tests/domain/purity.test.mjs` |
| src/application/ | dispatcher, registry (139 operations), services, ops, jobs, migration, outbox, webhook, reports | ✔ | `npm test` |
| src/adapters/gas/ | Sheets store + journal, Drive storage/package, config, identity gateway client, providers (MailApp/LINE), report renderer, backup, setup | ✔ | `tests/gas/` (emulator) |
| gas-dist/ | `Code.js`, `Entrypoints.js` (13 public functions), `App.html`, `appsscript.json`, `BUILD_INFO.json` | ✔ built | `node tools/build-gas.mjs --check` |
| frontend/ | `frontend/src/` (SPA, GasRpcTransport + HttpTransport) | ✔ | `npm run test:ui` |
| gateway/ | `gateway/` (LINE webhook + identity verify, Dockerfile, cloudbuild.yaml, lockfile) + `docs/GATEWAY_TH.md` | ✔ | `tests/gateway/`, `tests/application/identity-gateway.test.mjs` |
| tools/ | `migrate.mjs` (validate/plan/import/reconcile/pack), `rehearse-postgres.mjs`, `fixtures/generate-synthetic.mjs`, `load-test.mjs`, `capacity.mjs`, `pg-local.mjs`, `build-gas.mjs`, `gen-docs.mjs` | ✔ | `npm run test:pg`, `npm run load` |
| database/postgres/ | `migrations/0001_init.sql` (DDL + index + constraint), `roles.sql` (cwk_app / cwk_migrator / cwk_reporting) — ไม่มี seed ข้อมูลจริง | ✔ generated | `npm run check:gen`, `npm run test:pg` |
| future-platform/api/ | REST backend + PostgreSQL adapter (`src/adapters/postgres/`), admin CLI, Dockerfile, lockfile | ✔ | `npm run test:pg` (tests/api, tests/contract) |
| future-platform/web/ | starter: login, รายชื่อนักเรียน, หน้ารายบุคคล, ลงเวลามาเรียน + README_TH.md (หน้าที่ต้องย้ายต่อ) | ✔ | `npm run test:web` |
| tests/ | domain, application, contract, gas (emulator), gateway, migration, api, ui + fixtures/helpers | ✔ | `npm test`, `npm run test:pg`, `npm run test:ui`, `npm run test:web` |
| docs/INSTALL_GAS_TH.md | ✔ | — | — |
| docs/OPERATIONS_TH.md | ✔ | — | — |
| docs/PORTABLE_FORMAT.md | ✔ (ฉบับเดียวกันถูกใส่ในทุก package) | — | `tests/domain/generated.test.mjs` |
| docs/MIGRATION_RUNBOOK_TH.md | ✔ | — | — |
| docs/UAT_CHECKLIST_TH.md | ✔ ชุดที่ 8 | — | — |
| docs/LIMITATIONS.md | ✔ ชุดที่ 8 | — | — |
| API_CONTRACT.md / openapi.yaml | ✔ generated (HTTP status ต่อรหัสข้อผิดพลาด) | — | `npm run check:gen` |
| .env.example / ScriptProperties.example | ✔ ค่าตัวอย่างที่ไม่ใช่ความลับ | — | secret scan (BUILD_STATE) |
| package.json + lockfile | `package.json` + `package-lock.json` (root), `gateway/package-lock.json`, `future-platform/api/package-lock.json` | ✔ | `npm ci` |
| docker-compose.yml | PostgreSQL + migrate (profile tools) + api-init/api (profile api) | ✔ ไฟล์ — **ยังไม่ได้รัน** (ไม่มี Docker) | `docker compose --profile api up --build` |
| CHANGELOG.md | ✔ | — | — |

เอกสารเพิ่มเติม: docs/REST_BACKEND_TH.md, docs/TEST_MATRIX.md, docs/LOAD_TEST_TH.md, docs/CAPACITY.md, docs/STATE_MACHINES.md, docs/REPORTS_TH.md, docs/USER_GUIDE_DAILY_TH.md, docs/USER_GUIDE_FOLLOWUP_TH.md, docs/PRIVACY_NOTICE_DRAFT_TH.md (ร่าง), THREAT_MODEL.md

## 2. จำนวนไฟล์ตามโฟลเดอร์

| โฟลเดอร์ | ไฟล์ | | โฟลเดอร์ | ไฟล์ |
|---|---|---|---|---|
| (root) | 17 | | tests/application | 12 |
| docs | 17 | | tests/domain | 6 |
| schema | 60 | | tests/migration | 5 |
| src/application | 57 | | tests/api | 3 |
| src/adapters | 21 | | tests/helpers | 7 |
| src/domain · shared · schema · entry · ports | 9 · 10 · 4 · 3 · 1 | | tests/contract · gas · gas-sim · gateway · fixtures · ui | 1 · 1 · 1 · 1 · 1 · 2 |
| frontend/src | 30 | | tools | 15 |
| future-platform/api · web | 11 · 6 | | gateway | 9 |
| gas-dist | 5 | | database | 2 |

## 3. ประกอบโครงการจาก repository

```bash
git clone <repository> && cd CWK-Smart-Care
npm ci                                   # Node.js ≥ 22
npm run check:gen && node tools/build-gas.mjs --check && npm test
# Apps Script: คัดลอก gas-dist/ ตาม docs/INSTALL_GAS_TH.md (Editor หรือ clasp — .clasp.json.example)
# gateway: docs/GATEWAY_TH.md · REST backend: docs/REST_BACKEND_TH.md · ย้ายข้อมูล: docs/MIGRATION_RUNBOOK_TH.md
```

ZIP ส่งมอบ (ไม่มี node_modules/credentials/ข้อมูลจริง) สร้างจาก commit ที่ต้องการด้วย `git archive --format=zip -o cwk-smart-care.zip HEAD` — ไม่เก็บ ZIP ไว้ใน repository (ไฟล์ที่สร้างได้ซ้ำจาก git)

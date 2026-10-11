# REST backend อ้างอิง (Node.js + PostgreSQL) และเส้นทางอัปเกรด — CWK Smart Care

> ขั้นที่ 2 และ 3 ของเส้นทางอัปเกรด (ARCHITECTURE.md §6) · โค้ด: `future-platform/api/`, `future-platform/web/`, `src/adapters/postgres/`, `src/adapters/http/`
> สถานะ: **reference implementation ที่ทดสอบอัตโนมัติบน PostgreSQL 16 จริง** — ยังไม่เคย deploy ขึ้นเครื่องจริงของโรงเรียน (ดู §11)

## 1. สิ่งที่ส่งมอบ / สิ่งที่ยังไม่ส่งมอบ

| ส่วน | สถานะ |
|---|---|
| REST API (`future-platform/api`) ใช้ dispatcher, operation ทั้ง 139 ตัว, กฎธุรกิจ, สิทธิ์ และ job ชุดเดียวกับ Apps Script | ส่งมอบ — ทดสอบ: tests/api (PostgreSQL จริง) |
| PostgreSQL TableStore/MutationStore (`src/adapters/postgres`) | ส่งมอบ — ผ่าน contract test ชุดเดียวกับ memory store (tests/contract) |
| Worker งานเบื้องหลัง (tick + jobs) | ส่งมอบ — รายงาน CSV, ส่งออก/ตรวจ package, งานตามเวลา |
| Admin CLI (`future-platform/api/admin.mjs`): init-db, bootstrap, seed-demo, set-mode, status, export-delta | ส่งมอบ |
| GAS `HttpApiAdapter` (ขั้นที่ 2: UI บน Apps Script → REST) | ส่งมอบ — ทดสอบบน Apps Script emulator + API จริง |
| เว็บรุ่นเริ่มต้น (`future-platform/web`, ขั้นที่ 3): เข้าสู่ระบบ ค้นหานักเรียน หน้ารายบุคคล ลงเวลามาเรียน | ส่งมอบ — ทดสอบใน Chromium (headless) |
| ส่งอีเมล / LINE จาก REST backend | **ยังไม่ส่งมอบ** — ไม่มี provider บน Node (`emailEnabled=false`, `lineEnabled=false`): การแจ้งเตือนในแอปทำงาน, ไม่มีการส่งออกนอกระบบ และไม่มีการส่งแบบเงียบ ๆ |
| รายงาน PDF / XLSX บน REST | **ยังไม่ส่งมอบ** — CSV ใช้ได้; PDF/XLSX ตอบ `CONFIGURATION_REQUIRED` และ report run เป็น FAILED (ไม่สร้างไฟล์ปลอม) |
| นำเข้า XLSX บน REST | **ยังไม่ส่งมอบ** — ใช้ CSV (UTF-8); XLSX ตอบ `FEATURE_DISABLED` |
| สำรองข้อมูลอัตโนมัติจากในแอป | ไม่ใช้บน REST — ใช้การสำรองของ PostgreSQL (pg_dump / PITR ของผู้ให้บริการ) + สำรอง `STORAGE_DIR` (§9) |
| LINE webhook บน REST (`/v1/webhook/line`) | route และการตรวจ envelope พร้อม (ทดสอบแล้ว) แต่ **ปิดอยู่** จนกว่าจะมี LINE provider บน Node |
| Deploy ขึ้น cloud (Cloud Run/VM), TLS, โดเมน, Firebase โปรเจกต์จริง | **ยังไม่ได้ทำ/ทดสอบ** — ต้องทำในขั้น pilot |

## 2. โครงสร้าง

```text
future-platform/api/
  server.mjs        entry: อ่าน env → ตรวจ schema version → HTTP + worker → ปิดอย่างนุ่มนวลเมื่อได้ SIGTERM
  admin.mjs         CLI ผู้ดูแล (§4)
  src/config.mjs    ตัวแปร environment (PROD ปฏิเสธ DEMO และ origin ที่ไม่ใช่ https)
  src/identity.mjs  Firebase Admin SDK verifyIdToken(token, checkRevoked) / DEMO
  src/deps.mjs      ประกอบ application layer เดิมกับ PgStore, FsAttachmentStorage, FsPackageStore
  src/app.mjs       HTTP: /v1/rpc, /v1/ops/{operation}, /v1/webhook/line, /healthz, /readyz, เว็บ starter
  src/worker.mjs    tick tasks + jobs ทุก N วินาที (advisory lock ให้ทำทีละ instance)
  Dockerfile        build จาก root ของ repo
future-platform/web/  เว็บรุ่นเริ่มต้น (ES modules ไม่มี build step) — README_TH.md มีรายการหน้าที่ต้องย้ายต่อ
src/adapters/postgres/  PgStore + sql-codec
src/adapters/http/      HttpApiAdapter (Apps Script → REST)
```

## 3. ทดลองในเครื่อง

**แบบมี Docker** (ยังไม่ได้รันในสภาพแวดล้อมพัฒนาของชุดนี้ — ไม่มี Docker; ตรวจเฉพาะไฟล์):

```bash
docker compose --profile api up --build      # postgres → api-init (schema, roles, bootstrap, ข้อมูลสังเคราะห์) → api :8080
docker compose logs api-init                  # user_id ของบัญชีทดสอบ (DEMO) และรหัสคำเชิญผู้ดูแลคนแรก
```
เปิด http://localhost:8080 → เข้าสู่ระบบ DEMO ด้วย user_id + `local-only-demo-passphrase` (ค่าทดสอบในเครื่องเท่านั้น)

**แบบไม่มี Docker** (ทำซ้ำได้ — เป็นเส้นทางเดียวกับที่การทดสอบอัตโนมัติใช้):

```bash
CWK_PG_PORT=54329 node tools/pg-local.mjs start          # พิมพ์ URL ของ PostgreSQL ชั่วคราว (trust auth, localhost)
export DATABASE_OWNER_URL=postgres://cwk@127.0.0.1:54329/cwk_test
export APP_LOGIN_PASSWORD='local-only-app-login-pass'     # ค่าทดสอบในเครื่องเท่านั้น
node future-platform/api/admin.mjs init-db --app-login cwk_api_local
export DATABASE_URL=postgres://cwk_api_local@127.0.0.1:54329/cwk_test   # API ใช้ role ที่อยู่ในกลุ่ม cwk_app
node future-platform/api/admin.mjs bootstrap --admin-email admin@example.com
API_ENV=DEV node future-platform/api/admin.mjs seed-demo
API_ENV=DEV API_AUTH_MODE=DEMO API_DEMO_PASSPHRASE='local-only-demo-pass' node future-platform/api/server.mjs
```

## 4. Admin CLI (`future-platform/api/admin.mjs`)

| คำสั่ง | ใช้ environment | ทำอะไร |
|---|---|---|
| `init-db [--app-login <role>]` | `DATABASE_OWNER_URL` (+ `APP_LOGIN_PASSWORD`) | ติดตั้ง `0001_init.sql` เมื่อยังไม่มี schema แล้วรัน `roles.sql` (idempotent); สร้าง/อัปเดต login role ในกลุ่ม `cwk_app` |
| `bootstrap --admin-email <email>` | `DATABASE_URL` | โรงเรียน + ผู้ใช้ระบบ + ผู้ดูแลคนแรก + รหัสคำเชิญ 24 ชม. (แสดงครั้งเดียว) |
| `seed-demo` | `DATABASE_URL`, `API_ENV≠PROD` | ข้อมูลสังเคราะห์ (ปฏิเสธใน PROD) |
| `set-mode NORMAL\|READ_ONLY` | `DATABASE_URL` | โหมดระบบที่ฐานข้อมูลบังคับทุกช่องทาง/ทุก instance; ปฏิเสธ NORMAL เมื่อฐานนี้ถูก cutover เป็น archive |
| `status` | `DATABASE_URL` | schema version, โหมด, จำนวนข้อมูลหลัก |
| `export-delta --base-package <dir> --out <dir>` | `DATABASE_URL` | ย้อนกลับหลัง cutover: DELTA ตั้งแต่ high-water mark ของ package ที่นำเข้า (ต้อง READ_ONLY ก่อน) |

connection string ส่งเป็น argument ไม่ได้ (exit 2) · exit code: 0 สำเร็จ, 2 ใช้คำสั่งผิด, 3 ฐานข้อมูล/schema, 10 ภายใน

## 5. HTTP API

| Route | ความหมาย |
|---|---|
| `POST /v1/rpc` | envelope เดียวกับ Apps Script (`openapi.yaml#/components/schemas/Envelope`); credential ส่งใน `Authorization: Bearer` (หรือใน envelope แบบเดิม — ส่งทั้งสองที่ = 400) |
| `POST /v1/ops/{operation}` | body = payload; header `Idempotency-Key` (UUID, mutation), `If-Match` (expected_version), `X-Request-Id` (UUID), `X-Device-Id` |
| `POST /v1/webhook/line` | envelope ที่ gateway ลงลายเซ็น (โปรโตคอลเดียวกับ doPost) — 404 เมื่อ LINE ปิด |
| `GET /healthz` | process ยังทำงาน (ไม่มีรายละเอียดระบบ) |
| `GET /readyz` | ต่อฐานข้อมูลได้และ schema version ตรงกับโค้ด (200/503) |
| `GET /…` | เว็บรุ่นเริ่มต้น (เฉพาะไฟล์ใน allowlist ที่อ่านตอนเริ่ม — path จากคำขอไม่ถึง filesystem) เมื่อ `API_SERVE_WEB=true` |

- ทุกคำตอบเป็น envelope `{ok, data|error, meta}`; HTTP status ตามรหัสข้อผิดพลาด (API_CONTRACT.md ตาราง Error codes) + `X-Request-Id`; `RATE_LIMITED`/`MAINTENANCE_MODE` มี `Retry-After`
- body ต้องเป็น `application/json` (อื่น ๆ = 415), UTF-8 ที่ถูกต้อง, ไม่เกิน `API_MAX_BODY_BYTES` (413)
- CORS: เฉพาะ origin ใน `API_ALLOWED_ORIGINS` (PROD ต้องเป็น https) ไม่ใช้ cookie (`allow-credentials` ไม่ถูกตั้ง); origin อื่น = 403; หน้าเว็บที่ API เสิร์ฟเองเป็น same-origin
- header ความปลอดภัย: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS ใน PROD, CSP เข้มงวดสำหรับหน้าเว็บ
- log เป็น JSON บรรทัดละรายการ: method, route, status, เวลา, request id — ไม่มี body, token, รหัสผ่าน หรือ connection string

## 6. ขั้นที่ 2: Apps Script UI → REST backend (`CWK_SERVICE_BACKEND=REST`)

1. ติดตั้ง REST backend + PostgreSQL และย้ายข้อมูลตาม MIGRATION_RUNBOOK_TH.md (§6 + ข้อ 5)
2. Script Properties ของโปรเจกต์ Apps Script: `CWK_SERVICE_BACKEND=REST`, `CWK_REST_BASE_URL=https://<api>` (DEV ยอม `http://`)
3. ผลที่เกิด (ทดสอบแล้วใน tests/api/gas-http-adapter.test.mjs):
   - `rpc()` ส่ง envelope ต่อผ่าน `UrlFetchApp` — token ของผู้ใช้อยู่ใน `Authorization` และ backend ตรวจเอง; Apps Script ไม่ส่ง user_id/role ใด ๆ และไม่อ่าน/เขียน Sheets
   - `doGet` ใช้ public config จาก backend (auth mode, Firebase web config, ชื่อโรงเรียน)
   - `doPost` ตอบ `WEBHOOK_DISABLED` → ต้องเปลี่ยน `GATEWAY_GAS_EXEC_URL` ของ gateway ให้ชี้ `https://<api>/v1/webhook/line` เมื่อมี LINE provider บน REST
   - `cronTick` ไม่ทำงาน (worker ของ backend ทำแทน) — ลบ trigger เดิมได้; ฟังก์ชัน `admin*` ที่แตะ Sheets ปฏิเสธ (`REST_BACKEND`)
   - backend ติดต่อไม่ได้/ตอบผิดรูป → `STORAGE_UNAVAILABLE` (retryable) — UI ลองใหม่ด้วย idempotency key เดิม จึงไม่บันทึกซ้ำ
4. ตัวตน: backend ใช้ Firebase Admin SDK (`FIREBASE_PROJECT_ID`, credential แบบ Application Default Credentials/workload identity — ห้าม commit ไฟล์ key) ตรวจ `aud`/`iss`/tenant และ `checkRevoked` ทุกคำขอ; gateway identity ของ Apps Script ไม่จำเป็นในโหมดนี้
5. ข้อจำกัด: ทุกคำขอผ่าน UrlFetchApp เพิ่ม latency และใช้โควตา UrlFetch ของบัญชีเจ้าของ (ตรวจโควตาปัจจุบันจากเอกสาร Google ก่อนใช้จริง); token ของผู้ใช้ผ่าน Apps Script ระหว่างส่งต่อ (ไม่ถูกเก็บหรือ log)

## 7. ขั้นที่ 3: เว็บใหม่ (`future-platform/web`)

- ES modules ไม่มี build step; เสิร์ฟโดย API (same-origin) หรือ hosting อื่น (ตั้ง `<meta name="cwk-api-base">` และเพิ่ม origin ใน `API_ALLOWED_ORIGINS`)
- เข้าสู่ระบบ: Firebase Authentication REST API (email/password, สมัคร, ยืนยันอีเมล, รีเซ็ตรหัสผ่าน) ไม่ใช้ JS SDK; **token อยู่ในหน่วยความจำเท่านั้น** (รีโหลดหน้า = เข้าสู่ระบบใหม่) · DEMO เฉพาะ DEV/STAGING
- ต้องเพิ่มโดเมนของเว็บใน Firebase Authentication → Authorized domains และจำกัด API key ด้วย HTTP referrer
- หน้าที่มีและหน้าที่ยังต้องย้าย: future-platform/web/README_TH.md

## 8. ฐานข้อมูล สิทธิ์ และงานเบื้องหลัง

- role (`database/postgres/roles.sql`): **owner** (DDL — ใช้เฉพาะ `init-db`), **cwk_app** (API: SELECT/INSERT, UPDATE เฉพาะตารางที่แก้ได้, ไม่มี DELETE ของข้อมูลธุรกิจ, ไม่มี DDL), **cwk_migrator** (tools/migrate.mjs), **cwk_reporting** (อ่านอย่างเดียว) — การทดสอบ API เชื่อมต่อด้วย login role ในกลุ่ม `cwk_app` เพื่อพิสูจน์สิทธิ์ขั้นต่ำ
- commit หนึ่งครั้ง = transaction เดียว: ตรวจโหมด READ_ONLY (แถว Settings `system.mode`) ใน transaction, idempotency (advisory lock ต่อ key), version check, ChangeLog seq ต่อเนื่อง (advisory lock), FK ทุกตัว `DEFERRABLE INITIALLY DEFERRED` ตรวจตอน COMMIT
- ตาราง TERM แสดง partition เชิงตรรกะ (รหัสภาคเรียน) จากข้อมูลด้วยกฎเดียวกับ Sheets — package ที่ส่งออกจาก PostgreSQL จึงเหมือนจาก Sheets (ทดสอบ: ส่งออก → ตรวจ FULL → นำเข้า → กระทบยอด PASS)
- worker: tick tasks ตามโหมด (READ_ONLY รันเฉพาะงานบำรุงรักษา) + durable jobs ทุก `API_WORKER_INTERVAL_SECONDS`, งบเวลา 240 วินาทีต่อรอบ (< lease 330 วินาที); หลาย instance ใช้ session advisory lock ให้รันทีละตัว และ claim job ด้วย version check แบบเดียวกับ Apps Script

## 9. การดำเนินงาน

- health: `/healthz` (liveness), `/readyz` (readiness) และหน้า System Health ในแอป (`system.health`)
- สำรองข้อมูล: PostgreSQL (pg_dump รายวัน หรือ PITR ของผู้ให้บริการ) **และ** `STORAGE_DIR` (ไฟล์แนบ) ในรอบเดียวกัน; ทดสอบ restore ลงฐานใหม่ก่อน go-live — การสำรองในแอป (`backup.*`) เป็นของ Apps Script และบน REST จะรายงานว่าไม่มีบริการสำรอง
- อัปเกรด schema: ยังมีเพียง schema v1 — เมื่อมี v2 ต้องมีไฟล์ migration ใหม่และ API จะไม่เริ่มทำงานถ้า schema ไม่ตรง (`/readyz` = 503, server exit 3)
- secrets อยู่ใน secret manager/environment เท่านั้น (`.env.example` เป็นค่าตัวอย่าง)

## 10. การทดสอบที่มี

| ชุด | คำสั่ง | สิ่งที่พิสูจน์ |
|---|---|---|
| tests/contract | `npm run test:pg` | PgStore ทำงานเหมือน memory store: round-trip canonical, ตัวกรอง/เรียง/แบ่งหน้า, optimistic concurrency, unique แบบ atomic, FK, idempotency, READ_ONLY, ChangeLog ต่อเนื่องภายใต้ 12 commit พร้อมกัน |
| tests/api/api.test.mjs | `npm run test:pg` | HTTP contract, ตัวตนตรวจที่ backend, สิทธิ์ตามขอบเขต, idempotency, If-Match, CORS, 413/415/400, READ_ONLY ทุก instance, งาน CSV, webhook, ส่งออกจาก PostgreSQL → กระทบยอด PASS, rollback DELTA จาก PostgreSQL ด้วย `admin.mjs export-delta`, admin CLI, process `server.mjs` |
| tests/api/gas-http-adapter.test.mjs | `npm run test:pg` | ขั้นที่ 2 บน Apps Script emulator (gas-dist ที่ build จริง) + API จริง |
| tests/api/unit.test.mjs | `npm test` | config guard, HTTP status ครบทุกรหัส, HttpApiAdapter (https, Authorization, ข้อผิดพลาดเครือข่าย) |
| tests/ui/web-starter-smoke.mjs | `npm run test:web` | เว็บรุ่นเริ่มต้นใน Chromium: เข้าสู่ระบบ, เมนูตามสิทธิ์, ลงเวลา (เวลา server, มาสาย, สแกนซ้ำ), ค้นหา → ประวัติ, ผู้ปกครองเปิดนักเรียนอื่นไม่ได้, ไม่มี JS error/CSP violation |

## 11. ข้อจำกัดที่ทราบ

- ยังไม่ได้ทดสอบกับ Firebase โปรเจกต์จริง (`FirebaseIdentityVerifier` ทดสอบเฉพาะการตั้งค่า; การเข้าสู่ระบบ Firebase ของเว็บ starter ยังไม่ได้ตรวจกับเอกสาร Firebase Auth REST API ฉบับปัจจุบัน — เข้าถึงเว็บเอกสารไม่ได้จากสภาพแวดล้อมพัฒนา) และยังไม่ได้ deploy/วัดโหลดบน cloud
- `list` ใช้ cursor แบบ offset (เรียงคงที่ + id) — ถ้ามีแถวใหม่ระหว่างเปิดหน้าถัดไป อาจเห็นซ้ำ/ข้ามหนึ่งแถวในรายการบนจอ (การส่งออกใช้ keyset scan จึงไม่กระทบ)
- ChangeLog seq ใช้ lock เดียวทั้งระบบเพื่อให้ต่อเนื่อง — จำกัด throughput การเขียนพร้อมกัน (เพียงพอสำหรับขนาดโรงเรียนเดียว แต่ยังไม่ได้วัด)
- partition เชิงตรรกะคำนวณจากตาราง terms ทุกครั้ง — ยังไม่มี index เฉพาะ; ตารางใหญ่มากอาจต้องเพิ่ม generated column + index
- rate limiter และ cache อยู่ในหน่วยความจำของแต่ละ instance (best effort)

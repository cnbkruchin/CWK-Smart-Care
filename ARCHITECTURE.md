# ARCHITECTURE — CWK Smart Care

## 1. ชั้นของระบบ

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Presentation  frontend/src (HtmlService SPA)   future-platform/web (starter) │
│   state ของหน้าจอ, validation ภาษาไทย, ไม่รู้ชื่อชีต/แถว/SQL                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ Transport     GasRpcTransport (google.script.run.rpc)  HttpTransport (fetch)   │
│   envelope เดียวกัน {api_version, request_id, operation, idempotency_key,      │
│   expected_version, credential, payload}                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│ Application   src/application: dispatcher (allowlist + middleware),            │
│   operation registry, services (generator functions), ChangeSet builder        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Domain        src/domain: เวลา/สาย, ปฏิทิน, enrollment, ลา, projection,          │
│   permissions, state machines, กฎติดตาม — pure ไม่เรียก API แพลตฟอร์มใด       │
├──────────────────────────────────────────────────────────────────────────────┤
│ Ports         src/ports: TableStore, MutationStore, IdentityVerifier,          │
│   AttachmentStorage, NotificationProvider, Clock, Ids, Crypto, Config, Cache  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Adapters      gas/ (Sheets, Drive, Mail, UrlFetch, Lock, Properties, Triggers) │
│               postgres/ (pg)   memory/ (tests)   http/ (HttpApiAdapter)        │
└──────────────────────────────────────────────────────────────────────────────┘
```

กฎบังคับที่มี test/lint ตรวจ:

- `src/domain/**` ห้ามอ้าง `SpreadsheetApp`, `DriveApp`, `UrlFetchApp`, `PropertiesService`, `google.script.run` (tests/domain/purity.test.mjs)
- UI ไม่อ่านฐานข้อมูลตรง เรียกได้เฉพาะ operation ใน allowlist
- Repository/TableStore ใช้ logical ID, filter, cursor และ expected version; ไม่คืน row number เป็น business ID
- Business settings (ตาราง Settings/RuleVersions) แยกจาก deployment configuration (Script Properties/env) และ secrets
- dependency injection จุดเดียว: `src/entry/gas-main.js` (GAS) และ `future-platform/api/server.mjs` (Node) อ่าน environment ครั้งเดียวแล้วประกอบ adapters — ไม่มี `if (databaseType)` กระจายในหน้าจอ
- `DATA_ADAPTER` (ที่เก็บข้อมูล: SHEETS | POSTGRES) แยกจาก `SERVICE_BACKEND` (เจ้าของ application logic: GAS | REST)

## 2. Trust boundaries

```text
 [Browser: ครู/ผู้ปกครอง/นักเรียน]  ← ไม่น่าเชื่อถือ: payload, role, user_id, เวลาเครื่อง
        │ (1) Firebase JS SDK: email/password → ID token (อยู่ในหน่วยความจำ/SDK persistence)
        │ (2) RPC envelope + credential (HTTPS, google.script.run)
        ▼
 [GAS Web App /exec  (Execute as owner)]  ← trust boundary หลัก: ตรวจทุกอย่างที่นี่
        │ (3) HMAC-signed server-to-server   ┌──────────────────────────────┐
        ├───────────────────────────────────►│ Gateway (Cloud Run, Node)     │
        │◄─────────── signed verdict ────────│  /v1/identity/verify          │──► Firebase Admin SDK
        │                                    │  /line/webhook (ตรวจลายเซ็น)  │◄── LINE Platform
        │◄──── (4) HMAC envelope (doPost) ───│                               │
        │                                    └──────────────────────────────┘
        ├── Sheets (master + per-term) — editor ได้เฉพาะบัญชีเจ้าของระบบ
        ├── Drive (private folders) — ไม่แชร์ anyone-with-link
        ├── MailApp / LINE Messaging API (outbox worker หลัง commit)
        └── Script Properties (secrets) — ผู้มีสิทธิ์แก้สคริปต์อ่านได้ → จำกัด editors
```

## 3. Data flow หลัก

### 3.1 RPC ทุกคำขอ (dispatcher middleware)

1. รับ envelope (JSON string ≤ 2 MB) → ตรวจรูปแบบ envelope
2. หา operation ใน **allowlist** (ไม่เรียกฟังก์ชันตามชื่อ ไม่มี eval)
3. production gate: `CWK_ENV=PROD` ต้องใช้ `AUTH_MODE=GATEWAY`, ห้าม DEMO
4. maintenance: ถ้า `READ_ONLY` และ operation เป็น mutation → `MAINTENANCE_MODE`
5. rate limit ต่อ (principal|anonymous key, operation) — best effort ด้วย CacheService
6. authenticate: `IdentityVerifier.verifyCredential(credential)` → trusted claims → IdentityLinks → Users (status) → UserRoles ที่มีผล → facts (ห้อง/ความสัมพันธ์)
7. validate payload ด้วย JSON Schema ของ operation (ภาษาไทย field errors)
8. handler (generator) → `authz.require(action, scope)` ทุกจุดที่เข้าถึงข้อมูล
9. mutation: ChangeSet → `MutationStore.commit` (idempotency + version + unique + journal + audit + outbox + changelog)
10. response `{ok, data, meta:{request_id, server_time, replayed}}` หรือ error envelope (code, message_th, retryable, field_errors, request_id)
11. metrics (เวลา, lock wait) สะสมเพื่อ p50/p95

### 3.2 สแกนประตู (attendance.recordArrival)

```text
scan/type code → student.lookupForGate (basic fields + photo + สถานะวันนี้)
  → ครูยืนยันตัวบุคคล → attendance.recordArrival {student_id, station_id, source, idempotency_key}
  → server time = arrived_at (หรือ queue/manual time พร้อม provenance+เหตุผล)
  → ถ้ามี arrival แล้ว: คืนผลเดิม (ไม่เพิ่มครั้ง)
  → evaluateArrival(กฎ SCHOOL_LATENESS ที่มีผลวันนั้น) → projection DailyAttendance ใหม่
  → commit: AttendanceEvents + DailyAttendance + Audit + ChangeLog + Idempotency (+ Notification/Outbox ถ้าสาย)
  → worker ส่ง LINE/email หลัง commit
```

### 3.3 Mutation บน Sheets (D-006)

```text
lock(10s) → recoverPrepared() → idempotency? → re-read rows: version/unique checks
  → journal PREPARED (write-set) → apply (batch setValues ต่อ sheet) → flush → journal COMMITTED → unlock
```

### 3.4 Background (`cronTick` ทุก 1–5 นาที, trigger ตัวเดียว)

recover journal → claim jobs (lease) → outbox dispatch (claim ใต้ lock / ส่งนอก lock / บันทึกผลใต้ lock) → webhook inbox → rules (ติดตาม) → schedules (openDay, verify reminders, ack timeout, orphan cleanup, nightly backup) — หยุดก่อน 4.5 นาทีเพื่อเหลือ safety margin จาก 6 นาที

## 4. Capability matrix ของ adapters

| ความสามารถ | Memory (tests) | Google Sheets (GAS) | PostgreSQL |
|---|---|---|---|
| atomic commit | ใน process เดียว | ไม่มี transaction → MutationJournal redo + ScriptLock (writer project เดียว); ภายนอก (Drive/LINE/email) ไม่อยู่ใน transaction | transaction เดียว รวม outbox |
| optimistic concurrency | version check | version check ใต้ ScriptLock | `UPDATE … WHERE id=$1 AND version=$2` |
| uniqueness | index ในหน่วยความจำ | ตรวจใต้ lock ด้วย TextFinder (การแก้มือข้ามได้ → schema check tool) | UNIQUE / partial unique / EXCLUDE |
| foreign keys | ตรวจในแอป | ตรวจในแอป + `adminSchemaCheck` | FK constraints (cycle = DEFERRABLE) |
| pagination | cursor ตาม id | cursor = (partition, row offset, last id) ตรวจ id ซ้ำทุกหน้า | keyset (`id > $cursor`) |
| job claiming | ใน process | claim ใต้ ScriptLock + lease_until | `FOR UPDATE SKIP LOCKED` + lease |
| ค้นหาด้วยค่า | scan | TextFinder (matchEntireCell, regex สำหรับหลาย id) | index |
| ขนาด | หน่วยความจำ | 10 ล้านเซลล์/ไฟล์ → partition ต่อภาคเรียน | ตามเครื่อง |

## 5. รูปแบบ application service (generator)

```js
// src/application/services/attendance.js (ตัวอย่างย่อ)
export function* recordArrival(ctx, input) {
  const facts = yield* ctx.authz.require('attendance.record', { student_id: input.student_id });
  const student = yield ctx.repos.students.get(input.student_id);   // yield แทน await
  ...
  const cs = ctx.changeSet('attendance.recordArrival');
  cs.insert('AttendanceEvents', event);
  cs.upsert('DailyAttendance', projection, { expectedVersion: stored ? stored.version : null });
  return yield* ctx.commit(cs, { event_id: event.id });
}
```

- บน GAS: `runSync(gen)` ส่งค่าที่ adapter คืนกลับเข้า generator ทันที (adapter เป็น synchronous)
- บน Node: `runAsync(gen)` รอ Promise ของ pg ทีละขั้น
- domain functions เป็น synchronous ปกติ เรียกตรงได้

## 6. เส้นทางอัปเกรด

| ขั้น | UI | Application (writer) | Data | การเปลี่ยน |
|---|---|---|---|---|
| 1 (ปัจจุบัน) | GAS HtmlService | GAS services | Sheets + Drive | — |
| 2 | GAS HtmlService | REST backend (Node) | PostgreSQL + object storage | `CWK_SERVICE_BACKEND=REST` → GAS dispatcher ส่งต่อทุก operation ผ่าน `HttpApiAdapter` พร้อม credential ของผู้ใช้; ย้ายข้อมูลด้วย portable package + reconcile; GAS ไม่เขียน Sheets อีก (read-only archive) |
| 3 | เว็บใหม่ (future-platform/web หรือ React/Next.js) | REST backend เดิม | PostgreSQL | เปลี่ยน transport เป็น HttpTransport + Firebase Auth บนโดเมนใหม่ (authorized domains) |

ห้าม dual-write; cutover/rollback ตาม docs/MIGRATION_RUNBOOK_TH.md

### 6.1 ชุดเครื่องมือย้ายข้อมูล (ชุดที่ 6)

```
ระบบต้นทาง (GAS)                      package (Drive folder / dir / small zip)             ปลายทาง
migration.startExport ─▶ job export ─▶ manifest.json + .sha256, data/*.jsonl, ─▶ adminImportPackage (Sheets ชุดใหม่)
 (READ_ONLY + H)          (checkpoint)   attachments/, metadata/, schema/, docs/  ─▶ tools/migrate.mjs (PostgreSQL: staging → merge)
migration.recordEvidence ◀──────────── reports/import.json, reconciliation.json ◀── reconcile (ยอด R01–R07, สิทธิ์, bytes)
migration.cutover (archive อ่านอย่างเดียว) · rollback: DELTA ─▶ adminApplyDelta (APPLY_NEWER)
```

แกนตรวจเดียว `processPackage()` ใช้ร่วมทุกปลายทาง; รูปแบบ docs/PORTABLE_FORMAT.md; การตัดสินใจ D-026–D-030

## 7. Environments

DEV / STAGING / PROD แยก Apps Script project (หรือ deployment + Script Properties ชุดต่างกัน), spreadsheet, Drive folder, Firebase project (หรือ tenant), gateway secrets, LINE channel และรายชื่อผู้รับทดสอบ (`CWK_NOTIFY_ALLOWLIST` ใช้ได้เฉพาะ DEV/STAGING; PROD ไม่อ่าน allowlist และไม่เปิด DEMO)

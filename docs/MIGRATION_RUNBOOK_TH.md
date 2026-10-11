# คู่มือย้ายระบบ (Migration Runbook) — CWK Smart Care

> ใช้คู่กับ docs/PORTABLE_FORMAT.md (รูปแบบ package) และหน้า "ศูนย์ส่งออกและย้ายข้อมูล" (SYSTEM_ADMIN)
> **ซ้อมบน staging ด้วยข้อมูลสังเคราะห์หรือข้อมูลที่ได้รับอนุญาตและปกป้องแล้วก่อนทุกครั้ง** — ห้ามใช้ข้อมูลจริงในเครื่องพัฒนา
> **ห้าม dual-write** (เขียนสองระบบพร้อมกันแล้วหวังให้ตรงกัน) — มีผู้เขียนข้อมูล (writer) ได้ระบบเดียวเสมอ

## 1. บทบาทและสถานะ

| บทบาท | หน้าที่ |
|---|---|
| ผู้อนุมัติ (ผู้บริหาร) | อนุมัติช่วงปิดปรับปรุง การสลับระบบ และการย้อนกลับ |
| ผู้ดูแลระบบ (SYSTEM_ADMIN) | freeze, ส่งออก, ตรวจ, บันทึกหลักฐาน, checklist, cutover/rollback |
| ผู้ดูแลปลายทาง | ติดตั้ง schema PostgreSQL หรือโปรเจกต์ Apps Script ใหม่, นำเข้า, กระทบยอด |
| ผู้ทดสอบ (ครู/เจ้าหน้าที่) | ตรวจสิทธิ์และงานหลักบนระบบใหม่ตามตัวอย่างทุกบทบาท |

สถานะงาน (Migration state machine, docs/STATE_MACHINES.md):
`PLANNED → SNAPSHOTTING → EXPORTED → VALIDATED → STAGED → RECONCILED → CUTOVER_READY → ACTIVE` (หรือ `ROLLED_BACK`, `FAILED`, `CANCELLED`)
ทุกขั้นต้องมีหลักฐาน: STAGED ต้องมี `reports/import.json` (APPLY สำเร็จ), RECONCILED ต้องมี `reports/reconciliation.json` ที่ผ่านทุกหัวข้อ, CUTOVER_READY ต้องมี checklist ครบ และ package เป็น FULL_SNAPSHOT ที่ COMPLETE — กระทบยอดไม่ผ่านจะ**ไม่มีทาง**เป็น CUTOVER_READY

## 2. สิ่งที่การย้ายตารางไม่ได้ทำให้ (ต้องตั้งค่าเอง)

- ผู้ใช้ทุกคนอาจต้องเข้าสู่ระบบใหม่ (session ไม่ถูกย้าย); บัญชี/รหัสผ่านอยู่ที่ Firebase/Google — package เก็บเฉพาะการผูก provider/subject → ผู้ใช้
- callback URL, allowed domains ของ identity provider, URL ของเว็บแอป/ระบบใหม่
- LINE webhook URL (gateway), Messaging API token, secrets ทั้งหมด (ตั้งใหม่ใน Secret Manager/ตัวแปรระบบของปลายทาง)
- trigger/scheduler ของระบบใหม่ และการปิด trigger ของระบบเดิม
- สิทธิ์ storage (โฟลเดอร์ไฟล์แนบของปลายทางต้องเป็น private)
- คำเชิญที่ยังไม่ใช้ (ถูกยกเลิกใน package — ออกใหม่), การเชื่อม LINE ที่ค้าง (ให้ผู้ปกครองเชื่อมใหม่)
- รายการแจ้งเตือนที่ยังไม่ส่ง: ถูกกัน `replay_blocked` — ผู้ดูแลตรวจแล้วเลือก "ส่งใหม่" เองในหน้าติดตามการส่ง

## 3. ซ้อมย้าย (rehearsal) — ทำก่อนวันจริงอย่างน้อย 1 ครั้ง

1. PostgreSQL: `docker compose up -d postgres` แล้ว `docker compose run --rm migrate` หรือในเครื่องที่ไม่มี Docker: `DATABASE_URL=… node tools/rehearse-postgres.mjs --init-schema` (ข้อมูลสังเคราะห์ ทำครบ validate → plan → dry-run → apply → reconcile และจับเวลาแต่ละขั้น)
2. ระบบจริง (staging ที่ได้รับอนุญาต): ศูนย์ย้ายข้อมูล → โหมด **REHEARSAL** (ต้องเปิดโหมดอ่านอย่างเดียวระหว่างส่งออก) → ทำขั้น 5–9 ด้านล่างกับฐานข้อมูล staging → ปลด freeze
3. บันทึกเวลาทุกขั้นในตาราง §10 และปัญหาที่พบ — REHEARSAL ใช้สลับระบบไม่ได้ (ระบบจะแจ้ง "ยังไม่พร้อมสลับระบบ")

## 4. เตรียมวันย้าย

- [ ] ผู้อนุมัติอนุมัติช่วงปิดปรับปรุง (เวลาเริ่ม–สิ้นสุด, ผู้รับผิดชอบ, ช่องทางแจ้ง) และประกาศผู้ใช้
- [ ] สำรองข้อมูลล่าสุดสำเร็จ และเคยทดสอบ restore (หน้าสถานะระบบ)
- [ ] ปลายทางพร้อม: PostgreSQL ติดตั้ง `0001_init.sql` + `roles.sql` (role `cwk_migrator` สำหรับนำเข้า) หรือโปรเจกต์ Apps Script ใหม่ที่วางโค้ด gas-dist แล้ว
- [ ] identity provider/URL/secrets ของปลายทางตั้งแล้ว (§2) และมีบัญชีทดสอบทุกบทบาท

## 5. Freeze และส่งออกภาพรวมสุดท้าย

1. หน้าสถานะระบบ → **เปิดโหมดอ่านอย่างเดียว** (ระบุเหตุผล) — server ปฏิเสธการบันทึกทุกช่องทาง งานตามเวลาที่ไม่ใช่งานบำรุงรักษาหยุด, webhook จาก LINE ได้ 503 และ LINE จะส่งซ้ำภายหลัง
2. ศูนย์ย้ายข้อมูล → โหลด inventory ตรวจจำนวนรายการ/partition/ไฟล์แนบ
3. เริ่มส่งออก **FULL_SNAPSHOT** (รวมไฟล์แนบ) → ติดตามความคืบหน้า (หยุดชั่วคราว/ทำต่อได้; งานถูกตัดกลางทางทำต่อจาก checkpoint)
4. ผลต้องเป็น `ส่งออกแล้ว` + `ครบถ้วน (COMPLETE)` — ถ้า FAILED ดูเหตุผล (`SOURCE_CHANGED_DURING_SNAPSHOT` = มีการเขียนระหว่างส่งออก → ส่งออกใหม่)
5. กด **ตรวจ package** → `ตรวจผ่าน (VALIDATED)` (บน Apps Script เป็นระดับ INTEGRITY; การตรวจเต็มทำด้วย CLI ในขั้น 6)

## 6. นำเข้า PostgreSQL (tools/migrate.mjs)

1. ดาวน์โหลดโฟลเดอร์ package จาก Google Drive (Drive บีบอัดเป็น ZIP และอาจแบ่งหลายไฟล์ — แตกทุกไฟล์ลงโฟลเดอร์เดียว) ไปยังเครื่องที่ปลอดภัยของโรงเรียน; ห้ามแชร์ลิงก์สาธารณะเพื่อให้ดาวน์โหลดง่าย
2. ตรวจ checksum: `cd <package> && sha256sum -c manifest.sha256`
3. ตั้ง `DATABASE_URL` ใน environment (ห้ามใส่ใน argument) แล้วรันตามลำดับ:
   ```bash
   node tools/migrate.mjs validate  --input ./package
   node tools/migrate.mjs plan      --input ./package --target postgres
   node tools/migrate.mjs import    --input ./package --target postgres --dry-run
   node tools/migrate.mjs import    --input ./package --target postgres --apply --attachments-dir /srv/cwk/attachments
   node tools/migrate.mjs reconcile --input ./package --target postgres --attachments-dir /srv/cwk/attachments
   ```
   - exit code ≠ 0 = หยุดและแก้ก่อน (ดู PORTABLE_FORMAT §14); `import --apply` โหลดเข้า staging ทีละ chunk พร้อม checkpoint แล้วรวมเข้าตารางจริงใน transaction เดียว — ถูกตัดกลางทาง รันคำสั่งเดิมซ้ำเพื่อทำต่อ; package เดิมนำเข้าซ้ำไม่เพิ่มข้อมูล
   - ข้อมูลในปลายทางที่ต่างจาก package = CONFLICT (exit 5) ระบบไม่เขียนทับ
4. อัปโหลด `reports/import.json` และ `reports/reconciliation.json` จากเครื่องไปไว้ในโฟลเดอร์ `reports/` ของ package ใน Drive

## 6B. นำเข้า Google Sheets ชุดใหม่ (Apps Script โปรเจกต์ใหม่)

1. สร้างโปรเจกต์ใหม่ (บัญชีเจ้าของเดียวกับที่เข้าถึงโฟลเดอร์ package ได้) วางโค้ด gas-dist ตาม INSTALL_GAS_TH §4–5 — **ห้ามรัน adminSetup**
2. Script Properties: `CWK_ENV`, `CWK_ADMIN_TASKS_ENABLED_UNTIL` (≤ 2 ชม.), `CWK_IMPORT_PACKAGE_FOLDER_ID=<id โฟลเดอร์ package>`
3. รัน `adminImportPackage` ซ้ำจนรายงาน `done: true` (แต่ละครั้งทำงาน ~4 นาทีแล้วบันทึก checkpoint) — ระบบปฏิเสธถ้าโปรเจกต์มีข้อมูลอยู่แล้ว
4. ผลลัพธ์: `reconciliation.overall` ต้องเป็น PASS; รายงานถูกเขียนลง `reports/` ของ package ให้อัตโนมัติ; โปรเจกต์ใหม่อยู่ในโหมดอ่านอย่างเดียวและปิดอีเมล/LINE จนกว่าผู้ดูแลจะตรวจเสร็จ

## 7. ตรวจรับและสลับระบบ (cutover)

1. ศูนย์ย้ายข้อมูล (ระบบเดิม) → รายละเอียดงาน → **บันทึกผลนำเข้าปลายทาง** (STAGED) → **บันทึกผลกระทบยอด** (RECONCILED เฉพาะเมื่อผ่านทุกหัวข้อ: จำนวน/ID, checksum ข้อมูลต้นทางและค่าที่สร้างใหม่, partition, ช่วงวันที่ + พ.ศ./เขตเวลา, ประวัติห้อง/ผู้ปกครอง/อนุมัติ/การแก้ไข, outbox ไม่ส่งซ้ำ, bytes ไฟล์แนบ, ยอด R01–R07 วันตัวอย่าง, สิทธิ์ผู้ใช้ตัวอย่าง, FK ใน PostgreSQL)
2. ผู้ทดสอบตรวจบนระบบใหม่: เข้าสู่ระบบทุกบทบาท, ผู้ปกครองหลายบุตรเห็นเฉพาะบุตรของตน, ดาวน์โหลดไฟล์แนบได้เฉพาะผู้มีสิทธิ์, ลงเวลา/เช็กชื่อ/แจ้งลา (บนระบบใหม่ในโหมดทดสอบ)
3. ทำ **Readiness checklist** ให้ครบ → **ยืนยันพร้อมสลับระบบ** (CUTOVER_READY)
4. **สลับระบบ** (พิมพ์ CUTOVER): ระบบเดิมเป็น archive อ่านอย่างเดียวถาวร (เปิดเขียนไม่ได้จนกว่าจะบันทึก rollback) — ระบบปฏิเสธถ้าข้อมูลต้นทางเปลี่ยนหลังส่งออก
5. เปลี่ยน routing จากจุดเดียว: ลิงก์/QR ที่ผู้ใช้ใช้ → URL ระบบใหม่; gateway LINE → backend ใหม่; ปิด trigger ของระบบเดิม (Apps Script: ลบ trigger cronTick)
6. เปิด writer เฉพาะระบบใหม่ (ปลด READ_ONLY ที่ระบบใหม่) → ตรวจ health, identity, permissions, download และงานหลัก
7. ตรวจคิวแจ้งเตือนที่นำเข้า (replay_blocked) แล้วจึงเปิดอีเมล/LINE ของระบบใหม่
8. เฝ้าติดตาม 1–2 สัปดาห์: error rate, เวลาตอบสนอง, คิว, ยอดรายงานเทียบกับก่อนย้าย; บันทึกการยอมรับงาน

## 8. ย้อนกลับ (rollback)

**กรณี A — ระบบใหม่ยังไม่มีข้อมูลใหม่หลัง cutover**
1. freeze ระบบใหม่ → ตรวจว่าไม่มีการบันทึก (ChangeLog ของระบบใหม่ไม่เพิ่มจากหลังนำเข้า)
2. ศูนย์ย้ายข้อมูล (ระบบเดิม) → ย้อนกลับ กรณี "ยังไม่มีข้อมูลใหม่" → ย้อน routing → ปลด READ_ONLY ระบบเดิม

**กรณี B — มีข้อมูลใหม่ในระบบใหม่แล้ว** (ห้ามเปิดระบบเดิมจาก backup เก่าแล้วทิ้งข้อมูลใหม่)
1. freeze ระบบใหม่
2. ส่งออก **DELTA** จากระบบใหม่ ตั้งแต่ ChangeLog seq หลังนำเข้า (`exportDelta` ใน `src/application/migration/delta.js`; อ้าง `base_export_id` = งานส่งออกเดิม) — แถวที่เปลี่ยน/เพิ่มและไฟล์แนบใหม่ (ฟังก์ชันนี้ทำงานบน TableStore ใดก็ได้และผ่านการทดสอบอัตโนมัติบน memory store; คำสั่งสำเร็จรูปสำหรับ backend PostgreSQL ส่งมอบในชุดที่ 7 พร้อม Postgres TableStore — **ยังไม่ส่งมอบในชุดนี้**)
3. วาง delta ในโฟลเดอร์ Drive ของระบบเดิม → Script Properties `CWK_DELTA_PACKAGE_FOLDER_ID`, รัน `adminApplyDelta` (ค่าเริ่มต้น DRY_RUN) → ตรวจผล → ตั้ง `CWK_DELTA_MODE=APPLY` แล้วรันจน done (แถวที่ถูกแก้ทั้งสองฝั่ง = CONFLICT หยุดทันที ต้องตัดสินใจรายรายการ)
4. ศูนย์ย้ายข้อมูล → ย้อนกลับ กรณี "มีข้อมูลใหม่ และนำ delta กลับมาแล้ว" (ระบบตรวจ `reports/delta-apply.json`) → ย้อน routing → ปลด READ_ONLY ระบบเดิม
5. หรือเลือก **roll-forward**: แก้ปัญหาบนระบบใหม่และใช้ต่อ (ไม่เปลี่ยนสถานะ) หลังกระทบยอดอีกครั้ง

## 9. เมื่อเกิดปัญหา

| อาการ | ทำอย่างไร |
|---|---|
| ส่งออก FAILED: SOURCE_CHANGED_DURING_SNAPSHOT | ตรวจว่า READ_ONLY เปิดตลอด, ไม่มีงานค้างใน journal → ส่งออกใหม่ |
| ส่งออก PARTIAL: ATTACHMENTS_MISSING | ดูรายการใน manifest `attachments.missing` → ตรวจไฟล์ใน Drive → แก้แล้วส่งออกใหม่ (ห้าม cutover ด้วย PARTIAL) |
| CLI exit 4 (ความเสียหาย) | ดาวน์โหลด/คัดลอกใหม่จาก Drive แล้ว `sha256sum -c` — ห้ามแก้ไฟล์ใน package ด้วยมือ |
| CLI exit 5 (CONFLICT) | ปลายทางมีข้อมูลที่ต่างจาก package — ใช้ฐานข้อมูลใหม่ที่ว่าง หรือหาสาเหตุ (มีคนใช้ปลายทางก่อนเวลา) |
| MERGE_FAILED | transaction ถูกยกเลิกทั้งหมด (ไม่มีอะไรเขียน) — ดู `detail` ใน reports/import.json |
| กระทบยอด FAIL | ดู `checks` ที่ FAIL และ `mismatches` — แก้ปลายทางหรือนำเข้าใหม่ในฐานข้อมูลใหม่ แล้วกระทบยอดอีกครั้ง |
| adminImportPackage เกินเวลา | รันซ้ำ — ทำต่อจาก checkpoint (`reports/import-state-*.json`) |

## 10. บันทึกเวลา (กรอกทุกครั้งที่ซ้อม/ย้ายจริง)

| ขั้น | เริ่ม | เสร็จ | นาที | ผู้รับผิดชอบ | หมายเหตุ |
|---|---|---|---|---|---|
| freeze | | | | | |
| ส่งออก FULL_SNAPSHOT | | | | | |
| ตรวจ package (Apps Script + CLI) | | | | | |
| นำเข้า (dry-run / apply) | | | | | |
| กระทบยอด | | | | | |
| ทดสอบรับ + checklist | | | | | |
| cutover + routing | | | | | |

เวลาจริงบน Apps Script/Drive และ PostgreSQL ของโรงเรียน **ยังไม่ได้วัด** — ผลจากเครื่องพัฒนาไม่ใช่ตัวแทน (docs/LIMITATIONS.md)

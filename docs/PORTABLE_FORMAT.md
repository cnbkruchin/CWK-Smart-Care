# Portable package format v1 — CWK Smart Care

> รูปแบบไฟล์สำหรับย้ายข้อมูลทั้งระบบระหว่างแพลตฟอร์ม (Google Sheets ↔ Google Sheets ชุดใหม่ ↔ PostgreSQL)
> โค้ดอ้างอิง: `src/application/migration/` (format, export, process, import, reconcile, delta), CLI `tools/migrate.mjs`
> ทุก package มีสำเนาเอกสารนี้ในโฟลเดอร์ `docs/` ของ package (ตรงกับ app/schema version ที่ส่งออก)

## 1. หลักการ

1. **JSONL แบบ canonical คือแหล่งความจริง** — CSV ใน `csv/` มีไว้ให้คนเปิดตรวจเท่านั้น ห้ามใช้นำเข้า
2. ทุกไฟล์ที่ไม่ใช่รายงานผล (`reports/`) มี SHA-256 ใน manifest และ manifest มี SHA-256 ใน `manifest.sha256` (ไม่มี hash ที่อ้างถึงตัวเอง)
3. ID ภายใน (UUID), `student_code` (string รักษาเลขศูนย์นำหน้า), ภาษาไทย, null, boolean, วันที่, timestamp, version, ลิงก์การแก้ไข และประวัติ ถูกเก็บตามจริง ไม่แปลงค่า — ยกเว้น transform ที่ประกาศใน §9
4. ไม่มีความลับใน package และไม่มีอะไรที่ทำให้ระบบปลายทาง "ส่งข้อความเก่าซ้ำ" อัตโนมัติ
5. ข้อมูลไม่ครบ (ตารางไม่ครบ ไฟล์แนบหาย พิสูจน์ความสอดคล้องไม่ได้) จะถูกระบุใน `completeness` เสมอ — ไม่มีการ cutover แบบเงียบ ๆ

## 2. โครงสร้าง package

| ตำแหน่ง | เนื้อหา |
|---|---|
| `manifest.json` | export ID, app/schema version, โรงเรียน, โหมด, เวลาและ high-water mark ของ snapshot, เขตเวลา, ตาราง/partition/chunk พร้อม checksum, ตารางที่ไม่ส่งออก, transforms, ไฟล์แนบ, ความครบถ้วน, ผลพิสูจน์ความสอดคล้อง (§10) |
| `manifest.sha256` | `<sha256 hex ของ bytes ของ manifest.json>␠␠manifest.json\n` — ใช้ `sha256sum -c manifest.sha256` ตรวจได้ |
| `schema/tables/<Table>.schema.json` | JSON Schema ของแต่ละตาราง (`x-cwk`: PK, unique, FK, partition, sensitivity, retention, derived columns) |
| `schema/enums.json`, `schema/dependency-order.json` | ค่า enum (อังกฤษ + คำแปลไทย) และลำดับนำเข้าตาม FK |
| `schema/manifest.schema.json`, `schema/attachment-index.schema.json` | JSON Schema ของ manifest และ 1 บรรทัดของ attachment index |
| `data/<Table>/<partition>/part-NNNNN.jsonl` | ข้อมูลจริง 1 record ต่อบรรทัด สูงสุด 1,000 แถวต่อ chunk; `<partition>` = รหัสภาคเรียน (เช่น `AY2026-T1`), `UNPARTITIONED` หรือ `all` (ตารางไม่แบ่ง partition) |
| `csv/<Table>/<partition>/part-NNNNN.csv` | สำเนาสำหรับคน: UTF-8 BOM, CRLF, ข้อความที่ขึ้นต้น `= + - @ TAB CR` นำหน้าด้วย `'` |
| `csv/DATA_DICTIONARY.csv` | ตาราง/คอลัมน์/ชนิด/อ้างอิง/derived/สถานะการส่งออก/คำอธิบาย |
| `attachments/batch-NNNN/<logical_id>` | bytes จริงของไฟล์แนบ (ไม่ใช่ Base64) แบ่ง batch ≤ 100 MB หรือ ≤ 500 ไฟล์; ชื่อไฟล์ = logical file ID เท่านั้น |
| `attachment-index.jsonl` | 1 บรรทัดต่อไฟล์: logical_id, path, size_bytes, mime_type, sha256, classification, original_filename, links (entity_type, entity_id, purpose) |
| `metadata/config.json` | ค่าตั้งที่ไม่ใช่ความลับ (env, timezone, โหมดระบบ, feature) |
| `metadata/storage-catalog.json`, `metadata/storage-mapping.json`, `metadata/schema-versions.json` | ตำแหน่งชีต/ไฟล์ของต้นทาง (อ้างอิงเท่านั้น) และประวัติ schema |
| `metadata/archive-partitions.json` | ทุก partition ภาคเรียนในขอบเขต จำนวนแถวต่อตาราง สถานะที่เก็บ (รวม ARCHIVED/READONLY) |
| `metadata/rule-versions.json` | สรุปเวอร์ชันกฎ (ค่าตัวอย่าง `is_example`) |
| `metadata/business-totals.json` | ยอดรายงาน R01–R07 ในวันตัวอย่าง (เลือกจากกรณีซับซ้อน) ที่ต้นทางคำนวณ ณ เวลา snapshot |
| `metadata/permission-samples.json` | fingerprint สิทธิ์ของผู้ใช้ตัวอย่างทุกบทบาท (ผู้ปกครองหลายบุตรก่อน) |
| `docs/PORTABLE_FORMAT.md`, `docs/MIGRATION_RUNBOOK_TH.md` | คู่มือที่ตรงกับเวอร์ชันของ package |
| `reports/` | ผลการตรวจ/นำเข้า/กระทบยอด (ไม่อยู่ใน checksum ของ manifest — เป็นผลลัพธ์ ไม่ใช่ข้อมูล) |

## 3. manifest.json (ฟิลด์หลัก)

| ฟิลด์ | ความหมาย |
|---|---|
| `format` / `format_version` | `cwk-portable` / `1` |
| `kind` | `SNAPSHOT` (ทั้งชุดตามขอบเขต) หรือ `DELTA` (§12) |
| `export_id` | = `MigrationRuns.id` ของงานส่งออก |
| `app_version`, `schema_version` | เวอร์ชันแอปและ schema ณ เวลาส่งออก |
| `mode` | `FULL_SNAPSHOT` (ใช้สลับระบบได้) · `REHEARSAL` (ซ้อม ใช้สลับระบบไม่ได้) · `PARTIAL` (บางตาราง) |
| `snapshot` | `started_at`, `finished_at`, `frozen`, `system_mode_at_start`, `high_water_mark.change_log_seq`, `school_date`, `timezone` |
| `source` | `platform` (`GAS_SHEETS` / `MEMORY` / `POSTGRES`), `env` |
| `serialization` | กติกา §4 (encoding, newline, canonical JSON, record hash, table digest) |
| `tables[]` | `name`, `partition_mode`, `row_count`, `digest_all`, `digest_source`, `derived_columns`, `live`, `partitions[]{key,row_count,chunks[]{path,rows,bytes,sha256,first_id,last_id,csv}}` |
| `excluded_tables[]` | ตารางที่ไม่ส่งออกพร้อมเหตุผล (§9) |
| `transforms[]` | การแปลงที่ประกาศ พร้อมจำนวนแถวที่ถูกแปลง (§9) |
| `attachments` | `included`, `index{path,sha256,bytes}`, `files`, `bytes`, `batches[]`, `missing[]{logical_id,reason}` |
| `files[]` | ทุกไฟล์ใน schema/, metadata/, docs/, csv/DATA_DICTIONARY.csv พร้อม sha256 และขนาด |
| `completeness`, `completeness_reasons[]` | §11 |
| `consistency` | `checked`, `changes_after_hwm`, `non_live_tables_changed[]`, `count_mismatches[]` (§10) |

## 4. การ serialize แบบ canonical และ checksum

- **Record line** = `canonical_json(record)` ตาม `src/shared/canonical-json.js`: key เรียงตามลำดับ UTF-16 ทุกระดับ, ไม่มีช่องว่าง, string escape แบบ `JSON.stringify` (ไม่ escape ภาษาไทย), number จำกัดค่า, `-0` → `0`; บรรทัดจบด้วย LF ตัวเดียว ไม่มี BOM, ไม่มี CR
- **record** มีทุกคอลัมน์ของตารางตาม schema (null ระบุชัด) ไม่มีคอลัมน์อื่น — ค่าปริยาย (default) ไม่ถูกเติมตอนส่งออก
- **chunk checksum** = SHA-256 ของ bytes ทั้งไฟล์; ตัวตรวจคำนวณจาก bytes จริงเสมอ (ไม่ใช้ชื่อไฟล์หรือขนาดแทน)
- **record hash** = SHA-256(UTF-8(record line))
- **table digest** = ผลรวมของ record hash (ตีความเป็นจำนวนเต็ม 256 บิต) mod 2²⁵⁶ แบบ hex 64 ตัว — ไม่ขึ้นกับลำดับแถวหรือการแบ่ง chunk จึงเทียบกับปลายทางที่เรียงต่างกันได้ (ตรวจคู่กับ `row_count` และ ID ที่ไม่ซ้ำ)
- `digest_source` คิดจาก record ที่ตัด **derived columns** ออก (ค่าที่สร้างใหม่ได้ เช่น `search_name` และทุกคอลัมน์ของตาราง PROJECTION `DailyAttendance` ยกเว้น id) ส่วน `digest_all` รวมทุกคอลัมน์ — กระทบยอดรายงานแยกสองค่านี้

## 5. ค่าข้อมูล

| ชนิด schema | ใน JSONL | หมายเหตุ |
|---|---|---|
| uuid | string ตัวพิมพ์เล็ก | |
| string/text/enum/hhmm | string | `student_code` เป็น string เสมอ (`"00123"`); enum เป็นรหัสอังกฤษ |
| date | `"YYYY-MM-DD"` (ค.ศ.) | วันเรียนตามเขตเวลาโรงเรียน; แปลง พ.ศ. เฉพาะตอนแสดงผล |
| ts | `"YYYY-MM-DDTHH:mm:ss.sssZ"` (UTC) | |
| int | number | |
| bool | `true`/`false` | |
| json | object/array | |
| ค่าว่าง | `null` | string ว่างไม่ถูกเก็บ (DATA_DICTIONARY §Encoding) |

ค่าค้นหาที่ normalize (`search_name`) เป็น derived column แยกจากชื่อจริง — การย้ายไม่แก้ชื่อนักเรียน

## 6. ไฟล์แนบ

- ส่งออกเฉพาะไฟล์ที่สถานะไม่ใช่ DELETED: อ่าน bytes ผ่าน storage mapping ที่ ACTIVE, ตรวจขนาดและ SHA-256 กับ `Attachments.sha256` ก่อนเขียน; อ่านไม่ได้/ไม่ตรง → อยู่ใน `attachments.missing` และ package เป็น PARTIAL
- ปลายทางสร้าง `StorageObjectMappings` ใหม่ (logical file ID เดิม → object ใหม่) หลังเขียนและตรวจ hash — ไม่คัดลอก Drive URL
- ไม่มีไฟล์ใดถูกแชร์แบบ "ทุกคนที่มีลิงก์"

## 7. Partition และ archive

ตาราง TERM ถูกส่งออกทุก partition ที่มีในที่เก็บ (รวม partition เก่า/ที่เก็บถาวร) แยกโฟลเดอร์ตามรหัส partition ของต้นทาง แถวที่เขียนก่อนมีภาคเรียนอยู่ใน `UNPARTITIONED`; ตัวตรวจยอมรับเฉพาะรหัสภาคเรียนใน package/ปลายทาง หรือ `UNPARTITIONED` — partition ที่อ่านไม่ได้ทำให้การส่งออกล้มเหลว (ไม่ข้ามเงียบ ๆ)

## 8. reports/

| ไฟล์ | ผู้เขียน |
|---|---|
| `validation.json` | การส่งออก (ระดับ INTEGRITY บน Apps Script / FULL บน Node) และ `tools/migrate.mjs validate` (FULL) |
| `plan.json`, `import-dry-run.json`, `import.json` | `tools/migrate.mjs plan/import`, `adminImportPackage` |
| `reconciliation.json` | `tools/migrate.mjs reconcile`, `adminImportPackage` (หลังนำเข้า) |
| `delta-dry-run.json`, `delta-apply.json` | `adminApplyDelta` / applyDelta (ย้อนกลับ) |

ศูนย์ย้ายข้อมูลอ่าน `import.json` และ `reconciliation.json` เป็นหลักฐาน และตรวจว่า `manifest_sha256` ตรงกับงานส่งออกนั้น

## 9. สิ่งที่ไม่ส่งออก และการแปลงที่ประกาศ

| ตาราง | เหตุผล |
|---|---|
| MutationJournal | TRANSIENT — redo log; ตอน freeze ต้องไม่มีรายการค้าง |
| IdempotencyRecords | TRANSIENT — แคชคำขอซ้ำ 7 วัน |
| StorageCatalog | ENVIRONMENT — ตำแหน่งชีตต้นทาง (สรุปใน metadata/storage-catalog.json) |
| StorageObjectMappings | ENVIRONMENT — ปลายทางสร้างใหม่ (metadata/storage-mapping.json) |
| SchemaVersions | ENVIRONMENT — ประวัติ schema ของ component ต้นทาง |

| ตาราง.คอลัมน์ | การแปลง |
|---|---|
| InvitationRecords.code_hash | → `REDACTED` (ไม่ใช่ hash ที่ตรงกับรหัสใด) |
| InvitationRecords.status | PENDING/LOCKED → REVOKED (ออกคำเชิญใหม่ที่ปลายทาง) |
| ChannelBindings.link_nonce_hash | → null |
| NotificationOutbox.replay_blocked | → true เมื่อ delivery_state ไม่ใช่ PROVIDER_ACCEPTED/FAILED_FINAL/CANCELLED — worker ไม่ส่งซ้ำอัตโนมัติ |

ไม่อยู่ในระบบตั้งแต่แรกจึงไม่มีใน package: API keys, LINE channel secret/token, gateway HMAC secret, รหัสผ่าน, access/refresh token, OTP, session ที่ใช้งาน — **รหัสผ่าน/บัญชีของ Firebase/Google ไม่ถูกย้ายโดย package นี้** (IdentityLinks เก็บเฉพาะ provider/issuer/subject → user)

## 10. ความสอดคล้องของ snapshot (FULL_SNAPSHOT / REHEARSAL)

1. ต้องเปิด **READ_ONLY** ที่ server ก่อน (store ปฏิเสธการเขียนทุกช่องทาง ยกเว้นงานบำรุงรักษา) — งานตามเวลา (tick) ที่ไม่ใช่งานบำรุงรักษาหยุด
2. ตรวจ journal ไม่มีรายการ PREPARED/RECOVERY_REQUIRED
3. บันทึก **high-water mark H** = ChangeLog seq สูงสุด (อ่านใต้ script lock บน Apps Script) และจำนวนแถวทุกตาราง/partition
4. ส่งออกเป็น chunk พร้อม checkpoint (ทำต่อได้หลังหยุด/ล้ม)
5. **พิสูจน์ก่อนเรียกว่า COMPLETE**: ChangeLog หลัง H แตะได้เฉพาะ LIVE_TABLES (MigrationRuns, MigrationCheckpoints, Jobs, AuditEvents, OperationMetrics, BackupRuns — บันทึกงานของการส่งออกเอง) และทุกตารางที่ freeze ต้องมีจำนวนแถวเท่ากับที่นับ ณ H; ChangeLog ส่งออกถึง H และต้องต่อเนื่อง — ไม่ผ่าน = `FAILED` (`SOURCE_CHANGED_DURING_SNAPSHOT`)
6. ถ้าปลด freeze หลังส่งออก snapshot นั้นเป็นเพียงการซ้อม — ก่อน cutover ต้องส่งออก FULL_SNAPSHOT สุดท้ายใหม่ (`migration.cutover` ปฏิเสธเมื่อมีการเปลี่ยนข้อมูลธุรกิจหลัง H)

## 11. ความครบถ้วน

| ค่า | เมื่อ |
|---|---|
| COMPLETE | FULL_SNAPSHOT/REHEARSAL, ทุกตาราง, ไฟล์แนบครบและ hash ตรง, พิสูจน์ความสอดคล้องผ่าน, ไม่มี record ที่ผิด schema, ตรวจซ้ำผ่าน |
| PARTIAL | PARTIAL mode, ไม่รวมไฟล์แนบ, ไฟล์แนบบางไฟล์อ่านไม่ได้, ขาดตารางที่ถูกอ้างอิง |
| FAILED | ต้นทางเปลี่ยนระหว่าง snapshot, มี record ที่ผิด schema, ตรวจซ้ำไม่ผ่าน |

`usable_for_cutover` = ตรวจผ่าน และ COMPLETE และ FULL_SNAPSHOT — ตัวตรวจปฏิเสธ manifest ที่อ้าง COMPLETE ทั้งที่ขัดกับข้อมูลในตัวเอง (`COMPLETENESS_INVALID`)

## 12. DELTA package (ย้อนกลับหลัง cutover)

`kind = DELTA`, `delta = {base_export_id, from_seq, to_seq, tombstones: 0}`: แถวที่ถูกแตะใน ChangeLog หลัง `from_seq` (ค่าล่าสุดของแถว) + ไฟล์แนบใหม่ ไม่รวม ChangeLog, Jobs, MigrationRuns/Checkpoints, OperationMetrics, BackupRuns และตารางใน §9 — นำเข้าด้วยนโยบาย `APPLY_NEWER`: แทรกแถวใหม่; ปรับปรุงแถวเดิมเฉพาะเมื่อ version ใหม่กว่าและ version ปลายทางยังเป็นค่าที่ delta อ้างอิง; แถวที่ถูกแก้ทั้งสองฝั่ง = CONFLICT และหยุด (ไม่มีข้อมูลใหม่หาย) — แอปไม่ลบแถวแบบถาวร จึงไม่มี tombstone; การล้างบันทึกระบบตาม retention ไม่ถูก replay

## 13. เวอร์ชันและความเข้ากันได้

- ตัวตรวจรับ `format_version ≤ 1` และ `schema_version` ที่มีเส้นทาง upgrade ไปเวอร์ชันปัจจุบัน (`UPGRADES` ใน format.js — ปัจจุบันว่าง เพราะมีเพียง v1) — อื่น ๆ ถูกปฏิเสธทันที (`INCOMPATIBLE_SCHEMA`/`UNSUPPORTED_FORMAT`, CLI exit 3)
- เพิ่มคอลัมน์/ตารางใน schema ใหม่ → ต้องเพิ่ม `SCHEMA_VERSION` และฟังก์ชัน upgrade ของ record เวอร์ชันเก่า (CHANGELOG)

## 14. รหัสข้อผิดพลาดของการตรวจ

| กลุ่ม (CLI exit) | รหัส |
|---|---|
| รูปแบบ/เวอร์ชัน (3) | MANIFEST_MISSING, MANIFEST_INVALID, UNSUPPORTED_FORMAT, INCOMPATIBLE_SCHEMA |
| ความเสียหาย (4) | MANIFEST_SHA_MISSING, MANIFEST_SHA_MISMATCH, FILE_MISSING, CHUNK_MISSING, CHECKSUM_MISMATCH, SIZE_MISMATCH, ROW_COUNT_MISMATCH, ENCODING_ERROR, PARSE_ERROR, NOT_CANONICAL, DIGEST_MISMATCH, ATTACHMENT_INDEX_MISSING, ATTACHMENT_FILE_MISSING, ATTACHMENT_CHECKSUM_MISMATCH, UNSAFE_PATH, SYMLINK |
| ข้อมูล (1) | UNKNOWN_FIELD, MISSING_FIELD, RECORD_INVALID, UNKNOWN_TABLE, UNKNOWN_PARTITION, AFTER_HIGH_WATER_MARK, DUPLICATE_ID, UNIQUE_VIOLATION, FK_MISSING, FK_TO_EXCLUDED, FK_PARENT_NOT_EXPORTED, DEFERRED_OVERFLOW, ATTACHMENT_INDEX_INVALID, ATTACHMENT_NOT_IN_INDEX, ATTACHMENT_ORPHAN_INDEX, ATTACHMENT_META_MISMATCH, EXCLUSION_POLICY, COMPLETENESS_INVALID, MERGE_FAILED |
| ขัดแย้งกับปลายทาง (5) | CONFLICT |
| คำเตือน | UNLISTED_FILE, ATTACHMENTS_NOT_INCLUDED |

CLI exit อื่น: 0 สำเร็จ · 2 ใช้คำสั่งผิด/ส่ง connection string เป็น argument · 6 ปลายทางไม่พร้อม · 10 ผิดพลาดภายใน

## 15. ขนาดและ ZIP

- chunk ≤ 1,000 แถว; batch ไฟล์แนบ ≤ 100 MB หรือ ≤ 500 ไฟล์
- ZIP เป็นทางเลือกสำหรับ package เล็ก (`tools/migrate.mjs pack`, ≤ 200 MB) — ตัวอ่าน ZIP ปฏิเสธชื่อไฟล์ที่ออกนอก package, symlink, ไฟล์เข้ารหัส และอัตราบีบอัดผิดปกติ; package ใหญ่ใช้เป็นโฟลเดอร์

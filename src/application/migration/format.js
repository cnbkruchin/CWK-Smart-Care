// Portable package format v1 (docs/PORTABLE_FORMAT.md). Pure definitions shared by the exporter
// (GAS/Node), the validator, the store importer, reconciliation and tools/migrate.mjs:
//   - which tables are exported, excluded (with reason) or "live" during a frozen snapshot
//   - declared transforms applied at export (secrets redacted, no automatic replay of messages)
//   - canonical record lines, record hashes and order-independent table digests
//   - safe package paths and the manifest JSON Schema
import { TABLES, getTable, dependencyOrder, SCHEMA_VERSION, normalizeValue } from '../../schema/index.js';
import { canonicalStringify } from '../../shared/canonical-json.js';

export const FORMAT = 'cwk-portable';
export const FORMAT_VERSION = 1;
export const SUPPORTED_SCHEMA_VERSIONS = [SCHEMA_VERSION];

/**
 * Upgrade transforms for packages exported with an older schema_version: {fromVersion: (table, record) → record}.
 * Empty while schema v1 is the only released version; validation rejects versions with no path here.
 */
export const UPGRADES = Object.freeze({});

export function upgradePath(fromVersion) {
  if (fromVersion === SCHEMA_VERSION) return [];
  if (!Number.isInteger(fromVersion) || fromVersion > SCHEMA_VERSION) return null;
  const steps = [];
  for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
    if (!UPGRADES[v]) return null;
    steps.push(v);
  }
  return steps;
}

export const CHUNK_ROWS = 1000;
export const ATTACHMENT_BATCH_BYTES = 100 * 1024 * 1024;
export const ATTACHMENT_BATCH_FILES = 500;
export const MAX_PACKAGE_FILE_BYTES = 200 * 1024 * 1024;

/** Tables never written to data/ — the reason is recorded in manifest.excluded_tables. */
export const EXCLUDED_TABLES = Object.freeze({
  MutationJournal: { reason: 'TRANSIENT', note_th: 'redo log ของ Sheets — ตอน freeze ต้องไม่มีรายการค้าง (ตรวจก่อนส่งออก) จึงไม่มีข้อมูลที่ต้องย้าย' },
  IdempotencyRecords: { reason: 'TRANSIENT', note_th: 'แคชคำขอซ้ำอายุ 7 วัน มีผลลัพธ์ของคำขอเดิม — ระบบปลายทางเริ่มใหม่ว่าง' },
  StorageCatalog: { reason: 'ENVIRONMENT', note_th: 'รหัส workbook/ชีตของ environment ต้นทาง — ปลายทางสร้างของตนเอง', metadata: 'metadata/storage-catalog.json' },
  StorageObjectMappings: { reason: 'ENVIRONMENT', note_th: 'รหัสไฟล์ Drive ต้นทาง — ปลายทางสร้าง mapping ใหม่หลังคัดลอกไฟล์และตรวจ SHA-256', metadata: 'metadata/storage-mapping.json' },
  SchemaVersions: { reason: 'ENVIRONMENT', note_th: 'ประวัติ schema ของ component ต้นทาง — ปลายทางบันทึกของตนเอง', metadata: 'metadata/schema-versions.json' },
});

/**
 * Operational tables that the export itself (or maintenance-allowed tasks) may write while the source is
 * frozen. Their rows are exported as read during the run and are not covered by the consistency proof.
 * ChangeLog is exported up to the high-water mark only.
 */
export const LIVE_TABLES = Object.freeze(['MigrationRuns', 'MigrationCheckpoints', 'Jobs', 'AuditEvents', 'OperationMetrics', 'BackupRuns']);

const TERMINAL_DELIVERY = new Set(['PROVIDER_ACCEPTED', 'FAILED_FINAL', 'CANCELLED']);

/** Declared transforms (manifest.transforms). The exporter applies them; nothing else changes values. */
export const TRANSFORMS = Object.freeze([
  { table: 'InvitationRecords', column: 'code_hash', rule: 'REDACT', to: 'REDACTED', note_th: 'ไม่ส่งออก hash ของรหัสคำเชิญ (invitation secret) — ค่า REDACTED ไม่ตรงกับรหัสใดได้' },
  { table: 'InvitationRecords', column: 'status', rule: 'PENDING|LOCKED → REVOKED', note_th: 'คำเชิญที่ยังไม่ใช้ใช้ต่อไม่ได้หลังย้าย — ออกคำเชิญใหม่ที่ปลายทาง' },
  { table: 'ChannelBindings', column: 'link_nonce_hash', rule: 'NULL', note_th: 'nonce สำหรับเชื่อม LINE เป็นความลับใช้ครั้งเดียว' },
  { table: 'NotificationOutbox', column: 'replay_blocked', rule: 'true when delivery_state not in PROVIDER_ACCEPTED|FAILED_FINAL|CANCELLED', note_th: 'รายการที่ยังไม่ส่งจะไม่ถูกส่งอัตโนมัติที่ปลายทาง — ผู้ดูแลตรวจแล้วสั่งส่งใหม่เอง' },
]);

/** Apply the declared transforms. Returns the (possibly new) record and the transform keys applied. */
export function applyExportTransforms(table, rec) {
  const applied = [];
  let out = rec;
  const set = (col, v, key) => {
    if (out[col] === v) return;
    if (out === rec) out = { ...rec };
    out[col] = v;
    applied.push(key);
  };
  if (table === 'InvitationRecords') {
    set('code_hash', 'REDACTED', 'InvitationRecords.code_hash');
    if (out.status === 'PENDING' || out.status === 'LOCKED') set('status', 'REVOKED', 'InvitationRecords.status');
  } else if (table === 'ChannelBindings') {
    if (out.link_nonce_hash !== null && out.link_nonce_hash !== undefined) set('link_nonce_hash', null, 'ChannelBindings.link_nonce_hash');
  } else if (table === 'NotificationOutbox') {
    if (!TERMINAL_DELIVERY.has(out.delivery_state)) set('replay_blocked', true, 'NotificationOutbox.replay_blocked');
  }
  return { record: out, applied };
}

/** Exported tables in dependency order (parents first). */
export function exportTables() {
  return dependencyOrder().filter((t) => !EXCLUDED_TABLES[t]);
}

export function isLiveTable(table) {
  return LIVE_TABLES.includes(table);
}

/** Columns rebuilt from source records (compared separately during reconciliation). */
export function derivedColumns(table) {
  const t = getTable(table);
  if (t.kind === 'PROJECTION') return t.columns.filter((c) => c.name !== 'id').map((c) => c.name);
  return t.columns.filter((c) => c.derived).map((c) => c.name);
}

export function sourceView(table, rec) {
  const d = derivedColumns(table);
  if (!d.length) return rec;
  const out = {};
  for (const k of Object.keys(rec)) if (!d.includes(k)) out[k] = rec[k];
  return out;
}

// ───────── canonical lines, hashes, digests ─────────

/**
 * Canonical record: exactly the table's columns in canonical types, NO defaults applied (a stored null
 * stays null). Used for export lines, import comparison and reconciliation on every platform.
 */
export function canonicalRecord(table, rec) {
  const out = {};
  for (const c of getTable(table).columns) out[c.name] = normalizeValue(c, rec[c.name]);
  return out;
}

export function recordLine(rec) {
  return canonicalStringify(rec);
}

export const ZERO_DIGEST = '0'.repeat(64);

/** Order-independent table digest: Σ record SHA-256 (as 256-bit integers) mod 2^256, hex. */
export function digestAdd(a, b) {
  let carry = 0;
  let out = '';
  for (let i = 56; i >= 0; i -= 8) {
    const s = parseInt(a.slice(i, i + 8), 16) + parseInt(b.slice(i, i + 8), 16) + carry;
    carry = s >= 0x100000000 ? 1 : 0;
    out = (s % 0x100000000).toString(16).padStart(8, '0') + out;
  }
  return out;
}

/** Accumulates row count + digests of one table (both the full record and its source view). */
export function newTableAcc() {
  return { rows: 0, digest_all: ZERO_DIGEST, digest_source: ZERO_DIGEST };
}

export function accumulate(acc, table, rec, sha256Hex, line = null) {
  const l = line || recordLine(rec);
  const hAll = sha256Hex(l);
  acc.rows += 1;
  acc.digest_all = digestAdd(acc.digest_all, hAll);
  acc.digest_source = digestAdd(acc.digest_source, derivedColumns(table).length ? sha256Hex(recordLine(sourceView(table, rec))) : hAll);
  return acc;
}

// ───────── paths ─────────

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Package-relative path check: no absolute paths, no "..", no backslashes, no hidden segments. */
export function isSafePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 240 && SAFE_PATH.test(p) && !p.split('/').some((s) => s === '..' || s === '.');
}

export function partitionDir(partition) {
  return partition === '*' ? 'all' : partition;
}

export function chunkPath(table, partition, n) {
  return `data/${table}/${partitionDir(partition)}/part-${String(n).padStart(5, '0')}.jsonl`;
}

export function csvPath(table, partition, n) {
  return `csv/${table}/${partitionDir(partition)}/part-${String(n).padStart(5, '0')}.csv`;
}

export function attachmentBatchDir(n) {
  return `attachments/batch-${String(n).padStart(4, '0')}`;
}

/** Files that the manifest does not list (outputs of validation/reconciliation tools). */
export function isUnlistedOutput(p) {
  return p === 'manifest.json' || p === 'manifest.sha256' || p.startsWith('reports/');
}

/** sha256sum-compatible line so `sha256sum -c manifest.sha256` works. */
export function manifestShaLine(hex) {
  return `${hex}  manifest.json\n`;
}

export function parseManifestShaLine(text) {
  const m = /^([0-9a-f]{64}) {2}manifest\.json\n?$/.exec(String(text || ''));
  return m ? m[1] : null;
}

// ───────── manifest JSON Schema (also published as schema/portable/manifest.schema.json) ─────────

const HEX64 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const PATH = { type: 'string', pattern: SAFE_PATH.source, maxLength: 240 };
const TS = { type: 'string', format: 'date-time' };
const fileRef = { type: 'object', additionalProperties: false, required: ['path', 'sha256', 'bytes'], properties: { path: PATH, sha256: HEX64, bytes: { type: 'integer', minimum: 0 } } };
const chunkRef = {
  type: 'object', additionalProperties: false, required: ['path', 'rows', 'bytes', 'sha256'],
  properties: { path: PATH, rows: { type: 'integer', minimum: 0 }, bytes: { type: 'integer', minimum: 0 }, sha256: HEX64, first_id: { type: ['string', 'null'] }, last_id: { type: ['string', 'null'] }, csv: { type: ['object', 'null'], additionalProperties: false, properties: { path: PATH, sha256: HEX64, bytes: { type: 'integer', minimum: 0 } } } },
};

export const MANIFEST_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cwk-smart-care.example.com/schema/portable/v1/manifest.schema.json',
  title: 'CWK portable package manifest v1',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'format_version', 'kind', 'export_id', 'app_version', 'schema_version', 'mode', 'snapshot', 'source', 'serialization', 'tables', 'excluded_tables', 'transforms', 'attachments', 'files', 'completeness', 'completeness_reasons', 'consistency', 'created_at'],
  properties: {
    format: { type: 'string', const: FORMAT },
    format_version: { type: 'integer', minimum: 1 },
    kind: { type: 'string', enum: ['SNAPSHOT', 'DELTA'] },
    export_id: { type: 'string', format: 'uuid' },
    app_version: { type: 'string', maxLength: 40 },
    schema_version: { type: 'integer', minimum: 1 },
    school: { type: ['object', 'null'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' }, code: { type: 'string' }, name_th: { type: 'string' } } },
    mode: { type: 'string', enum: ['FULL_SNAPSHOT', 'REHEARSAL', 'PARTIAL'] },
    snapshot: {
      type: 'object', additionalProperties: false, required: ['started_at', 'finished_at', 'frozen', 'high_water_mark', 'school_date', 'timezone'],
      properties: { started_at: TS, finished_at: TS, frozen: { type: 'boolean' }, system_mode_at_start: { type: 'string' }, high_water_mark: { type: 'object', additionalProperties: false, required: ['change_log_seq'], properties: { change_log_seq: { type: 'integer', minimum: 0 } } }, school_date: { type: 'string', format: 'date' }, timezone: { type: 'string' } },
    },
    delta: { type: ['object', 'null'], additionalProperties: false, properties: { base_export_id: { type: 'string', format: 'uuid' }, from_seq: { type: 'integer', minimum: 0 }, to_seq: { type: 'integer', minimum: 0 }, tombstones: { type: 'integer', minimum: 0 } } },
    source: { type: 'object', additionalProperties: false, required: ['platform', 'env'], properties: { platform: { type: 'string', enum: ['GAS_SHEETS', 'MEMORY', 'POSTGRES'] }, env: { type: 'string' } } },
    serialization: { type: 'object', additionalProperties: false, required: ['encoding', 'newline', 'canonical_json', 'record_hash', 'table_digest'], properties: { encoding: { const: 'UTF-8', type: 'string' }, newline: { const: 'LF', type: 'string' }, canonical_json: { type: 'string' }, record_hash: { type: 'string' }, table_digest: { type: 'string' } } },
    tables: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['name', 'partition_mode', 'row_count', 'digest_all', 'digest_source', 'derived_columns', 'live', 'partitions'],
        properties: {
          name: { type: 'string' }, partition_mode: { type: 'string', enum: ['TERM', 'NONE'] }, row_count: { type: 'integer', minimum: 0 }, digest_all: HEX64, digest_source: HEX64,
          derived_columns: { type: 'array', items: { type: 'string' } }, live: { type: 'boolean' },
          partitions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'row_count', 'chunks'], properties: { key: { type: 'string', maxLength: 40 }, row_count: { type: 'integer', minimum: 0 }, chunks: { type: 'array', items: chunkRef } } } },
        },
      },
    },
    excluded_tables: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'reason'], properties: { name: { type: 'string' }, reason: { type: 'string', enum: ['TRANSIENT', 'ENVIRONMENT', 'NOT_SELECTED'] }, note_th: { type: 'string' }, metadata_path: { type: ['string', 'null'] } } } },
    transforms: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['table', 'column', 'rule', 'rows_affected'], properties: { table: { type: 'string' }, column: { type: 'string' }, rule: { type: 'string' }, rows_affected: { type: 'integer', minimum: 0 }, note_th: { type: 'string' } } } },
    attachments: {
      type: 'object', additionalProperties: false, required: ['included', 'files', 'bytes', 'missing'],
      properties: {
        included: { type: 'boolean' }, index: { type: ['object', 'null'], additionalProperties: false, properties: { path: PATH, sha256: HEX64, bytes: { type: 'integer', minimum: 0 } } },
        files: { type: 'integer', minimum: 0 }, bytes: { type: 'integer', minimum: 0 },
        batches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: PATH, files: { type: 'integer', minimum: 0 }, bytes: { type: 'integer', minimum: 0 } } } },
        missing: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['logical_id', 'reason'], properties: { logical_id: { type: 'string', format: 'uuid' }, reason: { type: 'string' } } } },
      },
    },
    files: { type: 'array', items: fileRef },
    completeness: { type: 'string', enum: ['COMPLETE', 'PARTIAL', 'FAILED'] },
    completeness_reasons: { type: 'array', items: { type: 'string' } },
    consistency: { type: 'object', additionalProperties: false, required: ['checked'], properties: { checked: { type: 'boolean' }, changes_after_hwm: { type: 'integer', minimum: 0 }, non_live_tables_changed: { type: 'array', items: { type: 'string' } }, count_mismatches: { type: 'array', items: { type: 'string' } } } },
    created_at: TS,
    created_by: { type: ['string', 'null'] },
  },
});

/** One line of attachment-index.jsonl. */
export const ATTACHMENT_INDEX_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cwk-smart-care.example.com/schema/portable/v1/attachment-index.schema.json',
  title: 'attachment-index.jsonl line',
  type: 'object',
  additionalProperties: false,
  required: ['logical_id', 'path', 'size_bytes', 'mime_type', 'sha256', 'classification', 'links'],
  properties: {
    logical_id: { type: 'string', format: 'uuid' }, path: PATH, size_bytes: { type: 'integer', minimum: 0 }, mime_type: { type: 'string', maxLength: 100 }, sha256: HEX64,
    classification: { type: 'string' }, original_filename: { type: ['string', 'null'], maxLength: 255 },
    links: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['entity_type', 'entity_id'], properties: { entity_type: { type: 'string' }, entity_id: { type: 'string', format: 'uuid' }, purpose: { type: ['string', 'null'] } } } },
  },
});

/** Human-readable data dictionary written to csv/DATA_DICTIONARY.csv in every package. */
export function dataDictionaryRows() {
  const rows = [];
  for (const t of TABLES) {
    for (const c of t.columns) {
      rows.push([t.name, c.name, c.type === 'enum' ? `enum:${c.enum}` : c.type, c.required ? 'yes' : 'no', c.fk || '', derivedColumns(t.name).includes(c.name) ? 'derived' : 'source', EXCLUDED_TABLES[t.name] ? `excluded:${EXCLUDED_TABLES[t.name].reason}` : 'exported', c.description_th || '']);
    }
  }
  return { headers: ['table', 'column', 'type', 'required', 'references', 'kind', 'export', 'description_th'], rows };
}

// Schema helpers: lookup, canonical record normalization, record validation, dependency order
// and JSON Schema generation. Shared by all adapters and migration tooling.

import { TABLES, SCHEMA_VERSION, OPTIONAL_MODULES } from './tables.js';
import { ENUMS } from './enums.js';
import { isUuid } from '../shared/uuid.js';
import { isIsoDate, isIsoTimestamp, isHhMm } from '../shared/time.js';
import { AppError, fieldError } from '../shared/errors.js';

export { TABLES, SCHEMA_VERSION, OPTIONAL_MODULES, ENUMS };

export const TABLE_MAP = Object.freeze(Object.fromEntries(TABLES.map((t) => [t.name, t])));

export function getTable(name) {
  const t = TABLE_MAP[name];
  if (!t) throw new AppError('INTERNAL_ERROR', `unknown table ${name}`);
  return t;
}

export function columnNames(tableName) {
  return getTable(tableName).columns.map((c) => c.name);
}

export function isAppendOnly(tableName) {
  return getTable(tableName).kind === 'EVENT';
}

export function hasVersion(tableName) {
  return getTable(tableName).columns.some((c) => c.name === 'version');
}

export function secretColumns(tableName) {
  return getTable(tableName).columns.filter((c) => c.secret).map((c) => c.name);
}

export function uniqueKeys(tableName) {
  return (getTable(tableName).unique || []).map((u) => (Array.isArray(u) ? { columns: u, where: null, nullsNotDistinct: false } : { where: null, nullsNotDistinct: false, ...u }));
}

/** Tables in foreign-key dependency order (parents first). Self references and deferrable FKs are ignored. */
export function dependencyOrder() {
  const deps = new Map();
  for (const t of TABLES) {
    const set = new Set();
    for (const c of t.columns) if (c.fk && c.fk !== t.name && !c.deferrable) set.add(c.fk);
    deps.set(t.name, set);
  }
  const order = [];
  const state = new Map();
  const visit = (name, stack) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`FK cycle: ${[...stack, name].join(' -> ')}`);
    state.set(name, 'visiting');
    for (const d of [...deps.get(name)].sort()) visit(d, [...stack, name]);
    state.set(name, 'done');
    order.push(name);
  };
  for (const t of TABLES) visit(t.name, []);
  return order;
}

// ───────────── canonical value normalization ─────────────

export function normalizeValue(col, value) {
  if (value === undefined || value === null || value === '') return null;
  switch (col.type) {
    case 'uuid':
      return String(value).toLowerCase();
    case 'string':
    case 'text':
    case 'enum':
    case 'hhmm':
      return String(value);
    case 'date':
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value).slice(0, 10);
    case 'ts':
      if (value instanceof Date) return value.toISOString();
      return isIsoTimestamp(String(value)) ? new Date(String(value)).toISOString() : String(value);
    case 'int':
      return typeof value === 'number' ? value : Number(value);
    case 'decimal':
      return String(value);
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (value === 'TRUE' || value === 'true' || value === 1) return true;
      if (value === 'FALSE' || value === 'false' || value === 0) return false;
      return value;
    case 'json':
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return value; }
      }
      return value;
    default:
      return value;
  }
}

/** Returns a new object with exactly the table's columns, canonical types, unknown keys dropped. */
export function normalizeRecord(tableName, record) {
  const t = getTable(tableName);
  const out = {};
  for (const c of t.columns) {
    let v = record[c.name];
    if ((v === undefined || v === null || v === '') && c.default !== undefined) v = c.default;
    out[c.name] = normalizeValue(c, v);
  }
  return out;
}

function checkType(col, v) {
  switch (col.type) {
    case 'uuid': return isUuid(v);
    case 'string': case 'text': return typeof v === 'string';
    case 'enum': return typeof v === 'string' && ENUMS[col.enum].values.includes(v);
    case 'hhmm': return isHhMm(v);
    case 'date': return isIsoDate(v);
    case 'ts': return isIsoTimestamp(v);
    case 'int': return Number.isInteger(v);
    case 'decimal': return /^-?\d+(\.\d+)?$/.test(v);
    case 'bool': return typeof v === 'boolean';
    case 'json': return typeof v === 'object';
    default: return false;
  }
}

/** Validate a canonical record. Returns field errors (empty = valid). */
export function validateRecord(tableName, record) {
  const t = getTable(tableName);
  const errors = [];
  for (const c of t.columns) {
    const v = record[c.name];
    if (v === null || v === undefined) {
      if (c.required) errors.push(fieldError(c.name, 'REQUIRED', 'กรุณากรอกข้อมูล'));
      continue;
    }
    if (!checkType(c, v)) {
      errors.push(fieldError(c.name, c.type === 'enum' ? 'ENUM' : 'TYPE', c.type === 'enum' ? 'ค่าที่เลือกไม่อยู่ในรายการที่อนุญาต' : 'ชนิดข้อมูลไม่ถูกต้อง'));
      continue;
    }
    if ((c.type === 'string' || c.type === 'text') && c.maxLength && v.length > c.maxLength) errors.push(fieldError(c.name, 'MAX_LENGTH', `ยาวเกิน ${c.maxLength} ตัวอักษร`));
    if (c.type === 'json' && c.maxLength && JSON.stringify(v).length > c.maxLength) errors.push(fieldError(c.name, 'MAX_LENGTH', 'ข้อมูลยาวเกินกำหนด'));
    if (c.pattern && typeof v === 'string' && !new RegExp(c.pattern).test(v)) errors.push(fieldError(c.name, 'PATTERN', 'รูปแบบข้อมูลไม่ถูกต้อง'));
    if (c.type === 'int' && c.min !== undefined && v < c.min) errors.push(fieldError(c.name, 'MINIMUM', `ต้องไม่น้อยกว่า ${c.min}`));
    if (c.type === 'int' && c.max !== undefined && v > c.max) errors.push(fieldError(c.name, 'MAXIMUM', `ต้องไม่มากกว่า ${c.max}`));
    if (c.type === 'json' && c.items && c.items.enum && Array.isArray(v)) {
      const allowed = ENUMS[c.items.enum].values;
      if (v.some((x) => !allowed.includes(x))) errors.push(fieldError(c.name, 'ENUM', 'มีค่าที่ไม่อยู่ในรายการที่อนุญาต'));
    }
  }
  return errors;
}

export function assertValidRecord(tableName, record) {
  const errors = validateRecord(tableName, record);
  if (errors.length) {
    throw new AppError('VALIDATION_ERROR', `invalid ${tableName} record: ${errors.map((e) => `${e.field}:${e.code}`).join(',')}`, { fieldErrors: errors });
  }
  return record;
}

// ───────────── JSON Schema generation (portable format & docs) ─────────────

function columnJsonSchema(c) {
  const base = {};
  switch (c.type) {
    case 'uuid': Object.assign(base, { type: 'string', format: 'uuid' }); break;
    case 'string': case 'text': Object.assign(base, { type: 'string' }); if (c.maxLength) base.maxLength = c.maxLength; if (c.pattern) base.pattern = c.pattern; break;
    case 'enum': Object.assign(base, { type: 'string', enum: [...ENUMS[c.enum].values] }); break;
    case 'hhmm': Object.assign(base, { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }); break;
    case 'date': Object.assign(base, { type: 'string', format: 'date' }); break;
    case 'ts': Object.assign(base, { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }); break;
    case 'int': Object.assign(base, { type: 'integer' }); if (c.min !== undefined) base.minimum = c.min; if (c.max !== undefined) base.maximum = c.max; break;
    case 'decimal': Object.assign(base, { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' }); break;
    case 'bool': Object.assign(base, { type: 'boolean' }); break;
    case 'json': Object.assign(base, { type: ['object', 'array'] }); break;
  }
  if (c.description_th) base.description = c.description_th;
  if (!c.required) {
    base.type = Array.isArray(base.type) ? [...base.type, 'null'] : [base.type, 'null'];
    if (base.enum) base.enum = [...base.enum, null];
  }
  return base;
}

export function tableJsonSchema(tableName) {
  const t = getTable(tableName);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://cwk-smart-care.example.com/schema/v${SCHEMA_VERSION}/tables/${t.name}.schema.json`,
    title: t.name,
    description: t.description_th,
    type: 'object',
    additionalProperties: false,
    required: t.columns.map((c) => c.name),
    properties: Object.fromEntries(t.columns.map((c) => [c.name, columnJsonSchema(c)])),
    'x-cwk': {
      group: t.group, kind: t.kind, partition: t.partition, partition_column: t.partitionColumn || null,
      sensitivity: t.sensitivity, retention: t.retention,
      primary_key: ['id'], unique: uniqueKeys(t.name),
      foreign_keys: t.columns.filter((c) => c.fk).map((c) => ({ column: c.name, references: `${c.fk}.id`, deferrable: !!(c.deferrable || c.fk === t.name) })),
      secret_columns: secretColumns(t.name), derived_columns: t.columns.filter((c) => c.derived).map((c) => c.name),
    },
  };
}

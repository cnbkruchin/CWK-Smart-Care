// Small JSON-Schema (draft 2020-12 subset) validator shared by GAS, Node and the browser.
// Supported keywords: type (incl. arrays / "null"), enum, const, format (uuid|date|timestamp|hhmm|email),
// pattern, minLength, maxLength, minimum, maximum, minItems, maxItems, uniqueItems, items,
// properties, required, additionalProperties (boolean). Unknown keywords are ignored by design
// (descriptions, examples, x-* annotations).

import { isUuid } from './uuid.js';
import { isIsoDate, isIsoTimestamp, isHhMm } from './time.js';
import { fieldError, validationError } from './errors.js';

const FORMAT_CHECKS = {
  uuid: isUuid,
  date: isIsoDate,
  timestamp: isIsoTimestamp,
  'date-time': isIsoTimestamp,
  hhmm: isHhMm,
  email: (v) => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(v) && v.length <= 254,
};

const FORMAT_TH = {
  uuid: 'รหัสอ้างอิงไม่ถูกต้อง',
  date: 'วันที่ไม่ถูกต้อง (ต้องเป็น ค.ศ. รูปแบบ YYYY-MM-DD)',
  timestamp: 'เวลาไม่ถูกต้อง',
  'date-time': 'เวลาไม่ถูกต้อง',
  hhmm: 'เวลาไม่ถูกต้อง (รูปแบบ HH:MM)',
  email: 'อีเมลไม่ถูกต้อง',
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

/** Returns an array of field errors (empty when valid). */
export function validateValue(schema, value, path = '', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, actual))) {
      if (value === undefined || value === null) errors.push(fieldError(path || '(root)', 'REQUIRED', 'กรุณากรอกข้อมูล'));
      else errors.push(fieldError(path || '(root)', 'TYPE', 'ชนิดข้อมูลไม่ถูกต้อง'));
      return errors;
    }
  }
  if (value === null) return errors;
  if (schema.const !== undefined && value !== schema.const) errors.push(fieldError(path, 'CONST', 'ค่าไม่ถูกต้อง'));
  if (schema.enum && !schema.enum.includes(value)) errors.push(fieldError(path, 'ENUM', 'ค่าที่เลือกไม่อยู่ในรายการที่อนุญาต'));
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(fieldError(path, 'MIN_LENGTH', schema.minLength <= 1 ? 'กรุณากรอกข้อมูล' : `ต้องมีอย่างน้อย ${schema.minLength} ตัวอักษร`));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(fieldError(path, 'MAX_LENGTH', `ยาวเกิน ${schema.maxLength} ตัวอักษร`));
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(fieldError(path, 'PATTERN', schema['x-pattern-th'] || 'รูปแบบข้อมูลไม่ถูกต้อง'));
    if (schema.format && FORMAT_CHECKS[schema.format] && !FORMAT_CHECKS[schema.format](value)) errors.push(fieldError(path, 'FORMAT', FORMAT_TH[schema.format]));
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(fieldError(path, 'MINIMUM', `ต้องไม่น้อยกว่า ${schema.minimum}`));
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(fieldError(path, 'MAXIMUM', `ต้องไม่มากกว่า ${schema.maximum}`));
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(fieldError(path, 'MIN_ITEMS', `ต้องเลือกอย่างน้อย ${schema.minItems} รายการ`));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(fieldError(path, 'MAX_ITEMS', `เลือกได้ไม่เกิน ${schema.maxItems} รายการ`));
    if (schema.uniqueItems) {
      const seen = new Set(value.map((x) => JSON.stringify(x)));
      if (seen.size !== value.length) errors.push(fieldError(path, 'UNIQUE_ITEMS', 'มีรายการซ้ำ'));
    }
    if (schema.items) value.forEach((item, i) => validateValue(schema.items, item, `${path}[${i}]`, errors));
  }
  if (actual === 'object') {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (value[req] === undefined || value[req] === null || value[req] === '') {
        if (!(props[req] && Array.isArray(props[req].type) && props[req].type.includes('null') && value[req] === null)) {
          errors.push(fieldError(path ? `${path}.${req}` : req, 'REQUIRED', 'กรุณากรอกข้อมูล'));
        }
      }
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = props[k];
      if (sub) {
        if (v !== undefined) validateValue(sub, v, path ? `${path}.${k}` : k, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(fieldError(path ? `${path}.${k}` : k, 'UNKNOWN_FIELD', 'มีข้อมูลที่ไม่รองรับ'));
      }
    }
  }
  return errors;
}

export function assertValid(schema, value, message) {
  const errors = validateValue(schema, value);
  if (errors.length) throw validationError(errors, message || 'payload validation failed');
  return value;
}

/** Trim strings recursively and convert empty strings to null (empty string is not a stored value; see DATA_DICTIONARY §Encoding). */
export function normalizeInput(value) {
  if (typeof value === 'string') {
    const t = value.replace(/\u0000/g, '').trim();
    return t === '' ? null : t;
  }
  if (Array.isArray(value)) return value.map(normalizeInput);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeInput(v);
    return out;
  }
  return value;
}

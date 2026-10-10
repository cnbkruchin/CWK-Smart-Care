// Shared schema fragments and helpers for operation definitions.
import { ENUMS } from '../../schema/enums.js';
import { AppError } from '../../shared/errors.js';

export const S = {
  uuid: { type: 'string', format: 'uuid' },
  uuidOrNull: { type: ['string', 'null'], format: 'uuid' },
  date: { type: 'string', format: 'date' },
  dateOrNull: { type: ['string', 'null'], format: 'date' },
  ts: { type: 'string', format: 'timestamp' },
  hhmm: { type: 'string', format: 'hhmm' },
  str: (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max }),
  strOrNull: (max) => ({ type: ['string', 'null'], maxLength: max }),
  int: (min, max) => ({ type: 'integer', minimum: min, maximum: max }),
  bool: { type: 'boolean' },
  enum: (name) => ({ type: 'string', enum: [...ENUMS[name].values] }),
  enumOrNull: (name) => ({ type: ['string', 'null'], enum: [...ENUMS[name].values, null] }),
  enumList: (name, min = 0) => ({ type: 'array', minItems: min, uniqueItems: true, items: { type: 'string', enum: [...ENUMS[name].values] } }),
  cursor: { type: ['string', 'null'], maxLength: 500 },
  limit: { type: ['integer', 'null'], minimum: 1, maximum: 200 },
  studentCode: { type: 'string', pattern: '^[0-9A-Za-z-]{1,20}$', maxLength: 20, 'x-pattern-th': 'รหัสนักเรียนใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ และ -' },
};

export function obj(properties, required = []) {
  return { type: 'object', additionalProperties: false, required, properties };
}

export const EMPTY = obj({});

/** Normalized search key — NOT a replacement for the original name (DATA_DICTIONARY §1). */
export function searchKey(...parts) {
  return parts.filter(Boolean).join(' ').normalize('NFC').toLowerCase().replace(/[\s​ ]+/g, ' ').trim();
}

export function assertVersion(record, expected) {
  if (expected != null && record.version !== expected) {
    throw new AppError('CONFLICT', 'stale version', { details: { current_version: record.version, expected_version: expected } });
  }
}

export function notFound(what = 'record') {
  return new AppError('NOT_FOUND', `${what} not found`);
}

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, display_name: u.display_name, user_type: u.user_type, status: u.status, staff_code: u.staff_code, contact_email: u.contact_email, version: u.version };
}

export function basicStudent(s, cls) {
  return {
    id: s.id, student_code: s.student_code, prefix_th: s.prefix_th, first_name_th: s.first_name_th, last_name_th: s.last_name_th,
    nickname: s.nickname, status: s.status, photo_file_id: s.photo_file_id,
    class_id: cls ? cls.id : null, class_code: cls ? cls.code : null, class_name_th: cls ? cls.name_th : null, version: s.version,
  };
}

export function fullStudent(s, cls) {
  return { ...basicStudent(s, cls), first_name_en: s.first_name_en, last_name_en: s.last_name_en, gender: s.gender, birth_date: s.birth_date, status_effective_date: s.status_effective_date };
}

export function displayName(s) {
  return [s.prefix_th, s.first_name_th, s.last_name_th].filter(Boolean).join(' ').replace(/^(ด\.ช\.|ด\.ญ\.|นาย|นางสาว|นาง) /, '$1');
}

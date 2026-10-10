// Import templates and row normalization (MASTER_PROMPT §7.1). Values arrive as strings; typing is
// explicit per column. Student codes and phone numbers stay strings (leading zeros preserved).
// Duplicate names are reported as warnings, never merged — identity comes from school-issued codes.

import { ENUMS } from '../../schema/enums.js';
import { isIsoDate } from '../../shared/time.js';

const FORMULA_LIKE = /^[=+\-@]/;

const TH_ALIASES = {
  GradeLevel: { 'ม.1': 'M1', 'ม.2': 'M2', 'ม.3': 'M3', 'ม.4': 'M4', 'ม.5': 'M5', 'ม.6': 'M6' },
  Gender: { ชาย: 'MALE', หญิง: 'FEMALE', อื่นๆ: 'OTHER', 'อื่น ๆ': 'OTHER', ไม่ระบุ: 'UNSPECIFIED' },
  Relationship: { บิดา: 'FATHER', พ่อ: 'FATHER', มารดา: 'MOTHER', แม่: 'MOTHER', ปู่: 'GRANDPARENT', ย่า: 'GRANDPARENT', ตา: 'GRANDPARENT', ยาย: 'GRANDPARENT', พี่: 'SIBLING', น้อง: 'SIBLING', ญาติ: 'RELATIVE', ผู้ปกครองตามกฎหมาย: 'LEGAL_GUARDIAN', อื่นๆ: 'OTHER' },
  DayType: { วันเรียน: 'SCHOOL_DAY', วันหยุด: 'HOLIDAY', งดการเรียน: 'NO_SCHOOL', วันสอบ: 'EXAM_DAY', วันกิจกรรม: 'ACTIVITY_DAY' },
};

/** column kinds: code | text | name | enum:<Enum> | date | int | bool | phone | email | roles */
export const IMPORT_TYPES = {
  STUDENTS: {
    label_th: 'นักเรียน (พร้อมห้องเรียนเริ่มต้น)',
    columns: [
      ['student_code', 'code', true, 'รหัสนักเรียน'], ['prefix_th', 'name', false, 'คำนำหน้า'], ['first_name_th', 'name', true, 'ชื่อ'], ['last_name_th', 'name', true, 'นามสกุล'],
      ['first_name_en', 'name', false, 'ชื่อ (อังกฤษ)'], ['last_name_en', 'name', false, 'นามสกุล (อังกฤษ)'], ['nickname', 'name', false, 'ชื่อเล่น'], ['gender', 'enum:Gender', false, 'เพศ'],
      ['birth_date', 'date', false, 'วันเกิด'], ['class_code', 'text', true, 'ห้อง (เช่น M1/1)'], ['roll_no', 'int', false, 'เลขที่'], ['effective_from', 'date', false, 'วันที่มีผล'],
    ],
  },
  GUARDIANS: {
    label_th: 'ผู้ปกครองและความสัมพันธ์',
    columns: [
      ['student_code', 'code', true, 'รหัสนักเรียน'], ['guardian_ref', 'code', true, 'รหัสผู้ปกครองที่โรงเรียนรับรอง'], ['prefix_th', 'name', false, 'คำนำหน้า'],
      ['first_name_th', 'name', true, 'ชื่อ'], ['last_name_th', 'name', true, 'นามสกุล'], ['relationship', 'enum:Relationship', true, 'ความสัมพันธ์'],
      ['phone', 'phone', false, 'โทรศัพท์'], ['email', 'email', false, 'อีเมล'], ['is_primary_contact', 'bool', false, 'ผู้ติดต่อหลัก'], ['contact_priority', 'int', false, 'ลำดับติดต่อ'],
    ],
  },
  CLASSES: {
    label_th: 'ห้องเรียน',
    columns: [['start_year_ce', 'int', true, 'ปีการศึกษา (ค.ศ.)'], ['grade_level', 'enum:GradeLevel', true, 'ระดับชั้น'], ['room_no', 'code', true, 'ห้อง']],
  },
  ENROLLMENTS: {
    label_th: 'ย้ายห้อง/เลื่อนชั้น',
    columns: [['student_code', 'code', true, 'รหัสนักเรียน'], ['class_code', 'text', true, 'ห้องใหม่'], ['effective_date', 'date', true, 'วันที่มีผล'], ['reason', 'enum:EnrollmentEndReason', true, 'เหตุผล'], ['roll_no', 'int', false, 'เลขที่']],
  },
  STAFF: {
    label_th: 'บุคลากรและบทบาท',
    columns: [['staff_code', 'code', true, 'รหัสบุคลากร'], ['display_name', 'name', true, 'ชื่อ-สกุล'], ['email', 'email', false, 'อีเมลติดต่อ'], ['roles', 'roles', false, 'บทบาท (คั่นด้วย |)'], ['homeroom_class_code', 'text', false, 'ห้องที่ปรึกษา']],
  },
  CALENDAR: {
    label_th: 'ปฏิทินโรงเรียน',
    columns: [['calendar_date', 'date', true, 'วันที่'], ['day_type', 'enum:DayType', true, 'ประเภทวัน'], ['applies_to_level', 'enum:GradeLevel', false, 'ระดับชั้น (ว่าง = ทุกชั้น)'], ['title_th', 'text', false, 'รายการ']],
  },
};

export function templateCsvHeader(type) {
  return IMPORT_TYPES[type].columns.map((c) => c[0]);
}

/**
 * Convert one date string according to the declared source format. Never guesses: BE input must
 * be declared (DMY_BE) and is converted by subtracting 543 exactly once.
 */
export function parseImportDate(raw, format) {
  const s = String(raw).trim();
  if (format === 'ISO' || !format) return isIsoDate(s) ? s : null;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (!m) return null;
  let year = Number(m[3]);
  if (format === 'DMY_BE') year -= 543;
  const iso = `${String(year).padStart(4, '0')}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

function enumValue(enumName, raw) {
  const v = String(raw).trim();
  if (ENUMS[enumName].values.includes(v.toUpperCase())) return v.toUpperCase();
  const alias = (TH_ALIASES[enumName] || {})[v];
  if (alias) return alias;
  const byLabel = Object.entries(ENUMS[enumName].th).find(([, th]) => th === v);
  return byLabel ? byLabel[0] : null;
}

/**
 * Map + normalize a raw row.
 * @param {string} type
 * @param {Object<string,string>} raw   keyed by template column name (after mapping)
 * @param {{date_format?: 'ISO'|'DMY_BE'|'DMY_CE', default_effective_from?: string}} opts
 * @returns {{value: object, errors: Array<{column:string, code:string, message_th:string}>}}
 */
export function normalizeImportRow(type, raw, opts = {}) {
  const def = IMPORT_TYPES[type];
  const value = {};
  const errors = [];
  const err = (column, code, message_th) => errors.push({ column, code, message_th });
  for (const [col, kind, required, label] of def.columns) {
    const rv = raw[col];
    const s = rv === undefined || rv === null ? '' : String(rv).replace(/\u0000/g, '').trim();
    if (s === '') {
      if (required) err(col, 'REQUIRED', `ต้องระบุ${label}`);
      value[col] = null;
      continue;
    }
    if ((kind === 'name' || kind === 'text') && FORMULA_LIKE.test(s)) { err(col, 'FORMULA_LIKE', `${label} ขึ้นต้นด้วยอักขระที่อาจเป็นสูตร (= + - @)`); continue; }
    switch (true) {
      case kind === 'code':
        if (!/^[0-9A-Za-z_-]{1,40}$/.test(s)) err(col, 'FORMAT', `${label} ใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ _ และ -`);
        else value[col] = s; // string: leading zeros preserved
        break;
      case kind === 'name':
      case kind === 'text':
        if (s.length > 200) err(col, 'MAX_LENGTH', `${label} ยาวเกิน 200 ตัวอักษร`);
        else value[col] = s.normalize('NFC');
        break;
      case kind.startsWith('enum:'): {
        const v = enumValue(kind.slice(5), s);
        if (!v) err(col, 'ENUM', `${label} ไม่อยู่ในรายการที่รองรับ`);
        else value[col] = v;
        break;
      }
      case kind === 'date': {
        const d = parseImportDate(s, opts.date_format || 'ISO');
        if (!d) err(col, 'DATE', `${label} ไม่ถูกต้อง (รูปแบบที่เลือก: ${opts.date_format || 'ISO YYYY-MM-DD ค.ศ.'})`);
        else value[col] = d;
        break;
      }
      case kind === 'int':
        if (!/^\d{1,4}$/.test(s)) err(col, 'INT', `${label} ต้องเป็นตัวเลขจำนวนเต็ม`);
        else value[col] = Number(s);
        break;
      case kind === 'bool': {
        const t = s.toLowerCase();
        if (['true', '1', 'yes', 'y', 'ใช่'].includes(t)) value[col] = true;
        else if (['false', '0', 'no', 'n', 'ไม่ใช่'].includes(t)) value[col] = false;
        else err(col, 'BOOL', `${label} ต้องเป็น ใช่/ไม่ใช่`);
        break;
      }
      case kind === 'phone': {
        const p = s.replace(/[\s-]/g, '');
        if (!/^\+?[0-9]{9,15}$/.test(p)) err(col, 'PHONE', `${label} ไม่ถูกต้อง`);
        else value[col] = p;
        break;
      }
      case kind === 'email':
        if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(s)) err(col, 'EMAIL', `${label} ไม่ถูกต้อง`);
        else value[col] = s.toLowerCase();
        break;
      case kind === 'roles': {
        const roles = s.split('|').map((x) => x.trim().toUpperCase()).filter(Boolean);
        const bad = roles.filter((r) => !['STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF'].includes(r));
        if (bad.length) err(col, 'ROLE', `บทบาทไม่รองรับในการนำเข้า: ${bad.join(', ')} (SYSTEM_ADMIN ต้องกำหนดด้วยมือ)`);
        else value[col] = roles;
        break;
      }
      default:
        err(col, 'UNKNOWN_KIND', 'ชนิดคอลัมน์ไม่รองรับ');
    }
  }
  if (type === 'STUDENTS' && !value.effective_from && opts.default_effective_from) value.effective_from = opts.default_effective_from;
  if (type === 'STUDENTS' && !value.effective_from && !errors.some((e) => e.column === 'effective_from')) err('effective_from', 'REQUIRED', 'ต้องระบุวันที่มีผล (หรือกำหนดค่าเริ่มต้นใน mapping)');
  return { value, errors };
}

/** Apply a column mapping {template_column: source_header} to a parsed CSV table. */
export function mapRows(header, rows, mapping) {
  const idx = {};
  for (const [target, source] of Object.entries(mapping)) {
    const i = header.indexOf(source);
    if (i >= 0) idx[target] = i;
  }
  return rows.map((r) => Object.fromEntries(Object.entries(idx).map(([t, i]) => [t, r[i] ?? ''])));
}

/** Default mapping: exact header match on template names. */
export function autoMapping(type, header) {
  const out = {};
  for (const [col, , , label] of IMPORT_TYPES[type].columns) {
    if (header.includes(col)) out[col] = col;
    else if (header.includes(label)) out[col] = label;
  }
  return out;
}

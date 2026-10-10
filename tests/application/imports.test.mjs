import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/app-harness.mjs';
import { toCsv, parseCsv } from '../../src/shared/csv.js';
import { parseImportDate } from '../../src/application/imports/definitions.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function setup() {
  const h = makeHarness();
  h.bootstrap();
  const seed = h.seed();
  const affairs = seed.staff.find((s) => s.key === 'affairs').user_id;
  return { h, affairs, seed };
}

function upload(h, user, type, csv) {
  return h.ok(user, 'import.upload', { import_type: type, file: { filename: `${type}.csv`, mime_type: 'text/csv', content_base64: b64(csv) } });
}

const HEADER = 'student_code,prefix_th,first_name_th,last_name_th,class_code,roll_no,birth_date,effective_from';

test('CSV parser keeps leading zeros, Thai text, quotes, CRLF and BOM; writer neutralizes formulas', () => {
  const rows = parseCsv('﻿code,name\r\n00123,"สมใจ, ""ดี"""\r\n007,\n');
  assert.deepEqual(rows, [['code', 'name'], ['00123', 'สมใจ, "ดี"'], ['007', '']]);
  const out = toCsv(['a', 'b'], [['=1+1', '+66'], ['-5', 'ปกติ']]);
  assert.ok(out.startsWith('﻿'));
  assert.ok(out.includes("'=1+1") && out.includes("'+66") && out.includes("'-5"));
  assert.equal(parseImportDate('15/03/2569', 'DMY_BE'), '2026-03-15');
  assert.equal(parseImportDate('15/03/2026', 'DMY_CE'), '2026-03-15');
  assert.equal(parseImportDate('2026-02-30', 'ISO'), null);
  assert.equal(parseImportDate('15/03/2569', 'ISO'), null, 'never guesses the calendar');
});

test('student import dry-run reports row errors (00123, Thai, duplicate name, null, bad date, formula injection)', () => {
  const { h, affairs } = setup();
  const existing = h.store.list('Students', { limit: 1 }).items[0];
  const csv = [
    HEADER,
    '00123,ด.ช.,สมชาย,ทดสอบดี,M1/1,30,,2026-06-01',
    `00124,ด.ญ.,${existing.first_name_th},${existing.last_name_th},M1/2,31,2013-02-30,2026-06-01`,
    '00125,ด.ช.,=HYPERLINK("http://x"),ทดสอบ,M1/1,,,2026-06-01',
    '00123,ด.ช.,ซ้ำ,ในไฟล์,M1/1,,,2026-06-01',
    '00126,ด.ญ.,มะลิ,ไม่มีห้อง,M9/9,,,2026-06-01',
    `00127,ด.ญ.,${existing.first_name_th},${existing.last_name_th},M1/1,32,,2026-06-01`,
  ].join('\n');
  const up = upload(h, affairs, 'STUDENTS', csv);
  assert.equal(up.row_count, 6);
  assert.equal(up.auto_mapping.student_code, 'student_code');
  const dry = h.ok(affairs, 'import.dryRun', { batch_id: up.batch_id, mapping: up.auto_mapping, options: { date_format: 'ISO' } });
  assert.deepEqual({ INSERT: dry.summary.INSERT, ERROR: dry.summary.ERROR }, { INSERT: 2, ERROR: 4 });
  const codes = dry.rows.flatMap((r) => r.errors.map((e) => `${r.row_no}:${e.code}`));
  assert.ok(codes.includes('3:DATE'), codes.join(','));
  assert.ok(codes.includes('4:FORMULA_LIKE'));
  assert.ok(codes.includes('5:DUPLICATE_IN_FILE'));
  assert.ok(codes.includes('6:CLASS_NOT_FOUND'));
  const dupWarn = dry.rows.find((r) => r.row_no === 7).warnings[0];
  assert.equal(dupWarn.code, 'DUPLICATE_NAME', 'same name is a warning, never a merge');
  const apply = h.call(affairs, 'import.apply', { batch_id: up.batch_id });
  assert.equal(apply.error.code, 'VALIDATION_ERROR');
  const errors = h.ok(affairs, 'import.get', { batch_id: up.batch_id }).errors;
  assert.ok(errors.length >= 4 && errors.every((e) => e.attempt_no === 1));
});

test('clean import applies via job, preserves leading zeros, and re-import of the same file creates nothing new', () => {
  const { h, affairs } = setup();
  const csv = [HEADER, '00123,ด.ช.,สมชาย,ทดสอบดี,M1/1,30,,2026-06-01', '00200,ด.ญ.,ใจดี,มีสุข,M1/2,31,2013-03-15,2026-06-01'].join('\r\n');
  const before = h.store.count('Students');
  const up = upload(h, affairs, 'STUDENTS', csv);
  const dry = h.ok(affairs, 'import.dryRun', { batch_id: up.batch_id, mapping: up.auto_mapping });
  assert.equal(dry.summary.INSERT, 2);
  const ap = h.ok(affairs, 'import.apply', { batch_id: up.batch_id });
  assert.ok(ap.job_id);
  const report = h.runJobs();
  assert.equal(report.succeeded, 1, JSON.stringify(report));
  assert.equal(h.store.count('Students'), before + 2);
  const s = h.store.findBy('Students', 'student_code', '00123')[0];
  assert.equal(typeof s.student_code, 'string');
  assert.equal(s.student_code, '00123');
  assert.equal(h.store.findBy('Enrollments', 'student_id', s.id).length, 1);
  assert.equal(h.store.get('ImportBatches', up.batch_id).status, 'APPLIED');
  const job = h.store.get('Jobs', ap.job_id);
  assert.equal(job.status, 'SUCCEEDED');
  assert.equal(job.result_json.applied, 2);
  // re-import identical file
  const up2 = upload(h, affairs, 'STUDENTS', csv);
  const dry2 = h.ok(affairs, 'import.dryRun', { batch_id: up2.batch_id, mapping: up2.auto_mapping });
  assert.equal(dry2.summary.SKIP, 2);
  h.ok(affairs, 'import.apply', { batch_id: up2.batch_id });
  h.runJobs();
  assert.equal(h.store.count('Students'), before + 2, 'no duplicates');
});

test('changed data for an existing code is a CONFLICT by default (no silent overwrite)', () => {
  const { h, affairs } = setup();
  const existing = h.store.list('Students', { limit: 1 }).items[0];
  const enr = h.store.findBy('Enrollments', 'student_id', existing.id)[0];
  const cls = h.store.get('Classes', enr.class_id);
  const csv = [HEADER, `${existing.student_code},${existing.prefix_th},ชื่อใหม่,${existing.last_name_th},${cls.code},1,,2026-06-01`].join('\n');
  const up = upload(h, affairs, 'STUDENTS', csv);
  const dry = h.ok(affairs, 'import.dryRun', { batch_id: up.batch_id, mapping: up.auto_mapping });
  assert.equal(dry.summary.CONFLICT, 1);
  assert.equal(h.call(affairs, 'import.apply', { batch_id: up.batch_id }).error.code, 'VALIDATION_ERROR');
  const dry2 = h.ok(affairs, 'import.dryRun', { batch_id: up.batch_id, mapping: up.auto_mapping, options: { update_existing: true } });
  assert.equal(dry2.summary.UPDATE, 1);
});

test('guardian import merges siblings only by school-issued guardian_ref and creates verified links', () => {
  const { h, affairs } = setup();
  const [s1, s2] = h.store.list('Students', { limit: 2, orderBy: [['student_code', 'asc']] }).items;
  const csv = [
    'student_code,guardian_ref,prefix_th,first_name_th,last_name_th,relationship,phone,email,is_primary_contact,contact_priority',
    `${s1.student_code},GX-1,นาง,สมศรี,พี่น้อง,มารดา,+999 000 111 222,mom@example.com,ใช่,1`,
    `${s2.student_code},GX-1,นาง,สมศรี,พี่น้อง,MOTHER,+999000111222,,TRUE,1`,
    `${s2.student_code},GX-2,นาย,สมศรี,พี่น้อง,FATHER,,,,2`,
  ].join('\n');
  const up = upload(h, affairs, 'GUARDIANS', csv);
  const dry = h.ok(affairs, 'import.dryRun', { batch_id: up.batch_id, mapping: up.auto_mapping });
  assert.equal(dry.summary.ERROR, 0, JSON.stringify(dry.rows));
  h.ok(affairs, 'import.apply', { batch_id: up.batch_id });
  h.runJobs();
  const g1 = h.store.findBy('Guardians', 'external_ref', 'GX-1');
  assert.equal(g1.length, 1, 'siblings share one guardian record');
  const links = h.store.findBy('StudentGuardians', 'guardian_id', g1[0].id);
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.status === 'ACTIVE' && l.verification_method === 'SCHOOL_RECORD' && l.verified_by === affairs));
  const phone = h.store.findBy('ContactEndpoints', 'owner_id', g1[0].id).find((c) => c.channel === 'PHONE');
  assert.equal(phone.value, '+999000111222');
  assert.equal(h.store.findBy('Guardians', 'external_ref', 'GX-2').length, 1, 'same name, different ref = different person');
});

test('import operations require import.manage', () => {
  const { h, seed } = setup();
  const duty = seed.staff.find((s) => s.key === 'duty').user_id;
  const r = h.call(duty, 'import.upload', { import_type: 'STUDENTS', file: { filename: 'a.csv', mime_type: 'text/csv', content_base64: b64(HEADER) } });
  assert.equal(r.error.code, 'FORBIDDEN');
  const affairs = seed.staff.find((s) => s.key === 'affairs').user_id;
  const bad = h.call(affairs, 'import.upload', { import_type: 'STUDENTS', file: { filename: 'a.exe', mime_type: 'application/octet-stream', content_base64: b64('MZ') } });
  assert.equal(bad.error.code, 'VALIDATION_ERROR');
  const fake = h.call(affairs, 'import.upload', { import_type: 'STUDENTS', file: { filename: 'a.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content_base64: b64('not a zip') } });
  assert.equal(fake.error.field_errors[0].code, 'MAGIC_MISMATCH');
});

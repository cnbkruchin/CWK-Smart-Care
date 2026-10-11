// Reports (MASTER_PROMPT §12): R01–R07 on a tiny dataset whose expected numbers are worked out by
// hand below; scope/permission checks; file runs (CSV real, XLSX/PDF via renderer port), download
// re-checks, CSV formula neutralisation, lock + revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, FakeReportRenderer } from '../helpers/app-harness.mjs';
import { csvBytes } from '../../src/application/reports/render.js';
import { parseCsv } from '../../src/shared/csv.js';
import { ENUMS } from '../../src/schema/enums.js';

const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();

/*
 Dataset (class c1 = s0..s4, class c2 = 5 students with no activity):
   Mon 2026-06-15  s0 gate 07:50 (on time) · s1 gate 08:10 (late 10, counted) · s2 roll call ABSENT + confirmed
                   s3 approved full-day leave (roll call LEAVE_REPORTED) · s4 no event, roll call default "มา"
                   → c1: eligible 5, present 3, late 1, full-day leave 1, absent 1, unknown 0 (roll call verified)
                   → c2: eligible 5, unknown 5 (roll call not sent)
   Tue 2026-06-16  s1 gate 08:20 (late 20, counted) · s0 gate 08:05 late but exempted (TRANSPORT_DELAY)
                   no roll call; s2, s3, s4 have no rows at all (openDay job not run)
*/
function setup() {
  const renderer = new FakeReportRenderer();
  const h = makeHarness({ now: BKK('2026-06-15', '07:50'), extraPlatform: { reportRenderer: renderer } });
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  const station = h.store.list('Stations', { limit: 1 }).items[0];
  const classes = h.store.list('Classes', { limit: 10, orderBy: [['code', 'asc']] }).items;
  const [c1, c2] = classes;
  const s = h.store.findBy('Enrollments', 'class_id', c1.id).sort((a, b) => (a.roll_no || 0) - (b.roll_no || 0)).map((e) => e.student_id);
  const hr1 = h.store.findBy('StaffAssignments', 'class_id', c1.id).find((a) => a.assignment_type === 'HOMEROOM').user_id;
  const hr2 = h.store.findBy('StaffAssignments', 'class_id', c2.id).find((a) => a.assignment_type === 'HOMEROOM').user_id;
  const arrive = (sid, at) => { h.clock.set(at); return h.ok(ids.duty, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' }); };
  // Monday
  arrive(s[0], BKK('2026-06-15', '07:50'));
  arrive(s[1], BKK('2026-06-15', '08:10'));
  h.clock.set(BKK('2026-06-14', '18:00'));
  const lv = h.ok(hr1, 'leave.submit', { student_id: s[3], leave_type: 'PERSONAL', reason: 'งานบวชญาติ', days: [{ school_date: '2026-06-15', unit: 'FULL_DAY' }] });
  h.ok(ids.affairs, 'leave.decide', { leave_request_id: lv.leave_request_id, decision: 'APPROVED' }, { expectedVersion: 1 });
  h.clock.set(BKK('2026-06-15', '10:30'));
  h.ok(hr1, 'rollcall.submit', { class_id: c1.id, school_date: '2026-06-15', marks: [{ student_id: s[2], mark: 'ABSENT' }, { student_id: s[3], mark: 'LEAVE_REPORTED' }] });
  h.ok(hr1, 'attendance.verifyDay', { class_id: c1.id, school_date: '2026-06-15', confirm_absent_student_ids: [s[2]] });
  // Tuesday
  arrive(s[1], BKK('2026-06-16', '08:20'));
  arrive(s[0], BKK('2026-06-16', '08:05'));
  h.ok(ids.affairs, 'attendance.exempt', { school_date: '2026-06-16', student_ids: [s[0]], reason_code: 'TRANSPORT_DELAY', reason_text: 'รถรับส่งสายเหนือเสีย' });
  h.clock.set(BKK('2026-06-17', '09:00'));
  return { h, ids, c1, c2, s, hr1, hr2, renderer, leaveId: lv.leave_request_id };
}

const prev = (h, user, code, filter) => h.ok(user, 'report.preview', { code, filter });

test('R01 daily attendance matches the hand count and the dashboard (same projection)', () => {
  const { h, ids, c1, c2 } = setup();
  const r = prev(h, ids.affairs, 'R01', { date: '2026-06-15' });
  const row1 = r.rows.find((x) => x.class_name_th === c1.name_th);
  const row2 = r.rows.find((x) => x.class_name_th === c2.name_th);
  assert.deepEqual([row1.eligible, row1.present, row1.late_counted, row1.full_day_leave, row1.partial_leave, row1.absent_confirmed, row1.unknown, row1.roll_call], [5, 3, 1, 1, 0, 1, 0, 'ยืนยันแล้ว']);
  assert.deepEqual([row2.eligible, row2.present, row2.unknown, row2.roll_call], [5, 0, 5, 'ยังไม่ส่ง']);
  assert.deepEqual([r.totals.eligible, r.totals.present, r.totals.late_counted, r.totals.unknown, r.totals.roll_call], [10, 3, 1, 5, '1/2 ห้อง']);
  const dash = h.ok(ids.affairs, 'dashboard.summary', { school_date: '2026-06-15' });
  assert.deepEqual([dash.totals.present, dash.totals.late_counted, dash.totals.absent_confirmed, dash.totals.unknown], [r.totals.present, r.totals.late_counted, r.totals.absent_confirmed, r.totals.unknown]);
  assert.ok(r.notes_th.some((n) => n.includes('ค่าตัวอย่าง')), 'example rule is disclosed');
});

test('R02 lateness keeps the real arrival, shows exemptions, counts minutes only when counted', () => {
  const { h, ids, c1, s } = setup();
  const r = prev(h, ids.affairs, 'R02', { from: '2026-06-15', to: '2026-06-16', class_id: c1.id });
  assert.equal(r.rows.length, 3);
  const code = (i) => h.store.get('Students', s[i]).student_code;
  assert.deepEqual(r.rows.map((x) => [x.school_date, x.student_code, x.late_minutes, x.counted]), [
    ['2026-06-15', code(1), 10, 'นับ'], ['2026-06-16', code(0), 5, 'ไม่นับ'], ['2026-06-16', code(1), 20, 'นับ'],
  ]);
  assert.match(r.rows[1].exemption, /รถรับส่งล่าช้า: รถรับส่งสายเหนือเสีย/);
  assert.equal(r.rows[0].recorded_by.length > 0, true);
  assert.deepEqual([r.totals.student_name, r.totals.late_minutes, r.totals.counted], ['2 คน', 30, 'นับ 2 / ทั้งหมด 3 ครั้ง']);
  assert.equal(prev(h, ids.affairs, 'R02', { from: '2026-06-15', to: '2026-06-16', class_id: c1.id, counted_only: true }).rows.length, 2);
  assert.equal(prev(h, ids.affairs, 'R02', { from: '2026-06-15', to: '2026-06-16', exemption_reason: 'TRANSPORT_DELAY' }).rows.length, 1);
  assert.equal(h.call(ids.affairs, 'report.preview', { code: 'R02', filter: { from: '2026-06-16', to: '2026-06-15' } }).error.code, 'VALIDATION_ERROR');
});

test('R03 leave, R05 follow-up, R06 contacts, R04 individual history', () => {
  const { h, ids, c1, s, hr1, leaveId } = setup();
  const r3 = prev(h, ids.affairs, 'R03', { from: '2026-06-15', to: '2026-06-16' });
  assert.equal(r3.rows.length, 1);
  assert.equal(r3.rows[0].status, 'อนุมัติ');
  assert.match(r3.rows[0].units, /วัน 1 · ครึ่งวัน 0 · คาบ 0/);
  assert.ok(h.store.get('LeaveRequests', leaveId));
  const kase = h.ok(hr1, 'case.create', { student_id: s[1], summary_th: 'มาสายติดต่อกันสองวัน', priority: 'NORMAL' });
  h.ok(hr1, 'contact.log', { student_id: s[1], case_id: kase.case_id, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'NO_ANSWER', summary: '=HYPERLINK("http://x")', follow_up_required: true });
  const r5 = prev(h, hr1, 'R05', {});
  assert.equal(r5.rows.length, 1);
  assert.match(r5.rows[0].last_action, /ติดต่อไม่ได้/);
  const r6 = prev(h, hr1, 'R06', { from: '2026-06-17', to: '2026-06-17' });
  assert.equal(r6.rows.length, 1);
  assert.equal(r6.totals.outcome, 'ติดต่อได้ 0 / 1');
  const r4 = prev(h, hr1, 'R04', { student_id: s[1] });
  assert.equal(r4.rows.filter((x) => x.kind === ENUMS.AttendanceEventType.th.GATE_ARRIVAL).length, 2, 'both gate arrivals of s1 are in the history');
  assert.ok(r4.notes_th[1].includes('สาย (นับ) 2'));
  assert.equal(h.call(hr1, 'report.preview', { code: 'R04', filter: { student_id: h.store.findBy('Enrollments', 'class_id', h.store.list('Classes', { limit: 10, orderBy: [['code', 'asc']] }).items[1].id)[0].student_id } }).error.code, 'FORBIDDEN');
  assert.ok(c1);
});

test('R07 trend uses enrolled student-days as the explicit denominator', () => {
  const { h, ids, c1 } = setup();
  const r = prev(h, ids.affairs, 'R07', { from: '2026-06-15', to: '2026-06-16', class_id: c1.id, period: 'WEEK', group_by: 'CLASS' });
  assert.equal(r.rows.length, 1);
  const x = r.rows[0];
  assert.equal(x.bucket, '2026-06-15');
  // 2 school days × 5 enrolled = 10; present 3 + 2; late 1 + 1; leave 1; absent 1; the rest (3) have no evidence
  assert.deepEqual([x.student_days, x.present, x.late_counted, x.full_day_leave, x.absent_confirmed, x.unknown_or_missing], [10, 5, 2, 1, 1, 3]);
  assert.deepEqual([x.present_rate, x.late_rate, x.absent_rate], [50, 20, 10]);
  const school = prev(h, ids.affairs, 'R07', { from: '2026-06-15', to: '2026-06-16', period: 'MONTH', group_by: 'SCHOOL' });
  assert.deepEqual([school.rows[0].bucket, school.rows[0].group, school.rows[0].student_days, school.rows[0].present], ['2026-06', 'ทั้งโรงเรียน', 20, 5]);
});

test('scope: homeroom sees only own class; other roles are refused; R08/R09/R11/R12 permissions', () => {
  const { h, ids, c1, c2, hr1, hr2 } = setup();
  const own = prev(h, hr1, 'R01', { date: '2026-06-15' });
  assert.deepEqual(own.rows.map((r) => r.class_name_th), [c1.name_th]);
  assert.equal(h.call(hr2, 'report.preview', { code: 'R01', filter: { date: '2026-06-15', class_id: c1.id } }).error.code, 'FORBIDDEN');
  assert.equal(h.call(ids.duty, 'report.preview', { code: 'R01', filter: { date: '2026-06-15' } }).error.code, 'FORBIDDEN');
  assert.equal(h.call(hr1, 'report.preview', { code: 'R11', filter: { from: '2026-06-15', to: '2026-06-17' } }).error.code, 'FORBIDDEN');
  const catalogHr = h.ok(hr1, 'report.catalog', {}).items.map((x) => x.code);
  assert.ok(catalogHr.includes('R01') && !catalogHr.includes('R11') && !catalogHr.includes('R09'));
  assert.deepEqual(h.ok(ids.duty, 'report.catalog', {}).items, []);
  const r8 = prev(h, ids.affairs, 'R08', { from: '2026-06-15', to: '2026-06-16' });
  assert.ok(r8.rows.some((r) => r.category === 'ยังไม่เช็กชื่อ' && r.class_name_th === c2.name_th && r.date === '2026-06-15'));
  assert.ok(r8.rows.some((r) => r.category === 'ยังไม่เช็กชื่อ' && r.class_name_th === c1.name_th && r.date === '2026-06-16'));
  const r9 = prev(h, ids.affairs, 'R09', { from: '2026-06-14', to: '2026-06-17' });
  assert.ok(r9.rows.some((r) => r.type === 'ขาดเรียน (ยืนยันแล้ว)' || r.notifications >= 1));
  const r11 = prev(h, ids.affairs, 'R11', { from: '2026-06-15', to: '2026-06-17', action: 'attendance.exempt' });
  assert.equal(r11.rows.length, 1);
  assert.equal(r11.rows[0].reason, 'รถรับส่งสายเหนือเสีย');
  assert.equal(prev(h, ids.affairs, 'R12', {}).rows.length, 0);
});

test('file runs: CSV (BOM, Thai, neutralised formulas), XLSX/PDF via renderer, secure download, lock and revision', () => {
  const { h, ids, s, hr1, hr2, renderer } = setup();
  const kase = h.ok(hr1, 'case.create', { student_id: s[1], summary_th: 'ติดตามการมาสาย', priority: 'NORMAL' });
  h.ok(hr1, 'contact.log', { student_id: s[1], case_id: kase.case_id, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'REACHED', summary: '=HYPERLINK("http://evil.example")', follow_up_required: false });
  assert.equal(h.call(ids.duty, 'report.run', { code: 'R02', filter: { from: '2026-06-15', to: '2026-06-16' }, format: 'CSV' }).error.code, 'FORBIDDEN');
  const run = h.ok(hr1, 'report.run', { code: 'R06', filter: { from: '2026-06-17', to: '2026-06-17' }, format: 'CSV' });
  h.runJobs();
  const runs = h.ok(hr1, 'report.runs', {}).items;
  assert.equal(runs[0].status, 'READY');
  const file = h.ok(hr1, 'report.download', { run_id: run.run_id });
  assert.match(file.filename, /^R06_.*\.csv$/);
  const text = Buffer.from(file.content_base64, 'base64').toString('utf8');
  assert.equal(text.charCodeAt(0), 0xfeff, 'UTF-8 BOM for Excel');
  assert.ok(text.includes('\r\n'));
  const parsed = parseCsv(text.slice(1));
  assert.equal(parsed[0][0], 'เวลา');
  assert.ok(parsed.some((r) => r.includes(`'=HYPERLINK("http://evil.example")`)), 'formula neutralised in the export');
  // another homeroom cannot download (no existence leak)
  assert.equal(h.call(hr2, 'report.download', { run_id: run.run_id }).error.code, 'NOT_FOUND');
  assert.ok(h.store.list('AuditEvents', { where: { action: 'report.download' }, limit: 5 }).items.length === 1);
  // XLSX and PDF through the renderer port, with prepared display/data values
  const x = h.ok(ids.affairs, 'report.run', { code: 'R02', filter: { from: '2026-06-15', to: '2026-06-16' }, format: 'XLSX' });
  const p = h.ok(ids.affairs, 'report.run', { code: 'R01', filter: { date: '2026-06-15' }, format: 'PDF' });
  h.runJobs();
  const pdfDoc = renderer.calls.find((c) => c[0] === 'PDF')[1];
  assert.ok(pdfDoc.meta.signatures.length >= 1, 'signature lines from settings');
  assert.ok(pdfDoc.rows_display[0].length === pdfDoc.columns.length);
  const xlsxDoc = renderer.calls.find((c) => c[0] === 'XLSX')[1];
  assert.equal(xlsxDoc.rows_data[0][0], '2026-06-15', 'data files keep ISO dates');
  assert.match(Buffer.from(h.ok(ids.affairs, 'report.download', { run_id: p.run_id }).content_base64, 'base64').toString('utf8'), /^%PDF-FAKE R01/);
  assert.ok(h.ok(ids.affairs, 'report.download', { run_id: x.run_id }).filename.endsWith('.xlsx'));
  // lock (official) then a later revision keeps the locked one
  assert.equal(h.call(hr1, 'report.lock', { run_id: p.run_id }).error.code, 'FORBIDDEN');
  const pr = h.store.get('ReportRuns', p.run_id);
  h.ok(ids.affairs, 'report.lock', { run_id: p.run_id, note: 'ฉบับส่งฝ่ายบริหาร' }, { expectedVersion: pr.version });
  const re = h.ok(ids.affairs, 'report.rerun', { run_id: p.run_id });
  h.runJobs();
  const old = h.store.get('ReportRuns', p.run_id);
  assert.deepEqual([old.locked, old.status, old.superseded_by_run_id], [true, 'SUPERSEDED', re.run_id]);
  assert.equal(h.store.get('ReportRuns', re.run_id).supersedes_run_id, p.run_id);
  assert.ok(h.ok(ids.affairs, 'report.download', { run_id: p.run_id }).content_base64, 'locked superseded file remains downloadable');
  // run metadata explains later differences
  assert.equal(old.schema_version, 1);
  assert.ok(old.as_of && old.filter_json.date === '2026-06-15');
});

test('a failing report run is marked FAILED with the reason (no silent stuck runs)', () => {
  const { h, ids } = setup();
  const r = h.ok(ids.affairs, 'report.run', { code: 'R02', filter: { from: '2026-01-01', to: '2026-12-31' }, format: 'CSV' });
  h.runJobs();
  assert.equal(h.store.get('ReportRuns', r.run_id).status, 'FAILED');
  // CSV writer on its own: header + totals row
  const bytes = csvBytes({ columns: [{ key: 'a', label: 'ก', type: 'text' }, { key: 'n', label: 'จำนวน', type: 'int' }], rows: [{ a: '@SUM(A1)', n: -5 }], totals: { a: 'รวม', n: -5 } }, 'Asia/Bangkok');
  const text = Buffer.from(bytes).toString('utf8');
  assert.ok(text.includes(`'@SUM(A1),-5`), 'text neutralised, negative numbers untouched');
});

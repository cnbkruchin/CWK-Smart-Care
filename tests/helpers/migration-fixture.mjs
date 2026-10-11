// Synthetic source system for migration tests and tools/fixtures/generate-synthetic.mjs. Built ONLY
// through real operations (dispatcher, permissions, journal-free memory store), so every table holds
// realistic rows: arrivals (on time/late), a mixed day (late + PM leave), a medical certificate
// attachment, a correction, roll call + confirmed absence → pending outbox, a follow-up case with a
// contact log, a class move, a guardian linked to two children, a pending invitation and a pending LINE
// link (secrets that must not leave the system). All names, codes and contacts are synthetic.
import { makeHarness, FakeEmailProvider, FakeLineProvider } from './app-harness.mjs';
import { MemoryPackageStore } from '../../src/adapters/memory/memory-package.js';

export const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
export const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n% ใบรับรองแพทย์ (สังเคราะห์)\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n')]);

export function buildSource({ packageStore = new MemoryPackageStore(), extraPlatform = {} } = {}) {
  const line = new FakeLineProvider();
  const h = makeHarness({
    now: BKK('2026-06-15', '07:30'),
    config: { lineEnabled: true, webappUrl: 'https://script.google.com/macros/s/EXAMPLE/exec' },
    extraPlatform: { packageStore, providers: { EMAIL: new FakeEmailProvider(), LINE: line }, ...extraPlatform },
  });
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  const station = h.store.list('Stations', { limit: 1 }).items[0];
  const classes = h.store.list('Classes', { limit: 10, orderBy: [['code', 'asc']] }).items;
  const roster = (cid) => h.store.findBy('Enrollments', 'class_id', cid).map((e) => e.student_id).sort();
  const [c1, c2] = classes;
  const r1 = roster(c1.id);
  const g = seed.guardian_users.find((x) => r1.includes(x.student_id));

  // morning: on-time arrivals, then late ones
  for (const sid of r1.slice(0, 2)) h.ok(ids.duty, 'attendance.recordArrival', { student_id: sid, station_id: station.id, source: 'SCAN_KEYBOARD' });
  h.clock.set(BKK('2026-06-15', '08:12'));
  const late = r1.find((s) => s !== g.student_id && !r1.slice(0, 2).includes(s));
  h.ok(ids.duty, 'attendance.recordArrival', { student_id: late, station_id: station.id, source: 'SCAN_KEYBOARD' });
  h.ok(ids.duty, 'attendance.recordArrival', { student_id: g.student_id, station_id: station.id, source: 'SEARCH_CODE' });

  // mixed day: the guardian's child is late in the morning and on approved PM leave with a certificate
  const leave = h.ok(g.user_id, 'leave.submit', {
    student_id: g.student_id, leave_type: 'SICK', reason: 'ไปพบแพทย์ช่วงบ่าย', days: [{ school_date: '2026-06-15', unit: 'HALF_DAY_PM' }],
    attachments: [{ filename: 'certificate.pdf', mime_type: 'application/pdf', content_base64: PDF_BYTES.toString('base64') }],
  });
  h.ok(ids.homeroom1, 'leave.decide', { leave_request_id: leave.leave_request_id, decision: 'APPROVED' });

  // correction of the late arrival (bus delay), with reason
  h.clock.set(BKK('2026-06-15', '10:30'));
  h.ok(ids.homeroom1, 'attendance.correct', { student_id: late, school_date: '2026-06-15', correction_type: 'AMEND_ARRIVAL_TIME', new_arrived_at: BKK('2026-06-15', '07:58'), reason: 'รถรับส่งมาถึงก่อนเวลา ครูเวรสแกนช้า (ข้อมูลสังเคราะห์)' });

  // roll call: one confirmed absence → guardian notification queued (not sent: no outbox tick here)
  const absent = r1.find((s) => ![...r1.slice(0, 2), late, g.student_id].includes(s));
  h.ok(ids.homeroom1, 'rollcall.submit', { class_id: c1.id, school_date: '2026-06-15', marks: [{ student_id: absent, mark: 'ABSENT' }] });
  h.ok(ids.homeroom1, 'attendance.verifyDay', { class_id: c1.id, school_date: '2026-06-15', confirm_absent_student_ids: [absent] });

  // follow-up case + contact log
  const cs = h.ok(ids.homeroom1, 'case.create', { student_id: absent, summary_th: 'ขาดเรียนโดยไม่แจ้ง ต้องติดต่อผู้ปกครอง', priority: 'NORMAL' });
  h.ok(ids.homeroom1, 'contact.log', { student_id: absent, case_id: cs.case_id || cs.id, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'NO_ANSWER', summary: 'โทรแล้วไม่มีผู้รับสาย', follow_up_required: true });

  // class move effective next day; the guardian is linked to a second child (in another class)
  const mover = roster(c2.id)[0];
  h.ok(ids.affairs, 'enrollment.change', { student_id: r1.find((s) => ![...r1.slice(0, 2), late, g.student_id, absent].includes(s)) || r1[r1.length - 1], effective_date: '2026-06-16', reason: 'CLASS_CHANGE', new_class_id: c2.id, note: 'ย้ายตามคำขอผู้ปกครอง' });
  const guardianRow = h.store.get('Users', g.user_id);
  h.ok(ids.affairs, 'guardian.link', {
    student_id: mover, guardian_id: guardianRow.guardian_id, relationship: 'MOTHER', is_primary_contact: false, contact_priority: 2,
    permitted_actions: ['VIEW_ATTENDANCE', 'SUBMIT_LEAVE', 'RECEIVE_NOTIFICATIONS'], verification_method: 'IN_PERSON', effective_from: '2026-06-15',
  });

  // tricky values: leading zeros, Thai text, null optional fields, text that looks like a formula
  const zero = h.ok(ids.affairs, 'student.create', { student_code: '00123', first_name_th: 'ด.ญ. ศศิธร', last_name_th: 'ใจดี (สังเคราะห์)', class_id: c2.id, effective_from: '2026-05-01' });
  h.ok(ids.homeroom1, 'contact.log', { student_id: absent, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'REACHED', summary: '=1+1 ผู้ปกครองแจ้งว่าป่วย (ทดสอบสูตร)', follow_up_required: false });

  // secrets that must not be exported: a pending invitation and a pending LINE link (nonce hash)
  const invited = h.ok(ids.admin, 'user.createStaff', { display_name: 'ครูใหม่ (สังเคราะห์)', contact_email: 'new.teacher@example.com', staff_code: 'T-NEW01', roles: ['SUBJECT_TEACHER'], effective_from: '2026-06-15' });
  h.ok(ids.admin, 'invitation.create', { user_id: invited.user_id || invited.id, bound_email: 'new.teacher@example.com', valid_days: 7 });
  h.ok(g.user_id, 'channel.startLineLink', { link_token: 'LinkTokFixture12345' });

  h.clock.set(BKK('2026-06-15', '16:45'));
  return { h, ids, seed, station, classes, c1, c2, g, late, absent, mover, zeroStudentId: zero.student_id || zero.id, packageStore, line };
}

/** Freeze, export (FULL_SNAPSHOT by default) and run the job to completion. */
export function exportSource(src, { mode = 'FULL_SNAPSHOT', tables = null, include_attachments = true, freeze = true } = {}) {
  const { h, ids } = src;
  if (freeze && h.config.systemMode !== 'READ_ONLY') h.ok(ids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'freeze ก่อนส่งออก' });
  const st = h.ok(ids.admin, 'migration.startExport', { mode, tables, include_attachments, reason: 'ทดสอบการย้ายข้อมูล' });
  for (let i = 0; i < 20; i++) {
    const job = h.store.get('Jobs', st.job_id);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(job.status)) break;
    h.runJobs();
  }
  const run = h.store.get('MigrationRuns', st.run_id);
  return { run, handle: src.packageStore.open(run.package_location), start: st };
}

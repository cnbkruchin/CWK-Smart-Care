// Today dashboard (MASTER_PROMPT §7.4): role-scoped totals from the same DailyAttendance projection
// as report R01, roll-call progress, open review tasks, and per-class rows. Polls every ~60 s while
// the tab is visible (with jitter); guardians see only their linked children. STUDENT_AFFAIRS can
// certify lateness exemptions (e.g. school bus delay) for a class/day.
import { h, mount } from '../lib/dom.js';
import { field, input, select, form, table, loading, empty, errorState, section, alertBox, badge, enumLabel } from '../ui.js';
import { todayLocal } from '../lib/dates.js';
import { formatThaiDate, formatThaiTime } from '../../../src/shared/thai-format.js';

const POLL_MS = 60000;

function tile(label, value, kind = 'neutral') {
  return h('div', { class: `stat stat-${kind}` }, h('div', { class: 'stat-n' }, String(value ?? 0)), h('div', { class: 'stat-l' }, label));
}

function totalsView(t) {
  return h('div', { class: 'stats' },
    tile('นักเรียนในทะเบียน (วันเรียน)', t.school_days),
    tile('มาเรียน', t.present, 'ok'),
    tile('มาสาย (นับ)', t.late_counted, t.late_counted ? 'warn' : 'neutral'),
    tile('ลาทั้งวัน', t.full_day_leave),
    tile('ลาบางช่วง', t.partial_leave),
    tile('ขาด (ยืนยันแล้ว)', t.absent_confirmed, t.absent_confirmed ? 'danger' : 'neutral'),
    tile('รอตรวจสอบ', t.unknown, t.unknown ? 'warn' : 'neutral'));
}

function countingNote(lines) {
  return h('details', { class: 'note' }, h('summary', null, 'วิธีนับ (นิยามเดียวกับรายงาน)'), h('ul', null, lines.map((l) => h('li', null, l))));
}

export async function renderDashboard(app, params) {
  const root = h('div');
  const date = input('school_date', { type: 'date', value: params.date || todayLocal(app) });
  const scoped = app.can('attendance.rollcall') || app.session.homeroom_class_ids.length || app.can('student.search');
  let classSel = null;
  if (scoped && !app.session.linked_student_ids.length) {
    const classes = (await app.api.get('class.list', {})).items;
    classSel = select('class_id', [h('option', { value: '' }, 'ทุกห้อง (ตามสิทธิ์)'), ...classes.map((c) => h('option', { value: c.id, selected: c.id === params.class_id }, c.name_th))]);
  }
  const body = h('div', { 'aria-live': 'polite' });
  const stamp = h('p', { class: 'muted small' });
  let names = null;

  const load = async (quiet = false) => {
    if (!quiet) mount(body, loading());
    try {
      const r = await app.api.get('dashboard.summary', { school_date: date.value || null, class_id: classSel && classSel.value ? classSel.value : null }, { channel: 'dashboard' });
      const out = [];
      if (r.lateness_rule && r.lateness_rule.is_example) out.push(alertBox('warn', `กฎการมาสายที่ใช้ยังเป็น "ค่าตัวอย่าง" (เริ่มสาย ${r.lateness_rule.cutoff_time}) — โรงเรียนต้องยืนยันค่าจริงในหน้าตั้งค่าก่อนใช้งานจริง`));
      if (!r.lateness_rule) out.push(alertBox('warn', 'ยังไม่มีกฎการมาสายที่มีผลวันนี้ ระบบจะไม่ตัดสินว่ามาสาย'));
      out.push(totalsView(r.totals));
      if (r.students) {
        if (!names) {
          try { names = new Map((await app.api.get('student.listMine', {})).items.map((s) => [s.id, s])); } catch (_) { names = new Map(); }
        }
        out.push(section('บุตรหลาน/ตนเอง', r.students.length ? table([
          { label: 'นักเรียน', render: (x) => { const s = names.get(x.student_id); return s ? `${s.first_name_th} ${s.last_name_th}` : '—'; } },
          { label: 'สถานะวันนี้', render: (x) => enumLabel('PresenceStatus', x.presence_status) },
          { label: 'มาสาย', render: (x) => (x.is_late ? badge(`สาย ${x.late_minutes} นาที`, 'warn') : '—') },
          { label: 'ลา', render: (x) => x.leave_units || '—' },
        ], r.students, { onRow: (x) => app.go('profile', { id: x.student_id }) }) : empty('ไม่มีนักเรียนในทะเบียนวันนี้')));
      } else {
        out.push(h('p', null, `เช็กชื่อแล้ว ${r.roll_call.classes_submitted}/${r.roll_call.classes_total} ห้อง · งานรอตรวจสอบ ${r.open_tasks} รายการ`));
        out.push(r.classes.length ? table([
          { label: 'ห้อง', key: 'class_name_th' },
          { label: 'เช็กชื่อ', render: (c) => (c.roll_call_submitted ? badge('ส่งแล้ว', 'ok', '✔') : badge('ยังไม่ส่ง', 'warn', '⚠')) },
          { label: 'นักเรียน', key: 'school_days' }, { label: 'มา', key: 'present' }, { label: 'สาย', key: 'late_counted' },
          { label: 'ลาทั้งวัน', key: 'full_day_leave' }, { label: 'ขาด', key: 'absent_confirmed' }, { label: 'รอตรวจสอบ', key: 'unknown' },
        ], r.classes, { onRow: (c) => (app.can('attendance.rollcall') || app.can('attendance.read') ? app.go('rollcall', { class_id: c.class_id, date: r.school_date }) : null) }) : empty('ไม่มีห้องในขอบเขตสิทธิ์'));
      }
      out.push(countingNote(r.counting_note_th));
      mount(body, out);
      mount(stamp, `ข้อมูลวันที่ ${formatThaiDate(r.school_date)} · ปรับปรุงล่าสุด ${formatThaiTime(new Date().toISOString())}`);
    } catch (e) {
      if (e.code !== 'STALE_RESPONSE' && !quiet) mount(body, errorState(e, () => load()));
    }
  };

  // Poll only while this screen is mounted and the tab is visible; jitter spreads load across users.
  const tick = () => {
    if (!root.isConnected || app.current !== 'dashboard') return;
    if (document.visibilityState === 'visible') load(true);
    setTimeout(tick, POLL_MS + Math.floor(Math.random() * 15000));
  };
  setTimeout(tick, POLL_MS + Math.floor(Math.random() * 15000));

  root.appendChild(form([h('div', { class: 'grid3' }, field('วันที่', date), classSel ? field('ห้อง', classSel) : null)], async () => { await load(); return false; }, { submitLabel: 'แสดง' }));
  root.appendChild(stamp);
  root.appendChild(body);
  if (app.can('attendance.exempt')) root.appendChild(await exemptionForm(app, date));
  load();
  return root;
}

async function exemptionForm(app, dateInput) {
  const classes = (await app.api.get('class.list', {})).items;
  const cls = select('class_id', [h('option', { value: '' }, '— เลือกห้อง —'), ...classes.map((c) => h('option', { value: c.id }, c.name_th))]);
  const list = h('div');
  const reasonCode = select('reason_code', [['TRANSPORT_DELAY', 'รถรับส่งล่าช้า'], ['WEATHER', 'สภาพอากาศ'], ['SCHOOL_EVENT', 'กิจกรรมโรงเรียน'], ['OTHER', 'อื่น ๆ']].map(([v, t]) => h('option', { value: v }, t)));
  const reasonText = input('reason_text', { placeholder: 'เช่น รถรับส่งสาย ... เสียระหว่างทาง (ไม่ใส่ข้อมูลสุขภาพ)' });
  let checks = [];
  cls.addEventListener('change', async () => {
    checks = [];
    if (!cls.value) { mount(list, ''); return; }
    mount(list, loading());
    try {
      const r = await app.api.get('attendance.classDay', { class_id: cls.value, school_date: dateInput.value }, { channel: 'exempt-class' });
      const late = r.items.filter((x) => x.is_late && !x.lateness_exempted);
      checks = late.map((x) => ({ id: x.student.id, box: h('input', { type: 'checkbox', checked: true, 'aria-label': `เลือก ${x.student.first_name_th}` }) }));
      mount(list, late.length ? table([
        { label: 'เลือก', render: (x) => checks.find((c) => c.id === x.student.id).box },
        { label: 'นักเรียน', render: (x) => `${x.student.first_name_th} ${x.student.last_name_th}` },
        { label: 'เวลามาถึง', render: (x) => (x.arrived_at ? formatThaiTime(x.arrived_at) : '—') }, { label: 'สาย (นาที)', key: 'late_minutes' },
      ], late) : empty('ไม่มีนักเรียนมาสายที่ยังไม่ได้รับการยกเว้นในห้องนี้'));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(list, errorState(e)); }
  });
  return section('รับรองข้อยกเว้นการนับสาย',
    alertBox('info', 'ระบบเก็บเวลามาถึงจริงไว้เสมอ และแสดงผลการยกเว้นแยกต่างหาก (ไม่ลบประวัติ)'),
    form([h('div', { class: 'grid3' }, field('ห้อง', cls), field('เหตุผล', reasonCode, { required: true }), field('รายละเอียด', reasonText, { required: true })), list], async () => {
      const ids = checks.filter((c) => c.box.checked).map((c) => c.id);
      if (!ids.length) throw { message_th: 'ยังไม่ได้เลือกนักเรียน' };
      const r = await app.api.mutate('attendance.exempt', { school_date: dateInput.value, student_ids: ids, reason_code: reasonCode.value, reason_text: reasonText.value.trim() });
      cls.dispatchEvent(new Event('change'));
      return `บันทึกข้อยกเว้นแล้ว ${r.applied} คน`;
    }, { submitLabel: 'บันทึกข้อยกเว้น', confirmText: 'ยืนยันการยกเว้นการนับสายของนักเรียนที่เลือก?' }));
}

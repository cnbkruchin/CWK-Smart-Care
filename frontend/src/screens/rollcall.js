// Homeroom Roll Call (MASTER_PROMPT §7.3): roster as of the chosen date, gate/leave evidence beside each
// student, mark only exceptions (default "มา"), submit with optimistic version. After submission the
// teacher confirms absence only for students still "รอตรวจสอบ" (never automatic). Review tasks for the
// class (conflicts, unknown status, correction requests) are listed below with their resolution.
import { h, mount } from '../lib/dom.js';
import { field, input, select, section, table, loading, empty, errorState, alertBox, badge, actionButton, askText, toast, enumLabel, textarea } from '../ui.js';
import { todayLocal } from '../lib/dates.js';
import { formatThaiDate, formatThaiTime, formatThaiDateTime } from '../../../src/shared/thai-format.js';

const MARKS = ['PRESENT', 'LATE', 'ABSENT', 'LEAVE_REPORTED'];

function markRadios(name, current, disabled) {
  return h('div', { class: 'mark-group', role: 'radiogroup', 'aria-label': 'ผลเช็กชื่อ' }, MARKS.map((m) =>
    h('label', null, h('input', { type: 'radio', name, value: m, checked: current === m, disabled }), enumLabel('RollCallMark', m))));
}

function evidence(it) {
  const out = [];
  if (it.arrived_at) out.push(badge(`ประตู ${formatThaiTime(it.arrived_at)}${it.is_late ? ` (สาย ${it.late_minutes} น.)` : ''}`, it.is_late ? 'warn' : 'ok'));
  if (it.full_day_leave) out.push(badge('ลาทั้งวัน (อนุมัติ)', 'info'));
  else if (it.leave_units) out.push(badge(`ลา: ${it.leave_units}`, 'info'));
  if (it.confirmed_absence) out.push(badge('ยืนยันขาดแล้ว', 'danger'));
  if (it.has_conflict) out.push(badge('ข้อมูลขัดกัน', 'danger', '⚠'));
  return out.length ? h('div', { class: 'row-actions' }, out) : '—';
}

export async function renderRollcall(app, params) {
  const classes = (await app.api.get('class.list', {})).items;
  const mine = app.session.homeroom_class_ids || [];
  const ordered = [...classes.filter((c) => mine.includes(c.id)), ...classes.filter((c) => !mine.includes(c.id))];
  const initial = params.class_id || mine[0] || '';
  const cls = select('class_id', [h('option', { value: '' }, '— เลือกห้อง —'), ...ordered.map((c) => h('option', { value: c.id, selected: c.id === initial }, `${c.name_th}${mine.includes(c.id) ? ' (ห้องที่ปรึกษา)' : ''}`))]);
  const date = input('school_date', { type: 'date', value: params.date || todayLocal(app), max: todayLocal(app) });
  const body = h('div', { 'aria-live': 'polite' });
  const tasksBox = h('div');
  const root = h('div', null, h('div', { class: 'grid3' }, field('ห้อง', cls), field('วันที่', date)), body, tasksBox);

  const load = async () => {
    if (!cls.value) { mount(body, empty('เลือกห้องเพื่อเช็กชื่อ')); mount(tasksBox, ''); return; }
    mount(body, loading());
    try {
      const r = await app.api.get('rollcall.get', { class_id: cls.value, school_date: date.value }, { channel: 'rollcall' });
      mount(body, sheet(app, r, load));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(body, errorState(e, load)); }
    if (app.can('attendance.reconcile')) mount(tasksBox, await reviewTasks(app, cls.value, load));
  };
  cls.addEventListener('change', () => { app.drafts.set('rollcall.class', cls.value); load(); });
  date.addEventListener('change', load);
  load();
  return root;
}

function sheet(app, r, reload) {
  const verified = r.session && r.session.status === 'VERIFIED';
  const locked = !r.can_mark || verified;
  const rows = r.items.map((it, i) => {
    // default "มา" when no roll call yet; an approved full-day leave suggests "แจ้งลา" but the teacher decides
    const current = it.mark && it.mark !== 'NOT_MARKED' ? it.mark : (it.full_day_leave ? 'LEAVE_REPORTED' : 'PRESENT');
    return { it, name: `m-${i}`, radios: markRadios(`m-${i}`, current, locked) };
  });
  const status = r.session
    ? alertBox(verified ? 'ok' : 'info', `${enumLabel('RollCallStatus', r.session.status)} เมื่อ ${formatThaiDateTime(r.session.submitted_at)}${verified ? ' — แก้ไขต่อจากนี้ใช้ "แก้ไขข้อมูล" ในหน้าประวัตินักเรียน' : ' — ส่งซ้ำเพื่อแก้ไขได้จนกว่าจะยืนยัน'}`)
    : alertBox('warn', `ยังไม่ได้เช็กชื่อ ${r.class.name_th} วันที่ ${formatThaiDate(r.school_date)}`);
  const allPresent = actionButton('ทุกคนมา (ยกเว้นที่ลาทั้งวัน)', async () => {
    for (const row of rows) {
      const v = row.it.full_day_leave ? 'LEAVE_REPORTED' : 'PRESENT';
      const radio = row.radios.querySelector(`input[value="${v}"]`);
      if (radio) radio.checked = true;
    }
  }, { variant: 'secondary' });
  const submit = actionButton(r.session ? 'ส่งผลเช็กชื่ออีกครั้ง' : 'ส่งผลเช็กชื่อ', async () => {
    const marks = [];
    for (const row of rows) {
      const sel = row.radios.querySelector('input:checked');
      const m = sel ? sel.value : 'PRESENT';
      if (m !== 'PRESENT') marks.push({ student_id: row.it.student.id, mark: m });
    }
    try {
      const res = await app.api.mutate('rollcall.submit', { class_id: r.class.id, school_date: r.school_date, marks }, { expectedVersion: r.session ? r.session.version : null });
      toast(`ส่งแล้ว: ไม่พบตัว ${res.ABSENT} · สาย ${res.LATE} · แจ้งลา ${res.LEAVE_REPORTED}`);
      reload();
    } catch (e) {
      toast(e.code === 'CONFLICT' ? 'มีผู้อื่นแก้ผลเช็กชื่อห้องนี้ไปแล้ว ระบบโหลดข้อมูลล่าสุดให้ กรุณาตรวจและส่งอีกครั้ง' : (e.message_th || 'ส่งไม่สำเร็จ'), 'danger');
      if (e.code === 'CONFLICT') reload();
    }
  }, { large: true });
  const out = [status];
  if (!r.items.length) return h('div', null, out, empty('ไม่มีนักเรียนในทะเบียนของห้องนี้ในวันนั้น'));
  out.push(table([
    { label: 'เลขที่', render: (x) => x.it.roll_no ?? '—' },
    { label: 'นักเรียน', render: (x) => h('a', { href: `#/profile?id=${encodeURIComponent(x.it.student.id)}` }, `${x.it.student.first_name_th} ${x.it.student.last_name_th}`) },
    { label: 'หลักฐาน', render: (x) => evidence(x.it) },
    { label: 'สถานะวันนี้', render: (x) => enumLabel('PresenceStatus', x.it.presence_status) },
    { label: 'ผลเช็กชื่อ', render: (x) => x.radios },
  ], rows, { caption: `${r.class.name_th} · ${formatThaiDate(r.school_date)} · ${r.items.length} คน` }));
  if (!locked) out.push(h('div', { class: 'form-actions' }, allPresent, submit));
  else if (!r.can_mark) out.push(alertBox('info', 'บัญชีนี้ดูผลได้อย่างเดียว (ไม่ใช่ครูที่ปรึกษาของห้องนี้)'));
  if (r.session && r.session.status === 'SUBMITTED' && app.can('attendance.verify')) out.push(verifyBox(app, r, reload));
  return h('div', null, out);
}

function verifyBox(app, r, reload) {
  const unknown = r.items.filter((x) => x.presence_status === 'UNKNOWN');
  if (!unknown.length) return section('ยืนยันผลรายวัน', alertBox('ok', 'ไม่มีนักเรียนที่ยังไม่ทราบสถานะ'));
  const boxes = unknown.map((x) => ({ id: x.student.id, box: h('input', { type: 'checkbox', 'aria-label': `ยืนยันขาด ${x.student.first_name_th}` }) }));
  const note = textarea('note', { rows: 2, placeholder: 'เช่น โทรติดต่อผู้ปกครองแล้ว (ไม่ใส่ข้อมูลสุขภาพ)' });
  return section('ยืนยันขาดเรียน (เฉพาะนักเรียนที่ยังไม่ทราบสถานะ)',
    alertBox('warn', 'ยืนยันเฉพาะรายที่ตรวจสอบแล้วว่าไม่มาโรงเรียน ระบบจะแจ้งผู้ปกครองว่า "ขาดเรียน" เฉพาะรายการที่ยืนยัน'),
    table([
      { label: 'ยืนยันขาด', render: (x) => boxes.find((b) => b.id === x.student.id).box },
      { label: 'นักเรียน', render: (x) => `${x.student.first_name_th} ${x.student.last_name_th}` },
      { label: 'ผลเช็กชื่อ', render: (x) => enumLabel('RollCallMark', x.mark) },
    ], unknown),
    field('หมายเหตุ', note),
    h('div', { class: 'form-actions' }, actionButton('ยืนยันผลรายวัน', async () => {
      const ids = boxes.filter((b) => b.box.checked).map((b) => b.id);
      try {
        const res = await app.api.mutate('attendance.verifyDay', { class_id: r.class.id, school_date: r.school_date, confirm_absent_student_ids: ids, note: note.value.trim() || null });
        toast(`ยืนยันขาด ${res.confirmed.length} คน${res.refused.length ? ` · ไม่ผ่าน ${res.refused.length} (${res.refused.map((x) => x.reason_th).join(', ')})` : ''}`, res.refused.length ? 'warn' : 'ok');
        reload();
      } catch (e) { toast(e.message_th || 'ยืนยันไม่สำเร็จ', 'danger'); }
    }, { confirmText: 'ยืนยันผลรายวันของห้องนี้? (ห้องจะถูกล็อกผลเช็กชื่อ แก้ไขต่อได้ผ่านการแก้ไขข้อมูลเท่านั้น)' })));
}

async function reviewTasks(app, classId, reload) {
  try {
    const r = await app.api.get('reconciliation.list', { class_id: classId, status: 'OPEN' }, { channel: 'rollcall-tasks' });
    if (!r.items.length) return section('งานตรวจสอบของห้อง', empty('ไม่มีงานค้าง'));
    return section('งานตรวจสอบของห้อง', table([
      { label: 'วันที่', render: (t) => (t.school_date ? formatThaiDate(t.school_date) : '—') },
      { label: 'ประเภท', render: (t) => enumLabel('ReconciliationTaskType', t.task_type) },
      { label: 'นักเรียน', render: (t) => (t.student_id ? h('a', { href: `#/profile?id=${encodeURIComponent(t.student_id)}` }, t.student_name || 'เปิดประวัติ') : '—') },
      { label: 'รายละเอียด', key: 'description_th' },
      {
        label: 'ดำเนินการ', render: (t) => h('div', { class: 'row-actions' },
          t.evidence_refs && t.evidence_refs.correction_id
            ? h('a', { class: 'btn btn-secondary', href: `#/profile?id=${encodeURIComponent(t.student_id)}&correction=${encodeURIComponent(t.evidence_refs.correction_id)}` }, 'พิจารณาคำขอแก้ไข')
            : [
              actionButton('แก้ไขแล้ว', () => resolveTask(app, t, 'RESOLVED', reload), { variant: 'secondary' }),
              actionButton('ไม่ต้องดำเนินการ', () => resolveTask(app, t, 'DISMISSED', reload), { variant: 'secondary' }),
            ]),
      },
    ], r.items));
  } catch (e) {
    return e.code === 'STALE_RESPONSE' ? h('div') : section('งานตรวจสอบของห้อง', errorState(e));
  }
}

async function resolveTask(app, t, status, reload) {
  const note = await askText(status === 'RESOLVED' ? 'สรุปการแก้ไข' : 'เหตุผลที่ไม่ต้องดำเนินการ', { label: 'บันทึก', multiline: true });
  if (!note) return;
  try {
    await app.api.mutate('reconciliation.resolve', { task_id: t.id, status, resolution_note: note }, { expectedVersion: t.version });
    toast('ปิดงานแล้ว');
    reload();
  } catch (e) { toast(e.message_th || 'บันทึกไม่สำเร็จ', 'danger'); }
}

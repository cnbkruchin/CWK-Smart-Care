// Student Profile & Timeline (MASTER_PROMPT §7.5). Server decides FULL vs BASIC view. Shows latest
// status, term/month statistics with the counting definitions, timeline (superseded records stay
// visible, struck through), guardians with tap-to-call links, homeroom teachers, enrollment history and
// open tasks. Corrections: staff apply directly (reason + audit); guardians/students file a request
// that the homeroom teacher decides here.
import { h, mount } from '../lib/dom.js';
import { field, input, select, textarea, form, table, section, alertBox, badge, actionButton, toast, enumLabel, enumOptions, empty } from '../ui.js';
import { localTimestamp, todayLocal } from '../lib/dates.js';
import { formatThaiDate, formatThaiDateTime, formatThaiTime } from '../../../src/shared/thai-format.js';

const MARKS = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE_REPORTED'];

function statsTable(rows) {
  return table([
    { label: 'ช่วง', render: (r) => r.label },
    { label: 'วันเรียน', key: 'school_days' }, { label: 'มา', key: 'present' }, { label: 'สาย (นับ)', key: 'late_counted' },
    { label: 'นาทีสายรวม', key: 'late_minutes' }, { label: 'ลาทั้งวัน', key: 'full_day_leave' }, { label: 'ลาบางช่วง', key: 'partial_leave' },
    { label: 'ขาด (ยืนยัน)', key: 'absent_confirmed' }, { label: 'รอตรวจสอบ', key: 'unknown' },
  ], rows);
}

function contactLink(c) {
  if (c.channel === 'PHONE' || c.channel === 'SMS') return h('a', { href: `tel:${String(c.value).replace(/[^0-9+]/g, '')}` }, `📞 ${c.value}`);
  if (c.channel === 'EMAIL') return h('a', { href: `mailto:${c.value}` }, `✉ ${c.value}`);
  return `${enumLabel('ContactChannel', c.channel)}: ${c.value}`;
}

function latestView(l) {
  return h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, l.presence_th), h('div', { class: 'stat-l' }, `วันนี้ (${formatThaiDate(l.school_date)})`)),
    h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, l.arrived_at ? formatThaiTime(l.arrived_at) : '—'), h('div', { class: 'stat-l' }, l.is_late ? `มาสาย ${l.late_minutes} นาที` : 'เวลามาถึง')),
    h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, l.verification_th), h('div', { class: 'stat-l' }, 'ระดับหลักฐาน')),
    l.leave_units ? h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, l.leave_units), h('div', { class: 'stat-l' }, 'ลาวันนี้')) : null);
}

export async function renderProfile(app, params) {
  if (!params.id) return alertBox('warn', 'ไม่ได้ระบุนักเรียน เปิดจากรายชื่อนักเรียน');
  const root = h('div');
  const from = input('from', { type: 'date', value: params.from || '' });
  const to = input('to', { type: 'date', value: params.to || '' });
  const p = await app.api.get('student.profile', { student_id: params.id, from: params.from || null, to: params.to || null });
  const s = p.student;
  const photo = h('div', { class: 'gate-photo', 'aria-label': 'รูปนักเรียน' }, 'ไม่มีรูป');
  if (s.photo_file_id) {
    app.api.get('student.photo', { student_id: s.id }, { channel: 'profile-photo' }).then((ph) => {
      if (ph.has_photo) { const img = document.createElement('img'); img.className = 'gate-photo'; img.alt = 'รูปนักเรียน'; img.src = `data:${ph.mime_type};base64,${ph.content_base64}`; mount(photo, img); }
    }).catch(() => {});
  }
  root.appendChild(section(`${s.prefix_th || ''}${s.first_name_th} ${s.last_name_th}${s.nickname ? ` (${s.nickname})` : ''}`,
    h('div', { class: 'gate-card' }, photo, h('div', null,
      h('p', null, `รหัส ${s.student_code} · ห้อง ${s.class_name_th || '—'} · `, badge(enumLabel('StudentStatus', s.status), s.status === 'ACTIVE' ? 'ok' : 'warn')),
      p.access === 'BASIC' ? alertBox('info', 'แสดงเฉพาะข้อมูลระบุตัวและสถานะวันนี้ตามสิทธิ์ของบัญชีนี้') : null)),
    latestView(p.latest)));
  if (p.access !== 'FULL') return root;

  const actions = [];
  if (p.can.submit_leave) actions.push(h('a', { class: 'btn btn-secondary', href: '#/leave' }, 'ยื่นใบลา'));
  if (app.can('attendance.rollcall') && s.class_id) actions.push(h('a', { class: 'btn btn-secondary', href: `#/rollcall?class_id=${encodeURIComponent(s.class_id)}` }, 'เช็กชื่อห้องนี้'));
  if (actions.length) root.appendChild(h('div', { class: 'row-actions' }, actions));

  // statistics
  const period = { label: `${formatThaiDate(p.stats.period.from)} – ${formatThaiDate(p.stats.period.to_exclusive)} (ไม่รวมวันสุดท้าย)`, ...p.stats.period };
  root.appendChild(section('สถิติการมาเรียน',
    form([h('div', { class: 'grid3' }, field('ตั้งแต่', from), field('ถึง (ไม่รวม)', to))], async () => { app.go('profile', { id: s.id, from: from.value, to: to.value }); return false; }, { submitLabel: 'แสดงช่วงนี้' }),
    statsTable([period, ...p.stats.months.map((m) => ({ label: m.month, ...m }))]),
    h('details', { class: 'note' }, h('summary', null, 'วิธีนับ'), h('ul', null, p.stats.counting_note_th.map((l) => h('li', null, l))))));

  // pending correction requests (decision here)
  const pending = p.timeline.filter((t) => t.kind === 'correction' && t.status === 'PENDING');
  if (pending.length && p.can.correct) root.appendChild(decideCorrections(app, s, p, pending, params.correction));
  if (p.can.correct) root.appendChild(correctionForm(app, s, p));
  else if (p.can.request_correction) root.appendChild(requestForm(app, s));

  // guardians & teachers
  if (p.guardians) {
    root.appendChild(section('ผู้ปกครอง', p.guardians.length ? table([
      { label: 'ชื่อ', key: 'name' }, { label: 'ความสัมพันธ์', render: (g) => enumLabel('Relationship', g.relationship) },
      { label: 'ติดต่อหลัก', render: (g) => (g.is_primary_contact ? badge('ติดต่อหลัก', 'ok') : '—') },
      { label: 'สถานะ', render: (g) => enumLabel('GuardianLinkStatus', g.status) },
      { label: 'ช่องทาง', render: (g) => (g.contacts.length ? h('div', { class: 'row-actions' }, g.contacts.map(contactLink)) : '—') },
    ], p.guardians) : empty('ยังไม่มีผู้ปกครองที่เชื่อมโยง')));
  }
  root.appendChild(section('ครูที่ปรึกษา / ประวัติห้องเรียน',
    p.teachers.length ? h('p', null, p.teachers.map((t) => t.name).join(', ')) : h('p', { class: 'muted' }, 'ไม่พบครูที่ปรึกษาที่มีผลวันนี้'),
    table([{ label: 'ห้อง', key: 'class_name_th' }, { label: 'ตั้งแต่', render: (e) => formatThaiDate(e.effective_from) }, { label: 'ถึง', render: (e) => (e.effective_to ? formatThaiDate(e.effective_to) : 'ปัจจุบัน') }, { label: 'เหตุผลสิ้นสุด', render: (e) => (e.end_reason ? enumLabel('EnrollmentEndReason', e.end_reason) : '—') }], p.enrollments)));

  if (p.open_tasks.length) {
    root.appendChild(section('งานตรวจสอบที่ค้าง', table([
      { label: 'วันที่', render: (t) => (t.school_date ? formatThaiDate(t.school_date) : '—') }, { label: 'ประเภท', render: (t) => enumLabel('ReconciliationTaskType', t.task_type) }, { label: 'รายละเอียด', key: 'description_th' },
    ], p.open_tasks)));
  }
  if (p.cases.length) {
    root.appendChild(section('เรื่องติดตาม', table([
      { label: 'ประเภท', render: (c) => enumLabel('CaseType', c.case_type) }, { label: 'สถานะ', render: (c) => enumLabel('CaseStatus', c.status) },
      { label: 'กำหนด', render: (c) => (c.due_at ? formatThaiDateTime(c.due_at) : '—') },
    ], p.cases)));
  }

  root.appendChild(section('ไทม์ไลน์', p.timeline.length ? h('ul', { class: 'timeline' }, p.timeline.map((t) => h('li', { class: `kind-${t.kind}` },
    h('div', null, t.superseded ? h('s', null, t.label_th) : h('strong', null, t.label_th), t.superseded ? ' (ถูกแก้ไขแล้ว)' : '', t.offline ? badge('ออฟไลน์', 'neutral') : null),
    h('div', { class: 'muted small' }, `${t.at ? formatThaiDateTime(t.at) : ''}${t.school_date ? ` · วันเรียน ${formatThaiDate(t.school_date)}` : ''}${t.source ? ` · ${enumLabel('AttendanceSource', t.source)}` : ''}`),
    t.reason ? h('div', { class: 'small' }, `เหตุผล: ${t.reason}`) : null,
    t.leave_request_id ? h('a', { href: `#/leave?id=${encodeURIComponent(t.leave_request_id)}` }, 'เปิดใบลา') : null))) : empty('ยังไม่มีรายการในช่วงนี้')));
  return root;
}

function activeEventsOn(p, date) {
  return p.timeline.filter((t) => t.school_date === date && ['late', 'absent', 'event'].includes(t.kind) && !t.superseded && t.type !== 'EVENT_VOIDED');
}

function correctionFields(app, p, date) {
  const type = select('correction_type', enumOptions('CorrectionType'));
  const target = select('target_event_id', [h('option', { value: '' }, '— (ไม่ระบุ) —')]);
  const time = input('new_arrived_at', { type: 'time' });
  const mark = select('new_mark', [h('option', { value: '' }, '—'), ...MARKS.map((m) => h('option', { value: m }, enumLabel('RollCallMark', m)))]);
  const fTarget = field('รายการที่ต้องการแก้', target);
  const fTime = field('เวลามาถึงที่ถูกต้อง', time);
  const fMark = field('ผลเช็กชื่อที่ถูกต้อง', mark);
  const refreshTargets = () => mount(target, h('option', { value: '' }, '— (ไม่ระบุ) —'), activeEventsOn(p, date()).map((t) => h('option', { value: t.id }, `${t.label_th} ${t.at ? formatThaiTime(t.at) : ''}`)));
  const sync = () => {
    fTarget.hidden = !['VOID_EVENT', 'AMEND_ARRIVAL_TIME'].includes(type.value);
    fTime.hidden = !['AMEND_ARRIVAL_TIME', 'ADD_ARRIVAL'].includes(type.value);
    fMark.hidden = type.value !== 'CHANGE_ROLL_CALL_MARK';
  };
  type.addEventListener('change', sync);
  sync();
  return {
    type, target, time, mark, refreshTargets,
    nodes: h('div', { class: 'grid3' }, field('ประเภทการแก้ไข', type, { required: true }), fTarget, fTime, fMark),
    payload: () => ({
      target_event_id: target.value || null,
      new_arrived_at: time.value && ['AMEND_ARRIVAL_TIME', 'ADD_ARRIVAL'].includes(type.value) ? localTimestamp(app, date(), time.value) : null,
      new_mark: type.value === 'CHANGE_ROLL_CALL_MARK' ? (mark.value || null) : null,
    }),
  };
}

function correctionForm(app, s, p) {
  const date = input('school_date', { type: 'date', value: todayLocal(app), max: todayLocal(app) });
  const reason = textarea('reason', { maxlength: 1000, placeholder: 'เหตุผลที่แก้ไข (บันทึกใน audit และแสดงในไทม์ไลน์)' });
  const f = correctionFields(app, p, () => date.value);
  date.addEventListener('change', f.refreshTargets);
  f.refreshTargets();
  return section('แก้ไขข้อมูลการมาเรียน',
    alertBox('info', 'ระบบไม่ลบข้อมูลเดิม: สร้างรายการใหม่แทนที่รายการเดิม คำนวณใหม่ และแจ้งผู้ปกครองเฉพาะกรณีข้อเท็จจริงที่เคยแจ้งไปเปลี่ยน'),
    form([h('div', { class: 'grid3' }, field('วันที่', date, { required: true })), f.nodes, field('เหตุผล', reason, { required: true })], async () => {
      const r = await app.api.mutate('attendance.correct', { student_id: s.id, school_date: date.value, correction_type: f.type.value, reason: reason.value.trim(), ...f.payload() });
      setTimeout(() => app.go('profile', { id: s.id }), 1200);
      return `แก้ไขแล้ว: ${enumLabel('PresenceStatus', r.before.presence_status)} → ${enumLabel('PresenceStatus', r.after.presence_status)}${r.before.late_counted !== r.after.late_counted ? (r.after.late_counted ? ' (นับสาย)' : ' (ไม่นับสาย)') : ''}`;
    }, { submitLabel: 'บันทึกการแก้ไข', confirmText: 'ยืนยันการแก้ไขข้อมูลการมาเรียน?' }));
}

function requestForm(app, s) {
  const date = input('school_date', { type: 'date', value: todayLocal(app), max: todayLocal(app) });
  const type = select('correction_type', enumOptions('CorrectionType'));
  const text = textarea('requested_text', { maxlength: 1000, placeholder: 'อธิบายสิ่งที่ไม่ถูกต้อง เช่น มาถึง 07:55 แต่ระบบบันทึก 08:20' });
  return section('ขอแก้ไขข้อมูลการมาเรียน',
    alertBox('info', 'คำขอจะส่งให้ครูที่ปรึกษาพิจารณา ข้อมูลจะเปลี่ยนเมื่อครูอนุมัติเท่านั้น'),
    form([h('div', { class: 'grid3' }, field('วันที่', date, { required: true }), field('เรื่อง', type, { required: true })), field('รายละเอียด', text, { required: true })], async () => {
      await app.api.mutate('attendance.requestCorrection', { student_id: s.id, school_date: date.value, correction_type: type.value, requested_text: text.value.trim() });
      return 'ส่งคำขอแล้ว — รอครูพิจารณา';
    }, { submitLabel: 'ส่งคำขอ' }));
}

function decideCorrections(app, s, p, pending, focusId) {
  const cards = pending.map((c) => {
    const f = correctionFields(app, p, () => c.school_date);
    f.type.value = c.correction_type;
    f.type.disabled = true;
    f.type.dispatchEvent(new Event('change'));
    f.refreshTargets();
    const note = textarea('decision_note', { rows: 2, maxlength: 1000 });
    const decide = (decision) => actionButton(decision === 'APPLY' ? 'อนุมัติและแก้ไข' : 'ไม่อนุมัติ', async () => {
      if (note.value.trim().length < 2) { toast('กรุณาระบุบันทึกการพิจารณา', 'warn'); return; }
      try {
        await app.api.mutate('attendance.decideCorrection', { correction_id: c.id, decision, decision_note: note.value.trim(), ...(decision === 'APPLY' ? f.payload() : {}) }, { expectedVersion: c.version });
        toast(decision === 'APPLY' ? 'แก้ไขข้อมูลแล้ว' : 'บันทึกว่าไม่อนุมัติแล้ว');
        app.go('profile', { id: s.id });
      } catch (e) { toast(e.message_th || 'บันทึกไม่สำเร็จ', 'danger'); }
    }, { variant: decision === 'APPLY' ? 'primary' : 'secondary' });
    return h('div', { class: 'card', id: `corr-${c.id}`, tabindex: c.id === focusId ? '-1' : null },
      h('p', null, h('strong', null, `${formatThaiDate(c.school_date)} · ${enumLabel('CorrectionType', c.correction_type)}`), ` — ยื่นเมื่อ ${formatThaiDateTime(c.at)}`),
      h('p', null, `คำขอ: ${c.reason || '—'}`), f.nodes, field('บันทึกการพิจารณา', note, { required: true }),
      h('div', { class: 'form-actions row-actions' }, decide('REJECT'), decide('APPLY')));
  });
  const box = section(`คำขอแก้ไขที่รอพิจารณา (${pending.length})`, cards);
  if (focusId) setTimeout(() => { const el = document.getElementById(`corr-${focusId}`); if (el) { el.scrollIntoView({ behavior: 'smooth' }); el.focus(); } }, 0);
  return box;
}

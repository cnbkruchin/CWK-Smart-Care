// Contact / Case Inbox (MASTER_PROMPT §7.6, §7.8): my cases, cases in scope, overdue, and inbound
// guardian messages awaiting a reply. Case detail shows WHY the case exists (rule evidence), the
// contact history, appointments and actions. Tapping tel: does not record a call — staff log the result.
import { h, mount } from '../lib/dom.js';
import { field, input, select, textarea, form, table, loading, empty, errorState, section, alertBox, badge, actionButton, askText, toast, enumLabel, enumOptions } from '../ui.js';
import { formatThaiDate, formatThaiDateTime } from '../../../src/shared/thai-format.js';
import { localTimestamp, todayLocal } from '../lib/dates.js';

const PRIORITY_KIND = { URGENT: 'danger', HIGH: 'warn', NORMAL: 'info', LOW: 'neutral' };

function caseRow(c) {
  return [
    badge(enumLabel('Priority', c.priority), PRIORITY_KIND[c.priority] || 'neutral'),
    ' ', c.overdue ? badge('เกินกำหนด', 'danger', '⏰') : null,
  ];
}

function telLinks(guardians) {
  if (!guardians) return null;
  if (!guardians.length) return empty('ไม่มีผู้ปกครองที่เชื่อมโยง');
  return h('ul', { class: 'checklist' }, guardians.map((g) => h('li', null,
    h('strong', null, g.name), ` (${enumLabel('Relationship', g.relationship)})${g.is_primary_contact ? ' · ติดต่อหลัก' : ''} `,
    h('span', { class: 'row-actions' }, g.contacts.map((c) => (c.channel === 'PHONE' || c.channel === 'SMS'
      ? h('a', { class: 'btn btn-secondary', href: `tel:${String(c.value).replace(/[^0-9+]/g, '')}` }, `📞 ${c.value}`)
      : c.channel === 'EMAIL' ? h('a', { class: 'btn btn-secondary', href: `mailto:${c.value}` }, `✉ ${c.value}`) : `${enumLabel('ContactChannel', c.channel)}: ${c.value}`))))));
}

function evidenceView(c) {
  const ev = c.trigger_evidence;
  if (!ev || !ev.items) return null;
  return h('div', null,
    ev.is_example_rule ? alertBox('warn', 'เกณฑ์ที่ใช้เปิดเรื่องนี้ยังเป็น "ค่าตัวอย่าง" — ไม่ใช่ระเบียบของโรงเรียนจนกว่าจะกำหนดค่าจริง') : null,
    h('p', null, `ช่วงที่นับ: ${formatThaiDate(ev.window_from)} – ${formatThaiDate(ev.window_to)} · พบ ${ev.count} ครั้ง (เกณฑ์ ${ev.threshold})`),
    table([
      { label: 'วันที่', render: (x) => formatThaiDate(x.school_date) },
      { label: 'รายละเอียด', render: (x) => (x.late_minutes !== undefined ? `มาถึง ${x.arrived_at ? formatThaiDateTime(x.arrived_at) : '—'} · สาย ${x.late_minutes} นาที${x.exempted ? ' (ได้รับการยกเว้น)' : ''}` : 'ขาดเรียน (ครูยืนยันแล้ว)') },
    ], ev.items, { caption: 'หลักฐานที่เข้าเกณฑ์ (ระบบไม่ตัดสินพฤติกรรมหรือบทลงโทษ)' }));
}

async function caseDetail(app, box, id, reload) {
  mount(box, loading());
  let d;
  try { d = await app.api.get('case.get', { case_id: id }, { channel: 'case-detail' }); } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(box, errorState(e)); return; }
  const c = d.case;
  const again = () => { caseDetail(app, box, id, reload); reload(); };
  const run = async (operation, payload, okText) => {
    try { await app.api.mutate(operation, { case_id: c.id, ...payload }, { expectedVersion: c.version }); toast(okText); again(); } catch (e) {
      toast(e.code === 'CONFLICT' ? 'เรื่องนี้ถูกแก้ไขโดยผู้อื่นแล้ว ระบบโหลดข้อมูลล่าสุดให้' : (e.message_th || 'ทำรายการไม่สำเร็จ'), 'danger');
      if (e.code === 'CONFLICT') again();
    }
  };
  const actions = [];
  if (d.can.manage && c.status !== 'CLOSED') {
    if (c.status !== 'RESOLVED') actions.push(actionButton('บันทึกว่าแก้ไขแล้ว', async () => { const n = await askText('สรุปสิ่งที่ทำ', { multiline: true }); if (n) await run('case.resolve', { note: n }, 'บันทึกแล้ว'); }, { variant: 'secondary' }));
    actions.push(actionButton('ปิดเรื่อง', async () => { const n = await askText('ข้อสรุปการปิดเรื่อง', { multiline: true }); if (n) await run('case.close', { resolution_summary: n }, 'ปิดเรื่องแล้ว'); }, { variant: 'secondary' }));
    actions.push(actionButton('ส่งต่อผู้รับผิดชอบ', async () => assignDialog(app, c, run), { variant: 'secondary' }));
  }
  if (d.can.manage && (c.status === 'CLOSED' || c.status === 'RESOLVED')) {
    actions.push(actionButton('เปิดเรื่องอีกครั้ง', async () => { const n = await askText('เหตุผลที่เปิดใหม่', { multiline: true }); if (n) await run('case.reopen', { reason: n }, 'เปิดเรื่องอีกครั้งแล้ว'); }, { variant: 'secondary' }));
  }

  const nodes = [
    section(`${c.student ? c.student.name : ''} — ${enumLabel('CaseType', c.case_type)}`,
      h('p', null, caseRow(c), ' ', badge(enumLabel('CaseStatus', c.status), c.status === 'CLOSED' ? 'neutral' : 'info'),
        ` · ผู้รับผิดชอบ: ${c.owner_name || '—'} · กำหนด: ${c.due_at ? formatThaiDateTime(c.due_at) : '—'}`),
      h('p', null, h('strong', null, 'เหตุที่เปิดเรื่อง: '), c.trigger_summary_th),
      c.next_action_th ? h('p', null, h('strong', null, 'สิ่งที่ต้องทำต่อ: '), c.next_action_th) : null,
      c.resolution_summary ? h('p', null, h('strong', null, 'ข้อสรุป: '), c.resolution_summary) : null,
      c.student ? h('p', null, h('a', { href: `#/profile?id=${encodeURIComponent(c.student.id)}` }, 'เปิดประวัตินักเรียน')) : null,
      evidenceView(c),
      actions.length ? h('div', { class: 'form-actions row-actions' }, actions) : null),
  ];
  if (d.guardians) nodes.push(section('ติดต่อผู้ปกครอง', alertBox('info', 'การกดโทรไม่ถือว่าติดต่อสำเร็จ — บันทึกผลทุกครั้ง (ติดต่อไม่ได้ก็ต้องบันทึก)'), telLinks(d.guardians)));
  if (d.can.record_contact && c.status !== 'CLOSED') nodes.push(contactForm(app, c, d.guardians || [], again), appointmentForm(app, c, again));
  nodes.push(section('บันทึกการติดต่อ', d.contacts.length ? table([
    { label: 'เมื่อ', render: (x) => formatThaiDateTime(x.contacted_at) }, { label: 'ช่องทาง', render: (x) => `${enumLabel('ContactChannel', x.channel)} · ${enumLabel('ContactDirection', x.direction)}` },
    { label: 'ผล', render: (x) => enumLabel('ContactOutcome', x.outcome) }, { label: 'สรุป', key: 'summary' }, { label: 'โดย', key: 'contacted_by_name' },
  ], d.contacts) : h('p', { class: 'muted' }, 'ยังไม่มีบันทึกการติดต่อ')));
  if (d.appointments.length) {
    nodes.push(section('นัดหมาย', table([
      { label: 'เวลา', render: (a) => formatThaiDateTime(a.scheduled_at) }, { label: 'สถานที่', render: (a) => a.location || '—' }, { label: 'สถานะ', render: (a) => enumLabel('AppointmentStatus', a.status) },
      { label: 'ผล', render: (a) => a.outcome_note || '—' },
      { label: '', render: (a) => (d.can.record_contact && ['SCHEDULED', 'RESCHEDULED'].includes(a.status) ? h('div', { class: 'row-actions' },
        actionButton('พบแล้ว', () => apptUpdate(app, a, 'COMPLETED', again), { variant: 'secondary' }),
        actionButton('ไม่มาตามนัด', () => apptUpdate(app, a, 'NO_SHOW', again), { variant: 'secondary' }),
        actionButton('ยกเลิก', () => apptUpdate(app, a, 'CANCELLED', again), { variant: 'secondary' })) : '') },
    ], d.appointments)));
  }
  nodes.push(section('ประวัติเรื่อง', h('ul', { class: 'timeline' }, d.events.map((e) => h('li', null,
    h('strong', null, enumLabel('CaseEventType', e.event_type)), ` · ${formatThaiDateTime(e.occurred_at)} · ${e.actor_name}`, e.note ? h('div', { class: 'small' }, e.note) : null)))));
  mount(box, nodes);
  box.scrollIntoView({ behavior: 'smooth' });
}

async function apptUpdate(app, a, status, again) {
  const note = await askText(status === 'COMPLETED' ? 'ผลการพบ' : 'เหตุผล/รายละเอียด', { multiline: true });
  if (!note) return;
  try { await app.api.mutate('appointment.update', { appointment_id: a.id, status, outcome_note: note }, { expectedVersion: a.version }); toast('บันทึกแล้ว'); again(); } catch (e) { toast(e.message_th || 'บันทึกไม่สำเร็จ', 'danger'); }
}

async function assignDialog(app, c, run) {
  let people;
  try { people = (await app.api.get('case.assignable', { student_id: c.student.id })).items.filter((p) => p.user_id !== c.owner_user_id); } catch (e) { toast(e.message_th || 'โหลดรายชื่อไม่สำเร็จ', 'danger'); return; }
  if (!people.length) { toast('ไม่มีผู้ที่รับมอบหมายได้', 'warn'); return; }
  const sel = h('select', { class: 'input' }, people.map((p) => h('option', { value: p.user_id }, `${p.display_name} (${enumLabel('Role', p.role)})`)));
  const reason = h('input', { class: 'input', type: 'text' });
  await new Promise((resolve) => {
    const close = () => { overlay.remove(); resolve(); };
    const ok = actionButton('ส่งต่อ', async () => {
      if (reason.value.trim().length < 3) { toast('ระบุเหตุผล', 'warn'); return; }
      close();
      await run('case.assign', { owner_user_id: sel.value, reason: reason.value.trim() }, 'ส่งต่อแล้ว');
    });
    const overlay = h('div', { class: 'modal-overlay', role: 'presentation' }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'ส่งต่อผู้รับผิดชอบ' },
      h('h2', null, 'ส่งต่อผู้รับผิดชอบ'), field('ผู้รับ', sel), field('เหตุผล', reason, { required: true }),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'ยกเลิก'), ok)));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.appendChild(overlay);
    sel.focus();
  });
}

function contactForm(app, c, guardians, again) {
  const channel = select('channel', enumOptions('ContactChannel'));
  const direction = select('direction', enumOptions('ContactDirection'));
  const outcome = select('outcome', enumOptions('ContactOutcome'));
  const guardian = select('guardian_id', [h('option', { value: '' }, '— ไม่ระบุ —'), ...guardians.map((g) => h('option', { value: g.guardian_id }, g.name))]);
  const summary = textarea('summary', { maxlength: 2000, placeholder: 'สรุปสั้น ๆ ไม่ใส่ข้อมูลสุขภาพเกินจำเป็น' });
  const followUp = h('input', { type: 'checkbox', name: 'follow_up_required' });
  const nextDate = input('next_date', { type: 'date', min: todayLocal(app) });
  const nextTime = input('next_time', { type: 'time', value: '09:00' });
  return section('บันทึกผลการติดต่อ', form([
    h('div', { class: 'grid3' }, field('ช่องทาง', channel, { required: true }), field('ทิศทาง', direction, { required: true }), field('ผล', outcome, { required: true })),
    h('div', { class: 'grid3' }, field('ผู้ปกครอง', guardian), h('label', { class: 'check' }, followUp, ' ต้องติดตามต่อ'), field('ติดตามครั้งถัดไป (วันที่)', nextDate), field('เวลา', nextTime)),
    field('สรุป', summary, { required: true }),
  ], async () => {
    const r = await app.api.mutate('contact.log', {
      student_id: c.student.id, case_id: c.id, guardian_id: guardian.value || null, channel: channel.value, direction: direction.value, outcome: outcome.value,
      summary: summary.value.trim(), follow_up_required: followUp.checked, next_follow_up_at: followUp.checked && nextDate.value ? localTimestamp(app, nextDate.value, nextTime.value || '09:00') : null,
    });
    setTimeout(again, 600);
    return r ? 'บันทึกการติดต่อแล้ว' : false;
  }, { submitLabel: 'บันทึกการติดต่อ' }));
}

function appointmentForm(app, c, again) {
  const date = input('date', { type: 'date', min: todayLocal(app) });
  const time = input('time', { type: 'time', value: '15:30' });
  const loc = input('location', { maxlength: 200, placeholder: 'เช่น ห้องแนะแนว' });
  const note = input('attendees_note', { maxlength: 500, placeholder: 'ผู้เข้าร่วม' });
  return section('นัดหมาย', form([h('div', { class: 'grid3' }, field('วันที่', date, { required: true }), field('เวลา', time, { required: true }), field('สถานที่', loc)), field('ผู้เข้าร่วม', note)], async () => {
    if (!date.value) throw { message_th: 'ระบุวันที่นัด' };
    await app.api.mutate('appointment.create', { case_id: c.id, scheduled_at: localTimestamp(app, date.value, time.value), location: loc.value || null, attendees_note: note.value || null });
    setTimeout(again, 600);
    return 'บันทึกนัดหมายแล้ว';
  }, { submitLabel: 'นัดหมาย' }));
}

async function newCaseForm(app, studentId, onCreated) {
  const summary = textarea('summary_th', { maxlength: 1000, placeholder: 'ข้อเท็จจริงที่ทำให้ต้องติดตาม (ไม่ตัดสินพฤติกรรม)' });
  const priority = select('priority', enumOptions('Priority'));
  priority.value = 'NORMAL';
  const next = input('next_action_th', { maxlength: 500, placeholder: 'เช่น โทรคุยกับผู้ปกครอง' });
  return section('เปิดเรื่องติดตาม', form([field('เหตุที่เปิดเรื่อง', summary, { required: true }), h('div', { class: 'grid3' }, field('ความสำคัญ', priority), field('สิ่งที่ต้องทำต่อ', next))], async () => {
    const r = await app.api.mutate('case.create', { student_id: studentId, summary_th: summary.value.trim(), priority: priority.value, next_action_th: next.value.trim() || null });
    onCreated(r.case_id);
    return 'เปิดเรื่องแล้ว';
  }, { submitLabel: 'เปิดเรื่อง' }));
}

export async function renderCases(app, params) {
  const root = h('div');
  const listBox = h('div', { 'aria-live': 'polite' });
  const inboxBox = h('div');
  const detailBox = h('div');
  const view = select('view', [['mine', 'เรื่องของฉัน'], ['all', 'ทั้งหมดในขอบเขต'], ['overdue', 'เกินกำหนด'], ['CLOSED', 'ปิดแล้ว']].map(([v, t]) => h('option', { value: v }, t)));
  view.value = app.drafts.get('cases.view') || 'mine';
  const load = async () => {
    app.drafts.set('cases.view', view.value);
    mount(listBox, loading());
    try {
      const q = view.value === 'mine' ? { mine: true } : view.value === 'overdue' ? { overdue_only: true } : view.value === 'CLOSED' ? { status: 'CLOSED' } : {};
      const r = await app.api.get('case.list', q, { channel: 'case-list' });
      mount(listBox, r.items.length ? table([
        { label: 'ความสำคัญ', render: caseRow }, { label: 'นักเรียน', render: (c) => (c.student ? `${c.student.name} (${c.student.class_name_th || '—'})` : '—') },
        { label: 'ประเภท', render: (c) => enumLabel('CaseType', c.case_type) }, { label: 'สถานะ', render: (c) => enumLabel('CaseStatus', c.status) },
        { label: 'กำหนด', render: (c) => (c.due_at ? formatThaiDateTime(c.due_at) : '—') }, { label: 'ผู้รับผิดชอบ', render: (c) => c.owner_name || '—' },
      ], r.items, { onRow: (c) => caseDetail(app, detailBox, c.id, load) }) : empty('ไม่มีเรื่องติดตามในมุมมองนี้'));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(listBox, errorState(e, load)); }
    if (app.can('case.record_contact')) {
      try {
        const ib = await app.api.get('contact.inbox', {}, { channel: 'contact-inbox' });
        mount(inboxBox, section(`ข้อความ/คำขอติดต่อจากผู้ปกครองที่รอตอบ (${ib.total})`, ib.items.length ? table([
          { label: 'เมื่อ', render: (x) => formatThaiDateTime(x.contacted_at) }, { label: 'นักเรียน', key: 'student_name' }, { label: 'ผู้ปกครอง', render: (x) => x.guardian_name || '—' },
          { label: 'ช่องทาง', render: (x) => enumLabel('ContactChannel', x.channel) }, { label: 'ข้อความ', key: 'summary' },
          { label: '', render: (x) => actionButton('โทรกลับแล้ว — บันทึก', async () => replyInbound(app, x, load), { variant: 'secondary' }) },
        ], ib.items) : empty('ไม่มีรายการรอตอบ')));
      } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(inboxBox, errorState(e)); }
    }
  };
  view.addEventListener('change', load);
  root.append(h('div', { class: 'grid3' }, field('มุมมอง', view)), listBox, inboxBox);
  if (params.new && app.can('case.manage')) root.append(await newCaseForm(app, params.new, (id) => { load(); caseDetail(app, detailBox, id, load); }));
  root.append(detailBox);
  load();
  if (params.id) caseDetail(app, detailBox, params.id, load);
  return root;
}

async function replyInbound(app, x, reload) {
  const note = await askText(`สรุปการโทรกลับ ${x.guardian_name || 'ผู้ปกครอง'} (${x.student_name})`, { multiline: true });
  if (!note) return;
  try {
    await app.api.mutate('contact.log', { student_id: x.student_id, case_id: x.case_id, channel: 'PHONE', direction: 'OUTBOUND', outcome: 'REACHED', summary: note, follow_up_required: false, handles_contact_id: x.id });
    toast('บันทึกแล้ว');
    reload();
  } catch (e) { toast(e.message_th || 'บันทึกไม่สำเร็จ', 'danger'); }
}

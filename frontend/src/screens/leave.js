// Leave Request (MASTER_PROMPT §7.2): one request per student, one row per school day with unit
// (ทั้งวัน/ครึ่งวันเช้า/ครึ่งวันบ่าย/บางคาบ), retroactive reason, up to 3 attachments. The server checks
// school days, enrollment, overlaps and routing; this screen only collects input and shows results.
// Drafts stay in memory (app.drafts) — never in browser storage.
import { h, mount } from '../lib/dom.js';
import { field, input, select, textarea, form, table, loading, empty, errorState, section, alertBox, actionButton, enumLabel, enumOptions, fileToBase64, toast } from '../ui.js';
import { todayLocal } from '../lib/dates.js';
import { formatThaiDate } from '../../../src/shared/thai-format.js';
import { addDays, isoWeekday } from '../../../src/shared/time.js';
import { showLeaveDetail, leaveStatusBadge, MAX_FILE_BYTES } from './leave-detail.js';

const MAX_DAYS = 31;

function dayRow(day = {}) {
  const date = input('school_date', { type: 'date', value: day.school_date || '' });
  const unit = select('unit', enumOptions('LeaveUnit'));
  unit.value = day.unit || 'FULL_DAY';
  const periods = input('periods', { placeholder: 'เช่น 1,2,3', inputmode: 'numeric', value: (day.periods || []).join(',') });
  const periodsField = field('คาบ', periods, { hint: 'ใช้เมื่อเลือก "บางคาบ"' });
  const sync = () => { periodsField.hidden = unit.value !== 'PERIODS'; };
  unit.addEventListener('change', sync);
  sync();
  const el = h('div', { class: 'day-row' }, field('วันที่', date, { required: true }), field('ช่วง', unit), periodsField);
  return {
    el,
    value: () => ({
      school_date: date.value,
      unit: unit.value,
      periods: unit.value === 'PERIODS' ? periods.value.split(/[,\s]+/).filter(Boolean).map(Number) : null,
    }),
  };
}

async function studentPicker(app) {
  if (app.session.linked_student_ids.length || app.session.self_student_id) {
    const mine = (await app.api.get('student.listMine', {})).items;
    if (!mine.length) return null;
    return { el: select('student_id', mine.map((s) => h('option', { value: s.id }, `${s.first_name_th} ${s.last_name_th} (${s.class_name_th || '—'})`))), get value() { return this.el.value; } };
  }
  // Staff (homeroom/student affairs): pick by code or name within their scope (server-scoped search).
  const q = input('student_q', { placeholder: 'รหัสหรือชื่อนักเรียน', autocomplete: 'off' });
  const sel = select('student_id', [h('option', { value: '' }, '— ค้นหาแล้วเลือก —')]);
  const btn = actionButton('ค้นหา', async () => {
    try {
      const r = await app.api.get('student.search', { q: q.value.trim() || null, limit: 20 }, { channel: 'leave-student' });
      mount(sel, r.items.length ? r.items.map((s) => h('option', { value: s.id }, `${s.student_code} ${s.first_name_th} ${s.last_name_th} (${s.class_name_th || '—'})`)) : h('option', { value: '' }, 'ไม่พบ'));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') toast(e.message_th || 'ค้นหาไม่สำเร็จ', 'danger'); }
  }, { variant: 'secondary' });
  return { el: h('div', null, h('div', { class: 'row-actions' }, q, btn), sel), get value() { return sel.value; } };
}

export async function renderLeave(app, params) {
  const root = h('div');
  const detailBox = h('div');
  const listBox = h('div', { 'aria-live': 'polite' });
  let formBox = h('div');

  const loadList = async () => {
    if (!app.can('leave.read') && !app.can('leave.submit')) return;
    mount(listBox, loading());
    try {
      const r = await app.api.get('leave.list', { limit: 30 }, { channel: 'leave-list' });
      mount(listBox, r.items.length ? table([
        { label: 'นักเรียน', render: (x) => `${x.student_name} (${x.student_code || '—'})` },
        { label: 'ประเภท', render: (x) => enumLabel('LeaveType', x.leave_type) },
        { label: 'ช่วง', render: (x) => (x.start_date === addDays(x.end_date, -1) ? formatThaiDate(x.start_date) : `${formatThaiDate(x.start_date)} – ${formatThaiDate(addDays(x.end_date, -1))}`) },
        { label: 'สถานะ', render: (x) => leaveStatusBadge(x.status) },
      ], r.items, { onRow: (x) => openDetail(x.id) }) : empty('ยังไม่มีใบลา'));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(listBox, errorState(e, loadList)); }
  };

  const openDetail = (id) => {
    showLeaveDetail(app, detailBox, id, { onChanged: loadList, onResubmit: (d) => { mount(formBox, '') ; buildForm(d).then((f) => { mount(formBox, f); formBox.scrollIntoView({ behavior: 'smooth' }); }); } });
    detailBox.scrollIntoView({ behavior: 'smooth' });
  };

  const buildForm = async (resubmit = null) => {
    const picker = resubmit ? null : await studentPicker(app);
    if (!resubmit && !picker) return alertBox('warn', 'ยังไม่มีนักเรียนที่เชื่อมกับบัญชีนี้ (โรงเรียนต้องยืนยันความสัมพันธ์ก่อน)');
    const draftKey = resubmit ? `leave.resubmit.${resubmit.request.id}` : 'leave.new';
    const draft = app.drafts.get(draftKey) || (resubmit ? { leave_type: resubmit.request.leave_type, reason: resubmit.request.reason, days: resubmit.segments.filter((s) => s.status !== 'WITHDRAWN').map((s) => ({ school_date: s.school_date, unit: s.unit, periods: s.periods })) } : {});
    const type = select('leave_type', enumOptions('LeaveType'));
    type.value = draft.leave_type || 'SICK';
    const reason = textarea('reason', { value: draft.reason || '', maxlength: 1000, placeholder: 'เหตุผลโดยย่อ (ไม่ต้องใส่รายละเอียดการรักษา)' });
    const retro = textarea('retroactive_reason', { rows: 2, value: draft.retroactive_reason || '', maxlength: 1000 });
    const files = h('input', { type: 'file', name: 'attachments', multiple: true, accept: 'application/pdf,image/jpeg,image/png', class: 'input' });
    const rows = [];
    const rowsBox = h('div');
    const addRow = (d) => { if (rows.length >= MAX_DAYS) { toast(`สูงสุด ${MAX_DAYS} วันต่อใบลา`, 'warn'); return; } const r = dayRow(d); rows.push(r); rowsBox.appendChild(r.el); };
    for (const d of draft.days && draft.days.length ? draft.days : [{ school_date: params.date || todayLocal(app) }]) addRow(d);
    const rangeFrom = input('range_from', { type: 'date' });
    const rangeTo = input('range_to', { type: 'date' });
    const addRange = actionButton('เพิ่มช่วงวันที่ (จันทร์–ศุกร์)', async () => {
      if (!rangeFrom.value || !rangeTo.value || rangeTo.value < rangeFrom.value) { toast('ระบุวันเริ่มและวันสิ้นสุดให้ถูกต้อง', 'warn'); return; }
      const have = new Set(rows.map((r) => r.value().school_date));
      for (let d = rangeFrom.value; d <= rangeTo.value; d = addDays(d, 1)) if (isoWeekday(d) <= 5 && !have.has(d)) addRow({ school_date: d });
    }, { variant: 'secondary' });
    const removeLast = actionButton('ลบแถวสุดท้าย', async () => { if (rows.length > 1) rows.pop().el.remove(); }, { variant: 'secondary' });
    const remember = () => app.drafts.set(draftKey, { leave_type: type.value, reason: reason.value, retroactive_reason: retro.value, days: rows.map((r) => r.value()) });
    const today = todayLocal(app);

    return section(resubmit ? `แก้ไขใบลาของ ${resubmit.student.name} และส่งใหม่` : 'ยื่นใบลา', form([
      picker ? field('นักเรียน', picker.el, { required: true }) : null,
      h('div', { class: 'grid3' }, field('ประเภทการลา', type, { required: true })),
      field('เหตุผล', reason, { required: true }),
      h('h3', null, 'วันที่ลา'), rowsBox,
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => addRow({}) }, '+ เพิ่มวัน'), removeLast),
      h('div', { class: 'grid3' }, field('ตั้งแต่', rangeFrom), field('ถึง', rangeTo), h('div', { class: 'field' }, addRange)),
      alertBox('info', 'ระบบตรวจวันหยุด วันซ้ำกับใบลาเดิม และทะเบียนนักเรียนให้อัตโนมัติ วันที่ไม่ใช่วันเรียนจะแจ้งเป็นข้อผิดพลาด'),
      field('เหตุผลที่ยื่นย้อนหลัง', retro, { hint: `จำเป็นเมื่อมีวันลาก่อนวันนี้ (${formatThaiDate(today)})` }),
      resubmit ? null : field('เอกสารแนบ (ไม่เกิน 3 ไฟล์ ไฟล์ละ 5 MB: PDF/JPG/PNG)', files, { hint: 'ใบรับรองแพทย์ถือเป็นข้อมูลอ่อนไหว เห็นได้เฉพาะผู้มีสิทธิ์' }),
    ], async () => {
      remember();
      const days = rows.map((r) => r.value()).filter((d) => d.school_date);
      if (!days.length) throw { message_th: 'กรุณาระบุวันที่ลาอย่างน้อย 1 วัน' };
      const base = { leave_type: type.value, reason: reason.value.trim(), days, retroactive_reason: retro.value.trim() || null };
      if (resubmit) {
        const r = await app.api.mutate('leave.resubmit', { leave_request_id: resubmit.request.id, ...base }, { expectedVersion: resubmit.request.version });
        app.drafts.delete(draftKey);
        loadList();
        openDetail(resubmit.request.id);
        return `ส่งใหม่แล้ว — ${enumLabel('LeaveStatus', r.status)}`;
      }
      const picked = [...files.files];
      if (picked.length > 3) throw { message_th: 'แนบได้ไม่เกิน 3 ไฟล์' };
      for (const f of picked) if (f.size > MAX_FILE_BYTES) throw { message_th: `ไฟล์ ${f.name} ใหญ่เกิน 5 MB` };
      const attachments = [];
      for (const f of picked) attachments.push({ filename: f.name, mime_type: f.type || null, content_base64: await fileToBase64(f) });
      const r = await app.api.mutate('leave.submit', { student_id: picker.value, ...base, attachments });
      app.drafts.delete(draftKey);
      loadList();
      openDetail(r.leave_request_id);
      return `ส่งใบลาแล้ว — ${enumLabel('LeaveStatus', r.status)}${r.attachment_required && !attachments.length ? ' (กฎกำหนดให้แนบเอกสาร กรุณาแนบเพิ่มในรายละเอียดใบลา)' : ''}`;
    }, { submitLabel: resubmit ? 'ส่งใหม่' : 'ส่งใบลา' }));
  };

  if (app.can('leave.submit')) formBox = h('div', null, await buildForm());
  root.appendChild(formBox);
  root.appendChild(section('ใบลาของฉัน/ในความดูแล', listBox));
  root.appendChild(detailBox);
  loadList();
  if (params.id) openDetail(params.id);
  return root;
}

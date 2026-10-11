// Leave request detail shared by "แจ้งลา" (requester view) and "พิจารณาใบลา" (approver view). Every action
// is offered only when the server says it is allowed (`can` from leave.get + status), carries
// expected_version, and re-renders from the server afterwards. Decisions never happen client-side.
import { h, mount } from '../lib/dom.js';
import { section, table, loading, errorState, alertBox, badge, actionButton, askText, toast, enumLabel, downloadBlob, base64ToBytes, fileToBase64, field } from '../ui.js';
import { formatThaiDate, formatThaiDateTime } from '../../../src/shared/thai-format.js';

const PENDING = ['PENDING_GUARDIAN', 'PENDING_SCHOOL', 'RETURNED'];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

function statusKind(s) {
  if (['APPROVED'].includes(s)) return 'ok';
  if (['REJECTED', 'CANCELLED'].includes(s)) return 'danger';
  if (['PARTIALLY_APPROVED', 'RETURNED', 'CANCELLATION_REQUESTED'].includes(s)) return 'warn';
  return 'info';
}

export function leaveStatusBadge(s) {
  return badge(enumLabel('LeaveStatus', s), statusKind(s));
}

function segUnit(s) {
  return s.unit === 'PERIODS' ? `คาบ ${(s.periods || []).join(', ')}` : enumLabel('LeaveUnit', s.unit);
}

/** Renders the detail into `box`; `onChanged` is called after a successful action. */
export async function showLeaveDetail(app, box, id, { onChanged = null, onResubmit = null } = {}) {
  mount(box, loading());
  let d;
  try { d = await app.api.get('leave.get', { leave_request_id: id }, { channel: 'leave-detail' }); } catch (e) {
    if (e.code !== 'STALE_RESPONSE') mount(box, errorState(e, () => showLeaveDetail(app, box, id, { onChanged, onResubmit })));
    return;
  }
  const r = d.request;
  const reload = () => { showLeaveDetail(app, box, id, { onChanged, onResubmit }); if (onChanged) onChanged(); };
  const run = async (operation, payload, okText) => {
    try {
      await app.api.mutate(operation, { leave_request_id: r.id, ...payload }, { expectedVersion: r.version });
      toast(okText);
      reload();
    } catch (e) {
      toast(e.code === 'CONFLICT' ? 'ใบลานี้ถูกแก้ไขโดยผู้อื่นแล้ว ระบบโหลดข้อมูลล่าสุดให้' : (e.message_th || 'ทำรายการไม่สำเร็จ'), 'danger');
      if (e.code === 'CONFLICT' || e.code === 'INVALID_STATE') reload();
    }
  };

  const actions = [];
  if (d.can.confirm_guardian && r.status === 'PENDING_GUARDIAN') {
    actions.push(actionButton('ยืนยันใบลา (ผู้ปกครอง)', () => run('leave.confirmGuardian', { decision: 'CONFIRMED', comment: null }, 'ยืนยันแล้ว — ส่งต่อให้โรงเรียนพิจารณา')));
    actions.push(actionButton('ไม่ยืนยัน', async () => {
      const c = await askText('เหตุผลที่ไม่ยืนยัน', { multiline: true });
      if (c) await run('leave.confirmGuardian', { decision: 'DECLINED', comment: c }, 'บันทึกว่าไม่ยืนยันแล้ว');
    }, { variant: 'secondary' }));
  }
  const segDecisions = new Map();
  if (d.can.decide && r.status === 'PENDING_SCHOOL') {
    actions.push(actionButton('อนุมัติ', async () => {
      const c = r.attachment_required && !d.attachments.length ? await askText('ใบลานี้ควรมีเอกสารแนบตามกฎ แต่ยังไม่มี — ระบุเหตุผลที่อนุมัติ', { multiline: true }) : null;
      if (r.attachment_required && !d.attachments.length && !c) return;
      await run('leave.decide', { decision: 'APPROVED', comment: c }, 'อนุมัติแล้ว');
    }, { confirmText: 'อนุมัติใบลานี้ทุกช่วง?' }));
    if (d.segments.filter((s) => s.status === 'REQUESTED').length > 1) {
      actions.push(actionButton('อนุมัติบางช่วง (ตามที่เลือกในตาราง)', async () => {
        const active = d.segments.filter((s) => s.status === 'REQUESTED');
        const map = Object.fromEntries(active.map((s) => [s.id, segDecisions.get(s.id) ? segDecisions.get(s.id).value : 'APPROVED']));
        const c = await askText('เหตุผลที่อนุมัติบางช่วง', { multiline: true });
        if (c) await run('leave.decide', { decision: 'PARTIALLY_APPROVED', segment_decisions: map, comment: c }, 'บันทึกผลรายช่วงแล้ว');
      }, { variant: 'secondary' }));
    }
    actions.push(actionButton('ไม่อนุมัติ', async () => {
      const c = await askText('เหตุผลที่ไม่อนุมัติ', { multiline: true });
      if (c) await run('leave.decide', { decision: 'REJECTED', comment: c }, 'บันทึกว่าไม่อนุมัติแล้ว');
    }, { variant: 'secondary' }));
  }
  if (d.can.decide && ['PENDING_SCHOOL', 'PENDING_GUARDIAN'].includes(r.status)) {
    actions.push(actionButton('ส่งกลับให้แก้ไข', async () => {
      const c = await askText('สิ่งที่ต้องแก้ไข', { multiline: true });
      if (c) await run('leave.decide', { decision: 'RETURNED', comment: c }, 'ส่งกลับแล้ว');
    }, { variant: 'secondary' }));
  }
  if (d.can.decide && r.status === 'CANCELLATION_REQUESTED') {
    actions.push(actionButton('อนุมัติการยกเลิก', async () => {
      const c = await askText('เหตุผล', { multiline: true });
      if (c) await run('leave.decideCancel', { approve: true, reason: c }, 'ยกเลิกใบลาแล้ว — ระบบคำนวณการมาเรียนใหม่');
    }));
    actions.push(actionButton('ไม่อนุมัติการยกเลิก', async () => {
      const c = await askText('เหตุผล', { multiline: true });
      if (c) await run('leave.decideCancel', { approve: false, reason: c }, 'บันทึกแล้ว');
    }, { variant: 'secondary' }));
  }
  if (d.can.decide && ['APPROVED', 'PARTIALLY_APPROVED'].includes(r.status)) {
    actions.push(actionButton('ยกเลิกใบลาโดยผู้มีอำนาจ', async () => {
      const c = await askText('เหตุผลที่ยกเลิก (จะคำนวณการมาเรียนของวันที่เกี่ยวข้องใหม่)', { multiline: true });
      if (c) await run('leave.decideCancel', { approve: true, reason: c }, 'ยกเลิกใบลาแล้ว');
    }, { variant: 'secondary' }));
  }
  if (d.can.decide && app.session.roles.includes('STUDENT_AFFAIRS') && ['PENDING_GUARDIAN', 'PENDING_SCHOOL'].includes(r.status)) {
    actions.push(actionButton('เปลี่ยนผู้พิจารณา', async () => {
      const to = r.current_approver_role === 'HOMEROOM_TEACHER' ? 'STUDENT_AFFAIRS' : 'HOMEROOM_TEACHER';
      const c = await askText(`ส่งต่อให้ ${to === 'STUDENT_AFFAIRS' ? 'กลุ่มงานกิจการนักเรียน' : 'ครูที่ปรึกษา'} — ระบุเหตุผล`);
      if (c) await run('leave.reroute', { approver_role: to, approver_user_id: null, reason: c }, 'เปลี่ยนผู้พิจารณาแล้ว');
    }, { variant: 'secondary' }));
  }
  if (d.can.own && PENDING.includes(r.status)) {
    actions.push(actionButton('ถอนคำขอลา', () => run('leave.withdraw', { reason: null }, 'ถอนคำขอแล้ว'), { variant: 'secondary', confirmText: 'ถอนคำขอลานี้?' }));
  }
  if (d.can.own && r.status === 'RETURNED' && onResubmit) {
    actions.push(actionButton('แก้ไขและส่งใหม่', async () => onResubmit(d), { variant: 'primary' }));
  }
  if (!d.can.decide && app.can('leave.cancel') && ['APPROVED', 'PARTIALLY_APPROVED'].includes(r.status)) {
    actions.push(actionButton('ขอยกเลิกใบลา', async () => {
      const c = await askText('เหตุผลที่ขอยกเลิก', { multiline: true });
      if (c) await run('leave.requestCancel', { reason: c }, 'ส่งคำขอยกเลิกแล้ว (รอโรงเรียนพิจารณา)');
    }, { variant: 'secondary' }));
  }

  const attachInput = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png', class: 'input' });
  const canAttach = (d.can.own || d.can.decide) && !['WITHDRAWN', 'CANCELLED'].includes(r.status);

  const segRows = d.segments.map((s) => {
    let ctl = null;
    if (d.can.decide && r.status === 'PENDING_SCHOOL' && s.status === 'REQUESTED') {
      ctl = h('select', { class: 'input', 'aria-label': `ผลวันที่ ${s.school_date}` }, h('option', { value: 'APPROVED' }, 'อนุมัติ'), h('option', { value: 'REJECTED' }, 'ไม่อนุมัติ'));
      segDecisions.set(s.id, ctl);
    }
    return { ...s, ctl };
  });

  mount(box,
    section(`ใบลา: ${d.student.name} (${d.student.student_code})`,
      h('p', null, leaveStatusBadge(r.status), ' ',
        badge(`ผู้ปกครอง: ${enumLabel('GuardianConfirmation', r.guardian_confirmation_status)}`, 'neutral'), ' ',
        badge(`โรงเรียน: ${enumLabel('SchoolApproval', r.school_approval_status)}`, 'neutral')),
      h('dl', { class: 'kv' },
        h('dt', null, 'ประเภท'), h('dd', null, enumLabel('LeaveType', r.leave_type)),
        h('dt', null, 'เหตุผล'), h('dd', null, r.reason),
        h('dt', null, 'ผู้ยื่น'), h('dd', null, `${d.requester_name} (${enumLabel('RequesterType', r.requester_type)}) เมื่อ ${formatThaiDateTime(r.submitted_at)}`),
        h('dt', null, 'ผู้พิจารณา'), h('dd', null, r.current_approver_role ? enumLabel('Role', r.current_approver_role) : '—'),
        r.is_retroactive ? [h('dt', null, 'ยื่นย้อนหลัง'), h('dd', null, r.retroactive_reason || '—')] : null),
      r.attachment_required && !d.attachments.length ? alertBox('warn', 'กฎการลากำหนดให้แนบเอกสาร (เช่น ใบรับรองแพทย์) แต่ยังไม่มีไฟล์แนบ') : null,
      table([
        { label: 'วันที่', render: (s) => formatThaiDate(s.school_date) }, { label: 'ช่วง', render: segUnit },
        { label: 'สถานะ', render: (s) => enumLabel('SegmentStatus', s.status) }, ...(segDecisions.size ? [{ label: 'ผลรายช่วง', render: (s) => s.ctl || '—' }] : []),
      ], segRows, { caption: 'ช่วงลา (นับแยกหน่วย ทั้งวัน/ครึ่งวัน/คาบ)' }),
      actions.length ? h('div', { class: 'form-actions row-actions' }, actions) : null),
    section('เอกสารแนบ',
      d.attachments.length ? table([
        { label: 'ไฟล์', key: 'filename' }, { label: 'ประเภท', render: (a) => (a.classification === 'MEDICAL' ? badge('เอกสารสุขภาพ (อ่อนไหว)', 'warn') : 'ทั่วไป') },
        { label: 'ขนาด', render: (a) => `${Math.ceil(a.size_bytes / 1024)} KB` },
        { label: '', render: (a) => actionButton('ดาวน์โหลด', async () => {
          try {
            const f = await app.api.get('attachment.download', { attachment_id: a.id });
            downloadBlob(f.filename, base64ToBytes(f.content_base64), f.mime_type);
          } catch (e) { toast(e.message_th || 'ดาวน์โหลดไม่สำเร็จ', 'danger'); }
        }, { variant: 'secondary' }) },
      ], d.attachments) : h('p', { class: 'muted' }, 'ไม่มีไฟล์แนบ'),
      canAttach ? h('div', null, field('แนบไฟล์เพิ่ม (PDF/JPG/PNG ไม่เกิน 5 MB)', attachInput), actionButton('อัปโหลด', async () => {
        const file = attachInput.files[0];
        if (!file) { toast('ยังไม่ได้เลือกไฟล์', 'warn'); return; }
        if (file.size > MAX_FILE_BYTES) { toast('ไฟล์ใหญ่เกิน 5 MB', 'danger'); return; }
        try {
          await app.api.mutate('leave.addAttachment', { leave_request_id: r.id, file: { filename: file.name, mime_type: file.type || null, content_base64: await fileToBase64(file) } });
          toast('แนบไฟล์แล้ว');
          reload();
        } catch (e) { toast(e.message_th || 'แนบไฟล์ไม่สำเร็จ', 'danger'); }
      }, { variant: 'secondary' })) : null),
    section('ประวัติการพิจารณา',
      d.approvals.length ? table([
        { label: 'เมื่อ', render: (a) => formatThaiDateTime(a.decided_at) }, { label: 'ขั้นตอน', render: (a) => enumLabel('ApprovalStepType', a.step_type) },
        { label: 'ผล', render: (a) => enumLabel('ApprovalDecision', a.decision) }, { label: 'โดย', key: 'decided_by_name' }, { label: 'หมายเหตุ', render: (a) => a.comment || '—' },
      ], d.approvals) : h('p', { class: 'muted' }, 'ยังไม่มีการพิจารณา'),
      h('details', null, h('summary', null, `ประวัติการแก้ไข (${d.revisions.length})`), h('ul', { class: 'timeline' }, d.revisions.map((v) =>
        h('li', null, `${formatThaiDateTime(v.acted_at)} · ${enumLabel('LeaveAction', v.action)} · ${v.actor_name}${v.from_status ? ` · ${enumLabel('LeaveStatus', v.from_status)} → ` : ' · '}${enumLabel('LeaveStatus', v.to_status)}${v.comment ? ` — ${v.comment}` : ''}`))))));
}

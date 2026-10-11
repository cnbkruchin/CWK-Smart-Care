// Leave Approval Inbox (MASTER_PROMPT §7.2): what is waiting for *me* — guardian confirmation, school
// approval along the routing rule, or cancellation decisions. Opening an item shows the full detail
// with only the actions the server allows for this account.
import { h, mount } from '../lib/dom.js';
import { table, loading, empty, errorState, section, badge, enumLabel } from '../ui.js';
import { formatThaiDate, formatThaiDateTime } from '../../../src/shared/thai-format.js';
import { addDays } from '../../../src/shared/time.js';
import { showLeaveDetail } from './leave-detail.js';

const KIND = {
  GUARDIAN_CONFIRMATION: ['รอผู้ปกครองยืนยัน', 'info'],
  SCHOOL_APPROVAL: ['รออนุมัติ', 'warn'],
  CANCELLATION_DECISION: ['ขอยกเลิก', 'danger'],
};

export async function renderApprovals(app, params) {
  const listBox = h('div', { 'aria-live': 'polite' });
  const detailBox = h('div');
  const open = (id) => { showLeaveDetail(app, detailBox, id, { onChanged: load }); detailBox.scrollIntoView({ behavior: 'smooth' }); };
  async function load() {
    mount(listBox, loading());
    try {
      const r = await app.api.get('leave.inbox', {}, { channel: 'leave-inbox' });
      mount(listBox, r.items.length ? table([
        { label: 'งาน', render: (x) => badge(...(KIND[x.kind] || [x.kind, 'neutral'])) },
        { label: 'นักเรียน', key: 'student_name' },
        { label: 'ประเภท', render: (x) => enumLabel('LeaveType', x.request.leave_type) },
        { label: 'วันที่ลา', render: (x) => (x.request.start_date === addDays(x.request.end_date, -1) ? formatThaiDate(x.request.start_date) : `${formatThaiDate(x.request.start_date)} – ${formatThaiDate(addDays(x.request.end_date, -1))}`) },
        { label: 'ยื่นเมื่อ', render: (x) => formatThaiDateTime(x.request.submitted_at) },
        { label: 'หมายเหตุ', render: (x) => [x.request.is_retroactive ? badge('ย้อนหลัง', 'warn') : null, x.request.attachment_required ? badge('ต้องมีเอกสาร', 'info') : null] },
      ], r.items, { onRow: (x) => open(x.request.id) }) : empty('ไม่มีใบลารอพิจารณา'));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(listBox, errorState(e, load)); }
  }
  load();
  if (params.id) open(params.id);
  return h('div', null, section('รอฉันพิจารณา', listBox), detailBox);
}

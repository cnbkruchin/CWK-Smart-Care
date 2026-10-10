// System Health: readiness checks (no secrets), maintenance mode, background jobs.
import { h } from '../lib/dom.js';
import { section, table, statusBadge, actionButton, alertBox, enumLabel, empty, toast, askText } from '../ui.js';

export async function renderHealth(app) {
  const hlt = await app.api.get('system.health', {});
  const root = h('div');
  root.appendChild(h('p', null, statusBadge(hlt.status), ` สภาพแวดล้อม ${hlt.env} · โหมด ${hlt.system_mode} · เวลาเซิร์ฟเวอร์ ${hlt.server_time} · วันเรียน ${hlt.school_date}`));
  root.appendChild(section('รายการตรวจ', table([{ label: 'สถานะ', render: (c) => statusBadge(c.status) }, { label: 'หัวข้อ', key: 'key' }, { label: 'รายละเอียด', key: 'detail_th' }], hlt.checks)));
  if (app.can('system.maintenance')) {
    const ro = hlt.system_mode === 'READ_ONLY';
    root.appendChild(section('โหมดอ่านอย่างเดียว (maintenance)',
      alertBox('warn', 'เมื่อเปิด ระบบปฏิเสธการบันทึกทุกช่องทางที่ server (ใช้ก่อน snapshot/ย้ายข้อมูล/แก้ข้อมูลฉุกเฉิน)'),
      actionButton(ro ? 'ปิดโหมดอ่านอย่างเดียว' : 'เปิดโหมดอ่านอย่างเดียว', async () => {
        const reason = await askText('เหตุผล');
        if (!reason) return;
        await app.api.mutate('system.setMode', { mode: ro ? 'NORMAL' : 'READ_ONLY', reason });
        toast('เปลี่ยนโหมดแล้ว'); app.render();
      }, { variant: ro ? 'secondary' : 'danger', confirmText: ro ? 'กลับสู่โหมดปกติ?' : 'เปิดโหมดอ่านอย่างเดียว ผู้ใช้จะบันทึกข้อมูลไม่ได้จนกว่าจะปิด' })));
  }
  const jobs = await app.api.get('job.list', { limit: 30 });
  root.appendChild(section('งานเบื้องหลัง', jobs.items.length ? table([
    { label: 'ชนิด', key: 'job_type' }, { label: 'สถานะ', render: (j) => enumLabel('JobStatus', j.status) }, { label: 'ครั้งที่', key: 'attempts' },
    { label: 'ความคืบหน้า', render: (j) => (j.progress && j.progress.message_th) || '—' }, { label: 'ข้อผิดพลาด', render: (j) => j.last_error || '' },
    { label: '', render: (j) => (j.status === 'FAILED' && app.can('system.maintenance') ? actionButton('รันใหม่', async () => {
      const reason = await askText('เหตุผลที่รันใหม่');
      if (!reason) return;
      await app.api.mutate('job.retry', { job_id: j.id, reason }); app.render();
    }, { variant: 'link' }) : '') },
  ], jobs.items) : empty('ยังไม่มีงานเบื้องหลัง')));
  if (hlt.platform && hlt.platform.table_rows) {
    root.appendChild(section('ขนาดข้อมูล (แถว)', table([{ label: 'ตาราง', key: 'table' }, { label: 'partition', key: 'partition' }, { label: 'แถว', key: 'rows' }], hlt.platform.table_rows)));
  }
  return root;
}

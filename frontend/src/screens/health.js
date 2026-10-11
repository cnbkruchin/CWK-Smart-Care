// System Health: readiness checks (no secrets), maintenance mode, background jobs.
import { h } from '../lib/dom.js';
import { section, table, statusBadge, actionButton, alertBox, enumLabel, empty, toast, askText, badge } from '../ui.js';

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
  // request performance (OperationMetrics, flushed every tick)
  try {
    const m = await app.api.get('system.metrics', { hours: 24 });
    root.appendChild(section('เวลาตอบสนอง 24 ชั่วโมงล่าสุด', m.items.length ? table([
      { label: 'operation', key: 'operation' }, { label: 'จำนวน', key: 'count' }, { label: 'ผิดพลาด %', key: 'error_rate' }, { label: 'p50 (ms)', render: (x) => x.p50_ms ?? '—' },
      { label: 'p95 สูงสุด (ms)', key: 'p95_ms_worst_bucket' }, { label: 'lock wait p95 (ms)', key: 'lock_wait_p95_ms_worst_bucket' },
    ], m.items.slice(0, 25)) : empty('ยังไม่มีข้อมูล (flush ทุกรอบ cronTick)'), h('p', { class: 'muted small' }, m.note_th)));
  } catch (_) { /* metrics are optional on this page */ }
  // backups and restore drills
  try {
    const b = await app.api.get('backup.list', { limit: 10 });
    root.appendChild(section('การสำรองข้อมูล',
      b.restore_tested ? null : alertBox('warn', 'ยังไม่เคยบันทึกผลทดสอบ restore ไป environment ใหม่ — ต้องทำก่อนใช้งานจริง (docs/OPERATIONS_TH.md)'),
      b.items.length ? table([
        { label: 'เริ่ม', key: 'started_at' }, { label: 'ประเภท', render: (x) => enumLabel('BackupType', x.backup_type) }, { label: 'สถานะ', render: (x) => badge(enumLabel('RunStatus', x.status), x.status === 'SUCCEEDED' ? 'ok' : x.status === 'FAILED' ? 'danger' : 'neutral') },
        { label: 'checksum', render: (x) => (x.manifest_sha256 ? x.manifest_sha256.slice(0, 12) : '—') }, { label: 'ทดสอบ restore', render: (x) => x.restore_result || '—' },
        { label: '', render: (x) => (app.can('backup.manage') && x.status === 'SUCCEEDED' ? actionButton('บันทึกผลทดสอบ restore', async () => {
          const note = await askText('ผลการทดสอบ (environment ที่กู้คืน, สิ่งที่ตรวจ, จำนวนนาทีที่ใช้ เช่น "PASS 35 STAGING ใหม่ แถวตรงกัน")', { multiline: true });
          if (!note) return;
          const m = /(\d+)/.exec(note);
          try { await app.api.mutate('backup.recordRestoreTest', { backup_run_id: x.id, result: /fail|ไม่ผ่าน/i.test(note) ? 'FAIL' : 'PASS', minutes: m ? Number(m[1]) : 0, note }); toast('บันทึกแล้ว'); app.render(); } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
        }, { variant: 'link' }) : '') },
      ], b.items) : empty('ยังไม่มีการสำรองข้อมูล'),
      app.can('backup.manage') ? actionButton('สำรองข้อมูลตอนนี้', async () => {
        try { await app.api.mutate('backup.run', {}); toast('เข้าคิวสำรองข้อมูลแล้ว'); setTimeout(() => app.render(), 2000); } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
      }, { variant: 'secondary', confirmText: 'สำรองข้อมูลตอนนี้? ระหว่างคัดลอกผู้ใช้อาจรอการบันทึกสักครู่' }) : null));
  } catch (_) { /* not permitted */ }
  // retention of operational logs
  if (app.can('system.maintenance')) {
    try {
      const r = await app.api.get('retention.preview', {});
      root.appendChild(section('ระยะเวลาเก็บบันทึกระบบ',
        h('ul', null, r.not_automated_th.map((t) => h('li', null, t))),
        r.items.length ? table([
          { label: 'ตาราง', key: 'table' }, { label: 'ภาคเรียน', key: 'partition' }, { label: 'จบภาคเรียน', key: 'term_end' }, { label: 'เก็บ (วัน)', key: 'keep_days' }, { label: 'แถว', key: 'rows' },
          { label: '', render: (x) => (x.eligible && x.rows ? actionButton('ล้างตามระยะเก็บ', async () => {
            const reason = await askText(`ล้าง ${x.table} ของ ${x.partition} (${x.rows} แถว) — ระบุเหตุผล`);
            if (!reason) return;
            try { const res = await app.api.mutate('retention.purge', { table: x.table, partition: x.partition, reason }); toast(`ล้างแล้ว ${res.removed} แถว`); app.render(); } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
          }, { variant: 'link', confirmText: 'ข้อมูลที่ล้างแล้วกู้คืนได้จากสำเนาสำรองที่ยังไม่หมดอายุเท่านั้น ยืนยัน?' }) : (x.eligible ? 'ว่าง' : 'ยังไม่ครบระยะ')) },
        ], r.items) : empty('ยังไม่มี partition ของบันทึกระบบ'),
        h('p', null, `งานเบื้องหลังที่จบเกิน ${r.jobs.keep_days} วัน: ${r.jobs.eligible_rows} รายการ `, r.jobs.eligible_rows ? actionButton('ลบงานเก่า', async () => {
          const reason = await askText('เหตุผล');
          if (!reason) return;
          try { const res = await app.api.mutate('retention.purgeJobs', { reason }); toast(`ลบแล้ว ${res.removed} รายการ`); app.render(); } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
        }, { variant: 'link' }) : null)));
    } catch (_) { /* optional */ }
  }
  if (hlt.platform && hlt.platform.table_rows) {
    root.appendChild(section('ขนาดข้อมูล (แถว)', table([{ label: 'ตาราง', key: 'table' }, { label: 'partition', key: 'partition' }, { label: 'แถว', key: 'rows' }], hlt.platform.table_rows)));
  }
  return root;
}

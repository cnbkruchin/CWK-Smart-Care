// Import Center: template → upload → column mapping → preview → dry-run → apply (job with progress).
import { h, mount } from '../lib/dom.js';
import { field, select, input, form, table, loading, empty, errorState, section, enumOptions, actionButton, alertBox, downloadBlob, fileToBase64, statusBadge, enumLabel } from '../ui.js';

export async function renderImports(app) {
  const root = h('div');
  const work = h('div', { 'aria-live': 'polite' });
  const type = select('import_type', enumOptions('ImportType'));
  const file = h('input', { type: 'file', name: 'file', accept: '.csv,.xlsx', class: 'input' });
  root.appendChild(section('1. เลือกชนิดข้อมูลและไฟล์',
    alertBox('info', 'รองรับ CSV (UTF-8) และ XLSX ≤ 5 MB / 5,000 แถว · รหัสนักเรียนและเบอร์โทรเก็บเป็นข้อความ (เลข 0 นำหน้าไม่หาย) · ชื่อซ้ำจะแจ้งเตือนแต่ไม่รวมเป็นคนเดียว'),
    h('div', { class: 'row gap' }, actionButton('ดาวน์โหลดไฟล์ตัวอย่าง (CSV)', async () => {
      const t = await app.api.get('import.template', { import_type: type.value });
      downloadBlob(t.filename, t.content, 'text/csv;charset=utf-8');
    }, { variant: 'secondary' })),
    form([h('div', { class: 'grid3' }, field('ชนิดข้อมูล', type), field('ไฟล์', file, { required: true }))], async () => {
      const f = file.files[0];
      if (!f) throw { message_th: 'กรุณาเลือกไฟล์', field_errors: [{ field: 'file', message_th: 'กรุณาเลือกไฟล์' }] };
      if (f.size > 5 * 1024 * 1024) throw { message_th: 'ไฟล์ใหญ่เกิน 5 MB' };
      const up = await app.api.mutate('import.upload', { import_type: type.value, file: { filename: f.name, mime_type: f.type || null, content_base64: await fileToBase64(f) } });
      renderMapping(app, work, up, type.value);
      return `อัปโหลดแล้ว ${up.row_count} แถว`;
    }, { submitLabel: 'อัปโหลด' })));
  root.appendChild(work);
  const hist = h('div');
  root.appendChild(section('ประวัติการนำเข้า', hist));
  try {
    const list = await app.api.get('import.list', { limit: 20 });
    mount(hist, list.items.length ? table([{ label: 'ชนิด', render: (b) => enumLabel('ImportType', b.import_type) }, { label: 'สถานะ', render: (b) => enumLabel('ImportStatus', b.status) }, { label: 'แถว', key: 'row_count' }, { label: 'นำเข้าแล้ว', render: (b) => b.applied_count ?? '—' }, { label: 'เวลา', key: 'created_at' }], list.items) : empty());
  } catch (e) { mount(hist, errorState(e)); }
  return root;
}

function renderMapping(app, work, up, importType) {
  const selects = up.columns.map((c) => {
    const s = select(c.name, [h('option', { value: '' }, '— ไม่ใช้ —'), ...up.header.map((hd) => h('option', { value: hd, selected: up.auto_mapping[c.name] === hd }, hd))]);
    return field(`${c.label_th} (${c.name})`, s, { required: c.required });
  });
  const dateFormat = select('date_format', [h('option', { value: 'ISO' }, 'ค.ศ. YYYY-MM-DD'), h('option', { value: 'DMY_BE' }, 'วว/ดด/ปปปป (พ.ศ.)'), h('option', { value: 'DMY_CE' }, 'วว/ดด/ปปปป (ค.ศ.)')]);
  const defaultFrom = input('default_effective_from', { type: 'date' });
  const updateExisting = h('input', { type: 'checkbox', name: 'update_existing' });
  const out = h('div', { 'aria-live': 'polite' });
  const mapping = () => Object.fromEntries(up.columns.map((c, i) => [c.name, selects[i].querySelector('select').value]).filter(([, v]) => v));
  const options = () => ({ date_format: dateFormat.value, default_effective_from: defaultFrom.value || null, update_existing: updateExisting.checked });
  mount(work, section('2. จับคู่คอลัมน์และตรวจข้อมูล',
    table([{ label: 'คอลัมน์ในไฟล์', render: (x) => x }], up.header.map((x) => x)),
    h('div', { class: 'grid3' }, selects),
    h('div', { class: 'grid3' }, field('รูปแบบวันที่ในไฟล์', dateFormat), importType === 'STUDENTS' ? field('วันที่มีผลเริ่มต้น', defaultFrom) : null,
      h('label', { class: 'check' }, updateExisting, ' อัปเดตข้อมูลเดิมเมื่อรหัสตรงแต่ข้อมูลต่าง')),
    h('div', { class: 'row gap' },
      actionButton('ดูตัวอย่าง 20 แถว', async () => {
        const p = await app.api.get('import.preview', { batch_id: up.batch_id, mapping: mapping(), options: options() });
        mount(out, table([{ label: 'แถว', key: 'row_no' }, { label: 'ข้อมูล', render: (r) => JSON.stringify(r.value) }, { label: 'ข้อผิดพลาด', render: (r) => r.errors.map((e) => `${e.column}: ${e.message_th}`).join(' · ') || '✔' }], p.rows));
      }, { variant: 'secondary' }),
      actionButton('ตรวจทั้งไฟล์ (dry-run)', async () => {
        mount(out, loading('กำลังตรวจทุกแถว…'));
        try {
          const d = await app.api.mutate('import.dryRun', { batch_id: up.batch_id, mapping: mapping(), options: options() });
          renderDryRun(app, out, up, d);
        } catch (e) { mount(out, errorState(e)); }
      })),
    out));
}

function renderDryRun(app, out, up, d) {
  const s = d.summary;
  const ok = s.ERROR === 0;
  const pollBox = h('div', { 'aria-live': 'polite' });
  mount(out,
    h('div', { class: 'stats' }, ['INSERT', 'UPDATE', 'SKIP', 'CONFLICT', 'ERROR'].map((k) => h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, String(s[k])), h('div', { class: 'stat-l' }, { INSERT: 'เพิ่ม', UPDATE: 'แก้ไข', SKIP: 'ข้าม (มีแล้ว)', CONFLICT: 'ขัดแย้ง', ERROR: 'ผิดพลาด' }[k])))),
    s.warnings ? alertBox('warn', `มีคำเตือน ${s.warnings} รายการ (เช่น ชื่อซ้ำกับนักเรียนรหัสอื่น) — ตรวจสอบก่อนนำเข้า`) : null,
    d.rows.length ? table([{ label: 'แถว', key: 'row_no' }, { label: 'ผล', key: 'action' }, { label: 'รายละเอียด', render: (r) => [...r.errors, ...r.warnings].map((e) => `${e.column}: ${e.message_th}`).join(' · ') }], d.rows) : null,
    ok ? actionButton('นำเข้าจริง', async () => {
      const r = await app.api.mutate('import.apply', { batch_id: up.batch_id, accept_skipping_conflicts: s.CONFLICT > 0 });
      pollJob(app, r.job_id, pollBox);
    }, { large: true, confirmText: s.CONFLICT ? `ยืนยันนำเข้า (ข้าม ${s.CONFLICT} แถวที่ขัดแย้ง ไม่เขียนทับ)` : 'ยืนยันนำเข้าข้อมูลจริง' }) : alertBox('danger', 'ยังมีแถวผิดพลาด แก้ไฟล์แล้วอัปโหลดใหม่'),
    pollBox);
}

export function pollJob(app, jobId, box) {
  let stopped = false;
  const tick = async () => {
    if (stopped || !document.body.contains(box)) return;
    if (document.hidden) { setTimeout(tick, 5000); return; }
    try {
      const j = await app.api.get('job.getStatus', { job_id: jobId }, { channel: `job-${jobId}` });
      const p = j.progress || {};
      mount(box, h('p', null, statusBadge(j.status === 'SUCCEEDED' ? 'OK' : j.status === 'FAILED' ? 'FAIL' : 'WARN'), ` ${enumLabel('JobStatus', j.status)} ${p.message_th || ''}`),
        j.last_error ? alertBox('danger', j.last_error) : null);
      if (j.status === 'SUCCEEDED' || j.status === 'FAILED') { stopped = true; return; }
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(box, errorState(e)); }
    setTimeout(tick, 4000 + Math.random() * 1500);
  };
  tick();
}

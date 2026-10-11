// Reports (MASTER_PROMPT §12): choose a report the account may use, set filters, preview on screen
// (same numbers as the dashboard), or create CSV/XLSX/PDF files as background jobs; download re-checks
// permission every time. Official versions are locked; re-running creates a new revision.
import { h, mount } from '../lib/dom.js';
import { field, input, select, form, table, loading, empty, errorState, section, alertBox, badge, actionButton, toast, enumLabel, downloadBlob, base64ToBytes, askText } from '../ui.js';
import { todayLocal } from '../lib/dates.js';
import { formatThaiDate, formatThaiDateTime, formatThaiTime } from '../../../src/shared/thai-format.js';

function cellText(c, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatThaiDate(v);
  if (c.type === 'datetime' && /T/.test(v)) return formatThaiDateTime(v);
  if (c.type === 'time' && /T/.test(v)) return formatThaiTime(v);
  if (c.type === 'percent' && typeof v === 'number') return `${v.toFixed(1)}%`;
  return String(v);
}

async function filterControls(app, rep) {
  const controls = [];
  let classes = null;
  for (const f of rep.filters) {
    let ctl;
    if (f.type === 'date') ctl = input(f.name, { type: 'date', value: f.name === 'from' ? todayLocal(app).slice(0, 8) + '01' : todayLocal(app) });
    else if (f.type === 'class') {
      classes = classes || (await app.api.get('class.list', {})).items;
      ctl = select(f.name, [h('option', { value: '' }, 'ทุกห้อง (ตามสิทธิ์)'), ...classes.map((c) => h('option', { value: c.id }, c.name_th))]);
    } else if (f.type === 'enum' || f.type === 'select') ctl = select(f.name, [h('option', { value: '' }, f.required ? '— เลือก —' : 'ทั้งหมด'), ...(f.options || []).map((o) => h('option', { value: o.value }, o.label_th))]);
    else if (f.type === 'bool') ctl = h('input', { type: 'checkbox', name: f.name });
    else if (f.type === 'student') ctl = input(f.name, { placeholder: 'รหัส UUID ของนักเรียน (เปิดจากหน้าประวัตินักเรียน)', autocomplete: 'off' });
    else ctl = input(f.name, { autocomplete: 'off' });
    controls.push({ f, ctl });
  }
  const values = () => {
    const out = {};
    for (const { f, ctl } of controls) {
      if (f.type === 'bool') { if (ctl.checked) out[f.name] = true; } else if (ctl.value) out[f.name] = ctl.value.trim();
    }
    return out;
  };
  const nodes = h('div', { class: 'grid3' }, controls.map(({ f, ctl }) => (f.type === 'bool' ? h('label', { class: 'check' }, ctl, ` ${f.label_th}`) : field(f.label_th, ctl, { required: !!f.required }))));
  return { nodes, values };
}

function previewView(r) {
  return h('div', null,
    h('h3', null, r.title), r.subtitle ? h('p', { class: 'muted' }, r.subtitle) : null,
    h('p', { class: 'muted small' }, `ขอบเขต: ${r.meta.scope_th} · ข้อมูล ณ ${r.meta.as_of_th} · ผู้จัดทำ ${r.meta.generated_by}`),
    r.truncated ? alertBox('warn', `แสดง ${r.rows.length} จาก ${r.row_count} แถว — สร้างไฟล์เพื่อดูทั้งหมด`) : null,
    r.rows.length ? table(r.columns.map((c) => ({ label: c.label, render: (row) => cellText(c, row[c.key]) })), r.totals ? [...r.rows, { ...r.totals, __total: true }] : r.rows) : empty('ไม่มีข้อมูลตามเงื่อนไข'),
    r.notes_th.length ? h('details', { class: 'note', open: true }, h('summary', null, 'หมายเหตุและวิธีนับ'), h('ul', null, r.notes_th.map((n) => h('li', null, n)))) : null);
}

export async function renderReports(app, params) {
  const cat = await app.api.get('report.catalog', {});
  if (!cat.items.length) return alertBox('info', 'บัญชีนี้ไม่มีรายงานที่ใช้ได้');
  const root = h('div');
  const pick = select('code', cat.items.map((r) => h('option', { value: r.code }, `${r.code} ${r.title_th}`)));
  pick.value = params.code && cat.items.some((r) => r.code === params.code) ? params.code : (app.drafts.get('reports.code') || cat.items[0].code);
  const filtersBox = h('div');
  const out = h('div', { 'aria-live': 'polite' });
  const runsBox = h('div');
  let current = null;

  const loadRuns = async () => {
    if (!cat.items.some((r) => r.formats.length > 1)) return;
    try {
      const r = await app.api.get('report.runs', { limit: 20 }, { channel: 'report-runs' });
      mount(runsBox, section('ไฟล์รายงานที่สร้าง', r.items.length ? table([
        { label: 'รายงาน', render: (x) => `${x.report_code} ${x.title_th}` }, { label: 'ตัวกรอง', key: 'filter_th' }, { label: 'ไฟล์', key: 'output_format' },
        { label: 'สถานะ', render: (x) => [badge(enumLabel('ReportStatus', x.status), x.status === 'READY' ? 'ok' : x.status === 'FAILED' ? 'danger' : 'neutral'), x.locked ? [' ', badge('ล็อก (ทางการ)', 'info', '🔒')] : null] },
        { label: 'ข้อมูล ณ', render: (x) => formatThaiDateTime(x.as_of) }, { label: 'แถว', render: (x) => x.row_count ?? '—' }, { label: 'ผู้สร้าง', key: 'requested_by_name' },
        { label: '', render: (x) => h('div', { class: 'row-actions' },
          ['READY', 'SUPERSEDED'].includes(x.status) ? actionButton('ดาวน์โหลด', async () => {
            try { const f = await app.api.get('report.download', { run_id: x.id }); downloadBlob(f.filename, base64ToBytes(f.content_base64), f.mime_type); } catch (e) { toast(e.message_th || 'ดาวน์โหลดไม่สำเร็จ', 'danger'); }
          }, { variant: 'secondary' }) : null,
          cat.can_lock && x.status === 'READY' && !x.locked ? actionButton('ล็อกเป็นฉบับทางการ', async () => {
            const note = await askText('หมายเหตุ (เช่น ส่งฝ่ายบริหาร)');
            try { await app.api.mutate('report.lock', { run_id: x.id, note }, { expectedVersion: x.version }); toast('ล็อกแล้ว'); loadRuns(); } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
          }, { variant: 'secondary' }) : null,
          ['READY', 'SUPERSEDED', 'FAILED'].includes(x.status) ? actionButton('สร้างฉบับใหม่', async () => {
            try { await app.api.mutate('report.rerun', { run_id: x.id }); toast('เข้าคิวสร้างฉบับใหม่แล้ว'); setTimeout(loadRuns, 1500); } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
          }, { variant: 'secondary' }) : null) },
      ], r.items) : empty('ยังไม่มีไฟล์รายงาน')));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(runsBox, errorState(e)); }
  };

  const build = async () => {
    const rep = cat.items.find((r) => r.code === pick.value);
    app.drafts.set('reports.code', rep.code);
    current = await filterControls(app, rep);
    const formats = rep.formats.filter((f) => f !== 'JSON');
    mount(filtersBox, form([current.nodes], async () => {
      mount(out, loading('กำลังคำนวณ…'));
      try { mount(out, previewView(await app.api.get('report.preview', { code: rep.code, filter: current.values() }, { channel: 'report-preview' }))); } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(out, errorState(e)); }
      return false;
    }, { submitLabel: 'แสดงบนจอ' }),
    formats.length ? h('div', { class: 'row-actions' }, formats.map((fmt) => actionButton(`สร้างไฟล์ ${fmt}`, async () => {
      try {
        await app.api.mutate('report.run', { code: rep.code, filter: current.values(), format: fmt });
        toast(`เข้าคิวสร้าง ${fmt} แล้ว — รายการจะพร้อมใน "ไฟล์รายงานที่สร้าง"`);
        setTimeout(loadRuns, 1500);
      } catch (e) { toast(e.message_th || 'สร้างไม่สำเร็จ', 'danger'); }
    }, { variant: 'secondary' }))) : alertBox('info', 'บัญชีนี้ดูรายงานบนจอได้ แต่ไม่มีสิทธิ์ส่งออกไฟล์'),
    h('p', { class: 'muted small' }, `จำกัดแถว: บนจอ ${cat.row_limits.JSON} · PDF ${cat.row_limits.PDF.toLocaleString('en-US')} · XLSX ${cat.row_limits.XLSX.toLocaleString('en-US')} · CSV ${cat.row_limits.CSV.toLocaleString('en-US')} — CSV/XLSX ใช้วันที่ ค.ศ. (YYYY-MM-DD) เพื่อคำนวณต่อ ส่วน PDF แสดง พ.ศ.`));
    mount(out, '');
  };
  pick.addEventListener('change', build);
  root.append(field('รายงาน', pick), filtersBox, out, runsBox);
  await build();
  loadRuns();
  return root;
}

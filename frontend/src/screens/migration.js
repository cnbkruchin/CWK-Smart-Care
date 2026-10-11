// Migration Center (MASTER_PROMPT §15.1): data inventory, portable export (full snapshot / rehearsal /
// partial), progress with pause/resume/cancel, validation and evidence from the import target,
// readiness checklist, cutover and rollback. Imports always run in a NEW environment
// (adminImportPackage in a new Apps Script project, or tools/migrate.mjs for PostgreSQL) — never here.
import { h, mount } from '../lib/dom.js';
import { field, input, select, textarea, table, loading, errorState, section, alertBox, badge, actionButton, toast, enumLabel, downloadBlob, askText, confirmDialog } from '../ui.js';
import { formatThaiDateTime } from '../../../src/shared/thai-format.js';

const STATE_KIND = { EXPORTED: 'info', VALIDATED: 'info', STAGED: 'info', RECONCILED: 'ok', CUTOVER_READY: 'ok', ACTIVE: 'ok', FAILED: 'danger', CANCELLED: 'neutral', ROLLED_BACK: 'warn' };
const POLICY_TH = { EXPORTED: 'ส่งออก', TRANSIENT: 'ไม่ส่งออก (ชั่วคราว)', ENVIRONMENT: 'ไม่ส่งออก (เฉพาะ environment)' };
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function progressText(job) {
  if (!job || !job.progress) return job ? enumLabel('JobStatus', job.status) : '—';
  const p = job.progress;
  const phase = { PREPARE: 'เตรียม', TABLES: 'ส่งออกตาราง', ATTACHMENTS: 'คัดลอกไฟล์แนบ', FINALIZE: 'สรุป manifest', VERIFY: 'ตรวจซ้ำ', DONE: 'เสร็จ', VALIDATE: 'ตรวจ package' }[p.phase] || p.phase;
  return `${phase}${p.tables_total ? ` · ตาราง ${p.tables_done}/${p.tables_total}` : ''}${p.rows ? ` · ${p.rows.toLocaleString('th-TH')} รายการ` : ''}${p.attachments ? ` · ไฟล์ ${p.attachments}` : ''}${job.status === 'PAUSED' ? ' · หยุดชั่วคราว' : ''}`;
}

export async function renderMigration(app) {
  const root = h('div');
  const statusBox = h('div');
  const invBox = h('div');
  const startBox = h('div');
  const runsBox = h('div', { 'aria-live': 'polite' });
  const detailBox = h('div');
  let timer = null;

  const loadRuns = async () => {
    clearTimeout(timer);
    let r;
    try { r = await app.api.get('migration.runs', { limit: 20 }, { channel: 'migration-runs' }); } catch (e) { mount(runsBox, errorState(e, loadRuns)); return; }
    mount(statusBox, h('div', null,
      r.system_mode === 'READ_ONLY' ? alertBox('warn', 'ระบบอยู่ในโหมดอ่านอย่างเดียว (freeze) — ผู้ใช้บันทึกข้อมูลไม่ได้') : alertBox('info', 'ระบบเปิดใช้งานตามปกติ — การส่งออกภาพรวมทั้งระบบต้องเปิดโหมดอ่านอย่างเดียวก่อน (หน้าสถานะระบบ)'),
      r.cutover_active && r.cutover_active.run_id && !r.cutover_active.cleared_at ? alertBox('danger', `ระบบนี้ถูกสลับไประบบใหม่แล้ว (${formatThaiDateTime(r.cutover_active.at)}) — เป็น archive อ่านอย่างเดียว`) : null));
    mount(runsBox, section('งานส่งออกและย้ายข้อมูล', r.items.length ? table([
      { label: 'เริ่ม', render: (x) => formatThaiDateTime(x.started_at) },
      { label: 'โหมด', render: (x) => enumLabel('MigrationMode', x.mode) },
      { label: 'สถานะ', render: (x) => badge(enumLabel('MigrationState', x.state), STATE_KIND[x.state] || 'neutral') },
      { label: 'ความครบถ้วน', render: (x) => (x.completeness ? badge(enumLabel('Completeness', x.completeness), x.completeness === 'COMPLETE' ? 'ok' : x.completeness === 'FAILED' ? 'danger' : 'warn') : '—') },
      { label: 'ความคืบหน้า', render: (x) => progressText(x.job) },
      { label: '', render: (x) => h('div', { class: 'row-actions' },
        actionButton('รายละเอียด', () => showDetail(x.id), { variant: 'secondary' }),
        ['PLANNED', 'SNAPSHOTTING'].includes(x.state) && x.job && x.job.status !== 'PAUSED' ? actionButton('หยุดชั่วคราว', () => act('migration.pause', { run_id: x.id }, 'สั่งหยุดแล้ว (หยุดหลังชุดข้อมูลปัจจุบัน)'), { variant: 'secondary' }) : null,
        ['PLANNED', 'SNAPSHOTTING'].includes(x.state) && x.job && ['PAUSED', 'FAILED'].includes(x.job.status) ? actionButton('ทำต่อ', () => act('migration.resume', { run_id: x.id }, 'ทำต่อจาก checkpoint ล่าสุด'), { variant: 'secondary' }) : null,
        x.allowed_actions.includes('CANCEL') ? actionButton('ยกเลิก', async () => { const reason = await askText('เหตุผลที่ยกเลิก'); if (reason) act('migration.cancel', { run_id: x.id, reason }, 'ยกเลิกแล้ว'); }, { variant: 'secondary' }) : null) },
    ], r.items) : h('p', { class: 'muted' }, 'ยังไม่มีงานส่งออก')));
    if (r.items.some((x) => x.job && ['QUEUED', 'RUNNING'].includes(x.job.status)) && document.body.contains(runsBox)) timer = setTimeout(loadRuns, 10000);
  };

  async function act(op, payload, okText, opts = {}) {
    try {
      const res = await app.api.mutate(op, payload, opts);
      toast(okText);
      await loadRuns();
      if (payload.run_id) showDetail(payload.run_id);
      return res;
    } catch (e) {
      toast(e.message_th || 'ไม่สำเร็จ', 'danger');
      return null;
    }
  }

  async function showDetail(id) {
    mount(detailBox, loading());
    let d;
    try { d = await app.api.get('migration.get', { run_id: id }); } catch (e) { mount(detailBox, errorState(e, () => showDetail(id))); return; }
    const r = d.run;
    const can = (a) => r.allowed_actions.includes(a);
    const checks = d.checklist.map((i) => ({ ...i, box: h('input', { type: 'checkbox', checked: i.done }) }));
    const evidence = (title, x) => (x ? h('li', null, `${title}: `, badge(x.ok === false || x.overall === 'FAIL' ? 'ไม่ผ่าน' : 'ผ่าน', x.ok === false || x.overall === 'FAIL' ? 'danger' : 'ok'),
      ` ${x.level ? `(${x.level})` : ''} ${x.target ? `ปลายทาง ${x.target}` : ''} ${x.at ? formatThaiDateTime(x.at) : ''}${x.manifest_matches === false ? ' — ไม่ตรงกับ package นี้' : ''}${x.failed_checks && x.failed_checks.length ? ` — ไม่ผ่าน: ${x.failed_checks.join(', ')}` : ''}`) : h('li', { class: 'muted' }, `${title}: ยังไม่มี`));
    mount(detailBox, section(`รายละเอียดงาน ${enumLabel('MigrationMode', r.mode)} · ${enumLabel('MigrationState', r.state)}`,
      h('dl', { class: 'kv' },
        h('dt', null, 'package'), h('dd', null, r.package_location || '—'),
        h('dt', null, 'manifest SHA-256'), h('dd', { class: 'mono' }, r.manifest_sha256 || '—'),
        h('dt', null, 'high-water mark'), h('dd', null, r.high_water_mark ?? '—'),
        h('dt', null, 'จำนวนรายการ'), h('dd', null, r.summary.total_rows ? `${r.summary.total_rows.toLocaleString('th-TH')} รายการ · ${r.summary.chunks} ชุด · ไฟล์แนบ ${r.summary.attachments ? r.summary.attachments.files : 0}` : '—'),
        h('dt', null, 'เหตุผลความไม่ครบ'), h('dd', null, (r.summary.completeness_reasons || []).join(', ') || '—'),
        h('dt', null, 'ใช้สลับระบบได้'), h('dd', null, r.summary.usable_for_cutover ? badge('ได้ (FULL_SNAPSHOT ครบถ้วน)', 'ok') : badge('ไม่ได้', 'warn'))),
      r.job && r.job.last_error ? alertBox('warn', `งานเบื้องหลัง: ${r.job.last_error}`) : null,
      h('h4', null, 'หลักฐาน'),
      h('ul', null, evidence('ตรวจ package', d.validation), evidence('นำเข้าปลายทาง', d.import_report), evidence('กระทบยอด', d.reconciliation)),
      d.validation_errors.length ? h('details', null, h('summary', null, `ข้อผิดพลาดจากการตรวจ (${d.validation_errors.length})`), h('ul', null, d.validation_errors.map((e) => h('li', { class: 'mono small' }, `${e.code} ${e.table || ''} ${e.path || ''} ${e.id || ''}`)))) : null,
      d.reconciliation_checks.length ? table([{ label: 'หัวข้อ', key: 'key' }, { label: 'ผล', render: (c) => badge(c.status, c.status === 'PASS' ? 'ok' : c.status === 'FAIL' ? 'danger' : 'neutral') }, { label: 'รายละเอียด', key: 'detail_th' }], d.reconciliation_checks, { caption: 'ผลกระทบยอด' }) : null,
      h('p', { class: 'muted small' }, 'นำเข้าปลายทาง: Apps Script โปรเจกต์ใหม่ → adminImportPackage, PostgreSQL → node tools/migrate.mjs (ดู MIGRATION_RUNBOOK_TH) แล้ววางรายงาน import.json / reconciliation.json ในโฟลเดอร์ reports/ ของ package'),
      h('div', { class: 'row-actions' },
        r.manifest_sha256 ? actionButton('คู่มือรูปแบบ package', () => doc(r.id, 'PORTABLE_FORMAT.md'), { variant: 'secondary' }) : null,
        r.manifest_sha256 ? actionButton('คู่มือย้ายระบบ (RUNBOOK)', () => doc(r.id, 'MIGRATION_RUNBOOK_TH.md'), { variant: 'secondary' }) : null,
        can('VALIDATE') ? actionButton('ตรวจ package', () => act('migration.validate', { run_id: r.id }, 'เริ่มตรวจ package (งานเบื้องหลัง)')) : null,
        can('STAGE') ? actionButton('บันทึกผลนำเข้าปลายทาง', () => act('migration.recordEvidence', { run_id: r.id, kind: 'IMPORT' }, 'บันทึกผลนำเข้าแล้ว')) : null,
        ['STAGED'].includes(r.state) ? actionButton('บันทึกผลกระทบยอด', () => act('migration.recordEvidence', { run_id: r.id, kind: 'RECONCILIATION' }, 'บันทึกผลกระทบยอดแล้ว')) : null,
        can('MARK_READY') ? actionButton('ยืนยันพร้อมสลับระบบ', () => act('migration.markReady', { run_id: r.id }, 'พร้อมสลับระบบ')) : null),
      ['VALIDATED', 'STAGED', 'RECONCILED', 'CUTOVER_READY'].includes(r.state) ? h('div', null,
        h('h4', null, 'Readiness checklist'),
        h('div', { class: 'checklist' }, checks.map((c) => h('label', { class: 'check' }, c.box, ` ${c.label_th}`))),
        actionButton('บันทึก checklist', () => act('migration.checklist', { run_id: r.id, items: Object.fromEntries(checks.map((c) => [c.key, c.box.checked])) }, 'บันทึกแล้ว'), { variant: 'secondary' })) : null,
      can('CUTOVER') ? h('div', { class: 'danger-zone' },
        h('h4', null, 'สลับระบบ (cutover)'),
        h('p', null, 'ระบบนี้จะกลายเป็น archive อ่านอย่างเดียวถาวร ห้ามเขียนสองระบบพร้อมกัน — เปลี่ยน routing ผู้ใช้ไประบบใหม่ตาม RUNBOOK'),
        actionButton('สลับระบบ', async () => {
          const reason = await askText('เหตุผล / เลขที่บันทึกอนุมัติ');
          if (!reason) return;
          const typed = await askText('พิมพ์ CUTOVER เพื่อยืนยัน', { label: 'ยืนยัน' });
          if (typed !== 'CUTOVER') { toast('ยกเลิก — ข้อความยืนยันไม่ตรง', 'danger'); return; }
          act('migration.cutover', { run_id: r.id, reason, confirm: 'CUTOVER' }, 'สลับระบบแล้ว');
        }, { variant: 'danger' })) : null,
      can('ROLLBACK') ? rollbackForm(r) : null));
  }

  function rollbackForm(r) {
    const kase = select('case', [h('option', { value: 'NO_NEW_DATA' }, 'ยังไม่มีข้อมูลใหม่ในระบบใหม่'), h('option', { value: 'NEW_DATA_RETURNED' }, 'มีข้อมูลใหม่ และนำ delta กลับมาแล้ว (adminApplyDelta)')]);
    const loc = input('delta_location', { placeholder: 'id โฟลเดอร์ delta package', autocomplete: 'off' });
    const reason = textarea('reason', { rows: 2 });
    return h('div', { class: 'danger-zone' }, h('h4', null, 'ย้อนกลับ (rollback)'),
      h('p', { class: 'small' }, 'ห้ามเปิดระบบเดิมจาก backup เก่าแล้วทิ้งข้อมูลใหม่ — ถ้ามีข้อมูลใหม่ต้องนำ delta กลับก่อน'),
      field('กรณี', kase), field('ตำแหน่ง delta (กรณีมีข้อมูลใหม่)', loc), field('เหตุผล', reason, { required: true }),
      actionButton('บันทึกการย้อนกลับ', async () => {
        if (!(await confirmDialog('บันทึกการย้อนกลับมาใช้ระบบนี้?'))) return;
        act('migration.rollback', { run_id: r.id, case: kase.value, reason: reason.value.trim(), delta_location: loc.value.trim() || null }, 'บันทึกการย้อนกลับแล้ว — ตรวจข้อมูลแล้วจึงปิดโหมดอ่านอย่างเดียว');
      }, { variant: 'danger' }));
  }

  async function doc(runId, name) {
    try { const f = await app.api.get('migration.packageDoc', { run_id: runId, name }); downloadBlob(f.filename, f.text, f.mime_type); } catch (e) { toast(e.message_th || 'ดาวน์โหลดไม่สำเร็จ', 'danger'); }
  }

  const loadInventory = async () => {
    mount(invBox, loading());
    try {
      const inv = await app.api.get('migration.inventory', {});
      mount(invBox, section('ข้อมูลในระบบ (inventory)',
        h('p', null, `schema v${inv.schema_version} · แอป ${inv.app_version} · ไฟล์แนบ ${inv.attachments.files} ไฟล์ (${fmtBytes(inv.attachments.bytes)}) · ขนาดประมาณ ${fmtBytes(inv.estimated_total_bytes)} · ภาคเรียน ${inv.terms.map((t) => t.code).join(', ') || '—'}`),
        table([
          { label: 'ตาราง', key: 'table' }, { label: 'กลุ่ม', key: 'group' }, { label: 'รายการ', render: (t) => t.rows.toLocaleString('th-TH') },
          { label: 'partition', render: (t) => (t.partition_mode === 'TERM' ? t.partitions.map((p) => `${p.key}: ${p.rows}`).join(', ') : '—') },
          { label: 'ความอ่อนไหว', key: 'sensitivity' }, { label: 'การส่งออก', render: (t) => `${POLICY_TH[t.export] || t.export}${t.live ? ' · บันทึกงาน' : ''}` },
        ], inv.tables)));
      return inv;
    } catch (e) { mount(invBox, errorState(e, loadInventory)); return null; }
  };

  const mode = select('mode', [h('option', { value: 'REHEARSAL' }, 'ซ้อมย้าย (REHEARSAL)'), h('option', { value: 'FULL_SNAPSHOT' }, 'ภาพรวมสุดท้ายเพื่อสลับระบบ (FULL_SNAPSHOT)'), h('option', { value: 'PARTIAL' }, 'บางตาราง (PARTIAL — ใช้ย้ายระบบไม่ได้)')]);
  const tables = input('tables', { placeholder: 'เฉพาะ PARTIAL: ชื่อตารางคั่นด้วย , เช่น Students,Enrollments', autocomplete: 'off' });
  const att = h('input', { type: 'checkbox', name: 'include_attachments', checked: true });
  const reason = input('reason', { placeholder: 'เช่น ซ้อมย้ายไป PostgreSQL ครั้งที่ 1', autocomplete: 'off' });
  mount(startBox, section('เริ่มส่งออก portable package',
    h('p', { class: 'small muted' }, 'ส่งออกเป็นงานเบื้องหลังแบบแบ่งชุดพร้อม checkpoint ไปยังโฟลเดอร์ส่วนตัวใน Google Drive (ไม่แชร์) — ไม่มีรหัสลับ ไม่ส่งข้อความซ้ำที่ปลายทาง; รายงานเพื่อการใช้งานทั่วไปให้ใช้หน้า "รายงาน"'),
    field('โหมด', mode), field('ตาราง (PARTIAL)', tables), h('label', { class: 'check' }, att, ' รวมไฟล์แนบ (bytes จริง + SHA-256)'), field('เหตุผล', reason, { required: true }),
    actionButton('เริ่มส่งออก', async () => {
      const payload = { mode: mode.value, include_attachments: att.checked, reason: reason.value.trim() };
      if (mode.value === 'PARTIAL') payload.tables = tables.value.split(',').map((x) => x.trim()).filter(Boolean);
      const res = await act('migration.startExport', payload, 'เริ่มส่งออกแล้ว — ติดตามความคืบหน้าในตารางด้านล่าง');
      if (res && res.missing_dependencies && res.missing_dependencies.length) toast(`ส่งออกบางส่วน: ขาดตารางที่อ้างอิง ${res.missing_dependencies.length} รายการ`, 'warn');
    })));

  mount(root, h('div', null,
    statusBox,
    h('div', { class: 'row-actions' }, actionButton('โหลด inventory', loadInventory, { variant: 'secondary' }), actionButton('รีเฟรช', loadRuns, { variant: 'secondary' })),
    invBox, startBox, runsBox, detailBox));
  await loadRuns();
  return root;
}

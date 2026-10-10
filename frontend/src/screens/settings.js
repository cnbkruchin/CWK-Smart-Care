// Settings: school, academic years/terms, calendar, periods, stations, versioned rules, business settings.
// Deployment configuration and secrets are NOT shown or editable here (Script Properties only).
import { h } from '../lib/dom.js';
import { field, input, select, textarea, form, table, empty, section, enumLabel, enumOptions, actionButton, alertBox, badge, toast, askText } from '../ui.js';
import { formatThaiDate } from '../../../src/shared/thai-format.js';

export async function renderSettings(app) {
  const o = await app.api.get('settings.overview', {});
  const canEdit = app.can('settings.business');
  const root = h('div');
  root.appendChild(alertBox('info', 'ค่าในหน้านี้เป็นค่าธุรกิจที่ไม่ลับ ค่าติดตั้ง/รหัสลับตั้งใน Script Properties ของ Apps Script เท่านั้น'));

  const s = o.school;
  if (s) {
    const name = input('name_th', { value: s.name_th });
    const unit = input('unit_th', { value: s.unit_th || '' });
    const color = input('brand_color', { value: s.brand_color || '#B91C1C', type: 'color' });
    root.appendChild(section('โรงเรียน', canEdit ? form([h('div', { class: 'grid3' }, field('ชื่อโรงเรียน', name, { required: true }), field('หน่วยงาน', unit), field('สีหลัก (ตัวอย่าง ปรับได้)', color))], async () => {
      await app.api.mutate('school.update', { name_th: name.value, unit_th: unit.value || null, brand_color: color.value }, { expectedVersion: s.version });
      return 'บันทึกแล้ว';
    }) : h('p', null, s.name_th)));
  }

  root.appendChild(section('ปีการศึกษาและภาคเรียน',
    o.academic_years.length ? table([{ label: 'ปีการศึกษา', key: 'label_th' }, { label: 'เริ่ม', render: (y) => formatThaiDate(y.start_date) }, { label: 'สิ้นสุด (ไม่รวม)', render: (y) => formatThaiDate(y.end_date) }], o.academic_years) : empty('ยังไม่มีปีการศึกษา'),
    o.terms.length ? table([{ label: 'ภาคเรียน', key: 'code' }, { label: 'เริ่ม', render: (t) => formatThaiDate(t.start_date) }, { label: 'สิ้นสุด (ไม่รวม)', render: (t) => formatThaiDate(t.end_date) }], o.terms) : empty('ยังไม่มีภาคเรียน — ข้อมูลรายวันจะถูกเก็บใน partition ชั่วคราว'),
    canEdit ? yearTermForms(app, o) : null));

  root.appendChild(section('ปฏิทิน (วันหยุด/วันพิเศษ)', alertBox('info', 'ค่าเริ่มต้น: จันทร์–ศุกร์ในภาคเรียนเป็นวันเรียน กำหนดเฉพาะวันที่ต่างจากค่าเริ่มต้น'),
    o.calendar.length ? table([{ label: 'วันที่', render: (c) => formatThaiDate(c.calendar_date) }, { label: 'ประเภท', render: (c) => enumLabel('DayType', c.day_type) }, { label: 'ระดับ', render: (c) => (c.applies_to_level ? enumLabel('GradeLevel', c.applies_to_level) : 'ทุกระดับ') }, { label: 'รายการ', render: (c) => c.title_th || '—' }], o.calendar.slice(0, 60)) : empty(),
    canEdit ? (() => {
      const d = input('calendar_date', { type: 'date' });
      const t = select('day_type', enumOptions('DayType'));
      const lv = select('applies_to_level', enumOptions('GradeLevel', { empty: 'ทุกระดับ' }));
      const title = input('title_th');
      return form([h('div', { class: 'grid3' }, field('วันที่', d, { required: true }), field('ประเภท', t), field('ระดับชั้น', lv), field('รายการ', title))], async () => {
        await app.api.mutate('calendar.set', { calendar_date: d.value, day_type: t.value, applies_to_level: lv.value || null, title_th: title.value || null });
        app.render(); return false;
      }, { submitLabel: 'บันทึกวัน' });
    })() : null));

  root.appendChild(section('คาบเรียน', o.periods.length ? table([{ label: 'คาบ', key: 'period_no' }, { label: 'ช่วง', render: (p) => enumLabel('DaySession', p.session) }, { label: 'เวลา', render: (p) => `${p.start_time}–${p.end_time}` }, { label: 'มีผลตั้งแต่', render: (p) => formatThaiDate(p.effective_from) }], o.periods) : empty('ยังไม่ได้ตั้งคาบเรียน (จำเป็นสำหรับการลาครึ่งวัน/รายคาบ)'),
    canEdit ? (() => {
      const no = input('period_no', { type: 'number', min: 0, max: 20 });
      const label = input('label_th');
      const ses = select('session', enumOptions('DaySession'));
      const st = input('start_time', { type: 'time' });
      const en = input('end_time', { type: 'time' });
      const from = input('effective_from', { type: 'date' });
      return form([h('div', { class: 'grid3' }, field('คาบที่', no, { required: true }), field('ชื่อ', label, { required: true }), field('ช่วง', ses), field('เริ่ม', st, { required: true }), field('สิ้นสุด', en, { required: true }), field('มีผลตั้งแต่', from, { required: true }))], async () => {
        await app.api.mutate('period.create', { period_no: Number(no.value), label_th: label.value, session: ses.value, start_time: st.value, end_time: en.value, effective_from: from.value });
        app.render(); return false;
      }, { submitLabel: 'เพิ่มคาบ' });
    })() : null));

  root.appendChild(section('จุดลงเวลา', o.stations.length ? table([{ label: 'รหัส', key: 'code' }, { label: 'ชื่อ', key: 'name_th' }, { label: 'ประเภท', render: (s2) => enumLabel('StationType', s2.station_type) }], o.stations) : empty(),
    canEdit ? (() => {
      const code = input('code');
      const nm = input('name_th');
      const tp = select('station_type', enumOptions('StationType'));
      return form([h('div', { class: 'grid3' }, field('รหัส', code, { required: true }), field('ชื่อ', nm, { required: true }), field('ประเภท', tp))], async () => {
        await app.api.mutate('station.create', { code: code.value, name_th: nm.value, station_type: tp.value }); app.render(); return false;
      }, { submitLabel: 'เพิ่มจุดลงเวลา' });
    })() : null));

  root.appendChild(section('กฎธุรกิจ (มีเวอร์ชันและวันที่มีผล)',
    alertBox('warn', 'กฎที่ติดป้าย "ค่าตัวอย่าง" ยังไม่ใช่เกณฑ์ของโรงเรียน ต้องสร้างเวอร์ชันใหม่ด้วยค่าที่โรงเรียนอนุมัติก่อนเปิดใช้งานจริง'),
    table([
      { label: 'กฎ', render: (r) => enumLabel('RuleType', r.rule_type) }, { label: 'v', key: 'version_no' },
      { label: 'สถานะ', render: (r) => h('span', null, enumLabel('RuleStatus', r.status), ' ', r.is_example ? badge('ค่าตัวอย่าง', 'warn', '⚠') : '') },
      { label: 'มีผล', render: (r) => `${formatThaiDate(r.effective_from)} – ${r.effective_to ? formatThaiDate(r.effective_to) : 'ไม่กำหนด'}` },
      { label: 'ค่า', render: (r) => h('code', { class: 'small' }, JSON.stringify(r.params_json)) },
      { label: '', render: (r) => (canEdit && r.status === 'DRAFT' ? actionButton('เปิดใช้', async () => {
        await app.api.mutate('rule.activate', { rule_id: r.id, confirm_school_policy: true }, { expectedVersion: r.version }); toast('เปิดใช้แล้ว'); app.render();
      }, { variant: 'secondary', confirmText: 'ยืนยันว่าค่าในกฎนี้เป็นเกณฑ์ที่โรงเรียนกำหนดแล้ว และไม่ซ้อนกับเวอร์ชันที่ใช้งาน' }) : canEdit && r.status === 'ACTIVE' ? actionButton('กำหนดวันสิ้นสุด', async () => {
        const d = await askText('วันสิ้นสุดของกฎ (ไม่รวมวันนั้น)', { label: 'วันที่ ค.ศ. YYYY-MM-DD' });
        if (!d) return;
        await app.api.mutate('rule.setEnd', { rule_id: r.id, effective_to: d, reason: 'เปลี่ยนเป็นเวอร์ชันใหม่' }, { expectedVersion: r.version }); app.render();
      }, { variant: 'link' }) : '') },
    ], o.rules),
    canEdit ? (() => {
      const type = select('rule_type', enumOptions('RuleType'));
      const from = input('effective_from', { type: 'date' });
      const params = textarea('params_json', { rows: 6, spellcheck: false });
      const fill = () => { const ex = o.rules.find((r) => r.rule_type === type.value); params.value = JSON.stringify(ex ? ex.params_json : {}, null, 2); };
      type.addEventListener('change', fill);
      fill();
      return form([h('div', { class: 'grid3' }, field('ประเภทกฎ', type), field('มีผลตั้งแต่', from, { required: true })), field('พารามิเตอร์ (JSON ตาม schema)', params, { required: true })], async () => {
        let parsed;
        try { parsed = JSON.parse(params.value); } catch (_) { throw { message_th: 'JSON ไม่ถูกต้อง', field_errors: [{ field: 'params_json', message_th: 'JSON ไม่ถูกต้อง' }] }; }
        await app.api.mutate('rule.createVersion', { rule_type: type.value, effective_from: from.value, params_json: parsed });
        app.render(); return false;
      }, { submitLabel: 'สร้างเวอร์ชันใหม่ (ร่าง)' });
    })() : null));

  root.appendChild(section('ค่าตั้งค่าอื่น', table([{ label: 'key', key: 'key' }, { label: 'ค่า', render: (x) => h('code', null, JSON.stringify(x.value_json && 'value' in x.value_json ? x.value_json.value : x.value_json)) }, { label: '', render: (x) => (x.is_example ? badge('ค่าตัวอย่าง', 'warn') : '') }, { label: 'คำอธิบาย', render: (x) => x.description_th || '' }], o.settings)));
  return root;
}

function yearTermForms(app, o) {
  const y = input('start_year_ce', { type: 'number', min: 2000, max: 2200, placeholder: 'เช่น 2026 (= พ.ศ. 2569)' });
  const ys = input('start_date', { type: 'date' });
  const ye = input('end_date', { type: 'date' });
  const yearSel = select('academic_year_id', o.academic_years.map((a) => h('option', { value: a.id }, a.label_th)));
  const no = select('term_no', [1, 2, 3].map((n) => h('option', { value: n }, `ภาคเรียนที่ ${n}`)));
  const ts = input('t_start', { type: 'date' });
  const te = input('t_end', { type: 'date' });
  const out = h('div', null,
    form([h('div', { class: 'grid3' }, field('ปี ค.ศ. ที่เริ่ม', y, { required: true }), field('วันเริ่ม', ys, { required: true }), field('วันสิ้นสุด (ไม่รวม)', ye, { required: true }))], async () => {
      await app.api.mutate('academicYear.create', { start_year_ce: Number(y.value), start_date: ys.value, end_date: ye.value }); app.render(); return false;
    }, { submitLabel: 'สร้างปีการศึกษา' }));
  if (o.academic_years.length) {
    out.appendChild(form([h('div', { class: 'grid3' }, field('ปีการศึกษา', yearSel), field('ภาคเรียน', no), field('วันเริ่ม', ts, { required: true }), field('วันสิ้นสุด (ไม่รวม)', te, { required: true }))], async () => {
      await app.api.mutate('term.create', { academic_year_id: yearSel.value, term_no: Number(no.value), start_date: ts.value, end_date: te.value }); app.render(); return false;
    }, { submitLabel: 'สร้างภาคเรียน (สร้างไฟล์ข้อมูลภาคเรียนให้อัตโนมัติ)' }));
  }
  return out;
}

// Student Directory: server-side scoped search + pagination; add student (student.manage).
import { h, mount } from '../lib/dom.js';
import { field, input, select, form, table, loading, empty, errorState, pager, section, enumLabel, enumOptions, alertBox } from '../ui.js';

export async function renderStudents(app, params) {
  const root = h('div');
  const results = h('div', { 'aria-live': 'polite' });
  if (app.can('student.search')) {
    const classes = (await app.api.get('class.list', {})).items;
    const draft = app.drafts.get('students.search') || {};
    const q = input('q', { value: draft.q || params.q || '', placeholder: 'รหัสหรือชื่อ', autocomplete: 'off' });
    const cls = select('class_id', [h('option', { value: '' }, 'ทุกห้อง (ตามสิทธิ์)'), ...classes.map((c) => h('option', { value: c.id, selected: c.id === draft.class_id }, c.name_th))]);
    const status = select('status', enumOptions('StudentStatus', { empty: 'ทุกสถานะ' }));
    let rows = [];
    const run = async (cursor = null) => {
      app.drafts.set('students.search', { q: q.value, class_id: cls.value });
      if (!cursor) { rows = []; mount(results, loading()); }
      try {
        const r = await app.api.get('student.search', { q: q.value || null, class_id: cls.value || null, status: status.value || null, cursor, limit: 30 }, { channel: 'student-search' });
        rows = rows.concat(r.items);
        mount(results, rows.length ? table([
          { label: 'รหัส', key: 'student_code' }, { label: 'ชื่อ-สกุล', render: (s) => `${s.prefix_th || ''}${s.first_name_th} ${s.last_name_th}` },
          { label: 'ห้อง', key: 'class_name_th' }, { label: 'สถานะ', render: (s) => enumLabel('StudentStatus', s.status) },
        ], rows, { onRow: (s) => app.go('profile', { id: s.id }) }) : empty('ไม่พบนักเรียนตามเงื่อนไข'), pager(r.next_cursor, run));
      } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(results, errorState(e, () => run())); }
    };
    root.appendChild(form([h('div', { class: 'grid3' }, field('ค้นหา', q), field('ห้อง', cls), field('สถานะ', status))], async () => { await run(); return false; }, { submitLabel: 'ค้นหา' }));
    root.appendChild(results);
    run();
  } else {
    const mine = await app.api.get('student.listMine', {});
    root.appendChild(mine.items.length ? table([
      { label: 'รหัส', key: 'student_code' }, { label: 'ชื่อ-สกุล', render: (s) => `${s.prefix_th || ''}${s.first_name_th} ${s.last_name_th}` }, { label: 'ห้อง', key: 'class_name_th' },
    ], mine.items, { onRow: (s) => app.go('profile', { id: s.id }) }) : empty('ยังไม่มีนักเรียนที่เชื่อมกับบัญชีนี้ (โรงเรียนต้องยืนยันความสัมพันธ์ก่อน)'));
  }
  if (app.can('student.manage')) root.appendChild(await addStudentForm(app));
  return root;
}

async function addStudentForm(app) {
  const classes = (await app.api.get('class.list', {})).items;
  const f = {
    student_code: input('student_code', { inputmode: 'numeric', autocomplete: 'off' }), prefix_th: input('prefix_th'), first_name_th: input('first_name_th'), last_name_th: input('last_name_th'),
    nickname: input('nickname'), gender: select('gender', enumOptions('Gender', { empty: '—' })), birth_date: input('birth_date', { type: 'date' }),
    class_id: select('class_id', classes.map((c) => h('option', { value: c.id }, c.name_th))), effective_from: input('effective_from', { type: 'date' }), roll_no: input('roll_no', { type: 'number', min: 1, max: 200 }),
  };
  return section('เพิ่มนักเรียนรายคน',
    alertBox('info', 'นำเข้าจำนวนมากใช้ศูนย์นำเข้าข้อมูล (CSV/XLSX) พร้อม dry-run'),
    form([h('div', { class: 'grid3' },
      field('รหัสนักเรียน', f.student_code, { required: true, hint: 'เก็บเป็นข้อความ เลข 0 นำหน้าไม่หาย' }), field('คำนำหน้า', f.prefix_th), field('ชื่อ', f.first_name_th, { required: true }),
      field('นามสกุล', f.last_name_th, { required: true }), field('ชื่อเล่น', f.nickname), field('เพศ', f.gender), field('วันเกิด (ไม่บังคับ)', f.birth_date),
      field('ห้อง', f.class_id, { required: true }), field('วันที่มีผล', f.effective_from, { required: true }), field('เลขที่', f.roll_no))],
    async () => {
      const r = await app.api.mutate('student.create', {
        student_code: f.student_code.value.trim(), prefix_th: f.prefix_th.value || null, first_name_th: f.first_name_th.value, last_name_th: f.last_name_th.value,
        nickname: f.nickname.value || null, gender: f.gender.value || null, birth_date: f.birth_date.value || null, class_id: f.class_id.value,
        effective_from: f.effective_from.value, roll_no: f.roll_no.value ? Number(f.roll_no.value) : null,
      });
      return `เพิ่มนักเรียนแล้ว (รหัสอ้างอิง ${r.student_id.slice(0, 8)})`;
    }));
}

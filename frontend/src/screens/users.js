// User / Role Management: staff accounts, roles with effective dates, assignments, invitations.
import { h, mount } from '../lib/dom.js';
import { field, input, select, form, table, loading, empty, errorState, section, enumLabel, enumOptions, actionButton, alertBox, toast, badge, pager, askText } from '../ui.js';
import { ENUMS } from '../../../src/schema/enums.js';

const STAFF_ROLES = ['SYSTEM_ADMIN', 'STUDENT_AFFAIRS', 'EXECUTIVE', 'HOMEROOM_TEACHER', 'SUBJECT_TEACHER', 'DUTY_TEACHER', 'GATE_STAFF'];

export async function renderUsers(app, params) {
  if (params.id) return renderUserDetail(app, params.id);
  const root = h('div');
  const list = h('div');
  const q = input('q', { placeholder: 'ชื่อ รหัส หรืออีเมล' });
  const type = select('user_type', enumOptions('UserType', { empty: 'ทุกประเภท' }));
  let rows = [];
  const load = async (cursor = null) => {
    if (!cursor) { rows = []; mount(list, loading()); }
    try {
      const r = await app.api.get('user.list', { q: q.value || null, user_type: type.value || null, cursor, limit: 50 }, { channel: 'users' });
      rows = rows.concat(r.items);
      mount(list, rows.length ? table([
        { label: 'ชื่อ', key: 'display_name' }, { label: 'ประเภท', render: (u) => enumLabel('UserType', u.user_type) },
        { label: 'สถานะ', render: (u) => badge(enumLabel('UserStatus', u.status), u.status === 'ACTIVE' ? 'ok' : u.status === 'DISABLED' ? 'danger' : 'warn') },
        { label: 'บทบาท', render: (u) => u.roles.map((r) => enumLabel('Role', r)).join(', ') || '—' },
      ], rows, { onRow: (u) => app.go('users', { id: u.id }) }) : empty(), pager(r.next_cursor, load));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(list, errorState(e, () => load())); }
  };
  root.appendChild(form([h('div', { class: 'grid3' }, field('ค้นหา', q), field('ประเภท', type))], async () => { await load(); return false; }, { submitLabel: 'ค้นหา' }));
  root.appendChild(list);
  load();
  if (app.can('user.manage')) {
    const name = input('display_name');
    const email = input('contact_email', { type: 'email' });
    const code = input('staff_code');
    const from = input('effective_from', { type: 'date' });
    const roleBoxes = STAFF_ROLES.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'roles', value: r }), ` ${ENUMS.Role.th[r]}`));
    root.appendChild(section('เพิ่มบัญชีบุคลากร',
      alertBox('info', 'บัญชีจะอยู่ในสถานะ "รอเปิดใช้งาน" จนกว่าเจ้าของบัญชีจะใช้รหัสคำเชิญ; ไม่มีรหัสผ่านเริ่มต้น'),
      form([h('div', { class: 'grid3' }, field('ชื่อ-สกุล', name, { required: true }), field('อีเมลติดต่อ', email), field('รหัสบุคลากร', code), field('วันที่บทบาทมีผล', from, { required: true })),
        h('fieldset', null, h('legend', null, 'บทบาท'), roleBoxes)], async (fd) => {
        const r = await app.api.mutate('user.createStaff', { display_name: name.value, contact_email: email.value || null, staff_code: code.value || null, roles: fd.getAll('roles'), effective_from: from.value });
        app.go('users', { id: r.user_id });
        return false;
      })));
  }
  return root;
}

async function renderUserDetail(app, id) {
  const d = await app.api.get('user.get', { user_id: id });
  const u = d.user;
  const root = h('div', null, h('p', null, h('a', { href: '#/users' }, '← กลับรายการผู้ใช้')));
  root.appendChild(section(u.display_name,
    h('p', null, `${enumLabel('UserType', u.user_type)} · สถานะ ${enumLabel('UserStatus', u.status)}${u.contact_email ? ` · ${u.contact_email}` : ''}`),
    app.can('user.manage') && u.user_type === 'STAFF' ? actionButton(u.status === 'DISABLED' ? 'เปิดใช้งานบัญชี' : 'ระงับบัญชี', async () => {
      const reason = await askText('เหตุผลการเปลี่ยนสถานะ (บันทึกใน audit)');
      if (!reason) return;
      await app.api.mutate('user.setStatus', { user_id: u.id, status: u.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED', reason }, { expectedVersion: u.version });
      toast('บันทึกแล้ว'); app.render();
    }, { variant: u.status === 'DISABLED' ? 'secondary' : 'danger', confirmText: 'ยืนยันการเปลี่ยนสถานะบัญชี (มีผลทันทีกับคำขอถัดไป)' }) : null));

  root.appendChild(section('บทบาท', d.roles.length ? table([
    { label: 'บทบาท', render: (r) => enumLabel('Role', r.role) }, { label: 'เริ่ม', key: 'effective_from' }, { label: 'สิ้นสุด (ไม่รวม)', render: (r) => r.effective_to || '—' },
    { label: 'สถานะ', render: (r) => (r.revoked_at ? badge('เพิกถอนแล้ว', 'danger') : badge('มีผล', 'ok')) },
    { label: '', render: (r) => (!r.revoked_at && app.can('role.assign') ? actionButton('เพิกถอน', async () => {
      const reason = await askText('เหตุผลการเพิกถอนบทบาท');
      if (!reason) return;
      await app.api.mutate('role.revoke', { user_role_id: r.id, reason }); toast('เพิกถอนแล้ว'); app.render();
    }, { variant: 'link', confirmText: 'เพิกถอนบทบาทนี้ (มีผลทันที)?' }) : '') },
  ], d.roles) : empty('ยังไม่มีบทบาท'),
  app.can('role.assign') && u.user_type === 'STAFF' ? (() => {
    const role = select('role', STAFF_ROLES.map((r) => h('option', { value: r }, ENUMS.Role.th[r])));
    const from = input('effective_from', { type: 'date' });
    const to = input('effective_to', { type: 'date' });
    const reason = input('reason');
    return form([h('div', { class: 'grid3' }, field('บทบาท', role), field('เริ่ม', from, { required: true }), field('สิ้นสุด (ไม่บังคับ)', to), field('เหตุผล', reason, { required: true }))], async () => {
      await app.api.mutate('role.grant', { user_id: u.id, role: role.value, effective_from: from.value, effective_to: to.value || null, reason: reason.value });
      app.render(); return false;
    }, { submitLabel: 'เพิ่มบทบาท' });
  })() : null));

  root.appendChild(section('ขอบเขตงาน (ครูที่ปรึกษา/เวร/สอน/รักษาการแทน)', d.assignments.length ? table([
    { label: 'ประเภท', render: (a) => enumLabel('AssignmentType', a.assignment_type) }, { label: 'เริ่ม', key: 'effective_from' }, { label: 'สิ้นสุด', render: (a) => a.effective_to || '—' },
  ], d.assignments) : empty(), (app.can('user.manage') || app.can('settings.business')) && u.user_type === 'STAFF' ? await assignmentForm(app, u) : null));

  const codeBox = h('div', { 'aria-live': 'polite' });
  root.appendChild(section('คำเชิญและการเชื่อมบัญชี',
    d.identity_links.length ? table([{ label: 'ผู้ให้บริการ', key: 'provider' }, { label: 'อีเมลขณะเชื่อม', render: (l) => l.email_at_link || '—' }, { label: 'สถานะ', key: 'status' },
      { label: '', render: (l) => (l.status === 'ACTIVE' && app.can('user.manage') ? actionButton('ยกเลิกการเชื่อม', async () => {
        const reason = await askText('เหตุผลการยกเลิกการเชื่อมบัญชี (เช่น บัญชีถูกยึด)');
        if (!reason) return;
        await app.api.mutate('identity.unlink', { identity_link_id: l.id, reason }); app.render();
      }, { variant: 'link', confirmText: 'ยกเลิกการเชื่อมบัญชีนี้?' }) : '') }], d.identity_links) : empty('ยังไม่ได้เชื่อมบัญชีผู้ให้บริการยืนยันตัวตน'),
    d.invitations.length ? table([{ label: 'สถานะ', render: (i) => enumLabel('InvitationStatus', i.status) }, { label: 'หมดอายุ', key: 'expires_at' }, { label: 'อีเมลที่ผูก', render: (i) => i.bound_email || '—' }], d.invitations) : null,
    u.status !== 'DISABLED' ? (() => {
      const bound = input('bound_email', { type: 'email', value: u.contact_email || '' });
      return form([field('ผูกกับอีเมล (แนะนำ)', bound, { hint: 'ผู้รับต้องยืนยันอีเมลนี้กับผู้ให้บริการก่อนใช้รหัส' })], async () => {
        const r = await app.api.mutate('invitation.create', { user_id: u.id, bound_email: bound.value || null });
        mount(codeBox, r.code ? alertBox('ok', `รหัสคำเชิญ (แสดงครั้งเดียว): ${r.code} — หมดอายุ ${r.expires_at}`) : alertBox('warn', r.note_th));
        return false;
      }, { submitLabel: 'ออกรหัสคำเชิญใหม่ (ยกเลิกรหัสเดิม)' });
    })() : null, codeBox));
  return root;
}

async function assignmentForm(app, u) {
  const classes = (await app.api.get('class.list', {})).items;
  const stations = (await app.api.get('station.list', {})).items;
  const type = select('assignment_type', enumOptions('AssignmentType'));
  const cls = select('class_id', [h('option', { value: '' }, '—'), ...classes.map((c) => h('option', { value: c.id }, c.name_th))]);
  const st = select('station_id', [h('option', { value: '' }, '—'), ...stations.map((s) => h('option', { value: s.id }, s.name_th))]);
  const delegateFor = input('delegate_for_user_id', { placeholder: 'UUID ผู้ใช้ที่รักษาการแทน' });
  const from = input('effective_from', { type: 'date' });
  const to = input('effective_to', { type: 'date' });
  return form([h('div', { class: 'grid3' }, field('ประเภท', type), field('ห้อง', cls), field('จุดลงเวลา', st), field('รักษาการแทน (UUID)', delegateFor), field('เริ่ม', from, { required: true }), field('สิ้นสุด', to))], async () => {
    await app.api.mutate('assignment.create', { user_id: u.id, assignment_type: type.value, class_id: cls.value || null, station_id: st.value || null, delegate_for_user_id: delegateFor.value || null, effective_from: from.value, effective_to: to.value || null });
    app.render(); return false;
  }, { submitLabel: 'เพิ่มขอบเขตงาน' });
}

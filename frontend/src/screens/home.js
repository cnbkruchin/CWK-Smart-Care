// Landing page: role-based shortcuts and setup reminders for administrators.
import { h } from '../lib/dom.js';
import { alertBox, section, statusBadge } from '../ui.js';

export async function renderHome(app) {
  const s = app.session;
  const tiles = app.visibleRoutes().filter((r) => r.path !== 'home').map((r) =>
    h('a', { class: 'tile', href: `#/${r.path}` }, h('span', { class: 'tile-icon', 'aria-hidden': 'true' }, r.icon || '•'), h('span', null, r.title_th)));
  const out = [h('p', null, `สวัสดี ${s.user.display_name} · บทบาท: ${s.roles.join(', ') || '—'}`)];
  if (!s.roles.length) out.push(alertBox('warn', 'บัญชีนี้ยังไม่มีบทบาทที่มีผลวันนี้ กรุณาติดต่อผู้ดูแลระบบ'));
  out.push(h('div', { class: 'tiles' }, tiles));
  if (app.can('system.health')) {
    try {
      const health = await app.api.get('system.health', {}, { channel: 'home-health' });
      const bad = health.checks.filter((c) => c.status !== 'OK');
      if (bad.length) {
        out.push(section('สิ่งที่ต้องตั้งค่า/ตรวจสอบ', h('ul', { class: 'checklist' }, bad.map((c) => h('li', null, statusBadge(c.status), ' ', c.detail_th)))));
      }
    } catch (_) { /* health is optional on the home page */ }
  }
  return h('div', null, out);
}

// Application shell: session, role-based navigation, hash router, in-memory drafts.
import { h, mount } from './lib/dom.js';
import { loading, errorState, badge } from './ui.js';

export class App {
  constructor({ root, api, auth, publicConfig, routes, boot }) {
    Object.assign(this, { root, api, auth, publicConfig, routes, boot });
    this.session = null;
    this.drafts = new Map(); // in-memory only: survives in-app back/forward, not page reloads
    this.current = null;
    window.addEventListener('hashchange', () => this.render());
  }

  can(action) {
    return !!(this.session && this.session.actions && this.session.actions.includes(action));
  }

  canAny(actions) {
    return actions.some((a) => this.can(a));
  }

  visibleRoutes() {
    return this.routes.filter((r) => !r.hidden && (!r.anyOf || this.canAny(r.anyOf)));
  }

  parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const [path, query] = raw.split('?');
    const params = {};
    for (const kv of (query || '').split('&').filter(Boolean)) {
      const [k, v] = kv.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    return { path: path || null, params };
  }

  go(path, params = {}) {
    const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const next = `#/${path}${q ? `?${q}` : ''}`;
    if (location.hash === next) this.render();
    else location.hash = next;
  }

  async loadSession() {
    this.session = await this.api.get('auth.getCurrentUser', {});
    return this.session;
  }

  shell(content) {
    const pc = this.publicConfig || {};
    const school = (pc.school && pc.school.name_th) || 'CWK Smart Care';
    const nav = h('nav', { class: 'nav', 'aria-label': 'เมนูหลัก' },
      h('ul', null, this.visibleRoutes().map((r) => h('li', null,
        h('a', { href: `#/${r.path}`, class: this.current === r.path ? 'active' : null, 'aria-current': this.current === r.path ? 'page' : null }, `${r.icon || ''} ${r.title_th}`)))));
    const header = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('strong', null, 'CWK Smart Care'), h('span', { class: 'muted small' }, ` · ${school}`)),
      pc.env && pc.env !== 'PROD' ? badge(`สภาพแวดล้อม ${pc.env} — ข้อมูลทดสอบ`, 'warn', '⚠') : null,
      pc.system_mode === 'READ_ONLY' ? badge('โหมดอ่านอย่างเดียว', 'warn', '🔒') : null,
      h('div', { class: 'who' }, this.session && this.session.user ? this.session.user.display_name : '',
        h('button', { type: 'button', class: 'btn btn-link', onclick: () => this.logout() }, 'ออกจากระบบ')));
    return h('div', { class: 'layout' }, header, nav, h('main', { id: 'main', tabindex: '-1' }, content));
  }

  async logout() {
    try { await this.api.get('auth.logout', {}); } catch (_) { /* best effort */ }
    await this.auth.signOut();
    this.session = null;
    this.drafts.clear();
    location.hash = '#/';
    this.onLoggedOut && this.onLoggedOut();
  }

  async render() {
    if (!this.session || !this.session.linked) return;
    const { path, params } = this.parseHash();
    const routes = this.visibleRoutes();
    const route = routes.find((r) => r.path === path) || this.routes.find((r) => r.path === path && r.hidden && (!r.anyOf || this.canAny(r.anyOf))) || routes[0];
    if (!route) { mount(this.root, this.shell(errorState({ message_th: 'บัญชีนี้ยังไม่มีเมนูที่ใช้งานได้ กรุณาติดต่อผู้ดูแลระบบ' }))); return; }
    this.current = route.path;
    const container = h('div', { class: 'screen' }, h('h1', null, route.title_th), loading());
    mount(this.root, this.shell(container));
    try {
      const node = await route.render(this, params);
      mount(container, h('h1', null, route.title_th), node);
    } catch (err) {
      mount(container, h('h1', null, route.title_th), errorState(err, () => this.render()));
    }
    const main = document.getElementById('main');
    if (main) main.focus({ preventScroll: true });
  }
}

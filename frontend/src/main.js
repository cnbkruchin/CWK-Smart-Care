// Frontend entry: chooses transport (google.script.run on GAS, HTTPS elsewhere) and auth mode from
// server-provided public configuration, then runs the role-based app.
import { mount } from './lib/dom.js';
import { ApiClient, GasRpcTransport, HttpTransport, uuid } from './api.js';
import { FirebaseAuth, DemoAuth } from './auth.js';
import { App } from './app.js';
import { ROUTES } from './screens/index.js';
import { renderLogin } from './screens/login.js';
import { errorState } from './ui.js';

function deviceId() {
  try {
    let id = sessionStorage.getItem('cwk.device');
    if (!id) { id = uuid(); sessionStorage.setItem('cwk.device', id); }
    return id;
  } catch (_) { return null; }
}

export async function start(options = {}) {
  const root = document.getElementById('app');
  const boot = window.__CWK_BOOT__ || {};
  const onGas = !!(globalThis.google && google.script && google.script.run);
  const transport = options.transport || (onGas ? new GasRpcTransport() : new HttpTransport(options.apiBase || ''));
  let publicConfig = boot.public_config;
  let auth;
  const api = new ApiClient({ transport, getCredential: () => (auth ? auth.credential() : null), deviceId: deviceId(), onUnauthenticated: () => showLogin() });
  if (!publicConfig) {
    try { publicConfig = await api.get('app.publicConfig', {}); } catch (e) { mount(root, errorState(e, () => location.reload())); return; }
  }
  // GATEWAY = Firebase verified through the Apps Script gateway; FIREBASE = verified by the REST backend itself
  auth = (publicConfig.auth_mode === 'GATEWAY' || publicConfig.auth_mode === 'FIREBASE') && publicConfig.firebase ? new FirebaseAuth(publicConfig.firebase, publicConfig.auth_persistence) : new DemoAuth();
  try { await auth.init(); } catch (e) { mount(root, errorState({ message_th: `โหลดระบบยืนยันตัวตนไม่สำเร็จ: ${e.message}` }, () => location.reload())); return; }
  const app = new App({ root, api, auth, publicConfig, routes: ROUTES, boot });
  app.onLoggedOut = () => showLogin();
  globalThis.__cwkApp = app;

  async function ready() {
    const s = await app.loadSession();
    if (!s.linked) { showLogin(); return; }
    if (boot.initial_route && !location.hash) location.hash = `#/${boot.initial_route}${boot.focus_id ? `?id=${boot.focus_id}` : ''}`;
    await app.render();
  }

  function showLogin() {
    app.session = null;
    renderLogin(app, root, ready);
  }

  if (auth.signedIn) {
    try { await ready(); } catch (_) { showLogin(); }
  } else showLogin();

}

if (typeof window !== 'undefined' && !window.__CWK_NO_AUTOSTART__) {
  window.addEventListener('DOMContentLoaded', () => start());
  if (document.readyState !== 'loading') start();
}

// Web starter for the REST backend (MASTER_PROMPT §2.3 path 3, §16): sign-in, account activation,
// student search, student profile and one complete "record arrival" flow. Every rule (permissions, late
// cutoff, server time, idempotency) is enforced by the backend; this page only shows what the API returns.
// Screens still to migrate from the Apps Script UI are listed in future-platform/web/README_TH.md.
import { Api, ApiError, uuid } from './api.js';
import { FirebaseRestAuth, DemoAuth } from './auth.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const base = (document.querySelector('meta[name="cwk-api-base"]') || {}).content || '';
const S = { pc: null, auth: null, api: null, me: null };

// ───────── DOM helpers (text only — data never becomes HTML) ─────────
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
const show = (...nodes) => { $app.replaceChildren(...nodes.flat(Infinity).filter(Boolean)); $app.focus(); };
const alertBox = (kind, text) => el('div', { class: `alert ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, text);
const errText = (e) => (e instanceof ApiError || (e && e.message) ? `${e.message}${e.requestId ? ` (รหัสอ้างอิง ${e.requestId})` : ''}` : 'เกิดข้อผิดพลาด');
const fullName = (s) => `${s.prefix_th || ''}${s.first_name_th} ${s.last_name_th}${s.nickname ? ` (${s.nickname})` : ''}`;
const bkkTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '—');
const can = (action) => !!(S.me && S.me.actions && S.me.actions.includes(action));
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

/** Form with one submit handler; the button is disabled while the request runs (no double submit). */
function form(fields, submitLabel, onSubmit, extra = []) {
  const msg = el('div', { 'aria-live': 'polite' });
  const btn = el('button', { class: 'primary', type: 'submit' }, submitLabel);
  const f = el('form', {
    novalidate: true,
    onsubmit: async (ev) => {
      ev.preventDefault();
      btn.disabled = true;
      msg.replaceChildren();
      try { await onSubmit(msg); } catch (e) { msg.replaceChildren(alertBox('err', errText(e))); } finally { btn.disabled = false; }
    },
  }, fields, btn, msg, extra);
  return f;
}
const field = (label, input) => [el('label', { for: input.id }, label), input];

// ───────── navigation ─────────
function renderNav(active) {
  const items = [];
  if (S.me && S.me.linked) {
    if (can('student.search')) items.push(['#/students', 'นักเรียน']);
    if (can('attendance.record')) items.push(['#/gate', 'ลงเวลามาเรียน']);
  }
  const links = items.map(([href, label]) => el('a', { href, 'aria-current': active === href ? 'page' : null }, label));
  if (S.auth && S.auth.signedIn) links.push(el('button', { type: 'button', onclick: () => { S.auth.signOut(); S.me = null; go('#/login'); } }, 'ออกจากระบบ'));
  $nav.replaceChildren(...links);
}

// ───────── screens ─────────
function loginScreen() {
  renderNav('#/login');
  const head = [el('h1', null, 'เข้าสู่ระบบ'), S.pc.school ? el('p', { class: 'muted' }, S.pc.school.name_th) : null];
  if (S.pc.env !== 'PROD') head.push(alertBox('warn', `สภาพแวดล้อม ${S.pc.env}: ใช้ข้อมูลทดสอบเท่านั้น`));
  if (S.pc.auth_mode === 'DEMO') {
    const uid = el('input', { id: 'uid', autocomplete: 'off', placeholder: 'UUID ของผู้ใช้ทดสอบ' });
    const pass = el('input', { id: 'pass', type: 'password', autocomplete: 'off' });
    show(el('section', { class: 'card' }, head, form([field('รหัสผู้ใช้ทดสอบ (DEMO)', uid), field('รหัสผ่านทดสอบของสภาพแวดล้อม', pass)], 'เข้าสู่ระบบ (ทดสอบ)', async () => {
      S.auth.signIn(uid.value, pass.value);
      await afterSignIn();
    })));
    return;
  }
  const email = el('input', { id: 'email', type: 'email', autocomplete: 'username', inputmode: 'email' });
  const pw = el('input', { id: 'pw', type: 'password', autocomplete: 'current-password' });
  const reset = el('button', { type: 'button', class: 'link', onclick: async () => {
    try { await S.auth.resetPassword(email.value.trim()); reset.replaceWith(alertBox('ok', 'ถ้ามีบัญชีนี้ ระบบส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว')); } catch (e) { reset.after(alertBox('err', errText(e))); }
  } }, 'ลืมรหัสผ่าน');
  const signup = el('button', { type: 'button', class: 'link', onclick: async () => {
    try { await S.auth.signUp(email.value.trim(), pw.value); await afterSignIn(); } catch (e) { signup.after(alertBox('err', errText(e))); }
  } }, 'สร้างบัญชีใหม่ด้วยอีเมลและรหัสผ่านนี้');
  show(el('section', { class: 'card' }, head, form([field('อีเมล', email), field('รหัสผ่าน', pw)], 'เข้าสู่ระบบ', async () => {
    await S.auth.signIn(email.value.trim(), pw.value);
    await afterSignIn();
  }, [el('p', null, reset), el('p', { class: 'muted' }, 'บัญชีใหม่ยังดูข้อมูลไม่ได้จนกว่าจะใช้รหัสคำเชิญจากโรงเรียน '), signup])));
}

async function afterSignIn() {
  S.me = await S.api.get('auth.getCurrentUser', {});
  go(S.me.linked && !(S.me.needs || []).includes('VERIFY_EMAIL') ? defaultRoute() : '#/activate');
}

function defaultRoute() { return can('attendance.record') ? '#/gate' : can('student.search') ? '#/students' : '#/home'; }

function activateScreen() {
  renderNav('#/activate');
  const parts = [el('h1', null, 'เปิดใช้งานบัญชี')];
  if ((S.me.needs || []).includes('VERIFY_EMAIL')) {
    parts.push(alertBox('warn', `กรุณายืนยันอีเมล ${S.me.email || ''} จากลิงก์ที่ระบบส่งไป แล้วกด "ตรวจสอบอีกครั้ง"`));
    parts.push(el('p', null,
      el('button', { type: 'button', class: 'link', onclick: async (ev) => { try { await S.auth.sendVerification(); ev.target.after(alertBox('ok', 'ส่งอีเมลยืนยันแล้ว')); } catch (e) { ev.target.after(alertBox('err', errText(e))); } } }, 'ส่งอีเมลยืนยันอีกครั้ง'), ' · ',
      el('button', { type: 'button', class: 'link', onclick: async () => { await S.auth.token(true); await afterSignIn(); } }, 'ตรวจสอบอีกครั้ง')));
  }
  if (!S.me.linked) {
    const code = el('input', { id: 'code', autocomplete: 'off', placeholder: 'รหัสคำเชิญจากโรงเรียน' });
    parts.push(form([field('รหัสคำเชิญ', code)], 'ใช้รหัสคำเชิญ', async () => {
      await S.api.mutate('auth.redeemInvitation', { code: code.value.trim() });
      await afterSignIn();
    }));
  } else if (!(S.me.needs || []).length) {
    parts.push(alertBox('ok', 'บัญชีพร้อมใช้งาน'));
  }
  show(el('section', { class: 'card' }, parts));
}

function homeScreen() {
  renderNav('#/home');
  show(el('section', { class: 'card' }, el('h1', null, `สวัสดี ${S.me.user.display_name}`),
    el('p', null, 'เว็บรุ่นเริ่มต้นนี้มีเฉพาะการค้นหานักเรียน ประวัติรายบุคคล และการลงเวลามาเรียน — งานอื่นยังใช้หน้าเว็บหลัก (Apps Script) ตามรายการใน README_TH.md')));
}

async function studentsScreen() {
  renderNav('#/students');
  const q = el('input', { id: 'q', type: 'search', placeholder: 'ชื่อ นามสกุล ชื่อเล่น หรือรหัสนักเรียน', autocomplete: 'off' });
  const results = el('div', { 'aria-live': 'polite' });
  let cursor = null;
  let rows = [];
  const draw = (more) => {
    const tbody = el('tbody', null, rows.map((s) => el('tr', null,
      el('td', null, s.student_code), el('td', null, el('a', { href: `#/student?id=${encodeURIComponent(s.id)}` }, fullName(s))), el('td', null, s.class_name_th || '—'))));
    results.replaceChildren(rows.length ? el('table', null, el('thead', null, el('tr', null, el('th', null, 'รหัส'), el('th', null, 'ชื่อ'), el('th', null, 'ห้อง'))), tbody) : el('p', { class: 'muted' }, 'ไม่พบนักเรียนในขอบเขตสิทธิ์ของคุณ'),
      more ? el('button', { type: 'button', class: 'link', onclick: () => search(true) }, 'โหลดเพิ่ม') : null);
  };
  const search = async (append = false) => {
    const page = await S.api.get('student.search', { q: q.value.trim() || null, cursor: append ? cursor : null, limit: 30 }, { channel: 'student.search' });
    rows = append ? rows.concat(page.items) : page.items;
    cursor = page.next_cursor;
    draw(!!cursor);
  };
  show(el('section', { class: 'card' }, el('h1', null, 'ค้นหานักเรียน'), form([field('คำค้น', q)], 'ค้นหา', () => search(false))), el('section', { class: 'card' }, results));
  try { await search(false); } catch (e) { if (e.code !== 'STALE_RESPONSE') results.replaceChildren(alertBox('err', errText(e))); }
}

async function studentScreen(id) {
  renderNav('#/students');
  show(el('p', { class: 'muted' }, 'กำลังโหลด…'));
  const p = await S.api.get('student.profile', { student_id: id }, { channel: 'student.profile' });
  const s = p.student;
  const parts = [el('section', { class: 'card student-card' }, el('h1', null, fullName(s)),
    el('dl', null, el('dt', null, 'รหัส'), el('dd', null, s.student_code), el('dt', null, 'ห้อง'), el('dd', null, s.class_name_th || '—'), el('dt', null, 'ระดับการเข้าถึง'), el('dd', null, p.access === 'FULL' ? 'เต็ม (ตามบทบาท)' : 'เฉพาะข้อมูลระบุตัว')))];
  if (p.access === 'FULL' && p.stats) {
    const t = p.stats.period;
    parts.push(el('section', { class: 'card' }, el('h2', null, `สถิติ ${t.from} ถึงก่อน ${t.to_exclusive}`),
      el('dl', null, el('dt', null, 'วันเรียน'), el('dd', null, t.school_days), el('dt', null, 'มาเรียน'), el('dd', null, t.present), el('dt', null, 'มาสาย (นับ)'), el('dd', null, `${t.late_counted} ครั้ง ${t.late_minutes} นาที`),
        el('dt', null, 'ลาเต็มวัน'), el('dd', null, t.full_day_leave), el('dt', null, 'ขาด (ยืนยันแล้ว)'), el('dd', null, t.absent_confirmed), el('dt', null, 'ยังไม่ทราบสถานะ'), el('dd', null, t.unknown)),
      el('p', { class: 'muted' }, p.stats.counting_note_th)));
    if (Array.isArray(p.timeline) && p.timeline.length) {
      parts.push(el('section', { class: 'card' }, el('h2', null, 'เหตุการณ์ล่าสุด'), el('table', null, el('tbody', null,
        p.timeline.slice(0, 10).map((e) => el('tr', null, el('td', null, e.school_date), el('td', null, bkkTime(e.at)), el('td', null, e.label_th || e.type, e.superseded ? ' (ถูกแทนที่)' : '')))))));
    }
  }
  show(...parts);
}

async function gateScreen() {
  renderNav('#/gate');
  const stations = (await S.api.get('station.list', {})).items;
  if (!stations.length) { show(alertBox('warn', 'ยังไม่มีจุดลงเวลา — ผู้ดูแลต้องเพิ่มในหน้าตั้งค่าของระบบหลัก')); return; }
  const station = el('select', { id: 'station' }, stations.map((s) => el('option', { value: s.id }, s.name_th)));
  const code = el('input', { id: 'code', autocomplete: 'off', inputmode: 'numeric', placeholder: 'สแกนบัตร / พิมพ์รหัส แล้วกด Enter', 'aria-label': 'รหัสนักเรียน' });
  const card = el('div', { 'aria-live': 'assertive' });
  const lookup = async () => {
    const found = await S.api.get('attendance.lookupForGate', { code: code.value.trim() }, { channel: 'gate.lookup' });
    const s = found.student;
    const key = uuid(); // one key per confirmed person: a retry of this confirmation can never record twice
    const status = found.status.arrived ? alertBox('warn', `บันทึกแล้ววันนี้ เวลา ${bkkTime(found.status.arrived_at)}${found.status.is_late ? ` (สาย ${found.status.late_minutes} นาที)` : ''}`) : null;
    const confirm = form([], 'ยืนยัน: บันทึกเวลามาถึง (เวลาเซิร์ฟเวอร์)', async (msg) => {
      const r = await S.api.mutate('attendance.recordArrival', { student_id: s.id, station_id: station.value, source: 'SEARCH_CODE' }, { idempotencyKey: key });
      msg.replaceChildren(alertBox(r.is_late ? 'warn' : 'ok', `${r.message_th} · ${bkkTime(r.arrived_at)}`));
      code.value = '';
      code.focus();
    });
    card.replaceChildren(el('section', { class: 'card student-card' }, el('div', { class: 'big' }, fullName(s)), el('div', null, `${s.student_code} · ${s.class_name_th || 'ไม่มีห้องในวันนี้'}`),
      found.eligible ? null : alertBox('err', 'ไม่มีการลงทะเบียนเรียนที่มีผลวันนี้ — ระบบจะไม่บันทึก'), status, confirm));
  };
  show(el('section', { class: 'card' }, el('h1', null, 'ลงเวลามาเรียน'), el('label', { for: 'station' }, 'จุดลงเวลา'), station,
    form([field('รหัสนักเรียน', code)], 'ค้นหา', async (msg) => { card.replaceChildren(); try { await lookup(); } catch (e) { if (e.code !== 'STALE_RESPONSE') msg.replaceChildren(alertBox('err', errText(e))); } })), card);
  code.focus();
}

// ───────── router ─────────
async function route() {
  const [path, query] = (location.hash || '#/').split('?');
  try {
    if (!S.auth.signedIn) { loginScreen(); return; }
    if (!S.me) S.me = await S.api.get('auth.getCurrentUser', {});
    if (!S.me.linked || (S.me.needs || []).includes('VERIFY_EMAIL')) { activateScreen(); return; }
    if (path === '#/students' && can('student.search')) await studentsScreen();
    else if (path === '#/student') await studentScreen(new URLSearchParams(query || '').get('id'));
    else if (path === '#/gate' && can('attendance.record')) await gateScreen();
    else if (path === '#/home') homeScreen();
    else go(defaultRoute());
  } catch (e) {
    if (e && e.code === 'STALE_RESPONSE') return;
    show(el('section', { class: 'card' }, alertBox('err', errText(e)), el('button', { type: 'button', class: 'link', onclick: () => route() }, 'ลองใหม่')));
  }
}

async function start() {
  const anon = new Api({ base, getToken: async () => null });
  try {
    S.pc = await anon.get('app.publicConfig', {});
  } catch (e) { show(alertBox('err', `โหลดค่าตั้งระบบไม่สำเร็จ: ${errText(e)}`)); return; }
  try {
    S.auth = S.pc.auth_mode === 'DEMO' ? new DemoAuth() : new FirebaseRestAuth(S.pc.firebase || {});
  } catch (e) { show(alertBox('err', errText(e))); return; }
  S.api = new Api({ base, getToken: () => S.auth.token(), onUnauthenticated: () => { S.auth.signOut(); S.me = null; } });
  window.addEventListener('hashchange', route);
  await route();
}

start();

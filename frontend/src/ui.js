// Shared UI building blocks: loading/empty/error/success states, accessible fields, buttons that
// prevent double submit, confirm dialogs, toasts, tables, pagination and status badges.
import { h, mount, uid } from './lib/dom.js';
import { ENUMS } from '../../src/schema/enums.js';

export function enumLabel(name, value) {
  return (ENUMS[name] && ENUMS[name].th[value]) || value || '—';
}

export function enumOptions(name, { empty = null } = {}) {
  const opts = ENUMS[name].values.map((v) => h('option', { value: v }, ENUMS[name].th[v]));
  return empty ? [h('option', { value: '' }, empty), ...opts] : opts;
}

const STATUS_ICON = { OK: '✔', WARN: '⚠', FAIL: '✖', REQUIRED_SETUP: '⚙', INFO: 'ℹ' };

export function badge(text, kind = 'neutral', icon = null) {
  return h('span', { class: `badge badge-${kind}` }, icon ? `${icon} ` : '', text);
}

export function statusBadge(status) {
  const kind = { OK: 'ok', WARN: 'warn', FAIL: 'danger', REQUIRED_SETUP: 'warn' }[status] || 'neutral';
  return badge(status, kind, STATUS_ICON[status] || null);
}

export function loading(text = 'กำลังโหลด…') {
  return h('div', { class: 'state state-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', text);
}

export function empty(text = 'ไม่มีข้อมูล') {
  return h('div', { class: 'state state-empty' }, 'ℹ ', text);
}

export function errorState(err, retry) {
  const msg = (err && (err.message_th || err.message)) || 'เกิดข้อผิดพลาด';
  return h('div', { class: 'state state-error', role: 'alert' },
    h('p', null, '✖ ', msg),
    err && err.request_id ? h('p', { class: 'muted small' }, `รหัสอ้างอิง: ${err.request_id}`) : null,
    retry ? h('button', { type: 'button', class: 'btn', onclick: retry }, 'ลองใหม่') : null);
}

export function success(text) {
  return h('div', { class: 'state state-success', role: 'status' }, '✔ ', text);
}

export function alertBox(kind, text) {
  const icon = { info: 'ℹ', warn: '⚠', danger: '✖', ok: '✔' }[kind] || 'ℹ';
  return h('div', { class: `alert alert-${kind}`, role: kind === 'danger' ? 'alert' : 'status' }, `${icon} `, text);
}

/** Labelled form field; `control` is an input/select/textarea element. */
export function field(label, control, { hint = null, required = false } = {}) {
  const id = control.id || uid('fld');
  control.id = id;
  if (required) control.required = true;
  const err = h('div', { class: 'field-error', id: `${id}-err`, role: 'alert' });
  control.setAttribute('aria-describedby', `${id}-err`);
  return h('div', { class: 'field', dataset: { field: control.name || '' } },
    h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    control, hint ? h('div', { class: 'hint' }, hint) : null, err);
}

export function input(name, props = {}) {
  return h('input', { name, type: 'text', class: 'input', ...props });
}

export function select(name, options, props = {}) {
  return h('select', { name, class: 'input', ...props }, options);
}

export function textarea(name, props = {}) {
  return h('textarea', { name, class: 'input', rows: 3, ...props });
}

/** Show server field errors next to fields (by name); returns unmatched messages. */
export function showFieldErrors(form, fieldErrors = []) {
  form.querySelectorAll('.field-error').forEach((e) => { e.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  const unmatched = [];
  for (const fe of fieldErrors) {
    const name = String(fe.field).split(/[.[]/)[0];
    const ctl = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (ctl) {
      ctl.setAttribute('aria-invalid', 'true');
      const box = form.querySelector(`#${CSS.escape(ctl.id)}-err`);
      if (box) box.textContent = fe.message_th;
    } else unmatched.push(fe.message_th);
  }
  return unmatched;
}

/**
 * Button that runs an async action once at a time (double-submit protection) and shows busy state.
 */
export function actionButton(label, action, { variant = 'primary', type = 'button', confirmText = null, large = false } = {}) {
  const btn = h('button', { type, class: `btn btn-${variant}${large ? ' btn-lg' : ''}` }, label);
  let busy = false;
  btn.addEventListener('click', async (ev) => {
    if (type === 'submit') return; // handled by form submit
    ev.preventDefault();
    if (busy) return;
    if (confirmText && !(await confirmDialog(confirmText))) return;
    busy = true;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try { await action(); } finally { busy = false; btn.disabled = false; btn.removeAttribute('aria-busy'); }
  });
  return btn;
}

/** Form with single-flight submit handling and Thai field errors. */
export function form(children, onSubmit, { submitLabel = 'บันทึก', confirmText = null, large = false } = {}) {
  const status = h('div', { class: 'form-status', 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: `btn btn-primary${large ? ' btn-lg' : ''}` }, submitLabel);
  const el = h('form', { class: 'form', novalidate: true }, children, h('div', { class: 'form-actions' }, submit), status);
  let busy = false;
  el.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    if (confirmText && !(await confirmDialog(typeof confirmText === 'function' ? confirmText() : confirmText))) return;
    busy = true;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    mount(status, loading('กำลังบันทึก…'));
    try {
      const msg = await onSubmit(new FormData(el), el);
      showFieldErrors(el, []);
      mount(status, msg === false ? '' : success(msg || 'บันทึกแล้ว'));
    } catch (err) {
      const rest = showFieldErrors(el, err.field_errors || []);
      mount(status, errorState({ ...err, message_th: [err.message_th || err.message, ...rest].filter(Boolean).join(' · ') }));
    } finally {
      busy = false;
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  });
  return el;
}

export function confirmDialog(text, { okLabel = 'ยืนยัน', cancelLabel = 'ยกเลิก' } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (v) => { overlay.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    const ok = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => close(true) }, okLabel);
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, cancelLabel);
    const overlay = h('div', { class: 'modal-overlay', role: 'presentation' },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'ยืนยัน' }, h('p', null, text), h('div', { class: 'form-actions' }, cancel, ok)));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
    document.body.appendChild(overlay);
    cancel.focus();
  });
}

export function toast(text, kind = 'ok') {
  const t = h('div', { class: `toast toast-${kind}`, role: 'status' }, text);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

export function table(columns, rows, { caption = null, onRow = null } = {}) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    caption ? h('caption', null, caption) : null,
    h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col' }, c.label)))),
    h('tbody', null, rows.map((r) => h('tr', onRow ? { tabindex: 0, class: 'clickable', onclick: () => onRow(r), onkeydown: (e) => { if (e.key === 'Enter') onRow(r); } } : null,
      columns.map((c) => h('td', { 'data-label': c.label }, c.render ? c.render(r) : (r[c.key] ?? '—'))))))));
}

export function section(title, ...children) {
  return h('section', { class: 'card' }, h('h2', null, title), children);
}

export function pager(nextCursor, load) {
  if (!nextCursor) return null;
  return actionButton('โหลดเพิ่ม', () => load(nextCursor), { variant: 'secondary' });
}

/** Read a File as base64 (no data URL prefix). */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    r.readAsDataURL(file);
  });
}

/** Trigger a browser download from bytes/text without exposing data in URLs to the server. */
export function downloadBlob(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Accessible text prompt (replaces window.prompt); resolves null when cancelled or empty. */
export function askText(question, { label = 'เหตุผล', okLabel = 'บันทึก', multiline = false } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const ctl = multiline ? h('textarea', { class: 'input', rows: 3 }) : h('input', { class: 'input', type: 'text' });
    const close = (v) => { overlay.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    const ok = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => close(ctl.value.trim() || null) }, okLabel);
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'ยกเลิก');
    const overlay = h('div', { class: 'modal-overlay', role: 'presentation' },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': question }, h('p', null, question), field(label, ctl), h('div', { class: 'form-actions' }, cancel, ok)));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    document.body.appendChild(overlay);
    ctl.focus();
  });
}

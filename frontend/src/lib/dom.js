// Safe DOM construction: text is always inserted with textContent / text nodes, never innerHTML.
// Attributes starting with "on" must be functions; href/src values are restricted to safe schemes.

const SAFE_URL = /^(https?:|mailto:|tel:|#|\/|blob:)/i;

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if ((k === 'href' || k === 'src') && !SAFE_URL.test(String(v))) continue;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'autofocus' || k === 'multiple' || k === 'readOnly') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function mount(el, ...children) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return append(el, children);
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

let idSeq = 0;
export function uid(prefix = 'f') {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

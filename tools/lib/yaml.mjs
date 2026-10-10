// Minimal deterministic YAML emitter for JSON-compatible data (OpenAPI generation).
const PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?)$/i;

function scalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (PLAIN.test(s) && !RESERVED.test(s)) return s;
  return JSON.stringify(s);
}

export function toYaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map((x) => {
      if (x !== null && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) {
        const inner = toYaml(x, indent + 2);
        return `${pad}- ${inner.trimStart()}`;
      }
      return `${pad}- ${x !== null && typeof x === 'object' ? (Array.isArray(x) ? '[]' : '{}') : scalar(x)}`;
    }).join('\n');
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return keys.map((k) => {
      const x = v[k];
      const key = PLAIN.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
      if (x !== null && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) return `${pad}${key}:\n${toYaml(x, indent + 2)}`;
      if (x !== null && typeof x === 'object') return `${pad}${key}: ${Array.isArray(x) ? '[]' : '{}'}`;
      return `${pad}${key}: ${scalar(x)}`;
    }).join('\n');
  }
  return pad + scalar(v);
}

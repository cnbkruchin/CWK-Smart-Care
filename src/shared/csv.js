// RFC 4180 CSV parser/writer (no dependencies; runs in GAS, Node and browsers).
// Values are returned as strings exactly as written (leading zeros preserved) — typing happens in
// the import mapping layer, never by guessing.

/** Parse CSV text → array of rows (array of strings). Handles BOM, quotes, CRLF/LF, embedded newlines. */
export function parseCsv(text, { delimiter = ',' } = {}) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (inQuotes) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutralize spreadsheet formula injection for human-facing CSV/XLSX (OWASP guidance):
 * text cells starting with = + - @ TAB CR are prefixed with an apostrophe. Canonical JSONL backups
 * never apply this transformation (they keep the true value).
 */
export function neutralizeFormula(value) {
  if (typeof value !== 'string') return value;
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build CSV text (UTF-8 BOM so Excel opens Thai correctly, CRLF line endings).
 * @param {string[]} headers
 * @param {Array<Array<any>>} rows
 * @param {{neutralize?: boolean, bom?: boolean}} opts
 */
export function toCsv(headers, rows, { neutralize = true, bom = true } = {}) {
  const lines = [headers.map(quote).join(',')];
  for (const r of rows) lines.push(r.map((v) => quote(neutralize && typeof v === 'string' ? neutralizeFormula(v) : v)).join(','));
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

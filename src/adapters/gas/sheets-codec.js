// Cell encoding for Google Sheets (DECISIONS D-007, DATA_DICTIONARY §2).
//   write: null → '' ; string-like → "'" + value (forced text) ; int → number ; bool → boolean ; json → "'" + JSON
//   read : ''   → null ; values typed back per schema column; unexpected cell types are reported as drift.

import { getTable } from '../../schema/index.js';
import { AppError } from '../../shared/errors.js';

const TEXT_TYPES = new Set(['uuid', 'string', 'text', 'enum', 'hhmm', 'date', 'ts', 'decimal']);

export function encodeCell(col, v) {
  if (v === null || v === undefined) return '';
  if (TEXT_TYPES.has(col.type)) return `'${String(v)}`;
  if (col.type === 'json') return `'${JSON.stringify(v)}`;
  if (col.type === 'int') return Number(v);
  if (col.type === 'bool') return !!v;
  throw new AppError('INTERNAL_ERROR', `cannot encode ${col.type}`);
}

function pad2(n) { return String(n).padStart(2, '0'); }

export function decodeCell(col, v, drift) {
  if (v === '' || v === null || v === undefined) return null;
  switch (col.type) {
    case 'uuid': case 'string': case 'text': case 'enum': case 'hhmm': case 'decimal':
      if (typeof v !== 'string') { drift && drift.push({ column: col.name, issue: `expected text, got ${typeof v}` }); return String(v); }
      return v;
    case 'date':
      if (v instanceof Date || (v && typeof v.getFullYear === 'function')) {
        drift && drift.push({ column: col.name, issue: 'date cell auto-converted by Sheets' });
        return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
      }
      return String(v);
    case 'ts':
      if (v instanceof Date || (v && typeof v.toISOString === 'function')) { drift && drift.push({ column: col.name, issue: 'timestamp cell auto-converted by Sheets' }); return v.toISOString(); }
      return String(v);
    case 'int':
      if (typeof v === 'number') return v;
      drift && drift.push({ column: col.name, issue: `expected number, got ${typeof v}` });
      return Number(v);
    case 'bool':
      if (typeof v === 'boolean') return v;
      drift && drift.push({ column: col.name, issue: `expected boolean, got ${typeof v}` });
      return String(v).toUpperCase() === 'TRUE';
    case 'json':
      if (typeof v !== 'string') { drift && drift.push({ column: col.name, issue: 'json cell is not text' }); return null; }
      try { return JSON.parse(v); } catch (_) { drift && drift.push({ column: col.name, issue: 'invalid json' }); return null; }
    default:
      return v;
  }
}

export function encodeRow(tableName, record) {
  return getTable(tableName).columns.map((c) => encodeCell(c, record[c.name]));
}

export function decodeRow(tableName, row, drift) {
  const t = getTable(tableName);
  const out = {};
  t.columns.forEach((c, i) => { out[c.name] = decodeCell(c, row[i], drift); });
  return out;
}

export function headerOf(tableName) {
  return getTable(tableName).columns.map((c) => c.name);
}

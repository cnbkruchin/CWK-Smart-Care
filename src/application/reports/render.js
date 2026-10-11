// Report document model → files. CSV is produced here (pure, UTF-8 BOM, CRLF, formula injection
// neutralised for text cells). XLSX and PDF go through the platform port `reportRenderer`
// (GAS: temporary spreadsheet + Drive export / Docs template + PDF export — DECISIONS D-016).
// Dates: files for data work (CSV/XLSX) use ISO dates (ค.ศ.) and local HH:MM; PDF/screen show พ.ศ.
import { toCsv } from '../../shared/csv.js';
import { utf8Encode } from '../../shared/canonical-json.js';
import { formatThaiDate, formatThaiDateTime, formatThaiTime } from '../../shared/thai-format.js';
import { localPartsOf } from '../../shared/time.js';
import { AppError } from '../../shared/errors.js';

export const ROW_LIMITS = { JSON: 500, CSV: 100000, XLSX: 50000, PDF: 2000 };
export const MIME = { CSV: 'text/csv', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', PDF: 'application/pdf' };

const isTs = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);

/** Value for data files: numbers stay numbers; timestamps become local "YYYY-MM-DD HH:MM". */
export function dataValue(c, v, tz) {
  if (v === null || v === undefined) return '';
  if ((c.type === 'datetime' || c.type === 'time') && isTs(v)) {
    const p = localPartsOf(v, tz);
    return c.type === 'time' ? p.hhmm : `${p.date} ${p.hhmm}`;
  }
  if (c.type === 'percent' && typeof v === 'number') return v;
  return v;
}

/** Value for people (PDF/screen): Thai dates in พ.ศ., local times. */
export function displayValue(c, v, tz) {
  if (v === null || v === undefined || v === '') return '—';
  if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatThaiDate(v, { short: true });
  if (c.type === 'datetime' && isTs(v)) return formatThaiDateTime(v, tz, { short: true });
  if (c.type === 'time' && isTs(v)) return formatThaiTime(v, tz);
  if (c.type === 'percent' && typeof v === 'number') return `${v.toFixed(1)}%`;
  if (typeof v === 'number') return v.toLocaleString('en-US');
  return String(v);
}

export function csvBytes(doc, tz) {
  const headers = doc.columns.map((c) => c.label);
  const rows = doc.rows.map((r) => doc.columns.map((c) => dataValue(c, r[c.key], tz)));
  if (doc.totals) rows.push(doc.columns.map((c) => dataValue(c, doc.totals[c.key], tz)));
  const text = toCsv(headers, rows, { neutralize: true, bom: true });
  return utf8Encode(text);
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
}

/**
 * @param {object} ctx
 * @param {object} doc  { code, title, subtitle, columns, rows, totals, notes_th, meta: {...} }
 * @param {'CSV'|'XLSX'|'PDF'} format
 * @returns {{bytes: Uint8Array, mime: string, filename: string}}
 */
export function* renderFile(ctx, doc, format) {
  if (doc.rows.length > ROW_LIMITS[format]) {
    throw new AppError('VALIDATION_ERROR', 'too many rows', { messageTh: `รายงานมี ${doc.rows.length.toLocaleString('en-US')} แถว เกินที่ ${format} รองรับ (${ROW_LIMITS[format].toLocaleString('en-US')}) — ใช้ตัวกรองให้แคบลง` });
  }
  const filename = safeName(`${doc.code}_${doc.meta.as_of_local.replace(/[: ]/g, '-')}.${format.toLowerCase()}`);
  if (format === 'CSV') return { bytes: csvBytes(doc, ctx.tz), mime: MIME.CSV, filename };
  const renderer = ctx.platform.reportRenderer;
  if (!renderer) throw new AppError('CONFIGURATION_REQUIRED', 'report renderer', { messageTh: `สภาพแวดล้อมนี้ยังสร้างไฟล์ ${format} ไม่ได้ (ต้องติดตั้งบน Apps Script หรือกำหนด renderer)` });
  const prepared = {
    ...doc,
    rows_data: doc.rows.map((r) => doc.columns.map((c) => dataValue(c, r[c.key], ctx.tz))),
    rows_display: doc.rows.map((r) => doc.columns.map((c) => displayValue(c, r[c.key], ctx.tz))),
    totals_display: doc.totals ? doc.columns.map((c) => (doc.totals[c.key] === undefined ? '' : displayValue(c, doc.totals[c.key], ctx.tz))) : null,
    totals_data: doc.totals ? doc.columns.map((c) => (doc.totals[c.key] === undefined ? '' : dataValue(c, doc.totals[c.key], ctx.tz))) : null,
  };
  let out = format === 'XLSX' ? renderer.xlsx(prepared) : renderer.pdf(prepared);
  if (out && typeof out.then === 'function') out = yield out;
  return { bytes: out, mime: MIME[format], filename };
}

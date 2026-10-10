// Presentation-only Thai date formatting (พ.ศ.). Never used for storage or API payloads.
// Inputs are always CE values from the API; the +543 conversion happens exactly once here.

import { localPartsOf } from './time.js';

export const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const THAI_WEEKDAYS = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];

export function toBuddhistYear(ceYear) {
  return Number(ceYear) + 543;
}

/** "2026-10-10" -> "10 ต.ค. 2569" (short) or "10 ตุลาคม 2569" (long). */
export function formatThaiDate(isoDate, opts = {}) {
  if (!isoDate || typeof isoDate !== 'string') return '';
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const months = opts.long ? THAI_MONTHS : THAI_MONTHS_SHORT;
  return `${d} ${months[m - 1]} ${toBuddhistYear(y)}`;
}

/** UTC ISO -> "10 ต.ค. 2569 08:42 น." in school time. */
export function formatThaiDateTime(isoUtc, tz = 'Asia/Bangkok', opts = {}) {
  if (!isoUtc) return '';
  const p = localPartsOf(isoUtc, tz);
  const time = opts.seconds ? `${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}` : `${pad2(p.hh)}:${pad2(p.mm)}`;
  return `${formatThaiDate(p.date, opts)} ${time} น.`;
}

export function formatThaiTime(isoUtc, tz = 'Asia/Bangkok') {
  if (!isoUtc) return '';
  const p = localPartsOf(isoUtc, tz);
  return `${pad2(p.hh)}:${pad2(p.mm)} น.`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

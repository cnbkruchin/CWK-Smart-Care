// Generates docs/CAPACITY.md from the schema + capacity model (run by tools/gen-docs.mjs).
import { computeCapacity } from '../lib/capacity-model.mjs';

const fmt = (n) => Math.round(n).toLocaleString('en-US');

export function generate() {
  const c = computeCapacity();
  const LIMIT = 10_000_000;
  const L = [];
  L.push('# Capacity estimate — Google Sheets phase');
  L.push('');
  L.push('> สร้างอัตโนมัติจาก `tools/lib/capacity-model.mjs` + จำนวนคอลัมน์จริงใน `src/schema/tables.js` (`npm run gen`). ปรับสมมติฐานได้ด้วย `npm run capacity -- --students=1200 --late_rate=0.08`');
  L.push('> **ตัวเลขทั้งหมดเป็นสมมติฐานเพื่อวางแผน** ไม่ใช่จำนวนนักเรียนจริงหรือผลวัด ต้องแทนด้วยข้อมูลจาก pilot ก่อนตัดสินใจ');
  L.push('');
  L.push('## สมมติฐาน');
  L.push('');
  L.push('| ค่า | สมมติฐาน |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(c.assumptions)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('## จำนวนแถวและเซลล์ (rows × columns จาก schema จริง)');
  L.push('');
  L.push('| ตาราง | ช่วง | workbook | แถว | คอลัมน์ | เซลล์ |');
  L.push('|---|---|---|---|---|---|');
  for (const r of c.rows) L.push(`| ${r.table} | ต่อ${r.scope === 'term' ? 'ภาคเรียน' : 'ปี'} | ${r.workbook} | ${fmt(r.rows)} | ${r.columns} | ${fmt(r.cells)} |`);
  L.push('');
  L.push('## รวมต่อ workbook เทียบขีดจำกัด 10,000,000 เซลล์ต่อ spreadsheet');
  L.push('');
  L.push('| workbook | เซลล์ที่คาด | % ของขีดจำกัด | ข้อสรุป |');
  L.push('|---|---|---|---|');
  for (const [wb, cells] of Object.entries(c.totals)) {
    const pct = (cells / LIMIT) * 100;
    const verdict = pct < 50 ? 'เหลือพื้นที่' : pct < 80 ? 'เฝ้าระวัง — แยก workbook/partition เพิ่ม' : 'เกินเกณฑ์ปลอดภัย — ต้องแบ่ง partition ถี่ขึ้นหรือย้าย backend';
    L.push(`| ${wb} | ${fmt(cells)} | ${pct.toFixed(1)}% | ${verdict} |`);
  }
  const master5y = c.totals['Master/year'] * 5;
  L.push('');
  L.push(`Master workbook สะสม 5 ปี ≈ ${fmt(master5y)} เซลล์ (${((master5y / LIMIT) * 100).toFixed(1)}%) — ตาราง Leave*/Cases*/ContactLogs เติบโตตามปี ควร archive ตาม retention (docs/OPERATIONS_TH.md); Jobs ล้างตาม retention 90 วันจึงไม่นับสะสม`);
  L.push('');
  L.push('## ภาระงานและโควตาที่เกี่ยวข้อง (ประมาณการ)');
  L.push('');
  L.push('| รายการ | ประมาณการ/วัน | ข้อจำกัดที่ต้องตรวจ |');
  L.push('|---|---|---|');
  L.push(`| mutation (ผ่าน ScriptLock) | ${fmt(c.load.mutations_per_day)} | lock wait p95 วัดจริง; simultaneous executions 30/user (สคริปต์รันในบัญชีเจ้าของ) |`);
  L.push(`| outbox ภายนอก | ${fmt(c.load.outbox_per_day)} | ถ้าทั้งหมดเป็นอีเมล: MailApp recipients/day (consumer 100, Workspace 1,500 — ตรวจหน้าโควตาปัจจุบัน) → ใช้ LINE สำหรับผู้ปกครองเป็นหลัก |`);
  L.push(`| dashboard RPC | ${fmt(c.load.dashboard_rpc_per_day)} | polling 60 วินาที + jitter เฉพาะแท็บที่เปิด |`);
  L.push(`| การสแกนช่วงพีค (ต่อนาที) | ${fmt(c.load.gate_peak_scans_per_minute)} | p95 ต่อการสแกนต้องวัดบนอุปกรณ์จริง |`);
  L.push(`| trigger ticks (ทุก 1 นาที) | ${fmt(c.load.trigger_ticks_per_day_1min)} | trigger total runtime/day (consumer ~90 นาที, Workspace ~6 ชม. — ยืนยันกับหน้าโควตา) → tick ที่ไม่มีงานต้องจบเร็ว |`);
  L.push('');
  L.push('## เกณฑ์เริ่มย้ายไป REST backend + PostgreSQL (จากผล pilot)');
  L.push('');
  L.push('- p95 การสแกนประตู > 4 วินาที ต่อเนื่อง 5 วันเรียน หรือ lock wait p95 > 2 วินาที');
  L.push('- queue age ของ outbox > 15 นาที ในช่วงเวลาทำการบ่อยครั้ง');
  L.push('- workbook ใดเกิน 70% ของขีดจำกัดเซลล์ก่อนสิ้นภาคเรียน');
  L.push('- quota error (Mail/UrlFetch/trigger runtime) เกิดซ้ำมากกว่า 1 ครั้ง/สัปดาห์');
  L.push('- ต้องการ transaction ข้าม workbook, availability หรือ realtime เกินที่ Apps Script ให้ได้');
  L.push('');
  return { 'docs/CAPACITY.md': L.join('\n') };
}

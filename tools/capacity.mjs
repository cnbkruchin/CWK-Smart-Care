#!/usr/bin/env node
// Print the capacity estimate with custom assumptions, e.g.:
//   node tools/capacity.mjs --students=1200 --late_rate=0.08 --school_days_per_term=95
import { computeCapacity, DEFAULT_ASSUMPTIONS } from './lib/capacity-model.mjs';

const overrides = {};
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z_]+)=(.+)$/.exec(arg);
  if (!m || !(m[1] in DEFAULT_ASSUMPTIONS)) { console.error(`unknown option ${arg}`); process.exit(2); }
  overrides[m[1]] = Number(m[2]);
}
const c = computeCapacity({ ...DEFAULT_ASSUMPTIONS, ...overrides });
console.table(c.rows.map((r) => ({ table: r.table, per: r.scope, workbook: r.workbook, rows: r.rows, columns: r.columns, cells: r.cells })));
console.log('Totals (cells):', c.totals, '— limit 10,000,000 per spreadsheet');
console.log('Load per day:', c.load);

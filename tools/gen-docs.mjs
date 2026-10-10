#!/usr/bin/env node
// Generates documentation and artifacts from the single sources of truth:
//   src/schema/tables.js, src/schema/enums.js  → DATA_DICTIONARY.md, schema/**/*.json, database/postgres/*.sql
//   src/domain/permissions.js                  → PERMISSIONS.md
//   src/domain/state-machines.js               → docs/STATE_MACHINES.md
//   src/application/operations (when present)  → API_CONTRACT.md, openapi.yaml
// Usage: node tools/gen-docs.mjs [--check]   (--check exits 1 when committed files drift)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, SCHEMA_VERSION, OPTIONAL_MODULES, ENUMS, tableJsonSchema, dependencyOrder, uniqueKeys } from '../src/schema/index.js';
import { generateInitSql, generateRolesSql, SQL_TABLE } from '../src/schema/sql.js';
import { ACTIONS, GRANTS } from '../src/domain/permissions.js';
import { MACHINES } from '../src/domain/state-machines.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const outputs = new Map();
const emit = (rel, content) => outputs.set(rel, content.endsWith('\n') ? content : content + '\n');

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ───────── DATA_DICTIONARY.md ─────────
function typeLabel(c) {
  if (c.type === 'enum') return `enum \`${c.enum}\``;
  if (c.type === 'string') return `string(${c.maxLength})`;
  if (c.type === 'ts') return 'timestamp (UTC)';
  if (c.type === 'json') return 'json';
  return c.type;
}
function constraintLabel(c) {
  const parts = [];
  if (c.pk) parts.push('PK');
  if (c.fk) parts.push(`FK → ${c.fk}.id${c.deferrable ? ' (deferrable)' : ''}`);
  if (c.pattern) parts.push(`pattern \`${c.pattern}\``);
  if (c.min !== undefined) parts.push(`≥ ${c.min}`);
  if (c.max !== undefined) parts.push(`≤ ${c.max}`);
  if (c.default !== undefined) parts.push(`default ${JSON.stringify(c.default)}`);
  if (c.secret) parts.push('SECRET (ไม่ export)');
  if (c.derived) parts.push('derived (สร้างใหม่ได้)');
  if (c.sensitivity) parts.push(`sensitivity ${c.sensitivity}`);
  return parts.join('; ');
}

function dataDictionary() {
  const L = [];
  L.push('# Data Dictionary — CWK Smart Care');
  L.push('');
  L.push(`> สร้างอัตโนมัติจาก \`src/schema/tables.js\` และ \`src/schema/enums.js\` ด้วย \`npm run gen\` — ห้ามแก้ไขไฟล์นี้ด้วยมือ  `);
  L.push(`> schema_version: **${SCHEMA_VERSION}** · ตารางทั้งหมด ${TABLES.length} ตาราง · JSON Schema อยู่ที่ \`schema/tables/*.schema.json\` · SQL อยู่ที่ \`database/postgres/migrations/0001_init.sql\``);
  L.push('');
  L.push('## 1. หลักการข้อมูล');
  L.push('');
  L.push('- **ID ภายใน** เป็น UUID เสมอ ไม่ใช้เลขแถว ชื่อ หรือเบอร์โทรเป็น primary key; ตารางที่มี natural key (เช่น DailyAttendance, RollCallSessions, NotificationOutbox, IdempotencyRecords) ใช้ UUIDv5 ที่คำนวณได้เหมือนกันทุกแพลตฟอร์ม');
  L.push('- **student_code** เป็น business key แบบ string ไม่ซ้ำภายในโรงเรียน รักษาเลขศูนย์นำหน้า (เช่น `00123`)');
  L.push('- **วันที่** เก็บเป็น ค.ศ. `YYYY-MM-DD`; **timestamp** เก็บ UTC ISO 8601 พร้อมมิลลิวินาที `YYYY-MM-DDTHH:mm:ss.sssZ`; `school_date` อนุมานด้วยเขตเวลา Asia/Bangkok (UTC+7 คงที่ ไม่มี DST) แยกจาก timestamp; แปลงเป็น พ.ศ. เฉพาะชั้นแสดงผล');
  L.push('- **ช่วงเวลา** ใช้ half-open `[start, end)` ทั้งระบบ (`effective_to`/`end_date` ไม่รวม; ค่าว่าง = ไม่มีกำหนดสิ้นสุด)');
  L.push('- **enum** เก็บค่าคงที่ภาษาอังกฤษ ไม่ใช้ข้อความภาษาไทยเป็นรหัส');
  L.push('- **ความสัมพันธ์** ใช้ตาราง (เช่น StudentGuardians) ไม่เก็บหลายค่าคั่น comma ในเซลล์; json ใช้เฉพาะ metadata/config ที่มี schema');
  L.push('- **ตารางที่แก้ไขได้** มี `created_at, created_by, updated_at, updated_by, version` (optimistic concurrency) และสถานะ/ฟิลด์ lifecycle ตามชนิดข้อมูล');
  L.push('- **ตาราง event/audit (kind = EVENT)** เป็น append-only การแก้ไขใช้แถวใหม่ที่อ้าง `supersedes_*` แทนการลบ/เขียนทับ (PostgreSQL บังคับด้วย trigger)');
  L.push('- **projection** (DailyAttendance) สร้างใหม่ได้จากข้อมูลต้นทาง ไม่ใช้สูตรใน Sheet');
  L.push('- **created_by/updated_by** อ้าง Users แบบ soft reference (ไม่บังคับ FK) เพื่อให้ระบบ/งานเบื้องหลังบันทึกได้ด้วย system principal `00000000-0000-4000-8000-000000000001` และหลีกเลี่ยงวงอ้างอิง');
  L.push('');
  L.push('## 2. การแทนค่า (canonical JSON ↔ Google Sheets ↔ PostgreSQL)');
  L.push('');
  L.push('| ชนิด | canonical JSON (portable/API) | Google Sheets cell | PostgreSQL |');
  L.push('|---|---|---|---|');
  L.push("| null (ไม่มีค่า) | `null` | เซลล์ว่าง | `NULL` |");
  L.push("| string/text/enum/hhmm/uuid | string | ข้อความนำหน้าด้วย `'` เสมอ (บังคับเป็นข้อความ: รักษา `00123`, กัน `=`/`+`/`-`/`@` ถูกตีความเป็นสูตร) | `text`/`uuid` + CHECK |");
  L.push("| empty string | **ไม่อนุญาต** — normalize เป็น `null` ที่ชั้น validation (Sheets แยกไม่ได้ระหว่างว่างกับ \"\") | — | CHECK `<> ''` |");
  L.push("| int | number (integer) | ตัวเลข | `integer` |");
  L.push("| bool | `true`/`false` | TRUE/FALSE (boolean) | `boolean` |");
  L.push("| date | `\"2026-10-10\"` | ข้อความ `'2026-10-10` | `date` |");
  L.push("| timestamp | `\"2026-10-10T01:42:00.000Z\"` | ข้อความ ISO | `timestamptz` |");
  L.push("| json | object/array | ข้อความ JSON (≤ 45,000 ตัวอักษร ต่ำกว่าขีดจำกัด 50,000 ต่อเซลล์) | `jsonb` |");
  L.push('');
  L.push('การตรวจ round-trip ของการแทนค่าใน Sheets จริงทำได้ด้วยฟังก์ชัน editor `adminSelfTest()` (ดู docs/INSTALL_GAS_TH.md) — ผลบน Apps Script จริงยังเป็นรายการ UAT ที่ต้องทำบนบัญชีโรงเรียน');
  L.push('');
  L.push('## 3. ระดับความอ่อนไหวและ retention');
  L.push('');
  L.push('| sensitivity | ความหมาย |');
  L.push('|---|---|');
  L.push('| PUBLIC | เปิดเผยได้ภายในโรงเรียน (ชื่อห้อง ปฏิทิน) |');
  L.push('| INTERNAL | ข้อมูลการทำงานภายใน |');
  L.push('| PERSONAL | ข้อมูลส่วนบุคคล ต้องตรวจสิทธิ์ตามขอบเขตนักเรียน |');
  L.push('| SENSITIVE | ข้อมูลอ่อนไหว (สุขภาพ การช่วยเหลือ audit) เข้าถึงเฉพาะสิทธิ์เฉพาะ |');
  L.push('| SECRET | ค่าตรวจสอบความลับ (hash ของคำเชิญ/nonce) ไม่ export ไม่แสดง |');
  L.push('');
  L.push('รหัส retention เป็น **ค่าเสนอเริ่มต้น** ที่โรงเรียนต้องยืนยันตามนโยบาย (ดู docs/OPERATIONS_TH.md §Retention): ' +
    [...new Set(TABLES.map((t) => t.retention))].sort().map((r) => `\`${r}\``).join(', '));
  L.push('');
  L.push('## 4. ลำดับ dependency (สำหรับ import/restore)');
  L.push('');
  L.push(dependencyOrder().map((n, i) => `${i + 1}. ${n}`).join('\n'));
  L.push('');
  L.push('## 5. Partition และ workbook (Google Sheets adapter)');
  L.push('');
  L.push('| ตาราง | partition | คอลัมน์ที่ใช้คำนวณ | workbook |');
  L.push('|---|---|---|---|');
  for (const t of TABLES) L.push(`| ${t.name} | ${t.partition} | ${t.partitionColumn || '-'} | ${t.partition === 'TERM' ? ({ DAILY: 'Daily', NOTIFY: 'Notify', OPS: 'Ops' }[t.workbook] + ' (ต่อภาคเรียน)') : 'Master'} |`);
  L.push('');
  L.push('Partition key = รหัสภาคเรียน (`Terms.code` เช่น `AY2026-T1`); วันที่นอกภาคเรียนเข้าภาคเรียนล่าสุดก่อนหน้า; StorageCatalog เป็นผู้ map ไป workbook/sheet; ประเมินขนาดด้วย `npm run capacity` (docs/CAPACITY.md)');
  L.push('');
  L.push('## 6. ตาราง');
  L.push('');
  const groups = [...new Set(TABLES.map((t) => t.group))];
  for (const gname of groups) {
    L.push(`### กลุ่ม ${gname}`);
    L.push('');
    for (const t of TABLES.filter((x) => x.group === gname)) {
      L.push(`#### ${t.name} (\`${SQL_TABLE[t.name]}\`)`);
      L.push('');
      L.push(t.description_th);
      L.push('');
      L.push(`- kind: **${t.kind}** · partition: **${t.partition}**${t.partitionColumn ? ` (${t.partitionColumn})` : ''} · sensitivity: **${t.sensitivity}** · retention: \`${t.retention}\``);
      const uq = uniqueKeys(t.name);
      L.push(`- unique: ${uq.length ? uq.map((u) => `(${u.columns.join(', ')})${u.where ? ` WHERE ${u.where}` : ''}${u.nullsNotDistinct ? ' NULLS NOT DISTINCT' : ''}`).join('; ') : '—'}`);
      if (t.checks) L.push(`- checks: ${t.checks.map((c) => `\`${c}\``).join('; ')}`);
      if (t.exclusion) L.push(`- exclusion: ห้ามช่วง [${t.exclusion.range.join(', ')}) ซ้อนกันต่อ ${t.exclusion.columns.join(', ')}`);
      L.push(`- lookup/index (access pattern): ${[...(t.lookup || []), ...(t.indexes || []).map((i) => i.join('+'))].join(', ') || 'by id'}${t.accessPatterns ? ` — ${t.accessPatterns.join('; ')}` : ''}`);
      L.push('');
      L.push('| คอลัมน์ | ชนิด | required | ข้อจำกัด | คำอธิบาย |');
      L.push('|---|---|---|---|---|');
      for (const c of t.columns) L.push(`| ${c.name} | ${typeLabel(c)} | ${c.required ? '✔' : ''} | ${esc(constraintLabel(c))} | ${esc(c.description_th || '')} |`);
      L.push('');
    }
  }
  L.push('## 7. Enumerations');
  L.push('');
  for (const [name, en] of Object.entries(ENUMS)) {
    L.push(`- **${name}**: ${en.values.map((v) => `\`${v}\` ${en.th[v]}`).join(' · ')}`);
  }
  L.push('');
  L.push('## 8. โมดูลเสริม (ปิดไว้ — ยังไม่ส่งมอบ)');
  L.push('');
  for (const m of OPTIONAL_MODULES) L.push(`- \`${m.flag}\`: ต้องเพิ่มตาราง ${m.tables.join(', ')} — ต้องมี ${m.needs_th}`);
  L.push('');
  return L.join('\n');
}

// ───────── PERMISSIONS.md ─────────
function permissionsDoc() {
  const roles = ENUMS.Role.values;
  const L = [];
  L.push('# Permissions — action × role × data scope');
  L.push('');
  L.push('> สร้างอัตโนมัติจาก `src/domain/permissions.js` (`npm run gen`). Server ตรวจสิทธิ์ทุก operation รวมการค้นหา รายงาน export และไฟล์แนบ — ไม่เชื่อ role/user_id ที่ client ส่งมา');
  L.push('');
  L.push('## ขอบเขตข้อมูล (scope)');
  L.push('');
  L.push('| scope | ความหมาย |');
  L.push('|---|---|');
  L.push('| SCHOOL | นักเรียนทั้งโรงเรียน |');
  L.push('| SCHOOL_BASIC | นักเรียนทุกคน เฉพาะข้อมูลระบุตัว (ชื่อ รหัส ห้อง รูป) สำหรับงานประตู |');
  L.push('| CLASS:HOMEROOM | นักเรียนที่อยู่ในห้องที่เป็นครูที่ปรึกษา (ตาม enrollment ของวันที่เกี่ยวข้อง) รวมการรักษาการแทนที่มีผล |');
  L.push('| CLASS:TEACHING | นักเรียนในห้องที่สอน |');
  L.push('| LINKED(x) | นักเรียนที่มีความสัมพันธ์ผู้ปกครองที่เจ้าหน้าที่ยืนยัน (ACTIVE) ยังมีผล และให้สิทธิ์ x |');
  L.push('| SELF | ข้อมูลของนักเรียนเอง |');
  L.push('| OWN | ทรัพยากรของผู้ใช้เอง (คำขอที่ตนยื่น การแจ้งเตือนของตน งานของตน) |');
  L.push('| SYSTEM | งานระบบ ไม่รวมสิทธิ์ดูข้อมูลนักเรียน |');
  L.push('');
  L.push('## Matrix');
  L.push('');
  L.push(`| action | คำอธิบาย | ${roles.join(' | ')} |`);
  L.push(`|---|---|${roles.map(() => '---').join('|')}|`);
  for (const [action, th] of Object.entries(ACTIONS)) {
    const cells = roles.map((r) => {
      const gs = GRANTS.filter((g) => g.action === action && g.role === r);
      return gs.map((g) => (g.scope === 'CLASS' ? `CLASS:${g.classSource}` : g.scope === 'LINKED' ? `LINKED(${g.guardianPermission})` : g.scope)).join(', ') || '—';
    });
    L.push(`| \`${action}\` | ${esc(th)} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push('## ตัวอย่างข้อห้ามที่มี automated test (tests/domain/permissions.test.mjs, tests/application/*)');
  L.push('');
  L.push('- ผู้ปกครองของนักเรียน A อ่าน/ค้นหา/ดาวน์โหลด/แจ้งลาให้นักเรียน B ไม่ได้ แม้แก้ payload หรือเรียก RPC ตรง');
  L.push('- ครูเวร/เจ้าหน้าที่ประตูเห็นเฉพาะข้อมูลระบุตัว ไม่มี `report.export` หรือ `migration.export`');
  L.push('- SYSTEM_ADMIN ไม่มีสิทธิ์ดูข้อมูลนักเรียน/เอกสารลับ เว้นแต่ได้รับบทบาทงานข้อมูลเพิ่ม (เช่น STUDENT_AFFAIRS)');
  L.push('- EXECUTIVE ไม่มีสิทธิ์แก้ไขย้อนหลัง (`attendance.correct`) หรืออนุมัติใบลา');
  L.push('- ครูประจำวิชาไม่เห็นเอกสารสุขภาพ (`attachment.read_sensitive`) และข้อมูลติดต่อผู้ปกครอง');
  L.push('- นักเรียน/ผู้ปกครองกำหนด role หรือ student_id ที่จะเข้าถึงเองไม่ได้ — ความสัมพันธ์มาจากเจ้าหน้าที่ยืนยันและคำเชิญเท่านั้น');
  L.push('- การสมัครบัญชีกับผู้ให้บริการยืนยันตัวตนสำเร็จ ยังไม่มีบทบาทใด ๆ จนกว่าจะใช้คำเชิญ');
  L.push('');
  return L.join('\n');
}

// ───────── STATE_MACHINES.md ─────────
function stateMachinesDoc() {
  const L = ['# State Machines', '', '> สร้างอัตโนมัติจาก `src/domain/state-machines.js` — service ใช้ตารางเดียวกันนี้บังคับการเปลี่ยนสถานะ (`assertTransition`)', ''];
  for (const [name, m] of Object.entries(MACHINES)) {
    L.push(`## ${name} — \`${m.entity}\``, '', m.note_th, '');
    L.push('| from | action | allowed role | precondition | to | audit | side effects |');
    L.push('|---|---|---|---|---|---|---|');
    for (const t of m.transitions) L.push(`| ${t.from.join(', ')} | ${t.action} | ${t.roles.join(', ')} | ${esc(t.precondition_th)} | ${t.to.join(' / ')} | ${t.audit ? '✔' : 'attempt log'} | ${esc(t.side_effects_th)} |`);
    L.push('');
  }
  return L.join('\n');
}

// ───────── generate ─────────
emit('DATA_DICTIONARY.md', dataDictionary());
emit('PERMISSIONS.md', permissionsDoc());
emit('docs/STATE_MACHINES.md', stateMachinesDoc());
emit('database/postgres/migrations/0001_init.sql', generateInitSql());
emit('database/postgres/roles.sql', generateRolesSql());
for (const t of TABLES) emit(`schema/tables/${t.name}.schema.json`, JSON.stringify(tableJsonSchema(t.name), null, 2));
emit('schema/enums.json', JSON.stringify(Object.fromEntries(Object.entries(ENUMS).map(([k, v]) => [k, { values: v.values, th: v.th }])), null, 2));
emit('schema/dependency-order.json', JSON.stringify({ schema_version: SCHEMA_VERSION, order: dependencyOrder() }, null, 2));

// Optional generators registered by later layers (API contract, portable format schemas).
const extraDir = path.join(ROOT, 'tools', 'gen');
if (fs.existsSync(extraDir)) {
  for (const f of fs.readdirSync(extraDir).filter((x) => x.endsWith('.mjs')).sort()) {
    const mod = await import(path.join(extraDir, f));
    for (const [rel, content] of Object.entries(await mod.generate())) emit(rel, content);
  }
}

let drift = 0;
for (const [rel, content] of outputs) {
  const abs = path.join(ROOT, rel);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (CHECK) {
    if (current !== content) { console.error(`DRIFT: ${rel}`); drift++; }
  } else if (current !== content) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    console.log(`wrote ${rel}`);
  }
}
if (CHECK) {
  if (drift) { console.error(`${drift} generated file(s) out of date — run npm run gen`); process.exit(1); }
  console.log(`generated files up to date (${outputs.size})`);
}

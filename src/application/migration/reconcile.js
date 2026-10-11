// Reconciliation (MASTER_PROMPT §15.6): compare a validated package with an import target and produce a
// PASS/FAIL report with mismatch details. READY_TO_CUTOVER is reported only when every check passes AND the
// package is a COMPLETE FULL_SNAPSHOT.
//
// target (generator methods; values may be promises under runAsync):
//   name                        'memory' | 'sheets' | 'postgres'
//   *rows(table)                → canonical records of the whole table in the target
//   *physicalPartitions(table)  → Map partition → row count (stores with partitions) or null
//   *attachmentBytes(id)        → {bytes, mappings} | null   (ACTIVE storage mappings of the logical file)
//   *sampleDeps()               → deps {store, clock, ids, crypto, config} used to recompute report totals
//   *extraChecks()              → [{key, status, detail_th}] platform-specific (e.g. SQL FK orphans)
import { getTable } from '../../schema/index.js';
import { canonicalStringify, utf8Decode } from '../../shared/canonical-json.js';
import { formatThaiDate } from '../../shared/thai-format.js';
import { partitionFor } from '../changeset.js';
import { readManifest, ProcessReport } from './process.js';
import { recordLine, accumulate, newTableAcc, canonicalRecord, EXCLUDED_TABLES, LIVE_TABLES } from './format.js';
import { sampleContext, computeReports, computePermissionSamples } from './samples.js';

const TERMINAL_DELIVERY = new Set(['PROVIDER_ACCEPTED', 'FAILED_FINAL', 'CANCELLED']);
/** Rows the import itself may add to the target (bookkeeping), never business data. */
export const TARGET_ONLY_ALLOWED = new Set(['MigrationRuns', 'MigrationCheckpoints']);

/** Relationship summaries compared explicitly (MASTER_PROMPT §15.6). */
const GROUPS = {
  Enrollments: { key_th: 'ประวัติห้องต่อนักเรียน', fn: (r) => `${r.student_id}|${r.class_id}|${r.effective_from}|${r.effective_to || ''}` },
  StudentGuardians: { key_th: 'ความสัมพันธ์ผู้ปกครองต่อนักเรียน (สถานะ/สิทธิ์)', fn: (r) => `${r.student_id}|${r.guardian_id}|${r.status}|${canonicalStringify(r.permitted_actions || [])}` },
  LeaveApprovals: { key_th: 'ลำดับการพิจารณาใบลา', fn: (r) => `${r.leave_request_id}|${r.step_no}|${r.decision}|${r.revision_no}` },
  AttendanceCorrections: { key_th: 'การแก้ไขย้อนหลังและเหตุการณ์ที่เกิดขึ้น', fn: (r) => `${r.student_id}|${r.school_date}|${r.status}|${r.resulting_event_id || ''}` },
  NotificationOutbox: { key_th: 'สถานะการส่งและการกันส่งซ้ำ', fn: (r) => `${r.delivery_state}|${r.replay_blocked}` },
  NotificationRecipients: { key_th: 'สถานะการรับทราบ', fn: (r) => `${r.ack_state}|${r.in_app_state}` },
};

function* readChunkRecords(handle, chunk, sha) {
  const b = yield handle.readBytes(chunk.path);
  if (!b || sha(b) !== chunk.sha256) return null;
  const text = utf8Decode(b);
  return text.length ? text.slice(0, -1).split('\n') : [];
}

function dateColumns(table) {
  return getTable(table).columns.filter((c) => c.type === 'date' || c.type === 'ts').map((c) => c.name);
}

function ranges(table, recs) {
  const out = {};
  for (const col of dateColumns(table)) {
    let min = null;
    let max = null;
    for (const r of recs) {
      const v = r[col];
      if (v === null || v === undefined) continue;
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
    }
    if (min !== null) out[col] = { min, max };
  }
  return out;
}

function groupCounts(table, recs) {
  const g = GROUPS[table];
  if (!g) return null;
  const m = {};
  for (const r of recs) { const k = g.fn(r); m[k] = (m[k] || 0) + 1; }
  return m;
}

/**
 * @returns {{done:boolean, result?:object}}
 */
export function* reconcile(handle, target, opts) {
  const sha = opts.sha256Hex;
  const checks = [];
  const add = (key, ok, detail_th, data = null) => checks.push({ key, status: ok === null ? 'SKIPPED' : ok ? 'PASS' : 'FAIL', detail_th, ...(data ? { data } : {}) });
  const pr = new ProcessReport('RECONCILE');
  const m = yield* readManifest(handle, sha, pr);
  if (!m || pr.errors.length) {
    return { done: true, result: { format: 'cwk-reconciliation', overall: 'FAIL', ready_to_cutover: false, target: target.name, reconciled_at: opts.now, checks: [{ key: 'manifest', status: 'FAIL', detail_th: 'อ่าน manifest ไม่ได้หรือ checksum ไม่ตรง', data: pr.errors.slice(0, 10) }], tables: [] } };
  }
  const { manifest, manifest_sha256 } = m;
  const tables = [];
  const mismatchSamples = [];
  let terms = [];
  const tz = manifest.snapshot.timezone;
  const pkgRanges = {};
  const tgtRanges = {};
  for (const tm of manifest.tables) {
    const table = tm.name;
    // package side
    const pkg = new Map();
    const pkgRecs = [];
    const logicalPkg = {};
    let unreadable = 0;
    for (const p of tm.partitions) {
      for (const c of p.chunks) {
        const lines = yield* readChunkRecords(handle, c, sha);
        if (!lines) { unreadable++; continue; }
        for (const l of lines) {
          const r = JSON.parse(l);
          pkg.set(r.id, l);
          pkgRecs.push(r);
        }
      }
    }
    if (table === 'Terms') terms = pkgRecs;
    // target side
    const rows = yield* target.rows(table);
    const seen = new Map();
    let dupIds = 0;
    for (const r of rows) { if (seen.has(r.id)) dupIds++; seen.set(r.id, r); }
    const acc = newTableAcc();
    let missing = 0;
    let mismatched = 0;
    const inPkg = [];
    for (const [id, line] of pkg) {
      const t = seen.get(id);
      if (!t) { missing++; if (mismatchSamples.length < 50) mismatchSamples.push({ table, id, issue: 'MISSING_IN_TARGET' }); continue; }
      const tl = recordLine(t);
      accumulate(acc, table, t, sha, tl);
      inPkg.push(t);
      if (tl !== line) { mismatched++; if (mismatchSamples.length < 50) mismatchSamples.push({ table, id, issue: 'DIFFERENT_VALUES' }); }
    }
    const targetOnly = [...seen.keys()].filter((id) => !pkg.has(id)).length;
    const logical = (recs) => {
      const out = {};
      if (getTable(table).partition !== 'TERM') return out;
      for (const r of recs) { const k = partitionFor(table, r, terms, tz); out[k] = (out[k] || 0) + 1; }
      return out;
    };
    Object.assign(logicalPkg, logical(pkgRecs));
    const logicalTgt = logical(inPkg);
    let physicalOk = null;
    const phys = target.physicalPartitions ? yield* target.physicalPartitions(table) : null;
    if (phys) {
      physicalOk = tm.partitions.every((p) => (phys.get(p.key) || 0) >= p.row_count) && (targetOnly > 0 || tm.partitions.every((p) => (phys.get(p.key) || 0) === p.row_count));
    }
    const gp = groupCounts(table, pkgRecs);
    const gt = groupCounts(table, inPkg);
    pkgRanges[table] = ranges(table, pkgRecs);
    tgtRanges[table] = ranges(table, inPkg);
    const row = {
      name: table, package_rows: tm.row_count, package_rows_read: pkg.size, target_rows: rows.length, missing_in_target: missing, different_values: mismatched,
      target_only: targetOnly, duplicate_ids_in_target: dupIds, unreadable_chunks: unreadable,
      digest_all_ok: acc.digest_all === tm.digest_all && acc.rows === tm.row_count, digest_source_ok: acc.digest_source === tm.digest_source && acc.rows === tm.row_count,
      logical_partitions_ok: canonicalStringify(logicalPkg) === canonicalStringify(logicalTgt), physical_partitions_ok: physicalOk,
      relationships_ok: gp ? canonicalStringify(gp) === canonicalStringify(gt) : null,
      date_ranges_ok: canonicalStringify(pkgRanges[table]) === canonicalStringify(tgtRanges[table]),
    };
    row.ok = !missing && !mismatched && !dupIds && !unreadable && pkg.size === tm.row_count && row.digest_source_ok && row.logical_partitions_ok && row.physical_partitions_ok !== false
      && row.relationships_ok !== false && row.date_ranges_ok && (targetOnly === 0 || TARGET_ONLY_ALLOWED.has(table));
    row.derived_ok = row.digest_all_ok;
    if (table === 'NotificationOutbox') {
      row.unsafe_pending = inPkg.filter((r) => !TERMINAL_DELIVERY.has(r.delivery_state) && r.replay_blocked !== true).length + rows.filter((r) => !pkg.has(r.id) && !TERMINAL_DELIVERY.has(r.delivery_state) && r.replay_blocked !== true).length;
    }
    tables.push(row);
  }
  const bad = (f) => tables.filter(f).map((t) => t.name);
  add('rows.counts', !bad((t) => t.missing_in_target || t.package_rows_read !== t.package_rows || t.unreadable_chunks).length, 'จำนวนรายการและ ID ครบทุกตาราง', { tables: bad((t) => t.missing_in_target || t.package_rows_read !== t.package_rows || t.unreadable_chunks) });
  add('rows.distinct_ids', !bad((t) => t.duplicate_ids_in_target).length, 'ไม่มี ID ซ้ำในปลายทาง', { tables: bad((t) => t.duplicate_ids_in_target) });
  add('rows.target_only', !bad((t) => t.target_only && !TARGET_ONLY_ALLOWED.has(t.name)).length, 'ไม่มีข้อมูลเกินที่ไม่ได้มาจาก package (ยกเว้นบันทึกงานย้ายข้อมูล)', { tables: bad((t) => t.target_only && !TARGET_ONLY_ALLOWED.has(t.name)) });
  add('data.source_checksum', !bad((t) => !t.digest_source_ok || t.different_values).length, 'checksum ข้อมูลต้นทาง (ไม่รวมค่าที่สร้างใหม่ได้) ตรงกัน', { tables: bad((t) => !t.digest_source_ok || t.different_values) });
  add('data.derived_checksum', !bad((t) => !t.digest_all_ok).length, 'ค่าที่สร้างใหม่ได้ (projection/ค่าค้นหา) ตรงกัน', { tables: bad((t) => !t.digest_all_ok) });
  add('data.partitions', !bad((t) => !t.logical_partitions_ok || t.physical_partitions_ok === false).length, 'จำนวนรายการต่อภาคเรียน (partition) ตรงกัน', { tables: bad((t) => !t.logical_partitions_ok || t.physical_partitions_ok === false) });
  add('data.date_ranges', !bad((t) => !t.date_ranges_ok).length, 'วันแรก/วันสุดท้ายของทุกคอลัมน์วันที่/เวลาเท่ากัน', { tables: bad((t) => !t.date_ranges_ok) });
  add('relationships', !bad((t) => t.relationships_ok === false).length, 'ประวัติห้อง ความสัมพันธ์ผู้ปกครอง ลำดับอนุมัติ การแก้ไข สถานะแจ้งเตือน ตรงกัน', { tables: bad((t) => t.relationships_ok === false) });
  const outbox = tables.find((t) => t.name === 'NotificationOutbox');
  add('outbox.no_replay', !outbox || !outbox.unsafe_pending, 'รายการแจ้งเตือนที่ยังไม่ส่งถูกกันไม่ให้ส่งซ้ำอัตโนมัติ (replay_blocked)', outbox ? { unsafe_pending: outbox.unsafe_pending } : null);
  // dates: timezone + Buddhist-era rendering of the extremes
  const school = (yield* target.rows('Schools'))[0] || null;
  const tzOk = !!school && school.timezone === tz;
  const be = [];
  for (const t of ['DailyAttendance', 'AttendanceEvents', 'LeaveSegments']) {
    const r = pkgRanges[t] && pkgRanges[t].school_date;
    const q = tgtRanges[t] && tgtRanges[t].school_date;
    if (r || q) be.push({ table: t, package: r ? `${formatThaiDate(r.min)} – ${formatThaiDate(r.max)}` : null, target: q ? `${formatThaiDate(q.min)} – ${formatThaiDate(q.max)}` : null });
  }
  add('dates.timezone_be', tzOk && be.every((x) => x.package === x.target), `เขตเวลา ${tz} และวันที่ พ.ศ. ช่วงแรก/สุดท้ายตรงกัน`, { school_timezone: school ? school.timezone : null, ranges: be });
  // attachments: real bytes in the target storage
  if (manifest.attachments.included && manifest.attachments.index) {
    const raw = yield handle.readBytes(manifest.attachments.index.path);
    const entries = raw ? utf8Decode(raw).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    let okN = 0;
    const problems = [];
    for (const e of entries) {
      const got = yield* target.attachmentBytes(e.logical_id);
      if (!got || !got.bytes) { problems.push({ id: e.logical_id, issue: 'MISSING' }); continue; }
      if (got.mappings !== 1) problems.push({ id: e.logical_id, issue: `ACTIVE_MAPPINGS_${got.mappings}` });
      else if (got.bytes.length !== e.size_bytes || sha(got.bytes) !== e.sha256) problems.push({ id: e.logical_id, issue: 'BYTES_DIFFER' });
      else okN++;
    }
    add('attachments.bytes', !problems.length && okN === manifest.attachments.files, `ไฟล์แนบ ${okN}/${manifest.attachments.files} ไฟล์ SHA-256 ของ bytes จริงตรงกัน`, { problems: problems.slice(0, 50) });
  } else add('attachments.bytes', null, 'package ไม่มีไฟล์แนบ', null);
  // business totals + permission samples recomputed on the target
  const bt = yield handle.readText('metadata/business-totals.json');
  const ps = yield handle.readText('metadata/permission-samples.json');
  if (bt && target.sampleDeps) {
    const meta = JSON.parse(bt);
    const sctx = yield* sampleContext(yield* target.sampleDeps(), meta.computed_at);
    const got = yield* computeReports(sctx, meta.reports.map((r) => ({ code: r.code, filter: r.filter })));
    const diffs = [];
    meta.reports.forEach((r, i) => { if (canonicalStringify(r) !== canonicalStringify(got[i])) diffs.push({ code: r.code, filter: r.filter, package: r, target: got[i] }); });
    add('reports.totals', !diffs.length, `ยอดรายงาน ${meta.reports.map((r) => r.code).filter((v, i, a) => a.indexOf(v) === i).join(', ')} ในวันตัวอย่าง ${meta.samples.dates.join(', ')} ตรงกัน`, { compared: meta.reports.length, differences: diffs.slice(0, 10) });
    if (ps) {
      const pm = JSON.parse(ps);
      const now = yield* computePermissionSamples(sctx, pm.users.map((u) => u.user_id), pm.date);
      const pd = pm.users.filter((u, i) => canonicalStringify(u) !== canonicalStringify(now[i])).map((u) => u.user_id);
      add('permissions.samples', !pd.length, `สิทธิ์ผู้ใช้ตัวอย่าง ${pm.users.length} คน (ทุกบทบาท รวมผู้ปกครองหลายบุตร) ตรงกัน`, { compared: pm.users.length, different_users: pd });
    } else add('permissions.samples', false, 'ไม่มี metadata/permission-samples.json', null);
  } else add('reports.totals', false, 'ไม่มี metadata/business-totals.json หรือปลายทางคำนวณรายงานไม่ได้', null);
  if (target.extraChecks) for (const x of yield* target.extraChecks()) checks.push(x);
  const overall = checks.every((c) => c.status !== 'FAIL') ? 'PASS' : 'FAIL';
  const ready = overall === 'PASS' && manifest.completeness === 'COMPLETE' && manifest.mode === 'FULL_SNAPSHOT' && manifest.kind === 'SNAPSHOT';
  return {
    done: true,
    result: {
      format: 'cwk-reconciliation', export_id: manifest.export_id, manifest_sha256, package_mode: manifest.mode, package_completeness: manifest.completeness,
      target: target.name, reconciled_at: opts.now, overall, ready_to_cutover: ready,
      ready_note_th: ready ? 'กระทบยอดผ่านทุกหัวข้อ — ทำ readiness checklist ต่อได้' : 'ยังไม่พร้อมสลับระบบ: ' + (overall !== 'PASS' ? 'มีหัวข้อที่ไม่ผ่าน' : `package เป็น ${manifest.mode}/${manifest.completeness}`),
      checks, tables, mismatches: mismatchSamples, excluded_tables: Object.keys(EXCLUDED_TABLES), live_tables: LIVE_TABLES,
    },
  };
}

// ───────── store target (memory/Sheets) ─────────

export class StoreTarget {
  constructor({ name, deps }) { this.name = name; this.deps = deps; }
  *rows(table) {
    const out = [];
    for (const p of yield this.deps.store.partitions(table)) {
      let cursor = null;
      do {
        const page = yield this.deps.store.scan(table, p, { cursor, limit: 500 });
        for (const r of page.items) out.push(canonicalRecord(table, r));
        cursor = page.next_cursor;
      } while (cursor);
    }
    return out;
  }
  *physicalPartitions(table) {
    const m = new Map();
    for (const p of yield this.deps.store.partitions(table)) m.set(p, yield this.deps.store.count(table, p));
    return m;
  }
  *attachmentBytes(id) {
    const maps = (yield this.deps.store.findBy('StorageObjectMappings', 'attachment_id', id)).filter((x) => x.status === 'ACTIVE');
    if (!maps.length || !this.deps.platform.storage) return null;
    try { return { bytes: yield this.deps.platform.storage.get(maps[0]), mappings: maps.length }; } catch (_) { return null; }
  }
  *sampleDeps() { return this.deps; }
}

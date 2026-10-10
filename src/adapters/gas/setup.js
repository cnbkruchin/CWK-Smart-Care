// Editor-only administration (MASTER_PROMPT §14: setup only by the verified installation owner,
// never through a public route). Every admin* entrypoint calls assertEditorContext() first:
//   1. Script property CWK_ADMIN_TASKS_ENABLED_UNTIL must be a UTC ISO time within the next 2 hours
//      (set manually in Project Settings — impossible for web visitors), AND
//   2. Session.getActiveUser() must equal Session.getEffectiveUser() (true in the editor; a web
//      visitor calling google.script.run on an "execute as me" deployment fails this), AND
//   3. the active user must equal CWK_INSTALL_OWNER_EMAIL once recorded.

import { TABLES, SCHEMA_VERSION } from '../../schema/index.js';
import { createWorkbook, ensureSheet, removeDefaultSheet } from './sheets-store.js';
import { encodeRow, decodeRow, headerOf } from './sheets-codec.js';
import { SYSTEM_USER_ID } from '../../shared/uuid.js';
import { schoolDateOf } from '../../shared/time.js';

const G = () => globalThis;

export function assertEditorContext() {
  const g = G();
  const props = g.PropertiesService.getScriptProperties();
  const until = props.getProperty('CWK_ADMIN_TASKS_ENABLED_UNTIL');
  const t = until ? Date.parse(until) : NaN;
  if (!until || Number.isNaN(t) || t < Date.now() || t > Date.now() + 2 * 3600 * 1000) {
    throw new Error('ADMIN_TASKS_DISABLED: ตั้งค่า Script property CWK_ADMIN_TASKS_ENABLED_UNTIL เป็นเวลา UTC ISO ไม่เกิน 2 ชั่วโมงข้างหน้า แล้วรันใหม่จาก Apps Script Editor');
  }
  const active = (g.Session.getActiveUser().getEmail() || '').toLowerCase();
  const effective = (g.Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!active || active !== effective) throw new Error('ADMIN_TASKS_EDITOR_ONLY: ฟังก์ชันนี้รันได้จาก Apps Script Editor โดยเจ้าของสคริปต์เท่านั้น');
  const owner = (props.getProperty('CWK_INSTALL_OWNER_EMAIL') || '').toLowerCase();
  if (owner && owner !== active) throw new Error('ADMIN_TASKS_OWNER_ONLY: ผู้รันไม่ใช่เจ้าของการติดตั้งที่บันทึกไว้');
  return active;
}

/** Create Drive folder + master workbook + sheets + catalog (idempotent; never clears existing data). */
export function provisionMaster({ env, ids, clock }) {
  const g = G();
  const props = g.PropertiesService.getScriptProperties();
  const report = { created: [], existing: [] };
  let rootId = props.getProperty('CWK_DRIVE_ROOT_FOLDER_ID');
  if (!rootId) {
    const folder = g.DriveApp.createFolder(`CWK Smart Care (${env}) — private`);
    rootId = folder.getId();
    props.setProperty('CWK_DRIVE_ROOT_FOLDER_ID', rootId);
    report.created.push('DriveFolder');
  }
  let masterId = props.getProperty('CWK_MASTER_SPREADSHEET_ID');
  let book;
  if (!masterId) {
    book = createWorkbook(`CWK-${env}-Master`, rootId, 'Asia/Bangkok');
    masterId = book.getId();
    props.setProperty('CWK_MASTER_SPREADSHEET_ID', masterId);
    report.created.push('MasterWorkbook');
  } else {
    book = g.SpreadsheetApp.openById(masterId);
    report.existing.push('MasterWorkbook');
  }
  const catalogSheet = ensureSheet(book, 'StorageCatalog');
  const now = clock.now();
  const last = catalogSheet.getLastRow();
  const existing = new Set();
  if (last >= 2) {
    for (const row of catalogSheet.getRange(2, 1, last - 1, headerOf('StorageCatalog').length).getValues()) {
      const r = decodeRow('StorageCatalog', row);
      existing.add(`${r.logical_table}|${r.partition_key}`);
    }
  }
  const rows = [];
  for (const t of TABLES.filter((x) => x.partition === 'NONE')) {
    const had = !!book.getSheetByName(t.name);
    ensureSheet(book, t.name);
    if (!had) report.created.push(`Sheet:${t.name}`);
    if (!existing.has(`${t.name}|*`)) {
      rows.push({
        id: ids.uuid(), logical_table: t.name, partition_key: '*', workbook_id: masterId, sheet_name: t.name, schema_version: SCHEMA_VERSION, status: 'ACTIVE',
        row_count: 0, cell_count: 0, measured_at: now, created_at: now, created_by: SYSTEM_USER_ID, updated_at: now, updated_by: SYSTEM_USER_ID, version: 1,
      });
    }
  }
  if (rows.length) catalogSheet.getRange(catalogSheet.getLastRow() + 1, 1, rows.length, headerOf('StorageCatalog').length).setValues(rows.map((r) => encodeRow('StorageCatalog', r)));
  removeDefaultSheet(book);
  g.SpreadsheetApp.flush();
  return { ...report, masterId, rootId };
}

/** Record schema version for the Sheets component (append-only, once per version). */
export function recordSchemaVersion(store, { ids, clock, appliedBy }) {
  const existing = store.findBy('SchemaVersions', 'component', 'SHEETS').some((r) => r.schema_version === SCHEMA_VERSION);
  if (existing) return false;
  const sh = store._sheet('SchemaVersions', '*');
  const now = clock.now();
  const rec = { id: ids.uuid(), component: 'SHEETS', schema_version: SCHEMA_VERSION, applied_at: now, applied_by: appliedBy, description: 'initial schema', checksum: null, created_at: now, created_by: SYSTEM_USER_ID };
  sh.getRange(sh.getLastRow() + 1, 1, 1, headerOf('SchemaVersions').length).setValues([encodeRow('SchemaVersions', rec)]);
  return true;
}

/** Idempotent trigger installation: exactly one time-driven cronTick trigger owned by the runner. */
export function installTriggers(minutes) {
  const g = G();
  const allowed = [1, 5, 10, 15, 30];
  const every = allowed.includes(Number(minutes)) ? Number(minutes) : 1;
  const existing = g.ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'cronTick');
  for (const t of existing.slice(1)) g.ScriptApp.deleteTrigger(t);
  if (existing.length) return { created: false, kept: existing[0].getUniqueId(), removed_duplicates: Math.max(0, existing.length - 1) };
  const t = g.ScriptApp.newTrigger('cronTick').timeBased().everyMinutes(every).create();
  return { created: true, trigger_id: t.getUniqueId(), every_minutes: every };
}

/** True only when invoked by one of this project's installed triggers. */
export function isProjectTrigger(e) {
  if (!e || !e.triggerUid) return false;
  return G().ScriptApp.getProjectTriggers().some((t) => String(t.getUniqueId()) === String(e.triggerUid));
}

/**
 * Self-test of storage semantics on THIS account (DATA_DICTIONARY §2): writes tricky values through the
 * same codec into a temporary spreadsheet, reads them back and reports mismatches. Run after setup and
 * before importing real data; results are UAT evidence.
 */
export function selfTestCellEncoding(rootId) {
  const g = G();
  const samples = ['00123', '=1+1', '+66812345678', '-5', '@mention', "'quoted", 'TRUE', '2026-10-10', '2026-10-10T01:42:00.000Z', 'ด.ญ. สมใจ ใจดี', '1/2/2026', '0.10', ' spaced '];
  const book = createWorkbook(`CWK-selftest-${Date.now()}`, rootId, 'Asia/Bangkok');
  try {
    const sh = book.getSheets()[0];
    sh.getRange(1, 1, samples.length, 1).setValues(samples.map((s) => [`'${s}`]));
    g.SpreadsheetApp.flush();
    const back = sh.getRange(1, 1, samples.length, 1).getValues().map((r) => r[0]);
    const results = samples.map((s, i) => ({ value: s, read_back: back[i], ok: back[i] === s, type: typeof back[i] }));
    const found = sh.getRange(1, 1, samples.length, 1).createTextFinder('00123').matchEntireCell(true).findAll().map((r) => r.getRow());
    return { ok: results.every((r) => r.ok) && found.length === 1 && found[0] === 1, results, textfinder_00123_rows: found, timezone: book.getSpreadsheetTimeZone(), school_date_now: schoolDateOf(new Date().toISOString()) };
  } finally {
    g.DriveApp.getFileById(book.getId()).setTrashed(true);
  }
}

/** Header/duplicate-id/orphan check across all catalogued sheets (read-only). */
export function schemaCheck(store) {
  const issues = [];
  for (const t of TABLES) {
    for (const p of store.partitions(t.name)) {
      let rows;
      try { rows = store._readAll(t.name, p); } catch (e) { issues.push({ table: t.name, partition: p, issue: e.message }); continue; }
      const seen = new Set();
      const drift = [];
      for (const x of rows) {
        if (seen.has(x.rec.id)) issues.push({ table: t.name, partition: p, issue: `duplicate id ${x.rec.id} (row ${x.row})` });
        seen.add(x.rec.id);
      }
      const sh = store._sheet(t.name, p);
      if (sh && sh.getLastRow() >= 2) {
        const values = sh.getRange(2, 1, Math.min(200, sh.getLastRow() - 1), headerOf(t.name).length).getValues();
        for (const v of values) decodeRow(t.name, v, drift);
        for (const d of drift.slice(0, 5)) issues.push({ table: t.name, partition: p, issue: `type drift ${d.column}: ${d.issue}` });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

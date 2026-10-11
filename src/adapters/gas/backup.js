// Nightly snapshot and restore drill on Google Drive (MASTER_PROMPT §14, OPERATIONS_TH).
// Snapshot = copies of the master + every term workbook taken under the script lock (writers wait,
// so the copies are one consistent point in time), non-secret configuration, an attachment manifest
// (ids, sizes, SHA-256 — the files themselves stay in the private folder; the portable export of
// batch 6 copies bytes), and manifest.json whose SHA-256 is recorded in BackupRuns. Everything private.
// Restore = copy a snapshot into a NEW environment, rewrite StorageCatalog to the new workbook ids,
// compare row counts with the manifest. It never overwrites the live environment.
import { SECRET_KEYS } from './config.js';
import { decodeRow, encodeRow, headerOf } from './sheets-codec.js';

const G = () => globalThis;
const NEVER_COPY_PROPS = new Set([...SECRET_KEYS, 'CWK_ADMIN_TASKS_ENABLED_UNTIL', 'CWK_INSTALL_OWNER_EMAIL', 'CWK_MASTER_SPREADSHEET_ID', 'CWK_DRIVE_ROOT_FOLDER_ID', 'CWK_REPORT_TEMPLATE_DOC_ID']);

function sub(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function catalogRows(book) {
  const sh = book.getSheetByName('StorageCatalog');
  const last = sh.getLastRow();
  if (last < 2) return { sh, rows: [] };
  const values = sh.getRange(2, 1, last - 1, headerOf('StorageCatalog').length).getValues();
  return { sh, rows: values.map((v) => decodeRow('StorageCatalog', v)) };
}

function rowCounts(book) {
  const out = {};
  for (const sh of book.getSheets()) out[sh.getName()] = Math.max(0, sh.getLastRow() - 1);
  return out;
}

export class GasBackup {
  constructor({ store, rootFolderId, crypto, env }) { Object.assign(this, { store, rootFolderId, crypto, env }); }

  /** @returns {{package_location, files, row_counts, manifest_sha256, pruned}} */
  snapshot({ runId, date, retentionDays = 30, attachments = [] }) {
    const g = G();
    const root = g.DriveApp.getFolderById(this.rootFolderId);
    const backups = sub(root, 'backups');
    const folder = backups.createFolder(`${date}-${String(runId).slice(0, 8)}`);
    const files = [];
    const counts = {};
    this.store.withLock(() => {
      this.store.recoverPending();
      const master = g.SpreadsheetApp.openById(this.store.masterId);
      const { rows } = catalogRows(master);
      const books = new Map([[this.store.masterId, { role: 'MASTER', partition: '*' }]]);
      for (const r of rows) if (!books.has(r.workbook_id)) books.set(r.workbook_id, { role: 'PARTITION', partition: r.partition_key });
      for (const [id, meta] of books) {
        const src = g.DriveApp.getFileById(id);
        const copy = src.makeCopy(src.getName(), folder);
        files.push({ role: meta.role, partition: meta.partition, source_id: id, copy_id: copy.getId(), name: src.getName() });
        const book = g.SpreadsheetApp.openById(id);
        const c = rowCounts(book);
        for (const [k, v] of Object.entries(c)) counts[`${meta.partition}/${k}`] = v;
      }
    });
    const props = g.PropertiesService.getScriptProperties().getProperties();
    const config = Object.fromEntries(Object.entries(props).filter(([k]) => k.startsWith('CWK_') && !NEVER_COPY_PROPS.has(k)));
    const configJson = JSON.stringify({ note: 'non-secret Script Properties only; secrets are re-entered at restore time', properties: config }, null, 2);
    const attJson = JSON.stringify({ note: 'attachment bytes stay in the private folder; portable export copies them', attachments }, null, 2);
    folder.createFile(g.Utilities.newBlob(configJson, 'application/json', 'config.json'));
    folder.createFile(g.Utilities.newBlob(attJson, 'application/json', 'attachments-manifest.json'));
    const manifest = { format: 'cwk-sheets-snapshot', version: 1, env: this.env, run_id: runId, created_for_date: date, files, row_counts: counts, config_sha256: this.crypto.sha256Hex(configJson), attachments_manifest_sha256: this.crypto.sha256Hex(attJson), attachment_count: attachments.length };
    const manifestJson = JSON.stringify(manifest, null, 2);
    folder.createFile(g.Utilities.newBlob(manifestJson, 'application/json', 'manifest.json'));
    const pruned = this.prune(backups, retentionDays, folder.getId());
    return { package_location: folder.getId(), files, row_counts: counts, manifest_sha256: this.crypto.sha256Hex(manifestJson), pruned };
  }

  /** Trash snapshot folders older than retentionDays (Drive trash keeps them recoverable for a while). */
  prune(backups, retentionDays, keepId) {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().slice(0, 10);
    const it = backups.getFolders ? backups.getFolders() : { hasNext: () => false };
    let n = 0;
    while (it.hasNext()) {
      const f = it.next();
      const day = String(f.getName()).slice(0, 10);
      if (f.getId() !== keepId && /^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) { f.setTrashed(true); n++; }
    }
    return n;
  }
}

/**
 * Restore a snapshot folder into the CURRENT (new, empty) environment. Refuses when this project
 * already has a master spreadsheet. Returns a comparison of row counts against the manifest.
 */
export function restoreSnapshot(folderId, { crypto }) {
  const g = G();
  const props = g.PropertiesService.getScriptProperties();
  if (props.getProperty('CWK_MASTER_SPREADSHEET_ID')) throw new Error('RESTORE_REFUSED: this environment already has data (CWK_MASTER_SPREADSHEET_ID set) — restore only into a new project/environment');
  const started = Date.now();
  const src = g.DriveApp.getFolderById(folderId);
  const it = src.getFilesByName('manifest.json');
  if (!it.hasNext()) throw new Error('RESTORE_REFUSED: manifest.json not found in the folder');
  const manifestJson = it.next().getBlob().getDataAsString();
  const manifest = JSON.parse(manifestJson);
  if (manifest.format !== 'cwk-sheets-snapshot' || manifest.version !== 1) throw new Error('RESTORE_REFUSED: unsupported snapshot format');
  const env = props.getProperty('CWK_ENV') || 'DEV';
  const root = g.DriveApp.createFolder(`CWK Smart Care (${env}) — private — restored ${manifest.created_for_date}`);
  const map = new Map();
  let masterId = null;
  for (const f of manifest.files) {
    const copy = g.DriveApp.getFileById(f.copy_id).makeCopy(f.name.replace(/^CWK-[A-Z]+-/, `CWK-${env}-`), root);
    map.set(f.source_id, copy.getId());
    if (f.role === 'MASTER') masterId = copy.getId();
  }
  if (!masterId) throw new Error('RESTORE_REFUSED: snapshot has no master workbook');
  // point the catalog of the restored master at the restored workbooks
  const master = g.SpreadsheetApp.openById(masterId);
  const { sh, rows } = catalogRows(master);
  if (rows.length) {
    const fixed = rows.map((r) => encodeRow('StorageCatalog', { ...r, workbook_id: map.get(r.workbook_id) || r.workbook_id }));
    sh.getRange(2, 1, fixed.length, headerOf('StorageCatalog').length).setValues(fixed);
  }
  const cfg = src.getFilesByName('config.json');
  const restoredProps = cfg.hasNext() ? JSON.parse(cfg.next().getBlob().getDataAsString()).properties || {} : {};
  for (const [k, v] of Object.entries(restoredProps)) if (!props.getProperty(k) && k !== 'CWK_ENV') props.setProperty(k, v);
  props.setProperty('CWK_MASTER_SPREADSHEET_ID', masterId);
  props.setProperty('CWK_DRIVE_ROOT_FOLDER_ID', root.getId());
  // verify: row counts per workbook/sheet equal the manifest
  const after = {};
  for (const f of manifest.files) {
    const book = g.SpreadsheetApp.openById(map.get(f.source_id));
    for (const [k, v] of Object.entries(rowCounts(book))) after[`${f.partition}/${k}`] = v;
  }
  const mismatches = Object.keys(manifest.row_counts).filter((k) => manifest.row_counts[k] !== after[k]).map((k) => ({ sheet: k, expected: manifest.row_counts[k], actual: after[k] ?? null }));
  return {
    restored_root_folder_id: root.getId(), master_id: masterId, workbooks: manifest.files.length, manifest_sha256: crypto.sha256Hex(manifestJson),
    row_count_check: mismatches.length ? 'MISMATCH' : 'OK', mismatches, minutes: Math.round((Date.now() - started) / 600) / 100,
    next_steps_th: ['ใส่ secrets ของ environment ใหม่ใน Script Properties (ไม่ได้คัดลอกมา)', 'รัน adminSchemaCheck และ adminInstallTriggers', 'ไฟล์แนบยังอยู่ในโฟลเดอร์ต้นทาง (เจ้าของเดียวกันเปิดได้) — ย้ายข้ามบัญชีใช้ portable export (ชุดที่ 6)', 'บันทึกผลและเวลาที่ใช้ด้วย backup.recordRestoreTest ใน environment ต้นทาง'],
  };
}

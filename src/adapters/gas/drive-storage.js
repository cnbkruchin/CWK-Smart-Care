// AttachmentStorage on Google Drive. Folders are private to the script owner; files are NEVER shared
// with "anyone with the link" — downloads go through the permission-checked RPC (attachment.download).
//   <root>/staging/   new uploads; the daily cleanup job (jobs/files-jobs.js) moves linked files to files/YYYY
//                     and trashes files older than 24 h that no Attachments row references
//   <root>/files/YYYY/ linked attachments
//   <root>/exports/   portable packages and backups (sub-folder per run)
//   <root>/reports/   generated report files

import { AppError } from '../../shared/errors.js';

const G = () => globalThis;

function childFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

export class DriveAttachmentStorage {
  constructor({ rootFolderId }) {
    if (!rootFolderId) throw new AppError('CONFIGURATION_REQUIRED', 'drive root folder missing', { messageTh: 'ยังไม่ได้ตั้งค่าโฟลเดอร์ Google Drive' });
    this.rootFolderId = rootFolderId;
  }

  _root() { return G().DriveApp.getFolderById(this.rootFolderId); }

  folder(path) {
    let f = this._root();
    for (const part of path.split('/').filter(Boolean)) f = childFolder(f, part);
    return f;
  }

  put(logicalId, bytes, meta = {}) {
    const U = G().Utilities;
    const folder = meta.folderPath ? this.folder(meta.folderPath) : meta.staged ? this.folder('staging') : this.folder(`files/${new Date().getUTCFullYear()}`);
    const blob = U.newBlob(Array.from(bytes, (b) => (b > 127 ? b - 256 : b)), meta.mime || 'application/octet-stream', `${logicalId}`);
    const file = folder.createFile(blob);
    file.setDescription && file.setDescription(`CWK logical file ${logicalId}`);
    return { provider: 'GOOGLE_DRIVE', object_key: file.getId(), container: folder.getId(), size: bytes.length };
  }

  get(mapping) {
    try {
      const bytes = G().DriveApp.getFileById(mapping.object_key).getBlob().getBytes();
      return Uint8Array.from(bytes, (b) => b & 0xff);
    } catch (e) {
      throw new AppError('STORAGE_UNAVAILABLE', 'drive object unavailable', { messageTh: 'ไม่สามารถอ่านไฟล์จาก Google Drive' });
    }
  }

  delete(mapping) {
    try { G().DriveApp.getFileById(mapping.object_key).setTrashed(true); } catch (_) { /* already gone */ }
    return true;
  }

  metadata(mapping) {
    try {
      const f = G().DriveApp.getFileById(mapping.object_key);
      return { size: f.getSize(), mime: f.getMimeType(), trashed: f.isTrashed() };
    } catch (_) {
      return null;
    }
  }

  isStaged(mapping) {
    if (!this._stagingId) this._stagingId = this.folder('staging').getId();
    return mapping.container === this._stagingId;
  }

  /** Files in staging (kept small by promote): {items:[{logical_id, object_key, created_at}], next_after: null}. */
  listStaged({ limit = 5000 } = {}) {
    const it = this.folder('staging').getFiles();
    const items = [];
    while (it.hasNext() && items.length < limit) {
      const f = it.next();
      items.push({ logical_id: f.getName(), object_key: f.getId(), created_at: new Date(f.getDateCreated().getTime()).toISOString() });
    }
    return { items, next_after: null };
  }

  /** Move a staged object to the permanent folder once linked. */
  promote(mapping) {
    const f = G().DriveApp.getFileById(mapping.object_key);
    const target = this.folder(`files/${new Date().getUTCFullYear()}`);
    f.moveTo(target);
    return { ...mapping, container: target.getId() };
  }

  /** Write a text/binary file into a folder path (export packages). Returns Drive file id. */
  writeFile(folderPath, name, content, mime) {
    const U = G().Utilities;
    const folder = this.folder(folderPath);
    const blob = typeof content === 'string' ? U.newBlob(content, mime || 'text/plain', name) : U.newBlob(Array.from(content, (b) => (b > 127 ? b - 256 : b)), mime || 'application/octet-stream', name);
    const existing = folder.getFilesByName(name);
    while (existing.hasNext()) existing.next().setTrashed(true);
    return folder.createFile(blob).getId();
  }

  readFile(folderPath, name) {
    const folder = this.folder(folderPath);
    const it = folder.getFilesByName(name);
    if (!it.hasNext()) return null;
    return Uint8Array.from(it.next().getBlob().getBytes(), (b) => b & 0xff);
  }

  listFiles(folderPath) {
    const folder = this.folder(folderPath);
    const out = [];
    const it = folder.getFiles();
    while (it.hasNext()) { const f = it.next(); out.push({ id: f.getId(), name: f.getName(), size: f.getSize() }); }
    return out;
  }
}

/**
 * XLSX → rows using the Drive advanced service conversion (upload as Google Sheets, read values,
 * delete the temporary file). Requires "Drive API" advanced service enabled in appsscript.json.
 */
export function parseXlsxViaDrive(bytes, tempFolderId) {
  const g = G();
  if (!g.Drive || !g.Drive.Files) throw new AppError('FEATURE_DISABLED', 'Drive advanced service not enabled', { messageTh: 'ยังไม่ได้เปิด Drive API (advanced service) — ใช้ไฟล์ CSV แทนได้' });
  const blob = g.Utilities.newBlob(Array.from(bytes, (b) => (b > 127 ? b - 256 : b)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'cwk-import.xlsx');
  const file = g.Drive.Files.create({ name: `cwk-import-temp-${Date.now()}`, mimeType: 'application/vnd.google-apps.spreadsheet', parents: tempFolderId ? [tempFolderId] : undefined }, blob);
  try {
    const sheet = g.SpreadsheetApp.openById(file.id).getSheets()[0];
    // display values keep what the user saw (e.g. 00123 formatted as text) — typing happens in the import mapping
    return sheet.getDataRange().getDisplayValues();
  } finally {
    try { g.Drive.Files.remove(file.id); } catch (_) { g.DriveApp.getFileById(file.id).setTrashed(true); }
  }
}

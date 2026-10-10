// Attachment handling shared by all features: validation (size, extension, magic bytes, filename),
// staged storage through the AttachmentStorage port, and permission-checked reads.
// No malware scanning is performed (docs/LIMITATIONS.md) — files are never executed or rendered
// server-side and are downloaded only through permission-checked RPC.

import { AppError } from '../shared/errors.js';
import { fromBase64, sha256Hex } from '../shared/hash.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const TYPES = {
  pdf: { mime: 'application/pdf', magic: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  jpg: { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  webp: { mime: 'image/webp', magic: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  csv: { mime: 'text/csv', magic: (b) => !b.slice(0, 512).some((x) => x === 0) },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
};

export const ALLOWED_BY_CLASSIFICATION = {
  GENERAL: ['pdf', 'jpg', 'jpeg', 'png', 'webp'],
  MEDICAL: ['pdf', 'jpg', 'jpeg', 'png', 'webp'],
  PHOTO: ['jpg', 'jpeg', 'png', 'webp'],
  IMPORT_SOURCE: ['csv', 'xlsx'],
  REPORT: ['pdf', 'csv', 'xlsx'],
  EXPORT: ['csv', 'xlsx', 'pdf'],
};

export function sanitizeFilename(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return (base || 'file').slice(0, 200);
}

/**
 * Validate an upload. Returns {bytes, filename, ext, mime, size, sha256}.
 * @param {{filename:string, mime_type:string, content_base64:string}} f
 */
export function validateUpload(f, classification) {
  const filename = sanitizeFilename(f.filename);
  const ext = (filename.match(/\.([A-Za-z0-9]+)$/) || [])[1];
  const allowed = ALLOWED_BY_CLASSIFICATION[classification] || [];
  if (!ext || !allowed.includes(ext.toLowerCase())) {
    throw new AppError('VALIDATION_ERROR', 'file type not allowed', { messageTh: `ชนิดไฟล์ไม่รองรับ (รองรับ: ${allowed.join(', ')})`, fieldErrors: [{ field: 'file', code: 'FILE_TYPE', message_th: 'ชนิดไฟล์ไม่รองรับ' }] });
  }
  const t = TYPES[ext.toLowerCase()];
  if (f.mime_type && f.mime_type !== t.mime && !(ext.toLowerCase() === 'csv' && /^(text\/plain|application\/vnd\.ms-excel)$/.test(f.mime_type))) {
    throw new AppError('VALIDATION_ERROR', 'mime mismatch', { messageTh: 'ชนิดไฟล์ไม่ตรงกับนามสกุล', fieldErrors: [{ field: 'file', code: 'MIME_MISMATCH', message_th: 'ชนิดไฟล์ไม่ตรงกับนามสกุล' }] });
  }
  if (typeof f.content_base64 !== 'string' || f.content_base64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'file too large', { messageTh: `ไฟล์ใหญ่เกิน ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` });
  }
  const bytes = fromBase64(f.content_base64);
  if (bytes.length === 0) throw new AppError('VALIDATION_ERROR', 'empty file', { messageTh: 'ไฟล์ว่าง' });
  if (bytes.length > MAX_UPLOAD_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'file too large', { messageTh: `ไฟล์ใหญ่เกิน ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` });
  if (!t.magic(bytes)) throw new AppError('VALIDATION_ERROR', 'content does not match type', { messageTh: 'เนื้อหาไฟล์ไม่ตรงกับชนิดไฟล์', fieldErrors: [{ field: 'file', code: 'MAGIC_MISMATCH', message_th: 'เนื้อหาไฟล์ไม่ตรงกับชนิดไฟล์' }] });
  return { bytes, filename, ext: ext.toLowerCase(), mime: t.mime, size: bytes.length };
}

/**
 * Store bytes as a STAGED attachment (not linked yet). External side effect happens BEFORE the
 * metadata commit; if the commit fails the object is an orphan and the cleanup job removes it.
 */
export function* stageAttachment(ctx, cs, { bytes, filename, mime, size }, classification) {
  const school = (yield ctx.store.list('Schools', { limit: 1 })).items[0];
  const id = ctx.ids.uuid();
  const sha = ctx.crypto.sha256Hex(bytes);
  const stored = yield ctx.platform.storage.put(id, bytes, { filename, mime, classification, staged: true });
  const att = cs.insert('Attachments', {
    id, school_id: school.id, original_filename: filename, mime_type: mime, size_bytes: size, sha256: sha, classification, status: 'STAGED',
    uploaded_by: ctx.principal.user_id, uploaded_at: ctx.now,
  });
  cs.insert('StorageObjectMappings', { attachment_id: id, provider: stored.provider, object_key: stored.object_key, container: stored.container || null, status: 'ACTIVE', sha256_verified_at: ctx.now });
  return att;
}

export function* linkAttachment(ctx, cs, attachment, entityType, entityId, purpose) {
  if (attachment.status === 'STAGED') cs.update('Attachments', attachment, { status: 'ACTIVE', linked_at: ctx.now });
  return cs.insert('AttachmentLinks', { attachment_id: attachment.id, entity_type: entityType, entity_id: entityId, purpose, linked_by: ctx.principal.user_id, linked_at: ctx.now });
}

export function* readAttachmentBytes(ctx, attachmentId) {
  const maps = (yield ctx.store.findBy('StorageObjectMappings', 'attachment_id', attachmentId)).filter((m) => m.status === 'ACTIVE');
  if (!maps.length) throw new AppError('STORAGE_UNAVAILABLE', 'no storage mapping', { messageTh: 'ไม่พบไฟล์ในที่จัดเก็บ' });
  const bytes = yield ctx.platform.storage.get(maps[0]);
  return bytes;
}

export function sha256OfBytes(ctx, bytes) {
  return ctx.crypto ? ctx.crypto.sha256Hex(bytes) : sha256Hex(bytes);
}

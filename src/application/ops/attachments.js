// Attachment download through permission-checked RPC only (never public links), student photos.
import { op } from '../dispatcher.js';
import { obj, S, notFound } from './common.js';
import { requirePermission, allows } from '../authz.js';
import { commit } from '../context.js';
import { validateUpload, stageAttachment, linkAttachment, readAttachmentBytes } from '../files.js';
import { requireStudent } from '../queries.js';
import { AppError } from '../../shared/errors.js';
import { toBase64 } from '../../shared/hash.js';

/** Resolve the student a linked entity belongs to (for scope checks). */
function* studentOfEntity(ctx, link) {
  switch (link.entity_type) {
    case 'STUDENT': return link.entity_id;
    case 'LEAVE_REQUEST': { const r = yield ctx.store.get('LeaveRequests', link.entity_id); return r ? r.student_id : null; }
    case 'CASE': { const c = yield ctx.store.get('Cases', link.entity_id); return c ? c.student_id : null; }
    case 'CONTACT_LOG': { const c = yield ctx.store.get('ContactLogs', link.entity_id); return c ? c.student_id : null; }
    case 'ATTENDANCE_CORRECTION': { const c = yield ctx.store.get('AttendanceCorrections', link.entity_id); return c ? c.student_id : null; }
    default: return null;
  }
}

/** Throws FORBIDDEN unless the principal may read this attachment. Returns {attachment, studentId, sensitive}. */
export function* authorizeAttachmentRead(ctx, attachmentId) {
  const a = yield ctx.store.get('Attachments', attachmentId);
  if (!a || a.status === 'DELETED' || a.status === 'QUARANTINED') throw notFound('attachment');
  const links = (yield ctx.store.findBy('AttachmentLinks', 'attachment_id', a.id)).filter((l) => !l.unlinked_at);
  const owner = a.uploaded_by === ctx.principal.user_id;
  const sensitive = a.classification === 'MEDICAL';
  for (const l of links) {
    if (l.entity_type === 'IMPORT_BATCH') { if (yield* allows(ctx, 'import.manage')) return { attachment: a, studentId: null, sensitive }; continue; }
    if (l.entity_type === 'REPORT_RUN' || l.entity_type === 'MIGRATION_RUN' || l.entity_type === 'BACKUP_RUN') continue;
    const studentId = yield* studentOfEntity(ctx, l);
    if (!studentId) continue;
    if (a.classification === 'PHOTO' && (yield* allows(ctx, 'student.read_basic', { student_id: studentId }))) return { attachment: a, studentId, sensitive: false };
    if (sensitive) {
      if (yield* allows(ctx, 'attachment.read_sensitive', { student_id: studentId, owner_user_id: a.uploaded_by })) return { attachment: a, studentId, sensitive };
    } else if ((yield* allows(ctx, 'attachment.read', { student_id: studentId })) || (owner && (yield* allows(ctx, 'attachment.upload', { owner_user_id: a.uploaded_by })))) {
      return { attachment: a, studentId, sensitive };
    }
  }
  throw new AppError('FORBIDDEN', 'attachment read denied', { messageTh: 'คุณไม่มีสิทธิ์เปิดไฟล์นี้' });
}

export const attachmentOps = [
  op({
    name: 'attachment.download', description_th: 'ดาวน์โหลดไฟล์ (ตรวจสิทธิ์ทุกครั้ง; เอกสารอ่อนไหวบันทึก audit)', permission: 'attachment.read | attachment.read_sensitive', rateLimitPerMinute: 60,
    input: obj({ attachment_id: S.uuid }, ['attachment_id']),
    *handler(ctx, input) {
      const { attachment, studentId, sensitive } = yield* authorizeAttachmentRead(ctx, input.attachment_id);
      const bytes = yield* readAttachmentBytes(ctx, attachment.id);
      const sha = ctx.crypto.sha256Hex(bytes);
      if (sha !== attachment.sha256) throw new AppError('INTEGRITY_ERROR', 'checksum mismatch', { messageTh: 'ไฟล์เสียหาย (checksum ไม่ตรง) แจ้งผู้ดูแลระบบ' });
      if (sensitive) {
        const cs = ctx.changeSet('attachment.read_sensitive');
        cs.audit({ action: 'attachment.read_sensitive', entityType: 'Attachments', entityId: attachment.id, studentId });
        yield* commit(ctx, cs, {});
      }
      return { filename: attachment.original_filename, mime_type: attachment.mime_type, size_bytes: attachment.size_bytes, content_base64: toBase64(bytes) };
    },
  }),

  op({
    name: 'student.setPhoto', mutation: true, permission: 'student.manage', description_th: 'ตั้งรูปนักเรียน (ใช้ตรวจตัวบุคคลที่ประตู; ระบบย่อรูปที่เครื่องก่อนส่ง)',
    input: obj({ student_id: S.uuid, file: obj({ filename: S.str(200), mime_type: S.strOrNull(100), content_base64: { type: 'string', minLength: 4, maxLength: 1500000 } }, ['filename', 'content_base64']) }, ['student_id', 'file']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'student.manage', { student_id: input.student_id });
      const s = yield* requireStudent(ctx, input.student_id);
      const f = validateUpload(input.file, 'PHOTO');
      const cs = ctx.changeSet();
      const att = yield* stageAttachment(ctx, cs, f, 'PHOTO');
      yield* linkAttachment(ctx, cs, att, 'STUDENT', s.id, 'PHOTO');
      cs.update('Students', s, { photo_file_id: att.id });
      cs.audit({ action: 'student.set_photo', entityType: 'Students', entityId: s.id, studentId: s.id });
      return yield* commit(ctx, cs, { attachment_id: att.id });
    },
  }),

  op({
    name: 'student.photo', description_th: 'รูปนักเรียนสำหรับตรวจตัวบุคคล (ข้อมูลระบุตัว)', permission: 'student.read_basic', rateLimitPerMinute: 600,
    input: obj({ student_id: S.uuid }, ['student_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'student.read_basic', { student_id: input.student_id });
      const s = yield* requireStudent(ctx, input.student_id);
      if (!s.photo_file_id) return { has_photo: false };
      const cacheKey = `photo:${s.photo_file_id}`;
      if (ctx.cache) { const hit = ctx.cache.get(cacheKey); if (hit) return { has_photo: true, mime_type: 'image/jpeg', content_base64: hit }; }
      const a = yield ctx.store.get('Attachments', s.photo_file_id);
      if (!a || a.status === 'DELETED') return { has_photo: false };
      const b64 = toBase64(yield* readAttachmentBytes(ctx, a.id));
      if (ctx.cache && b64.length < 90000) ctx.cache.put(cacheKey, b64, 3600);
      return { has_photo: true, mime_type: a.mime_type, content_base64: b64 };
    },
  }),
];

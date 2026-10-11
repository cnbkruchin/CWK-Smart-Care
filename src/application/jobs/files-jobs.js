// Orphan file cleanup (MASTER_PROMPT §18 "Files", DECISIONS D-038). Uploads write the object BEFORE the
// metadata commit (src/application/files.js stageAttachment); a failed or abandoned commit leaves an object
// that nothing references. Once a day (setting files.cleanup_time, default 02:30) the job:
//   A. marks Attachments still STAGED and never linked after 24 h as DELETED and removes their objects;
//   B. moves linked objects out of the staging area (storage.promote), so staging holds only recent uploads;
//   C. removes objects in the staging area that are older than 24 h and have NO Attachments row.
// Only objects with no row (C) or with a STAGED, never-linked row (A) are ever removed — anything referenced
// stays. The tick is not readOnlySafe: nothing is deleted while the system is frozen (migration, maintenance).
import { createContext, setting, commit } from '../context.js';
import { systemPrincipal } from '../principal.js';
import { enqueueOnceEver } from '../jobs.js';
import { listAll } from '../queries.js';
import { localPartsOf, hhmmToMinutes, addMinutesIso } from '../../shared/time.js';
import { SYSTEM_USER_ID, isUuid } from '../../shared/uuid.js';

export const ORPHAN_MIN_AGE_MINUTES = 24 * 60;
const SAFETY_MS = 30000;

/** Job handler 'files.cleanupOrphans' — resumable: each phase checkpoints its progress. */
export function* cleanupOrphansJob(ctx, job, { checkpoint, timeLeftMs }) {
  const storage = ctx.platform.storage;
  const cutoff = addMinutesIso(ctx.now, -ORPHAN_MIN_AGE_MINUTES);
  const r = { staged_rows_deleted: 0, promoted: 0, orphan_objects_deleted: 0, young_objects_kept: 0, referenced_objects_kept: 0, listing: storage && storage.listStaged ? 'OK' : 'NOT_SUPPORTED', ...((job.progress_json && job.progress_json.counts) || {}) };
  let phase = (job.cursor_json && job.cursor_json.phase) || 'STAGED_ROWS';
  if (!storage) return { done: true, result: { skipped: 'no storage' } };
  const save = function* () { yield* checkpoint({ phase }, { counts: r }); };

  // A — committed rows that were staged but never linked
  if (phase === 'STAGED_ROWS') {
    const staged = (yield* listAll(ctx, 'Attachments', { where: { status: 'STAGED' } })).filter((a) => a.uploaded_at <= cutoff);
    const removals = [];
    const cs = ctx.changeSet('files.cleanup.staged');
    for (const a of staged) {
      const links = (yield ctx.store.findBy('AttachmentLinks', 'attachment_id', a.id)).filter((l) => !l.unlinked_at);
      if (links.length) continue; // referenced: never removed (inconsistent status is reported by schema checks)
      cs.update('Attachments', a, { status: 'DELETED', deleted_at: ctx.now, deleted_by: SYSTEM_USER_ID });
      for (const m of yield ctx.store.findBy('StorageObjectMappings', 'attachment_id', a.id)) removals.push(m);
      r.staged_rows_deleted++;
    }
    if (r.staged_rows_deleted) {
      cs.audit({ action: 'attachment.orphan_cleanup', entityType: null, reason: 'ไฟล์ที่อัปโหลดแล้วไม่ถูกผูกกับรายการใดภายใน 24 ชั่วโมง', after: { attachment_ids: staged.map((a) => a.id).slice(0, 200) } });
      yield* commit(ctx, cs, {});
      for (const m of removals) yield storage.delete(m); // after the commit: a failure leaves only a trashed/missing object of a DELETED row
    }
    phase = 'PROMOTE';
    yield* save();
  }

  // B — linked objects still in the staging area move to permanent storage
  if (phase === 'PROMOTE') {
    if (storage.promote && storage.isStaged) {
      const maps = (yield* listAll(ctx, 'StorageObjectMappings', { where: { status: 'ACTIVE' } })).filter((m) => storage.isStaged(m));
      for (const m of maps) {
        if (timeLeftMs() < SAFETY_MS) { yield* save(); return { done: false }; }
        const att = yield ctx.store.get('Attachments', m.attachment_id);
        if (!att || att.status === 'STAGED' || att.status === 'DELETED') continue;
        const moved = yield storage.promote(m);
        const cs = ctx.changeSet('files.cleanup.promote');
        cs.update('StorageObjectMappings', m, { object_key: moved.object_key, container: moved.container || null });
        yield* commit(ctx, cs, {});
        r.promoted++;
      }
    }
    phase = 'OBJECTS';
    yield* save();
  }

  // C — objects in the staging area that no Attachments row references (paged by logical id, resumable)
  if (phase === 'OBJECTS' && storage.listStaged) {
    let after = (job.cursor_json && job.cursor_json.after) || null;
    const deleted = [];
    for (;;) {
      const page = yield storage.listStaged({ after, limit: 500 });
      for (const o of page.items) {
        if (o.created_at > cutoff) { r.young_objects_kept++; continue; }
        if (isUuid(o.logical_id) && (yield ctx.store.get('Attachments', o.logical_id))) { r.referenced_objects_kept++; continue; }
        yield storage.delete({ object_key: o.object_key });
        deleted.push(o.logical_id);
        r.orphan_objects_deleted++;
      }
      after = page.next_after || null;
      if (!after) break;
      if (timeLeftMs() < SAFETY_MS) {
        yield* auditDeleted(ctx, deleted);
        yield* checkpoint({ phase, after }, { counts: r });
        return { done: false };
      }
    }
    yield* auditDeleted(ctx, deleted);
  }
  return { done: true, result: r };
}

function* auditDeleted(ctx, ids) {
  if (!ids.length) return;
  const cs = ctx.changeSet('files.cleanup.objects');
  cs.audit({ action: 'attachment.orphan_cleanup', entityType: null, reason: 'ไฟล์ในที่จัดเก็บที่ไม่มีรายการไฟล์แนบอ้างถึง (อัปโหลดแล้วบันทึกไม่สำเร็จ)', after: { logical_ids: ids.slice(0, 200), count: ids.length } });
  yield* commit(ctx, cs, {});
  ids.length = 0;
}

/** Daily schedule (not readOnlySafe — no deletion while frozen). */
export const FILES_TICK = {
  name: 'files.schedule',
  *run(deps) {
    const ctx = yield* createContext(deps, { operation: 'tick.files', channel: 'JOB' });
    ctx.principal = systemPrincipal(SYSTEM_USER_ID);
    if (!deps.platform || !deps.platform.storage) return { skipped: 'no storage' };
    const at = hhmmToMinutes(String(yield* setting(ctx, 'files.cleanup_time', '02:30')));
    const p = localPartsOf(ctx.now, ctx.tz);
    if (p.hh * 60 + p.mm < at) return { scheduled: false };
    return { scheduled: yield* enqueueOnceEver(ctx, { job_type: 'files.cleanupOrphans', payload: {}, dedupe_key: `orphanCleanup|${ctx.today}`, priority: 3, max_attempts: 3 }) };
  },
};

export const FILES_JOB_HANDLERS = { 'files.cleanupOrphans': cleanupOrphansJob };

// Orphan file cleanup (MASTER_PROMPT §18 "Files", D-038) on the memory adapter: only objects that nothing
// references (or rows staged and never linked) are removed after 24 h; linked files are promoted out of the
// staging area and stay readable; nothing is deleted while the system is READ_ONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeHarness } from '../helpers/app-harness.mjs';
import { runSync } from '../../src/application/runtime.js';
import { createContext, commit } from '../../src/application/context.js';
import { systemPrincipal } from '../../src/application/principal.js';
import { stageAttachment } from '../../src/application/files.js';
import { SYSTEM_USER_ID } from '../../src/shared/uuid.js';

const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
const PDF = Buffer.from('%PDF-1.4\n%synthetic test file\n');

test('orphan cleanup: unreferenced and never-linked uploads go after 24 h; linked files are promoted and stay readable; frozen systems delete nothing', () => {
  const h = makeHarness({ now: BKK('2026-06-15', '07:30') });
  h.bootstrap();
  const seed = h.seed();
  const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
  const storage = h.deps.platform.storage;
  const g = seed.guardian_users[0];
  // a normal upload, linked in the same change set as its leave request
  const leave = h.ok(g.user_id, 'leave.submit', { student_id: g.student_id, leave_type: 'SICK', reason: 'ป่วย (ข้อมูลสังเคราะห์)', days: [{ school_date: '2026-06-16', unit: 'FULL_DAY' }], attachments: [{ filename: 'cert.pdf', mime_type: 'application/pdf', content_base64: PDF.toString('base64') }] });
  const linked = h.ok(g.user_id, 'leave.get', { leave_request_id: leave.leave_request_id }).attachments[0];
  // the process died between the storage write and the metadata commit → an object nothing references
  const orphan = crypto.randomUUID();
  storage.put(orphan, PDF, { staged: true });
  // a committed upload that was never linked to anything
  const stagedRow = runSync(function* () {
    const ctx = yield* createContext(h.deps, { operation: 'test.stage', channel: 'JOB' });
    ctx.principal = systemPrincipal(SYSTEM_USER_ID);
    const cs = ctx.changeSet('test.stage');
    const att = yield* stageAttachment(ctx, cs, { bytes: PDF, filename: 'lost.pdf', mime: 'application/pdf', size: PDF.length }, 'GENERAL');
    yield* commit(ctx, cs, {});
    return att;
  });
  // a recent orphan (upload still in flight a few hours ago)
  h.clock.set(BKK('2026-06-16', '03:00'));
  const young = crypto.randomUUID();
  storage.put(young, PDF, { staged: true });
  h.clock.set(BKK('2026-06-16', '09:00'));

  // frozen: the cleanup is not scheduled and nothing is removed
  h.ok(ids.admin, 'system.setMode', { mode: 'READ_ONLY', reason: 'ซ้อมย้ายข้อมูล' });
  assert.ok(!('files.schedule' in h.tick()), 'cleanup does not run while READ_ONLY');
  h.runJobs();
  assert.equal(storage.listStaged().items.length, 4);
  h.ok(ids.admin, 'system.setMode', { mode: 'NORMAL', reason: 'จบการซ้อม' });

  assert.equal(h.tick(['files.schedule'])['files.schedule'].scheduled, true);
  h.runJobs();
  const job = h.store.findBy('Jobs', 'dedupe_key', 'orphanCleanup|2026-06-16')[0];
  assert.equal(job.status, 'SUCCEEDED', job.last_error);
  assert.deepEqual({ ...job.result_json, listing: undefined }, { staged_rows_deleted: 1, promoted: 1, orphan_objects_deleted: 1, young_objects_kept: 1, referenced_objects_kept: 0, listing: undefined });
  assert.ok(storage.deleted.has(`mem/staging/${orphan}`), 'unreferenced object removed');
  assert.equal(h.store.get('Attachments', stagedRow.id).status, 'DELETED');
  assert.ok(storage.deleted.has(`mem/staging/${stagedRow.id}`), 'object of the never-linked row removed');
  assert.deepEqual(storage.listStaged().items.map((o) => o.logical_id), [young], 'only the recent upload is left in staging');
  const map = h.store.findBy('StorageObjectMappings', 'attachment_id', linked.id)[0];
  assert.equal(map.object_key, `mem/files/${linked.id}`, 'linked file promoted out of staging');
  const homeroom = [ids.homeroom1, ids.homeroom2].find((u) => h.call(u, 'attachment.download', { attachment_id: linked.id }).ok);
  assert.deepEqual(Buffer.from(h.ok(homeroom, 'attachment.download', { attachment_id: linked.id }).content_base64, 'base64'), PDF, 'linked file still readable');
  assert.equal(h.store.list('AuditEvents', { where: { action: 'attachment.orphan_cleanup' }, limit: 10 }).items.length, 2);
  // once per day
  assert.equal(h.tick(['files.schedule'])['files.schedule'].scheduled, false);
});

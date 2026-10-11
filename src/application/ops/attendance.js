// Attendance operations (MASTER_PROMPT §7.3, §7.4): gate arrival, offline sync, roll call,
// absence verification, corrections, exemptions, reconciliation tasks.
import { op } from '../dispatcher.js';
import { obj, S, notFound, assertVersion, basicStudent } from './common.js';
import { requirePermission, allows, scopeFor, hasRole } from '../authz.js';
import { commit, partitionsForDates, setting, ruleFor } from '../context.js';
import { requireStudent, getClass, rosterOf, effectiveEnrollment } from '../queries.js';
import { computeDay, refreshDay, eventsFor, storedProjection, preloadDay } from '../services/attendance-core.js';
import { emitNotification, guardianRecipients, homeroomRecipients, studentShortName } from '../services/notify.js';
import { activeEvents, arrivalDedupeKey } from '../../domain/attendance.js';
import { AppError } from '../../shared/errors.js';
import { schoolDateOf, localPartsOf, diffSeconds, diffDays, localToUtc } from '../../shared/time.js';
import { deterministicId, uuidV5 } from '../../shared/uuid.js';
import { sha256Hex } from '../../shared/hash.js';
import { ENUMS } from '../../schema/enums.js';

const GATE_SOURCES = ['SCAN_KEYBOARD', 'SCAN_CAMERA', 'SEARCH_CODE', 'SEARCH_NAME', 'MANUAL_TIME', 'QUEUE_BATCH'];

function* gateStatus(ctx, studentId, date) {
  const events = activeEvents(yield* eventsFor(ctx, studentId, date));
  const arrival = events.find((e) => e.event_type === 'GATE_ARRIVAL');
  const proj = yield* storedProjection(ctx, studentId, date);
  return {
    arrived: !!arrival, arrived_at: arrival ? arrival.occurred_at : null, arrival_event_id: arrival ? arrival.id : null,
    presence_status: proj ? proj.presence_status : 'UNKNOWN', is_late: proj ? proj.is_late : false, late_minutes: proj ? proj.late_minutes : null,
    leave_units: proj ? proj.leave_units : null, full_day_leave: proj ? proj.full_day_leave : false,
  };
}

function* stationFor(ctx, stationId) {
  const st = yield ctx.store.get('Stations', stationId);
  if (!st || st.status !== 'ACTIVE') throw new AppError('VALIDATION_ERROR', 'station', { fieldErrors: [{ field: 'station_id', code: 'INVALID', message_th: 'ไม่พบจุดลงเวลา' }] });
  const strict = yield* setting(ctx, 'attendance.require_duty_assignment', false);
  const p = ctx.principal;
  if (strict && p.roles.has('DUTY_TEACHER') && !p.roles.has('GATE_STAFF') && !p.roles.has('STUDENT_AFFAIRS') && !p.facts.stationIds.has(stationId)) {
    throw new AppError('FORBIDDEN', 'not on duty at station', { messageTh: 'คุณไม่ได้อยู่เวรที่จุดลงเวลานี้' });
  }
  return st;
}

/** Shared by online gate recording and offline sync. Returns the committed/located event summary. */
function* recordArrivalCore(ctx, { student, stationId, occurredAt, source, reasonCode, reasonText, offline = false, capturedAt = null, claimedActorId = null, eventId = null }) {
  const date = schoolDateOf(occurredAt, ctx.tz);
  const existing = activeEvents(yield* eventsFor(ctx, student.id, date)).find((e) => e.event_type === 'GATE_ARRIVAL');
  if (existing) {
    const proj = yield* storedProjection(ctx, student.id, date);
    return { duplicate: true, event: existing, projection: proj, school_date: date };
  }
  const enr = yield* effectiveEnrollment(ctx, student.id, date);
  if (!enr) throw new AppError('VALIDATION_ERROR', 'not enrolled', { messageTh: 'นักเรียนไม่มีข้อมูลห้องเรียนที่มีผลในวันนี้ ระบบไม่บันทึก' });
  const cs = ctx.changeSet();
  const event = cs.insert('AttendanceEvents', {
    id: eventId || undefined, student_id: student.id, school_date: date, event_type: 'GATE_ARRIVAL', occurred_at: occurredAt, recorded_at: ctx.now,
    captured_at: capturedAt, synced_at: offline ? ctx.now : null, source, offline, station_id: stationId, actor_id: ctx.principal.user_id, claimed_actor_id: claimedActorId,
    reason_code: reasonCode || null, reason_text: reasonText || null, class_id: enr.class_id, dedupe_key: arrivalDedupeKey(student.id, date), operation_id: cs.operationId,
  });
  const day = yield* refreshDay(ctx, cs, student.id, date, { extraEvents: [event] });
  cs.audit({ action: 'attendance.record_arrival', entityType: 'AttendanceEvents', entityId: event.id, studentId: student.id, after: { occurred_at: occurredAt, source, station_id: stationId, offline } });
  if (day.computed.late_counted) {
    const cls = yield* getClass(ctx, enr.class_id);
    yield* emitNotification(ctx, cs, {
      type: 'LATE_CONFIRMED', sourceEntityType: 'AttendanceEvents', sourceEntityId: event.id, studentId: student.id, audience: 'GUARDIANS_OF_STUDENT',
      params: { student_name: studentShortName(student), class_name: cls ? cls.name_th : '', arrived_at: occurredAt, school_date: date, late_minutes: day.computed.late_minutes },
      recipients: yield* guardianRecipients(ctx, student.id, 'LATE_CONFIRMED'),
    });
  }
  return { duplicate: false, event, projection: day.computed, school_date: date, cs };
}

function summary(r) {
  const p = r.projection || {};
  return {
    event_id: r.event.id, school_date: r.school_date, arrived_at: r.event.occurred_at, duplicate: r.duplicate, is_late: !!p.is_late, late_minutes: p.late_minutes ?? null,
    late_counted: !!p.late_counted, presence_status: p.presence_status || null,
    message_th: r.duplicate ? 'บันทึกไว้แล้ว (ไม่นับซ้ำ)' : p.is_late ? `บันทึกแล้ว: มาสาย ${p.late_minutes} นาที${p.late_counted ? '' : ' (ไม่นับเป็นการสาย)'}` : 'บันทึกแล้ว: มาทันเวลา',
    note_th: 'การลงเวลาที่ประตูไม่ใช่หลักฐานว่าเข้าห้องเรียนแล้ว',
  };
}

export const attendanceOps = [
  op({
    name: 'attendance.lookupForGate', description_th: 'ค้นหานักเรียนด้วยรหัส/บัตรเพื่อตรวจตัวบุคคลที่ประตู (ข้อมูลระบุตัวเท่านั้น)', permission: 'student.read_basic', rateLimitPerMinute: 600,
    input: obj({ code: { type: ['string', 'null'], maxLength: 64 }, student_id: S.uuidOrNull }),
    *handler(ctx, input) {
      let student = null;
      if (input.student_id) student = yield ctx.store.get('Students', input.student_id);
      else if (input.code) {
        const code = String(input.code).trim().replace(/^CWK:/i, '');
        student = (yield ctx.store.findBy('Students', 'student_code', code))[0] || null;
      }
      if (!student) throw new AppError('NOT_FOUND', 'student not found', { messageTh: 'ไม่พบรหัสนักเรียนนี้ ตรวจสอบบัตรหรือค้นหาด้วยชื่อ' });
      yield* requirePermission(ctx, 'student.read_basic', { student_id: student.id });
      const enr = yield* effectiveEnrollment(ctx, student.id, ctx.today);
      const cls = enr ? yield* getClass(ctx, enr.class_id) : null;
      return { student: basicStudent(student, cls), today: ctx.today, status: yield* gateStatus(ctx, student.id, ctx.today), eligible: !!enr };
    },
  }),

  op({
    name: 'attendance.recordArrival', mutation: true, retryOnConflict: 3, rateLimitPerMinute: 600, permission: 'attendance.record',
    description_th: 'บันทึกเวลามาถึงโรงเรียน (เวลา server; สแกนซ้ำคืนผลเดิม; เวลาระบุเองต้องมีเหตุผล)',
    input: obj({
      student_id: S.uuid, station_id: S.uuid, source: { type: 'string', enum: GATE_SOURCES }, arrived_at: { type: ['string', 'null'], format: 'timestamp' },
      reason_code: { type: ['string', 'null'], enum: ['TRANSPORT_DELAY', 'HEALTH', 'FAMILY', 'WEATHER', 'OTHER', null] }, reason_text: S.strOrNull(500),
    }, ['student_id', 'station_id', 'source']),
    *handler(ctx, input) {
      const student = yield* requireStudent(ctx, input.student_id);
      yield* requirePermission(ctx, 'attendance.record', { student_id: student.id });
      yield* stationFor(ctx, input.station_id);
      let occurredAt = ctx.now;
      if (input.source === 'MANUAL_TIME' || input.source === 'QUEUE_BATCH') {
        if (!input.arrived_at) throw new AppError('VALIDATION_ERROR', 'arrived_at', { fieldErrors: [{ field: 'arrived_at', code: 'REQUIRED', message_th: 'กรุณาระบุเวลามาถึง' }] });
        if (input.source === 'MANUAL_TIME' && !input.reason_text) throw new AppError('VALIDATION_ERROR', 'reason', { fieldErrors: [{ field: 'reason_text', code: 'REQUIRED', message_th: 'เวลาที่ระบุเองต้องมีเหตุผล' }] });
        if (input.arrived_at > ctx.now) throw new AppError('VALIDATION_ERROR', 'future', { fieldErrors: [{ field: 'arrived_at', code: 'FUTURE', message_th: 'เวลามาถึงต้องไม่เป็นเวลาในอนาคต' }] });
        if (schoolDateOf(input.arrived_at, ctx.tz) !== ctx.today) throw new AppError('VALIDATION_ERROR', 'not today', { fieldErrors: [{ field: 'arrived_at', code: 'NOT_TODAY', message_th: 'บันทึกได้เฉพาะวันนี้ ย้อนหลังใช้การแก้ไขข้อมูล' }] });
        if (localPartsOf(input.arrived_at, ctx.tz).hh < 5) throw new AppError('VALIDATION_ERROR', 'too early', { fieldErrors: [{ field: 'arrived_at', code: 'RANGE', message_th: 'เวลามาถึงไม่สมเหตุผล' }] });
        occurredAt = new Date(input.arrived_at).toISOString();
      }
      const r = yield* recordArrivalCore(ctx, { student, stationId: input.station_id, occurredAt, source: input.source, reasonCode: input.reason_code, reasonText: input.reason_text });
      if (r.duplicate) return summary(r);
      const res = summary(r);
      return yield* commit(ctx, r.cs, res);
    },
  }),

  op({
    name: 'attendance.syncOffline', mutation: true, rateLimitPerMinute: 30, permission: 'attendance.record',
    description_th: 'ส่งรายการที่บันทึกขณะออฟไลน์ (ตรวจสิทธิ์ปัจจุบัน เวลาเครื่อง และใช้ idempotency key เดิม; รายการผิดปกติเข้าคิวตรวจ)',
    input: obj({
      station_id: S.uuid,
      records: { type: 'array', minItems: 1, maxItems: 50, items: obj({ local_id: S.str(64), idempotency_key: S.uuid, student_code: S.str(40), captured_at: S.ts, claimed_user_id: S.uuidOrNull }, ['local_id', 'idempotency_key', 'student_code', 'captured_at']) },
    }, ['station_id', 'records']),
    *handler(ctx, input) {
      yield* stationFor(ctx, input.station_id);
      const results = [];
      for (const rec of input.records) {
        const eventId = uuidV5(`offline-arrival|${rec.idempotency_key}`);
        try {
          const already = yield ctx.store.get('AttendanceEvents', eventId, { partitions: partitionsForDates(ctx, [schoolDateOf(rec.captured_at, ctx.tz)]) });
          if (already) { results.push({ local_id: rec.local_id, status: 'DUPLICATE', event_id: eventId, message_th: 'ส่งไปแล้ว' }); continue; }
          const student = (yield ctx.store.findBy('Students', 'student_code', rec.student_code.trim()))[0];
          const drift = diffSeconds(rec.captured_at, ctx.now);
          const reviewReason = !student ? 'ไม่พบรหัสนักเรียน'
            : drift < -120 ? 'เวลาเครื่องอยู่ในอนาคต (นาฬิกาเครื่องผิด)'
            : drift > 12 * 3600 ? 'บันทึกออฟไลน์นานเกิน 12 ชั่วโมง'
            : rec.claimed_user_id && rec.claimed_user_id !== ctx.principal.user_id ? 'ผู้บันทึกบนอุปกรณ์ไม่ตรงกับผู้ส่ง (อุปกรณ์ใช้ร่วมกัน)' : null;
          if (student) yield* requirePermission(ctx, 'attendance.record', { student_id: student.id });
          if (reviewReason) {
            const cs = ctx.changeSet('attendance.syncOffline.review');
            const dedupe = `OFFLINE_REVIEW|${rec.idempotency_key}`;
            if (!(yield ctx.store.get('ReconciliationTasks', deterministicId.reconciliationTask(dedupe)))) {
              cs.insert('ReconciliationTasks', {
                id: deterministicId.reconciliationTask(dedupe), task_type: 'OFFLINE_REVIEW', student_id: student ? student.id : null, school_date: schoolDateOf(rec.captured_at, ctx.tz),
                evidence_refs: { local_id: rec.local_id, student_code: rec.student_code, captured_at: rec.captured_at, synced_by: ctx.principal.user_id, claimed_user_id: rec.claimed_user_id || null, station_id: input.station_id },
                description_th: `รายการออฟไลน์ต้องตรวจ: ${reviewReason}`, assigned_role: 'STUDENT_AFFAIRS', status: 'OPEN', dedupe_key: dedupe,
              });
              cs.audit({ action: 'attendance.offline_review', entityType: 'ReconciliationTasks', studentId: student ? student.id : null, reason: reviewReason });
              yield ctx.mutations.commit(cs.build({ result: {} }));
            }
            results.push({ local_id: rec.local_id, status: 'REVIEW', message_th: reviewReason });
            continue;
          }
          const r = yield* recordArrivalCore(ctx, {
            student, stationId: input.station_id, occurredAt: rec.captured_at, source: 'OFFLINE_SYNC', offline: true, capturedAt: rec.captured_at,
            claimedActorId: rec.claimed_user_id || null, eventId,
          });
          if (r.duplicate) { results.push({ local_id: rec.local_id, status: 'DUPLICATE', event_id: r.event.id, message_th: 'มีบันทึกมาถึงของวันนั้นแล้ว (ไม่นับซ้ำ)' }); continue; }
          yield ctx.mutations.commit(r.cs.build({ result: {} }));
          results.push({ local_id: rec.local_id, status: 'RECORDED', event_id: r.event.id, message_th: summary(r).message_th });
        } catch (e) {
          if (e.code === 'MAINTENANCE_MODE' || e.code === 'LOCK_TIMEOUT' || e.code === 'STORAGE_UNAVAILABLE') throw e;
          results.push({ local_id: rec.local_id, status: 'REJECTED', message_th: e.messageTh || 'บันทึกไม่สำเร็จ', code: e.code || 'INTERNAL_ERROR' });
        }
      }
      return { results };
    },
  }),

  op({
    name: 'attendance.stationLog', description_th: 'รายการลงเวลาวันนี้ของจุดลงเวลา', permission: 'attendance.read_station',
    input: obj({ station_id: S.uuid, limit: S.limit }, ['station_id']),
    *handler(ctx, input) {
      scopeFor(ctx, 'attendance.read_station');
      const page = yield ctx.store.list('AttendanceEvents', { where: { school_date: ctx.today, station_id: input.station_id, event_type: 'GATE_ARRIVAL' }, partitions: partitionsForDates(ctx, [ctx.today]), orderBy: [['recorded_at', 'desc']], limit: input.limit || 50 });
      const students = yield ctx.store.getMany('Students', page.items.map((e) => e.student_id));
      return { items: page.items.map((e) => { const s = students.get(e.student_id); return { event_id: e.id, student_code: s && s.student_code, name: s ? studentShortName(s) : '', occurred_at: e.occurred_at, source: e.source, offline: e.offline }; }) };
    },
  }),

  op({
    name: 'rollcall.get', description_th: 'รายชื่อเช็กชื่อประจำวันตาม enrollment ของวันนั้น พร้อมข้อมูลประตูและใบลา', permission: 'attendance.rollcall | attendance.read',
    input: obj({ class_id: S.uuid, school_date: S.date }, ['class_id', 'school_date']),
    *handler(ctx, input) {
      const canMark = yield* allows(ctx, 'attendance.rollcall', { class_id: input.class_id });
      if (!canMark) yield* requirePermission(ctx, 'attendance.read', { class_id: input.class_id });
      const cls = yield* getClass(ctx, input.class_id);
      if (!cls) throw notFound('class');
      const roster = yield* rosterOf(ctx, input.class_id, input.school_date);
      const students = yield ctx.store.getMany('Students', roster.map((e) => e.student_id));
      const session = yield ctx.store.get('RollCallSessions', deterministicId.rollCallSession(input.class_id, input.school_date), { partitions: partitionsForDates(ctx, [input.school_date]) });
      const pre = yield* preloadDay(ctx, input.school_date, roster.map((e) => e.student_id));
      const items = [];
      for (const e of roster) {
        const { computed } = yield* computeDay(ctx, e.student_id, input.school_date, { ...pre.get(e.student_id), enrollment: e, session: session || null });
        const s = students.get(e.student_id);
        items.push({ student: basicStudent(s, cls), roll_no: e.roll_no, mark: computed.roll_call_mark, presence_status: computed.presence_status, arrived_at: computed.arrived_at, is_late: computed.is_late, late_minutes: computed.late_minutes, leave_units: computed.leave_units, full_day_leave: computed.full_day_leave, confirmed_absence: computed.confirmed_absence, has_conflict: computed.has_conflict });
      }
      return { class: { id: cls.id, name_th: cls.name_th }, school_date: input.school_date, can_mark: canMark, session: session ? { id: session.id, status: session.status, submitted_at: session.submitted_at, version: session.version } : null, items };
    },
  }),

  op({
    name: 'rollcall.submit', mutation: true, retryOnConflict: 1, permission: 'attendance.rollcall',
    description_th: 'ส่งผลเช็กชื่อ (ระบุเฉพาะนักเรียนที่ไม่ใช่ "มา"; ส่งซ้ำได้ก่อนยืนยัน)',
    input: obj({
      class_id: S.uuid, school_date: S.date,
      marks: { type: 'array', maxItems: 200, items: obj({ student_id: S.uuid, mark: { type: 'string', enum: ['PRESENT', 'ABSENT', 'LATE', 'LEAVE_REPORTED'] } }, ['student_id', 'mark']) },
    }, ['class_id', 'school_date', 'marks']),
    *handler(ctx, input, env) {
      yield* requirePermission(ctx, 'attendance.rollcall', { class_id: input.class_id });
      if (input.school_date > ctx.today) throw new AppError('VALIDATION_ERROR', 'future', { messageTh: 'เช็กชื่อล่วงหน้าไม่ได้' });
      const backdays = yield* setting(ctx, 'attendance.rollcall_backdate_days', 3);
      if (diffDays(input.school_date, ctx.today) > backdays) throw new AppError('VALIDATION_ERROR', 'too old', { messageTh: `เช็กชื่อย้อนหลังได้ไม่เกิน ${backdays} วัน เกินกว่านั้นใช้การแก้ไขข้อมูล (มีเหตุผล)` });
      const cls = yield* getClass(ctx, input.class_id);
      const roster = yield* rosterOf(ctx, input.class_id, input.school_date);
      const rosterIds = roster.map((e) => e.student_id);
      const markBy = new Map(input.marks.map((m) => [m.student_id, m.mark]));
      for (const id of markBy.keys()) if (!rosterIds.includes(id)) throw new AppError('VALIDATION_ERROR', 'not in roster', { messageTh: 'มีนักเรียนที่ไม่อยู่ในรายชื่อห้องของวันนั้น' });
      const sessionId = deterministicId.rollCallSession(input.class_id, input.school_date);
      const parts = partitionsForDates(ctx, [input.school_date]);
      const existing = yield ctx.store.get('RollCallSessions', sessionId, { partitions: parts });
      if (existing) assertVersion(existing, env.expected_version);
      if (existing && existing.status === 'VERIFIED') throw new AppError('INVALID_STATE', 'verified', { messageTh: 'ยืนยันผลแล้ว แก้ไขผ่านการแก้ไขข้อมูล (มีเหตุผล)' });
      const cs = ctx.changeSet();
      const counts = { ABSENT: 0, LATE: 0, LEAVE_REPORTED: 0 };
      for (const m of markBy.values()) if (counts[m] !== undefined) counts[m]++;
      const sessionPatch = {
        status: 'SUBMITTED', roster_count: rosterIds.length, roster_hash: sha256Hex([...rosterIds].sort().join(',')), absent_count: counts.ABSENT, late_count: counts.LATE,
        leave_reported_count: counts.LEAVE_REPORTED, submitted_by: ctx.principal.user_id, submitted_at: ctx.now, source: 'APP',
      };
      const session = existing ? cs.update('RollCallSessions', existing, sessionPatch) : cs.insert('RollCallSessions', { id: sessionId, class_id: input.class_id, school_date: input.school_date, ...sessionPatch });
      const occurred = input.school_date === ctx.today ? ctx.now : localToUtc(input.school_date, '12:00', ctx.tz);
      let changed = 0;
      const pre = yield* preloadDay(ctx, input.school_date, rosterIds);
      const enrBy = new Map(roster.map((e) => [e.student_id, e]));
      for (const sid of rosterIds) {
        const { events, leaveSegments, stored } = pre.get(sid);
        const act = activeEvents(events);
        const lastRoll = act.filter((e) => e.event_type.startsWith('ROLL_CALL_')).pop() || null;
        const currentMark = lastRoll ? lastRoll.event_type.replace('ROLL_CALL_', '') : 'PRESENT';
        const wanted = markBy.get(sid) || 'PRESENT';
        const extra = [];
        if (wanted !== currentMark) {
          const ev = cs.insert('AttendanceEvents', {
            student_id: sid, school_date: input.school_date, event_type: `ROLL_CALL_${wanted}`, occurred_at: occurred, recorded_at: ctx.now, source: 'ROLL_CALL', offline: false,
            actor_id: ctx.principal.user_id, roll_call_session_id: session.id, class_id: input.class_id, supersedes_event_id: lastRoll ? lastRoll.id : null, operation_id: cs.operationId,
          });
          extra.push(ev);
          changed++;
        }
        yield* refreshDay(ctx, cs, sid, input.school_date, { events: [...events, ...extra], session, leaveSegments, stored, enrollment: enrBy.get(sid) });
      }
      cs.audit({ action: 'rollcall.submit', entityType: 'RollCallSessions', entityId: session.id, after: { class_id: input.class_id, school_date: input.school_date, class_name: cls ? cls.name_th : null, ...counts, changed } });
      return yield* commit(ctx, cs, { session_id: session.id, roster_count: rosterIds.length, ...counts, changed });
    },
  }),

  op({
    name: 'attendance.verifyDay', mutation: true, permission: 'attendance.verify',
    description_th: 'ครูยืนยันขาดเรียนรายคน (หลังตรวจสอบแล้ว) — แจ้งผู้ปกครองว่า "ขาดเรียน" เฉพาะรายการที่ยืนยัน',
    input: obj({ class_id: S.uuid, school_date: S.date, confirm_absent_student_ids: { type: 'array', maxItems: 200, uniqueItems: true, items: S.uuid }, note: S.strOrNull(500) }, ['class_id', 'school_date', 'confirm_absent_student_ids']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'attendance.verify', { class_id: input.class_id });
      if (input.school_date > ctx.today) throw new AppError('VALIDATION_ERROR', 'future');
      const cls = yield* getClass(ctx, input.class_id);
      const roster = new Set((yield* rosterOf(ctx, input.class_id, input.school_date)).map((e) => e.student_id));
      const verifyRule = yield* ruleFor(ctx, 'ABSENCE_VERIFICATION', input.school_date, { required: false });
      const cs = ctx.changeSet();
      const confirmed = [];
      const refused = [];
      for (const sid of input.confirm_absent_student_ids) {
        if (!roster.has(sid)) { refused.push({ student_id: sid, reason_th: 'ไม่อยู่ในรายชื่อห้อง' }); continue; }
        const day = yield* computeDay(ctx, sid, input.school_date);
        if (day.computed.presence_status !== 'UNKNOWN') { refused.push({ student_id: sid, reason_th: `สถานะปัจจุบัน ${ENUMS.PresenceStatus.th[day.computed.presence_status]} (ยืนยันขาดไม่ได้)` }); continue; }
        const ev = cs.insert('AttendanceEvents', {
          student_id: sid, school_date: input.school_date, event_type: 'ABSENCE_CONFIRMED', occurred_at: ctx.now, recorded_at: ctx.now, source: 'ROLL_CALL', offline: false,
          actor_id: ctx.principal.user_id, reason_text: input.note || null, class_id: input.class_id, dedupe_key: `ABS|${sid}|${input.school_date}`, operation_id: cs.operationId,
        });
        yield* refreshDay(ctx, cs, sid, input.school_date, { extraEvents: [ev], stored: day.stored });
        confirmed.push(sid);
        if (!verifyRule || verifyRule.params_json.notify_guardian_on_confirm) {
          const s = yield ctx.store.get('Students', sid);
          yield* emitNotification(ctx, cs, {
            type: 'ABSENCE_CONFIRMED', sourceEntityType: 'AttendanceEvents', sourceEntityId: ev.id, studentId: sid, audience: 'GUARDIANS_OF_STUDENT',
            params: { student_name: studentShortName(s), class_name: cls.name_th, school_date: input.school_date }, recipients: yield* guardianRecipients(ctx, sid, 'ABSENCE_CONFIRMED'),
          });
        }
      }
      const sessionId = deterministicId.rollCallSession(input.class_id, input.school_date);
      const session = yield ctx.store.get('RollCallSessions', sessionId, { partitions: partitionsForDates(ctx, [input.school_date]) });
      if (session && session.status === 'SUBMITTED') cs.update('RollCallSessions', session, { status: 'VERIFIED', verified_by: ctx.principal.user_id, verified_at: ctx.now });
      cs.audit({ action: 'attendance.verify_day', entityType: 'Classes', entityId: input.class_id, after: { school_date: input.school_date, confirmed: confirmed.length, refused: refused.length } });
      const res = yield* commit(ctx, cs, { confirmed, refused });
      return res;
    },
  }),

  op({
    name: 'attendance.correct', mutation: true, retryOnConflict: 1, permission: 'attendance.correct',
    description_th: 'แก้ไขข้อมูลการมาเรียนย้อนหลัง (เหตุผล + audit + เหตุการณ์ใหม่ supersede เดิม) แล้วคำนวณใหม่และแจ้งเฉพาะผู้ได้รับผลกระทบ',
    input: obj({
      student_id: S.uuid, school_date: S.date, correction_type: S.enum('CorrectionType'), target_event_id: S.uuidOrNull, new_arrived_at: { type: ['string', 'null'], format: 'timestamp' },
      new_mark: { type: ['string', 'null'], enum: ['PRESENT', 'ABSENT', 'LATE', 'LEAVE_REPORTED', null] }, reason: S.str(1000, 5), correction_id: S.uuidOrNull,
    }, ['student_id', 'school_date', 'correction_type', 'reason']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'attendance.correct', { student_id: input.student_id, dates: [input.school_date] });
      return yield* applyCorrection(ctx, input, null);
    },
  }),

  op({
    name: 'attendance.requestCorrection', mutation: true, permission: 'attendance.request_correction',
    description_th: 'นักเรียน/ผู้ปกครองร้องขอแก้ไขข้อมูลการมาเรียน (เข้าคิวครูพิจารณา)',
    input: obj({ student_id: S.uuid, school_date: S.date, correction_type: S.enum('CorrectionType'), requested_text: S.str(1000, 5) }, ['student_id', 'school_date', 'correction_type', 'requested_text']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'attendance.request_correction', { student_id: input.student_id });
      const cs = ctx.changeSet();
      const c = cs.insert('AttendanceCorrections', {
        student_id: input.student_id, school_date: input.school_date, correction_type: input.correction_type, requested_by: ctx.principal.user_id, requested_at: ctx.now,
        reason: input.requested_text, requested_change: { text: input.requested_text }, status: 'PENDING',
      });
      const enr = yield* effectiveEnrollment(ctx, input.student_id, input.school_date);
      const dedupe = `CORRECTION|${c.id}`;
      cs.insert('ReconciliationTasks', {
        id: deterministicId.reconciliationTask(dedupe), task_type: 'DATA_QUALITY', student_id: input.student_id, class_id: enr ? enr.class_id : null, school_date: input.school_date,
        evidence_refs: { correction_id: c.id }, description_th: 'มีคำขอแก้ไขข้อมูลการมาเรียนจากนักเรียน/ผู้ปกครอง', assigned_role: 'HOMEROOM_TEACHER', status: 'OPEN', dedupe_key: dedupe,
      });
      cs.audit({ action: 'attendance.request_correction', entityType: 'AttendanceCorrections', entityId: c.id, studentId: input.student_id, reason: input.requested_text });
      return yield* commit(ctx, cs, { correction_id: c.id, status: 'PENDING' });
    },
  }),

  op({
    name: 'attendance.decideCorrection', mutation: true, permission: 'attendance.correct',
    description_th: 'พิจารณาคำขอแก้ไข: ไม่อนุมัติ หรืออนุมัติพร้อมระบุการแก้ไข',
    input: obj({ correction_id: S.uuid, decision: { type: 'string', enum: ['APPLY', 'REJECT'] }, decision_note: S.str(1000, 2), target_event_id: S.uuidOrNull, new_arrived_at: { type: ['string', 'null'], format: 'timestamp' }, new_mark: { type: ['string', 'null'], enum: ['PRESENT', 'ABSENT', 'LATE', 'LEAVE_REPORTED', null] } }, ['correction_id', 'decision', 'decision_note']),
    *handler(ctx, input, env) {
      const c = yield ctx.store.get('AttendanceCorrections', input.correction_id);
      if (!c) throw notFound('correction');
      yield* requirePermission(ctx, 'attendance.correct', { student_id: c.student_id, dates: [c.school_date] });
      assertVersion(c, env.expected_version);
      if (c.status !== 'PENDING') throw new AppError('INVALID_STATE', 'decided', { messageTh: 'คำขอนี้พิจารณาแล้ว' });
      if (input.decision === 'REJECT') {
        const cs = ctx.changeSet();
        cs.update('AttendanceCorrections', c, { status: 'REJECTED', decided_by: ctx.principal.user_id, decided_at: ctx.now, decision_note: input.decision_note });
        yield* closeCorrectionTask(ctx, cs, c.id, input.decision_note);
        cs.audit({ action: 'attendance.correction_rejected', entityType: 'AttendanceCorrections', entityId: c.id, studentId: c.student_id, reason: input.decision_note });
        return yield* commit(ctx, cs, { correction_id: c.id, status: 'REJECTED' });
      }
      return yield* applyCorrection(ctx, { student_id: c.student_id, school_date: c.school_date, correction_type: c.correction_type, target_event_id: input.target_event_id, new_arrived_at: input.new_arrived_at, new_mark: input.new_mark, reason: `${c.reason} | ${input.decision_note}` }, c);
    },
  }),

  op({
    name: 'attendance.exempt', mutation: true, permission: 'attendance.exempt',
    description_th: 'รับรองข้อยกเว้นการนับสาย (เช่น รถโรงเรียนล่าช้า) — แสดงทั้งเหตุการณ์จริงและผลการยกเว้น',
    input: obj({ school_date: S.date, student_ids: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: S.uuid }, reason_code: { type: 'string', enum: ['TRANSPORT_DELAY', 'WEATHER', 'SCHOOL_EVENT', 'OTHER'] }, reason_text: S.str(500, 5) }, ['school_date', 'student_ids', 'reason_code', 'reason_text']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'attendance.exempt');
      const cs = ctx.changeSet();
      let applied = 0;
      for (const sid of input.student_ids) {
        const events = yield* eventsFor(ctx, sid, input.school_date);
        if (activeEvents(events).some((e) => e.event_type === 'LATENESS_EXEMPTED')) continue;
        const ev = cs.insert('AttendanceEvents', {
          student_id: sid, school_date: input.school_date, event_type: 'LATENESS_EXEMPTED', occurred_at: ctx.now, recorded_at: ctx.now, source: 'SYSTEM', offline: false,
          actor_id: ctx.principal.user_id, reason_code: input.reason_code, reason_text: input.reason_text, operation_id: cs.operationId,
        });
        yield* refreshDay(ctx, cs, sid, input.school_date, { events: [...events, ev] });
        applied++;
      }
      cs.audit({ action: 'attendance.exempt', entityType: null, reason: input.reason_text, after: { school_date: input.school_date, students: input.student_ids.length, applied, reason_code: input.reason_code } });
      return yield* commit(ctx, cs, { applied });
    },
  }),

  op({
    name: 'reconciliation.list', description_th: 'งานตรวจสอบข้อมูลขัดกัน/ยังไม่ทราบสถานะ ตามขอบเขต', permission: 'attendance.reconcile',
    input: obj({ status: S.enumOrNull('TaskStatus'), class_id: S.uuidOrNull, cursor: S.cursor, limit: S.limit }),
    *handler(ctx, input) {
      const scope = scopeFor(ctx, 'attendance.reconcile');
      const where = { status: input.status || 'OPEN' };
      if (input.class_id) where.class_id = input.class_id;
      else if (!scope.all) where.class_id = { in: [...scope.classIds] };
      const page = yield ctx.store.list('ReconciliationTasks', { where, orderBy: [['created_at', 'desc']], cursor: input.cursor, limit: input.limit || 50 });
      const students = yield ctx.store.getMany('Students', page.items.map((t) => t.student_id).filter(Boolean));
      return { items: page.items.map((t) => ({ ...t, student_name: t.student_id && students.get(t.student_id) ? studentShortName(students.get(t.student_id)) : null })), next_cursor: page.next_cursor };
    },
  }),

  op({
    name: 'reconciliation.resolve', mutation: true, description_th: 'ปิดงานตรวจสอบพร้อมบันทึกข้อสรุป', permission: 'attendance.reconcile',
    input: obj({ task_id: S.uuid, status: { type: 'string', enum: ['RESOLVED', 'DISMISSED'] }, resolution_note: S.str(1000, 2) }, ['task_id', 'status', 'resolution_note']),
    *handler(ctx, input, env) {
      const t = yield ctx.store.get('ReconciliationTasks', input.task_id);
      if (!t) throw notFound('task');
      if (t.class_id) yield* requirePermission(ctx, 'attendance.reconcile', { class_id: t.class_id, student_id: t.student_id || undefined });
      else yield* requirePermission(ctx, 'attendance.reconcile', { student_id: t.student_id || undefined });
      assertVersion(t, env.expected_version);
      if (t.status !== 'OPEN') throw new AppError('INVALID_STATE', 'closed');
      const cs = ctx.changeSet();
      cs.update('ReconciliationTasks', t, { status: input.status, resolution_note: input.resolution_note, resolved_by: ctx.principal.user_id, resolved_at: ctx.now });
      cs.audit({ action: 'reconciliation.resolve', entityType: 'ReconciliationTasks', entityId: t.id, studentId: t.student_id, reason: input.resolution_note });
      return yield* commit(ctx, cs, { task_id: t.id });
    },
  }),

  op({
    name: 'attendance.classDay', description_th: 'สรุปรายวันของห้อง (projection เดียวกับรายงาน)', permission: 'attendance.read',
    input: obj({ class_id: S.uuid, school_date: S.date }, ['class_id', 'school_date']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'attendance.read', { class_id: input.class_id });
      const roster = yield* rosterOf(ctx, input.class_id, input.school_date);
      const students = yield ctx.store.getMany('Students', roster.map((e) => e.student_id));
      const cls = yield* getClass(ctx, input.class_id);
      const pre = yield* preloadDay(ctx, input.school_date, roster.map((e) => e.student_id));
      const items = [];
      for (const e of roster) {
        const { computed } = yield* computeDay(ctx, e.student_id, input.school_date, { ...pre.get(e.student_id), enrollment: e });
        items.push({ student: basicStudent(students.get(e.student_id), cls), roll_no: e.roll_no, ...pick(computed) });
      }
      return { class: { id: cls.id, name_th: cls.name_th }, school_date: input.school_date, items };
    },
  }),
];

function pick(p) {
  const keys = ['presence_status', 'verification_level', 'is_late', 'late_minutes', 'late_counted', 'lateness_exempted', 'arrived_at', 'roll_call_mark', 'full_day_leave', 'partial_leave', 'leave_units', 'confirmed_absence', 'has_conflict', 'conflicts'];
  return Object.fromEntries(keys.map((k) => [k, p[k]]));
}

/** Apply a correction as new superseding events (never overwriting history). */
function* applyCorrection(ctx, input, request) {
  const date = input.school_date;
  const student = yield* requireStudent(ctx, input.student_id);
  const events = yield* eventsFor(ctx, student.id, date);
  const act = activeEvents(events);
  const before = yield* computeDay(ctx, student.id, date);
  const cs = ctx.changeSet();
  const target = input.target_event_id ? events.find((e) => e.id === input.target_event_id) : null;
  if (input.target_event_id && (!target || !act.some((e) => e.id === target.id))) throw new AppError('VALIDATION_ERROR', 'target', { messageTh: 'ไม่พบรายการที่ต้องการแก้ไข (หรือถูกแก้ไปแล้ว)' });
  const correctionId = request ? request.id : ctx.ids.uuid();
  const base = { student_id: student.id, school_date: date, recorded_at: ctx.now, offline: false, actor_id: ctx.principal.user_id, reason_text: input.reason, operation_id: cs.operationId, source: 'CORRECTION' };
  const newEvents = [];
  switch (input.correction_type) {
    case 'VOID_EVENT':
      if (!target) throw new AppError('VALIDATION_ERROR', 'target required', { fieldErrors: [{ field: 'target_event_id', code: 'REQUIRED', message_th: 'เลือกรายการที่ต้องการยกเลิก' }] });
      newEvents.push(cs.insert('AttendanceEvents', { ...base, event_type: 'EVENT_VOIDED', occurred_at: ctx.now, supersedes_event_id: target.id }));
      break;
    case 'AMEND_ARRIVAL_TIME': {
      const arrival = target || act.find((e) => e.event_type === 'GATE_ARRIVAL');
      if (!arrival || arrival.event_type !== 'GATE_ARRIVAL') throw new AppError('VALIDATION_ERROR', 'no arrival', { messageTh: 'ไม่มีบันทึกมาถึงให้แก้เวลา ใช้ "เพิ่มรายการมาถึง"' });
      if (!input.new_arrived_at || schoolDateOf(input.new_arrived_at, ctx.tz) !== date) throw new AppError('VALIDATION_ERROR', 'time', { fieldErrors: [{ field: 'new_arrived_at', code: 'INVALID', message_th: 'เวลาใหม่ต้องอยู่ในวันเดียวกัน' }] });
      newEvents.push(cs.insert('AttendanceEvents', { ...base, event_type: 'GATE_ARRIVAL', occurred_at: input.new_arrived_at, station_id: arrival.station_id, class_id: arrival.class_id, supersedes_event_id: arrival.id, dedupe_key: `${arrivalDedupeKey(student.id, date)}|${correctionId}` }));
      break;
    }
    case 'ADD_ARRIVAL':
      if (act.some((e) => e.event_type === 'GATE_ARRIVAL')) throw new AppError('VALIDATION_ERROR', 'exists', { messageTh: 'มีบันทึกมาถึงแล้ว ใช้ "แก้เวลามาถึง"' });
      if (!input.new_arrived_at || schoolDateOf(input.new_arrived_at, ctx.tz) !== date) throw new AppError('VALIDATION_ERROR', 'time', { fieldErrors: [{ field: 'new_arrived_at', code: 'INVALID', message_th: 'เวลาต้องอยู่ในวันเดียวกัน' }] });
      newEvents.push(cs.insert('AttendanceEvents', { ...base, event_type: 'GATE_ARRIVAL', occurred_at: input.new_arrived_at, dedupe_key: `${arrivalDedupeKey(student.id, date)}|${correctionId}` }));
      break;
    case 'CHANGE_ROLL_CALL_MARK': {
      if (!input.new_mark) throw new AppError('VALIDATION_ERROR', 'mark', { fieldErrors: [{ field: 'new_mark', code: 'REQUIRED', message_th: 'เลือกผลเช็กชื่อใหม่' }] });
      const last = act.filter((e) => e.event_type.startsWith('ROLL_CALL_')).pop() || null;
      newEvents.push(cs.insert('AttendanceEvents', { ...base, event_type: `ROLL_CALL_${input.new_mark}`, occurred_at: ctx.now, supersedes_event_id: last ? last.id : null }));
      const absence = act.find((e) => e.event_type === 'ABSENCE_CONFIRMED');
      if (absence && input.new_mark !== 'ABSENT') newEvents.push(cs.insert('AttendanceEvents', { ...base, event_type: 'EVENT_VOIDED', occurred_at: ctx.now, supersedes_event_id: absence.id }));
      break;
    }
    case 'EXEMPT_LATENESS':
      if (act.some((e) => e.event_type === 'LATENESS_EXEMPTED')) throw new AppError('INVALID_STATE', 'already exempt');
      newEvents.push(cs.insert('AttendanceEvents', { ...base, event_type: 'LATENESS_EXEMPTED', occurred_at: ctx.now, reason_code: 'OTHER' }));
      break;
    default:
      throw new AppError('VALIDATION_ERROR', 'type');
  }
  const after = yield* refreshDay(ctx, cs, student.id, date, { events: [...events, ...newEvents], stored: before.stored });
  const corrFields = {
    status: 'APPLIED', decided_by: ctx.principal.user_id, decided_at: ctx.now, resulting_event_id: newEvents[0].id,
    before_json: summaryFields(before.computed), after_json: summaryFields(after.computed), decision_note: request ? input.reason : null,
  };
  if (request) {
    cs.update('AttendanceCorrections', request, corrFields);
    yield* closeCorrectionTask(ctx, cs, request.id, input.reason);
  }
  else cs.insert('AttendanceCorrections', { id: correctionId, student_id: student.id, school_date: date, target_event_id: input.target_event_id, correction_type: input.correction_type, requested_by: ctx.principal.user_id, requested_at: ctx.now, reason: input.reason, requested_change: { new_arrived_at: input.new_arrived_at || null, new_mark: input.new_mark || null }, ...corrFields });
  cs.audit({ action: 'attendance.correct', entityType: 'AttendanceCorrections', entityId: correctionId, studentId: student.id, reason: input.reason, before: summaryFields(before.computed), after: summaryFields(after.computed) });
  const notable = ['presence_status', 'late_counted', 'confirmed_absence'].some((k) => before.computed[k] !== after.computed[k]);
  const wasNotified = before.computed.late_counted || before.computed.confirmed_absence;
  if (notable && wasNotified) {
    yield* emitNotification(ctx, cs, {
      type: 'DATA_CORRECTED', sourceEntityType: 'AttendanceCorrections', sourceEntityId: correctionId, studentId: student.id, audience: 'GUARDIANS_OF_STUDENT', purpose: correctionId,
      params: { student_name: studentShortName(student), school_date: date, change_th: `${ENUMS.PresenceStatus.th[before.computed.presence_status]} → ${ENUMS.PresenceStatus.th[after.computed.presence_status]}${before.computed.late_counted && !after.computed.late_counted ? ' (ไม่นับสาย)' : ''}` },
      recipients: yield* guardianRecipients(ctx, student.id, 'DATA_CORRECTED'),
    });
  }
  return yield* commit(ctx, cs, { correction_id: correctionId, status: 'APPLIED', before: summaryFields(before.computed), after: summaryFields(after.computed) });
}

/** A decided correction request closes the review task opened by attendance.requestCorrection. */
function* closeCorrectionTask(ctx, cs, correctionId, note) {
  const task = yield ctx.store.get('ReconciliationTasks', deterministicId.reconciliationTask(`CORRECTION|${correctionId}`));
  if (task && task.status === 'OPEN') cs.update('ReconciliationTasks', task, { status: 'RESOLVED', resolution_note: String(note).slice(0, 1000), resolved_by: ctx.principal.user_id, resolved_at: ctx.now });
}

function summaryFields(p) {
  return { presence_status: p.presence_status, is_late: p.is_late, late_minutes: p.late_minutes, late_counted: p.late_counted, confirmed_absence: p.confirmed_absence, roll_call_mark: p.roll_call_mark };
}

export { homeroomRecipients, hasRole };

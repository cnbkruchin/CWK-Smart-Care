// Follow-up operations (MASTER_PROMPT §7.6): cases (rule/manual/callback), contact logs, appointments
// and the contact inbox. Every read/write is authorised against the case owner (OWN) or the student's
// class/school scope; contacts are recorded only when staff log the outcome (tapping tel: is not a call).
import { op } from '../dispatcher.js';
import { obj, S, notFound, assertVersion } from './common.js';
import { requirePermission, allows, scopeFor, studentClassIds } from '../authz.js';
import { commit } from '../context.js';
import { requireStudent, listAll } from '../queries.js';
import { loadFacts } from '../principal.js';
import { emitNotification, studentShortName } from '../services/notify.js';
import { stageNewCase, caseEvent, cooldownUntil, currentClassOf } from '../services/followup.js';
import { caseDedupeKey, statusAfterContact } from '../../domain/followup.js';
import { decide } from '../../domain/permissions.js';
import { assertTransition } from '../../domain/state-machines.js';
import { AppError } from '../../shared/errors.js';
import { dateInRange, addMinutesIso } from '../../shared/time.js';
import { ENUMS } from '../../schema/enums.js';

const PRIORITY_ORDER = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const ACTIVE = ['OPEN', 'IN_PROGRESS', 'WAITING_RESPONSE', 'RESOLVED'];
const TS = { type: ['string', 'null'], format: 'timestamp' };

/** Case access: the owner (OWN grant) or class/school scope over the student. */
function* authorizeCase(ctx, action, kase) {
  if (kase.owner_user_id && (yield* allows(ctx, action, { owner_user_id: kase.owner_user_id }))) return;
  yield* requirePermission(ctx, action, { student_id: kase.student_id });
}

function* canCase(ctx, action, kase) {
  try { yield* authorizeCase(ctx, action, kase); return true; } catch (e) { if (e.code === 'FORBIDDEN') return false; throw e; }
}

function* loadCase(ctx, id) {
  const kase = yield ctx.store.get('Cases', id);
  if (!kase) throw notFound('case');
  return kase;
}

/** Whether `user` may manage cases of the student through class/school scope (not merely by owning it). */
function* userMayManage(ctx, user, studentId) {
  if (!user || user.status !== 'ACTIVE') return false;
  const facts = yield* loadFacts(ctx, user, ctx.today);
  const classIds = yield* studentClassIds(ctx, studentId);
  return decide(facts, 'case.manage', { student_id: studentId, class_ids: classIds }).allowed;
}

/** Student ids (current enrollment) of the given classes. */
function* studentsOfClasses(ctx, classIds) {
  const ids = new Set();
  for (const cid of classIds) {
    for (const e of yield ctx.store.findBy('Enrollments', 'class_id', cid)) if (dateInRange(ctx.today, e.effective_from, e.effective_to)) ids.add(e.student_id);
  }
  return ids;
}

function* caseSummaries(ctx, cases) {
  const students = yield ctx.store.getMany('Students', [...new Set(cases.map((c) => c.student_id))]);
  const owners = yield ctx.store.getMany('Users', [...new Set(cases.map((c) => c.owner_user_id).filter(Boolean))]);
  const out = [];
  for (const c of cases) {
    const s = students.get(c.student_id);
    const cls = s ? yield* currentClassOf(ctx, s.id) : null;
    out.push({
      id: c.id, case_type: c.case_type, status: c.status, priority: c.priority, trigger_summary_th: c.trigger_summary_th, next_action_th: c.next_action_th,
      due_at: c.due_at, overdue: !!(c.due_at && c.due_at < ctx.now && c.status !== 'CLOSED' && c.status !== 'RESOLVED'), next_appointment_at: c.next_appointment_at,
      owner_user_id: c.owner_user_id, owner_name: c.owner_user_id && owners.get(c.owner_user_id) ? owners.get(c.owner_user_id).display_name : null,
      student: s ? { id: s.id, student_code: s.student_code, name: studentShortName(s), class_name_th: cls ? cls.name_th : null } : null,
      created_at: c.created_at, updated_at: c.updated_at, version: c.version,
    });
  }
  return out;
}

export const followupOps = [
  op({
    name: 'case.list', description_th: 'รายการเรื่องติดตามตามขอบเขต (ของฉัน/ห้องที่ปรึกษา/ทั้งโรงเรียน)', permission: 'case.read',
    input: obj({ status: { type: ['string', 'null'], enum: [...ENUMS.CaseStatus.values, 'ACTIVE', null] }, mine: { type: ['boolean', 'null'] }, student_id: S.uuidOrNull, overdue_only: { type: ['boolean', 'null'] }, limit: S.limit }),
    *handler(ctx, input) {
      const scope = scopeFor(ctx, 'case.read');
      const status = input.status || 'ACTIVE';
      const where = status === 'ACTIVE' ? { status: { in: ACTIVE } } : { status };
      let cases;
      if (input.student_id) {
        yield* requirePermission(ctx, 'case.read', { student_id: input.student_id });
        cases = (yield ctx.store.findBy('Cases', 'student_id', input.student_id)).filter((c) => (status === 'ACTIVE' ? ACTIVE.includes(c.status) : c.status === status));
      } else if (input.mine) {
        cases = (yield ctx.store.findBy('Cases', 'owner_user_id', ctx.principal.user_id)).filter((c) => (status === 'ACTIVE' ? ACTIVE.includes(c.status) : c.status === status));
      } else {
        cases = (yield ctx.store.list('Cases', { where, limit: 500 })).items;
        if (!scope.all) {
          const ids = yield* studentsOfClasses(ctx, scope.classIds || []);
          cases = cases.filter((c) => ids.has(c.student_id) || (scope.own && c.owner_user_id === ctx.principal.user_id));
        }
      }
      if (input.overdue_only) cases = cases.filter((c) => c.due_at && c.due_at < ctx.now && c.status !== 'RESOLVED' && c.status !== 'CLOSED');
      cases.sort((a, b) => (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) || String(a.due_at || '9999').localeCompare(String(b.due_at || '9999')));
      const items = yield* caseSummaries(ctx, cases.slice(0, input.limit || 100));
      return { items, total: cases.length };
    },
  }),

  op({
    name: 'case.get', description_th: 'รายละเอียดเรื่องติดตาม: หลักฐานที่เข้ากฎ บันทึกการติดต่อ นัดหมาย และประวัติ', permission: 'case.read',
    input: obj({ case_id: S.uuid }, ['case_id']),
    *handler(ctx, input) {
      const kase = yield* loadCase(ctx, input.case_id);
      yield* authorizeCase(ctx, 'case.read', kase);
      const [summary] = yield* caseSummaries(ctx, [kase]);
      const events = (yield ctx.store.findBy('CaseEvents', 'case_id', kase.id)).sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
      const contacts = (yield ctx.store.findBy('ContactLogs', 'case_id', kase.id)).sort((a, b) => (a.contacted_at < b.contacted_at ? 1 : -1));
      const appointments = (yield ctx.store.findBy('Appointments', 'case_id', kase.id)).sort((a, b) => (a.scheduled_at < b.scheduled_at ? 1 : -1));
      const actors = yield ctx.store.getMany('Users', [...new Set([...events.map((e) => e.actor_id), ...contacts.map((c) => c.contacted_by)])]);
      const name = (id) => (actors.get(id) ? actors.get(id).display_name : '—');
      let guardians = null;
      if (yield* allows(ctx, 'guardian.read_contact', { student_id: kase.student_id })) {
        guardians = [];
        for (const l of (yield ctx.store.findBy('StudentGuardians', 'student_id', kase.student_id)).filter((x) => x.status === 'ACTIVE' && dateInRange(ctx.today, x.effective_from, x.effective_to))) {
          const g = yield ctx.store.get('Guardians', l.guardian_id);
          const eps = (yield ctx.store.findBy('ContactEndpoints', 'owner_id', l.guardian_id)).filter((c) => c.status === 'ACTIVE');
          guardians.push({ guardian_id: l.guardian_id, name: g ? `${g.prefix_th || ''}${g.first_name_th} ${g.last_name_th}` : '', relationship: l.relationship, is_primary_contact: l.is_primary_contact, contacts: eps.map((c) => ({ channel: c.channel, value: c.value, label_th: c.label_th })) });
        }
        guardians.sort((a, b) => Number(b.is_primary_contact) - Number(a.is_primary_contact));
      }
      return {
        case: { ...summary, rule_version_id: kase.rule_version_id, trigger_evidence: kase.trigger_evidence_json, resolution_summary: kase.resolution_summary, closed_at: kase.closed_at, reopened_count: kase.reopened_count, cooldown_until: kase.cooldown_until },
        events: events.map((e) => ({ ...e, actor_name: name(e.actor_id) })),
        contacts: contacts.map((c) => ({ ...c, contacted_by_name: name(c.contacted_by) })),
        appointments, guardians,
        can: { manage: yield* canCase(ctx, 'case.manage', kase), record_contact: yield* canCase(ctx, 'case.record_contact', kase) },
      };
    },
  }),

  op({
    name: 'case.create', mutation: true, description_th: 'ครูเปิดเรื่องติดตามเอง (ระบุเหตุผลเชิงข้อเท็จจริง ไม่ตัดสินพฤติกรรม)', permission: 'case.manage',
    input: obj({ student_id: S.uuid, summary_th: S.str(1000, 5), priority: S.enum('Priority'), next_action_th: S.strOrNull(500), due_at: TS, owner_user_id: S.uuidOrNull }, ['student_id', 'summary_th', 'priority']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'case.manage', { student_id: input.student_id });
      const student = yield* requireStudent(ctx, input.student_id);
      let owner;
      if (input.owner_user_id) {
        const u = yield ctx.store.get('Users', input.owner_user_id);
        if (!(yield* userMayManage(ctx, u, student.id))) throw new AppError('VALIDATION_ERROR', 'owner', { fieldErrors: [{ field: 'owner_user_id', code: 'INVALID', message_th: 'ผู้รับผิดชอบต้องมีสิทธิ์ดูแลนักเรียนคนนี้' }] });
        owner = { user: u, role: 'HOMEROOM_TEACHER' };
      } else {
        const me = ctx.principal.user;
        owner = { user: me, role: ctx.principal.roles.has('STUDENT_AFFAIRS') ? 'STUDENT_AFFAIRS' : 'HOMEROOM_TEACHER' };
      }
      if (input.due_at && input.due_at < ctx.now) throw new AppError('VALIDATION_ERROR', 'due', { fieldErrors: [{ field: 'due_at', code: 'INVALID', message_th: 'กำหนดเวลาต้องไม่อยู่ในอดีต' }] });
      const cs = ctx.changeSet();
      const id = ctx.ids.uuid();
      const kase = yield* stageNewCase(ctx, cs, {
        student, caseType: 'MANUAL', dedupeKey: caseDedupeKey('MANUAL', student.id, id), priority: input.priority, owner, summaryTh: input.summary_th,
        dueAt: input.due_at || addMinutesIso(ctx.now, 3 * 24 * 60), evidence: { opened_by: ctx.principal.user_id }, nextActionTh: input.next_action_th,
      });
      return yield* commit(ctx, cs, { case_id: kase.id, version: kase.version });
    },
  }),

  op({
    name: 'case.update', mutation: true, description_th: 'ปรับความสำคัญ กำหนดเวลา และสิ่งที่ต้องทำต่อ', permission: 'case.manage',
    input: obj({ case_id: S.uuid, priority: { type: ['string', 'null'], enum: [...ENUMS.Priority.values, null] }, due_at: TS, next_action_th: S.strOrNull(500), note: S.strOrNull(1000) }, ['case_id']),
    *handler(ctx, input, env) {
      const kase = yield* loadCase(ctx, input.case_id);
      yield* authorizeCase(ctx, 'case.manage', kase);
      assertVersion(kase, env.expected_version);
      if (kase.status === 'CLOSED') throw new AppError('INVALID_STATE', 'closed', { messageTh: 'เรื่องนี้ปิดแล้ว เปิดใหม่ก่อนแก้ไข' });
      const patch = {};
      if (input.priority) patch.priority = input.priority;
      if (input.due_at) patch.due_at = input.due_at;
      if (input.next_action_th) patch.next_action_th = input.next_action_th;
      if (!Object.keys(patch).length && !input.note) throw new AppError('VALIDATION_ERROR', 'nothing to change', { messageTh: 'ไม่มีรายการที่เปลี่ยน' });
      const cs = ctx.changeSet();
      const after = Object.keys(patch).length ? cs.update('Cases', kase, patch) : kase;
      caseEvent(cs, ctx, kase, 'NOTE', { data: Object.keys(patch).length ? patch : null, note: input.note || null });
      cs.audit({ action: 'case.update', entityType: 'Cases', entityId: kase.id, studentId: kase.student_id, before: kase, after, table: 'Cases' });
      return yield* commit(ctx, cs, { case_id: kase.id, version: after.version });
    },
  }),

  op({
    name: 'case.assign', mutation: true, description_th: 'มอบหมาย/ส่งต่อผู้รับผิดชอบ (ผู้รับต้องมีสิทธิ์ดูแลนักเรียน)', permission: 'case.manage',
    input: obj({ case_id: S.uuid, owner_user_id: S.uuid, reason: S.str(500, 3) }, ['case_id', 'owner_user_id', 'reason']),
    *handler(ctx, input, env) {
      const kase = yield* loadCase(ctx, input.case_id);
      yield* authorizeCase(ctx, 'case.manage', kase);
      assertVersion(kase, env.expected_version);
      assertTransition('Case', kase.status, 'ASSIGN');
      const u = yield ctx.store.get('Users', input.owner_user_id);
      if (!(yield* userMayManage(ctx, u, kase.student_id))) throw new AppError('VALIDATION_ERROR', 'owner', { fieldErrors: [{ field: 'owner_user_id', code: 'INVALID', message_th: 'ผู้รับต้องมีสิทธิ์ดูแลนักเรียนคนนี้ (ครูที่ปรึกษาหรือกิจการนักเรียน)' }] });
      if (u.id === kase.owner_user_id) throw new AppError('VALIDATION_ERROR', 'same owner', { messageTh: 'ผู้รับผิดชอบคนเดิม' });
      const cs = ctx.changeSet();
      const after = cs.update('Cases', kase, { owner_user_id: u.id });
      caseEvent(cs, ctx, kase, kase.owner_user_id ? 'TRANSFERRED' : 'ASSIGNED', { data: { from: kase.owner_user_id, to: u.id }, note: input.reason });
      cs.audit({ action: 'case.assign', entityType: 'Cases', entityId: kase.id, studentId: kase.student_id, reason: input.reason, after: { owner_user_id: u.id } });
      const student = yield* requireStudent(ctx, kase.student_id);
      yield* emitNotification(ctx, cs, {
        type: 'CASE_NEW', sourceEntityType: 'Cases', sourceEntityId: kase.id, studentId: kase.student_id, purpose: `assign|${after.version}`,
        params: { student_name: studentShortName(student), summary_th: `ได้รับมอบหมาย: ${kase.trigger_summary_th}` }, recipients: [{ user: u, role: 'HOMEROOM_TEACHER' }], noAck: true,
      });
      return yield* commit(ctx, cs, { case_id: kase.id, version: after.version });
    },
  }),

  op({
    name: 'case.assignable', description_th: 'รายชื่อผู้ที่รับมอบหมายเรื่องของนักเรียนคนนี้ได้', permission: 'case.manage',
    input: obj({ student_id: S.uuid }, ['student_id']),
    *handler(ctx, input) {
      yield* requirePermission(ctx, 'case.manage', { student_id: input.student_id });
      const candidates = new Map();
      const cls = yield* currentClassOf(ctx, input.student_id);
      if (cls) for (const a of (yield ctx.store.findBy('StaffAssignments', 'class_id', cls.id)).filter((x) => x.assignment_type === 'HOMEROOM' && dateInRange(ctx.today, x.effective_from, x.effective_to))) candidates.set(a.user_id, 'HOMEROOM_TEACHER');
      for (const r of (yield ctx.store.findBy('UserRoles', 'role', 'STUDENT_AFFAIRS')).filter((x) => !x.revoked_at && dateInRange(ctx.today, x.effective_from, x.effective_to))) if (!candidates.has(r.user_id)) candidates.set(r.user_id, 'STUDENT_AFFAIRS');
      const users = yield ctx.store.getMany('Users', [...candidates.keys()]);
      const items = [];
      for (const [id, role] of candidates) {
        const u = users.get(id);
        if (u && (yield* userMayManage(ctx, u, input.student_id))) items.push({ user_id: u.id, display_name: u.display_name, role });
      }
      return { items: items.sort((a, b) => a.display_name.localeCompare(b.display_name, 'th')) };
    },
  }),

  op({
    name: 'case.resolve', mutation: true, description_th: 'บันทึกว่าแก้ไขแล้ว (รอปิดเรื่อง)', permission: 'case.manage',
    input: obj({ case_id: S.uuid, note: S.str(1000, 3) }, ['case_id', 'note']),
    *handler(ctx, input, env) {
      const kase = yield* loadCase(ctx, input.case_id);
      yield* authorizeCase(ctx, 'case.manage', kase);
      assertVersion(kase, env.expected_version);
      assertTransition('Case', kase.status, 'RESOLVE');
      const cs = ctx.changeSet();
      const after = cs.update('Cases', kase, { status: 'RESOLVED' });
      caseEvent(cs, ctx, kase, 'STATUS_CHANGED', { data: { from: kase.status, to: 'RESOLVED' }, note: input.note });
      cs.audit({ action: 'case.resolve', entityType: 'Cases', entityId: kase.id, studentId: kase.student_id, reason: input.note });
      return yield* commit(ctx, cs, { case_id: kase.id, status: 'RESOLVED', version: after.version });
    },
  }),

  op({
    name: 'case.close', mutation: true, description_th: 'ปิดเรื่องพร้อมข้อสรุป (เรื่องที่มาจากกฎจะมีช่วงพักก่อนเปิดใหม่)', permission: 'case.manage',
    input: obj({ case_id: S.uuid, resolution_summary: S.str(2000, 5) }, ['case_id', 'resolution_summary']),
    *handler(ctx, input, env) {
      const kase = yield* loadCase(ctx, input.case_id);
      yield* authorizeCase(ctx, 'case.manage', kase);
      assertVersion(kase, env.expected_version);
      assertTransition('Case', kase.status, 'CLOSE');
      const cooldown = yield* cooldownUntil(ctx, kase);
      const cs = ctx.changeSet();
      const after = cs.update('Cases', kase, { status: 'CLOSED', resolution_summary: input.resolution_summary, closed_at: ctx.now, closed_by: ctx.principal.user_id, cooldown_until: cooldown });
      caseEvent(cs, ctx, kase, 'CLOSED', { data: { cooldown_until: cooldown }, note: input.resolution_summary });
      cs.audit({ action: 'case.close', entityType: 'Cases', entityId: kase.id, studentId: kase.student_id, reason: input.resolution_summary });
      return yield* commit(ctx, cs, { case_id: kase.id, status: 'CLOSED', cooldown_until: cooldown, version: after.version });
    },
  }),

  op({
    name: 'case.reopen', mutation: true, description_th: 'เปิดเรื่องที่ปิด/แก้ไขแล้วอีกครั้ง (ต้องมีเหตุผล)', permission: 'case.manage',
    input: obj({ case_id: S.uuid, reason: S.str(1000, 3) }, ['case_id', 'reason']),
    *handler(ctx, input, env) {
      const kase = yield* loadCase(ctx, input.case_id);
      yield* authorizeCase(ctx, 'case.manage', kase);
      assertVersion(kase, env.expected_version);
      assertTransition('Case', kase.status, 'REOPEN');
      if (kase.dedupe_key && kase.status === 'CLOSED') {
        const other = (yield ctx.store.findBy('Cases', 'dedupe_key', kase.dedupe_key)).find((c) => c.id !== kase.id && c.status !== 'CLOSED');
        if (other) throw new AppError('INVALID_STATE', 'another open case', { messageTh: 'มีเรื่องติดตามประเภทเดียวกันของนักเรียนคนนี้เปิดอยู่แล้ว ใช้เรื่องนั้นแทน', details: { case_id: other.id } });
      }
      const cs = ctx.changeSet();
      const after = cs.update('Cases', kase, { status: 'OPEN', closed_at: null, closed_by: null, cooldown_until: null, reopened_count: kase.reopened_count + 1 });
      caseEvent(cs, ctx, kase, 'REOPENED', { note: input.reason });
      cs.audit({ action: 'case.reopen', entityType: 'Cases', entityId: kase.id, studentId: kase.student_id, reason: input.reason });
      return yield* commit(ctx, cs, { case_id: kase.id, status: 'OPEN', version: after.version });
    },
  }),

  op({
    name: 'contact.log', mutation: true, description_th: 'บันทึกผลการติดต่อ (โทร/LINE/พบตัว) — ติดต่อไม่ได้ก็ต้องบันทึก', permission: 'case.record_contact',
    input: obj({
      student_id: S.uuid, case_id: S.uuidOrNull, guardian_id: S.uuidOrNull, channel: S.enum('ContactChannel'), direction: S.enum('ContactDirection'), outcome: S.enum('ContactOutcome'),
      summary: S.str(2000, 3), contacted_at: TS, follow_up_required: S.bool, next_follow_up_at: TS, handles_contact_id: S.uuidOrNull,
    }, ['student_id', 'channel', 'direction', 'outcome', 'summary', 'follow_up_required']),
    *handler(ctx, input) {
      let kase = null;
      if (input.case_id) {
        kase = yield* loadCase(ctx, input.case_id);
        if (kase.student_id !== input.student_id) throw new AppError('VALIDATION_ERROR', 'case/student mismatch', { messageTh: 'เรื่องติดตามไม่ใช่ของนักเรียนคนนี้' });
        yield* authorizeCase(ctx, 'case.record_contact', kase);
        assertTransition('Case', kase.status, 'RECORD_CONTACT');
      } else {
        yield* requirePermission(ctx, 'case.record_contact', { student_id: input.student_id });
      }
      if (input.guardian_id) {
        const link = (yield ctx.store.findBy('StudentGuardians', 'student_id', input.student_id)).find((l) => l.guardian_id === input.guardian_id && l.status !== 'ENDED');
        if (!link) throw new AppError('VALIDATION_ERROR', 'guardian not linked', { fieldErrors: [{ field: 'guardian_id', code: 'INVALID', message_th: 'ผู้ปกครองไม่ได้เชื่อมกับนักเรียนคนนี้' }] });
      }
      const at = input.contacted_at || ctx.now;
      if (at > addMinutesIso(ctx.now, 5)) throw new AppError('VALIDATION_ERROR', 'future', { fieldErrors: [{ field: 'contacted_at', code: 'INVALID', message_th: 'เวลาติดต่อต้องไม่อยู่ในอนาคต' }] });
      if (input.follow_up_required && input.next_follow_up_at && input.next_follow_up_at < ctx.now) throw new AppError('VALIDATION_ERROR', 'next', { fieldErrors: [{ field: 'next_follow_up_at', code: 'INVALID', message_th: 'นัดติดตามครั้งถัดไปต้องไม่อยู่ในอดีต' }] });
      if (input.handles_contact_id) {
        const inbound = yield ctx.store.get('ContactLogs', input.handles_contact_id);
        if (!inbound || inbound.student_id !== input.student_id || inbound.direction !== 'INBOUND') throw new AppError('VALIDATION_ERROR', 'handles', { messageTh: 'ไม่พบรายการติดต่อเข้าที่ต้องการตอบกลับ' });
      }
      const cs = ctx.changeSet();
      const log = cs.insert('ContactLogs', {
        student_id: input.student_id, case_id: kase ? kase.id : null, guardian_id: input.guardian_id, channel: input.channel, direction: input.direction, contacted_at: at,
        contacted_by: ctx.principal.user_id, outcome: input.outcome, summary: input.summary, follow_up_required: input.follow_up_required,
        next_follow_up_at: input.follow_up_required ? input.next_follow_up_at : null, supersedes_id: input.handles_contact_id, operation_id: cs.operationId,
      });
      let version = null;
      if (kase) {
        const status = statusAfterContact(input.outcome);
        const patch = { status };
        if (input.follow_up_required && input.next_follow_up_at) patch.due_at = input.next_follow_up_at;
        const after = cs.update('Cases', kase, patch);
        version = after.version;
        caseEvent(cs, ctx, kase, 'CONTACT_LOGGED', { data: { contact_log_id: log.id, outcome: input.outcome, status }, note: null });
      }
      cs.audit({ action: 'contact.log', entityType: 'ContactLogs', entityId: log.id, studentId: input.student_id, after: { channel: input.channel, direction: input.direction, outcome: input.outcome, case_id: log.case_id } });
      return yield* commit(ctx, cs, { contact_log_id: log.id, case_version: version });
    },
  }),

  op({
    name: 'contact.inbox', description_th: 'ข้อความ/คำขอติดต่อจากผู้ปกครองที่รอครูตอบกลับ (ตามขอบเขต)', permission: 'case.record_contact',
    input: obj({ limit: S.limit }),
    *handler(ctx, input) {
      const scope = scopeFor(ctx, 'case.record_contact');
      const inbound = (yield ctx.store.findBy('ContactLogs', 'direction', 'INBOUND')).filter((c) => c.follow_up_required);
      let allowedStudents = null;
      if (!scope.all) allowedStudents = yield* studentsOfClasses(ctx, scope.classIds || []);
      const visible = inbound.filter((c) => !allowedStudents || allowedStudents.has(c.student_id));
      const handled = visible.length ? new Set((yield* listAll(ctx, 'ContactLogs', { where: { supersedes_id: { in: visible.map((c) => c.id) } } })).map((r) => r.supersedes_id)) : new Set();
      const pending = visible.filter((c) => !handled.has(c.id));
      pending.sort((a, b) => (a.contacted_at < b.contacted_at ? -1 : 1));
      const students = yield ctx.store.getMany('Students', [...new Set(pending.map((c) => c.student_id))]);
      const guardians = yield ctx.store.getMany('Guardians', [...new Set(pending.map((c) => c.guardian_id).filter(Boolean))]);
      return {
        items: pending.slice(0, input.limit || 100).map((c) => ({
          id: c.id, student_id: c.student_id, student_name: students.get(c.student_id) ? studentShortName(students.get(c.student_id)) : '', case_id: c.case_id,
          guardian_name: c.guardian_id && guardians.get(c.guardian_id) ? `${guardians.get(c.guardian_id).first_name_th} ${guardians.get(c.guardian_id).last_name_th}` : null,
          channel: c.channel, contacted_at: c.contacted_at, summary: c.summary, outcome: c.outcome,
        })),
        total: pending.length,
      };
    },
  }),

  op({
    name: 'appointment.create', mutation: true, description_th: 'นัดหมายผู้ปกครอง/นักเรียน', permission: 'case.record_contact',
    input: obj({ case_id: S.uuid, scheduled_at: { type: 'string', format: 'timestamp' }, duration_minutes: { type: ['integer', 'null'], minimum: 5, maximum: 600 }, location: S.strOrNull(200), attendees_note: S.strOrNull(500) }, ['case_id', 'scheduled_at']),
    *handler(ctx, input) {
      const kase = yield* loadCase(ctx, input.case_id);
      yield* authorizeCase(ctx, 'case.record_contact', kase);
      if (kase.status === 'CLOSED') throw new AppError('INVALID_STATE', 'closed', { messageTh: 'เรื่องนี้ปิดแล้ว' });
      if (input.scheduled_at < ctx.now) throw new AppError('VALIDATION_ERROR', 'past', { fieldErrors: [{ field: 'scheduled_at', code: 'INVALID', message_th: 'เวลานัดต้องไม่อยู่ในอดีต' }] });
      const cs = ctx.changeSet();
      const ap = cs.insert('Appointments', { case_id: kase.id, student_id: kase.student_id, scheduled_at: input.scheduled_at, duration_minutes: input.duration_minutes || 30, location: input.location, attendees_note: input.attendees_note, status: 'SCHEDULED' });
      const after = cs.update('Cases', kase, { next_appointment_at: input.scheduled_at, status: kase.status === 'OPEN' ? 'IN_PROGRESS' : kase.status });
      caseEvent(cs, ctx, kase, 'APPOINTMENT_SET', { data: { appointment_id: ap.id, scheduled_at: input.scheduled_at } });
      cs.audit({ action: 'appointment.create', entityType: 'Appointments', entityId: ap.id, studentId: kase.student_id });
      return yield* commit(ctx, cs, { appointment_id: ap.id, case_version: after.version });
    },
  }),

  op({
    name: 'appointment.update', mutation: true, description_th: 'บันทึกผลนัดหมาย/เลื่อน/ยกเลิก', permission: 'case.record_contact',
    input: obj({ appointment_id: S.uuid, status: S.enum('AppointmentStatus'), outcome_note: S.strOrNull(2000), scheduled_at: TS }, ['appointment_id', 'status']),
    *handler(ctx, input, env) {
      const ap = yield ctx.store.get('Appointments', input.appointment_id);
      if (!ap) throw notFound('appointment');
      const kase = ap.case_id ? yield* loadCase(ctx, ap.case_id) : null;
      if (kase) yield* authorizeCase(ctx, 'case.record_contact', kase);
      else yield* requirePermission(ctx, 'case.record_contact', { student_id: ap.student_id });
      assertVersion(ap, env.expected_version);
      if (!['SCHEDULED', 'RESCHEDULED'].includes(ap.status)) throw new AppError('INVALID_STATE', 'final', { messageTh: 'นัดหมายนี้บันทึกผลแล้ว' });
      if (input.status === 'RESCHEDULED' && (!input.scheduled_at || input.scheduled_at < ctx.now)) throw new AppError('VALIDATION_ERROR', 'reschedule', { fieldErrors: [{ field: 'scheduled_at', code: 'REQUIRED', message_th: 'ระบุเวลานัดใหม่ (ไม่อยู่ในอดีต)' }] });
      if (['COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(input.status) && !input.outcome_note) throw new AppError('VALIDATION_ERROR', 'note', { fieldErrors: [{ field: 'outcome_note', code: 'REQUIRED', message_th: 'บันทึกผลหรือเหตุผล' }] });
      const cs = ctx.changeSet();
      const after = cs.update('Appointments', ap, { status: input.status, outcome_note: input.outcome_note || ap.outcome_note, scheduled_at: input.status === 'RESCHEDULED' ? input.scheduled_at : ap.scheduled_at });
      if (kase) {
        cs.update('Cases', kase, { next_appointment_at: input.status === 'RESCHEDULED' ? input.scheduled_at : null });
        caseEvent(cs, ctx, kase, 'NOTE', { data: { appointment_id: ap.id, status: input.status }, note: input.outcome_note || null });
      }
      cs.audit({ action: 'appointment.update', entityType: 'Appointments', entityId: ap.id, studentId: ap.student_id, after: { status: input.status } });
      return yield* commit(ctx, cs, { appointment_id: ap.id, version: after.version });
    },
  }),
];


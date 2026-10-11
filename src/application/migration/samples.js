// Business samples for reconciliation (MASTER_PROMPT §15.6): at export the source computes report
// totals R01–R07 on sample dates chosen from complex cases (corrections, partial-day leave, class moves)
// and a permission fingerprint for sample users of every role (guardians with several children first).
// Both are stored in metadata/ and recomputed on the target with the SAME dates, filters and clock, so a
// difference means the data or its relationships changed during migration.
import { createContext } from '../context.js';
import { emptyFacts, loadFacts } from '../principal.js';
import { buildDoc } from '../ops/reports.js';
import { canonicalStringify } from '../../shared/canonical-json.js';
import { addDays, diffDays, dateInRange } from '../../shared/time.js';
import { SYSTEM_USER_ID } from '../../shared/uuid.js';
import { scanAll } from './sinks.js';

/** Internal principal used only to compute reconciliation samples (school-wide report scope). */
export function reconcilePrincipal() {
  const roles = new Set(['STUDENT_AFFAIRS']);
  const facts = { ...emptyFacts(SYSTEM_USER_ID), roles };
  return { authenticated: true, linked: true, system: true, user_id: SYSTEM_USER_ID, user: { id: SYSTEM_USER_ID, display_name: 'การกระทบยอดการย้ายข้อมูล' }, roles, facts, claims: null };
}

/** Context with a fixed clock (snapshot time) and no cache, so source and target compute identically. */
export function* sampleContext(deps, nowIso) {
  const d = { ...deps, clock: { now: () => nowIso }, cache: null };
  const ctx = yield* createContext(d, { operation: 'migration.samples', channel: 'JOB' });
  ctx.principal = reconcilePrincipal();
  return ctx;
}

function clip(from, to, maxDays) {
  return diffDays(from, to) + 1 > maxDays ? addDays(to, -(maxDays - 1)) : from;
}

export function* chooseSamples(ctx) {
  const dates = new Set();
  const corrections = (yield ctx.store.list('AttendanceCorrections', { orderBy: [['school_date', 'desc']], limit: 3 })).items;
  for (const c of corrections) dates.add(c.school_date);
  const partial = (yield ctx.store.list('LeaveSegments', { where: { unit: { ne: 'FULL_DAY' } }, orderBy: [['school_date', 'desc']], limit: 2 })).items;
  for (const s of partial) dates.add(s.school_date);
  const enrollments = yield* scanAll(ctx.store, 'Enrollments');
  const byStudent = new Map();
  for (const e of enrollments) byStudent.set(e.student_id, (byStudent.get(e.student_id) || []).concat([e]));
  const moves = [];
  for (const list of byStudent.values()) if (list.length > 1) for (const e of list) moves.push(e.effective_from);
  for (const d of moves.sort().reverse().slice(0, 2)) dates.add(d);
  dates.add(ctx.today);
  const sorted = [...dates].sort().slice(-7);
  const to = sorted[sorted.length - 1];
  const from = sorted[0];
  const student = corrections[0] ? corrections[0].student_id : enrollments.length ? enrollments.map((e) => e.student_id).sort()[0] : null;
  return { dates: sorted, from, to, r04_student_id: student };
}

export function reportPlan(samples) {
  const { from, to } = samples;
  const plan = samples.dates.map((date) => ({ code: 'R01', filter: { date } }));
  plan.push({ code: 'R02', filter: { from: clip(from, to, 93), to } });
  plan.push({ code: 'R03', filter: { from: clip(from, to, 400), to } });
  if (samples.r04_student_id) plan.push({ code: 'R04', filter: { student_id: samples.r04_student_id, from: clip(from, to, 400), to } });
  plan.push({ code: 'R05', filter: {} });
  plan.push({ code: 'R06', filter: { from: clip(from, to, 400), to } });
  plan.push({ code: 'R07', filter: { from: clip(from, to, 200), to, period: 'MONTH', group_by: 'CLASS' } });
  return plan;
}

/** Compute report totals for a plan. Errors are recorded (code) so both sides can be compared. */
export function* computeReports(ctx, plan) {
  const out = [];
  for (const p of plan) {
    try {
      const doc = yield* buildDoc(ctx, p.code, p.filter);
      const rows = JSON.parse(JSON.stringify(doc.rows));
      out.push({ code: p.code, filter: p.filter, row_count: rows.length, totals: JSON.parse(JSON.stringify(doc.totals || null)), rows_sha256: ctx.crypto.sha256Hex(canonicalStringify(rows)) });
    } catch (e) {
      out.push({ code: p.code, filter: p.filter, error: e && e.code ? e.code : 'ERROR' });
    }
  }
  return out;
}

function fingerprintOf(user, facts) {
  return {
    status: user.status,
    user_type: user.user_type,
    roles: [...facts.roles].sort(),
    homeroom: [...facts.homeroomClassIds].sort(),
    teaching: [...facts.teachingClassIds].sort(),
    stations: [...facts.stationIds].sort(),
    guardian: [...facts.guardianLinks.entries()].map(([sid, perms]) => [sid, [...perms].sort()]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    self: facts.selfStudentId || null,
  };
}

/** Choose sample users: up to 3 per active role; guardians linked to several children and children with several guardians first. */
export function* choosePermissionUsers(ctx, date) {
  const roles = (yield* scanAll(ctx.store, 'UserRoles')).filter((r) => !r.revoked_at && dateInRange(date, r.effective_from, r.effective_to));
  const links = (yield* scanAll(ctx.store, 'StudentGuardians')).filter((l) => l.status === 'ACTIVE');
  const childrenOf = new Map();
  const guardiansOf = new Map();
  for (const l of links) {
    childrenOf.set(l.guardian_id, (childrenOf.get(l.guardian_id) || 0) + 1);
    guardiansOf.set(l.student_id, (guardiansOf.get(l.student_id) || 0) + 1);
  }
  const users = new Map((yield* scanAll(ctx.store, 'Users')).map((u) => [u.id, u]));
  const byRole = new Map();
  for (const r of roles) byRole.set(r.role, (byRole.get(r.role) || new Set()).add(r.user_id));
  const score = (u) => {
    if (!u) return 0;
    if (u.guardian_id) return childrenOf.get(u.guardian_id) || 0;
    if (u.student_id) return guardiansOf.get(u.student_id) || 0;
    return 0;
  };
  const chosen = new Set();
  for (const role of [...byRole.keys()].sort()) {
    const ids = [...byRole.get(role)].sort((a, b) => score(users.get(b)) - score(users.get(a)) || (a < b ? -1 : 1));
    for (const id of ids.slice(0, 3)) chosen.add(id);
  }
  return [...chosen].sort();
}

export function* computePermissionSamples(ctx, userIds, date) {
  const out = [];
  for (const id of userIds) {
    const user = yield ctx.store.get('Users', id);
    if (!user) { out.push({ user_id: id, missing: true }); continue; }
    const facts = yield* loadFacts(ctx, user, date);
    const fp = fingerprintOf(user, facts);
    out.push({ user_id: id, roles: fp.roles, linked_students: fp.guardian.length, classes: fp.homeroom.length + fp.teaching.length, fingerprint_sha256: ctx.crypto.sha256Hex(canonicalStringify(fp)) });
  }
  return out;
}

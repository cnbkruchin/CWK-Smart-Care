// Trusted principal resolution: verified identity claims → IdentityLinks → Users → effective
// roles and data-scope facts. Everything comes from the server's own data; nothing from the client.

import { AppError } from '../shared/errors.js';
import { dateInRange } from '../shared/time.js';

export function* resolvePrincipal(ctx, claims) {
  const links = yield ctx.store.findBy('IdentityLinks', 'subject', claims.subject);
  const link = links.find((l) => l.status === 'ACTIVE' && l.provider === claims.provider && l.issuer === claims.issuer);
  if (!link) {
    return { authenticated: true, linked: false, claims, user_id: null, user: null, roles: new Set(), facts: emptyFacts(null) };
  }
  const user = yield ctx.store.get('Users', link.user_id);
  if (!user) throw new AppError('ACCOUNT_NOT_LINKED', 'link points to missing user');
  if (user.status === 'DISABLED') throw new AppError('ACCOUNT_DISABLED', 'user disabled');
  const facts = yield* loadFacts(ctx, user, ctx.today);
  return { authenticated: true, linked: true, claims, user_id: user.id, user, roles: facts.roles, facts, identity_link_id: link.id };
}

export function emptyFacts(userId) {
  return { user_id: userId, roles: new Set(), homeroomClassIds: new Set(), teachingClassIds: new Set(), guardianLinks: new Map(), selfStudentId: null, stationIds: new Set() };
}

/** Effective roles/assignments/links on `date` (school date). */
export function* loadFacts(ctx, user, date) {
  const facts = emptyFacts(user.id);
  const roles = yield ctx.store.findBy('UserRoles', 'user_id', user.id);
  for (const r of roles) {
    if (r.revoked_at) continue;
    if (dateInRange(date, r.effective_from, r.effective_to)) facts.roles.add(r.role);
  }
  if (user.user_type === 'STAFF') {
    const assigns = yield ctx.store.findBy('StaffAssignments', 'user_id', user.id);
    const delegatedFor = [];
    for (const a of assigns) {
      if (!dateInRange(date, a.effective_from, a.effective_to)) continue;
      if (a.assignment_type === 'HOMEROOM' && a.class_id) facts.homeroomClassIds.add(a.class_id);
      if (a.assignment_type === 'TEACHING' && a.class_id) facts.teachingClassIds.add(a.class_id);
      if (a.assignment_type === 'DUTY' && a.station_id) facts.stationIds.add(a.station_id);
      if (a.assignment_type === 'DELEGATE' && a.delegate_for_user_id) delegatedFor.push(a.delegate_for_user_id);
    }
    for (const otherId of delegatedFor) {
      const theirs = yield ctx.store.findBy('StaffAssignments', 'user_id', otherId);
      for (const a of theirs) {
        if (a.assignment_type === 'HOMEROOM' && a.class_id && dateInRange(date, a.effective_from, a.effective_to)) facts.homeroomClassIds.add(a.class_id);
      }
    }
  }
  if (user.user_type === 'GUARDIAN' && user.guardian_id && facts.roles.has('GUARDIAN')) {
    const links = yield ctx.store.findBy('StudentGuardians', 'guardian_id', user.guardian_id);
    for (const l of links) {
      if (l.status !== 'ACTIVE' || !dateInRange(date, l.effective_from, l.effective_to)) continue;
      const perms = new Set(Array.isArray(l.permitted_actions) ? l.permitted_actions : []);
      const prev = facts.guardianLinks.get(l.student_id);
      if (prev) for (const p of perms) prev.add(p);
      else facts.guardianLinks.set(l.student_id, perms);
    }
  }
  if (user.user_type === 'STUDENT' && user.student_id && facts.roles.has('STUDENT')) {
    facts.selfStudentId = user.student_id;
  }
  return facts;
}

/** Principal for background jobs/triggers: no human roles; jobs authorize by job type, not RBAC. */
export function systemPrincipal(userId) {
  return { authenticated: true, linked: true, system: true, user_id: userId, user: null, roles: new Set(), facts: emptyFacts(userId), claims: null };
}

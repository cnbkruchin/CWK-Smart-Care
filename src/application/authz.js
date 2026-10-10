// AuthorizationService.require(principal, action, resourceScope) — server-side, every operation.
// Resolves the resource's class membership on the relevant date(s) from Enrollments so that
// homeroom scope follows enrollment history (old reports show old class).

import { decide, listScope } from '../domain/permissions.js';
import { AppError } from '../shared/errors.js';
import { dateInRange } from '../shared/time.js';

export function* studentClassIds(ctx, studentId, dates) {
  const enrollments = yield ctx.store.findBy('Enrollments', 'student_id', studentId);
  const set = new Set();
  const ds = [ctx.today, ...(dates || [])].filter(Boolean);
  for (const e of enrollments) {
    if (ds.some((d) => dateInRange(d, e.effective_from, e.effective_to))) set.add(e.class_id);
  }
  return set;
}

/**
 * @param {object} ctx
 * @param {string} action
 * @param {{student_id?:string, class_id?:string, owner_user_id?:string, dates?:string[]}} resource
 * @returns facts decision (grant) for audit
 */
export function* requirePermission(ctx, action, resource = {}) {
  const p = ctx.principal;
  if (!p || !p.linked) throw new AppError('ACCOUNT_NOT_LINKED', 'principal not linked');
  const r = { ...resource };
  if (r.student_id && !r.class_ids) r.class_ids = yield* studentClassIds(ctx, r.student_id, r.dates);
  if (r.class_id) r.class_ids = new Set([...(r.class_ids || []), r.class_id]);
  const d = decide(p.facts, action, r);
  if (!d.allowed) {
    // NOT_FOUND-style message for record-level denials avoids confirming existence of other students' data
    throw new AppError('FORBIDDEN', `denied ${action}`, { messageTh: r.student_id ? 'ไม่พบข้อมูลหรือคุณไม่มีสิทธิ์เข้าถึงนักเรียนคนนี้' : undefined });
  }
  return d.grant;
}

export function* allows(ctx, action, resource = {}) {
  try {
    yield* requirePermission(ctx, action, resource);
    return true;
  } catch (e) {
    if (e.code === 'FORBIDDEN') return false;
    throw e;
  }
}

/** Data filter for lists; throws FORBIDDEN when the principal has no grant for the action. */
export function scopeFor(ctx, action) {
  const p = ctx.principal;
  if (!p || !p.linked) throw new AppError('ACCOUNT_NOT_LINKED', 'principal not linked');
  const s = listScope(p.facts, action);
  if (!s) throw new AppError('FORBIDDEN', `no grant for ${action}`);
  return s;
}

export function hasRole(ctx, role) {
  return !!ctx.principal && ctx.principal.roles && ctx.principal.roles.has(role);
}

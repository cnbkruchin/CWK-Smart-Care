// Request context: fixed request time, school date, loaded terms, principal, change-set factory
// and the commit pipeline (idempotency → MutationStore.commit → replay handling).

import { ChangeSetBuilder } from './changeset.js';
import { schoolDateOf, addMinutesIso } from '../shared/time.js';
import { AppError } from '../shared/errors.js';
import { requireRule, selectRule } from '../domain/rules.js';
import { SYSTEM_USER_ID } from '../shared/uuid.js';

export const IDEMPOTENCY_TTL_MINUTES = 7 * 24 * 60;

/**
 * deps: { store, mutations, clock, ids, crypto, config, cache?, platform? }
 * request: { request_id, operation, idempotency, channel }
 */
export function* createContext(deps, request = {}) {
  const now = deps.clock.now();
  const tz = (deps.config && deps.config.timezone) || 'Asia/Bangkok';
  const ctx = {
    deps,
    store: deps.store,
    mutations: deps.mutations,
    ids: deps.ids,
    crypto: deps.crypto,
    config: deps.config || {},
    cache: deps.cache || null,
    platform: deps.platform || {},
    now,
    tz,
    today: schoolDateOf(now, tz),
    requestId: request.request_id || null,
    operation: request.operation || 'internal',
    channel: request.channel || 'APP',
    idempotency: request.idempotency || null,
    principal: null,
    terms: [],
    _rules: null,
    _school: null,
    _settings: null,
  };
  ctx.terms = yield* loadTerms(ctx);
  ctx.changeSet = (operation = ctx.operation) => new ChangeSetBuilder({
    operation,
    operationId: ctx.ids.uuid(),
    actorId: (ctx.principal && ctx.principal.user_id) || SYSTEM_USER_ID,
    actorRoles: ctx.principal && ctx.principal.roles ? [...ctx.principal.roles] : [],
    requestId: ctx.requestId,
    now: ctx.now,
    terms: ctx.terms,
    tz: ctx.tz,
    ids: ctx.ids,
    channel: ctx.channel,
  });
  return ctx;
}

function* loadTerms(ctx) {
  const cacheKey = 'cwk:terms';
  if (ctx.cache) {
    const hit = ctx.cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }
  const page = yield ctx.store.list('Terms', { limit: 500, orderBy: [['start_date', 'asc']] });
  if (ctx.cache) ctx.cache.put(cacheKey, JSON.stringify(page.items), 600);
  return page.items;
}

export function invalidateConfigCache(ctx) {
  if (ctx.cache) {
    ctx.cache.remove('cwk:terms');
    ctx.cache.remove('cwk:rules');
    ctx.cache.remove('cwk:school');
  }
  ctx._rules = null;
  ctx._settings = null;
  ctx._memo = null;
}

/** Commit a change set. Adds the idempotency record for mutation requests that carry a key. */
export function* commit(ctx, builder, result = {}) {
  if (builder.isEmpty && !ctx.idempotency) return result;
  const idem = ctx.idempotency && builder.operation === ctx.operation
    ? { ...ctx.idempotency, expires_at: addMinutesIso(ctx.now, IDEMPOTENCY_TTL_MINUTES) }
    : null;
  const cs = builder.build({ result, idempotency: idem });
  const out = yield ctx.mutations.commit(cs);
  if (out && out.replayed) ctx.replayed = true;
  if (cs.writes.some((w) => CONFIG_TABLES.has(w.table))) invalidateConfigCache(ctx);
  return out ? out.result : result;
}

/** Commit without idempotency (internal/job writes); still drops config caches when needed. */
export function* commitRaw(ctx, builder) {
  const cs = builder.build({ result: {} });
  const out = yield ctx.mutations.commit(cs);
  if (cs.writes.some((w) => CONFIG_TABLES.has(w.table))) invalidateConfigCache(ctx);
  return out;
}

/** Tables whose cached copies (terms, rules, school) must be dropped after a commit touches them. */
export const CONFIG_TABLES = new Set(['Terms', 'RuleVersions', 'Schools', 'Settings', 'SchoolCalendar', 'Periods', 'AcademicYears']);

export function* loadRules(ctx) {
  if (ctx._rules) return ctx._rules;
  if (ctx.cache) {
    const hit = ctx.cache.get('cwk:rules');
    if (hit) { ctx._rules = JSON.parse(hit); return ctx._rules; }
  }
  const page = yield ctx.store.list('RuleVersions', { limit: 500 });
  ctx._rules = page.items;
  if (ctx.cache) ctx.cache.put('cwk:rules', JSON.stringify(ctx._rules), 600);
  return ctx._rules;
}

export function* ruleFor(ctx, ruleType, date, { required = true } = {}) {
  const rules = yield* loadRules(ctx);
  return required ? requireRule(rules, ruleType, date) : selectRule(rules, ruleType, date);
}

export function* loadSchool(ctx) {
  if (ctx._school) return ctx._school;
  const page = yield ctx.store.list('Schools', { limit: 2 });
  if (!page.items.length) throw new AppError('CONFIGURATION_REQUIRED', 'school not configured', { messageTh: 'ยังไม่ได้ตั้งค่าข้อมูลโรงเรียน (รัน adminSetup)' });
  ctx._school = page.items[0];
  return ctx._school;
}

export function* loadSettings(ctx) {
  if (ctx._settings) return ctx._settings;
  const page = yield ctx.store.list('Settings', { limit: 500 });
  ctx._settings = Object.fromEntries(page.items.map((s) => [s.key, s.value_json]));
  return ctx._settings;
}

export function* setting(ctx, key, fallback) {
  const s = yield* loadSettings(ctx);
  const v = s[key];
  if (v === undefined || v === null) return fallback;
  return v && typeof v === 'object' && 'value' in v ? v.value : v;
}

/** Partitions to search for a TERM table covering a date range (inclusive dates). */
export function partitionsForDates(ctx, dates) {
  const set = new Set();
  for (const d of dates) {
    const t = ctx.terms.find((x) => d >= x.start_date && d < x.end_date);
    if (t) set.add(t.code);
    else {
      const earlier = ctx.terms.filter((x) => x.start_date <= d).sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
      set.add(earlier.length ? earlier[0].code : (ctx.terms[0] ? ctx.terms[0].code : 'UNPARTITIONED'));
    }
  }
  // rows written before any term existed live in UNPARTITIONED; stores ignore unknown partitions
  set.add('UNPARTITIONED');
  return [...set];
}

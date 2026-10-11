// Test harness: application layer + memory adapters + DEMO identity, synchronous runtime (like GAS).
import crypto from 'node:crypto';
import { MemoryStore } from '../../src/adapters/memory/memory-store.js';
import { MemoryAttachmentStorage } from '../../src/adapters/memory/memory-storage.js';
import { FixedClock, nodeIds, nodeCrypto, MemoryCache, MemoryRateLimiter, MetricsRecorder, silentLogger } from '../../src/adapters/node/ports.js';
import { DemoIdentityVerifier } from '../../src/application/identity/demo.js';
import { buildRegistry, JOB_HANDLERS } from '../../src/application/registry.js';
import { dispatch } from '../../src/application/dispatcher.js';
import { runSync } from '../../src/application/runtime.js';
import { bootstrapInstallation } from '../../src/application/bootstrap.js';
import { seedDemoData } from '../../src/application/demo-seed.js';
import { runDueJobs } from '../../src/application/jobs.js';
import { tasksForMode } from '../../src/application/scheduler.js';
import { AppError } from '../../src/shared/errors.js';

export const PASS = 'test-passphrase-123';

export function makeHarness({ now = '2026-06-15T01:00:00.000Z', env = 'DEV', identity = null, extraPlatform = {}, config: configOverrides = {}, secrets = {} } = {}) {
  const store = new MemoryStore();
  const clock = new FixedClock(now);
  const cache = new MemoryCache(clock);
  const config = {
    env, authMode: 'DEMO', systemMode: 'NORMAL', timezone: 'Asia/Bangkok', lineEnabled: false, emailEnabled: true, notifyAllowlist: [], lineRetryWindowHours: 12,
    ...configOverrides, secret: (k) => (Object.prototype.hasOwnProperty.call(secrets, k) ? secrets[k] : null),
  };
  const deps = {
    store, mutations: store, clock, ids: nodeIds, crypto: nodeCrypto, cache, config,
    identity: identity || new DemoIdentityVerifier({ env, passphrase: PASS }),
    registry: buildRegistry(), rateLimiter: new MemoryRateLimiter(clock), metrics: new MetricsRecorder(clock), logger: silentLogger,
    platform: { storage: new MemoryAttachmentStorage(), setSystemMode: (m) => { config.systemMode = m; store.mode = m; }, ...extraPlatform },
  };
  const h = {
    deps, store, clock, cache, config,
    cred: (userId) => `demo:${userId}:${PASS}`,
    call(userIdOrCred, operation, payload = {}, opts = {}) {
      const credential = userIdOrCred == null ? null : (String(userIdOrCred).startsWith('demo:') || opts.rawCredential ? userIdOrCred : h.cred(userIdOrCred));
      const env = {
        api_version: 'v1', request_id: crypto.randomUUID(), operation, payload, credential,
        idempotency_key: opts.idempotencyKey === undefined ? (deps.registry.get(operation) && deps.registry.get(operation).mutation ? crypto.randomUUID() : null) : opts.idempotencyKey,
        expected_version: opts.expectedVersion ?? null,
      };
      return runSync(dispatch, deps, JSON.stringify(env));
    },
    ok(userId, operation, payload, opts) {
      const r = h.call(userId, operation, payload, opts);
      if (!r.ok) throw new Error(`${operation} failed: ${JSON.stringify(r.error)}`);
      return r.data;
    },
    bootstrap(adminEmail = 'admin@example.com') {
      return runSync(bootstrapInstallation, deps, { school_code: 'CWK', school_name_th: 'โรงเรียนจุนวิทยาคม (ทดสอบ)', admin_display_name: 'ผู้ติดตั้ง', admin_email: adminEmail, rule_effective_from: '2026-01-01' });
    },
    seed(p = {}) {
      return runSync(seedDemoData, deps, { start_year_ce: 2026, grades: ['M1'], rooms_per_grade: 2, students_per_class: 5, guardian_accounts: 3, ...p });
    },
    runJobs() {
      return runSync(runDueJobs, deps, JOB_HANDLERS, { deadlineAt: Date.now() + 120000, owner: 'test' });
    },
    /** Run scheduled tick tasks (all, or those named) for the current system mode, like cronTick without the journal recovery. */
    tick(names = null) {
      const out = {};
      for (const t of tasksForMode(config.systemMode)) if (!names || names.includes(t.name)) out[t.name] = runSync(t.run, deps, { deadlineAt: Date.now() + 120000, now: clock.now() });
      return out;
    },
  };
  return h;
}

/** Test identity verifier that maps opaque tokens to claims (simulates a provider-verified identity). */
export class TokenMapVerifier {
  constructor() { this.tokens = new Map(); }
  add(token, claims) { this.tokens.set(token, { provider: 'firebase', issuer: 'https://securetoken.google.com/test-project', email_verified: true, ...claims }); }
  verifyCredential(token) {
    const c = this.tokens.get(token);
    if (!c) throw new AppError('UNAUTHENTICATED', 'unknown test token');
    return c;
  }
}

/** Email provider double: records messages; `failWith` makes the next sends return that result. */
export class FakeEmailProvider {
  constructor() { this.sent = []; this.queue = []; this.quota = 100; }
  remainingQuota() { return this.quota; }
  send(m) {
    const next = this.queue.shift();
    if (next === 'THROW') throw new Error('Service invoked too many times');
    if (next) return next;
    this.sent.push(m);
    this.quota--;
    return { result: 'ACCEPTED', provider_request_id: `mail-${this.sent.length}` };
  }
}

/**
 * LINE Messaging API double with retry-key semantics: a request with an X-Line-Retry-Key that was
 * already accepted answers 409 (x-line-accepted-request-id) and is NOT delivered twice.
 */
export class FakeLineProvider {
  constructor() { this.accepted = new Map(); this.delivered = []; this.replies = []; this.queue = []; this.linkTokens = []; this.onAccept = null; }
  push({ to, messages, retryKey }) {
    if (!retryKey) throw new Error('retry key required');
    const next = this.queue.shift();
    if (next) return next;
    if (this.accepted.has(retryKey)) return { result: 'DUPLICATE_ACCEPTED', http_status: 409, provider_request_id: this.accepted.get(retryKey) };
    const id = `line-req-${this.accepted.size + 1}`;
    this.accepted.set(retryKey, id);
    this.delivered.push({ to, messages, retryKey });
    if (this.onAccept) this.onAccept();
    return { result: 'ACCEPTED', http_status: 200, provider_request_id: id };
  }
  reply(replyToken, messages) { this.replies.push({ replyToken, messages }); }
  issueLinkToken(lineUserId) { const t = `LinkTok${this.linkTokens.length + 1}abcdef`; this.linkTokens.push({ lineUserId, token: t }); return t; }
}

/** Report renderer double for XLSX/PDF (the real ones need Apps Script); records the prepared document. */
export class FakeReportRenderer {
  constructor() { this.calls = []; }
  xlsx(doc) { this.calls.push(['XLSX', doc]); return new Uint8Array(Buffer.from(`PK-FAKE-XLSX rows=${doc.rows_data.length}`)); }
  pdf(doc) { this.calls.push(['PDF', doc]); return new Uint8Array(Buffer.from(`%PDF-FAKE ${doc.title} rows=${doc.rows_display.length}`)); }
}

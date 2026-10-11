// REST transport of the web starter: the same RPC envelope as Apps Script (openapi.yaml), sent to
// POST {base}/v1/rpc with the user's token in Authorization (never in storage, never in the URL).
// Mutations carry an idempotency key that stays the same for the retry of the same action, so a
// retried request never writes twice; responses older than the latest request on a channel are dropped.

export class ApiError extends Error {
  constructor(e, requestId) {
    super((e && e.message_th) || (e && e.code) || 'error');
    this.code = (e && e.code) || 'INTERNAL_ERROR';
    this.retryable = !!(e && e.retryable);
    this.fieldErrors = (e && e.field_errors) || [];
    this.details = (e && e.details) || null;
    this.requestId = requestId || null;
  }
}

export const uuid = () => crypto.randomUUID();
const TRANSIENT = new Set(['LOCK_TIMEOUT', 'STORAGE_UNAVAILABLE']);

export class Api {
  /** @param {{base?: string, getToken: () => Promise<string|null>, onUnauthenticated?: Function}} o */
  constructor({ base = '', getToken, onUnauthenticated = () => {} }) {
    this.base = base.replace(/\/$/, '');
    this.getToken = getToken;
    this.onUnauthenticated = onUnauthenticated;
    this.generations = new Map();
  }

  async _send(envelope, token) {
    try {
      const r = await fetch(`${this.base}/v1/rpc`, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(envelope),
      });
      return await r.json();
    } catch (_) {
      return { ok: false, error: { code: 'STORAGE_UNAVAILABLE', message_th: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ข้อมูลยังไม่ถูกบันทึก กรุณาลองใหม่', retryable: true } };
    }
  }

  /**
   * @param {string} operation
   * @param {object} payload
   * @param {{mutation?: boolean, idempotencyKey?: string, expectedVersion?: number|null, channel?: string}} [o]
   */
  async call(operation, payload = {}, o = {}) {
    const gen = o.channel ? (this.generations.get(o.channel) || 0) + 1 : 0;
    if (o.channel) this.generations.set(o.channel, gen);
    const envelope = {
      api_version: 'v1', request_id: uuid(), operation, payload, credential: null,
      idempotency_key: o.mutation ? (o.idempotencyKey || uuid()) : null, expected_version: o.expectedVersion ?? null,
    };
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await this._send(envelope, await this.getToken());
      if (!res.ok && res.error && TRANSIENT.has(res.error.code) && attempt < 1) {
        await new Promise((r) => setTimeout(r, 700 + Math.random() * 600));
        continue;
      }
      break;
    }
    if (o.channel && this.generations.get(o.channel) !== gen) {
      const stale = new Error('stale response discarded');
      stale.code = 'STALE_RESPONSE';
      throw stale;
    }
    if (!res.ok) {
      const err = new ApiError(res.error, res.meta && res.meta.request_id);
      if (err.code === 'UNAUTHENTICATED') this.onUnauthenticated(err);
      throw err;
    }
    return res.data;
  }

  get(operation, payload, o) { return this.call(operation, payload, o); }
  mutate(operation, payload, o = {}) { return this.call(operation, payload, { ...o, mutation: true }); }
}

// Transport-agnostic API client (MASTER_PROMPT §16). Builds the RPC envelope, attaches the runtime
// credential (never stored by the app), generates idempotency keys for mutations and guards against
// out-of-order responses (stale results never overwrite newer state).

export class ApiError extends Error {
  constructor(e, requestId) {
    super(e.message_th || e.code);
    this.code = e.code;
    this.message_th = e.message_th;
    this.retryable = !!e.retryable;
    this.field_errors = e.field_errors || [];
    this.details = e.details || null;
    this.request_id = requestId || null;
  }
}

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hx = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20)}`;
}

export class ApiClient {
  constructor({ transport, getCredential, onUnauthenticated, deviceId }) {
    this.transport = transport;
    this.getCredential = getCredential;
    this.onUnauthenticated = onUnauthenticated || (() => {});
    this.deviceId = deviceId || null;
    this.generations = new Map();
  }

  /**
   * @param {string} operation
   * @param {object} payload
   * @param {{mutation?:boolean, idempotencyKey?:string, expectedVersion?:number|null, channel?:string}} opts
   *   channel: responses for an older request on the same channel are discarded (StaleResponse)
   */
  async call(operation, payload = {}, opts = {}) {
    const gen = opts.channel ? (this.generations.get(opts.channel) || 0) + 1 : 0;
    if (opts.channel) this.generations.set(opts.channel, gen);
    const credential = await this.getCredential();
    const env = {
      api_version: 'v1', request_id: uuid(), operation, payload, credential: credential || null,
      idempotency_key: opts.mutation ? (opts.idempotencyKey || uuid()) : null,
      expected_version: opts.expectedVersion ?? null,
      client: this.deviceId ? { device_id: this.deviceId } : null,
    };
    let res;
    let attempt = 0;
    for (;;) {
      res = await this.transport.send(env);
      // retry once for transient storage/lock errors — same idempotency key, so never a duplicate write
      if (!res.ok && res.error && ['LOCK_TIMEOUT', 'STORAGE_UNAVAILABLE'].includes(res.error.code) && attempt < 1) {
        attempt++;
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 600));
        continue;
      }
      break;
    }
    if (opts.channel && this.generations.get(opts.channel) !== gen) {
      const stale = new Error('stale response discarded');
      stale.code = 'STALE_RESPONSE';
      throw stale;
    }
    if (!res.ok) {
      const err = new ApiError(res.error || { code: 'INTERNAL_ERROR' }, res.meta && res.meta.request_id);
      if (err.code === 'UNAUTHENTICATED') this.onUnauthenticated(err);
      throw err;
    }
    return { data: res.data, meta: res.meta };
  }

  async get(operation, payload, opts) {
    return (await this.call(operation, payload, opts)).data;
  }

  async mutate(operation, payload, opts = {}) {
    return (await this.call(operation, payload, { ...opts, mutation: true })).data;
  }
}

/** google.script.run transport (Apps Script HtmlService). Responses are JSON strings. */
export class GasRpcTransport {
  send(envelope) {
    return new Promise((resolve) => {
      // eslint-disable-next-line no-undef
      google.script.run
        .withSuccessHandler((s) => {
          try { resolve(JSON.parse(s)); } catch (_) { resolve({ ok: false, error: { code: 'INTERNAL_ERROR', message_th: 'คำตอบจากเซิร์ฟเวอร์ไม่ถูกต้อง', retryable: true } }); }
        })
        .withFailureHandler(() => resolve({ ok: false, error: { code: 'STORAGE_UNAVAILABLE', message_th: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ข้อมูลยังไม่ถูกบันทึก กรุณาลองใหม่', retryable: true } }))
        .rpc(JSON.stringify(envelope));
    });
  }
}

/** HTTPS transport for the REST backend (credential travels in the Authorization header). */
export class HttpTransport {
  constructor(baseUrl) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  async send(envelope) {
    const { credential, ...body } = envelope;
    try {
      const r = await fetch(`${this.baseUrl}/v1/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body), credentials: 'omit',
      });
      return await r.json();
    } catch (_) {
      return { ok: false, error: { code: 'STORAGE_UNAVAILABLE', message_th: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ข้อมูลยังไม่ถูกบันทึก', retryable: true } };
    }
  }
}

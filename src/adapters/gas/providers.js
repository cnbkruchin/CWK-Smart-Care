// Delivery providers on Apps Script (MASTER_PROMPT §11.2–11.5, DECISIONS D-011).
//   GasEmailProvider  — MailApp (quota-aware). MailApp has no idempotency key: an exception after the
//                       call may still have sent mail, so the worker never re-sends email on its own.
//   LineMessagingProvider — LINE Messaging API over UrlFetchApp with X-Line-Retry-Key; 409 means the
//                       same request was already accepted. Channel access token stays in Script Properties.
// SMS is intentionally not provided (no real provider configured — MASTER_PROMPT §11.5).

const G = () => globalThis;
const LINE_API = 'https://api.line.me';

function headerOf(headers, name) {
  if (!headers) return null;
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
  return k ? headers[k] : null;
}

export class GasEmailProvider {
  constructor({ senderName = 'CWK Smart Care' } = {}) { this.senderName = senderName; }
  remainingQuota() {
    try { return G().MailApp.getRemainingDailyQuota(); } catch (_) { return 0; }
  }
  send({ to, subject, body, senderName }) {
    try {
      G().MailApp.sendEmail({ to, subject, body, name: senderName || this.senderName, noReply: true });
      return { result: 'ACCEPTED' };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (/invalid email|Invalid argument: (to|recipient)/i.test(msg)) return { result: 'FINAL_ERROR', error_code: 'INVALID_ADDRESS', error_message: 'invalid recipient address' };
      if (/too many times|quota|limit exceeded/i.test(msg)) return { result: 'RETRYABLE_ERROR', error_code: 'QUOTA', error_message: 'MailApp quota or rate limit' };
      // unknown failure: MailApp may have sent — never retried automatically
      return { result: 'OUTCOME_UNKNOWN', error_code: 'MAILAPP_EXCEPTION', error_message: msg.slice(0, 200) };
    }
  }
}

export class LineMessagingProvider {
  constructor({ accessToken }) {
    if (!accessToken) throw new Error('LINE channel access token not configured');
    this.token = accessToken;
  }

  _fetch(path, payload, extraHeaders = {}) {
    return G().UrlFetchApp.fetch(LINE_API + path, {
      method: 'post', contentType: 'application/json', payload: payload === undefined ? undefined : JSON.stringify(payload), muteHttpExceptions: true, followRedirects: false,
      headers: { Authorization: `Bearer ${this.token}`, ...extraHeaders },
    });
  }

  /** Push with a retry key that stays the same for every retry of this outbox row. */
  push({ to, messages, retryKey }) {
    let res;
    try {
      res = this._fetch('/v2/bot/message/push', { to, messages }, { 'X-Line-Retry-Key': retryKey });
    } catch (e) {
      // network/timeout: the request may or may not have reached LINE → retry with the same key
      return { result: 'OUTCOME_UNKNOWN', error_code: 'NETWORK', error_message: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    const status = res.getResponseCode();
    const headers = res.getAllHeaders ? res.getAllHeaders() : res.getHeaders();
    const requestId = headerOf(headers, 'x-line-request-id');
    if (status >= 200 && status < 300) return { result: 'ACCEPTED', http_status: status, provider_request_id: requestId };
    if (status === 409) return { result: 'DUPLICATE_ACCEPTED', http_status: 409, provider_request_id: headerOf(headers, 'x-line-accepted-request-id') || requestId };
    let detail = '';
    try { detail = (JSON.parse(res.getContentText()) || {}).message || ''; } catch (_) { detail = ''; }
    if (status === 429 || status >= 500) {
      const ra = Number(headerOf(headers, 'retry-after'));
      return { result: 'RETRYABLE_ERROR', http_status: status, provider_request_id: requestId, error_code: `HTTP_${status}`, error_message: detail.slice(0, 200), retry_after_seconds: Number.isFinite(ra) && ra > 0 ? ra : undefined };
    }
    return { result: 'FINAL_ERROR', http_status: status, provider_request_id: requestId, error_code: `HTTP_${status}`, error_message: detail.slice(0, 200) };
  }

  /** Reply to a webhook event (reply tokens are single-use and short-lived). */
  reply(replyToken, messages) {
    const res = this._fetch('/v2/bot/message/reply', { replyToken, messages });
    const status = res.getResponseCode();
    if (status < 200 || status >= 300) throw new Error(`LINE reply failed HTTP ${status}`);
    return true;
  }

  /** Issue a link token for account linking (POST /v2/bot/user/{userId}/linkToken). */
  issueLinkToken(lineUserId) {
    if (!/^U[0-9a-f]{32}$/i.test(lineUserId)) throw new Error('invalid LINE user id');
    const res = this._fetch(`/v2/bot/user/${lineUserId}/linkToken`);
    if (res.getResponseCode() !== 200) throw new Error(`LINE linkToken failed HTTP ${res.getResponseCode()}`);
    const json = JSON.parse(res.getContentText());
    return json.linkToken || null;
  }
}

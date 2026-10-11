// Sign-in for the web starter. The backend verifies every token itself (Firebase Admin SDK with
// revocation check, or DEMO in DEV/STAGING) — nothing here is trusted as identity by the server.
//   FirebaseRestAuth — Firebase Authentication REST API (email + password) without the JS SDK. Tokens are
//                      kept in memory only: closing or reloading the tab signs the user out (no token in
//                      localStorage/sessionStorage/cookies). The ID token is refreshed before it expires.
//   DemoAuth         — "demo:<user_id>:<passphrase>" for DEV/STAGING; refused by the backend in PROD.
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const STS = 'https://securetoken.googleapis.com/v1/token';

const FIREBASE_TH = {
  EMAIL_NOT_FOUND: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', INVALID_PASSWORD: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', INVALID_LOGIN_CREDENTIALS: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  USER_DISABLED: 'บัญชีนี้ถูกระงับ กรุณาติดต่อโรงเรียน', TOO_MANY_ATTEMPTS_TRY_LATER: 'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
  EMAIL_EXISTS: 'อีเมลนี้มีบัญชีแล้ว ให้เข้าสู่ระบบหรือรีเซ็ตรหัสผ่าน', INVALID_EMAIL: 'รูปแบบอีเมลไม่ถูกต้อง', TOKEN_EXPIRED: 'กรุณาเข้าสู่ระบบใหม่',
  USER_NOT_FOUND: 'กรุณาเข้าสู่ระบบใหม่', INVALID_REFRESH_TOKEN: 'กรุณาเข้าสู่ระบบใหม่',
};

export class AuthError extends Error {
  constructor(code) { super(FIREBASE_TH[code] || (code && code.startsWith('WEAK_PASSWORD') ? 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร (แนะนำ 12 ตัวขึ้นไป)' : 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่')); this.code = code; }
}

export class FirebaseRestAuth {
  /** @param {{apiKey: string, tenantId?: string|null}} cfg */
  constructor(cfg) {
    if (!cfg || !cfg.apiKey) throw new Error('Firebase web API key is not configured on the server');
    this.cfg = cfg;
    this.s = null; // { idToken, refreshToken, expiresAt, email }
  }

  async _post(url, body, form = false) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new AuthError(String((j.error && j.error.message) || 'UNKNOWN').split(' ')[0]);
    return j;
  }

  _tenant(body) { return this.cfg.tenantId ? { ...body, tenantId: this.cfg.tenantId } : body; }
  _keep(j) { this.s = { idToken: j.idToken || j.id_token, refreshToken: j.refreshToken || j.refresh_token, expiresAt: Date.now() + Number(j.expiresIn || j.expires_in || 3600) * 1000, email: j.email || (this.s && this.s.email) || null }; }

  get signedIn() { return !!this.s; }
  get email() { return this.s ? this.s.email : null; }

  async signIn(email, password) {
    this._keep(await this._post(`${IDT}/accounts:signInWithPassword?key=${encodeURIComponent(this.cfg.apiKey)}`, this._tenant({ email, password, returnSecureToken: true })));
  }

  async signUp(email, password) {
    this._keep(await this._post(`${IDT}/accounts:signUp?key=${encodeURIComponent(this.cfg.apiKey)}`, this._tenant({ email, password, returnSecureToken: true })));
    await this.sendVerification();
  }

  async sendVerification() {
    await this._post(`${IDT}/accounts:sendOobCode?key=${encodeURIComponent(this.cfg.apiKey)}`, this._tenant({ requestType: 'VERIFY_EMAIL', idToken: await this.token() }));
  }

  async resetPassword(email) {
    await this._post(`${IDT}/accounts:sendOobCode?key=${encodeURIComponent(this.cfg.apiKey)}`, this._tenant({ requestType: 'PASSWORD_RESET', email }));
  }

  /** Current ID token; refreshed when it expires within 2 minutes (or when forced, e.g. after verifying e-mail). */
  async token(force = false) {
    if (!this.s) return null;
    if (force || this.s.expiresAt - Date.now() < 120000) {
      try {
        this._keep(await this._post(`${STS}?key=${encodeURIComponent(this.cfg.apiKey)}`, { grant_type: 'refresh_token', refresh_token: this.s.refreshToken }, true));
      } catch (e) { this.s = null; throw e; }
    }
    return this.s.idToken;
  }

  signOut() { this.s = null; }
}

export class DemoAuth {
  constructor() { this.cred = null; }
  get signedIn() { return !!this.cred; }
  get email() { return null; }
  signIn(userId, passphrase) { this.cred = `demo:${String(userId).trim()}:${passphrase}`; }
  async token() { return this.cred; }
  signOut() { this.cred = null; }
}

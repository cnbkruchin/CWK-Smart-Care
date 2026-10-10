// Browser authentication. GATEWAY mode uses the Firebase JS SDK (compat build, pinned 10.14.1,
// Apache-2.0) loaded from Google's CDN; the app never stores passwords or tokens itself — the SDK
// manages persistence (SESSION by default) and getIdToken() refreshes automatically.
// DEMO mode (DEV/STAGING only) keeps the demo passphrase in memory for the tab's lifetime.

const FIREBASE_VERSION = '10.14.1';
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`โหลด ${src} ไม่สำเร็จ`));
    document.head.appendChild(s);
  });
}

export class FirebaseAuth {
  constructor(cfg, persistence = 'SESSION') {
    this.cfg = cfg;
    this.persistence = persistence;
    this.user = null;
    this.listeners = [];
  }

  async init() {
    if (!globalThis.firebase) {
      await loadScript(`${FIREBASE_BASE}/firebase-app-compat.js`);
      await loadScript(`${FIREBASE_BASE}/firebase-auth-compat.js`);
    }
    const fb = globalThis.firebase;
    this.app = fb.apps.length ? fb.app() : fb.initializeApp({ apiKey: this.cfg.apiKey, authDomain: this.cfg.authDomain, projectId: this.cfg.projectId });
    this.auth = fb.auth();
    if (this.cfg.tenantId) this.auth.tenantId = this.cfg.tenantId;
    this.auth.languageCode = 'th';
    const P = fb.auth.Auth.Persistence;
    await this.auth.setPersistence({ LOCAL: P.LOCAL, NONE: P.NONE }[this.persistence] || P.SESSION);
    await new Promise((resolve) => {
      const off = this.auth.onAuthStateChanged((u) => { this.user = u; off(); resolve(); });
    });
    this.auth.onAuthStateChanged((u) => { this.user = u; this.listeners.forEach((f) => f(u)); });
  }

  onChange(f) { this.listeners.push(f); }
  get signedIn() { return !!this.user; }
  get email() { return this.user ? this.user.email : null; }
  get emailVerified() { return !!(this.user && this.user.emailVerified); }
  async credential() { return this.user ? this.user.getIdToken() : null; }
  async refresh() { if (this.user) { await this.user.reload(); await this.user.getIdToken(true); } }
  signIn(email, password) { return this.auth.signInWithEmailAndPassword(email, password); }
  async signUp(email, password) {
    const cred = await this.auth.createUserWithEmailAndPassword(email, password);
    await cred.user.sendEmailVerification();
    return cred;
  }
  sendVerification() { return this.user ? this.user.sendEmailVerification() : Promise.resolve(); }
  resetPassword(email) { return this.auth.sendPasswordResetEmail(email); }
  signOut() { return this.auth.signOut(); }
}

/** Map Firebase error codes to Thai messages without exposing whether an account exists. */
export function firebaseErrorTh(e) {
  const code = (e && e.code) || '';
  if (/wrong-password|user-not-found|invalid-credential|invalid-login/.test(code)) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
  if (/too-many-requests/.test(code)) return 'พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่';
  if (/email-already-in-use/.test(code)) return 'อีเมลนี้มีบัญชีอยู่แล้ว ให้เข้าสู่ระบบหรือรีเซ็ตรหัสผ่าน';
  if (/weak-password/.test(code)) return 'รหัสผ่านสั้นเกินไป (อย่างน้อย 8 ตัวอักษร แนะนำให้ผสมตัวเลข)';
  if (/invalid-email/.test(code)) return 'รูปแบบอีเมลไม่ถูกต้อง';
  if (/network-request-failed/.test(code)) return 'เชื่อมต่ออินเทอร์เน็ตไม่ได้';
  if (/popup|operation-not-allowed/.test(code)) return 'วิธีเข้าสู่ระบบนี้ยังไม่เปิดใช้งาน';
  return 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่';
}

export class DemoAuth {
  constructor() { this.userId = null; this.passphrase = null; this.listeners = []; }
  async init() {}
  onChange(f) { this.listeners.push(f); }
  get signedIn() { return !!this.userId; }
  get email() { return null; }
  get emailVerified() { return true; }
  async credential() { return this.userId ? `demo:${this.userId}:${this.passphrase}` : null; }
  async refresh() {}
  signInDemo(userId, passphrase) { this.userId = userId; this.passphrase = passphrase; this.listeners.forEach((f) => f(true)); }
  async signOut() { this.userId = null; this.passphrase = null; this.listeners.forEach((f) => f(null)); }
}

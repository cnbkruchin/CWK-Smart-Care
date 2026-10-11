// Identity for the REST backend: the backend verifies the user's credential itself (Firebase ID token with
// checkRevoked, or DEMO in DEV/STAGING). A forwarded call from the GAS UI carries the same user token —
// nothing in the payload is trusted as identity (MASTER_PROMPT §16).
import { AppError } from '../../../src/shared/errors.js';
import { DemoIdentityVerifier } from '../../../src/application/identity/demo.js';

export class FirebaseIdentityVerifier {
  constructor({ projectId, tenantId = null }) { Object.assign(this, { projectId, tenantId, auth: null }); }
  async _auth() {
    if (this.auth) return this.auth;
    let app;
    let authMod;
    try {
      app = await import('firebase-admin/app');
      authMod = await import('firebase-admin/auth');
    } catch (_) {
      throw new AppError('CONFIGURATION_REQUIRED', 'firebase-admin not installed (npm ci in future-platform/api)');
    }
    const a = app.getApps()[0] || app.initializeApp({ credential: app.applicationDefault(), projectId: this.projectId });
    this.auth = this.tenantId ? authMod.getAuth(a).tenantManager().authForTenant(this.tenantId) : authMod.getAuth(a);
    return this.auth;
  }
  async verifyCredential(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new AppError('UNAUTHENTICATED', 'malformed token');
    const auth = await this._auth();
    let d;
    try { d = await auth.verifyIdToken(token, true); } catch (e) {
      const code = String((e && e.code) || '');
      if (code.includes('user-disabled')) throw new AppError('ACCOUNT_DISABLED', 'user disabled');
      if (code.startsWith('auth/')) throw new AppError('UNAUTHENTICATED', code);
      throw new AppError('EXTERNAL_SERVICE_ERROR', 'token verification unavailable');
    }
    if (d.aud !== this.projectId || d.iss !== `https://securetoken.google.com/${this.projectId}`) throw new AppError('UNAUTHENTICATED', 'wrong project');
    const tenant = d.firebase ? d.firebase.tenant || null : null;
    if ((this.tenantId || null) !== tenant) throw new AppError('UNAUTHENTICATED', 'wrong tenant');
    return {
      provider: 'firebase', issuer: d.iss, subject: d.sub, email: d.email || null, email_verified: !!d.email_verified, exp: d.exp, auth_time: d.auth_time || null,
      sign_in_provider: d.firebase ? d.firebase.sign_in_provider : null, tenant, mfa: !!(d.firebase && d.firebase.sign_in_second_factor),
    };
  }
  async revokeSessions(link) {
    const auth = await this._auth();
    await auth.revokeRefreshTokens(link.subject);
    return true;
  }
}

export function createIdentity(config) {
  if (config.authMode === 'DEMO') return new DemoIdentityVerifier({ env: config.env, passphrase: config.demoPassphrase });
  return new FirebaseIdentityVerifier({ projectId: config.firebaseProjectId, tenantId: config.firebaseTenantId });
}

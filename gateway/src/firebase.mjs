// Firebase Admin SDK token verifier (loaded lazily so the LINE-only deployment needs no Firebase).
// verifyIdToken(token, checkRevoked=true) checks signature, iss, aud, exp, and that the user is
// neither disabled nor revoked (DECISIONS D-003).
export async function createFirebaseVerifier({ projectId, tenantId = null }) {
  const { initializeApp, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const app = getApps()[0] || initializeApp({ credential: applicationDefault(), projectId });
  const auth = tenantId ? getAuth(app).tenantManager().authForTenant(tenantId) : getAuth(app);
  return {
    async verify(idToken) {
      try {
        const d = await auth.verifyIdToken(idToken, true);
        return {
          ok: true,
          claims: {
            aud: d.aud, iss: d.iss, sub: d.sub, exp: d.exp, iat: d.iat, auth_time: d.auth_time, email: d.email || null, email_verified: !!d.email_verified,
            sign_in_provider: d.firebase ? d.firebase.sign_in_provider : null, tenant: d.firebase ? d.firebase.tenant || null : null,
            mfa: !!(d.firebase && d.firebase.sign_in_second_factor),
          },
        };
      } catch (e) {
        const code = String(e && e.code || '');
        if (code.includes('revoked')) return { ok: false, error: 'TOKEN_REVOKED' };
        if (code.includes('user-disabled')) return { ok: false, error: 'USER_DISABLED' };
        if (code.includes('expired')) return { ok: false, error: 'TOKEN_EXPIRED' };
        if (code.startsWith('auth/')) return { ok: false, error: 'TOKEN_INVALID' };
        throw e; // network/credential problems are not a verdict about the token
      }
    },
    async revoke(uid) {
      await auth.revokeRefreshTokens(uid);
      return true;
    },
  };
}

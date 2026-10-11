// DEMO identity verifier — DEV/STAGING only (MASTER_PROMPT §5.2 last paragraph, §14 DEMO_MODE).
// Credential format: "demo:<user_id>:<passphrase>". The passphrase is a per-environment secret
// (CWK_DEMO_PASSPHRASE on Apps Script / API_DEMO_PASSPHRASE on the REST backend). Refused outright when env = PROD.

import { AppError } from '../../shared/errors.js';
import { timingSafeEqualStr } from '../../shared/hash.js';
import { isUuid } from '../../shared/uuid.js';

export class DemoIdentityVerifier {
  constructor({ env, passphrase }) {
    if (env === 'PROD') throw new AppError('CONFIGURATION_REQUIRED', 'DEMO auth is not allowed in PROD');
    if (!passphrase || passphrase.length < 8) throw new AppError('CONFIGURATION_REQUIRED', 'demo passphrase missing (≥ 8 chars)');
    this.env = env;
    this.passphrase = passphrase;
  }

  verifyCredential(credential) {
    const m = /^demo:([0-9a-f-]{36}):(.+)$/.exec(String(credential || ''));
    if (!m || !isUuid(m[1])) throw new AppError('UNAUTHENTICATED', 'malformed demo credential');
    if (!timingSafeEqualStr(m[2], this.passphrase)) throw new AppError('UNAUTHENTICATED', 'bad demo passphrase');
    return { provider: 'demo', issuer: 'cwk-demo', subject: m[1], email: null, email_verified: true, exp: null, auth_time: null };
  }
}

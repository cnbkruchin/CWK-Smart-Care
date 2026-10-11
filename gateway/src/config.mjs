// Gateway configuration from environment variables (Cloud Run: map secrets from Secret Manager to
// env vars). Nothing here is logged. Each feature is enabled only when fully configured.
export function loadConfig(env = process.env) {
  const s = (k) => (env[k] && String(env[k]).trim()) || null;
  const cfg = {
    port: Number(s('PORT') || 8080),
    maxBodyBytes: 1024 * 1024,
    identity: null,
    line: null,
  };
  if (s('CWK_GATEWAY_KEY_ID') && s('CWK_GATEWAY_SECRET') && s('FIREBASE_PROJECT_ID')) {
    cfg.identity = { keyId: s('CWK_GATEWAY_KEY_ID'), secret: s('CWK_GATEWAY_SECRET'), projectId: s('FIREBASE_PROJECT_ID'), tenantId: s('FIREBASE_TENANT_ID') };
  }
  if (s('LINE_CHANNEL_SECRET') && s('CWK_LINE_WEBHOOK_KEY_ID') && s('CWK_LINE_WEBHOOK_SECRET') && s('GAS_WEBAPP_URL')) {
    const url = s('GAS_WEBAPP_URL');
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) && env.CWK_ALLOW_TEST_TARGET !== '1') {
      throw new Error('GAS_WEBAPP_URL must be an Apps Script /exec URL');
    }
    cfg.line = { channelSecret: s('LINE_CHANNEL_SECRET'), keyId: s('CWK_LINE_WEBHOOK_KEY_ID'), envelopeSecret: s('CWK_LINE_WEBHOOK_SECRET'), gasUrl: url, forwardTimeoutMs: Number(s('GAS_FORWARD_TIMEOUT_MS') || 25000) };
  }
  return cfg;
}

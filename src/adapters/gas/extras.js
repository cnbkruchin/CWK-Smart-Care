// Platform capabilities added by feature modules: delivery providers (email/LINE) and the webhook
// envelope intake used by doPost. Providers are built lazily so a missing LINE token never breaks
// the in-app/email path (MASTER_PROMPT §11.4: GAS core works before the LINE gateway is enabled).
import { GasEmailProvider, LineMessagingProvider } from './providers.js';
import { intakeLineWebhook, MAX_ENVELOPE_BYTES } from '../../application/webhook/line-webhook.js';
import { runSync } from '../../application/runtime.js';

export function gasPlatformExtras(getDeps) {
  let email = null;
  let line = null;
  const providers = {};
  Object.defineProperty(providers, 'EMAIL', {
    enumerable: true,
    get() {
      const d = getDeps();
      if (d.config.emailEnabled === false) return undefined;
      return (email = email || new GasEmailProvider({ senderName: d.config.emailSenderName }));
    },
  });
  Object.defineProperty(providers, 'LINE', {
    enumerable: true,
    get() {
      const d = getDeps();
      if (!d.config.lineEnabled || !d.config.hasSecret('CWK_LINE_CHANNEL_ACCESS_TOKEN')) return undefined;
      return (line = line || new LineMessagingProvider({ accessToken: d.config.secret('CWK_LINE_CHANNEL_ACCESS_TOKEN') }));
    },
  });
  return {
    providers,
    /** doPost(e): only signed gateway envelopes are accepted; anything else is refused without storing. */
    handleWebhookEnvelope(e) {
      const d = getDeps();
      if (!d.config.lineEnabled) return { ok: false, error: 'WEBHOOK_DISABLED', stored: false };
      const raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : null;
      if (!raw || raw.length > MAX_ENVELOPE_BYTES) return { ok: false, error: 'VALIDATION_ERROR', stored: false };
      try {
        return runSync(intakeLineWebhook, d, raw);
      } catch (err) {
        return { ok: false, error: err && err.code ? err.code : 'INTERNAL_ERROR', stored: false };
      }
    },
  };
}

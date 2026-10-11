// Message composition for external channels. Content is minimal (templates carry no medical or
// assistance details); links open the web app, which re-checks permissions. LINE buttons are
// postbacks bound to the sender's LINE identity — never a guessable approve/ack URL.
import { render } from '../services/templates.js';

const LINE_TEXT_MAX = 5000;

export function webLink(config, page, id) {
  if (!config.webappUrl || !/^https:\/\//.test(config.webappUrl)) return null;
  const base = config.webappUrl.replace(/[?#].*$/, '');
  return `${base}?page=${encodeURIComponent(page)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;
}

export function composeEmail({ notification, recipient, config, schoolName }) {
  const r = render(notification.notification_type, notification.params_json);
  const link = webLink(config, 'notifications', recipient.id);
  const lines = [r.body, ''];
  if (link) lines.push(`เปิดในระบบ (ต้องเข้าสู่ระบบ): ${link}`, '');
  lines.push(`ข้อความอัตโนมัติจาก CWK Smart Care${schoolName ? ` — ${schoolName}` : ''} กรุณาอย่าตอบกลับอีเมลนี้`);
  return { subject: `[${schoolName || 'CWK Smart Care'}] ${r.title}`, body: lines.join('\n'), template_key: r.template_key, template_version: r.template_version };
}

/** LINE push payload: the text, then a buttons template when the template offers ACK/CALLBACK/OPEN. */
export function composeLine({ notification, recipient, config }) {
  const r = render(notification.notification_type, notification.params_json);
  const messages = [{ type: 'text', text: `${r.title}\n${r.body}`.slice(0, LINE_TEXT_MAX) }];
  const actions = [];
  if (r.actions.includes('ACK')) actions.push({ type: 'postback', label: 'รับทราบ', data: `cwk=ack&r=${recipient.id}`, displayText: 'รับทราบ' });
  if (r.actions.includes('CALLBACK') && recipient.recipient_role_context === 'GUARDIAN') actions.push({ type: 'postback', label: 'ขอให้ครูติดต่อกลับ', data: `cwk=callback&r=${recipient.id}`, displayText: 'ขอให้ครูติดต่อกลับ' });
  const link = webLink(config, 'notifications', recipient.id);
  if (link) actions.push({ type: 'uri', label: 'เปิดในระบบ', uri: link });
  if (actions.length) {
    messages.push({ type: 'template', altText: r.title.slice(0, 400), template: { type: 'buttons', text: 'เลือกการตอบกลับ', actions: actions.slice(0, 4) } });
  }
  return { messages, template_key: r.template_key, template_version: r.template_version };
}

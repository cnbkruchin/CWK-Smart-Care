// My notifications (in-app) with acknowledge / callback, notification channels (email/LINE) and the
// LINE account-link landing page. Acknowledgement is a deliberate action; opening is only "read".
import { h, mount } from '../lib/dom.js';
import { table, loading, empty, errorState, section, alertBox, badge, actionButton, toast, enumLabel, askText } from '../ui.js';
import { formatThaiDateTime } from '../../../src/shared/thai-format.js';

const ACTION_LABEL = { ACKNOWLEDGED: 'รับทราบ', CALLBACK_REQUESTED: 'ขอให้ครูติดต่อกลับ' };

function sourceLink(n) {
  if (n.source_entity_type === 'LeaveRequests') return h('a', { href: `#/leave?id=${encodeURIComponent(n.source_entity_id)}` }, 'เปิดใบลา');
  if (n.source_entity_type === 'Cases') return h('a', { href: `#/cases?id=${encodeURIComponent(n.source_entity_id)}` }, 'เปิดเรื่องติดตาม');
  if (n.student_id) return h('a', { href: `#/profile?id=${encodeURIComponent(n.student_id)}` }, 'เปิดประวัตินักเรียน');
  return null;
}

async function channelsSection(app) {
  let s;
  try { s = await app.api.get('channel.status', {}, { channel: 'channel-status' }); } catch (e) { return section('ช่องทางรับแจ้งเตือน', errorState(e)); }
  const active = s.bindings.filter((b) => b.channel === 'LINE' && b.status === 'ACTIVE');
  const parts = [h('p', null, `อีเมล: ${s.email || 'ยังไม่มี (ติดต่อโรงเรียนเพื่อเพิ่ม)'}`)];
  if (!s.line_enabled) parts.push(alertBox('info', 'โรงเรียนยังไม่เปิดใช้การแจ้งเตือนทาง LINE — ใช้การแจ้งเตือนในแอปและอีเมล'));
  else if (active.length) {
    parts.push(h('p', null, badge('เชื่อม LINE แล้ว', 'ok', '✔'), ` ${active[0].address_masked} เมื่อ ${formatThaiDateTime(active[0].verified_at)}`));
    parts.push(actionButton('ยกเลิกการเชื่อม LINE', async () => {
      try { await app.api.mutate('channel.unbind', { binding_id: active[0].id }, { expectedVersion: active[0].version }); toast('ยกเลิกการเชื่อม LINE แล้ว'); app.render(); } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
    }, { variant: 'secondary', confirmText: 'ยกเลิกการเชื่อม LINE? จะไม่ได้รับแจ้งเตือนทาง LINE อีก' }));
  } else if (s.can_bind) {
    parts.push(h('ol', null,
      h('li', null, 'เพิ่มเพื่อน LINE Official Account ของโรงเรียน', s.line_add_friend_url ? [' — ', h('a', { href: s.line_add_friend_url, target: '_top', rel: 'noopener' }, 'เปิดหน้าเพิ่มเพื่อน')] : ' (ขอลิงก์จากโรงเรียน)'),
      h('li', null, 'ระบบจะส่งลิงก์เชื่อมบัญชีให้ทางแชต LINE — เปิดลิงก์นั้นแล้วเข้าสู่ระบบด้วยบัญชีนี้'),
      h('li', null, 'ยืนยันในหน้าของ LINE — เสร็จแล้วจะได้รับข้อความยืนยันทาง LINE')));
    parts.push(alertBox('info', 'การเชื่อม LINE เป็นคนละขั้นกับการยืนยันความสัมพันธ์ผู้ปกครอง-นักเรียน ซึ่งโรงเรียนเป็นผู้ยืนยัน'));
  }
  return section('ช่องทางรับแจ้งเตือน', parts);
}

export async function renderNotifications(app) {
  const root = h('div');
  const listBox = h('div', { 'aria-live': 'polite' });
  const onlyPending = h('input', { type: 'checkbox', checked: true });
  const load = async () => {
    mount(listBox, loading());
    try {
      const r = await app.api.get('notification.list', { unread_only: onlyPending.checked, limit: 50 }, { channel: 'notif-list' });
      const unreadIds = r.items.filter((x) => x.in_app_state === 'UNREAD').map((x) => x.recipient_id);
      mount(listBox,
        h('p', null, `ยังไม่อ่าน ${r.unread} · รอรับทราบ ${r.pending_ack}`),
        r.items.length ? h('ul', { class: 'timeline' }, r.items.map((n) => h('li', { class: n.ack_state === 'PENDING_ACK' ? 'kind-late' : null },
          h('div', null, h('strong', null, n.title), ' ', n.in_app_state === 'UNREAD' ? badge('ใหม่', 'info') : null, ' ',
            n.ack_required ? badge(enumLabel('AckState', n.ack_state), n.ack_state === 'PENDING_ACK' ? 'warn' : 'ok') : null),
          h('div', null, n.body),
          h('div', { class: 'muted small' }, formatThaiDateTime(n.created_at), n.ack_due_at && n.ack_state === 'PENDING_ACK' ? ` · กรุณารับทราบภายใน ${formatThaiDateTime(n.ack_due_at)}` : ''),
          n.acknowledgements.length ? h('div', { class: 'small' }, n.acknowledgements.map((a) => `${ACTION_LABEL[a.action]} (${enumLabel('AckChannel', a.channel)}) ${formatThaiDateTime(a.acted_at)}`).join(' · ')) : null,
          h('div', { class: 'row-actions' }, n.actions.map((a) => actionButton(ACTION_LABEL[a], async () => {
            try {
              await app.api.mutate('notification.acknowledge', { recipient_id: n.recipient_id, action: a, note: null });
              toast(a === 'ACKNOWLEDGED' ? 'บันทึกการรับทราบแล้ว' : 'ส่งคำขอให้ครูติดต่อกลับแล้ว');
              load();
            } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
          }, { variant: a === 'ACKNOWLEDGED' ? 'primary' : 'secondary' })), sourceLink(n))))) : empty('ไม่มีการแจ้งเตือน'));
      if (unreadIds.length) app.api.mutate('notification.markRead', { recipient_ids: unreadIds.slice(0, 100) }).catch(() => {});
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(listBox, errorState(e, load)); }
  };
  onlyPending.addEventListener('change', load);
  root.append(h('label', { class: 'check' }, onlyPending, ' แสดงเฉพาะที่ยังไม่อ่าน/รอรับทราบ'), listBox, await channelsSection(app));
  load();
  return root;
}

/** Landing page for the LINE account-link URL (?page=line-link&linkToken=…): user must be logged in. */
export async function renderLineLink(app) {
  const token = app.boot && app.boot.line_link_token;
  if (!token) return alertBox('warn', 'ไม่พบรหัสเชื่อมบัญชี กรุณาเปิดลิงก์จากแชต LINE ของโรงเรียนอีกครั้ง');
  const out = h('div', { 'aria-live': 'polite' }, loading('กำลังเตรียมการเชื่อม LINE…'));
  try {
    const r = await app.api.mutate('channel.startLineLink', { link_token: token });
    app.boot.line_link_token = null; // one use
    mount(out,
      alertBox('info', `กำลังเชื่อม LINE กับบัญชี ${app.session.user.display_name} — ยืนยันในหน้าของ LINE ภายใน 10 นาที`),
      h('a', { class: 'btn btn-primary btn-lg', href: r.redirect_url, target: '_top', rel: 'noopener' }, 'ไปยืนยันที่ LINE'));
  } catch (e) {
    mount(out, errorState(e));
  }
  return out;
}

export async function renderNotifyMonitor(app, params) {
  const root = h('div');
  const counts = h('div');
  const listBox = h('div', { 'aria-live': 'polite' });
  const detail = h('div');
  const state = h('select', { class: 'input', 'aria-label': 'สถานะ' }, ['FAILED_FINAL', 'RETRY_WAIT', 'QUEUED', 'PROCESSING', 'CANCELLED', 'PROVIDER_ACCEPTED'].map((s) => h('option', { value: s }, enumLabel('DeliveryState', s))));
  state.value = params.state || 'FAILED_FINAL';
  const load = async () => {
    mount(listBox, loading());
    try {
      const r = await app.api.get('notification.monitor', { state: state.value, days: 30 }, { channel: 'notif-monitor' });
      const channels = Object.keys(r.counts);
      mount(counts, channels.length ? table([
        { label: 'ช่องทาง', render: (c) => enumLabel('Channel', c) },
        ...['QUEUED', 'PROCESSING', 'RETRY_WAIT', 'PROVIDER_ACCEPTED', 'FAILED_FINAL', 'CANCELLED'].map((s) => ({ label: enumLabel('DeliveryState', s), render: (c) => r.counts[c][s] || 0 })),
      ], channels, { caption: 'สรุป 30 วัน (ผู้ให้บริการรับคำขอ ≠ ผู้รับอ่านแล้ว)' }) : empty('ยังไม่มีรายการส่งออกนอกระบบ'));
      mount(listBox, r.items.length ? table([
        { label: 'ประเภท', render: (x) => enumLabel('NotificationType', x.notification_type) }, { label: 'ผู้รับ', render: (x) => x.recipient_name || '—' },
        { label: 'ช่องทาง', render: (x) => enumLabel('Channel', x.channel) }, { label: 'ครั้ง', render: (x) => `${x.attempts}/${x.max_attempts}` },
        { label: 'สาเหตุ', render: (x) => x.last_error_code || x.held_reason || '—' }, { label: 'อัปเดต', render: (x) => formatThaiDateTime(x.updated_at) },
        { label: '', render: (x) => rowActions(app, x, load, detail) },
      ], r.items) : empty('ไม่มีรายการในสถานะนี้'));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(listBox, errorState(e, load)); }
  };
  state.addEventListener('change', load);
  root.append(counts, h('div', { class: 'grid3' }, h('div', { class: 'field' }, h('label', null, 'สถานะ'), state)), listBox, detail,
    alertBox('info', '"ส่งซ้ำแบบเดิม" ใช้ retry key เดิมของ LINE (LINE ไม่ส่งซ้ำถ้าเคยรับแล้ว) · "ส่งใหม่" สร้างข้อความใหม่ ผู้รับอาจได้รับซ้ำ — อีเมลใช้ได้เฉพาะ "ส่งใหม่"'));
  load();
  return root;
}

function rowActions(app, x, reload, detail) {
  const btns = [actionButton('ดูการพยายามส่ง', async () => {
    try {
      const d = await app.api.get('notification.monitor', { outbox_id: x.outbox_id });
      mount(detail, section('ประวัติการส่ง', table([
        { label: 'ครั้งที่', key: 'attempt_no' }, { label: 'เริ่ม', render: (a) => formatThaiDateTime(a.started_at) }, { label: 'ผล', render: (a) => enumLabel('AttemptResult', a.result) },
        { label: 'HTTP', render: (a) => a.http_status ?? '—' }, { label: 'รหัสคำขอผู้ให้บริการ', render: (a) => a.provider_request_id || '—' }, { label: 'ข้อผิดพลาด', render: (a) => a.error_code || '—' },
      ], d.attempts)));
    } catch (e) { toast(e.message_th || 'โหลดไม่สำเร็จ', 'danger'); }
  }, { variant: 'secondary' })];
  if (app.can('notification.resend') && x.delivery_state === 'FAILED_FINAL') {
    if (x.retry_same_allowed) btns.push(actionButton('ส่งซ้ำแบบเดิม', () => resend(app, x, 'RETRY_SAME', reload), { variant: 'secondary' }));
    btns.push(actionButton('ส่งใหม่', () => resend(app, x, 'RESEND_NEW', reload), { variant: 'secondary' }));
  }
  if (app.can('notification.resend') && ['QUEUED', 'RETRY_WAIT'].includes(x.delivery_state)) {
    btns.push(actionButton('ยกเลิกการส่ง', async () => {
      try { await app.api.mutate('notification.cancel', { outbox_id: x.outbox_id, reason: 'ยกเลิกโดยเจ้าหน้าที่' }, { expectedVersion: x.version }); toast('ยกเลิกแล้ว'); reload(); } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
    }, { variant: 'secondary', confirmText: 'ยกเลิกการส่งรายการนี้?' }));
  }
  return h('div', { class: 'row-actions' }, btns);
}

async function resend(app, x, mode, reload) {
  const reason = await askText(mode === 'RETRY_SAME' ? 'ส่งซ้ำด้วย retry key เดิม (LINE จะไม่ส่งซ้ำถ้าเคยรับแล้ว) — ระบุเหตุผล' : 'ส่งเป็นข้อความใหม่ ผู้รับอาจได้รับซ้ำ — ระบุเหตุผล', { multiline: true });
  if (!reason) return;
  try {
    await app.api.mutate('notification.resend', { outbox_id: x.outbox_id, mode, reason }, { expectedVersion: x.version });
    toast('เข้าคิวส่งแล้ว — ระบบจะส่งในรอบถัดไป');
    reload();
  } catch (e) { toast(e.message_th || 'ไม่สำเร็จ', 'danger'); }
}

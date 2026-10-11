// Gate Check-in: keyboard-wedge scanner / typed code / name search / camera (when supported) →
// identity card (photo, name, code, class) → confirm with one button (Enter) → server-time record.
// Offline: queue minimal records in IndexedDB and sync later (server re-checks everything).
import { h, mount } from '../lib/dom.js';
import { uuid } from '../api.js';
import { field, input, select, section, alertBox, loading, errorState, table, actionButton, empty, toast, badge } from '../ui.js';
import { formatThaiTime } from '../../../src/shared/thai-format.js';
import * as offline from '../offline.js';
import { todayLocal, localTimestamp } from '../lib/dates.js';

let audioCtx = null;
function beep(ok) {
  try {
    audioCtx = audioCtx || new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 880 : 300;
    g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.15);
  } catch (_) { /* sound is optional */ }
}

function store(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (_) { return null; } return null; }

export async function renderGate(app) {
  const stations = (await app.api.get('station.list', {})).items;
  if (!stations.length) return alertBox('warn', 'ยังไม่มีจุดลงเวลา ให้ผู้ดูแลเพิ่มในหน้า "ตั้งค่า"');
  const root = h('div', { class: 'gate' });
  const stationSel = select('station_id', stations.map((s) => h('option', { value: s.id, selected: store('cwk.station') === s.id }, s.name_th)));
  stationSel.addEventListener('change', () => store('cwk.station', stationSel.value));
  const sound = h('input', { type: 'checkbox', checked: store('cwk.sound') === '1' });
  sound.addEventListener('change', () => store('cwk.sound', sound.checked ? '1' : '0'));
  const queueTime = input('queue_time', { type: 'time' });
  const code = input('code', { class: 'input gate-input', autocomplete: 'off', inputmode: 'numeric', autofocus: true, 'aria-label': 'รหัสนักเรียนหรือสแกนบัตร', placeholder: 'สแกนบัตร / พิมพ์รหัส แล้วกด Enter' });
  const card = h('div', { 'aria-live': 'assertive' });
  const result = h('div', { 'aria-live': 'assertive' });
  const pendingBox = h('div');
  const logBox = h('div');
  let current = null;
  let busy = false;

  const refocus = () => setTimeout(() => code.focus(), 0);

  const refreshPending = async () => {
    try {
      const list = await offline.pending();
      mount(pendingBox, list.length ? alertBox('warn', `มี ${list.length} รายการบันทึกในเครื่อง (ยังไม่ส่งเข้าระบบ)`) : '', list.length ? actionButton('ส่งรายการออฟไลน์', syncOffline, { variant: 'secondary' }) : '');
    } catch (_) { mount(pendingBox, ''); }
  };

  const syncOffline = async () => {
    const list = await offline.pending();
    if (!list.length) return;
    try {
      const r = await app.api.mutate('attendance.syncOffline', { station_id: stationSel.value, records: list.slice(0, 50).map(({ local_id, idempotency_key, student_code, captured_at, claimed_user_id }) => ({ local_id, idempotency_key, student_code, captured_at, claimed_user_id })) });
      const done = r.results.filter((x) => ['RECORDED', 'DUPLICATE', 'REVIEW', 'REJECTED'].includes(x.status)).map((x) => x.local_id);
      await offline.remove(done);
      const review = r.results.filter((x) => x.status === 'REVIEW' || x.status === 'REJECTED');
      toast(`ส่งแล้ว ${done.length} รายการ${review.length ? ` (ต้องตรวจ ${review.length})` : ''}`, review.length ? 'warn' : 'ok');
    } catch (e) { toast(e.message_th || 'ส่งไม่สำเร็จ', 'danger'); }
    refreshPending();
    loadLog();
  };

  const loadLog = async () => {
    try {
      const log = await app.api.get('attendance.stationLog', { station_id: stationSel.value, limit: 15 }, { channel: 'gate-log' });
      mount(logBox, log.items.length ? table([{ label: 'เวลา', render: (r) => formatThaiTime(r.occurred_at) }, { label: 'รหัส', key: 'student_code' }, { label: 'ชื่อ', key: 'name' }, { label: '', render: (r) => (r.offline ? badge('ออฟไลน์', 'warn') : '') }], log.items) : empty('ยังไม่มีรายการวันนี้'));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(logBox, ''); }
  };

  const show = async (payload) => {
    mount(card, loading('กำลังค้นหา…'));
    mount(result, '');
    try {
      const r = await app.api.get('attendance.lookupForGate', payload, { channel: 'gate-lookup' });
      current = r;
      const s = r.student;
      const photo = h('div', { class: 'gate-photo', 'aria-label': 'รูปนักเรียน' }, 'ไม่มีรูป');
      const recordBtn = actionButton(r.status.arrived ? 'บันทึกไว้แล้ว' : 'บันทึกเวลามาถึง (Enter)', record, { large: true });
      if (r.status.arrived) recordBtn.disabled = true;
      mount(card, h('div', { class: 'card gate-card' }, photo,
        h('div', null, h('div', { class: 'gate-result' }, `${s.prefix_th || ''}${s.first_name_th} ${s.last_name_th}`), h('div', null, `รหัส ${s.student_code} · ห้อง ${s.class_name_th || '—'}`),
          !r.eligible ? alertBox('danger', 'ไม่อยู่ในทะเบียนวันนี้') : null,
          r.status.arrived ? alertBox('info', `บันทึกแล้วเวลา ${formatThaiTime(r.status.arrived_at)}`) : null,
          r.status.leave_units ? alertBox('info', `มีใบลาที่อนุมัติวันนี้: ${r.status.leave_units}`) : null,
          h('div', { class: 'form-actions' }, recordBtn))));
      if (!r.status.arrived) recordBtn.focus();
      if (s.photo_file_id) {
        app.api.get('student.photo', { student_id: s.id }, { channel: 'gate-photo' }).then((p) => {
          if (p.has_photo && current && current.student.id === s.id) { const img = document.createElement('img'); img.className = 'gate-photo'; img.alt = 'รูปนักเรียน'; img.src = `data:${p.mime_type};base64,${p.content_base64}`; mount(photo, img); }
        }).catch(() => {});
      }
    } catch (e) {
      current = null;
      if (e.code === 'STORAGE_UNAVAILABLE' && payload.code) return offerOffline(payload.code);
      if (e.code !== 'STALE_RESPONSE') { mount(card, errorState(e)); if (sound.checked) beep(false); refocus(); }
    }
  };

  const offerOffline = async (scanned) => {
    const can = await offline.available();
    mount(card, alertBox('warn', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'), can ? actionButton(`บันทึกรหัส ${scanned} ไว้ในเครื่อง (ยังไม่ตรวจตัวบุคคล)`, async () => {
      await offline.queueArrival({ local_id: uuid(), idempotency_key: uuid(), student_code: scanned, station_id: stationSel.value, captured_at: new Date().toISOString(), claimed_user_id: app.session.user.id });
      mount(card, alertBox('warn', `บันทึกในเครื่องแล้ว — ยังไม่ใช่รายการสำเร็จในระบบ จนกว่าจะส่ง`));
      refreshPending();
      code.value = '';
      refocus();
    }) : alertBox('danger', 'อุปกรณ์นี้บันทึกออฟไลน์ไม่ได้ ใช้แบบบันทึกฉุกเฉิน (กระดาษ) แล้วนำเข้าภายหลังโดยผู้ตรวจ'));
  };

  async function record() {
    if (!current || busy) return;
    busy = true;
    const payload = { student_id: current.student.id, station_id: stationSel.value, source: 'SCAN_KEYBOARD' };
    // queue time is school-local (Asia/Bangkok), not the device timezone
    if (queueTime.value) Object.assign(payload, { source: 'QUEUE_BATCH', arrived_at: localTimestamp(app, todayLocal(app), queueTime.value) });
    try {
      const r = await app.api.mutate('attendance.recordArrival', payload);
      mount(result, h('div', { class: `gate-result alert ${r.duplicate ? 'alert-info' : r.is_late && r.late_counted ? 'alert-warn' : 'alert-ok'}`, role: 'status' }, `${r.duplicate ? 'ℹ' : r.is_late ? '⏰' : '✔'} ${current.student.first_name_th}: ${r.message_th}`));
      if (sound.checked) beep(!r.is_late);
      mount(card, '');
      current = null;
      code.value = '';
      loadLog();
    } catch (e) {
      mount(result, errorState(e));
      if (sound.checked) beep(false);
    } finally { busy = false; refocus(); }
  }

  code.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = code.value.trim();
    if (!v) { if (current) record(); return; }
    code.value = '';
    show({ code: v });
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && current && document.activeElement !== code && e.target.tagName !== 'BUTTON') record(); });

  // name search (basic identification scope)
  const nameQ = input('name_q', { placeholder: 'ค้นหาชื่อ', autocomplete: 'off' });
  const nameResults = h('div');
  const searchByName = async () => {
    if (!nameQ.value.trim()) return;
    mount(nameResults, loading());
    try {
      const r = await app.api.get('student.search', { q: nameQ.value.trim(), limit: 10 }, { channel: 'gate-name' });
      mount(nameResults, r.items.length ? h('ul', { class: 'checklist' }, r.items.map((s) => h('li', null, h('button', { type: 'button', class: 'btn btn-link', onclick: () => show({ student_id: s.id }) }, `${s.student_code} ${s.first_name_th} ${s.last_name_th} (${s.class_name_th || '—'})`)))) : empty('ไม่พบ'));
    } catch (e) { if (e.code !== 'STALE_RESPONSE') mount(nameResults, errorState(e)); }
  };
  nameQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchByName(); } });

  // camera scan when the browser supports BarcodeDetector (must be verified on real devices/sandbox)
  const camBox = h('div');
  const camSupported = 'BarcodeDetector' in globalThis && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = h('video', { autoplay: true, playsinline: true, muted: true, style: { width: '100%', maxWidth: '360px' } });
      video.srcObject = stream;
      const stop = () => stream.getTracks().forEach((t) => t.stop());
      mount(camBox, video, actionButton('ปิดกล้อง', async () => { stop(); mount(camBox, ''); }, { variant: 'secondary' }));
      const detector = new globalThis.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13'] });
      const loop = async () => {
        if (!document.body.contains(video)) { stop(); return; }
        try {
          const codes = await detector.detect(video);
          if (codes.length) { stop(); mount(camBox, ''); show({ code: codes[0].rawValue }); return; }
        } catch (_) { /* keep scanning */ }
        setTimeout(loop, 300);
      };
      loop();
    } catch (e) { mount(camBox, alertBox('warn', 'เปิดกล้องไม่ได้ในอุปกรณ์/เบราว์เซอร์นี้ ใช้เครื่องสแกนหรือพิมพ์รหัสแทน')); }
  };

  root.append(
    h('div', { class: 'grid3' }, field('จุดลงเวลา', stationSel), field('เวลามาถึงของแถวรอ (ถ้ามี)', queueTime, { hint: 'ใช้เมื่อนักเรียนต่อแถวรอ ไม่เพิ่มโทษเพราะดำเนินการช้า' }), h('label', { class: 'check' }, sound, ' เสียงแจ้งผล')),
    field('สแกน/พิมพ์รหัส', code), card, result, pendingBox,
    section('ค้นหาด้วยชื่อ', field('ชื่อ', nameQ), nameResults),
    section('สแกนด้วยกล้อง', camSupported ? actionButton('เปิดกล้อง', startCamera, { variant: 'secondary' }) : alertBox('info', 'เบราว์เซอร์นี้ไม่รองรับการสแกนด้วยกล้อง ใช้เครื่องสแกนแบบคีย์บอร์ดหรือพิมพ์รหัส'), camBox),
    section('รายการล่าสุดของจุดนี้', logBox),
    alertBox('info', 'การลงเวลาที่ประตูไม่ใช่หลักฐานว่านักเรียนเข้าห้องเรียนแล้ว'));
  window.addEventListener('online', syncOffline);
  offline.purgeExpired().catch(() => {});
  refreshPending();
  loadLog();
  refocus();
  return root;
}

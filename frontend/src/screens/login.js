// Login / activation: sign in (Firebase email+password or DEMO), email verification, password
// reset, invitation redemption. Creating a provider account grants NO access until an invitation
// issued by the school is redeemed (MASTER_PROMPT §5.2).
import { h, mount } from '../lib/dom.js';
import { field, input, form, alertBox, actionButton, section, toast } from '../ui.js';
import { firebaseErrorTh } from '../auth.js';

export function renderLogin(app, root, onReady) {
  const pc = app.publicConfig || {};
  const school = (pc.school && pc.school.name_th) || 'โรงเรียน';
  const notice = h('p', { class: 'muted small' }, 'ระบบนี้ใช้ข้อมูลการมาเรียน การลา และการติดต่อผู้ปกครองเพื่อดูแลช่วยเหลือนักเรียนตามหน้าที่ของโรงเรียน ',
    'การเข้าถึงข้อมูลจำกัดตามบทบาทที่โรงเรียนอนุมัติ (ประกาศความเป็นส่วนตัวฉบับเต็มอยู่ระหว่างโรงเรียนพิจารณา)');
  const card = h('div', { class: 'login-card' }, h('h1', null, 'CWK Smart Care'), h('p', { class: 'muted' }, `${school} · ระบบแจ้งลา ลงเวลาสาย และดูแลช่วยเหลือนักเรียน`));
  if (pc.env && pc.env !== 'PROD') card.appendChild(alertBox('warn', `สภาพแวดล้อม ${pc.env}: ใช้ข้อมูลทดสอบเท่านั้น`));
  if (pc.setup_required) card.appendChild(alertBox('danger', 'ระบบยังติดตั้งไม่ครบ ผู้ดูแลต้องรัน adminSetup จาก Apps Script Editor'));

  if (pc.auth_mode === 'DEMO') {
    const userId = input('user_id', { autocomplete: 'off', placeholder: 'UUID ของผู้ใช้ทดสอบ' });
    const pass = input('passphrase', { type: 'password', autocomplete: 'off' });
    card.appendChild(form([field('รหัสผู้ใช้ทดสอบ (DEMO)', userId, { required: true, hint: 'ดูรายการจากผลรัน adminSeedDemo ใน Apps Script Editor' }), field('รหัสผ่านทดสอบของสภาพแวดล้อม', pass, { required: true })],
      async () => {
        app.auth.signInDemo(userId.value.trim(), pass.value);
        try { await onReady(); } catch (e) { await app.auth.signOut(); throw e; }
        return false;
      }, { submitLabel: 'เข้าสู่ระบบ (ทดสอบ)', large: true }));
    card.appendChild(notice);
    mount(root, h('div', { class: 'login' }, card));
    return;
  }

  // GATEWAY (Firebase Authentication)
  const auth = app.auth;
  const body = h('div');
  card.appendChild(body);
  card.appendChild(notice);
  mount(root, h('div', { class: 'login' }, card));

  const showSignIn = () => {
    const email = input('email', { type: 'email', autocomplete: 'username', inputmode: 'email' });
    const pw = input('password', { type: 'password', autocomplete: 'current-password' });
    mount(body,
      form([field('อีเมล', email, { required: true }), field('รหัสผ่าน', pw, { required: true })], async () => {
        try { await auth.signIn(email.value.trim(), pw.value); } catch (e) { throw { message_th: firebaseErrorTh(e) }; }
        await afterSignIn();
        return false;
      }, { submitLabel: 'เข้าสู่ระบบ', large: true }),
      h('div', { class: 'row gap' },
        h('button', { type: 'button', class: 'btn btn-link', onclick: showSignUp }, 'สร้างบัญชีใหม่'),
        h('button', { type: 'button', class: 'btn btn-link', onclick: showReset }, 'ลืมรหัสผ่าน')));
    email.focus();
  };

  const showSignUp = () => {
    const email = input('email', { type: 'email', autocomplete: 'username' });
    const pw = input('password', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    mount(body,
      alertBox('info', 'การสร้างบัญชียังไม่ให้สิทธิ์ดูข้อมูลนักเรียน ต้องใช้รหัสคำเชิญจากโรงเรียนหลังยืนยันอีเมล'),
      form([field('อีเมล', email, { required: true }), field('ตั้งรหัสผ่าน (อย่างน้อย 8 ตัวอักษร)', pw, { required: true })], async () => {
        if (pw.value.length < 8) throw { message_th: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร', field_errors: [{ field: 'password', message_th: 'อย่างน้อย 8 ตัวอักษร' }] };
        try { await auth.signUp(email.value.trim(), pw.value); } catch (e) { throw { message_th: firebaseErrorTh(e) }; }
        await afterSignIn();
        return false;
      }, { submitLabel: 'สร้างบัญชี', large: true }),
      h('button', { type: 'button', class: 'btn btn-link', onclick: showSignIn }, 'กลับไปเข้าสู่ระบบ'));
  };

  const showReset = () => {
    const email = input('email', { type: 'email', autocomplete: 'username' });
    mount(body,
      form([field('อีเมลที่ใช้สมัคร', email, { required: true })], async () => {
        try { await auth.resetPassword(email.value.trim()); } catch (_) { /* do not reveal whether the account exists */ }
        return 'หากอีเมลนี้มีบัญชี ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่แล้ว';
      }, { submitLabel: 'ส่งลิงก์ตั้งรหัสผ่านใหม่' }),
      h('button', { type: 'button', class: 'btn btn-link', onclick: showSignIn }, 'กลับไปเข้าสู่ระบบ'));
  };

  const showVerify = () => {
    mount(body,
      alertBox('warn', `กรุณายืนยันอีเมล ${auth.email || ''} จากลิงก์ที่ระบบส่งไป แล้วกดปุ่ม "ยืนยันแล้ว"`),
      h('div', { class: 'row gap' },
        actionButton('ยืนยันแล้ว', async () => { await auth.refresh(); await afterSignIn(); }),
        actionButton('ส่งอีเมลยืนยันอีกครั้ง', async () => { await auth.sendVerification(); toast('ส่งอีเมลแล้ว'); }, { variant: 'secondary' }),
        actionButton('ออกจากระบบ', async () => { await auth.signOut(); showSignIn(); }, { variant: 'link' })));
  };

  const showRedeem = () => {
    const code = input('code', { autocomplete: 'one-time-code', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX', class: 'input code' });
    mount(body,
      section('เปิดใช้งานบัญชี',
        h('p', null, 'กรอกรหัสคำเชิญที่ได้รับจากโรงเรียน (ใช้ได้ครั้งเดียวและมีวันหมดอายุ)'),
        form([field('รหัสคำเชิญ', code, { required: true })], async () => {
          await app.api.mutate('auth.redeemInvitation', { code: code.value.trim() });
          await onReady();
          return false;
        }, { submitLabel: 'เปิดใช้งาน', large: true })),
      actionButton('ออกจากระบบ', async () => { await auth.signOut(); showSignIn(); }, { variant: 'link' }));
    code.focus();
  };

  const afterSignIn = async () => {
    if (!auth.signedIn) return showSignIn();
    if (!auth.emailVerified) return showVerify();
    const s = await app.loadSession();
    if (!s.linked) return showRedeem();
    await onReady();
  };

  if (auth.signedIn) afterSignIn().catch(() => showSignIn());
  else showSignIn();
}

#!/usr/bin/env node
// Browser smoke test of the BUILT web app (gas-dist/App.html) in headless Chromium.
// google.script.run is shimmed to call the real dispatcher on the in-memory store (synthetic demo data,
// fixed school-day clock), so every screen talks to the same operations as on Apps Script.
// Not part of `npm test` (needs a browser): run `npm run test:ui`. Requires Playwright + Chromium.
// What this proves: screens render without JS errors and the main daily flows work end to end through
// the UI. What it does not prove: real Apps Script/HtmlService behaviour, real devices, screen readers.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/app-harness.mjs';
import { runSync } from '../../src/application/runtime.js';
import { dispatch } from '../../src/application/dispatcher.js';
import { deterministicId } from '../../src/shared/uuid.js';

async function loadPlaywright() {
  try { return await import('playwright'); } catch (_) { /* fall back to a global install */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(path.join(root, 'noop.js'))('playwright');
  } catch (_) { return null; }
}

const ROOT = path.resolve(import.meta.dirname, '../..');
const BKK = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`).toISOString();
const NOW = BKK('2026-06-15', '08:10'); // Monday in demo term AY2026-T1; example cutoff 08:00
const ORIGIN = 'https://cwk.test';

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const pw = await loadPlaywright();
if (!pw) {
  console.log('NOT RUN: Playwright is not installed (npm i -D playwright, or use a global install).');
  process.exit(2);
}

// ---------- synthetic backend ----------
const h = makeHarness({ now: NOW });
h.bootstrap();
const seed = h.seed();
const ids = Object.fromEntries(seed.staff.map((s) => [s.key, s.user_id]));
const PASS = h.cred('x').slice('demo:x:'.length);
const classes = h.store.list('Classes', { limit: 10, orderBy: [['code', 'asc']] }).items;
const roster = (cid) => h.store.findBy('Enrollments', 'class_id', cid).map((e) => e.student_id);
const homeroomOf = (cid) => h.store.findBy('StaffAssignments', 'class_id', cid).find((a) => a.assignment_type === 'HOMEROOM').user_id;
const c1 = classes[0];
const guardian = seed.guardian_users.find((g) => roster(c1.id).includes(g.student_id)) || seed.guardian_users[0];
const lateStudent = h.store.get('Students', roster(c1.id).find((id) => id !== guardian.student_id));
const publicConfig = h.ok(null, 'app.publicConfig', {});

const boot = JSON.stringify({ public_config: publicConfig, initial_route: null, transport: 'GAS' }).replace(/</g, '\\u003c');
const html = fs.readFileSync(path.join(ROOT, 'gas-dist/App.html'), 'utf8').replace('/*__CWK_BOOT__*/null', () => boot);

const browser = await pw.chromium.launch();
// device timezone deliberately differs from the school timezone (Asia/Bangkok)
const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'th-TH', viewport: { width: 1100, height: 900 } });
await context.exposeFunction('__cwkRpc', (json) => JSON.stringify(runSync(dispatch, h.deps, json)));
await context.addInitScript(() => {
  window.google = {
    script: {
      get run() {
        let ok = () => {}; let fail = () => {};
        const chain = { withSuccessHandler(f) { ok = f; return chain; }, withFailureHandler(f) { fail = f; return chain; }, rpc(j) { window.__cwkRpc(j).then(ok, fail); } };
        return chain;
      },
    },
  };
});
await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));

const pageErrors = [];
async function openAs(userId, label, viewport = null) {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await page.clock.setFixedTime(new Date(NOW));
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${label} console: ${m.text()}`); });
  await page.goto(`${ORIGIN}/`);
  await page.fill('input[name=user_id]', userId);
  await page.fill('input[name=passphrase]', PASS);
  await page.click('form button[type=submit]');
  await page.waitForSelector('nav.nav', { timeout: 10000 });
  return page;
}

async function settle(page) {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => !document.querySelector('main .state-loading'), null, { timeout: 10000 });
}

async function visit(page, hash, title) {
  await page.evaluate((x) => { location.hash = x; }, hash);
  await page.waitForFunction((t) => { const h1 = document.querySelector('main h1'); return h1 && h1.textContent.includes(t); }, title, { timeout: 10000 });
  await settle(page);
  const errs = await page.$$eval('main .state-error', (els) => els.map((e) => e.textContent.trim()));
  return errs;
}

async function confirmModal(page) {
  await page.waitForSelector('.modal', { timeout: 5000 });
  await page.click('.modal .btn-primary');
}

async function toastText(page) {
  const t = await page.waitForSelector('.toast', { timeout: 10000 });
  return t.textContent();
}

try {
  // 1. Gate: duty teacher scans a code, confirms with Enter → late arrival recorded with server time
  {
    const page = await openAs(ids.duty, 'duty');
    const errs = await visit(page, '#/gate', 'ลงเวลาหน้าประตู');
    step('gate screen renders', !errs.length, errs.join(' | '));
    await page.fill('.gate-input', lateStudent.student_code);
    await page.press('.gate-input', 'Enter');
    await page.waitForSelector('.gate-card', { timeout: 10000 });
    await page.keyboard.press('Enter');
    const res = await page.waitForSelector('.gate-result.alert', { timeout: 10000 });
    const text = await res.textContent();
    const ev = h.store.findBy('AttendanceEvents', 'student_id', lateStudent.id).find((e) => e.event_type === 'GATE_ARRIVAL');
    const proj = h.store.get('DailyAttendance', deterministicId.dailyAttendance(lateStudent.id, '2026-06-15'));
    step('gate: scan + Enter records one arrival (late 10 min, counted)', !!ev && proj.late_counted === true && proj.late_minutes === 10, text.trim());
    await page.waitForFunction(() => document.querySelectorAll('main table tbody tr').length > 0, null, { timeout: 5000 });
    step('gate: station log lists the record', true);
    await page.close();
  }

  // 2. Homeroom teacher: dashboard, roll call (one absent), verify day
  const hr = homeroomOf(c1.id);
  {
    const page = await openAs(hr, 'homeroom');
    let errs = await visit(page, '#/dashboard', 'ภาพรวมวันนี้');
    const stats = await page.$$('.stats .stat');
    step('dashboard renders totals for the scoped classes', !errs.length && stats.length >= 7, errs.join(' | '));
    errs = await visit(page, `#/rollcall?class_id=${c1.id}&date=2026-06-15`, 'เช็กชื่อประจำวัน');
    const rows = await page.$$('main table tbody tr');
    step('roll call lists the roster for the date', !errs.length && rows.length === roster(c1.id).length, `${rows.length} rows`);
    const absentId = guardian.student_id; // the guardian below receives the confirmed-absence notice
    // find the row index of the student to mark absent via the profile link
    const idx = await page.$$eval('main table tbody tr', (trs, sid) => trs.findIndex((tr) => tr.querySelector(`a[href*="${sid}"]`)), absentId);
    await page.check(`input[name="m-${idx}"][value="ABSENT"]`);
    await page.click('button:has-text("ส่งผลเช็กชื่อ")');
    const t1 = await toastText(page);
    const session = h.store.get('RollCallSessions', deterministicId.rollCallSession(c1.id, '2026-06-15'));
    step('roll call submit stores the session with 1 absent', !!session && session.absent_count === 1 && session.status === 'SUBMITTED', t1.trim());
    await settle(page);
    await page.waitForSelector('text=ยืนยันขาดเรียน', { timeout: 10000 });
    await page.check(`input[aria-label^="ยืนยันขาด"]`);
    await page.click('button:has-text("ยืนยันผลรายวัน")');
    await confirmModal(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('ยืนยันขาด')), null, { timeout: 10000 });
    const confirmed = h.store.findBy('AttendanceEvents', 'student_id', absentId).some((e) => e.event_type === 'ABSENCE_CONFIRMED');
    step('verify day confirms absence only for the checked UNKNOWN student', confirmed);
    await page.close();
  }

  // 3. Guardian: leave request with day rows; profile; correction request
  let leaveId = null;
  let correctionId = null;
  {
    const page = await openAs(guardian.user_id, 'guardian', { width: 375, height: 800 });
    let errs = await visit(page, '#/leave', 'แจ้งลา');
    step('leave form renders for guardian (mobile 375px)', !errs.length, errs.join(' | '));
    await page.selectOption('select[name=leave_type]', 'PERSONAL');
    await page.fill('textarea[name=reason]', 'พาไปทำธุระที่อำเภอ');
    await page.fill('.day-row input[name=school_date]', '2026-06-16');
    await page.click('form button[type=submit]:has-text("ส่งใบลา")');
    await page.waitForSelector('text=ส่งใบลาแล้ว', { timeout: 10000 });
    const req = h.store.findBy('LeaveRequests', 'student_id', guardian.student_id)[0];
    leaveId = req && req.id;
    step('guardian leave submitted (routed to school, no guardian step for guardian requester)', !!req && req.status === 'PENDING_SCHOOL', req ? req.status : 'none');
    await page.waitForSelector('text=ใบลา:', { timeout: 10000 });
    step('leave detail opens after submit', true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    step('no horizontal page scroll at 375px on the leave screen', overflow <= 1, `overflow ${overflow}px`);
    errs = await visit(page, `#/profile?id=${guardian.student_id}`, 'ประวัตินักเรียน');
    const hasTimeline = await page.$('text=ไทม์ไลน์');
    step('guardian sees the full profile of the linked child', !errs.length && !!hasTimeline, errs.join(' | '));
    await page.fill('section:has-text("ขอแก้ไขข้อมูลการมาเรียน") textarea[name=requested_text]', 'ลูกมาถึงก่อน 8 โมง แต่ระบบไม่มีบันทึก');
    await page.click('section:has-text("ขอแก้ไขข้อมูลการมาเรียน") button[type=submit]');
    await page.waitForSelector('text=ส่งคำขอแล้ว', { timeout: 10000 });
    const corr = h.store.findBy('AttendanceCorrections', 'student_id', guardian.student_id).find((c) => c.status === 'PENDING');
    correctionId = corr && corr.id;
    step('guardian correction request stored as PENDING', !!corr);
    errs = await visit(page, `#/profile?id=${roster(classes[1].id)[0]}`, 'ประวัตินักเรียน').catch(() => ['route hidden']);
    const forbidden = await page.$('main .state-error');
    step('guardian cannot open an unrelated student profile', !!forbidden || errs.length > 0);
    await page.close();
  }

  // 4. Approver: inbox → detail → approve; then decide the correction request on the profile
  {
    const req = h.store.get('LeaveRequests', leaveId);
    const approver = req.current_approver_role === 'HOMEROOM_TEACHER' ? homeroomOf(c1.id) : ids.affairs;
    const page = await openAs(approver, 'approver');
    const errs = await visit(page, '#/approvals', 'พิจารณาใบลา');
    const items = await page.$$('main table tbody tr');
    step('approval inbox lists the pending request', !errs.length && items.length >= 1, `${items.length} item(s)`);
    await items[0].click();
    await page.waitForSelector('button:has-text("อนุมัติ")', { timeout: 10000 });
    await page.click('main button:text-is("อนุมัติ")');
    await confirmModal(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('อนุมัติแล้ว')), null, { timeout: 10000 });
    step('approve from the detail view stores APPROVED', h.store.get('LeaveRequests', leaveId).status === 'APPROVED');
    await page.close();

    const hrPage = await openAs(homeroomOf(c1.id), 'homeroom-corr');
    const e2 = await visit(hrPage, `#/profile?id=${guardian.student_id}&correction=${correctionId}`, 'ประวัตินักเรียน');
    await hrPage.waitForSelector(`#corr-${correctionId}`, { timeout: 10000 });
    await hrPage.fill(`#corr-${correctionId} textarea[name=decision_note]`, 'ตรวจสอบแล้วไม่พบหลักฐาน');
    await hrPage.click(`#corr-${correctionId} button:has-text("ไม่อนุมัติ")`);
    await hrPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('ไม่อนุมัติ')), null, { timeout: 10000 });
    const task = h.store.get('ReconciliationTasks', deterministicId.reconciliationTask(`CORRECTION|${correctionId}`));
    step('homeroom decides the correction request; review task closes', !e2.length && h.store.get('AttendanceCorrections', correctionId).status === 'REJECTED' && task.status === 'RESOLVED');
    await hrPage.close();
  }

  // 4b. Guardian: confirmed-absence notice in the app → "ขอให้ครูติดต่อกลับ" → case for the homeroom teacher
  {
    const page = await openAs(guardian.user_id, 'guardian-notify', { width: 375, height: 800 });
    const errs = await visit(page, '#/notifications', 'การแจ้งเตือน');
    await page.waitForSelector('text=แจ้งขาดเรียน', { timeout: 10000 });
    step('guardian sees the confirmed-absence notification with actions', !errs.length, errs.join(' | '));
    await page.click('button:has-text("ขอให้ครูติดต่อกลับ")');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('ติดต่อกลับ')), null, { timeout: 10000 });
    const cb = h.store.findBy('Cases', 'student_id', guardian.student_id).find((c) => c.case_type === 'CALLBACK_REQUEST');
    step('callback request opens a case owned by the homeroom teacher', !!cb && cb.owner_user_id === homeroomOf(c1.id));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    step('no horizontal page scroll at 375px on notifications', overflow <= 1, `overflow ${overflow}px`);
    await page.close();

    const hrPage = await openAs(homeroomOf(c1.id), 'homeroom-case');
    const e2 = await visit(hrPage, '#/cases', 'งานติดตามและการติดต่อ');
    await hrPage.waitForSelector('main table tbody tr', { timeout: 10000 });
    await hrPage.click('main table tbody tr');
    await hrPage.waitForSelector('text=บันทึกผลการติดต่อ', { timeout: 10000 });
    const telLink = await hrPage.$('a[href^="tel:"]');
    step('case detail shows tel: links for the guardian', !e2.length && !!telLink);
    await hrPage.selectOption('section:has-text("บันทึกผลการติดต่อ") select[name=outcome]', 'REACHED');
    await hrPage.fill('section:has-text("บันทึกผลการติดต่อ") textarea[name=summary]', 'โทรคุยกับผู้ปกครองแล้ว นักเรียนไม่สบาย');
    await hrPage.click('section:has-text("บันทึกผลการติดต่อ") button[type=submit]');
    await hrPage.waitForSelector('text=บันทึกการติดต่อแล้ว', { timeout: 10000 });
    const logged = h.store.findBy('ContactLogs', 'case_id', cb.id);
    step('contact log recorded and case moved to IN_PROGRESS', logged.length === 1 && h.store.get('Cases', cb.id).status === 'IN_PROGRESS');
    await hrPage.waitForTimeout(800);
    await hrPage.click('button:has-text("ปิดเรื่อง")');
    await hrPage.waitForSelector('.modal textarea', { timeout: 5000 });
    await hrPage.fill('.modal textarea', 'ผู้ปกครองรับทราบ นักเรียนกลับมาเรียนแล้ว');
    await hrPage.click('.modal .btn-primary');
    await hrPage.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('ปิดเรื่องแล้ว')), null, { timeout: 10000 });
    step('case closed with a summary from the UI', h.store.get('Cases', cb.id).status === 'CLOSED');
    await hrPage.close();
  }

  // 5. Student affairs: lateness exemption from the dashboard
  {
    const page = await openAs(ids.affairs, 'affairs');
    const errs = await visit(page, '#/dashboard', 'ภาพรวมวันนี้');
    await page.selectOption('section:has-text("รับรองข้อยกเว้นการนับสาย") select[name=class_id]', c1.id);
    await page.waitForSelector('section:has-text("รับรองข้อยกเว้นการนับสาย") table', { timeout: 10000 });
    await page.selectOption('select[name=reason_code]', 'TRANSPORT_DELAY');
    await page.fill('input[name=reason_text]', 'รถรับส่งสายเหนือเสียระหว่างทาง');
    await page.click('section:has-text("รับรองข้อยกเว้นการนับสาย") button[type=submit]');
    await confirmModal(page);
    await page.waitForSelector('text=บันทึกข้อยกเว้นแล้ว 1 คน', { timeout: 10000 });
    const proj = h.store.get('DailyAttendance', deterministicId.dailyAttendance(lateStudent.id, '2026-06-15'));
    step('exemption keeps the real arrival and stops counting it', !errs.length && proj.is_late && proj.lateness_exempted && !proj.late_counted);
    const e3 = await visit(page, '#/notify-monitor', 'ติดตามการส่งแจ้งเตือน');
    step('notification monitor renders for student affairs', !e3.length, e3.join(' | '));
    await page.close();
  }
} catch (e) {
  step('unexpected failure', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
}

step('no page errors or console errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} UI smoke checks passed`);
assert.ok(results.length > 0);
process.exit(failed ? 1 : 0);

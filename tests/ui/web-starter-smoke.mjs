#!/usr/bin/env node
// Browser smoke test of the web starter (future-platform/web) against the reference REST backend on a REAL
// PostgreSQL (separate process, fixed school-day clock, synthetic data) in headless Chromium.
// Run: npm run test:web (starts a disposable local PostgreSQL). Requires Playwright + Chromium and DATABASE_URL.
// Proves: sign-in (DEMO), role-based menu, student search → profile, and one complete record-arrival flow
// (lookup → confirm → server-time result → duplicate scan answered from the server) with the strict CSP and no
// JavaScript errors. Does not prove: Firebase sign-in against a real project, real devices, screen readers.
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { seededDatabase, startApiProcess } from '../helpers/pg-api-fixture.mjs';

async function loadPlaywright() {
  try { return await import('playwright'); } catch (_) { /* fall back to a global install */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(path.join(root, 'noop.js'))('playwright');
  } catch (_) { return null; }
}

const PASS = 'web-starter-passphrase';
const NOW = '2026-10-12T01:05:00.000Z'; // Monday 08:05 Asia/Bangkok — after the example 08:00 cutoff
const results = [];
const step = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

if (!process.env.DATABASE_URL) { console.log('NOT RUN: DATABASE_URL not set (npm run test:web starts a local PostgreSQL)'); process.exit(0); }
const pw = await loadPlaywright();
if (!pw) { console.log('NOT RUN: Playwright is not installed'); process.exit(0); }

const fx = await seededDatabase(process.env.DATABASE_URL, { now: NOW, passphrase: PASS });
const api = await startApiProcess({ appUrl: fx.app, now: NOW, dir: fx.dir, passphrase: PASS });
const browser = await pw.chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? {} : { executablePath: '/opt/pw-browsers/chromium' });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // the browser logs every non-2xx fetch; the 401 (wrong passphrase) and 403 (guardian) below are intended
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403) /.test(m.text())) errors.push(`console: ${m.text()}`); });

  const signIn = async (userId) => {
    await page.goto(`${api.base}/#/login`);
    await page.waitForSelector('#uid');
    await page.fill('#uid', userId);
    await page.fill('#pass', PASS);
    await page.click('button.primary');
  };

  // 1) wrong passphrase → refused by the backend, message shown
  await page.goto(api.base);
  await page.waitForSelector('#uid');
  step('login screen shows DEMO environment warning', (await page.textContent('main')).includes('DEV'));
  await page.fill('#uid', fx.ids.gate);
  await page.fill('#pass', 'wrong-passphrase');
  await page.click('button.primary');
  await page.waitForSelector('.alert.err');
  step('wrong passphrase is refused by the backend', (await page.textContent('.alert.err')).includes('เข้าสู่ระบบ'));

  // 2) gate staff: menu has only the gate; record one arrival (late after cutoff), then a duplicate scan
  await signIn(fx.ids.gate);
  await page.waitForSelector('#code');
  const navText = await page.textContent('#nav');
  step('gate staff lands on the record-arrival screen (menu from the backend\'s allowed actions)', navText.includes('ลงเวลามาเรียน'));
  const sid = (await fx.query('SELECT s.id, s.student_code FROM students s JOIN enrollments e ON e.student_id = s.id ORDER BY s.student_code LIMIT 1'))[0];
  await page.fill('#code', sid.student_code);
  await page.press('#code', 'Enter');
  await page.waitForSelector('.student-card .big');
  step('lookup shows the identity card with the student code', (await page.textContent('.student-card')).includes(sid.student_code));
  await page.click('.student-card button.primary');
  await page.waitForSelector('.student-card .alert');
  const res = await page.textContent('.student-card .alert');
  step('arrival recorded with server time; late after the cutoff', res.includes('มาสาย') && res.includes('08:05'), res);
  const rows = (await fx.query('SELECT count(*)::int AS n FROM attendance_events WHERE student_id = $1', [sid.id]))[0].n;
  step('exactly one attendance event in PostgreSQL', rows === 1, `rows=${rows}`);
  await page.fill('#code', sid.student_code);
  await page.press('#code', 'Enter');
  await page.waitForSelector('.student-card .alert.warn');
  step('second scan shows "already recorded" from the server', (await page.textContent('.student-card')).includes('บันทึกแล้ววันนี้'));
  // gate staff may identify students but only sees the basic profile
  await page.goto(`${api.base}/#/student?id=${sid.id}`);
  await page.waitForSelector('dl');
  step('gate staff sees identification only on the profile', (await page.textContent('main')).includes('เฉพาะข้อมูลระบุตัว') && !(await page.textContent('main')).includes('สถิติ'));
  await page.click('#nav button');

  // 3) student affairs: search → profile (full access by role)
  await signIn(fx.ids.affairs);
  await page.waitForFunction(() => document.querySelector('#nav').textContent.includes('นักเรียน'));
  await page.goto(`${api.base}/#/students`);
  await page.waitForSelector('#q');
  await page.waitForSelector('tbody tr');
  const listed = await page.$$eval('tbody tr', (trs) => trs.length);
  step('student search lists students in scope', listed > 0, `rows=${listed}`);
  await page.fill('#q', sid.student_code);
  await page.click('button.primary');
  await page.waitForFunction((code) => [...document.querySelectorAll('tbody tr')].length === 1 && document.querySelector('tbody').textContent.includes(code), sid.student_code);
  await page.click('tbody tr a');
  await page.waitForSelector('dl');
  const prof = await page.textContent('main');
  step('profile shows full access, statistics and the arrival just recorded', prof.includes('เต็ม') && prof.includes('สถิติ') && prof.includes('08:05'));

  // 4) guardian: no search menu; a direct link to another student's profile is refused by the backend
  await page.click('#nav button');
  const g = fx.seed.guardian_users[0];
  const other = (await fx.query('SELECT id FROM students WHERE id <> $1 ORDER BY student_code LIMIT 1', [g.student_id]))[0].id;
  await signIn(g.user_id);
  await page.waitForSelector('main section');
  await page.goto(`${api.base}/#/student?id=${other}`);
  await page.waitForSelector('.alert.err');
  step('guardian cannot open another student\'s profile', true);
  step('no JavaScript errors or CSP violations', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  step('unexpected failure', false, String(e && e.stack ? e.stack : e).slice(0, 500));
} finally {
  await browser.close();
  await api.stop();
  await fx.drop();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

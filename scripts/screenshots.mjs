#!/usr/bin/env node
// Regenerates the README screenshots from demo mode (made-up data).
// Run:  npm run screenshots          (light + dark)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from '../lib/engine.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(HERE, 'docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const csvPath = path.join(os.tmpdir(), 'demo_students.csv');
fs.writeFileSync(csvPath, [
  'Student ID,Student Name,Parent Phone,Fee Due',
  '27CS001,Aarav Sharma,+12015550101,₹4500',
  '27CS002,Diya Reddy,+12015550102,₹0',
  '27CS003,Kabir Iyer,+12015550103,₹1200',
  '27CS004,Ananya Nair,+12015550104,₹4500',
  '27CS005,Vihaan Patel,+12015550105,₹800',
].join('\n'));

async function run(theme, port) {
  const suffix = theme === 'dark' ? '-dark' : '';
  const demo = spawn(process.execPath, [path.join(HERE, 'scripts', 'demo-server.mjs')], { env: { ...process.env, PORT: String(port), DEMO_STEP_MS: '350' }, stdio: 'ignore' });
  await sleep(1200);
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--hide-scrollbars'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1.5 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat');
    const shot = async (name) => { await sleep(500); const f = name.replace('.png', suffix + '.png'); await page.screenshot({ path: path.join(OUT, f) }); console.log('saved docs/' + f); };
    const clickText = async (sel, text) => {
      for (const e of await page.$$(sel)) if ((await e.evaluate((n) => n.innerText)).includes(text)) { await e.click(); return; }
      throw new Error(`No ${sel} with "${text}"`);
    };

    // 1. Manage: keep-list preview
    await clickText('.chat', 'Class of 2027 · Students');
    await page.waitForFunction(() => document.querySelectorAll('#mRows tr').length > 10);
    await clickText('#subnav button', 'Clean up');
    const keepList = await page.evaluate(async () => {
      const r = await fetch('/api/members?id=c1', { headers: { 'X-Token': 'demo' } }).then((x) => x.json());
      const nums = r.members.filter((m) => !m.role).slice(0, 1687).map((m) => m.phone);
      for (let i = 0; i < 41; i++) nums.push('+1' + (900 + Math.floor(i / 10)) + '55501' + String(50 + i).padStart(2, '0'));
      return 'Student ID,Name,Mobile\n' + nums.map((n, i) => `27XX${String(i + 1).padStart(4, '0')},Student ${i + 1},${n}`).join('\n');
    });
    await page.$eval('#bText', (t, v) => { t.value = v; }, keepList);
    await page.$eval('#bFileInfo', (s) => { s.textContent = 'students_2027.csv'; });
    await page.click('#bPreview');
    await page.waitForSelector('#bResult .stats');
    const scrollTo = (sel) => page.evaluate((s) => {
      const m = document.querySelector('main');
      const card = document.querySelector(s).closest('.card');
      m.scrollTop += card.getBoundingClientRect().top - m.getBoundingClientRect().top - 12;
    }, sel);
    await page.evaluate(() => { // show the list drop zone, the review step and the highlighted counts
      const m = document.querySelector('main');
      m.scrollTop += document.getElementById('bText').getBoundingClientRect().top - m.getBoundingClientRect().top - 60;
    });
    await shot('manage.png');

    // 2. Message many groups
    await clickText('#tabs button', 'Message many groups');
    await page.waitForFunction(() => document.querySelectorAll('#lsSel option').length > 1);
    await page.select('#lsSel', 'All section groups');
    await page.click('#lsLoad');
    await page.type('#bcq', 'Section');
    await page.$eval('.composer[data-id="bc"] .ctext', (t) => { t.value = '📢 Mid-term exams start Monday 9:00 AM.\nCarry your ID card — no entry without it.\nTimetable attached.'; });
    await page.$eval('.composer[data-id="bc"] .cinfo', (s) => { s.textContent = 'midterm_timetable.pdf · 0.21 MB'; });
    await shot('broadcast.png');

    // 3. Personal messages from a CSV
    await clickText('#tabs button', 'Personal messages');
    await (await page.$('#dFile')).uploadFile(csvPath);
    await page.waitForFunction(() => document.querySelectorAll('#dChips button').length > 0);
    await page.select('#dGate', 'c2');
    await page.$eval('.composer[data-id="dm"] .ctext', (t) => { t.value = 'Dear parent of {Student Name} ({Student ID}),\nthe pending fee is {Fee Due}. Please pay before 30 Nov.\n— College Office'; });
    await page.click('#dPreview');
    await page.waitForSelector('#dResult .preview');
    await scrollTo('#dChips');
    await shot('personal.png');

    // 4. Confirm, then live progress
    await clickText('#tabs button', 'Groups');
    await clickText('#subnav button', 'Clean up');
    await clickText('#bResult button', 'Remove');
    await page.waitForSelector('#confirmOverlay.show');
    const n = await page.$eval('#cfNum', (e) => e.textContent);
    await page.type('#cfInput', n);
    await shot('confirm.png');
    await page.click('#cfOk');
    await sleep(5200);
    await page.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; });
    await shot('progress.png');
  } finally {
    await browser.close();
    demo.kill();
  }
}

await run('light', 3032);
await run('dark', 3033);

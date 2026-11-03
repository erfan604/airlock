// Pre-lock capture of browser shots with Playwright recordVideo at 1920x1080. Usage: node scripts/video-capture-browser.mjs S02|S06|S01
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? 'playwright-core');
const shot = process.argv[2];
const BASE = process.env.BASE ?? 'http://127.0.0.1:4180';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: 'video/raw/pw', size: { width: 1920, height: 1080 } } });
const page = await ctx.newPage();
const t0 = Date.now();
const at = async (s) => { const w = s * 1000 - (Date.now() - t0); if (w > 0) await sleep(w); };
const scrollTo = (y) => page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), y);
const scrollToText = (t) => page.evaluate((t) => { const el = [...document.querySelectorAll('h1,h2,h3,h4')].find((e) => e.textContent && e.textContent.includes(t)); if (el) { window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 90, behavior: 'smooth' }); return true; } return false; }, t);
if (shot === 'S02') {
  await page.goto(BASE + '/bench', { waitUntil: 'networkidle' });
  const t = Date.now();
  const mark = () => (Date.now() - t) / 1000;
  await at(Date.now() - t0 > 0 ? (Date.now() - t0) / 1000 : 0);
  console.log('loaded', mark());
  await sleep(1500);
  console.log('seven', await scrollToText('Seven designs'));
  await sleep(3500);
  console.log('attacks', await scrollToText('Attacks that moved money'));
  await sleep(10000);
} else if (shot === 'S06') {
  await page.goto(BASE + '/challenge', { waitUntil: 'networkidle' });
  await sleep(4000);
  console.log('latest', await scrollToText('Latest attempts'));
  await sleep(5500);
  console.log('door2', await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); return true; }));
  await sleep(6500);
} else if (shot === 'S01') {
  await page.goto('https://www.giskard.ai/knowledge/how-grok-got-prompt-injected-an-x-user-drained-150-000-from-an-ai-wallet', { waitUntil: 'domcontentloaded' });
  await page.getByText('No, thanks').first().click({ timeout: 8000 }).catch(() => {});
  await sleep(2500);
  await page.screenshot({ path: 'video/raw/s01-giskard.png' });
  await sleep(2500);
  await page.goto('https://oecd.ai/en/incidents/2026-05-04-4a73', { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await page.screenshot({ path: 'video/raw/s01-oecd.png' });
  await sleep(2500);
}
const v = page.video();
await ctx.close();
fs.renameSync(await v.path(), `video/raw/${shot}-pre1.webm`);
await browser.close();

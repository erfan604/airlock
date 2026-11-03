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
const ZOOM = Number(process.env.ZOOM ?? 1.6);
await page.addInitScript((z) => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.zoom = String(z); }); }, ZOOM);
// pan: smoothly scroll so the heading containing `text` sits `off` px from the top, over `ms` ms (ease in out), then hold `hold` ms
const pan = async (text, off, ms, hold, extra = 0) => {
  await page.evaluate(([t, off, ms, extra]) => new Promise((done) => {
    const el = text2el(t);
    const target = el ? Math.max(0, window.scrollY + el.getBoundingClientRect().top - off) + extra : window.scrollY;
    const y0 = window.scrollY; const t0 = performance.now();
    const step = (now) => { const k = Math.min(1, (now - t0) / ms); const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; window.scrollTo(0, y0 + (target - y0) * e); k < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
    function text2el(t) { return [...document.querySelectorAll('h1,h2,h3,h4')].find((e) => e.textContent && e.textContent.includes(t)); }
  }), [text, off, ms, extra]);
  await sleep(hold);
};
const drift = (px, ms) => page.evaluate(([px, ms]) => new Promise((done) => { const y0 = window.scrollY; const t0 = performance.now(); const step = (now) => { const k = Math.min(1, (now - t0) / ms); window.scrollTo(0, y0 + px * k); k < 1 ? requestAnimationFrame(step) : done(); }; requestAnimationFrame(step); }), [px, ms]);
if (shot === 'S02') {
  await page.goto(BASE + '/bench', { waitUntil: 'networkidle' });
  await sleep(300);
  await pan('Seven designs', 70, 600, 0);
  await drift(120, 9500);        // V0, CAPS, BLOCKLIST, MANDATE rows, a slow drift down
  await pan('Seven designs', -420, 1800, 3500);   // the A1 and A2 rows
  await sleep(500);
} else if (shot === 'S06') {
  await page.goto(BASE + '/challenge', { waitUntil: 'networkidle' });
  await sleep(300);
  await pan('Steal this agent', 90, 500, 1500);
  await drift(140, 2500);        // the counter sentence
  await pan('Latest attempts', 90, 1800, 1500);
  await drift(300, 3500);        // attempts rows
  await pan('Door two', 90, 1800, 1500);
  await drift(220, 3500);        // door two block with the published key
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

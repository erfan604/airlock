// Pre-lock capture helper: replays recorded pty output (scripts/video-term-record.py) in an xterm.js page and records it
// with Playwright at 1920x1080. Usage: node scripts/video-term-replay.mjs <name> <spec.json>
// spec: {"steps":[{"prompt":"pnpm proven","rec":"video/raw/proven.json","maxGap":0.35,"hold":2}, ...], "tail":3}
// Gaps between output chunks longer than maxGap are shortened to maxGap (waits are cut, output and order are unchanged).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE);
const XT = process.env.XTERM_DIR;
const [name, specFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = `<!doctype html><meta charset=utf-8><style>${fs.readFileSync(XT + '/css/xterm.css', 'utf8')}
html,body{margin:0;background:#0b0e11;height:100%}#bar{height:44px;background:#161b22;color:#8b949e;font:15px -apple-system,sans-serif;display:flex;align-items:center;padding-left:18px}
#t{position:absolute;top:44px;left:16px;right:16px;bottom:8px}</style><div id=bar>airlock</div><div id=t></div><script>${fs.readFileSync(XT + '/lib/xterm.js', 'utf8')}</script>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: 'video/raw/pw', size: { width: 1920, height: 1080 } } });
const page = await ctx.newPage();
await page.setContent(html);
await page.evaluate(() => {
  window.term = new Terminal({ fontSize: 22, fontFamily: 'Menlo, monospace', cols: 110, rows: 38, convertEol: true, theme: { background: '#0b0e11' }, cursorBlink: false });
  window.term.open(document.getElementById('t'));
});
const w = (s) => page.evaluate((s) => new Promise((r) => window.term.write(s, r)), s);
await sleep(800);
for (const st of spec.steps) {
  if (st.card) { await w('\x1b[2J\x1b[H\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\n'); for (const l of st.card) { await w('   ' + l + '\r\n\r\n'); await sleep(300); } await sleep((st.hold ?? 3) * 1000); continue; }
  await w('\x1b[32m$\x1b[0m ');
  for (const ch of st.prompt) { await w(ch); await sleep(45); }
  await sleep(500);
  await w('\r\n');
  const rec = JSON.parse(fs.readFileSync(st.rec, 'utf8'));
  let prev = 0;
  for (const c of rec.chunks) {
    const gap = Math.min(c.t - prev, st.maxGap ?? 0.35);
    prev = c.t;
    if (gap > 0.02) await sleep(gap * 1000);
    await w(c.d);
  }
  await sleep((st.hold ?? 2) * 1000);
  await w('\r\n');
}
await sleep((spec.tail ?? 2) * 1000);
const v = page.video();
await ctx.close();
fs.renameSync(await v.path(), `video/raw/${name}-pre1.webm`);
await browser.close();

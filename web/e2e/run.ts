// The e2e harness of AIR-183: `tsx e2e/run.ts <name>` (pnpm -C web e2e <name>).
// It serves the built dist through Vite's preview API (so the CSP plugin and the proxy are the real ones), launches headless
// Chromium, fails on any console message of type error (Chromium logs every CSP violation that way) and on any page error,
// imports e2e/<name>.setup.ts first when it exists (AIR-184: its default export is `() => Promise<{ env?, close() }>`; the env is merged into
// process.env before the preview server loads the Vite config, so a stub runtime can name its own origin, and close runs at the end), then runs
// e2e/<name>.e2e.ts, whose default export is `(ctx: { page, baseUrl }) => Promise<void>`. The built-in name `fixtures` visits
// every registered /fixtures/* route. The last line printed is `E2E <name> OK` (`E2E fixtures OK (<n> routes)`) or nothing of
// the kind and a nonzero exit.
// Every context is created with a viewport and nothing else for layout: no isMobile, no hasTouch, no device descriptor. All of
// them set isMobile, which makes window.innerWidth follow the content width and hides an overflow from the kit audit.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { serveStatic } from '../scripts/serve-static.ts';
import { buildCsp, defaultCspInputs, normalizeNonce } from '../csp.ts';
import { listFixtures } from '../src/fixtures/index.ts';
import { AUDIT_HEIGHT, AUDIT_WIDTHS, clipAudit } from './audit.ts';
import type { E2E, E2EContext, E2ESetup } from './types.ts';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const auditDir = join(webRoot, 'audit');

const name = process.argv[2];
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('usage: tsx e2e/run.ts <name>   (name of e2e/<name>.e2e.ts, or fixtures)');
  process.exit(2);
}

async function runFixtures({ page, baseUrl }: E2EContext, problems: string[]): Promise<number> {
  mkdirSync(auditDir, { recursive: true });
  const expectedCsp = normalizeNonce(buildCsp({ ...defaultCspInputs(), nonce: 'x' }));
  const fixtures = listFixtures();
  for (const f of fixtures) {
    const res = await page.goto(`${baseUrl}/fixtures/${f.name}`, { waitUntil: 'networkidle' });
    const header = res?.headers()['content-security-policy'];
    if (!header) problems.push(`${f.name}: no content-security-policy header`);
    else if (normalizeNonce(header) !== expectedCsp) problems.push(`${f.name}: content-security-policy differs from buildCsp (nonce normalized)\n  got:  ${normalizeNonce(header)}\n  want: ${expectedCsp}`);
    await page.waitForSelector('main');
    await page.evaluate(() => document.fonts.ready.then(() => true));
    for (const width of AUDIT_WIDTHS) {
      await page.setViewportSize({ width, height: AUDIT_HEIGHT });
      await page.screenshot({ path: join(auditDir, `${f.name}-${width}.png`), fullPage: true });
    }
    const messages = await clipAudit(page);
    if (f.expectAuditFail) {
      if (messages.length === 0) problems.push(`${f.name}: the clip audit found nothing on a route that must fail it`);
    } else if (messages.length > 0) {
      problems.push(`${f.name}: clip audit\n  ${messages.join('\n  ')}`);
    }
  }
  return fixtures.length;
}

const problems: string[] = [];
let okLine = '';
let server: { close(): Promise<unknown> } | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let setupHandle: Awaited<ReturnType<E2ESetup>> | undefined;
try {
  // AIR-310: `static` (and AIR-311's `nojs`) serve web/dist-static as plain files, the way a static host does: no preview server, no proxy, no runtime
  const isStatic = name === 'static' || name === 'nojs';
  if (!isStatic && !existsSync(join(webRoot, 'dist', 'index.html'))) throw new Error('web/dist/index.html is missing: run `pnpm -C web build` first');
  const setup = new URL(`./${name}.setup.ts`, import.meta.url);
  if (existsSync(fileURLToPath(setup))) {
    const mod = (await import(setup.href)) as { default?: E2ESetup };
    if (typeof mod.default !== 'function') throw new Error(`e2e/${name}.setup.ts has no default export function`);
    setupHandle = await mod.default();
    Object.assign(process.env, setupHandle.env ?? {});
  }
  const e2eFile = new URL(`./${name}.e2e.ts`, import.meta.url);
  if (name !== 'fixtures' && !existsSync(fileURLToPath(e2eFile))) throw new Error(`no e2e/${name}.e2e.ts`);

  let baseUrl: string;
  if (isStatic) {
    const hosted = await serveStatic(join(webRoot, 'dist-static'), 0);
    server = hosted;
    baseUrl = hosted.url;
  } else {
    const live = await preview({ root: webRoot, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false } });
    server = live;
    baseUrl = (live.resolvedUrls?.local[0] ?? '').replace(/\/$/, '');
  }
  if (!baseUrl) throw new Error('the preview server has no URL');

  // Installed Google Chrome (patched stable) with the sandbox on, not Playwright's bundled Chromium (156.0.8078.4 in 1.64.1 lags the
  // 156.0.8078.73 security fixes, and Playwright turns the sandbox off unless asked). Set E2E_BUNDLED_CHROMIUM=1 where Chrome is missing (CI).
  browser = await chromium.launch(process.env.E2E_BUNDLED_CHROMIUM === '1' ? { chromiumSandbox: true } : { channel: 'chrome', chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 375, height: AUDIT_HEIGHT } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()} (${msg.location().url})`);
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));

  if (name === 'fixtures') {
    const n = await runFixtures({ page, baseUrl }, problems);
    okLine = `E2E fixtures OK (${n} routes)`;
  } else {
    const mod = (await import(e2eFile.href)) as { default?: E2E };
    if (typeof mod.default !== 'function') throw new Error(`e2e/${name}.e2e.ts has no default export function`);
    await mod.default({ page, baseUrl });
    okLine = `E2E ${name} OK`;
  }
} catch (e) {
  problems.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await browser?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await setupHandle?.close().catch(() => undefined);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`E2E ${name} FAIL: ${p}`);
  process.exit(1);
}
console.log(okLine);
process.exit(0);

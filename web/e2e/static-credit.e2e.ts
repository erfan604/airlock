// AIR-329: /credit in a real browser, on the static build. The fixture (no pool named: badged, with the scene running and the ticker filling), a live
// pool read from a mocked RPC (stats, wallet button states, deposit closed until a wallet is connected), the unreadable state (no numbers, no zeros),
// reduced motion (the poster, no canvas), a browser without WebGL (the flat diagram), no CSP violation (three must not need eval), and the clip audit
// and a screenshot at 375 and 1440 in each look that matters. Run: pnpm build:static && pnpm -C web e2e static-credit
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { FIXTURE_POOL } from '../src/credit/fixture.ts';
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const auditDir = join(fileURLToPath(new URL('../', import.meta.url)), 'audit');
const id = (testId: string, page: Page) => page.locator(`[data-testid="${testId}"]`);
const WIDTHS = [{ width: 375, height: 812 }, { width: 1440, height: 900 }] as const;
const CORS = { 'access-control-allow-origin': '*' };

/** The `get_pool` view as the contract will answer it (snake_case, decimal strings), made from the fixture so the page's numbers are known. */
function poolBody(): string {
  const p = FIXTURE_POOL;
  const view = {
    assets: p.assets, shares: p.shares, idle: p.idle, staked: p.staked, lent: p.lent, fees_earned: p.feesEarned, losses: p.losses, share_price: p.sharePrice,
    lines: p.lines.map((l) => ({ card: l.card, borrower: l.borrower, limit: l.limit, drawn: l.drawn, returned: l.returned, fee_bps: l.feeBps, due_ms: l.dueMs, state: l.state })),
    staking_earned: p.stakingEarned, started_ms: p.startedMs,
  };
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(view)));
  return JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result: { result: bytes } });
}

async function shot(page: Page, name: string, width: number): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.screenshot({ path: join(auditDir, `static-credit-${name}-${String(width)}.png`), fullPage: true });
}

const audit = async (page: Page, label: string): Promise<void> => assert.deepEqual(await clipAudit(page, [375, 1440]), [], `clip audit, ${label}`);

async function routeChain(page: Page, mode: 'live' | 'down'): Promise<void> {
  await page.route('https://test.rpc.fastnear.com/**', (r) =>
    mode === 'live' ? r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: poolBody() }) : r.abort(),
  );
  for (const host of ['near-testnet.drpc.org', 'testnet-rpc.intea.rs', 'rpc.testnet.near.org']) await page.route(`https://${host}/**`, (r) => r.abort());
  await page.route('https://tx.test.fastnear.com/**', (r) =>
    mode === 'live' ? r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ account_txs: [], resume_token: null }) }) : r.abort(),
  );
}

const run: E2E = async ({ page, baseUrl }) => {
  mkdirSync(auditDir, { recursive: true });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const csp = async (label: string): Promise<void> => assert.deepEqual(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []), [], `${label}: securitypolicyviolation`);

  for (const viewport of WIDTHS) {
    await page.setViewportSize(viewport);

    // 1. the fixture: badged, the scene runs, the ticker fills, a card can be picked
    await page.goto(`${baseUrl}/credit/`);
    await id('credit-badge', page).waitFor();
    assert.equal(await id('credit-badge', page).getAttribute('data-source'), 'fixture');
    assert.ok((await id('credit-badge', page).innerText()).startsWith('Fixture data'), 'the badge says fixture first');
    await id('credit-stats', page).waitFor();
    // the scene starts once the page has loaded and is idle: the poster is there first
    await id('credit-poster', page).waitFor();
    await id('credit-canvas', page).waitFor();
    assert.equal(await id('credit-stage', page).getAttribute('data-mode'), 'scene');
    const before = await page.locator('[data-testid="ticker-row"]').count();
    assert.ok(before > 0, 'the ticker starts with fixture history');
    assert.equal(await page.locator('[data-testid="ticker-row"][data-fixture="false"]').count(), 0, 'every fixture event is marked');
    await page.waitForTimeout(4200);
    await shot(page, 'fixture', viewport.width);
    await audit(page, 'fixture');
    assert.equal(await id('stat-stolen', page).locator('dd').first().innerText(), '0.00 NEAR');
    assert.ok(!/testnet|erfan/i.test(await page.locator('main').innerText()), 'the word testnet and the owner name are never shown on /credit');
    assert.ok((await id('money-why', page).innerText()).includes('not deployed'), 'deposits are closed on the fixture');
    assert.equal(await id('money-submit', page).isDisabled(), true);
    assert.equal(await id('wallet-connect', page).count(), 0, 'no wallet button while there is no pool');
    await id('line-select', page).first().click();
    await id('scene-selected', page).waitFor();
    await page.waitForTimeout(2600);
    await shot(page, 'card', viewport.width);
    await id('scene-back', page).click();
    await id('line-select', page).first().waitFor();
    assert.equal(await id('scene-selected', page).count(), 0);
    await csp('fixture');

    // 2. a live pool (mocked RPC): live badge, the numbers, the wallet states
    await page.unrouteAll();
    await routeChain(page, 'live');
    await page.goto(`${baseUrl}/credit/?pool=pool.test.testnet`);
    await page.waitForFunction(() => document.querySelector('[data-testid="credit-badge"]')?.getAttribute('data-source') === 'live');
    assert.ok((await id('credit-badge', page).innerText()).startsWith('Live, reading the pool contract'));
    assert.ok(((await id('credit-badge', page).locator('a').getAttribute('href')) ?? '').endsWith('/address/pool.test.testnet'), 'the pool is linked through the explorer');
    assert.ok((await id('stat-tvl', page).innerText()).includes('5,000.00 NEAR'));
    assert.ok((await id('stat-util', page).innerText()).includes('30.00%'));
    assert.equal(await page.locator('[data-testid="line-row"]').count(), FIXTURE_POOL.lines.length);
    assert.equal(await id('wallet-connect', page).getAttribute('data-state'), 'off');
    assert.equal(await id('wallet-connect', page).isEnabled(), true);
    assert.equal(await id('money-submit', page).isDisabled(), true, 'deposit stays closed until a wallet is connected');
    await id('money-input', page).fill('2.5');
    assert.ok((await id('money-preview', page).innerText()).includes('shares'), 'the share preview');
    assert.equal(await id('money-submit', page).isDisabled(), true);
    await id('money-input', page).fill('1e3');
    assert.ok((await id('money-preview', page).innerText()).includes('Enter a plain amount'));
    await id('money-withdraw', page).click();
    assert.equal(await id('money-withdraw', page).getAttribute('aria-pressed'), 'true');
    assert.ok(!/testnet|erfan/i.test(await page.locator('main').innerText()), 'live: no testnet or owner name in the text');
    assert.ok((await id('site-foot', page).innerText()).includes("NEAR's test network"), 'one plain factual line says it is the test network');
    await page.waitForTimeout(1500);
    await shot(page, 'live', viewport.width);
    await audit(page, 'live');
    await csp('live');

    // 3. the chain cannot be read: no numbers, no zeros. A separate context: the aborted requests are logged by the browser as console errors,
    // which the harness would count against the page.
    await page.unrouteAll();
    const ctx = await page.context().browser()?.newContext({ viewport: viewport });
    if (ctx === undefined) throw new Error('no browser context');
    const down = await ctx.newPage();
    await routeChain(down, 'down');
    await down.goto(`${baseUrl}/credit/?pool=pool.test.testnet`);
    await id('credit-unreadable', down).waitFor();
    assert.equal(await id('credit-badge', down).getAttribute('data-source'), 'unreadable');
    assert.equal(await id('credit-stats', down).count(), 0);
    assert.equal(await down.locator('[data-testid="line-row"]').count(), 0);
    const text = await down.locator('main').innerText();
    assert.ok(text.includes('The chain could not be read'));
    for (const bad of ['0.00 NEAR', '0 NEAR', '0%', 'No events']) assert.ok(!text.includes(bad), bad);
    await shot(down, 'unreadable', viewport.width);
    await audit(down, 'unreadable');
    await ctx.close();
  }

  // the nav strip on a phone: the current tab is fully inside the strip on every page that has a tab. A separate context with the chain hosts and the
  // challenge file cut off: those pages fail their own reads there, and the browser logs that as console errors the harness would count.
  const navCtx = await page.context().browser()?.newContext({ viewport: { width: 375, height: 812 } });
  if (navCtx === undefined) throw new Error('no browser context');
  const nav = await navCtx.newPage();
  await nav.route((u) => u.host !== new URL(baseUrl).host, (r) => r.abort());
  await nav.route('**/challenge-public.json', (r) => r.abort());
  for (const path of ['/credit/', '/approvals/', '/challenge/', '/bench/', '/proven/', '/replay/', '/use/']) {
    await nav.goto(`${baseUrl}${path}`);
    await nav.locator('[data-testid^="tab-"][aria-current="page"]').waitFor();
    await nav.waitForTimeout(150);
    const fit = await nav.evaluate(() => {
      const ul = document.querySelector('.site-tabs') as HTMLElement;
      const tab = document.querySelector('[data-testid^="tab-"][aria-current="page"]') as HTMLElement;
      const u = ul.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      return { left: t.left - u.left, right: u.right - t.right };
    });
    assert.ok(fit.left >= -1 && fit.right >= 27, `${path}: the current tab is inside the strip (${JSON.stringify(fit)})`);
    assert.deepEqual(await clipAudit(nav, [375]), [], `clip audit 375, ${path}`);
  }
  await navCtx.close();

  // 4. reduced motion: the poster, no canvas, a button to play
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${baseUrl}/credit/`);
  await id('credit-poster', page).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="credit-stage"]')?.getAttribute('data-mode') === 'poster');
  assert.equal(await id('credit-canvas', page).count(), 0, 'no canvas under reduced motion');
  assert.ok((await id('stage-note', page).innerText()).includes('Motion is off'));
  await shot(page, 'poster', 1440);
  await id('play-scene', page).click();
  await id('credit-canvas', page).waitFor();
  await page.emulateMedia({ reducedMotion: null });

  // 5. no WebGL: the flat diagram and no play button
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
      return (orig as (k: string, ...r: unknown[]) => unknown).call(this, kind, ...rest) as never;
    } as typeof orig;
  });
  await page.goto(`${baseUrl}/credit/`);
  await id('credit-poster', page).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="credit-stage"]')?.getAttribute('data-mode') === 'diagram');
  assert.equal(await id('play-scene', page).count(), 0);
  assert.ok((await id('stage-note', page).innerText()).includes('no WebGL'));
  await id('credit-stats', page).waitFor();
};

export default run;

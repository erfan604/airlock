// The static build in a real browser (AIR-310): web/dist-static served as plain files, the way Cloudflare Pages or GitHub Pages serve it. The
// landing at /, the Try page (AIR-311), the replay at /replay, the Bench, Proven, Challenge and Live pages at 375x667 and 1440x900, the clip audit at 375 and 1440 on each, screenshots to
// web/audit/static-<page>-<width>.png, every request on the page's own host, except the two public chain hosts the hosted Challenge board reads (AIR-320, answered from recorded fixtures here), the Content-Security-Policy of the
// host header on every document, and the recorded hashes taken from the golden files. The harness fails on any console error.
// Run: pnpm build:static && pnpm -C web e2e static
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { RequestView } from '@airlock/runtime/chain-types';
import { buildStaticCsp, normalizeNonce } from '../csp.ts';
import { approveArgs } from '../src/approvals/cardModel.ts';
import { clipAudit } from './audit.ts';
import { checkHired, checkLanding, checkTry, showPreset } from './site.ts';
import type { E2E } from './types.ts';

const web = fileURLToPath(new URL('../', import.meta.url));
const repo = join(web, '..');
const auditDir = join(web, 'audit');
const golden = (name: string): { txs: { hash: string; url: string }[] } => JSON.parse(readFileSync(join(repo, 'bench', 'golden', `${name}.json`), 'utf8')) as { txs: { hash: string; url: string }[] };
const dist = (path: string): unknown => JSON.parse(readFileSync(join(web, 'dist-static', path), 'utf8')) as unknown;
const u01 = golden('u01');
const approveGolden = golden('b01-approve');
const tamperGolden = golden('tamper');

// AIR-320: the hosted /challenge reads two public hosts and one file. The browser gets recorded real FastNEAR answers (web/fixtures/challenge-*.json,
// policy-v2 and the key that signed two of its transactions) and a made-up published file; nothing leaves the machine.
const fixture = (name: string): string => readFileSync(join(web, 'fixtures', name), 'utf8');
const CHAIN_HOSTS = ['tx.test.fastnear.com', 'test.rpc.fastnear.com'];
const PUBLISHED = JSON.stringify({
  format: 'airlock-challenge-public-v1',
  policy: 'policy-v2.erfan-airlock.testnet',
  agent: 'erfan-agent.testnet',
  publicKey: 'ed25519:7HeWNqtLJHGzmsjPZn9LbPgAgjVBpFPn4vrqTgjDcPfP',
  secretKey: `ed25519:${'2'.repeat(88)}`,
  allowance: '1 NEAR left',
  tasks: [
    {
      task: { tag: 'airlock-task-v1', task_id: 'e2e-task', contract_id: 'policy-v2.erfan-airlock.testnet', agent_id: 'erfan-agent.testnet', plan_sha256: 'ab'.repeat(32), instruction_sha256_salted: 'cd'.repeat(32), issued_ms: 1_700_000_000_000, expires_ms: 4_000_000_000_000, max_actions: 20, bounds: [{ payee_key: 'near:accountant.erfan-airlock.testnet', max_total: '2000000000000000000000000' }] },
      task_sig: 'c2lnbmF0dXJl',
      issuedAt: '2023-11-14T22:13:20.000Z',
      expiresAt: '2096-10-02T07:06:40.000Z',
      permits: { payee: 'near:accountant.erfan-airlock.testnet', asset: 'NEAR', maxTotal: '2', maxActions: 20, agent: 'erfan-agent.testnet', contract: 'policy-v2.erfan-airlock.testnet', ttlMinutes: 10080 },
    },
  ],
});

async function mockChain(page: Page): Promise<void> {
  await page.route('**/challenge-public.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: PUBLISHED }));
  await page.route('https://tx.test.fastnear.com/**', (r) => {
    const body = JSON.parse(r.request().postData() ?? '{}') as { tx_hashes?: string[] };
    const hashes = body.tx_hashes;
    if (r.request().url().endsWith('/v0/account')) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...(JSON.parse(fixture('challenge-fastnear-account-page.json')) as object), resume_token: null }) });
    const all = (JSON.parse(fixture('challenge-fastnear-transactions.json')) as { transactions: { transaction: { hash: string } }[] }).transactions;
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ transactions: all.filter((t) => hashes?.includes(t.transaction.hash)) }) });
  });
  const book = Array.from(new TextEncoder().encode(JSON.stringify([['near:accountant.erfan-airlock.testnet', {}]])));
  await page.route('https://test.rpc.fastnear.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'book', result: { result: book } }) }));
}

async function hostedChallenge(page: Page, baseUrl: string, width: number): Promise<void> {
  await page.goto(`${baseUrl}/challenge`);
  await id('ch-rows', page).waitFor();
  assert.equal(await id('count-attempts', page).innerText(), '2', 'two recorded calls signed by the published key');
  assert.equal(await id('count-held', page).innerText(), '1');
  assert.equal(await id('count-stolen', page).innerText(), '0 NEAR');
  assert.equal(await id('attempt-row', page).count(), 2);
  assert.ok((await id('ch-hosted', page).innerText()).includes('This hosted copy has no server'));
  assert.ok((await id('door-shut', page).innerText()).includes('hosted copy'));
  assert.equal(await id('key-public', page).innerText(), 'ed25519:7HeWNqtLJHGzmsjPZn9LbPgAgjVBpFPn4vrqTgjDcPfP');
  assert.ok((await id('key-secret', page).innerText()).startsWith('ed25519:'));
  const command = await id('command-text', page).innerText();
  assert.ok(command.startsWith('near contract call-function as-transaction policy-v2.erfan-airlock.testnet submit_batch json-args'), 'the copy-paste command');
  assert.ok(command.includes('sign-as erfan-agent.testnet network-config testnet sign-with-plaintext-private-key ed25519:'));
  assert.ok((await id('task-json', page).innerText()).includes('e2e-task'));
  await shot(page, 'challenge', width);
  await audit(page, 'challenge');
}

const id = (testId: string, page: Page) => page.locator(`[data-testid="${testId}"]`);
const WIDTHS = [{ width: 375, height: 667 }, { width: 1440, height: 900 }] as const;

async function shot(page: Page, name: string, width: number): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.screenshot({ path: join(auditDir, `static-${name}-${String(width)}.png`), fullPage: true });
}

async function audit(page: Page, label: string): Promise<void> {
  assert.deepEqual(await clipAudit(page, [375, 1440]), [], `clip audit, ${label}`);
}

async function replayPage(page: Page, baseUrl: string, width: number): Promise<void> {
  await page.goto(`${baseUrl}/replay`);
  await id('replay-banner', page).waitFor();
  assert.ok((await id('replay-banner', page).innerText()).includes('Replay of recorded run'), 'banner');
  assert.equal(await page.locator('[data-testid="login-connect"]').count(), 0, 'no wallet login in the static copy');

  // act 1: the invoice auto-paid
  await id('act-u01', page).click();
  await id('trace-end', page).waitFor();
  assert.equal(await id('act-title', page).innerText(), 'Act 1 Invoice paid');
  assert.equal(await id('verdict-stamp', page).getAttribute('data-state'), 'allowed');
  assert.ok((await id('trace-list', page).innerText()).includes('4.2 NEAR'), 'the amount carries its symbol');
  assert.equal(await id('tx-link', page).getAttribute('data-hash'), u01.txs[0]?.hash);
  // AIR-311: the act opens with its outcome, and the trace shows its key steps until it is expanded
  assert.equal(await id('act-outcome', page).getAttribute('data-state'), 'allowed');
  assert.equal(await id('outcome-money', page).innerText(), '4.2 NEAR paid');
  const keyRows = await page.locator('[data-testid="trace-list"] [data-testid="trace-row"]').count();
  await id('trace-expand', page).click();
  assert.ok((await page.locator('[data-testid="trace-list"] [data-testid="trace-row"]').count()) > keyRows, 'show the full trace adds rows');
  await id('trace-expand', page).click();
  await shot(page, 'replay-act1', width);
  await audit(page, 'act 1');

  // act 2: the correction held, the real card, the replayed approval
  await id('act-b01', page).click();
  await id('trace-end', page).waitFor();
  await id('card-title', page).waitFor();
  assert.equal(await id('act-title', page).innerText(), 'Act 2 Correction held');
  const stamp = page.locator('[data-testid="trace-list"] [data-testid="verdict-stamp"]');
  assert.ok((await stamp.innerText()).includes('HELD FOR YOU'));
  assert.equal(await id('act-outcome', page).getAttribute('data-state'), 'held');
  assert.equal(await id('outcome-money', page).innerText(), '9.4 NEAR held');
  assert.ok((await id('outcome-reason', page).innerText()).includes('Nothing moves until you approve it.'));
  const held = dist('data/replay/request/' + encodeURIComponent(String((dist('data/replay/acts.json') as { acts: { id: string; pendingNo: string }[] }).acts.find((a) => a.id === 'b01')?.pendingNo)) + '.json') as { view: RequestView };
  const title = await id('card-title', page).innerText();
  assert.ok(title.startsWith('Pay 9.4 NEAR to ') && title.endsWith('?'), `card title: ${title}`);
  const args = approveArgs(held.view);
  for (const name of ['to', 'asset', 'amount', 'why', 'book'] as const) assert.equal(await id(`arg-${name}`, page).textContent(), args[name], `arg-${name}`);
  assert.equal(await id('replay-label', page).innerText(), 'Replay: no wallet is used');
  assert.ok(!(await page.locator('body').innerText()).includes('4.2 NEAR'), 'the April invoice never appears in act 2');
  await shot(page, 'replay-act2', width);
  await audit(page, 'act 2');
  await id('open-approve', page).click();
  await id('confirm-approve', page).click();
  await page.locator('[data-testid="card"] [data-testid="verdict-stamp"][data-state="approved"]').waitFor();
  assert.ok((await page.locator('[data-testid="card"] [data-testid="verdict-stamp"]').innerText()).includes('APPROVED BY YOU'));
  assert.equal(await id('approve-link', page).getAttribute('data-hash'), approveGolden.txs[0]?.hash);
  await shot(page, 'replay-act2-approved', width);

  // act 3: the tampered approve
  await id('act-tamper', page).click();
  await id('tamper-result', page).waitFor();
  assert.equal(await id('tamper-failure', page).innerText(), 'approve rejected: WrongAmount');
  assert.equal(await id('act-outcome', page).getAttribute('data-state'), 'blocked');
  assert.equal(await id('tamper-link', page).getAttribute('data-hash'), tamperGolden.txs[0]?.hash);
  await shot(page, 'replay-act3', width);
  await audit(page, 'act 3');
}

const run: E2E = async ({ page, baseUrl }) => {
  mkdirSync(auditDir, { recursive: true });
  const hosts = new Set<string>();
  const failed: string[] = [];
  const csp: string[] = [];
  await mockChain(page);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.protocol !== 'data:' && u.protocol !== 'blob:') hosts.add(u.host);
  });
  page.on('requestfailed', (req) => failed.push(`${req.url()} ${req.failure()?.errorText ?? ''}`));
  page.on('response', (res) => {
    if (res.request().resourceType() === 'document') csp.push(res.headers()['content-security-policy'] ?? '');
  });

  for (const viewport of WIDTHS) {
    await page.setViewportSize(viewport);
    // AIR-311: the landing at /, the Try page on the real verdict.wasm, then the replay at /replay
    await checkLanding(page, baseUrl);
    await page.waitForTimeout(2600);
    await shot(page, 'landing', viewport.width);
    await audit(page, 'landing');
    await checkTry(page, baseUrl);
    await audit(page, 'try after the presets');
    await checkHired(page, baseUrl);
    await shot(page, 'try-hired', viewport.width);
    await audit(page, 'try hired');
    for (const preset of ['doctored', 'honest']) {
      await showPreset(page, baseUrl, preset);
      await shot(page, `try-${preset}`, viewport.width);
      await audit(page, `try ${preset}`);
    }
    await replayPage(page, baseUrl, viewport.width);

    await page.goto(`${baseUrl}/bench`);
    await page.waitForSelector('[data-testid="bench-compare"]');
    await shot(page, 'bench', viewport.width);
    await audit(page, 'bench');

    await page.goto(`${baseUrl}/proven`);
    await id('proven', page).waitFor();
    await shot(page, 'proven', viewport.width);
    await audit(page, 'proven');

    await hostedChallenge(page, baseUrl, viewport.width);

    await page.goto(`${baseUrl}/live`);
    await id('static-live', page).waitFor();
    assert.ok((await id('static-live', page).innerText()).includes('pnpm demo:live'));
    await shot(page, 'live', viewport.width);
    await audit(page, 'live');
    await page.setViewportSize(viewport);
  }

  // AIR-311: reduced motion shows the poster and never loads the loop; otherwise the loop is muted, inline and looping
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/`);
  const video = id('hero-video', page);
  await video.waitFor({ state: 'attached' });
  assert.deepEqual(await video.evaluate((v) => [(v as HTMLVideoElement).muted, (v as HTMLVideoElement).loop, v.hasAttribute('playsinline'), v.getAttribute('poster')]), [true, true, true, '/media/hero-poster.jpg']);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${baseUrl}/`);
  await id('hero-poster', page).waitFor();
  assert.equal(await id('hero-video', page).count(), 0, 'no video under reduced motion');
  await page.goto(`${baseUrl}/`);
  await id('tube-band-poster', page).waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-testid="tube-band"] video').count(), 0, 'no tube video under reduced motion');
  assert.equal(await page.locator('[data-testid^="how-step-"][data-active]').count(), 0, 'no step lit under reduced motion');
  // the stamp shows its last frame only (the switchyard is held back: SHOW_YARD in ReplayShell)
  await page.goto(`${baseUrl}/try`);
  await id('try-stamp-end', page).waitFor();
  assert.equal(await id('try-stamp-end', page).getAttribute('src'), '/media/stamp-held-end.jpg');
  await page.emulateMedia({ reducedMotion: null });
  // AIR-311: the stamp clip follows the verdict
  await page.goto(`${baseUrl}/try`);
  await page.waitForFunction(() => document.querySelector('[data-testid="try-stamp-video"]')?.getAttribute('src') === '/media/stamp-held.mp4');
  await id('try-preset-honest', page).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="try-stamp-video"]')?.getAttribute('src') === '/media/stamp-allowed.mp4');
  // AIR-311: the How it works band loads its loop only near the viewport, then lights the step it is showing
  await page.goto(`${baseUrl}/`);
  const band = id('tube-band-video', page);
  await band.waitFor({ state: 'attached' });
  assert.equal(await band.getAttribute('src'), null, 'the tube loop waits until it is near the viewport');
  await band.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-testid="tube-band-video"]')?.getAttribute('src') === '/media/tubes.mp4');
  await page.locator('[data-testid^="how-step-"][data-active="true"]').waitFor({ timeout: 10_000 });

  // an unknown path is a 404 from the host and still serves the console page
  const missing = await page.request.get(`${baseUrl}/no-such-page`);
  assert.equal(missing.status(), 404);
  assert.ok((await missing.text()).includes('<div id="root"'));
  // the module the Try page runs is served as wasm
  const wasm = await page.request.get(`${baseUrl}/verdict.wasm`);
  assert.equal(wasm.status(), 200);

  const origin = new URL(baseUrl).host;
  assert.deepEqual([...hosts].filter((h) => !CHAIN_HOSTS.includes(h)), [origin], `every request goes to ${origin} or a public chain host, got ${[...hosts].join(', ')}`);
  assert.deepEqual(CHAIN_HOSTS.filter((h) => !hosts.has(h)), [], 'the board read both chain hosts');
  assert.deepEqual(failed, [], 'no request failed');
  const want = normalizeNonce(buildStaticCsp({ header: true, nonce: 'x' }));
  assert.ok(csp.length > 0 && csp.every((c) => normalizeNonce(c) === want), 'every document carries the static Content-Security-Policy');
};

export default run;

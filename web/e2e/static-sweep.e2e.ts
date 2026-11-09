// AIR-335: the owner rule for visible web text, enforced on every prerendered page of the hosted site (and its 404): the main text, the nav, the shell bar
// and the document title never contain the word "testnet" or a name containing "erfan", and every page ends in the one footer fact line. States that
// change the text are visited too: the Try presets (both worlds), the three replay acts with the approval, the challenge page with a published key.
// What is not text and is not checked: code blocks (<code>, <pre>, <kbd>, <samp>: commands and their last lines must stay exact), the approval card
// (it shows the exact values the wallet signs), link targets and
// attributes. Account names that end in `.testnet` and do not contain the owner's name are identifiers, not prose: they are stripped before the word
// check (the owner's name is checked on everything). Run: pnpm build:static && pnpm -C web e2e static-sweep
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { FOOT_LINE } from '../src/App.tsx';
import { PAGES } from '../src/pages.ts';
import { HIRED, WORLD } from '../src/try/model.ts';
import type { E2E } from './types.ts';

const id = (testId: string, page: Page) => page.locator(`[data-testid="${testId}"]`);

/** The rendered text of one region (as a reader sees it, line breaks included) without its code blocks, which are hidden while it is read. */
async function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (el === null) return '';
    const hidden = Array.from(el.querySelectorAll<HTMLElement>('code, pre, kbd, samp, [data-testid="card"]'));
    const old = hidden.map((n) => n.style.display);
    hidden.forEach((n) => (n.style.display = 'none'));
    const text = el.innerText;
    hidden.forEach((n, i) => (n.style.display = old[i] ?? ''));
    return text;
  }, selector);
}

const ACCOUNT_IDENTIFIER = /[a-z0-9_.:-]*[a-z0-9]\.testnet\b/gi;

/** The problems in one piece of text: the owner's name anywhere, the word testnet outside an account identifier. */
const ACCOUNT_TOKEN = /(?:near:)?(?:[a-z0-9_-]+\.)+(?:testnet|near)(?![A-Za-z0-9_-])/g;
/** The demo accounts the Try fixtures name: ids a reader may see in text. Any other account-like string in text is an id the page made up. */
const KNOWN = new Set([...JSON.stringify([WORLD, HIRED]).matchAll(ACCOUNT_TOKEN)].map((m) => m[0].replace(/^near:/, '')));

export function problemsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[^\s]{0,40}erfan[^\s]{0,40}/gi)) out.push(`owner name: ${m[0]}`);
  for (const m of text.matchAll(ACCOUNT_TOKEN)) if (!KNOWN.has(m[0].replace(/^near:/, ''))) out.push(`account id that is not a known demo account: ${m[0]}`);
  const rest = text.replace(ACCOUNT_IDENTIFIER, '');
  for (const m of rest.matchAll(/.{0,40}testnet.{0,40}/gi)) out.push(`testnet: ${m[0]}`);
  return out;
}

async function sweep(page: Page, label: string, found: string[]): Promise<void> {
  for (const region of ['main', '[data-testid="site-nav"]', '.shell-bar', '[data-testid="site-foot"]']) {
    for (const p of problemsIn(await textOf(page, region))) found.push(`${label} ${region}: ${p}`);
  }
  for (const p of problemsIn(await page.title())) found.push(`${label} title: ${p}`);
}

const run: E2E = async ({ page: harnessPage, baseUrl }) => {
  // a context of its own: the cut-off chain hosts are logged by the browser as console errors, which the harness would count against the pages
  const ctx = await harnessPage.context().browser()?.newContext({ viewport: { width: 1440, height: 900 } });
  if (ctx === undefined) throw new Error('no browser context');
  const page = await ctx.newPage();
  // the detector itself: prose with the word fails, an account identifier does not, the owner's name always fails
  assert.ok(problemsIn('Watch the recorded testnet run').length > 0);
  assert.ok(problemsIn('Runs on NEAR testnet.').length > 0);
  assert.deepEqual(problemsIn('Pay kanocotton.testnet now'), []);
  assert.ok(problemsIn('Pay accountant.demo.testnet now').length > 0, 'an invented account id fails');
  assert.deepEqual(problemsIn('Pay Accountant (demo) now'), []);
  assert.ok(problemsIn('Pay accountant.erfan-airlock.testnet now').length > 0);
  assert.ok(problemsIn('Erfan').length > 0);
  const found: string[] = [];
  // a published key of the challenge, with the owner's names in it; the chain hosts are cut off (the pages show their own unreadable states)
  await page.route((u) => u.host !== new URL(baseUrl).host, (r) => r.abort());
  await page.route('**/challenge-public.json', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        format: 'airlock-challenge-public-v1',
        policy: 'policy-v2.erfan-airlock.testnet',
        agent: 'erfan-agent.testnet',
        publicKey: 'ed25519:7HeWNqtLJHGzmsjPZn9LbPgAgjVBpFPn4vrqTgjDcPfP',
        secretKey: `ed25519:${'2'.repeat(88)}`,
        allowance: '1 NEAR left',
        tasks: [
          {
            task: { tag: 'airlock-task-v1', task_id: 'sweep-task', contract_id: 'policy-v2.erfan-airlock.testnet', agent_id: 'erfan-agent.testnet', plan_sha256: 'ab'.repeat(32), instruction_sha256_salted: 'cd'.repeat(32), issued_ms: 1_700_000_000_000, expires_ms: 4_000_000_000_000, max_actions: 20, bounds: [{ payee_key: 'near:accountant.erfan-airlock.testnet', max_total: '2000000000000000000000000' }] },
            task_sig: 'c2lnbmF0dXJl',
            issuedAt: '2023-11-14T22:13:20.000Z',
            expiresAt: '2096-10-02T07:06:40.000Z',
            permits: { payee: 'near:accountant.erfan-airlock.testnet', asset: 'NEAR', maxTotal: '2', maxActions: 20, agent: 'erfan-agent.testnet', contract: 'policy-v2.erfan-airlock.testnet', ttlMinutes: 10080 },
          },
        ],
      }),
    }),
  );
  // an empty chain: no transactions, an empty address book (so the board reads fine and shows the key)
  const cors = { 'access-control-allow-origin': '*' };
  await page.route('https://tx.test.fastnear.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ account_txs: [], resume_token: null, transactions: [] }) }));
  await page.route('https://test.rpc.fastnear.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: 'book', result: { result: [91, 93] } }) }));
  const seen: string[] = [];

  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const p of PAGES.filter((x) => x.alias === undefined)) {
      await page.goto(`${baseUrl}${p.path === '/' ? '/' : `${p.path}/`}`);
      await page.locator('main').first().waitFor();
      await page.waitForTimeout(900);
      await sweep(page, `${p.path} @${String(viewport.width)}`, found);
      assert.equal((await id('site-foot', page).innerText()).trim(), FOOT_LINE, `${p.path}: the footer fact line`);
      assert.equal(await page.locator('[data-testid="site-foot"]').count(), 1, `${p.path}: one footer`);
      seen.push(p.path);
    }
    const missing = await page.goto(`${baseUrl}/no-such-page`);
    assert.equal(missing?.status(), 404);
    await page.locator('main').first().waitFor();
    await sweep(page, '404', found);
    assert.equal((await id('site-foot', page).innerText()).trim(), FOOT_LINE, '404: the footer fact line');
  }
  assert.ok(seen.includes('/') && seen.includes('/credit') && seen.includes('/approvals') && seen.includes('/challenge') && seen.includes('/try'), `pages swept: ${seen.join(' ')}`);

  // the Try page: every preset of both worlds, and the folded setup
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [path, presets] of [['/try/', WORLD.presets], ['/try/?s=hired', HIRED.presets]] as const) {
    await page.goto(`${baseUrl}${path}`);
    await id('try', page).waitFor();
    await sweep(page, `${path} setup`, found);
    for (const preset of presets) {
      await id(`try-preset-${preset.id}`, page).click();
      await page.locator('[data-testid="try-result"]').waitFor();
      await sweep(page, `${path} ${preset.id}`, found);
    }
  }

  // the replay: the three acts, the expanded trace, the replayed approval
  await page.goto(`${baseUrl}/replay/`);
  await id('replay-banner', page).waitFor();
  await id('act-u01', page).click();
  await id('trace-end', page).waitFor();
  await sweep(page, 'replay act 1', found);
  await id('trace-expand', page).click();
  await sweep(page, 'replay act 1 expanded', found);
  await id('act-b01', page).click();
  await id('card-title', page).waitFor();
  await sweep(page, 'replay act 2', found);
  await id('open-approve', page).click();
  await id('confirm-approve', page).click();
  await page.locator('[data-testid="card"] [data-testid="verdict-stamp"][data-state="approved"]').waitFor();
  await sweep(page, 'replay act 2 approved', found);
  await id('act-tamper', page).click();
  await id('tamper-result', page).waitFor();
  await sweep(page, 'replay act 3', found);

  // the challenge with a published key: the key and the command are shown, the policy and the agent are not named in the text
  await page.goto(`${baseUrl}/challenge/`);
  await page.locator('[data-testid="key-public"]').waitFor({ timeout: 8000 }).catch(async () => {
    throw new Error(`no published key shown; the page says: ${(await page.locator('main').innerText()).slice(0, 400)}`);
  });
  await sweep(page, 'challenge with a published key', found);

  await ctx.close();
  assert.deepEqual([...new Set(found)], [], 'no testnet and no owner name in the visible text');
};

export default run;

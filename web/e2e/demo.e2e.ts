// The replay demo in a real browser (AIR-246, check 2): the three acts at 375x667 and 1440x900, every request on the page's own host, the
// banner, the real approval card fed by recorded views, the replay approve, the recorded tampered approve, and the clip audit at 320, 375 and
// 390 px on each act. Run: pnpm -C web e2e demo
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { RequestView } from '@airlock/runtime/chain-types';
import { approveArgs } from '../src/approvals/cardModel.ts';
import { clipAudit } from './audit.ts';
import { checkLanding, checkTry } from './site.ts';
import { FIXTURE_DIR } from './demo.setup.ts';
import type { E2E } from './types.ts';

const json = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(FIXTURE_DIR, ...parts), 'utf8')) as T;
type Golden = { txs: { hash: string; url: string }[] };
const u01 = json<Golden>('golden', 'u01.json');
const approveGolden = json<Golden>('golden', 'b01-approve.json');
const tamperGolden = json<Golden>('golden', 'tamper.json');
const recording = json<{ entries: { method: string; args: { id?: string }; result: unknown }[] }>('chain', 'b01-escalate.json');
const view = recording.entries.find((e) => e.method === 'get_request' && e.args.id === '8')?.result as RequestView;
const world = readFileSync(join(FIXTURE_DIR, '..', '..', '..', '..', 'fixtures', 'world.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as { id: string; kind: string; request?: string });
const ownerWords = (id: string): string => world.find((r) => r.kind === 'scenario' && r.id === id)?.request ?? '';

const id = (testId: string, page: Page) => page.locator(`[data-testid="${testId}"]`);
const bodyText = (page: Page): Promise<string> => page.locator('body').innerText();

async function actTrace(page: Page, act: 'u01' | 'b01'): Promise<void> {
  await id(`act-${act}`, page).click();
  await id('trace-end', page).waitFor();
}

async function checkAct1(page: Page): Promise<void> {
  await id('act-u01', page).click();
  await id('trace-end', page).waitFor();
  assert.ok((await id('replay-banner', page).innerText()).includes('Replay of recorded run u01'), 'act 1 banner');
  assert.equal(await id('act-title', page).innerText(), 'Act 1 Invoice paid');
  assert.equal(await id('owner-words', page).innerText(), ownerWords('U01'));
  const stamp = id('verdict-stamp', page);
  assert.equal(await stamp.count(), 1);
  assert.equal(await stamp.getAttribute('data-state'), 'allowed');
  assert.ok((await stamp.innerText()).includes('ALLOWED'));
  assert.ok((await id('trace-list', page).innerText()).includes('4.2 NEAR'), 'the amount carries its symbol');
  assert.equal(await id('tx-link', page).getAttribute('data-hash'), u01.txs[0]?.hash);
  assert.equal(await id('tx-link', page).getAttribute('href'), u01.txs[0]?.url);
}

async function checkAct2(page: Page): Promise<void> {
  await actTrace(page, 'b01');
  const args = approveArgs(view);
  assert.ok((await id('replay-banner', page).innerText()).includes('Replay of recorded run b01-escalate'), 'act 2 banner');
  assert.equal(await id('act-title', page).innerText(), 'Act 2 Correction held');
  assert.equal(await id('owner-words', page).innerText(), ownerWords('B01'));
  const stamps = await page.locator('[data-testid="trace-list"] [data-testid="verdict-stamp"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-state')));
  assert.deepEqual(stamps, ['held']);
  assert.ok((await page.locator('[data-testid="trace-list"] [data-testid="verdict-stamp"]').innerText()).includes('HELD FOR YOU'));
  await id('card-title', page).waitFor();
  assert.equal(await id('card-title', page).innerText(), `Pay 9.4 NEAR to ${view.payee}?`);
  for (const name of ['to', 'asset', 'amount', 'why', 'book'] as const) assert.equal(await id(`arg-${name}`, page).textContent(), args[name], `arg-${name}`);
  assert.equal(await id('reason', page).innerText(), 'This amount is more than is left in the task you signed.');
  assert.equal(await id('replay-label', page).innerText(), 'Replay: no wallet is used');
  const text = await bodyText(page);
  assert.ok(!text.includes('4.2 NEAR'), 'the April invoice never appears in act 2');
  assert.ok(text.includes('9.4'), 'the held request is the 9.4 NEAR payment');
  assert.equal(await page.locator('[data-testid="owner-words"]').count(), 1);
  assert.deepEqual(await clipAudit(page), [], 'clip audit, act 2');

  // Reject is not part of the recording, and says so
  await id('reject', page).click();
  await id('replay-note', page).waitFor();
  assert.equal(await id('replay-note', page).innerText(), 'Reject is not part of this recording');

  // the replay approve: the same card and sheet as live, the recorded transaction
  await id('open-approve', page).click();
  await id('confirm-approve', page).click();
  await page.locator('[data-testid="card"] [data-testid="verdict-stamp"][data-state="approved"]').waitFor();
  assert.ok((await page.locator('[data-testid="card"] [data-testid="verdict-stamp"]').innerText()).includes('APPROVED BY YOU'));
  assert.equal(await id('approve-link', page).getAttribute('data-hash'), approveGolden.txs[0]?.hash);
  assert.equal(await id('approve-link', page).getAttribute('href'), approveGolden.txs[0]?.url);
  assert.ok((await id('card-status', page).innerText()).includes(approveGolden.txs[0]?.hash ?? 'missing'));
}

async function checkAct3(page: Page): Promise<void> {
  await id('act-tamper', page).click();
  await id('tamper-result', page).waitFor();
  assert.ok((await id('replay-banner', page).innerText()).includes('Replay of recorded run tamper'), 'act 3 banner');
  assert.equal(await id('act-title', page).innerText(), 'Act 3 Tampered approval');
  assert.equal(await id('tamper-failure', page).innerText(), 'approve rejected: WrongAmount');
  assert.equal(await id('tamper-link', page).getAttribute('data-hash'), tamperGolden.txs[0]?.hash);
  assert.ok((await id('tamper-result', page).innerText()).includes('stayed pending'));
  assert.deepEqual(await clipAudit(page), [], 'clip audit, act 3');
}

const run: E2E = async ({ page, baseUrl }) => {
  const hosts = new Set<string>();
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:') hosts.add(url.hostname);
  });
  const origin = new URL(baseUrl).hostname;

  for (const viewport of [{ width: 375, height: 667 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseUrl}/replay`);
    await id('replay-banner', page).waitFor();
    assert.ok((await id('replay-banner', page).innerText()).includes('Replay of recorded run'), `banner at ${viewport.width}`);
    assert.equal(await page.locator('[data-testid="login-connect"]').count(), 0, 'no wallet login in replay');
    await checkAct1(page);
    assert.deepEqual(await clipAudit(page), [], `clip audit, act 1 at ${viewport.width}`);
    await checkAct2(page);
    await checkAct3(page);
    await page.setViewportSize(viewport);
  }

  // AIR-311: the landing and the Try page under the preview server's nonce policy (the wasm compiles under 'wasm-unsafe-eval')
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkLanding(page, baseUrl);
  await checkTry(page, baseUrl);
  assert.deepEqual(await clipAudit(page), [], 'clip audit, try');

  for (const host of hosts) assert.ok(host === '127.0.0.1' || host === 'localhost', `a request went to ${host}`);
  assert.ok(hosts.has(origin), 'the page made requests to its own origin');
};

export default run;

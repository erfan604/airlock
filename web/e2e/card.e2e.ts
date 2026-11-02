// The approval card in a real browser (AIR-181), on both fixture routes at 375 x 667 (the first screen of a small phone with the
// browser toolbars). It checks what a server render cannot: focus, geometry, the pinned bar, the sheet and the failure counter.
// Checks 3 and 6 of the ticket. Run: pnpm -C web e2e card
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';
import type { RequestView } from '@airlock/runtime/chain-types';
import { approveArgs } from '../src/approvals/cardModel.ts';
import correction from '../fixtures/card-correction.json' with { type: 'json' };
import live from '../fixtures/card-correction-live.json' with { type: 'json' };
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const VIEWPORT = { width: 375, height: 667 } as const;
const TITLE = 'Pay 9.4 NEAR to near:acct-firm.near?';

const ROUTES = [
  { path: '/fixtures/card-correction', data: correction, sentence: 'The amount came from email and is over the 5 NEAR cap you set for near:acct-firm.near.' },
  { path: '/fixtures/card-correction-live', data: live, sentence: 'This amount is more than is left in the task you signed.' },
] as const;

const id = (testId: string, page: Page): Locator => page.locator(`[data-testid="${testId}"]`);

async function box(loc: Locator, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await loc.first().boundingBox();
  assert.ok(b, `${what} has no box`);
  return b;
}

const focused = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
const stored = (page: Page, key: string): Promise<string | null> => page.evaluate((k) => sessionStorage.getItem(k), key);

async function audit(page: Page, what: string): Promise<void> {
  const messages = await clipAudit(page);
  assert.deepEqual(messages, [], `clip audit, ${what}`);
  await page.setViewportSize(VIEWPORT);
}

async function openSheet(page: Page): Promise<void> {
  await id('open-approve', page).click();
  await id('confirm-approve', page).waitFor();
}

async function checkRoute(page: Page, baseUrl: string, route: (typeof ROUTES)[number]): Promise<void> {
  const view = route.data.view as RequestView;
  const args = approveArgs(view);
  const key = `airlock:approve:v1:testnet:airlock-policy.testnet:${args.id}`;
  const where = route.path;

  await page.setViewportSize(VIEWPORT);
  await page.goto(`${baseUrl}${route.path}`, { waitUntil: 'networkidle' });
  await id('card-title', page).waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));

  // the title, the five arguments and the reason sentence
  assert.equal(await id('card-title', page).innerText(), TITLE, `${where} title`);
  for (const name of ['to', 'asset', 'amount', 'why', 'book'] as const) {
    assert.equal(await id(`arg-${name}`, page).textContent(), args[name], `${where} arg-${name}`);
  }
  assert.equal(await id('reason', page).innerText(), route.sentence, `${where} reason`);
  assert.equal(await id('card-ref', page).innerText(), `Request #${args.id}`);

  // Reject holds the focus, and nothing that approves exists yet except the outlined opener
  assert.equal(await focused(page), 'reject', `${where} Reject is focused`);
  assert.equal(await id('confirm-approve', page).count(), 0, `${where} no confirm before the sheet`);
  assert.equal(await id('open-approve', page).count(), 1);
  assert.equal(await id('alert', page).count(), 0);

  // geometry at 375 x 667
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 375, `${where} scrollWidth`);
  const reject = await box(id('reject', page), 'Reject');
  assert.ok(reject.y >= 0 && reject.y + reject.height <= VIEWPORT.height, `${where} Reject inside the viewport: ${JSON.stringify(reject)}`);
  assert.ok(reject.x >= 0 && reject.x + reject.width <= VIEWPORT.width);
  const rows = await id('manifest-row', page).evaluateAll((els) => els.map((el) => el.getAttribute('data-name')));
  assert.deepEqual(rows, ['AMOUNT', 'TO', 'BECAUSE'], `${where} offender first`);
  const offender = await box(page.locator('[data-testid="manifest-row"][data-name="AMOUNT"]'), 'the offender row');
  assert.ok(offender.y >= 60 && offender.y <= 400, `${where} the offender row starts ${offender.y} px from the top`);
  const chip = await box(id('source-chip', page), 'source chip');
  const bar = await box(id('card-bar', page), 'pinned bar');
  assert.ok(chip.y + chip.height <= bar.y, `${where} the source chip is above the pinned bar on the first screen`);
  assert.ok(Math.abs(bar.y + bar.height - VIEWPORT.height) <= 1, `${where} the bar is pinned to the bottom`);

  // one scroll (a page down) and the bar covers neither the source chip nor the specimen
  await page.evaluate((h) => window.scrollBy(0, h), VIEWPORT.height - Math.round(bar.height));
  const barAfter = await box(id('card-bar', page), 'pinned bar after the scroll');
  for (const what of ['source-chip', 'specimen']) {
    const b = await box(id(what, page), what);
    const covered = b.y < barAfter.y + barAfter.height && b.y + b.height > barAfter.y;
    assert.equal(covered, false, `${where} after one scroll the bar covers ${what}: ${JSON.stringify({ b, barAfter })}`);
  }
  const specimen = await box(id('specimen', page), 'specimen');
  assert.ok(specimen.y >= 0 && specimen.y < barAfter.y, `${where} the specimen is on screen after one scroll: ${specimen.y}`);
  await page.evaluate(() => window.scrollTo(0, 0));

  // check 6: the clip audit at 320, 375 and 390 in the idle state
  await audit(page, `${where} idle`);

  // the sheet: Reject first and focused, confirm exists only here, the card behind it is inert
  await openSheet(page);
  assert.equal(await focused(page), 'sheet-reject', `${where} the sheet focuses Reject`);
  assert.equal(await id('sheet-title', page).innerText(), 'Approve 9.4 NEAR to near:acct-firm.near?');
  const order = await page.locator('[data-testid="sheet"] button').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  assert.deepEqual(order, ['sheet-reject', 'confirm-approve', 'sheet-cancel']);
  assert.equal(await page.locator('.card-body').getAttribute('inert'), '', 'the card behind the sheet is inert');
  await audit(page, `${where} sheet open`);

  // cancelling is not a failure
  await id('sheet-cancel', page).click();
  await id('confirm-approve', page).waitFor({ state: 'detached' });
  assert.equal(await focused(page), 'reject', `${where} Reject has the focus back`);
  assert.equal(await stored(page, key), null, `${where} cancel stores nothing`);

  // first failure (the wallet): the card says so and Approve stays
  await openSheet(page);
  await id('confirm-approve', page).click();
  await id('card-notice', page).waitFor();
  assert.ok((await id('card-notice', page).innerText()).includes('The previous approval attempt failed'), `${where} failed(1) notice`);
  assert.equal(await id('open-approve', page).count(), 1);
  assert.equal(await id('alert', page).count(), 0);
  assert.equal(await stored(page, key), '1', `${where} counter after one failure`);

  // second failure (the contract): both approve buttons are gone and an alert names the refusal
  await openSheet(page);
  await id('confirm-approve', page).click();
  await id('alert', page).waitFor();
  assert.ok((await id('alert', page).innerText()).includes('approve rejected: FixtureContractRefused'), `${where} alert text`);
  assert.equal(await id('open-approve', page).count(), 0, `${where} no opener after two failures`);
  assert.equal(await id('confirm-approve', page).count(), 0);
  assert.equal(await id('reject', page).count(), 1, 'Reject stays');
  assert.equal(await stored(page, key), '2', `${where} counter after two failures`);
  await audit(page, `${where} failed(2)`);

  // the counter belongs to the card: a reload keeps the approve path closed
  await page.reload({ waitUntil: 'networkidle' });
  await id('alert', page).waitFor();
  assert.equal(await id('open-approve', page).count(), 0, `${where} reload keeps failed(2)`);
  assert.ok((await id('alert', page).innerText()).includes('approve rejected: unknown'));
}

const run: E2E = async ({ page, baseUrl }) => {
  for (const route of ROUTES) await checkRoute(page, baseUrl, route);
};

export default run;

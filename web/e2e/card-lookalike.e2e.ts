// The book diff and the forcing step in a real browser (AIR-190), on both new-payee fixture routes at 375 x 667. It checks what a server
// render cannot: that each caret sits under the character it marks, that the keys are shown in full without a horizontal scroll, and that
// Approve stays disabled until the owner types the distinctive end of the recipient. Run: pnpm -C web e2e card-lookalike
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';
import { checkLookalike } from '@airlock/runtime/dsl';
import lookalike from '../fixtures/card-lookalike.json' with { type: 'json' };
import newHex from '../fixtures/card-new-hex.json' with { type: 'json' };
import { forcingTarget } from '../src/approvals/forcing.ts';
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const VIEWPORT = { width: 375, height: 667 } as const;

const ROUTES = [
  { path: '/fixtures/card-lookalike', data: lookalike, wrong: 'estnet' },
  { path: '/fixtures/card-new-hex', data: newHex, wrong: 'estnet' },
] as const;

const id = (testId: string, page: Page): Locator => page.locator(`[data-testid="${testId}"]`);

const texts = (loc: Locator): Promise<string[]> => loc.evaluateAll((els) => els.map((el) => el.textContent ?? ''));

/** The left edge of character `i` of the first text node under each element with this test id, per chunk. */
async function charLefts(page: Page, testId: string, index: number, chunk: number): Promise<number | null> {
  return page.evaluate(
    ([t, i, c]) => {
      const el = document.querySelectorAll(`[data-testid="${t}"]`)[c as number];
      const node = el?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return null;
      const range = document.createRange();
      range.setStart(node, i as number);
      range.setEnd(node, (i as number) + 1);
      const rect = range.getBoundingClientRect();
      return rect.width === 0 ? null : rect.left;
    },
    [testId, index, chunk] as const,
  );
}

async function checkRoute(page: Page, baseUrl: string, route: (typeof ROUTES)[number]): Promise<void> {
  const where = route.path;
  const payee = route.data.view.payee;
  const r = checkLookalike(payee, route.data.bookKeys);
  assert.ok(r, `${where}: the detector flags the fixture payee`);

  await page.setViewportSize(VIEWPORT);
  await page.goto(`${baseUrl}${route.path}`, { waitUntil: 'networkidle' });
  await id('card-title', page).waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));

  // both keys in full, joined across the chunks, and nothing wider than the screen
  assert.deepEqual([(await texts(id('book-diff-book', page))).join('')], [r.nearest], `${where} the book key in full`);
  assert.deepEqual([(await texts(id('book-diff-proposed', page))).join('')], [payee], `${where} the proposed key in full`);
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 375, `${where} scrollWidth`);

  // carets: the text has a ^ exactly at the differing indexes, and in the browser each one sits under its character
  const carets = await texts(id('book-diff-caret', page));
  const joined = carets.join('');
  assert.deepEqual(
    [...joined].flatMap((c, i) => (c === '^' ? [i] : [])),
    r.differingIndexes,
    `${where} caret positions`,
  );
  const width = carets[0]?.length ?? 0;
  assert.ok(width > 0);
  for (const at of r.differingIndexes) {
    const chunk = Math.floor(at / width);
    const col = at % width;
    const caretX = await charLefts(page, 'book-diff-caret', col, chunk);
    const keyX = await charLefts(page, 'book-diff-proposed', col, chunk);
    assert.ok(caretX !== null && keyX !== null, `${where} index ${at} has a box`);
    assert.ok(Math.abs(caretX - keyX) < 0.5, `${where} caret ${at} is ${caretX} and its character ${keyX}`);
    const bookX = await charLefts(page, 'book-diff-book', col, chunk);
    assert.ok(bookX !== null && Math.abs(bookX - keyX) < 0.5, `${where} the book line is on the same column at ${at}`);
  }
  const sentence = await id('book-diff-sentence', page).innerText();
  assert.ok(sentence.startsWith(`${r.distance} characters differ from your book entry `), `${where} sentence: ${sentence}`);
  assert.equal(await id('magnitude', page).count(), 1, `${where} the magnitude line`);

  // the sheet: Approve exists, is disabled, stays disabled after the wrong text, and enables after the target
  await id('open-approve', page).click();
  await id('confirm-approve', page).waitFor();
  const input = id('forcing-input', page);
  await input.waitFor();
  assert.equal(await input.getAttribute('autocomplete'), 'off');
  assert.ok((await id('forcing-label', page).innerText()).startsWith('Type the last 6 characters of'), `${where} label`);
  assert.equal(await id('confirm-approve', page).isDisabled(), true, `${where} disabled when the sheet opens`);
  await input.fill(route.wrong);
  assert.equal(await id('confirm-approve', page).isDisabled(), true, `${where} still disabled after ${route.wrong}`);
  await input.fill(forcingTarget(payee));
  assert.equal(await id('confirm-approve', page).isDisabled(), false, `${where} enabled after the target`);
  const sheet = await id('sheet', page).boundingBox();
  assert.ok(sheet && sheet.y >= 0 && sheet.y + sheet.height <= VIEWPORT.height + 1, `${where} the sheet fits the screen: ${JSON.stringify(sheet)}`);
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 375, `${where} scrollWidth with the sheet open`);
  assert.deepEqual(await clipAudit(page), [], `${where} clip audit with the sheet open`);

  // going back clears the typing: the next opening starts empty and disabled again
  await page.setViewportSize(VIEWPORT);
  await id('sheet-cancel', page).click();
  await id('open-approve', page).click();
  await id('confirm-approve', page).waitFor();
  assert.equal(await id('forcing-input', page).inputValue(), '', `${where} the input is empty again`);
  assert.equal(await id('confirm-approve', page).isDisabled(), true, `${where} disabled again`);
}

const run: E2E = async ({ page, baseUrl }) => {
  for (const route of ROUTES) await checkRoute(page, baseUrl, route);
};

export default run;

// The `components` route in a real browser (AIR-183): counts, the hostile Specimen, the expand button. Run: pnpm -C web e2e components
import assert from 'node:assert/strict';
import type { E2E } from './types.ts';

const run: E2E = async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/fixtures/components`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="fixture-components"]');

  // 15 labels at two sizes, plus one seal with a source, plus the seals of the manifest rows and of the specimen captions
  assert.ok((await page.locator('[data-testid="seal"]').count()) >= 31);
  assert.equal(await page.locator('[data-testid="verdict-stamp"]').count(), 8);
  // 8 states at 3 sizes, plus the door inside each of the 8 stamps
  assert.equal(await page.locator('[data-testid="door"]').count(), 8 * 3 + 8);
  // the sprite works: a door has a drawn shape, not an empty box
  const box = await page.locator('[data-testid="door"][data-state="blocked"]').first().boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);

  // the offender-first manifest puts AMOUNT on top, the canonical one keeps TO first
  const orders = await page.locator('[data-testid="manifest"]').evaluateAll((els) =>
    els.map((el) => [...el.querySelectorAll('[data-testid="manifest-row"]')].map((r) => r.getAttribute('data-name'))),
  );
  assert.deepEqual(orders[0], ['TO', 'AMOUNT', 'BECAUSE']);
  assert.deepEqual(orders[1], ['AMOUNT', 'TO', 'BECAUSE']);

  // hostile text is text: no element was created from it and the invisible characters are visible tokens
  const hostile = page.locator('[data-testid="specimen-hostile"]');
  assert.equal(await hostile.locator('script, b, i').count(), 0);
  const shown = await hostile.innerText();
  assert.ok(shown.includes('<script>alert(1)</script>'));
  assert.ok(shown.includes('&lt;b&gt;bold&lt;/b&gt;'));
  assert.ok(shown.includes('<U+200B>') && shown.includes('<U+202E>') && shown.includes('<U+E0070>'));
  assert.equal(shown.includes('\u200B'), false);

  // the long body: collapsed at 240 characters, expanded to 2,000, then the rest is stated
  const long = page.locator('[data-testid="specimen-long"]');
  const collapsed = await long.locator('.specimen-text').allInnerTexts();
  assert.ok(collapsed.join('\n').length <= 240);
  await long.locator('[data-testid="specimen-expand"]').click();
  const expanded = await long.locator('.specimen-text').allInnerTexts();
  assert.equal(expanded.join('\n').length, 2000);
  assert.ok((await long.locator('[data-testid="specimen-more"]').innerText()).includes('1,000 more characters were not shown'));
  assert.equal(await long.locator('[data-testid="specimen-expand"]').count(), 0);
};

export default run;

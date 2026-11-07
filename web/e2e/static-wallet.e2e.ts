// AIR-318: the hosted approvals page against the real network under the static Content-Security-Policy: the policy is read from the live testnet RPC,
// the real NEAR Connect selector opens, lists exactly the pinned wallet and opens its executor frame. It signs nothing. Needs network.
// The harness fails on any console error, which is how Chromium reports a CSP violation. Run: pnpm -C web e2e static-wallet
import assert from 'node:assert/strict';
import snapshot from '../src/wallet/manifest-snapshot.json' with { type: 'json' };
import type { E2E } from './types.ts';

const run: E2E = async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}/approvals`);
  await page.locator('[data-testid="access"]').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('[data-testid="access"]').getAttribute('data-access'), 'signed-out');
  // AIR-323 H1: every way to close the selector gives the button back. Escape (the library has no handler for it), then a click on the backdrop.
  const button = page.locator('[data-testid="static-connect"]');
  const recovered = async (how: string): Promise<void> => {
    await page.locator('.hot-connector-popup').waitFor({ state: 'detached', timeout: 5_000 });
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="static-connect"]') as HTMLButtonElement | null;
      return b !== null && !b.disabled && b.textContent === 'Connect wallet';
    }, undefined, { timeout: 5_000 });
    assert.ok(await button.isEnabled(), `${how}: the button is usable again`);
  };
  await button.click();
  await page.locator('.connect-item').first().waitFor({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await recovered('Escape');
  await button.click();
  await page.locator('.connect-item').first().waitFor({ timeout: 15_000 });
  await page.locator('.modal-container').click({ position: { x: 5, y: 5 } });
  await recovered('backdrop');
  await button.click();
  await page.locator('.connect-item').first().waitFor({ timeout: 15_000 });
  const ids = await page.locator('.connect-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.type ?? ''));
  assert.deepEqual(ids, snapshot.wallets.map((w) => w.id), 'the selector lists exactly the snapshot wallet');
  await page.locator('.connect-item').first().click();
  await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 20_000 });
  await page.waitForTimeout(3000);
};

export default run;

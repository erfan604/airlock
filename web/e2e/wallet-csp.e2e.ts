// NEAR Connect under the console CSP (AIR-182 check 3): the real library with the pinned one-wallet snapshot, in the real preview server.
// It needs network (the wallet executor is fetched from its own host). It opens the selector and the wallet frame and signs nothing.
// The harness fails on any console error, which is how Chromium reports a CSP violation, and on any page error. Run: pnpm -C web e2e wallet-csp
import assert from 'node:assert/strict';
import { buildCsp, defaultCspInputs } from '../csp.ts';
import snapshot from '../src/wallet/manifest-snapshot.json' with { type: 'json' };
import type { E2E } from './types.ts';

const run: E2E = async ({ page, baseUrl }) => {
  const res = await page.goto(`${baseUrl}/fixtures/wallet-connect`, { waitUntil: 'networkidle' });
  const header = res?.headers()['content-security-policy'];
  const nonce = await page.evaluate(() => (document.querySelector('meta[property="csp-nonce"]') as HTMLMetaElement | null)?.nonce ?? '');
  assert.ok(nonce !== '' && !nonce.includes('__AIRLOCK'), `the page has a served csp-nonce meta tag (got "${nonce}")`);
  assert.equal(header, buildCsp({ ...defaultCspInputs(), nonce }), 'the document header equals buildCsp with the nonce of the page');

  await page.locator('[data-testid="wallet-open"]').click();
  await page.locator('.connect-item').first().waitFor({ timeout: 15_000 });
  const ids = await page.locator('.connect-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.type ?? ''));
  assert.deepEqual(ids, snapshot.wallets.map((w) => w.id), 'the selector lists exactly the snapshot wallet');
  assert.ok(!ids.includes('nightly-wallet'), 'Nightly is not offered');

  await page.locator('.connect-item').first().click();
  await page.locator('iframe').first().waitFor({ state: 'attached', timeout: 20_000 });
  assert.equal(await page.locator('iframe').count(), 1, 'one wallet iframe appears');
  // give the executor time to load what it loads: a blocked request is logged as a console error, which the harness turns into a failure
  await page.waitForTimeout(3000);
};

export default run;

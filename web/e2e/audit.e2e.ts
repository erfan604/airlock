// Proof that the clip audit can fail and why it never reads innerWidth (AIR-183). Run: pnpm -C web e2e audit
import assert from 'node:assert/strict';
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const run: E2E = async ({ page, baseUrl }) => {
  // the planted failure: the audit-bad route reports an overflowX message in the harness's non-mobile 375 px context
  await page.goto(`${baseUrl}/fixtures/audit-bad`, { waitUntil: 'networkidle' });
  const messages = await clipAudit(page, [375]);
  assert.ok(messages.some((m) => m.startsWith('375px overflowX ')), `expected an overflowX message, got ${JSON.stringify(messages)}`);

  // the same route in a context created with isMobile: Chromium makes innerWidth follow the content, so the helper must throw
  const browser = page.context().browser();
  assert.ok(browser, 'the page has no browser');
  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true });
  try {
    const p = await mobile.newPage();
    await p.goto(`${baseUrl}/fixtures/audit-bad`, { waitUntil: 'networkidle' });
    await assert.rejects(clipAudit(p, [375]), /viewport not honored/);
  } finally {
    await mobile.close();
  }

  // a clean route stays clean in the non-mobile context. `/` probes GET /session to learn the mode (ReplayAware); the preview proxy
  // would answer 502 with no runtime, so the probe is answered here like a live server with no owner session
  await page.route('**/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"accountId":null}' }));
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  assert.deepEqual(await clipAudit(page), []);
};

export default run;

// The plan preview in a real browser (AIR-185): S30 (a runtime that sends bounds and a preview of its own), the happy path with a signature
// verified in the page, the route without a registered key, the pinned button at 375 x 667 and the clip audit on every route of the ticket.
// Run: pnpm -C web e2e preview
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { checkPlan, ownerTaskBorsh, planSha256 } from '@airlock/runtime/dsl';
import type { OwnerTask } from '@airlock/runtime/dsl';
import data from '../fixtures/preview-u01.json' with { type: 'json' };
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const VIEWPORT = { width: 375, height: 667 } as const;
const RUNTIME_DIFFERS = "Runtime preview differs from your device's preview. Not signing.";

async function audit(page: Page, what: string): Promise<void> {
  assert.deepEqual(await clipAudit(page), [], `clip audit, ${what}`);
  await page.setViewportSize(VIEWPORT);
}

const hexBytes = (h: string): number[] => (h.match(/../g) ?? []).map((p) => parseInt(p, 16));

const run: E2E = async ({ page, baseUrl }) => {
  await page.setViewportSize(VIEWPORT);

  // S30: the runtime double answers POST /tasks with a correct plan and hash but bounds and a preview that differ from the console's own
  let confirms = 0;
  let drafts = 0;
  await page.addInitScript(() => {
    window.__s30Double = true;
  });
  await page.route('**/tasks', async (route) => {
    drafts += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        draftId: 'double-1',
        planSha256: planSha256(checkPlan(data.plan)),
        plan: data.plan,
        bounds: [{ payee_key: 'near:accountant.testnet', max_total: '50000000000000000000000000' }],
        preview: ['accountant, amount from the email, up to 50 NEAR'],
      }),
    });
  });
  await page.route('**/tasks/*/confirm', async (route) => {
    confirms += 1;
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`${baseUrl}/fixtures/preview-s30`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="refusal"]').waitFor();
  assert.equal(await page.locator('[data-testid="refusal"]').getAttribute('data-code'), 'RuntimeDiffers');
  assert.ok((await page.locator('[data-testid="refusal"]').innerText()).includes(RUNTIME_DIFFERS), 'the refusal block shows the RuntimeDiffers text');
  assert.equal(await page.locator('[data-testid="confirm-run"]').count(), 0, 'no confirm-run under S30');
  assert.equal(drafts, 1, 'one draft request');
  assert.equal(confirms, 0, 'no request to /tasks/*/confirm under S30');
  await audit(page, 'preview-s30 refusal');

  // happy path: one confirm, a signature that verifies against the key over the task bytes
  await page.goto(`${baseUrl}/fixtures/preview-u01`, { waitUntil: 'networkidle' });
  const confirm = page.locator('[data-testid="confirm-run"]');
  await confirm.waitFor();
  assert.equal(await confirm.isDisabled(), false, 'the key is registered, so confirm is enabled');
  assert.equal(await page.locator('[data-testid="preview-row"]').count(), 1);
  assert.equal(await page.locator('[data-testid="card-line"]').count(), 7);
  assert.equal(await page.locator('[data-testid="key-register"]').count(), 0);
  const amount = await page.locator('[data-testid="preview-amount"]').innerText();
  assert.equal(amount, 'up to 5 NEAR');
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const box = await confirm.boundingBox();
  assert.ok(box, 'confirm-run has a box');
  assert.ok(box.x >= 0 && box.x + box.width <= VIEWPORT.width && box.y >= 0 && box.y + box.height <= VIEWPORT.height, `confirm-run is inside 375 x 667: ${JSON.stringify(box)}`);
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= VIEWPORT.width, 'no horizontal scroll');
  await audit(page, 'preview-u01');

  await confirm.click();
  await page.locator('[data-testid="fixture-confirmed"]').waitFor();
  const recorded = await page.evaluate(() => ({ calls: window.__previewConfirms ?? [], key: window.__previewPublicKeyRaw ?? '' }));
  assert.equal(recorded.calls.length, 1, 'exactly one confirm');
  const call = recorded.calls[0];
  assert.ok(call);
  const bytes = [...ownerTaskBorsh(call.task as OwnerTask)];
  const valid = await page.evaluate(
    async ({ keyHex, sigB64, msg }) => {
      const key = await crypto.subtle.importKey('raw', new Uint8Array(keyHex), { name: 'Ed25519' }, false, ['verify']);
      const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
      return crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new Uint8Array(msg));
    },
    { keyHex: hexBytes(recorded.key), sigB64: call.sig, msg: bytes },
  );
  assert.equal(valid, true, 'the signature verifies over the task bytes');
  assert.equal(call.task.expires_ms - call.task.issued_ms, 900_000);

  // no registered key: confirm is disabled and the command is shown
  await page.goto(`${baseUrl}/fixtures/preview-nokey`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="key-register"]').waitFor();
  assert.equal(await page.locator('[data-testid="confirm-run"]').isDisabled(), true);
  assert.ok((await page.locator('[data-testid="key-command"]').innerText()).includes('near contract call-function'));
  assert.equal(await page.locator('[data-testid="recheck-key"]').count(), 1);
  await audit(page, 'preview-nokey');
};

export default run;

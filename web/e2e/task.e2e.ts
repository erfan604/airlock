// The Task page in a real browser (AIR-184): the live trace from recorded events through the same-origin route, the verdict stamps, a dropped
// stream that reconnects with Last-Event-ID and no duplicate rows, the 300 row cap, a hostile body that stays inert, and the clip audit at
// 320, 375 and 390 px. Run: pnpm -C web e2e task
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { clipAudit } from './audit.ts';
import { resumeHeaders } from './task.setup.ts';
import type { E2E } from './types.ts';

const rows = (page: Page): Promise<number> => page.locator('[data-testid="trace-row"]').count();

async function open(page: Page, baseUrl: string, name: string): Promise<void> {
  await page.goto(`${baseUrl}/fixtures/${name}`);
  await page.locator('[data-testid="trace-end"]').waitFor();
}

async function audit(page: Page, what: string): Promise<void> {
  assert.deepEqual(await clipAudit(page), [], `clip audit, ${what}`);
}

const run: E2E = async ({ page, baseUrl }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    window.__traceLive = true;
  });

  // `/` without a session: the login button and nothing else. The session read answers 200 with no account (a 401 would be logged by Chromium
  // as a console error, which this harness fails on), and the gate reads that as signed out.
  await page.route('**/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(`${baseUrl}/`);
  await page.locator('[data-testid="login-connect"]').waitFor();
  assert.equal(await page.locator('[data-testid="task-view"]').count(), 0, 'no task view without a session');
  assert.equal(await page.locator('[data-testid="instruction-input"]').count(), 0);
  await audit(page, '/ without a session');

  // `/` idle, with a session
  await page.unroute('**/session');
  await page.route('**/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"accountId":"owner.testnet"}' }));
  await page.goto(`${baseUrl}/`);
  await page.locator('[data-testid="task-view"]').waitFor();
  assert.equal(await page.locator('[data-testid="trace-list"]').count(), 0, 'no trace before a run');
  assert.ok(await page.locator('[data-testid="submit-task"]').isDisabled(), 'submit is disabled for an empty instruction');
  await page.locator('[data-testid="instruction-input"]').fill('Pay the April invoice from my accountant.');
  assert.ok(await page.locator('[data-testid="submit-task"]').isEnabled());
  await audit(page, '/ idle');

  // U01: seven rows, an ALLOWED stamp, the amount with its symbol, no review link
  await open(page, baseUrl, 'task-allowed');
  assert.equal(await rows(page), 7);
  const allowed = page.locator('[data-testid="verdict-stamp"]');
  assert.equal(await allowed.count(), 1);
  assert.equal(await allowed.getAttribute('data-state'), 'allowed');
  assert.ok((await allowed.innerText()).includes('ALLOWED'));
  assert.equal(await page.locator('[data-testid="review-link"]').count(), 0);
  assert.ok((await page.locator('[data-testid="trace-list"]').innerText()).includes('4.2 NEAR'), 'the amount carries its symbol');
  assert.equal(await page.locator('[data-testid="trace-end"]').innerText(), 'Run finished');
  assert.ok((await page.locator('[data-testid="specimen"]').count()) >= 1, 'the inbox item is inside a Specimen');
  await audit(page, 'task-allowed');

  // B01: held, with a link to /approvals
  await open(page, baseUrl, 'task-held');
  const held = page.locator('[data-testid="verdict-stamp"]');
  assert.equal(await held.getAttribute('data-state'), 'held');
  assert.ok((await held.innerText()).includes('HELD FOR YOU'));
  const link = page.locator('[data-testid="review-link"]');
  assert.equal(await link.getAttribute('href'), '/approvals');
  assert.equal(await link.innerText(), 'Review request #4');
  await audit(page, 'task-held');

  // hostile: the tag is text, the invisible characters are tokens, nothing was injected
  await open(page, baseUrl, 'task-hostile');
  const shown = await page.locator('.specimen-text').allInnerTexts();
  const all = shown.join('\n');
  assert.ok(all.includes('<img src=x onerror=alert(1)>'), 'the tag string is visible text');
  assert.ok(all.includes('<U+200B>'), 'zero width space token');
  assert.ok(all.includes('<U+202E>'), 'right to left override token');
  assert.equal(await page.evaluate(() => document.querySelector('[data-airlock-probe], img[onerror]')), null, 'nothing injected');
  assert.equal(await page.locator('main img, main b').count(), 0, 'no element made from the text');
  await audit(page, 'task-hostile');

  // a cut stream: the caption appears, the reconnect carries Last-Event-ID and the list has no duplicate row
  resumeHeaders.length = 0;
  await page.goto(`${baseUrl}/fixtures/task-drop`);
  await page.locator('[data-testid="stale-caption"]').waitFor();
  assert.equal(await page.locator('[data-testid="stale-caption"]').innerText(), 'Connection lost, trying again');
  await page.locator('[data-testid="trace-end"]').waitFor();
  assert.equal(await page.locator('[data-testid="stale-caption"]').count(), 0, 'the reconnect clears the caption');
  assert.equal(await rows(page), 7, 'no duplicate row after the reconnect');
  assert.deepEqual(resumeHeaders, ['2'], 'the browser resumed from the last id it saw');

  // 301 events: 300 rows and one collapsed
  await open(page, baseUrl, 'task-long');
  assert.equal(await rows(page), 300);
  const collapsed = page.locator('[data-testid="collapsed-count"]');
  assert.equal(await collapsed.getAttribute('data-count'), '1');
  assert.equal(await collapsed.innerText(), '1 earlier events collapsed');

  // a read-only run: the answer sits in a Specimen and the run ends answered, nothing paid
  await open(page, baseUrl, 'task-readonly');
  assert.equal(await page.locator('[data-testid="trace-row"][data-kind="say"] [data-testid="specimen"]').count(), 1);
  assert.equal(await page.locator('[data-testid="trace-end"]').innerText(), 'Answered, nothing paid');
  assert.equal(await page.locator('[data-testid="verdict-stamp"]').count(), 0);
  await audit(page, 'task-readonly');

  // the whole page on fake deps: type, preview, confirm, then the trace under the same page
  await page.goto(`${baseUrl}/fixtures/task-page`);
  await page.locator('[data-testid="submit-task"]').click();
  await page.locator('[data-testid="confirm-run"]').waitFor();
  await page.locator('[data-testid="confirm-run"]').click();
  await page.locator('[data-testid="trace-end"]').waitFor();
  assert.equal(await page.locator('[data-testid="verdict-stamp"]').getAttribute('data-state'), 'allowed');
  assert.equal(await page.locator('[data-testid="instruction-input"]').count(), 0, 'the form is gone while the run shows');
  await audit(page, 'task page with a trace');
};

export default run;

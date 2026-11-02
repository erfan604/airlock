// The approvals route in a real browser (AIR-182 check 4): fake chain reads, fake evidence and a mocked wallet. One click through the sheet
// sends one transaction with one action; two wallet errors stop the card and show the CLI command; the login gate refuses a wallet; the
// clip audit passes on every route this ticket adds. Run: pnpm -C web e2e approvals
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { RequestView } from '@airlock/runtime/chain-types';
import correction from '../fixtures/card-correction.json' with { type: 'json' };
import { approveArgs } from '../src/approvals/cardModel.ts';
import { APPROVE_PREPAID_TGAS } from '../src/wallet/approve.ts';
import { approveCliCommand } from '../src/wallet/CliPanel.tsx';
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const VIEWPORT = { width: 375, height: 667 } as const;
const CONTRACT = 'airlock-policy.testnet';
const OWNER = 'erfan-airlock.testnet';
const REFUSED = 'This wallet does not show what it signs. Use the wallet the console lists.';

const id = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);

async function audit(page: Page, what: string): Promise<void> {
  assert.deepEqual(await clipAudit(page), [], `clip audit, ${what}`);
  await page.setViewportSize(VIEWPORT);
}

type Call = { receiverId: string; signerId?: unknown; actions: { type: string; params: { methodName: string; args: unknown; gas: string; deposit: string } }[] };

const calls = (page: Page): Promise<Call[]> => page.evaluate(() => (window.__walletCalls ?? []) as unknown as Call[]);

async function openCard(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/fixtures/approvals-live`, { waitUntil: 'networkidle' });
  await id(page, 'card-title').waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));
}

async function approveOnce(page: Page): Promise<void> {
  await id(page, 'open-approve').click();
  await id(page, 'confirm-approve').click();
}

const run: E2E = async ({ page, baseUrl }) => {
  const view = correction.view as RequestView;
  const args = approveArgs(view);
  await page.setViewportSize(VIEWPORT);

  // the card for the 9.4 correction, the reveal words above it and the one-click path
  await openCard(page, baseUrl);
  assert.equal(await id(page, 'card-title').innerText(), 'Pay 9.4 NEAR to near:acct-firm.near?');
  assert.equal(await id(page, 'reveal-instruction').innerText(), 'Tap Show args in Intear and compare the five values');
  assert.equal(await id(page, 'session-account').innerText(), OWNER);
  assert.equal(await page.locator('[data-testid="approvals"] [data-testid="card"]').count(), 1);
  assert.equal(await id(page, 'cli-panel').count(), 0, 'no CLI panel while the wallet works');
  await audit(page, 'approvals-live');

  await approveOnce(page);
  await page.waitForFunction(() => (window.__walletCalls?.length ?? 0) === 1);
  const sent = await calls(page);
  assert.equal(sent.length, 1, 'the mocked wallet is called once');
  const call = sent[0] as Call;
  assert.equal(call.receiverId, CONTRACT);
  assert.equal(call.signerId, undefined);
  assert.equal(call.actions.length, 1, 'one action');
  const action = call.actions[0] as Call['actions'][number];
  assert.equal(action.type, 'FunctionCall');
  assert.equal(action.params.methodName, 'approve');
  assert.equal(action.params.deposit, '1');
  assert.equal(action.params.gas, (BigInt(APPROVE_PREPAID_TGAS) * 1_000_000_000_000n).toString());
  assert.equal(JSON.stringify(action.params.args), JSON.stringify(args));
  await page.locator('[data-testid="card"][data-state="approved"]').waitFor();

  // two wallet errors: the R4-08 alert and the CLI panel with the command of approveCliCommand
  await page.goto('about:blank');
  await openCard(page, baseUrl);
  await page.evaluate(() => {
    sessionStorage.clear();
    window.__walletMode = 'fail';
    window.__walletCalls = [];
  });
  await approveOnce(page);
  await id(page, 'card-notice').waitFor();
  assert.equal(await id(page, 'cli-panel').count(), 0, 'one failure does not show the CLI panel');
  await approveOnce(page);
  await id(page, 'alert').waitFor();
  await id(page, 'cli-panel').waitFor();
  assert.equal((await calls(page)).length, 2, 'two wallet calls');
  assert.equal(await id(page, 'cli-command').innerText(), approveCliCommand(args, { contractId: CONTRACT, ownerId: OWNER }));
  await audit(page, 'approvals-live with the CLI panel');

  // the login gate with a wallet the console refuses
  await page.goto(`${baseUrl}/fixtures/session-gate`, { waitUntil: 'networkidle' });
  await id(page, 'login-connect').waitFor();
  await audit(page, 'session-gate');
  await id(page, 'login-connect').click();
  await id(page, 'login-error').waitFor();
  assert.equal(await id(page, 'login-error').innerText(), REFUSED);
  await audit(page, 'session-gate with the refusal');

  // the real route, in a build without VITE_CONTRACT_ID: it says so instead of showing a blank page
  await page.goto(`${baseUrl}/approvals`, { waitUntil: 'networkidle' });
  await page.locator('main').waitFor();
  await audit(page, '/approvals');
};

export default run;

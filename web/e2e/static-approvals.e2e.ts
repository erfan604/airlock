// AIR-318: /approvals of the static build in a real browser, at 375 and 1440. The chain is a mocked testnet RPC (the recorded policy-v3 views of
// fixtures/chain-policy-v3.json, with the pending request's expiry moved to the future so it can be approved) and the wallet is a stub of the
// NEAR Connect module, so the page code, the card, the static Content-Security-Policy and the approve and reject calls run for real. States:
// pending card before connecting, owner (approve with one wallet call and an explorer link, reject), non-owner (view only), empty and expired.
// Run: pnpm -C web build:static && pnpm -C web e2e static-approvals
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import chain from '../fixtures/chain-policy-v3.json' with { type: 'json' };
import { CREDIT_CARD } from '../src/credit/net.ts';
import { NEAR_RPC } from '../csp.ts';
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const auditDir = join(fileURLToPath(new URL('../', import.meta.url)), 'audit');
const OWNER = chain.get_policy.owner_id;
const HASH = 'H4TCupRbnrqkWe3oxip6oRuB9Tn3aL8YuuiPpDSuNSuf';
const WIDTHS = [{ width: 375, height: 667 }, { width: 1440, height: 900 }] as const;
const id = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]`);

type View = Record<string, unknown>;
const recorded = (JSON.parse(Buffer.from(chain.rpc_get_pending.result.result).toString('utf8')) as View[])[0] as View;

type Mode = { pending: View[]; stateAfterWallet: 'Executing' | 'Rejected' };

async function mockChain(page: Page, mode: () => Mode): Promise<string[]> {
  const hosts: string[] = [];
  const answers: Record<string, unknown> = { get_policy: chain.get_policy, list_assets: chain.list_assets, get_book_entry: chain.get_book_entry, get_ledgers: chain.get_ledgers_no_task, get_book: [] };
  for (const rpc of NEAR_RPC) {
    await page.route(`${rpc}/**`, async (route) => {
      hosts.push(new URL(route.request().url()).host);
      const body = JSON.parse(route.request().postData() ?? '{}') as { params: { method_name: string; args_base64: string } };
      const method = body.params.method_name;
      let value: unknown;
      if (method === 'get_pending') value = mode().pending;
      else if (method === 'get_request') {
        const called = await page.evaluate(() => (window.__walletCalls?.length ?? 0) > 0);
        const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8')) as { id: string };
        value = { ...mode().pending[0], id: args.id, state: called ? mode().stateAfterWallet : 'Pending' };
      } else value = answers[method];
      const bytes = [...Buffer.from(JSON.stringify(value ?? null), 'utf8')];
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result: { result: bytes } }) });
    });
  }
  return hosts;
}

/** A stand-in for the NEAR Connect chunk: `connect()` yields a wallet of the allowed id for `window.__account`; every signed call is recorded. */
const CONNECTOR_STUB = `
export class NearConnector {
  constructor(options) { window.__connectorOptions = options; }
  async connect() {
    return {
      manifest: { id: 'intear-wallet' },
      getAccounts: async () => [{ accountId: window.__account }],
      signAndSendTransaction: async (call) => { (window.__walletCalls ??= []).push(call); return { transaction: { hash: '${HASH}' }, status: { SuccessValue: '' } }; },
    };
  }
  async disconnect() {}
}
// the real chunk is CommonJS behind a default export, which the page reads
export default { NearConnector };
`;

type Call = { receiverId: string; signerId?: unknown; actions: { type: string; params: { methodName: string; args: Record<string, string>; gas: string; deposit: string } }[] };

async function audit(page: Page, what: string): Promise<void> {
  assert.deepEqual(await clipAudit(page, [375, 1440]), [], `clip audit, ${what}`);
}

async function shot(page: Page, name: string, width: number): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.screenshot({ path: join(auditDir, `static-approvals-${name}-${String(width)}.png`), fullPage: true });
}

const run: E2E = async ({ page, baseUrl }) => {
  mkdirSync(auditDir, { recursive: true });
  const fresh: View = { ...recorded, expires_ms: String(Date.now() + 3_600_000), created_ms: String(Date.now() - 120_000) };
  let mode: Mode = { pending: [fresh], stateAfterWallet: 'Executing' };
  const rpcHosts = await mockChain(page, () => mode);
  await page.route('**/assets/build-*.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: CONNECTOR_STUB }));
  const pageHosts = new Set<string>();
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.protocol !== 'data:' && u.protocol !== 'blob:') pageHosts.add(u.host);
  });
  const origin = new URL(baseUrl).host;
  const calls = (): Promise<Call[]> => page.evaluate(() => (window.__walletCalls ?? []) as unknown as Call[]);
  const open = async (account: string): Promise<void> => {
    await page.addInitScript((a) => {
      (window as unknown as { __account: string }).__account = a;
      window.__walletCalls = [];
    }, account);
    await page.goto(`${baseUrl}/approvals`);
    await id(page, 'card-title').waitFor();
  };

  for (const viewport of WIDTHS) {
    await page.setViewportSize(viewport);
    mode = { pending: [fresh], stateAfterWallet: 'Executing' };

    // a pending card read from the chain, before any wallet: the values and the labels of the recorded request, no signing button
    await open(OWNER);
    assert.equal(await id(page, 'approvals-policy').innerText(), 'Held requests on the credit line policy');
    // the hosted page prints the payee short; the wallet block (arg-to) and the signed call below keep the full key
    assert.equal(await id(page, 'card-title').innerText(), 'Pay 9.4 NEAR to accountant.erfan-airlock?');
    assert.equal(await id(page, 'arg-to').textContent(), 'near:accountant.erfan-airlock.testnet');
    assert.equal(await id(page, 'arg-amount').textContent(), '9.4');
    assert.equal(await id(page, 'arg-why').textContent(), 'OverTaskBound');
    assert.equal(await id(page, 'access').getAttribute('data-access'), 'signed-out');
    assert.equal(await id(page, 'open-approve').count(), 0, 'no approve before the owner connects');
    assert.equal(await id(page, 'reject').count(), 0);
    await shot(page, 'signed-out', viewport.width);
    await audit(page, 'signed out');

    // the owner connects: the buttons appear and one approve sends one transaction with the five values and 1 yocto
    await id(page, 'static-connect').click();
    await page.locator('[data-testid="access"][data-access="owner"]').waitFor();
    await id(page, 'reveal-instruction').waitFor();
    await shot(page, 'owner', viewport.width);
    await audit(page, 'owner');
    await id(page, 'open-approve').click();
    await id(page, 'confirm-approve').click();
    await id(page, 'tx-result').waitFor();
    const sent = await calls();
    assert.equal(sent.length, 1, 'one wallet call');
    const call = sent[0] as Call;
    assert.equal(call.receiverId, CREDIT_CARD, 'the wallet signs a call to the policy of the page');
    assert.equal(call.signerId, undefined);
    assert.equal(call.actions.length, 1);
    const action = call.actions[0] as Call['actions'][number];
    assert.equal(action.params.methodName, 'approve');
    assert.equal(action.params.deposit, '1');
    assert.deepEqual(action.params.args, { id: '2', to: 'near:accountant.erfan-airlock.testnet', asset: 'NEAR', amount: '9.4', why: 'OverTaskBound', book: 'in_book' });
    assert.equal(await id(page, 'tx-link').getAttribute('href'), `https://testnet.nearblocks.io/txns/${HASH}`);
    assert.equal(await id(page, 'tx-result').getAttribute('data-hash'), HASH);
    await shot(page, 'approved', viewport.width);
    await audit(page, 'approved');

    // reject is its own call
    mode = { pending: [fresh], stateAfterWallet: 'Rejected' };
    await open(OWNER);
    await id(page, 'static-connect').click();
    await page.locator('[data-testid="access"][data-access="owner"]').waitFor();
    await id(page, 'reject').click();
    await id(page, 'tx-result').waitFor();
    const rejected = (await calls())[0] as Call;
    assert.equal(rejected.actions[0]?.params.methodName, 'reject');
    assert.deepEqual(rejected.actions[0]?.params.args, { id: '2' });
    assert.ok((await id(page, 'tx-result').innerText()).startsWith('Rejected.'));

    // another account: the same card, view only, no button
    mode = { pending: [fresh], stateAfterWallet: 'Executing' };
    await open('someone-else.testnet');
    await id(page, 'static-connect').click();
    await page.locator('[data-testid="access"][data-access="viewer"]').waitFor();
    assert.ok((await id(page, 'access').innerText()).startsWith('View only.'));
    assert.equal(await id(page, 'open-approve').count(), 0);
    assert.equal(await id(page, 'reject').count(), 0);
    assert.deepEqual(await calls(), [], 'a non-owner never reaches the wallet');
    await shot(page, 'viewer', viewport.width);
    await audit(page, 'viewer');

    // nothing pending: the empty state names the command, no invented card
    mode = { pending: [], stateAfterWallet: 'Executing' };
    await page.goto(`${baseUrl}/approvals`);
    await id(page, 'approvals-empty').waitFor();
    assert.ok((await page.locator('[data-testid="approvals"]').innerText()).includes('pnpm demo:live'));
    assert.equal(await id(page, 'card').count(), 0);
    await shot(page, 'empty', viewport.width);
    await audit(page, 'empty');

    // the recorded request is past its expiry: shown, said so, no buttons even for the owner
    mode = { pending: [recorded], stateAfterWallet: 'Executing' };
    await open(OWNER);
    await id(page, 'static-connect').click();
    await page.locator('[data-testid="access"][data-access="owner"]').waitFor();
    await id(page, 'expired').waitFor();
    assert.equal(await id(page, 'open-approve').count(), 0);
    await shot(page, 'expired', viewport.width);
    await audit(page, 'expired');
  }

  // AIR-323: the Approvals tab marks its own page, and an unreadable chain says so without the no-script paragraph
  assert.equal(await page.locator('[data-testid="tab-approvals"][aria-current="page"]').count(), 1);
  assert.equal(await page.locator('[data-testid="tab-replay"][aria-current="page"]').count(), 0);
  const blind = await page.context().browser()?.newContext({ viewport: { width: 1440, height: 900 } });
  if (blind === undefined) throw new Error('no browser context');
  const blindPage = await blind.newPage();
  for (const rpc of NEAR_RPC) await blindPage.route(`${rpc}/**`, (r) => r.abort());
  await blindPage.goto(`${baseUrl}/approvals`);
  await blindPage.getByText('The chain could not be read. Reload to try again.').waitFor();
  assert.ok(!(await blindPage.locator('main').innerText()).includes('needs JavaScript'), 'no "needs JavaScript" text for a reader who has it');
  await blind.close();

  // a policy that is not a testnet account is refused before any read
  await page.goto(`${baseUrl}/approvals?policy=evil.near`);
  await id(page, 'approvals-badpolicy').waitFor();

  assert.deepEqual([...pageHosts].sort(), [origin, ...new Set(NEAR_RPC.map((u) => new URL(u).host))].filter((h) => h === origin || pageHosts.has(h)).sort(), 'the page talks to its own host and the testnet RPC only');
  assert.ok(rpcHosts.length > 0, 'the chain was read through the RPC');
  assert.ok(rpcHosts.every((h) => NEAR_RPC.some((u) => new URL(u).host === h)));
};

export default run;

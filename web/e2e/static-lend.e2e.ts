// AIR-359: /lend in a real browser on the static build, with the faucet, the RPC and FastNEAR all mocked (a real faucet call spends one of the
// 10 accounts an internet address gets per 12 hours; no test makes one). Before the click, during it (the send held open), with a position, and
// the faucet fallback; the posted transaction is decoded far enough to check it is one `deposit` call to the pool with 1 NEAR. The clip audit
// and screenshots at 375 and 1440 in each state. Run: pnpm build:static && pnpm -C web e2e static-lend
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { CREDIT_POOL } from '../src/credit/net.ts';
import { base58 } from '../src/preview/taskKey.ts';
import vector from '../test/fixtures/tx-vector.json' with { type: 'json' };
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const auditDir = join(fileURLToPath(new URL('../', import.meta.url)), 'audit');
const id = (testId: string, page: Page) => page.locator(`[data-testid="${testId}"]`);
const CORS = { 'access-control-allow-origin': '*' };
const NEAR = 10n ** 24n;
const BLOCK = 'Bp3BbhbyBNoTt3LgewDgCezdiUAWKxiWq18vdj3PVUiS';
const DEPOSIT_TX = 'DepositTxHash1111111111111111111111111111111';

type World = { account: string | null; deposited: boolean; release: (() => void) | null; held: Promise<void> | null; sent: string[]; faucet: 'ok' | 'down' };

const viewBytes = (v: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(v))) } });
const rpc = (result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result });
const ev = (event: string, data: object): string => `EVENT_JSON:${JSON.stringify({ standard: 'airlock-credit', version: '1.0.0', event, data: [data] })}`;

function pool(w: World): object {
  const assets = 2n * NEAR + (w.deposited ? NEAR : 0n);
  return { assets: assets.toString(), shares: assets.toString(), idle: assets.toString(), staked: '0', lent: '0', fees_earned: '0', losses: '0', share_price: NEAR.toString(), lines: [{ card: 'card.airlock-credit-c1108d.testnet', borrower: 'borrower.airlock-credit-c1108d.testnet', limit: '0', drawn: '0', returned: '0', fee_bps: 1000, due_ms: '1', state: 'Defaulted' }] };
}

async function routes(page: Page, w: World): Promise<void> {
  await page.route('https://helper.testnet.near.org/**', async (r: Route) => {
    if (w.faucet === 'down') return r.fulfill({ status: 503, headers: CORS, body: 'down' });
    const body = JSON.parse(r.request().postData() ?? '{}') as { newAccountId?: string; newAccountPublicKey?: string };
    assert.match(body.newAccountId ?? '', /^lender-[a-z0-9]{10}\.testnet$/);
    assert.match(body.newAccountPublicKey ?? '', /^ed25519:/);
    w.account = body.newAccountId ?? null;
    return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ transaction: { hash: 'FaucetTxHash111111111111111111111111111111111' } }) });
  });
  await page.route('https://test.rpc.fastnear.com/**', async (r: Route) => {
    const req = JSON.parse(r.request().postData() ?? '{}') as { method: string; params: Record<string, string> };
    if (req.method === 'send_tx') {
      w.sent.push(req.params['signed_tx_base64'] ?? '');
      if (w.held !== null) await w.held;
      w.deposited = true;
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: rpc({ status: { SuccessValue: '' }, transaction: { hash: DEPOSIT_TX }, receipts_outcome: [{ outcome: { executor_id: CREDIT_POOL, logs: [ev('deposit', { account: w.account, amount: NEAR.toString(), shares: NEAR.toString() })], status: { SuccessValue: '' } } }] }) });
    }
    const p = req.params;
    if (p['request_type'] === 'view_access_key') return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: rpc({ nonce: 5, block_hash: BLOCK }) });
    const method = p['method_name'];
    const body = method === 'get_pool' ? viewBytes(pool(w)) : method === 'get_lp' ? viewBytes({ shares: w.deposited ? NEAR.toString() : '0', value: w.deposited ? NEAR.toString() : '0', locked_until_ms: String(Date.now() + 45_000) }) : method === 'get_book' ? viewBytes([]) : viewBytes(null);
    return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body });
  });
  await page.route('https://tx.test.fastnear.com/**', async (r: Route) => {
    const url = r.request().url();
    const lp1 = { transaction_hash: 'TeamDepositHash1111111111111111111111111111', tx_block_height: 1, tx_block_timestamp: String(BigInt(Date.now() - 7_200_000) * 1_000_000n), is_success: true };
    const mine = { transaction_hash: DEPOSIT_TX, tx_block_height: 2, tx_block_timestamp: String(BigInt(Date.now() - 5_000) * 1_000_000n), is_success: true };
    if (url.endsWith('/v0/account')) {
      const who = (JSON.parse(r.request().postData() ?? '{}') as { account_id?: string }).account_id;
      const txs = who === CREDIT_POOL ? (w.deposited ? [lp1, mine] : [lp1]) : [];
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ account_txs: txs, resume_token: null }) });
    }
    const hashes = (JSON.parse(r.request().postData() ?? '{}') as { tx_hashes: string[] }).tx_hashes;
    const tx = (hash: string, account: string): object => ({ transaction: { hash, signer_id: account, receiver_id: CREDIT_POOL, public_key: 'ed25519:x', actions: [] }, receipts: [{ receipt: { predecessor_id: account }, execution_outcome: { outcome: { executor_id: CREDIT_POOL, status: { SuccessValue: '' }, logs: [ev('deposit', { account, amount: (hash === DEPOSIT_TX ? NEAR : 2n * NEAR).toString(), shares: (hash === DEPOSIT_TX ? NEAR : 2n * NEAR).toString() })] } } }] });
    return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ transactions: hashes.map((h) => (h === DEPOSIT_TX ? tx(h, w.account ?? 'x') : tx(h, 'lp1.airlock-credit-c1108d.testnet'))) }) });
  });
}

async function shot(page: Page, name: string): Promise<void> {
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    // the page's entry motion runs once; shoot the settled page
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(auditDir, `static-lend-${name}-${String(width)}.png`), fullPage: true });
  }
  assert.deepEqual(await clipAudit(page, [375, 1440]), [], `clip audit, ${name}`);
}

/** The signed transaction's receiver and method, read from its borsh bytes: four length-prefixed strings in a known order. */
function decoded(b64: string): { signer: string; receiver: string; method: string; deposit: bigint } {
  const b = Buffer.from(b64, 'base64');
  let at = 0;
  const str = (): string => {
    const n = b.readUInt32LE(at);
    const s = b.subarray(at + 4, at + 4 + n).toString('utf8');
    at += 4 + n;
    return s;
  };
  const signer = str();
  at += 1 + 32 + 8;
  const receiver = str();
  at += 32 + 4 + 1;
  const method = str();
  const args = b.readUInt32LE(at);
  at += 4 + args + 8;
  const deposit = b.readBigUInt64LE(at) + (b.readBigUInt64LE(at + 8) << 64n);
  return { signer, receiver, method, deposit };
}

const run: E2E = async ({ page, baseUrl }) => {
  mkdirSync(auditDir, { recursive: true });
  const w: World = { account: null, deposited: false, release: null, held: null, sent: [], faucet: 'ok' };
  await routes(page, w);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/lend/`);
  await id('lend-go', page).waitFor();
  await page.locator('[data-testid="lend-lenders"]', { hasText: "not on the team's list" }).waitFor();
  assert.ok((await id('lend-lenders', page).innerText()).startsWith("0 lender accounts are not on the team's list"));
  assert.ok((await id('lend-loop', page).innerText()).includes('has not started'));
  await shot(page, 'before');

  // during: the send is held open while the page shows its steps
  w.held = new Promise<void>((r) => (w.release = r));
  await page.setViewportSize({ width: 1440, height: 900 });
  await id('lend-go', page).click();
  await page.locator('[data-testid="lend-progress"] li', { hasText: 'Lending 1 NEAR.' }).waitFor();
  assert.ok((await id('lend-progress', page).innerText()).includes('Account made: lender-'));
  await shot(page, 'during');
  w.release?.();
  w.held = null;

  await id('lend-position', page).waitFor();
  await page.locator('[data-testid="lend-progress"] li', { hasText: 'Done: you are a lender.' }).waitFor();
  await page.locator('[data-testid="lend-shares"]', { hasText: '1.0000' }).waitFor();
  assert.equal(await id('lend-worth', page).innerText(), '1.0000 NEAR');
  assert.match(await id('lend-account', page).innerText(), /^lender-[a-z0-9]{4}…$/);
  assert.equal(await id('lend-withdraw', page).isDisabled(), true, 'locked for 60 s');
  assert.equal(w.sent.length, 1);
  // the link names the transaction the page signed: base58 of sha256 of the transaction bytes (the signed bytes less key type and signature)
  const signedBytes = Buffer.from(w.sent[0] ?? '', 'base64');
  const txHash = base58(createHash('sha256').update(signedBytes.subarray(0, signedBytes.length - 65)).digest());
  assert.equal(await page.locator('[data-testid="lend-deposit-link"] a').getAttribute('href'), `https://testnet.nearblocks.io/txns/${txHash}`);
  const tx = decoded(w.sent[0] ?? '');
  assert.deepEqual(tx, { signer: w.account, receiver: CREDIT_POOL, method: 'deposit', deposit: NEAR });
  await page.locator('[data-testid="lend-attacks"]', { hasText: 'since you joined:' }).waitFor();
  assert.equal(await id('lend-since', page).count(), 0, 'no borrow line while the loop has not run');
  const stored = await page.evaluate(() => localStorage.getItem('airlock.lender.v1'));
  assert.ok(stored !== null && stored.includes(w.account ?? 'none'));
  await shot(page, 'position');

  // a reload keeps the position from this browser's storage; the restore link works in a fresh context and leaves the address clean
  const link = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('airlock.lender.v1') ?? '{}') as { accountId: string; secretKey: string };
    return `${location.origin}/lend/#k=${s.secretKey.slice(8)}&a=${s.accountId}`;
  });
  const ctx = await page.context().browser()?.newContext({ viewport: { width: 1440, height: 900 } });
  if (ctx === undefined) throw new Error('no browser context');
  const p2 = await ctx.newPage();
  await routes(p2, w);
  await p2.goto(link);
  await p2.locator('[data-testid="lend-position"]').waitFor();
  assert.equal(new URL(p2.url()).hash, '', 'the key is taken out of the address bar');
  await ctx.close();

  // a restore link to another account: nothing is replaced until the visitor chooses; the record left is kept and can be switched back to
  const mine = await id('lend-account', page).innerText();
  const other = `${baseUrl}/lend/#k=${vector.secretKey.slice(8)}&a=lender-zzzzzzzzzz.testnet`;
  await page.goto(other);
  await id('lend-confirm', page).waitFor();
  assert.equal(new URL(page.url()).hash, '', 'the key is out of the address bar before anything is decided');
  assert.ok((await id('lend-confirm', page).innerText()).includes('This link holds a different lender account (lender-zzzz…)'));
  await shot(page, 'confirm');
  await page.setViewportSize({ width: 1440, height: 900 });
  await id('lend-keep-mine', page).click();
  assert.equal(await id('lend-confirm', page).count(), 0);
  assert.equal(await id('lend-account', page).innerText(), mine, 'keep mine changes nothing');
  await page.goto(other);
  await id('lend-switch-linked', page).click();
  await page.locator('[data-testid="lend-account"]', { hasText: 'lender-zzzz…' }).waitFor();
  assert.ok((await id('lend-backups', page).innerText()).includes(`Also kept in this browser: ${mine}`));
  await shot(page, 'switched');
  await page.setViewportSize({ width: 1440, height: 900 });
  await id('lend-switch-back', page).click();
  await page.locator('[data-testid="lend-account"]', { hasText: mine }).waitFor();

  // the faucet down: the fallback offers a wallet
  const ctx3 = await page.context().browser()?.newContext({ viewport: { width: 1440, height: 900 } });
  if (ctx3 === undefined) throw new Error('no browser context');
  const p3 = await ctx3.newPage();
  const w3: World = { account: null, deposited: false, release: null, held: null, sent: [], faucet: 'down' };
  await routes(p3, w3);
  await p3.goto(`${baseUrl}/lend/`);
  await p3.locator('[data-testid="lend-go"]').click();
  await p3.locator('[data-testid="lend-problem"]').waitFor({ timeout: 15_000 });
  assert.ok((await p3.locator('[data-testid="lend-problem"]').innerText()).includes('The faucet did not answer'));
  await p3.locator('[data-testid="lend-wallet"]').waitFor();
  await p3.screenshot({ path: join(auditDir, 'static-lend-fallback-1440.png'), fullPage: true });
  await ctx3.close();
};

export default run;

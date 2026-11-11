// AIR-356: /rob in a real browser on the static build, with the public file, the RPC and FastNEAR mocked (no transaction reaches a node). The
// contract's answers are played by the mock from the request the page signed, by the try card's rules: an unbooked payee is held OutsideTask,
// an amount above 0.01 NEAR blocked AmountOutOfBounds, the shop with a typed amount held UntrustedTrigger, another coin blocked UnknownAsset,
// the owner's own request paid; in `queue` mode every hold answers PendingFull. Each posted transaction is decoded: one submit_batch, signed as
// the try agent on the try policy, deposit 0, never a credit account. Screens and the clip audit before, during, refused, paid and queue full.
// Run: pnpm build:static && pnpm -C web e2e static-rob
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { AGENT, POLICY, PUB, SHOP } from '../test/fixtures/robPub.ts';
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

const auditDir = join(fileURLToPath(new URL('../', import.meta.url)), 'audit');
const id = (testId: string, page: Page) => page.locator(`[data-testid="${testId}"]`);
const CORS = { 'access-control-allow-origin': '*' };
const BLOCK = 'Bp3BbhbyBNoTt3LgewDgCezdiUAWKxiWq18vdj3PVUiS';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');

type Sent = { signer: string; receiver: string; method: string; deposit: bigint; args: { reqs: Record<string, unknown>[] } };

/** The signed transaction's signer, receiver, method, deposit and JSON arguments, from its borsh bytes. */
function decode(b64tx: string): Sent {
  const b = Buffer.from(b64tx, 'base64');
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
  const args = JSON.parse(str()) as Sent['args'];
  at += 8;
  return { signer, receiver, method, deposit: b.readBigUInt64LE(at) + (b.readBigUInt64LE(at + 8) << 64n), args };
}

type World = { sent: Sent[]; held: Promise<void> | null; queue: boolean; listed: { hash: string; atMs: number; raw: object }[] };

function answerFor(req: Record<string, unknown>, queue: boolean): { outcome: string; reason: string | null } {
  const labels = req['labels'] as { pc: number };
  if (req['asset'] !== 'near') return { outcome: 'blocked', reason: 'UnknownAsset' };
  if (BigInt(String(req['amount'])) > 10n ** 22n) return { outcome: 'blocked', reason: 'AmountOutOfBounds' };
  const hold = (reason: string) => (queue ? { outcome: 'blocked', reason: 'PendingFull' } : { outcome: 'escalated', reason });
  if (req['payee'] !== SHOP) return hold('OutsideTask');
  if (labels.pc !== 1) return hold('UntrustedTrigger');
  return { outcome: 'allowed', reason: null };
}

async function routes(page: Page, w: World): Promise<void> {
  await page.route('**/try-public.json', (r: Route) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PUB) }));
  await page.route('https://test.rpc.fastnear.com/**', async (r: Route) => {
    const req = JSON.parse(r.request().postData() ?? '{}') as { method: string; params: Record<string, string> };
    const ok = (result: unknown) => r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result }) });
    if (req.method === 'send_tx') {
      const tx = decode(req.params['signed_tx_base64'] ?? '');
      w.sent.push(tx);
      if (w.held !== null) await w.held;
      const reqs = tx.args.reqs;
      const answers = reqs.map((q, i) => ({ request_id: `${'f'.repeat(63)}${String(w.sent.length)}:${String(i)}`, ...answerFor(q, w.queue), pending_id: null }));
      const hash = `SentTxHash${String(w.sent.length).padStart(34, '1')}`;
      w.listed.push({
        hash,
        atMs: Date.now(),
        raw: {
          transaction: { hash, signer_id: tx.signer, receiver_id: tx.receiver, public_key: PUB.keys[0]?.publicKey, actions: [{ FunctionCall: { method_name: 'submit_batch', args: b64(tx.args) } }] },
          receipts: [{ receipt: { predecessor_id: tx.signer }, execution_outcome: { outcome: { executor_id: tx.receiver, logs: [], status: { SuccessValue: b64(answers) } } } }],
        },
      });
      return ok({ status: { SuccessValue: b64(answers) }, transaction: { hash } });
    }
    if (req.params['request_type'] === 'view_access_key') return ok({ nonce: 5, block_hash: BLOCK });
    return ok({ result: Array.from(new TextEncoder().encode('null')) });
  });
  await page.route('https://tx.test.fastnear.com/**', async (r: Route) => {
    const url = r.request().url();
    if (url.endsWith('/v0/account')) {
      const txs = [...w.listed].reverse().map((t, i) => ({ transaction_hash: t.hash, tx_block_height: 100 - i, tx_block_timestamp: String(BigInt(t.atMs) * 1_000_000n), is_success: true }));
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ account_txs: txs, resume_token: null }) });
    }
    const hashes = (JSON.parse(r.request().postData() ?? '{}') as { tx_hashes: string[] }).tx_hashes;
    return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ transactions: w.listed.filter((t) => hashes.includes(t.hash)).map((t) => t.raw) }) });
  });
}

async function shot(page: Page, name: string): Promise<void> {
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(auditDir, `static-rob-${name}-${String(width)}.png`), fullPage: true });
  }
  assert.deepEqual(await clipAudit(page, [375, 1440]), [], `clip audit, ${name}`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

const run: E2E = async ({ page, baseUrl }) => {
  mkdirSync(auditDir, { recursive: true });
  const w: World = { sent: [], held: null, queue: false, listed: [] };
  await routes(page, w);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/rob/`);
  await id('rob-go', page).waitFor();
  await page.locator('[data-testid="rob-count"]', { hasText: 'paid to anyone but the booked shop' }).waitFor();
  assert.ok((await id('rob-count', page).innerText()).startsWith('0 paid to anyone but the booked shop, in 0 attempts.'));
  await shot(page, 'before');

  // during: the send is held open
  let release = (): void => undefined;
  w.held = new Promise<void>((r) => (release = r));
  await id('rob-pick-stranger', page).click();
  // a preset fills the custom fields, and one line says what Send sends
  assert.equal(await id('rob-own-payee', page).inputValue(), 'my-own-wallet');
  assert.equal(await id('rob-own-amount', page).inputValue(), '0.005');
  assert.ok((await id('rob-sends', page).innerText()).startsWith('This sends 0.005 NEAR to my-own-wallet'));
  await id('rob-go', page).click();
  await page.locator('[data-testid="rob-window"]', { hasText: 'Sending' }).waitFor();
  assert.equal(await id('rob-go', page).innerText(), 'Sending to the card');
  await shot(page, 'during');
  release();
  w.held = null;

  // refused: held for the owner, OutsideTask
  await page.locator('[data-testid="rob-machine"][data-state="refused"]').waitFor({ timeout: 10_000 });
  assert.ok((await id('rob-why', page).innerText()).includes('Held for the owner. A hold is safe: it expires unpaid after a minute'));
  assert.equal(await id('rob-code', page).innerText(), 'OutsideTask');
  // visitor test 2026-11-11: on a laptop the answer was below the fold; it is in view once it lands
  await page.waitForTimeout(800);
  assert.ok(await page.evaluate(() => { const r = document.querySelector('[data-testid="rob-window"]')?.getBoundingClientRect(); return r !== undefined && r.top >= 0 && r.bottom <= innerHeight; }), 'the answer is in view after Send');
  assert.match((await page.locator('[data-testid="rob-why"] a').getAttribute('href')) ?? '', /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  await page.locator('[data-testid="rob-row"][data-mine="true"]').waitFor({ timeout: 10_000 });
  await shot(page, 'refused');

  // the other attacks answer as the contract would
  for (const [pick, code] of [['more', 'UntrustedTrigger'], ['coin', 'UnknownAsset']] as const) {
    await id(`rob-pick-${pick}`, page).click();
    await id('rob-go', page).click();
    await page.locator('[data-testid="rob-code"]', { hasText: code }).waitFor({ timeout: 10_000 });
  }
  // typed: above the card's limit
  await id('rob-own-payee', page).fill('alice');
  await id('rob-own-amount', page).fill('5');
  await id('rob-go', page).click();
  await page.locator('[data-testid="rob-code"]', { hasText: 'AmountOutOfBounds' }).waitFor({ timeout: 10_000 });

  // paid: the owner's own request
  await id('rob-pick-honest', page).click();
  await id('rob-go', page).click();
  await page.locator('[data-testid="rob-machine"][data-state="paid"]').waitFor({ timeout: 10_000 });
  await page.locator('[data-testid="rob-count"]', { hasText: 'Paid to the booked shop: 1.' }).waitFor({ timeout: 10_000 });
  await shot(page, 'paid');

  // the queue full
  w.queue = true;
  await id('rob-pick-stranger', page).click();
  await id('rob-go', page).click();
  await page.locator('[data-testid="rob-code"]', { hasText: 'PendingFull' }).waitFor({ timeout: 10_000 });
  assert.ok((await id('rob-why', page).innerText()).includes('Fifty requests are already waiting for the owner'));
  await shot(page, 'queue');
  // a change to the request clears the answer, so a stale verdict never sits beside new fields
  await id('rob-own-amount', page).fill('0.002');
  await page.locator('[data-testid="rob-window"]', { hasText: 'Waiting for you' }).waitFor();
  assert.equal(await id('rob-why', page).count(), 0);

  // every posted transaction: one submit_batch as the try agent on the try policy, deposit 0, never a credit account
  assert.equal(w.sent.length, 6);
  for (const s of w.sent) {
    assert.equal(s.signer, AGENT);
    assert.equal(s.receiver, POLICY);
    assert.equal(s.method, 'submit_batch');
    assert.equal(s.deposit, 0n);
    assert.ok(!/airlock-credit/.test(s.signer));
  }
};

export default run;

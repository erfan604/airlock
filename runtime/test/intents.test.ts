// AIR-305: the 1Click quote leg against a recorded live dry quote (fixtures/intents/dry-exact-output.live.json, recorded 2026-11-03 from
// https://1click.chaindefuser.com/v0/quote with dry: true, no key, no money) and variants of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkQuote, requestDryQuote, REASONS } from '../src/chain/intents.ts';
import type { AllowedPayout } from '../src/chain/intents.ts';

const here = new URL('.', import.meta.url).pathname;
const rec = JSON.parse(readFileSync(join(here, 'fixtures/intents/dry-exact-output.live.json'), 'utf8')) as Record<string, any>;
const clone = (): Record<string, any> => structuredClone(rec);

const T0 = BigInt(Date.parse(rec.timestamp));
const allowed: AllowedPayout = {
  requestId: 'req-0001',
  payee: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
  destinationAsset: rec.quoteRequest.destinationAsset,
  amountOut: '5000000',
  originAsset: rec.quoteRequest.originAsset,
  maxAmountIn: '5100000',
  refundTo: [rec.quoteRequest.refundTo],
  windowStartMs: T0,
  windowEndMs: T0 + 40n * 60n * 1000n,
  maxSlippageBps: 100n,
};
const sent = (): Record<string, unknown> => ({ ...rec.quoteRequest });
const run = (r: Record<string, any>, s: Record<string, unknown> = sent(), a: AllowedPayout = allowed) => checkQuote(a, s, r, { expectDry: true });

test('the recorded live dry quote matches the allowed payout and is bound to the request id', () => {
  const r = run(clone());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.record.requestId, 'req-0001');
  assert.equal(r.record.depositAddress, null);
  assert.equal(r.record.dry, true);
  assert.match(r.record.label, /no funds move/);
  assert.match(r.record.binding, /^[0-9a-f]{64}$/);
  const other = checkQuote({ ...allowed, requestId: 'req-0002' }, sent(), clone(), { expectDry: true });
  assert.equal(other.ok && other.record.binding !== r.record.binding, true);
});

function refused(mutate: (r: Record<string, any>, s: Record<string, unknown>) => void, reason: string, a: AllowedPayout = allowed): void {
  const r = clone();
  const s = sent();
  mutate(r, s);
  const out = run(r, s, a);
  assert.deepEqual(out, { ok: false, reason });
  assert.ok((REASONS as readonly string[]).includes(reason));
}

test('a swapped recipient is refused (response and request both rewritten)', () => {
  refused((r, s) => { r.quoteRequest.recipient = '0x1111111111111111111111111111111111111111'; s['recipient'] = r.quoteRequest.recipient; }, 'RecipientMismatch');
});
test('a response that answers a different request than the one sent is refused', () => {
  refused((r) => { r.quoteRequest.recipient = '0x1111111111111111111111111111111111111111'; }, 'RequestEchoMismatch');
});
test('a recipient inside Intents, not on the destination chain, is refused', () => {
  refused((r, s) => { r.quoteRequest.recipientType = 'INTENTS'; s['recipientType'] = 'INTENTS'; }, 'RecipientNotOnDestinationChain');
});
test('an amount out below the allowed amount is refused, in amountOut and in minAmountOut', () => {
  refused((r) => { r.quote.amountOut = '4999999'; }, 'AmountOutBelowAllowed');
  refused((r) => { r.quote.minAmountOut = '4999999'; }, 'AmountOutBelowAllowed');
});
test('an inflated amount in above the Allow cap is refused', () => {
  refused((r) => { r.quote.amountIn = '5100001'; }, 'AmountInAboveCap');
});
test('slippage wider than the bound is refused, in the request and in the quote spread', () => {
  refused((r, s) => { r.quoteRequest.slippageTolerance = 500; s['slippageTolerance'] = 500; }, 'SlippageTooWide');
  refused((r) => { r.quote.amountOut = '5200000'; }, 'SlippageTooWide', { ...allowed, maxAmountIn: '9999999' });
  refused((r) => { r.quote.amountOut = '5100000'; r.quote.minAmountOut = '5000000'; }, 'SlippageTooWide', { ...allowed, maxSlippageBps: 50n });
});
test('a refund address that is not ours is refused', () => {
  refused((r, s) => { r.quoteRequest.refundTo = 'attacker.near'; s['refundTo'] = 'attacker.near'; }, 'RefundNotOurs');
});
test('a deadline outside the authorization window is refused', () => {
  const late = new Date(Number(allowed.windowEndMs) + 1000).toISOString();
  refused((r, s) => { r.quoteRequest.deadline = late; s['deadline'] = late; }, 'DeadlineOutsideWindow');
  const early = new Date(Number(allowed.windowStartMs) - 1000).toISOString();
  refused((r, s) => { r.quoteRequest.deadline = early; s['deadline'] = early; }, 'DeadlineOutsideWindow');
});
test('other assets are refused', () => {
  refused((r, s) => { r.quoteRequest.destinationAsset = 'nep141:eth.omft.near'; s['destinationAsset'] = 'nep141:eth.omft.near'; }, 'DestinationAssetMismatch');
  refused((r, s) => { r.quoteRequest.originAsset = 'nep141:wrap.near'; s['originAsset'] = 'nep141:wrap.near'; }, 'OriginAssetMismatch');
});
test('a dry quote that carries a deposit address, or a non-dry request, is refused', () => {
  refused((r) => { r.quote.depositAddress = 'bc1qattacker'; }, 'UnexpectedDepositAddress');
  refused((r, s) => { r.quoteRequest.dry = false; s['dry'] = false; }, 'NotDry');
});
test('a malformed quote (amount as a number, missing fields) is refused', () => {
  refused((r) => { r.quote.amountOut = 5000000; }, 'MalformedQuote');
  refused((r) => { delete r.signature; }, 'MalformedQuote');
});

// A live-shape (non-dry) quote exists only as a test fixture: the runtime never asks for one. It shows how a deposit address is bound.
function liveShape(): { r: Record<string, any>; s: Record<string, unknown> } {
  const r = clone();
  const s = sent();
  r.quoteRequest.dry = false;
  s['dry'] = false;
  r.quote.depositAddress = '9f1c0f6a2b7d4e8a91c3b5d7f0a2c4e6081a3c5e7f9b1d3f5a7c9e1b3d5f7a90';
  r.quote.deadline = new Date(Number(T0) + 30 * 60 * 1000).toISOString();
  return { r, s };
}
test('a live-shape quote records the deposit address bound to the allowed request id', () => {
  const { r, s } = liveShape();
  const a = checkQuote(allowed, s, r, { expectDry: false });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.record.depositAddress, r.quote.depositAddress);
  const swapped = liveShape();
  swapped.r.quote.depositAddress = 'ffff0f6a2b7d4e8a91c3b5d7f0a2c4e6081a3c5e7f9b1d3f5a7c9e1b3d5f7a90';
  const b = checkQuote(allowed, swapped.s, swapped.r, { expectDry: false });
  assert.equal(b.ok && b.record.binding !== a.record.binding, true);
});
test('a live-shape quote without a deposit address, or with a deposit deadline past the window, is refused', () => {
  const a = liveShape();
  delete a.r.quote.depositAddress;
  assert.deepEqual(checkQuote(allowed, a.s, a.r, { expectDry: false }), { ok: false, reason: 'MissingDepositAddress' });
  const b = liveShape();
  b.r.quote.deadline = new Date(Number(allowed.windowEndMs) + 1000).toISOString();
  assert.deepEqual(checkQuote(allowed, b.s, b.r, { expectDry: false }), { ok: false, reason: 'DeadlineOutsideWindow' });
});

test('requestDryQuote always sends dry: true, clamps the deadline to the window and refuses a failed call', async () => {
  const bodies: Record<string, unknown>[] = [];
  const mk = (status: number, payload: unknown): typeof fetch =>
    (async (_u: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return { ok: status < 300, json: async () => payload };
    }) as unknown as typeof fetch;
  const tight = { ...allowed, windowEndMs: T0 + 10n * 60n * 1000n };
  const echo = async (init: { body?: string }): Promise<unknown> => {
    const body = JSON.parse(init.body ?? '{}');
    const r = clone();
    r.quoteRequest = { ...r.quoteRequest, ...body };
    return r;
  };
  const f = (async (_u: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    const payload = await echo(init ?? {});
    return { ok: true, json: async () => payload };
  }) as unknown as typeof fetch;
  const res = await requestDryQuote(tight, { fetch: f, nowMs: () => T0 });
  assert.equal(bodies[0]?.['dry'], true);
  assert.equal(bodies[0]?.['deadline'], new Date(Number(T0) + 10 * 60 * 1000).toISOString());
  assert.equal(res.check.ok, true);
  const bad = await requestDryQuote(allowed, { fetch: mk(500, {}), nowMs: () => T0 });
  assert.deepEqual(bad.check, { ok: false, reason: 'MalformedQuote' });
});

test('the module imports no signer, chain client or key code (a pass or a refusal never signs)', () => {
  const src = readFileSync(join(here, '../src/chain/intents.ts'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['node:crypto', 'zod']);
});

// AIR-168: the PAYMENT-SIGNATURE assembly and the local facilitator checks, over an authorization signed by a local viem key (the
// contract's mock MPC returns a value that recovers to no address, so a real key is needed here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PaymentRequiredV2, X402Mismatch, buildPaymentPayload, decodeX402Signed, encodePaymentHeader } from '../src/chain/x402.ts';
import type { X402Signed } from '../src/chain/x402.ts';
import { TRANSFER_WITH_AUTHORIZATION_TYPES, verifyLocally } from '../src/chain/x402-verify.ts';

const FIXTURE = join(import.meta.dirname, '../../fixtures/x402-live/live-usdc.json');
const required = (): PaymentRequiredV2 => PaymentRequiredV2.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex;
const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' as Hex;
const NOW = 1_740_672_000n;
const VALID_BEFORE = NOW + 300n;
const NONCE = `0x${'ab'.repeat(32)}` as Hex;
const DOMAIN = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC } as const;

async function eventOf(over: Partial<{ value: bigint; to: Hex; validBefore: bigint; signer: ReturnType<typeof privateKeyToAccount> }> = {}): Promise<X402Signed> {
  const value = over.value ?? 10000n;
  const to = over.to ?? PAY_TO;
  const validBefore = over.validBefore ?? VALID_BEFORE;
  const sig = await (over.signer ?? account).signTypedData({
    domain: DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: { from: account.address, to, value, validAfter: 0n, validBefore, nonce: NONCE },
  });
  return {
    id: 'task:0',
    from: account.address.toLowerCase(),
    to: to.toLowerCase(),
    value: value.toString(),
    valid_after: '0',
    valid_before: validBefore.toString(),
    nonce: NONCE,
    v: sig.endsWith('1b') ? 27 : 28,
    r: sig.slice(2, 66),
    s: sig.slice(66, 130),
  };
}

const decodeHeader = (h: string): any => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));

test('the header has the v2 shape and echoes accepts[0] exactly', async () => {
  const req = required();
  const p = decodeHeader(encodePaymentHeader(buildPaymentPayload(await eventOf(), req, 0)));
  assert.equal(p.x402Version, 2);
  assert.deepEqual(p.accepted, JSON.parse(readFileSync(FIXTURE, 'utf8')).accepts[0]);
  assert.equal(p.accepted.network, 'eip155:84532');
  assert.equal(p.maxAmountRequired, undefined);
  assert.equal(p.scheme, undefined);
  assert.ok(!JSON.stringify(p).includes('"base-sepolia"'));
  assert.deepEqual(p.resource, req.resource);
  assert.deepEqual(Object.keys(p.payload.authorization), ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']);
  assert.equal(p.payload.authorization.validAfter, '0');
  assert.equal(typeof p.payload.authorization.value, 'string');
});

test('the signature is 65 bytes ending 1b or 1c and recovers the payer', async () => {
  const ev = await eventOf();
  const p = buildPaymentPayload(ev, required(), 0);
  const sig = p.payload.signature;
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  assert.ok(sig.endsWith('1b') || sig.endsWith('1c'));
  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: { from: ev.from as Hex, to: ev.to as Hex, value: 10000n, validAfter: 0n, validBefore: VALID_BEFORE, nonce: NONCE },
    signature: sig as Hex,
  });
  assert.equal(recovered.toLowerCase(), ev.from);
});

test('the digest of the fixed M2 example matches', () => {
  const digest = hashTypedData({
    domain: DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: { from: account.address, to: PAY_TO, value: 10000n, validAfter: 0n, validBefore: 1740672154n, nonce: NONCE },
  });
  assert.equal(digest, '0x2178b44a8b4de3e9911b1ae6639674f3f844d1ea965bc358ece95239ab834f8d');
});

test('verifyLocally passes for the fixture', async () => {
  await verifyLocally(buildPaymentPayload(await eventOf(), required(), 0), NOW);
});

test('verifyLocally fails for a changed value', async () => {
  const p = buildPaymentPayload(await eventOf(), required(), 0);
  p.payload.authorization.value = '10001';
  await assert.rejects(verifyLocally(p, NOW), /value differs/);
  p.payload.authorization.value = '9999';
  await assert.rejects(verifyLocally(p, NOW), /value differs/);
});

test('verifyLocally fails for a changed to', async () => {
  const p = buildPaymentPayload(await eventOf(), required(), 0);
  p.payload.authorization.to = '0x0000000000000000000000000000000000000001';
  await assert.rejects(verifyLocally(p, NOW), /to differs/);
});

test('verifyLocally fails with validBefore 5 seconds ahead and passes with 6', async () => {
  const ev = await eventOf({ validBefore: NOW + 5n });
  await assert.rejects(verifyLocally(buildPaymentPayload(ev, required(), 0), NOW), /6 seconds/);
  const ok = await eventOf({ validBefore: NOW + 6n });
  await verifyLocally(buildPaymentPayload(ok, required(), 0), NOW);
});

test('verifyLocally fails for a signature from another key', async () => {
  const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
  const ev = await eventOf({ signer: other });
  await assert.rejects(verifyLocally(buildPaymentPayload(ev, required(), 0), NOW), /does not recover from/);
});

test('buildPaymentPayload throws X402Mismatch for a value, payTo, network or asset difference', async () => {
  const ev = await eventOf();
  assert.throws(() => buildPaymentPayload({ ...ev, value: '10001' }, required(), 0), X402Mismatch);
  assert.throws(() => buildPaymentPayload({ ...ev, to: '0x0000000000000000000000000000000000000001' }, required(), 0), X402Mismatch);
  const r = required();
  r.accepts[0]!.network = 'base-sepolia';
  assert.throws(() => buildPaymentPayload(ev, r, 0), (e) => e instanceof X402Mismatch && e.field === 'network');
  const r2 = required();
  r2.accepts[0]!.asset = '0x0000000000000000000000000000000000000002';
  assert.throws(() => buildPaymentPayload(ev, r2, 0), (e) => e instanceof X402Mismatch && e.field === 'asset');
  assert.throws(() => buildPaymentPayload(ev, required(), 3), X402Mismatch);
});

test('decodeX402Signed reads the event line and rejects other lines', async () => {
  const ev = await eventOf();
  const line = (event: string, data: unknown[]) => `EVENT_JSON:${JSON.stringify({ standard: 'airlock', version: '1.0.0', event, data })}`;
  assert.deepEqual(decodeX402Signed(line('x402_signed', [ev])), ev);
  assert.equal(decodeX402Signed(line('signed', [ev])), null);
  assert.equal(decodeX402Signed(line('x402_signed', [ev, ev])), null);
  assert.equal(decodeX402Signed('EVENT_JSON:{not json'), null);
  assert.equal(decodeX402Signed('not an event'), null);
  assert.equal(decodeX402Signed(line('x402_signed', [{ ...ev, v: 29 }])), null);
});

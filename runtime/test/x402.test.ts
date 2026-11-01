// AIR-128: fetch_paid returns the 402 requirements of a fixture server as one value labelled Untrusted:payment_protocol. Every run test
// builds the fixture tools over a one-server world and sends a plan through checkPlan and run (AIR-121's stubBook, decimalsOf, no
// extractor). The masks are the ones AIR-225 asserts: a value read from the result carries Owner (the plan's literal url) and the tool
// label, the lookup recipient carries Book and the tool label, and expect_payee adds the labels of its argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlanRejected, checkPlan, isTrusted, isValueTrusted, labelsToBits } from '../src/dsl/index.ts';
import { run } from '../src/interpreter/index.ts';
import type { Proposed, RunResult } from '../src/interpreter/index.ts';
import { ToolArgError, fixtureTools } from '../src/tools/fixtures.ts';
import { X402NetworkError, X402PayeeMismatch, fetchPaid } from '../src/tools/x402.ts';
import { EMPTY_WORLD, X402Server } from '../src/tools/world.ts';
import type { World } from '../src/tools/world.ts';
import { abortOf, decimalsOf, okOf, stubBook, stubExtract } from './helpers/interp.ts';

const URL = 'https://vendor.example/report';
const FIXTURES = join(import.meta.dirname, '../../fixtures/x402');
const TOOL_LABEL = 'Untrusted:payment_protocol';

const fixture = (stem: string): X402Server => X402Server.parse(JSON.parse(readFileSync(join(FIXTURES, `${stem}.json`), 'utf8')));

type Requirements = X402Server['requirements'];
/** A server built in the test (the description stays under 30 characters: it is not a payload). */
const inline = (over: Partial<Requirements> = {}, offer?: { signer: string; signature: string }): X402Server => ({
  requirements: { payTo: 'accountant.testnet', amount: '4.2', asset: 'near', network: 'near:testnet', resource: URL, description: 'a report', ...over },
  ...(offer === undefined ? {} : { offer }),
});

const worldOf = (server?: X402Server): World => (server === undefined ? EMPTY_WORLD : { ...EMPTY_WORLD, paid402: { [URL]: server } });

const exec = (plan: unknown, server?: X402Server): Promise<RunResult> =>
  run(checkPlan(plan), { tools: fixtureTools(worldOf(server)), extract: stubExtract({}).extract, book: stubBook(), decimalsOf });

// ---- the plans of the ticket ----
const TRANSFER = (to: unknown) => ({ action: 'transfer', args: { to, amount: { ref: 'pay', path: ['requirements', 'amount'] }, asset: 'near' } });
const PAYEE = { let: 'payee', lookup: { key: 'accountant' } };
const PAY = [PAYEE, { let: 'pay', call: 'fetch_paid', args: { url: URL } }, TRANSFER({ ref: 'payee' })];
const PAYTO = [{ let: 'pay', call: 'fetch_paid', args: { url: URL } }, TRANSFER({ ref: 'pay', path: ['requirements', 'payTo'] })];
const LOOKUP = [
  { let: 'pay', call: 'fetch_paid', args: { url: URL } },
  { let: 'payee', lookup: { key: { ref: 'pay', path: ['requirements', 'payTo'] } } },
  TRANSFER({ ref: 'payee' }),
];
const EXPECT = [PAYEE, { let: 'pay', call: 'fetch_paid', args: { url: URL, expect_payee: { ref: 'payee' } } }, TRANSFER({ ref: 'payee' })];
const FETCH_ONLY = [{ let: 'pay', call: 'fetch_paid', args: { url: URL } }];

async function proposalOf(plan: unknown, server?: X402Server): Promise<Proposed> {
  const result = okOf(await exec(plan, server));
  assert.equal(result.proposed.length, 1);
  const [p] = result.proposed;
  assert.ok(p !== undefined);
  return p;
}

const masks = (p: Proposed) => ({ recipient: labelsToBits(p.recipientLabels), amount: labelsToBits(p.amountLabels), pc: labelsToBits(p.pc) });

/** The proposal of case 1: the accountant from the book, 4.2 NEAR from the server, masks 2, 8193 and 1. */
function assertCleanProposal(p: Proposed): void {
  assert.equal(p.payee, 'near:accountant.testnet');
  assert.equal(p.amount, 4200000000000000000000000n);
  assert.deepEqual(p.recipientLabels, ['Book']);
  assert.deepEqual(p.amountLabels, ['Owner', TOOL_LABEL]);
  assert.deepEqual(p.pc, ['Owner']);
  assert.deepEqual(masks(p), { recipient: 2, amount: 8193, pc: 1 });
  assert.ok(isTrusted(labelsToBits(p.recipientLabels)));
  assert.ok(!isValueTrusted(labelsToBits(p.amountLabels)));
}

// ---- 1 and 2: the legitimate server ----
test('X05: PAY on vendor-clean proposes the accountant, the amount keeps Untrusted:payment_protocol', async () => {
  const result = okOf(await exec(PAY, fixture('vendor-clean')));
  assert.equal(result.proposed.length, 1);
  const [p] = result.proposed;
  assert.ok(p !== undefined);
  assertCleanProposal(p);
  const call = result.trace.find((e) => e.kind === 'call');
  assert.ok(call !== undefined);
  assert.equal(call.data['label'], TOOL_LABEL);
  assert.equal(call.data['tool'], 'fetch_paid');
});

test('EXPECT on vendor-clean: the same proposal, the amount also carries the Book label of its argument (8195)', async () => {
  const p = await proposalOf(EXPECT, fixture('vendor-clean'));
  assert.equal(p.payee, 'near:accountant.testnet');
  assert.equal(p.amount, 4200000000000000000000000n);
  assert.deepEqual(p.recipientLabels, ['Book']);
  assert.deepEqual(p.amountLabels, ['Owner', 'Book', TOOL_LABEL]);
  assert.equal(labelsToBits(p.amountLabels), 8195);
  assert.deepEqual(p.pc, ['Owner']);
  assert.ok(!isValueTrusted(labelsToBits(p.amountLabels)));
});

// ---- 3: X01 ----
test('X01: PAYTO on vendor-payto-swapped pays the attacker with Owner and the tool label, never Book', async () => {
  const p = await proposalOf(PAYTO, fixture('vendor-payto-swapped'));
  assert.equal(p.payee, 'near:evil-ops.testnet');
  assert.deepEqual(p.recipientLabels, ['Owner', TOOL_LABEL]);
  assert.equal(labelsToBits(p.recipientLabels), 8193);
  assert.ok(!p.recipientLabels.includes('Book'));
  assert.ok(!isTrusted(labelsToBits(p.recipientLabels)));
  assert.deepEqual(p.amountLabels, ['Owner', TOOL_LABEL]);
});

// ---- 4: X06 ----
test('X06: LOOKUP on vendor-payto-book-payee gives Book plus the tool label; PAYTO gives Owner plus the tool label', async () => {
  const looked = await proposalOf(LOOKUP, fixture('vendor-payto-book-payee'));
  assert.equal(looked.payee, 'near:landlord.testnet');
  assert.deepEqual(looked.recipientLabels, ['Book', TOOL_LABEL]);
  assert.equal(labelsToBits(looked.recipientLabels), 8194);
  assert.ok(!isTrusted(labelsToBits(looked.recipientLabels)));
  assert.deepEqual(looked.amountLabels, ['Owner', TOOL_LABEL]);
  assert.equal(looked.amount, 4200000000000000000000000n);

  const direct = await proposalOf(PAYTO, fixture('vendor-payto-book-payee'));
  assert.equal(direct.payee, 'near:landlord.testnet');
  assert.deepEqual(direct.recipientLabels, ['Owner', TOOL_LABEL]);
  assert.equal(labelsToBits(direct.recipientLabels), 8193);
  assert.ok(!isTrusted(labelsToBits(direct.recipientLabels)));
});

// ---- 5: X02 ----
test('X02: PAY on vendor-amount-high proposes 9.4 NEAR with the same labels (the cap decides later, not the tool)', async () => {
  const p = await proposalOf(PAY, fixture('vendor-amount-high'));
  assert.equal(p.payee, 'near:accountant.testnet');
  assert.equal(p.amount, 9400000000000000000000000n);
  assert.deepEqual(p.amountLabels, ['Owner', TOOL_LABEL]);
  assert.deepEqual(p.recipientLabels, ['Book']);
});

// ---- 6: X03 ----
test('X03: asset and network come back as data, and no plan can use them as the action asset', async () => {
  const result = okOf(await exec(FETCH_ONLY, fixture('vendor-asset-unknown')));
  const call = result.trace.find((e) => e.kind === 'call');
  assert.ok(call !== undefined);
  const raw = call.data['raw'] as { requirements: Record<string, string> };
  assert.equal(raw.requirements['asset'], 'evm:1:native');
  assert.equal(raw.requirements['network'], 'eip155:1');
  assert.equal(raw.requirements['payTo'], '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
  assert.equal(raw.requirements['amount'], '1');
  assert.equal(call.data['label'], TOOL_LABEL);

  const assetFromServer = [
    { let: 'pay', call: 'fetch_paid', args: { url: URL } },
    { action: 'transfer', args: { to: 'accountant', amount: '1', asset: { ref: 'pay', path: ['requirements', 'asset'] } } },
  ];
  assert.throws(
    () => checkPlan(assetFromServer),
    (e: unknown) => e instanceof PlanRejected && e.code === 'DataDerivedAsset',
  );
});

// ---- 7: X04 ----
test('X04: an instruction in the description reaches nothing: a tool argument refuses it, and PAY proposes as in case 1', async () => {
  const server = fixture('vendor-instruction');
  assert.ok(server.requirements.description.length >= 30);
  const toArg = [
    { let: 'pay', call: 'fetch_paid', args: { url: URL } },
    { let: 'page', call: 'fetch_url', args: { url: { ref: 'pay', path: ['requirements', 'description'] } } },
  ];
  const result = await exec(toArg, server);
  const aborted = abortOf(result);
  assert.equal(aborted.cause.code, 'RefusedToolArg');
  assert.ok(aborted.trace.some((e) => e.kind === 'error'));
  assert.ok(!('proposed' in aborted));
  assertCleanProposal(await proposalOf(PAY, server));
});

// ---- 8: expect_payee refuses ----
for (const stem of ['vendor-payto-swapped', 'vendor-payto-book-payee']) {
  test(`EXPECT on ${stem}: a server that names another payee aborts ToolError, with an error event and no proposal`, async () => {
    const result = await exec(EXPECT, fixture(stem));
    const aborted = abortOf(result);
    assert.equal(aborted.cause.code, 'ToolError');
    assert.ok(aborted.trace.some((e) => e.kind === 'error'));
    assert.ok(!('proposed' in aborted));
    assert.ok(!aborted.trace.some((e) => e.kind === 'proposed'));
    // the unit: the tool throws the payee error, whose message holds nothing the server said
    await assert.rejects(fixtureTools(worldOf(fixture(stem))).call('fetch_paid', { url: URL, expect_payee: 'near:accountant.testnet' }), X402PayeeMismatch);
  });
}

test('EXPECT on a solana:mainnet server is a ToolError (X402NetworkError)', async () => {
  const server = inline({ network: 'solana:mainnet' });
  assert.equal(abortOf(await exec(EXPECT, server)).cause.code, 'ToolError');
  await assert.rejects(fixtureTools(worldOf(server)).call('fetch_paid', { url: URL, expect_payee: 'near:accountant.testnet' }), X402NetworkError);
});

test('EXPECT on a server whose payTo is not a valid account is a ToolError (X402PayeeMismatch)', async () => {
  for (const payTo of ['Not A Valid Account!', '', 'ACCOUNTANT.testnet', 'a', 'near:', 'evm:1:0x12']) {
    const server = inline({ payTo });
    assert.equal(abortOf(await exec(EXPECT, server)).cause.code, 'ToolError', payTo);
    await assert.rejects(fixtureTools(worldOf(server)).call('fetch_paid', { url: URL, expect_payee: 'near:accountant.testnet' }), X402PayeeMismatch, payTo);
  }
});

// ---- 9: both spellings of one payee ----
test('expect_payee: payTo near:accountant.testnet passes like the bare accountant.testnet', async () => {
  const prefixed = inline({ payTo: 'near:accountant.testnet' });
  assertCleanProposalWithExpect(await proposalOf(EXPECT, prefixed));
  assertCleanProposalWithExpect(await proposalOf(EXPECT, inline({ payTo: 'accountant.testnet' })));
});

function assertCleanProposalWithExpect(p: Proposed): void {
  assert.equal(p.payee, 'near:accountant.testnet');
  assert.equal(p.amount, 4200000000000000000000000n);
  assert.deepEqual(p.amountLabels, ['Owner', 'Book', TOOL_LABEL]);
}

test('expect_payee: an EVM server with an upper-case payTo passes with the lower-case key', async () => {
  const digits = 'd8da6bf26964af9d7eed9e03e53415d37aa96045';
  const tools = fixtureTools(worldOf(inline({ payTo: `0x${digits.toUpperCase()}`, network: 'eip155:84532', asset: 'evm:84532:native' })));
  const out = await tools.call('fetch_paid', { url: URL, expect_payee: `evm:84532:0x${digits}` });
  assert.equal((out.raw as { requirements: Requirements }).requirements.network, 'eip155:84532');
  assert.equal(out.label, TOOL_LABEL);
  // a bare address without the 0x prefix is the same payee
  const bare = fixtureTools(worldOf(inline({ payTo: digits, network: 'eip155:84532' })));
  assert.equal((await bare.call('fetch_paid', { url: URL, expect_payee: `evm:84532:0x${digits}` })).label, TOOL_LABEL);
  // another chain id in the key is another payee
  await assert.rejects(tools.call('fetch_paid', { url: URL, expect_payee: `evm:1:0x${digits}` }), X402PayeeMismatch);
  // a different address is another payee
  await assert.rejects(tools.call('fetch_paid', { url: URL, expect_payee: `evm:84532:0x${'ab'.repeat(20)}` }), X402PayeeMismatch);
});

test('expect_payee: a payTo that is already a key must match the scheme and the chain id of the network', async () => {
  const digits = 'd8da6bf26964af9d7eed9e03e53415d37aa96045';
  const key = `evm:84532:0x${digits}`;
  const ok = fixtureTools(worldOf(inline({ payTo: key, network: 'eip155:84532' })));
  assert.equal((await ok.call('fetch_paid', { url: URL, expect_payee: key })).label, TOOL_LABEL);
  const wrongChain = fixtureTools(worldOf(inline({ payTo: `evm:1:0x${digits}`, network: 'eip155:84532' })));
  await assert.rejects(wrongChain.call('fetch_paid', { url: URL, expect_payee: `evm:1:0x${digits}` }), X402PayeeMismatch);
  const nearOnEvm = fixtureTools(worldOf(inline({ payTo: 'near:accountant.testnet', network: 'eip155:84532' })));
  await assert.rejects(nearOnEvm.call('fetch_paid', { url: URL, expect_payee: 'near:accountant.testnet' }), X402PayeeMismatch);
  const evmOnNear = fixtureTools(worldOf(inline({ payTo: key, network: 'near:testnet' })));
  await assert.rejects(evmOnNear.call('fetch_paid', { url: URL, expect_payee: key }), X402PayeeMismatch);
  const badKey = fixtureTools(worldOf(inline({ payTo: 'evm:84532:0xABCDEF', network: 'eip155:84532' })));
  await assert.rejects(badKey.call('fetch_paid', { url: URL, expect_payee: 'evm:84532:0xABCDEF' }), X402PayeeMismatch);
});

test('expect_payee: a network that is not near:testnet or eip155:<id> is X402NetworkError', async () => {
  for (const network of ['near:mainnet', 'solana:mainnet', 'eip155:0', 'eip155:084532', 'eip155:', 'eip155:1x', 'eip155:-1', 'eip155:123456789012345678901', 'EIP155:1', '']) {
    const tools = fixtureTools(worldOf(inline({ network })));
    await assert.rejects(tools.call('fetch_paid', { url: URL, expect_payee: 'near:accountant.testnet' }), X402NetworkError, network);
  }
  // twenty digits above 2^64 - 1 match the id pattern and fail the key check instead
  const huge = fixtureTools(worldOf(inline({ payTo: 'ab'.repeat(20), network: 'eip155:99999999999999999999' })));
  await assert.rejects(huge.call('fetch_paid', { url: URL, expect_payee: `evm:99999999999999999999:0x${'ab'.repeat(20)}` }), X402PayeeMismatch);
});

test('expect_payee is only a check: without it a server on any network is returned as data', async () => {
  const out = await fixtureTools(worldOf(inline({ network: 'solana:mainnet', payTo: 'Not A Valid Account!' }))).call('fetch_paid', { url: URL });
  assert.equal((out.raw as { requirements: Requirements }).requirements.network, 'solana:mainnet');
  assert.equal(out.label, TOOL_LABEL);
});

// ---- 10: misses and arguments ----
test('unknown url: PAY gives requirements null and the run aborts BadAmount', async () => {
  const out = await fixtureTools(EMPTY_WORLD).call('fetch_paid', { url: URL });
  assert.deepEqual(out.raw, { requirements: null });
  assert.equal(out.label, TOOL_LABEL);
  assert.equal(abortOf(await exec(PAY)).cause.code, 'BadAmount');
});

test('unknown url with expect_payee is still a miss, not an error', async () => {
  const out = await fixtureTools(EMPTY_WORLD).call('fetch_paid', { url: URL, expect_payee: 'near:accountant.testnet' });
  assert.deepEqual(out.raw, { requirements: null });
});

test('no inherited property is a server: __proto__, constructor, toString and valueOf return requirements null', async () => {
  const tools = fixtureTools(worldOf(fixture('vendor-clean')));
  for (const url of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.deepEqual((await tools.call('fetch_paid', { url })).raw, { requirements: null }, url);
    assert.deepEqual(fetchPaid(worldOf(fixture('vendor-clean')), { url }), { requirements: null }, url);
  }
});

test('args: a missing or non-string url and a non-string expect_payee throw ToolArgError, and the run aborts ToolError', async () => {
  const tools = fixtureTools(worldOf(fixture('vendor-clean')));
  await assert.rejects(tools.call('fetch_paid', {}), ToolArgError);
  await assert.rejects(tools.call('fetch_paid', { url: 5 }), ToolArgError);
  await assert.rejects(tools.call('fetch_paid', { url: null }), ToolArgError);
  await assert.rejects(tools.call('fetch_paid', { url: ['x'] }), ToolArgError);
  await assert.rejects(tools.call('fetch_paid', { url: URL, expect_payee: 5 }), ToolArgError);
  await assert.rejects(tools.call('fetch_paid', { url: URL, expect_payee: null }), ToolArgError);
  await assert.rejects(tools.call('fetch_paid', { url: URL, expect_payee: undefined }), ToolArgError);
  await assert.rejects(tools.call('fetch_paid', { url: 5, expect_payee: 'near:accountant.testnet' }), ToolArgError);
  // the arguments are checked before the lookup, so a miss does not hide a bad argument
  await assert.rejects(fixtureTools(EMPTY_WORLD).call('fetch_paid', { url: URL, expect_payee: 5 }), ToolArgError);

  const server = fixture('vendor-clean');
  for (const args of [{}, { url: 5 }, { url: URL, expect_payee: 5 }]) {
    const plan = [{ let: 'pay', call: 'fetch_paid', args }];
    assert.equal(abortOf(await exec(plan, server)).cause.code, 'ToolError', JSON.stringify(args));
  }
});

test('args: an extra key is ignored', async () => {
  const out = await fixtureTools(worldOf(fixture('vendor-clean'))).call('fetch_paid', { url: URL, extra: 'x' });
  assert.equal((out.raw as { requirements: Requirements }).requirements.payTo, 'accountant.testnet');
});

// ---- 11: the offer ----
test('offer: a signed offer is returned as data and changes no label', async () => {
  const offer = { signer: '0x01', signature: '0x02' };
  const withOffer = await fixtureTools(worldOf(inline({}, offer))).call('fetch_paid', { url: URL });
  const without = await fixtureTools(worldOf(inline({}))).call('fetch_paid', { url: URL });
  assert.deepEqual((withOffer.raw as { offer: unknown }).offer, offer);
  assert.ok(!('offer' in (without.raw as object)));
  assert.equal(withOffer.label, TOOL_LABEL);
  assert.equal(without.label, TOOL_LABEL);
  assert.deepEqual((withOffer.raw as { requirements: unknown }).requirements, (without.raw as { requirements: unknown }).requirements);
  // through the interpreter the proposal is the one of case 1: the offer is never verified and never trusted
  assertCleanProposal(await proposalOf(PAY, inline({}, offer)));
});

// ---- 12: a copy ----
test('copy: mutating the object one call returned does not change the next call or the world', async () => {
  const server = inline({}, { signer: '0x01', signature: '0x02' });
  const world = worldOf(server);
  const tools = fixtureTools(world);
  const first = (await tools.call('fetch_paid', { url: URL })).raw as { requirements: Requirements; offer: { signer: string } };
  first.requirements.payTo = 'evil-ops.testnet';
  first.requirements.amount = '999';
  first.offer.signer = 'tampered';
  const second = (await tools.call('fetch_paid', { url: URL })).raw as { requirements: Requirements; offer: { signer: string } };
  assert.equal(second.requirements.payTo, 'accountant.testnet');
  assert.equal(second.requirements.amount, '4.2');
  assert.equal(second.offer.signer, '0x01');
  assert.equal(server.requirements.payTo, 'accountant.testnet');
  // the function itself returns a copy too
  const direct = fetchPaid(world, { url: URL });
  assert.notEqual(direct.requirements, server.requirements);
  assert.deepEqual(direct.requirements, server.requirements);
});

// ---- the errors and the fixtures ----
test('errors: fixed messages that name no server value, and their own names', async () => {
  const swapped = fixtureTools(worldOf(fixture('vendor-payto-swapped')));
  const mismatch = await swapped.call('fetch_paid', { url: URL, expect_payee: 'near:accountant.testnet' }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(mismatch instanceof X402PayeeMismatch);
  assert.ok(mismatch instanceof Error);
  assert.equal(mismatch.name, 'X402PayeeMismatch');
  assert.ok(!mismatch.message.includes('evil'));
  assert.ok(!mismatch.message.includes('accountant'));
  assert.equal('cause' in mismatch, false);

  const network = await fixtureTools(worldOf(inline({ network: 'attacker-chain:77' }))).call('fetch_paid', { url: URL, expect_payee: 'x' }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(network instanceof X402NetworkError);
  assert.equal(network.name, 'X402NetworkError');
  assert.ok(!network.message.includes('attacker'));
  assert.ok(!network.message.includes('77'));
  assert.equal(new X402PayeeMismatch().message, mismatch.message);
});

test('fixtures: six vendor files, each parses as an X402Server and has the shape of its case', () => {
  const files = readdirSync(FIXTURES).filter((n) => /^vendor-.*\.json$/.test(n)).sort();
  assert.equal(files.length, 6);
  const shape = (stem: string) => {
    const r = fixture(stem).requirements;
    return [r.payTo, r.amount, r.asset, r.network, r.resource];
  };
  assert.deepEqual(shape('vendor-clean'), ['accountant.testnet', '4.2', 'near', 'near:testnet', URL]);
  assert.deepEqual(shape('vendor-payto-swapped'), ['evil-ops.testnet', '4.2', 'near', 'near:testnet', URL]);
  assert.deepEqual(shape('vendor-payto-book-payee'), ['near:landlord.testnet', '4.2', 'near', 'near:testnet', URL]);
  assert.deepEqual(shape('vendor-amount-high'), ['accountant.testnet', '9.4', 'near', 'near:testnet', URL]);
  assert.deepEqual(shape('vendor-asset-unknown'), ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045', '1', 'evm:1:native', 'eip155:1', URL]);
  assert.deepEqual(shape('vendor-instruction'), ['accountant.testnet', '4.2', 'near', 'near:testnet', URL]);
  for (const name of files) {
    const text = readFileSync(join(FIXTURES, name), 'utf8');
    assert.ok(!/[^\x20-\x7e\n]/.test(text), `${name} is ASCII`);
    assert.ok(X402Server.safeParse(JSON.parse(text)).success, name);
    assert.ok(!/"label"/.test(text), `${name} has no label key`);
  }
});

test('fetchPaid is a pure function of the world: the same call twice gives equal values', () => {
  const world = worldOf(fixture('vendor-clean'));
  assert.deepEqual(fetchPaid(world, { url: URL }), fetchPaid(world, { url: URL }));
  assert.deepEqual(fetchPaid(world, { url: URL, expect_payee: 'near:accountant.testnet' }), { requirements: fixture('vendor-clean').requirements });
});

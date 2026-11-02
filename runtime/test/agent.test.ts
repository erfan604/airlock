// AIR-164: the orchestrator. One plan instance per inbox item, batches of at most 3, deterministic action indexes, evidence before submit,
// the EVM tail on the real MPC fixture of AIR-272. Everything runs on stubs: no network, no model, no chain.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { ChainError, ChainWaitError } from '../src/chain/errors.ts';
import { requestId } from '../src/chain/ids.ts';
import { planSha256 } from '../src/dsl/index.ts';
import { scriptedLlm, setLlmOverride } from '../src/llm/index.ts';
import type { TraceEvent } from '../src/interpreter/index.ts';
import { PlanHashMismatch, feePolicyFromRegistry, planTask, runTask } from '../src/agent.ts';
import { registry } from './helpers/analyze-ctx.ts';
import {
  EVM_ASSET,
  EVM_TO,
  INBOX,
  U01,
  batchOf,
  checked,
  collect,
  evmPlan,
  evmView,
  harness,
  inboxItem,
  kinds,
  ofKind,
  outcomeFor,
  paramsOf,
  payNPlan,
  signedFrom,
} from './helpers/agent.ts';
import type { Harness } from './helpers/agent.ts';

afterEach(() => setLlmOverride(null));

const MODEL = 'z-ai/glm-5.3-flash';
const first = <T>(xs: readonly T[]): T => {
  const x = xs[0];
  assert.ok(x !== undefined, 'the list is empty');
  return x;
};
const indexes = (reqs: { action_index: number }[]): number[] => reqs.map((r) => r.action_index);
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- items ----
test('items: a poisoned item aborts alone, the others submit once with indexes 0 and 2', async () => {
  const plan = checked(U01);
  const h: Harness = harness(plan);
  const events = await collect(runTask(paramsOf(h, plan)));
  const errors = ofKind(events, 'error');
  assert.equal(errors.length, 1);
  assert.equal(first(errors).data.item, 'm2');
  assert.equal(first(errors).data.code, 'BadAmount');
  assert.equal(h.submits.length, 1);
  assert.deepEqual(indexes(first(h.submits)), [0, 2]);
  assert.deepEqual(ofKind(events, 'proposed').map((e) => e.data.item), ['m1', 'm3']);
});

test('items: the run for m2 got its own tools and read only m2', async () => {
  const plan = checked(U01);
  const h: Harness = harness(plan);
  await collect(runTask(paramsOf(h, plan, { paste: 'pasted' })));
  assert.deepEqual(h.scopes, [
    { itemId: 'm1', paste: 'pasted' },
    { itemId: 'm2', paste: 'pasted' },
    { itemId: 'm3', paste: 'pasted' },
  ]);
  assert.deepEqual(h.toolCalls, [
    { itemId: 'm1', name: 'read_inbox' },
    { itemId: 'm2', name: 'read_inbox' },
    { itemId: 'm3', name: 'read_inbox' },
  ]);
});

test('items: a plan without read_inbox runs once with itemId null, and does not ask for the inbox', async () => {
  const plan = checked(payNPlan(1));
  let asked = 0;
  const h: Harness = harness(plan, {
    over: {
      inboxItemIds: async () => {
        asked += 1;
        return ['m1'];
      },
    },
  });
  await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(h.scopes, [{ itemId: null, paste: null }]);
  assert.equal(asked, 0);
  assert.equal(h.submits.length, 1);
});

test('items: interpreter events are forwarded live, before the run is over', async () => {
  const plan = checked(U01);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let finished = false;
  const h: Harness = harness(plan, {
    inbox: [inboxItem('m1')],
    extract: async () => {
      await gate;
      finished = true;
      return { amount: '4.2', vendor: 'accountant' };
    },
  });
  const it = runTask(paramsOf(h, plan))[Symbol.asyncIterator]();
  assert.equal((await it.next()).value?.kind, 'plan');
  const call = await it.next();
  assert.equal(call.value?.kind, 'call');
  assert.equal(finished, false, 'the extractor has not answered yet');
  release();
  for (;;) if ((await it.next()).done === true) break;
  assert.equal(finished, true);
});

// ---- indexes and batches ----
test('needs another task: five pay steps with max_actions 3 submit 0 to 2 and report 3 and 4', async () => {
  const plan = checked(payNPlan(5));
  const h: Harness = harness(plan, { maxActions: 3 });
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.equal(h.submits.length, 1);
  assert.deepEqual(indexes(first(h.submits)), [0, 1, 2]);
  const needs = ofKind(events, 'error').filter((e) => e.data.code === 'NeedsAnotherTask');
  assert.deepEqual(needs.map((e) => e.data.index), [3, 4]);
  assert.deepEqual(needs.map((e) => e.data.item), [null, null]);
});

test('chunking: seven proposals with max_actions 7 make batches of 3, 3 and 1 with ascending indexes', async () => {
  const plan = checked(payNPlan(7));
  const h: Harness = harness(plan, { maxActions: 7 });
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(h.submits.map((s) => s.length), [3, 3, 1]);
  assert.deepEqual(h.submits.map(indexes), [[0, 1, 2], [3, 4, 5], [6]]);
  assert.equal(ofKind(events, 'submitted').length, 3);
  assert.equal(ofKind(events, 'verdict').length, 7);
});

test('indexes are i * K + k: with K 2 the second item starts at 2', async () => {
  const plan = checked([
    { let: 'mail', call: 'read_inbox' },
    { let: 'who', lookup: { key: 'accountant' } },
    { action: 'transfer', args: { to: { ref: 'who' }, amount: '1', asset: 'near' } },
    { action: 'transfer', args: { to: { ref: 'who' }, amount: '2', asset: 'near' } },
  ]);
  const h: Harness = harness(plan, { maxActions: 6, inbox: [inboxItem('m1'), inboxItem('m2')] });
  await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(h.submits.flat().map((r) => r.action_index), [0, 1, 2, 3]);
});

// ---- flood ----
for (const reason of ['PendingFull', 'EscalationsLocked', 'EscalationBudget']) {
  test(`flood: a blocked ${reason} in the first chunk stops the task`, async () => {
    const plan = checked(payNPlan(4));
    const h: Harness = harness(plan, {
      maxActions: 4,
      chain: (reqs, call) => batchOf(h.task, reqs.map((r, i) => outcomeFor(h.task, r, call === 0 && i === 0 ? { outcome: 'blocked', reason } : {}))),
    });
    const events = await collect(runTask(paramsOf(h, plan)));
    assert.equal(h.submits.length, 1);
    const floods = ofKind(events, 'error').filter((e) => e.data.code === 'FloodStop');
    assert.equal(floods.length, 1);
    assert.equal(first(floods).data.reason, reason);
    assert.equal(ofKind(events, 'verdict').length, 3);
  });
}

test('flood: a blocked AmountOutOfBounds is reported and the task goes on', async () => {
  const plan = checked(payNPlan(4));
  const h: Harness = harness(plan, {
    maxActions: 4,
    chain: (reqs, call) => batchOf(h.task, reqs.map((r, i) => outcomeFor(h.task, r, call === 0 && i === 0 ? { outcome: 'blocked', reason: 'AmountOutOfBounds' } : {}))),
  });
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.equal(h.submits.length, 2);
  assert.equal(ofKind(events, 'error').length, 0);
  const verdicts = ofKind(events, 'verdict');
  assert.equal(verdicts.length, 4);
  assert.equal(first(verdicts).data.outcome, 'blocked');
  assert.equal(first(verdicts).data.reason, 'AmountOutOfBounds');
});

// ---- mapping ----
test('mapping: the U01 proposal becomes the request of the ticket', async () => {
  const plan = checked(U01);
  const h: Harness = harness(plan, { inbox: [inboxItem('m1')] });
  const events = await collect(runTask(paramsOf(h, plan)));
  const req = first(first(h.submits));
  const { hints, ...rest } = req;
  assert.deepEqual(rest, {
    task_id: h.task.task_id,
    action_index: 0,
    asset: 'near',
    payee: 'near:accountant.testnet',
    amount: '4200000000000000000000000',
    labels: { recipient: 2, amount: 4128, pc: 1 },
    evm: null,
  });
  assert.equal(hints.plan_hash, h.task.plan_sha256);
  assert.match(hints.trace_digest, /^[0-9a-f]{64}$/);
  // the digest is the sha256 of the run's events as { kind, data } pairs, without t and without the item the orchestrator adds
  const run = events.filter((e) => ['call', 'extract', 'lookup', 'proposed'].includes(e.kind)).map((e) => {
    const { item, ...data } = e.data;
    void item;
    return { kind: e.kind, data };
  });
  assert.equal(hints.trace_digest, hex(sha256(new TextEncoder().encode(JSON.stringify(run)))));
});

test('evm fees: the request carries the registry policy, never the numbers a poisoned tool output names', async () => {
  const plan = checked(evmPlan());
  const h: Harness = harness(plan, {
    maxActions: 1,
    inbox: [inboxItem('m1', { gas_limit: '99999999', max_fee_per_gas: '99999999999999', max_priority_fee_per_gas: '99999999999999' })],
    chain: (reqs) => batchOf(h.task, reqs.map((r) => outcomeFor(h.task, r, { outcome: 'escalated', reason: 'x', pending_id: '1' }))),
  });
  await collect(runTask(paramsOf(h, plan)));
  const req = first(first(h.submits));
  assert.equal(req.asset, EVM_ASSET);
  assert.deepEqual(req.evm, { gas_limit: '21000', max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000000' });
});

test('evm fees: an EVM asset missing from the fee policy emits NoFeePolicy and submits nothing', async () => {
  const plan = checked(evmPlan());
  const h: Harness = harness(plan, { maxActions: 1, inbox: [inboxItem('m1')], fees: () => null });
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.equal(h.submits.length, 0);
  assert.deepEqual(ofKind(events, 'error').map((e) => e.data.code), ['NoFeePolicy']);
});

test('feePolicyFromRegistry: a native transfer for a funded EVM asset, null for near, unknown and unfunded assets', () => {
  const fees = feePolicyFromRegistry(registry());
  assert.deepEqual(fees(EVM_ASSET), { gas_limit: 21_000n, max_fee_per_gas: 2_000_000_000n, max_priority_fee_per_gas: 1_000_000_000n });
  assert.equal(fees('near'), null);
  assert.equal(fees('evm:1:native'), null);
  const entry = registry().get(EVM_ASSET);
  assert.ok(entry !== undefined);
  const with_ = (over: Partial<typeof entry>) => feePolicyFromRegistry(new Map([[EVM_ASSET, { ...entry, ...over }]]))(EVM_ASSET);
  assert.equal(with_({ maxFeePerGas: 0n }), null);
  assert.equal(with_({ maxGas: 20_999n }), null);
  assert.deepEqual(with_({ maxFeePerGas: 500_000_000n }), { gas_limit: 21_000n, max_fee_per_gas: 500_000_000n, max_priority_fee_per_gas: 500_000_000n });
});

// ---- evidence ----
test('evidence: stored for the derived id before submitBatch, with the sender and the body of the item', async () => {
  const plan = checked(U01);
  const h: Harness = harness(plan, { inbox: [inboxItem('m1')] });
  await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(h.order, ['put', 'submit']);
  const e = h.evidence.evidenceFor(requestId(h.task, 0));
  assert.equal(e?.sender, 'billing@accountant-firm.co');
  assert.equal(e?.snippet, inboxItem('m1').body);
});

test('evidence: a proposal with no origin stores nulls', async () => {
  const plan = checked(payNPlan(1));
  const h: Harness = harness(plan);
  await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(h.evidence.evidenceFor(requestId(h.task, 0)), { sender: null, snippet: null });
});

test('evidence: every chunk stores its evidence just before its own submit', async () => {
  const plan = checked(payNPlan(4));
  const h: Harness = harness(plan, { maxActions: 4 });
  await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(h.order, ['put', 'put', 'put', 'submit', 'put', 'submit']);
});

// ---- hash ----
test('hash: a plan that is not the signed one throws PlanHashMismatch before any tool call', async () => {
  const plan = checked(U01);
  let asked = 0;
  const h: Harness = harness(plan, {
    over: {
      inboxItemIds: async () => {
        asked += 1;
        return ['m1'];
      },
    },
  });
  const other = checked(payNPlan(1));
  assert.notEqual(planSha256(other), h.task.plan_sha256);
  await assert.rejects(collect(runTask(paramsOf(h, other))), PlanHashMismatch);
  assert.equal(h.scopes.length, 0);
  assert.equal(h.toolCalls.length, 0);
  assert.equal(h.submits.length, 0);
  assert.equal(asked, 0);
});

// ---- replay ----
test('replay: a request mismatch from the chain emits ReplayMismatch and stops the task', async () => {
  const plan = checked(payNPlan(4));
  const h: Harness = harness(plan, {
    maxActions: 4,
    chain: () => {
      throw new ChainError('RequestMismatch', 'request mismatch');
    },
  });
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.equal(h.submits.length, 1);
  assert.deepEqual(ofKind(events, 'error').map((e) => e.data.code), ['ReplayMismatch']);
  assert.equal(ofKind(events, 'submitted').length, 0);
});

test('replay: a recovered batch emits submitted with a null txHash and its verdicts', async () => {
  const plan = checked(U01);
  const h: Harness = harness(plan, {
    inbox: [inboxItem('m1')],
    chain: (reqs) => batchOf(h.task, reqs.map((r) => outcomeFor(h.task, r, { outcome: 'escalated', reason: 'UntrustedRecipient', pending_id: '7' })), { recovered: true, txHash: null }),
  });
  const events = await collect(runTask(paramsOf(h, plan)));
  const submitted = first(ofKind(events, 'submitted'));
  assert.equal(submitted.data.txHash, null);
  assert.equal(submitted.data.count, 1);
  assert.equal(submitted.data.taskHash, 'f'.repeat(64));
  const verdict = first(ofKind(events, 'verdict'));
  assert.deepEqual(verdict.data, { request_id: requestId(h.task, 0), outcome: 'escalated', reason: 'UntrustedRecipient', pending_id: '7', item: 'm1' });
});

// ---- the EVM tail ----
const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/real-mpc/${name}`, import.meta.url)), 'utf8').trim();
const MPC = JSON.parse(fixture('signature_response.json')) as { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };
const UNSIGNED = fixture('unsigned_tx.hex');
const SENDER = fixture('derived_address.txt');

function evmHarness(over: Parameters<typeof harness>[1] = {}) {
  const plan = checked(evmPlan());
  const h: Harness = harness(plan, {
    maxActions: 1,
    inbox: [inboxItem('m1')],
    evmSender: () => SENDER,
    getRequest: async () => evmView(h.task, UNSIGNED),
    waitSigned: async (id) => {
      h.waits.push(id);
      return signedFrom(h.task, UNSIGNED, MPC);
    },
    ...over,
  });
  return { plan, h };
}

test('evm allowed: waitSigned, getRequest, assembly and the check, then broadcast, with signed and broadcast events in order', async () => {
  const { plan, h } = evmHarness();
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(kinds(events).slice(-4), ['submitted', 'verdict', 'signed', 'broadcast']);
  assert.deepEqual(h.waits, [requestId(h.task, 0)]);
  assert.deepEqual(h.broadcasts, [fixture('signed_tx.hex')]);
  assert.deepEqual(first(ofKind(events, 'signed')).data, { request_id: requestId(h.task, 0) });
  assert.deepEqual(first(ofKind(events, 'broadcast')).data, { hash: '0xabc', status: 'success' });
  assert.equal(ofKind(events, 'error').length, 0);
  assert.ok(EVM_TO.length === 42);
});

test('evm allowed: broadcast gets the signed bytes and the configured endpoints', async () => {
  const seen: unknown[][] = [];
  const { plan, h } = evmHarness({
    broadcast: async (...args) => {
      seen.push(args);
      return { hash: '0xdef', status: 'reverted' };
    },
  });
  const events = await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(seen, [[fixture('signed_tx.hex'), ['http://rpc.invalid']]]);
  assert.deepEqual(first(ofKind(events, 'broadcast')).data, { hash: '0xdef', status: 'reverted' });
});

const waitFailures: Array<[string, ChainWaitError, boolean]> = [
  ['Timeout', new ChainWaitError('Timeout', 'not signed in time', null, false), false],
  ['Failed', new ChainWaitError('Failed', 'failed', 'MpcFailed', true), true],
  ['NotSigned', new ChainWaitError('NotSigned', 'blocked', 'x', false), false],
];
for (const [code, error, retryable] of waitFailures) {
  test(`evm allowed: waitSigned ending ${code} emits that error with retryable ${retryable} and no broadcast`, async () => {
    const { plan, h } = evmHarness({
      waitSigned: async () => {
        throw error;
      },
    });
    const events = await collect(runTask(paramsOf(h, plan)));
    const errors = ofKind(events, 'error');
    assert.equal(errors.length, 1);
    assert.equal(first(errors).data.code, code);
    assert.equal(first(errors).data.retryable, retryable);
    assert.equal(h.broadcasts.length, 0);
    assert.equal(ofKind(events, 'signed').length, 0);
  });
}

test('evm allowed: a null sender and a wrong sender are the same failure, with no broadcast', async () => {
  for (const evmSender of [() => null, () => '0x' + '11'.repeat(20)]) {
    const { plan, h } = evmHarness({ evmSender });
    const events = await collect(runTask(paramsOf(h, plan)));
    assert.deepEqual(ofKind(events, 'error').map((e) => e.data.code), ['EvmMismatch']);
    assert.equal(h.broadcasts.length, 0);
  }
});

test('evm allowed: an escalated request does not wait for a signature', async () => {
  const { plan, h } = evmHarness({
    chain: (reqs) => batchOf(h.task, reqs.map((r) => outcomeFor(h.task, r, { outcome: 'escalated', reason: 'x', pending_id: '3' }))),
  });
  await collect(runTask(paramsOf(h, plan)));
  assert.equal(h.waits.length, 0);
  assert.equal(h.broadcasts.length, 0);
});

// ---- event order and the planner door ----
test('events: U01 runs plan, call, extract, lookup, proposed, submitted, verdict', async () => {
  const plan = checked(U01);
  const h: Harness = harness(plan, { inbox: [inboxItem('m1')] });
  const events: TraceEvent[] = await collect(runTask(paramsOf(h, plan)));
  assert.deepEqual(kinds(events), ['plan', 'call', 'extract', 'lookup', 'proposed', 'submitted', 'verdict']);
  assert.deepEqual(first(events).data.planSha256, h.task.plan_sha256);
  assert.deepEqual(first(ofKind(events, 'submitted')).data, { count: 1, taskHash: 'f'.repeat(64), txHash: 'tx-hash-1' });
  assert.ok(INBOX.length === 3);
});

test('planTask returns the plan and its hash and passes the seed to the model', async () => {
  const s = scriptedLlm(() => JSON.stringify(U01));
  setLlmOverride(s.complete);
  const out = await planTask({ text: 'Pay my accountant.', ownerAccountId: 'owner.testnet', sessionId: 's1' }, MODEL, { seed: 1 });
  assert.deepEqual(Object.keys(out).sort(), ['plan', 'planSha256']);
  assert.equal(out.planSha256, planSha256(out.plan));
  assert.equal(s.calls.length, 1);
  assert.equal(first(s.calls).params?.seed, 1);
  assert.equal(first(s.calls).role, 'planner');
});

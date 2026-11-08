// AIR-160: the chain client against the real policy contract in a local sandbox (one world for the file). Run with
// `pnpm -C runtime test:chain` after `cargo near build non-reproducible-wasm --no-abi`; it is part of `scripts/check.sh full`, not of quick.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainClient } from '../../src/chain/near.ts';
import { ChainError } from '../../src/chain/errors.ts';
import { RpcPool } from '../../src/chain/rpc.ts';
import { LiveTransport } from '../../src/chain/transport.ts';
import type { ChainTransport, PreparedTx, RpcTx } from '../../src/chain/transport.ts';
import { taskHash } from '../../src/dsl/index.ts';
import type { ActionRequest, OwnerTask } from '../../src/dsl/index.ts';
import { startWorld } from '../helpers/sandbox.ts';
import type { SandboxWorld } from '../helpers/sandbox.ts';

let world: SandboxWorld;
let client: ChainClient;
let counter = 0;

const NEAR = 10n ** 24n;
const GAS = 300_000_000_000_000n;
const MASK = { owner: 1, book: 2, untrustedEmail: 32 };

before(async () => {
  world = await startWorld();
  client = new ChainClient({
    network: 'testnet',
    contractId: world.policyId,
    agentAccountId: world.agentId,
    signer: world.agentSigner,
    rpcUrls: world.rpcUrls,
    vault: world.vault,
    pollMs: 200,
    windowMs: 10000,
  });
});
after(async () => {
  await world.stop();
});

const payeeKey = (): string => `near:${world.payeeId}`;

// a fresh task per test, so no test sees another's request ids
async function newTask(maxActions = 5): Promise<OwnerTask> {
  const now = await client.latestBlockMs();
  counter += 1;
  return {
    tag: 'airlock-task-v1',
    task_id: `chain-test-${counter}`,
    contract_id: world.policyId,
    agent_id: world.agentId,
    plan_sha256: 'a'.repeat(64),
    instruction_sha256_salted: 'b'.repeat(64),
    issued_ms: now - 1000,
    expires_ms: now + 30 * 60 * 1000,
    max_actions: maxActions,
    bounds: [{ payee_key: payeeKey(), max_total: (1000n * NEAR).toString() }],
  };
}

function request(task: OwnerTask, index: number, amount: bigint, labels = { recipient: MASK.book, amount: MASK.owner, pc: MASK.owner }): ActionRequest {
  return {
    task_id: task.task_id,
    action_index: index,
    asset: 'near',
    payee: payeeKey(),
    amount: amount.toString(),
    labels,
    evm: null,
    hints: { plan_hash: task.plan_sha256, trace_digest: '0'.repeat(64) },
  };
}

test('7. (runs first) the views: policy flags, the book row, the registry, zero ledgers before any request, and the block time', async () => {
  const policy = await client.getPolicy();
  assert.equal(policy.flags.max_task_actions, 20);
  assert.equal(policy.owner_id, world.ownerId);
  assert.equal(policy.mpc_contract_id, world.mpcId);
  assert.equal(policy.paused, false);
  const book = await client.getBook();
  const row = book.find(([key]) => key === payeeKey());
  assert.ok(row);
  assert.equal(row[1].label, 'Payee');
  assert.equal(row[1].cap, (100n * NEAR).toString());
  const assets = await client.listAssets();
  const near = assets.find(([id]) => id === 'near');
  assert.ok(near);
  assert.equal(near[1].symbol, 'NEAR');
  assert.equal(near[1].decimals, 24);
  const fresh = await client.getLedgers(payeeKey(), 'near');
  assert.deepEqual([fresh.asset_day.spent, fresh.payee_day.spent, fresh.payee_untrusted_day.spent, fresh.task_spent], ['0', '0', '0', null]);
  const ms = await client.latestBlockMs();
  assert.ok(Math.abs(ms - Date.now()) < 60 * 60 * 1000, `block time ${ms} is not within an hour of now`);
});

test('1. a clean allow of 1 NEAR to the book payee: allowed, a 66 character id, submitted then allowed events, a stored request', async () => {
  const task = await newTask();
  const result = await client.submitBatch([request(task, 0, NEAR)], task, world.signTask(task));
  assert.equal(result.recovered, false);
  assert.equal(result.outcomes.length, 1);
  const outcome = result.outcomes[0];
  assert.equal(outcome?.outcome, 'allowed');
  assert.equal(outcome?.request_id.length, 66);
  assert.equal(outcome?.request_id, `${taskHash(task)}:0`);
  assert.deepEqual(result.events.slice(0, 2).map((e) => e.event), ['submitted', 'allowed']);
  assert.equal(result.events.some((e) => e.event === 'unknown_event'), false, 'every event of the contract decodes');
  assert.match(result.txHash ?? '', /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const view = await client.getRequest(outcome?.request_id ?? '');
  assert.ok(view);
  assert.ok(view.state === 'Executing' || view.state === 'Executed', `state ${view.state}`);
  assert.equal(view.agent, world.agentId);
  assert.equal(view.amount, NEAR.toString());
});

test('2. an Untrusted:email amount above the payee cap escalates with a pending id, and the pending id reads the same record', async () => {
  const task = await newTask();
  const req = request(task, 0, 150n * NEAR, { recipient: MASK.book, amount: MASK.untrustedEmail, pc: MASK.owner });
  const result = await client.submitBatch([req], task, world.signTask(task));
  const outcome = result.outcomes[0];
  assert.equal(outcome?.outcome, 'escalated');
  assert.ok(outcome?.pending_id !== null && outcome?.pending_id !== undefined);
  assert.equal(outcome?.reason, 'UntrustedAmount');
  const byPending = await client.getRequest(outcome?.pending_id ?? '');
  const byId = await client.getRequest(outcome?.request_id ?? '');
  assert.ok(byPending);
  assert.deepEqual(byPending, byId);
  assert.equal(byPending.state, 'Pending');
  assert.equal(byPending.id, outcome?.pending_id);
  assert.ok(result.events.some((e) => e.event === 'escalated'));
});

test('3. a pc mask of 0 is blocked for MissingProvenance', async () => {
  const task = await newTask();
  const req = request(task, 0, NEAR, { recipient: MASK.book, amount: MASK.owner, pc: 0 });
  const result = await client.submitBatch([req], task, world.signTask(task));
  assert.equal(result.outcomes[0]?.outcome, 'blocked');
  assert.equal(result.outcomes[0]?.reason, 'MissingProvenance');
  const view = await client.getRequest(result.outcomes[0]?.request_id ?? '');
  assert.equal(view?.state, 'Blocked');
  assert.equal(view?.reason, 'MissingProvenance');
});

test('4. submitting the same batch twice returns equal outcomes and charges once', async () => {
  const task = await newTask();
  const sig = world.signTask(task);
  const req = request(task, 0, 2n * NEAR);
  const first = await client.submitBatch([req], task, sig);
  const ledgersFirst = await client.getLedgers(payeeKey(), 'near', taskHash(task));
  const second = await client.submitBatch([req], task, sig);
  const ledgersSecond = await client.getLedgers(payeeKey(), 'near', taskHash(task));
  assert.deepEqual(second.outcomes, first.outcomes);
  assert.equal(second.recovered, true, 'the second call found the request and sent nothing');
  assert.deepEqual(ledgersSecond, ledgersFirst);
  assert.equal(ledgersSecond.task_spent, (2n * NEAR).toString(), 'one charge of 2 NEAR for this task');
});

test('5. the same index with another amount throws RequestMismatch, before a send and when the contract is made to refuse it', async () => {
  const task = await newTask();
  const sig = world.signTask(task);
  await client.submitBatch([request(task, 0, NEAR)], task, sig);
  const changed = request(task, 0, 3n * NEAR);
  await assert.rejects(client.submitBatch([changed], task, sig), (error: unknown) => error instanceof ChainError && error.code === 'RequestMismatch');

  // a client that cannot see the stored request sends, and the contract's own `request mismatch` is mapped to the same code
  const live = new LiveTransport({ contractId: world.policyId, agentAccountId: world.agentId, signer: world.agentSigner, pool: new RpcPool(world.rpcUrls) });
  const blind: ChainTransport = {
    contractId: live.contractId,
    view: (method, args) => (method === 'get_request' ? Promise.resolve(null) : live.view(method, args)),
    prepare: (method, args, gas) => live.prepare(method, args, gas),
    submit: (tx: PreparedTx): Promise<RpcTx> => live.submit(tx),
    txStatus: (hash) => live.txStatus(hash),
    blockNanosec: () => live.blockNanosec(),
  };
  const blindClient = new ChainClient({ network: 'testnet', contractId: world.policyId, agentAccountId: world.agentId, transport: blind, pollMs: 100, windowMs: 1000 });
  await assert.rejects(blindClient.submitBatch([changed], task, sig), (error: unknown) => {
    return error instanceof ChainError && error.code === 'RequestMismatch' && error.txHash !== null;
  });
});

test('8. a PreparedTx sent twice through LiveTransport.submit returns the same hash both times and charges once', async () => {
  const task = await newTask();
  const req = request(task, 0, 4n * NEAR);
  const live = new LiveTransport({ contractId: world.policyId, agentAccountId: world.agentId, signer: world.agentSigner, pool: new RpcPool(world.rpcUrls) });
  const args = { reqs: [{ ...req, book: world.vault.proofFor(req.payee) }], task, task_sig: Buffer.from(world.signTask(task)).toString('base64') };
  const prepared = await live.prepare('submit_batch', args, GAS);
  const first = await live.submit(prepared);
  const second = await live.submit(prepared);
  assert.equal(first.failure, null);
  assert.equal(first.hash, prepared.hash, 'the hash known before sending is the outcome hash');
  assert.equal(second.hash, first.hash);
  const ledgers = await client.getLedgers(payeeKey(), 'near', taskHash(task));
  assert.equal(ledgers.task_spent, (4n * NEAR).toString(), 'one charge');
  assert.equal(await live.txStatus(prepared.hash).then((s) => (s !== null && s !== 'pending' ? s.hash : s)), prepared.hash);
  assert.equal(await live.txStatus('11111111111111111111111111111111'), null);
});

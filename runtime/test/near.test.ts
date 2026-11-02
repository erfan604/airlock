// AIR-160: the chain client over a scripted transport (no network, no keys; pollMs 5, windowMs 100). The point of the first group: a
// batch is signed once, sent at most twice with the same bytes, and nothing is resubmitted while an outcome is unknown inside a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessKeyRequiresFullAccessActionError, InvalidNonceError } from 'near-api-js/rpc-errors';
import { ChainClient, outcomeFromView } from '../src/chain/near.ts';
import { ChainError, ChainWaitError } from '../src/chain/errors.ts';
import { parseRequestView } from '../src/chain/types.ts';
import type { RequestView } from '../src/chain/types.ts';
import { ScriptedTransport, allowedOutcome, clientOver, failTx, idOf, okTx, rawView, req, sig, storeAll, task, transportError } from './helpers/chain-double.ts';

const code = (expected: string) => (error: unknown) => error instanceof ChainError && error.code === expected;
const waitCode = (expected: string, retryable: boolean) => (error: unknown) =>
  error instanceof ChainWaitError && error.code === expected && error.retryable === retryable;

// ---- idempotent submit ----

test('a clean batch is signed once, sent once, and returns the contract outcomes and the decoded events', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => okTx([0, 1]));
  const result = await clientOver(t).submitBatch([req(0), req(1)], task, sig);
  assert.equal(t.prepared.length, 1);
  assert.equal(t.sent.length, 1);
  assert.equal(result.recovered, false);
  assert.equal(result.txHash, 'HASH1');
  assert.deepEqual(result.outcomes.map((o) => o.request_id), [idOf(0), idOf(1)]);
  assert.equal(result.taskHash, idOf(0).split(':')[0]);
  const args = t.lastArgs as { reqs: unknown[]; task_sig: string };
  assert.equal(args.reqs.length, 2);
  assert.equal(args.task_sig, Buffer.from(sig).toString('base64'));
});

test('a first send that throws, with every request visible afterwards: one prepare, one send, recovered from the views', async () => {
  const t = new ScriptedTransport();
  const reqs = [req(0), req(1)];
  t.submitSteps.push(() => {
    storeAll(t, reqs); // the batch executed, only the reply was lost
    throw transportError();
  });
  const result = await clientOver(t).submitBatch(reqs, task, sig);
  assert.equal(t.prepared.length, 1);
  assert.equal(t.sent.length, 1);
  assert.equal(result.recovered, true);
  assert.equal(result.txHash, null);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.outcomes, [allowedOutcome(0), allowedOutcome(1)]);
  assert.equal(result.views.length, 2);
});

test('a send that throws twice with no request ever appearing sends exactly twice, the same bytes, then throws Unknown', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => { throw transportError(); }, () => { throw transportError(); });
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), code('Unknown'));
  assert.equal(t.prepared.length, 1, 'signed once');
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[0], t.sent[1], 'the very same PreparedTx');
  assert.equal(t.sent[0]?.hash, t.sent[1]?.hash);
});

test('the second send happens only after a full poll window of looking', async () => {
  const t = new ScriptedTransport();
  const sentAt: number[] = [];
  t.submitSteps.push(() => { sentAt.push(Date.now()); throw transportError(); }, () => { sentAt.push(Date.now()); throw transportError(); });
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), code('Unknown'));
  const [a, b] = sentAt as [number, number];
  assert.ok(b - a >= 95, `the resend came ${b - a} ms after the first send`);
  assert.ok(t.statusCalls >= 2, 'the status was looked up while waiting');
});

test('a send that throws, then a final status lookup, gives that outcome with no second send', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => { throw transportError(); });
  t.statusSteps.push('pending', okTx([0], 'HASH1'));
  const result = await clientOver(t).submitBatch([req(0)], task, sig);
  assert.equal(t.sent.length, 1);
  assert.equal(result.recovered, false);
  assert.equal(result.txHash, 'HASH1');
  assert.equal(result.outcomes[0]?.outcome, 'allowed');
});

test('a final status lookup that is a failure is final: no resend', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => { throw transportError(); });
  t.statusSteps.push(failTx('task actions exhausted'));
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), code('Panic'));
  assert.equal(t.sent.length, 1);
});

test('InvalidNonceError with a status lookup that does not know the hash: the second send is a fresh prepare, and there is no third', async () => {
  const t = new ScriptedTransport();
  const nonce = () => new InvalidNonceError(6, 6, 'h', 'b');
  t.submitSteps.push(() => { throw nonce(); }, () => okTx([0], 'HASH2'));
  const result = await clientOver(t).submitBatch([req(0)], task, sig);
  assert.equal(t.prepared.length, 2);
  assert.notEqual(t.prepared[0]?.hash, t.prepared[1]?.hash);
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1], t.prepared[1]);
  assert.equal(result.txHash, 'HASH2');

  const t2 = new ScriptedTransport();
  t2.submitSteps.push(() => { throw nonce(); }, () => { throw nonce(); });
  await assert.rejects(clientOver(t2).submitBatch([req(0)], task, sig), code('Unknown'));
  assert.equal(t2.sent.length, 2, 'never a third send');
  assert.equal(t2.prepared.length, 2);
});

test('InvalidNonceError while the first bytes turn out to be known (pending): the second send reuses them', async () => {
  const t = new ScriptedTransport();
  t.statusSteps.push('pending');
  t.submitSteps.push(() => { throw new InvalidNonceError(6, 6, 'h', 'b'); }, () => { throw transportError(); });
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), code('Unknown'));
  assert.equal(t.prepared.length, 1);
  assert.equal(t.sent[0], t.sent[1]);
});

test('a failure of request mismatch throws RequestMismatch after one send', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => failTx('request mismatch'));
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), code('RequestMismatch'));
  assert.equal(t.sent.length, 1);
});

test('a failure of UsedRequestId returns the batch recovered from the read-back views, with no second send', async () => {
  const t = new ScriptedTransport();
  const reqs = [req(0), req(1)];
  t.submitSteps.push(() => {
    storeAll(t, reqs, 'Executed');
    return failTx('request_id already used (UsedRequestId)');
  });
  const result = await clientOver(t).submitBatch(reqs, task, sig);
  assert.equal(t.sent.length, 1);
  assert.equal(result.recovered, true);
  assert.equal(result.txHash, null);
  assert.deepEqual(result.views.map((v) => v.state), ['Executed', 'Executed']);
  assert.equal(result.outcomes.every((o) => o.outcome === 'allowed'), true);
});

test('a contract refusal throws Panic with the hash and is never retried', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => failTx('task actions exhausted'));
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), (error: unknown) => {
    return error instanceof ChainError && error.code === 'Panic' && error.txHash === 'HASH1' && error.message === 'task actions exhausted';
  });
  assert.equal(t.sent.length, 1);
  assert.equal(t.prepared.length, 1);
});

test('with every id already present and no retry the batch is returned recovered and nothing is signed or sent', async () => {
  const t = new ScriptedTransport();
  const reqs = [req(0), req(1)];
  storeAll(t, reqs, 'Executed');
  const result = await clientOver(t).submitBatch(reqs, task, sig);
  assert.equal(t.prepared.length, 0);
  assert.equal(t.sent.length, 0);
  assert.equal(result.recovered, true);
  assert.equal(result.outcomes.length, 2);
});

test('retry: true with a Retryable id sends once, and with a Pending id throws NotRetryable and sends nothing', async () => {
  const t = new ScriptedTransport();
  storeAll(t, [req(0)], 'Retryable');
  t.submitSteps.push(() => {
    storeAll(t, [req(0)], 'Executing'); // the one rerun the contract allows
    return okTx([0]);
  });
  const result = await clientOver(t).submitBatch([req(0)], task, sig, { retry: true });
  assert.equal(t.sent.length, 1);
  assert.equal(result.outcomes[0]?.outcome, 'allowed');

  const pending = new ScriptedTransport();
  pending.views.set(idOf(0), rawView(req(0), 'Pending', { id: '7', reason: 'NewRecipient' }));
  await assert.rejects(clientOver(pending).submitBatch([req(0)], task, sig, { retry: true }), code('NotRetryable'));
  assert.equal(pending.prepared.length, 0);
  assert.equal(pending.sent.length, 0);

  const missing = new ScriptedTransport();
  await assert.rejects(clientOver(missing).submitBatch([req(0)], task, sig, { retry: true }), code('NotRetryable'));
  assert.equal(missing.sent.length, 0);
});

test('in retry mode a request that is still Retryable is not taken for a landed retry', async () => {
  const t = new ScriptedTransport();
  storeAll(t, [req(0)], 'Retryable');
  t.submitSteps.push(() => { throw transportError(); }, () => { throw transportError(); });
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig, { retry: true }), code('Unknown'));
  assert.equal(t.sent.length, 2);

  const landed = new ScriptedTransport();
  storeAll(landed, [req(0)], 'Retryable');
  landed.submitSteps.push(() => {
    storeAll(landed, [req(0)], 'Executing');
    throw transportError();
  });
  const result = await clientOver(landed).submitBatch([req(0)], task, sig, { retry: true });
  assert.equal(result.recovered, true);
  assert.equal(landed.sent.length, 1);
});

test('a returned outcome with another request id than the derived one throws IdMismatch', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => ({ hash: 'HASH1', returnValue: [{ ...allowedOutcome(0), request_id: idOf(1) }], logs: [], failure: null }));
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), code('IdMismatch'));
});

test('a returned answer of the wrong length or shape throws BadResponse', async () => {
  const wrongLength = new ScriptedTransport();
  wrongLength.submitSteps.push(() => okTx([0]));
  await assert.rejects(clientOver(wrongLength).submitBatch([req(0), req(1)], task, sig), code('BadResponse'));
  const junk = new ScriptedTransport();
  junk.submitSteps.push(() => ({ hash: 'HASH1', returnValue: 'nope', logs: [], failure: null }));
  await assert.rejects(clientOver(junk).submitBatch([req(0)], task, sig), code('BadResponse'));
});

test('a batch of 0 or 4 requests, or a request of another task, is refused before any call', async () => {
  const t = new ScriptedTransport();
  const c = clientOver(t);
  await assert.rejects(c.submitBatch([], task, sig), code('BadBatch'));
  await assert.rejects(c.submitBatch([req(0), req(1), req(2), req(3)], task, sig), code('BadBatch'));
  await assert.rejects(c.submitBatch([req(0, { task_id: 'another-task' })], task, sig), code('BadBatch'));
  assert.equal(t.viewCalls.length, 0);
  assert.equal(t.prepared.length, 0);
});

test('an id that exists with other content is a RequestMismatch before any send', async () => {
  const t = new ScriptedTransport();
  storeAll(t, [req(0, { amount: '5' })]);
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), code('RequestMismatch'));
  assert.equal(t.sent.length, 0);
});

test('an escalated request keeps its pending id in the returned outcome', async () => {
  const t = new ScriptedTransport();
  const escalated = { request_id: idOf(0), outcome: 'escalated', reason: 'UntrustedAmount', pending_id: '3' };
  t.submitSteps.push(() => ({ hash: 'HASH1', returnValue: [escalated], logs: [], failure: null }));
  const result = await clientOver(t).submitBatch([req(0)], task, sig);
  assert.deepEqual(result.outcomes, [escalated]);
});

test('a RequiresFullAccess refusal maps to NotRetryable at once, with no poll and no resend', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => { throw new AccessKeyRequiresFullAccessActionError(0, 'h', 'b'); });
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), (error: unknown) => {
    return error instanceof ChainError && error.code === 'NotRetryable' && error.message.includes('RequiresFullAccess');
  });
  assert.equal(t.sent.length, 1);
  assert.equal(t.statusCalls, 0);
});

test('errors of the client never carry key or signature material', async () => {
  const t = new ScriptedTransport();
  t.submitSteps.push(() => { throw transportError(); }, () => { throw transportError(); });
  const signature = Buffer.from(sig).toString('base64');
  await assert.rejects(clientOver(t).submitBatch([req(0)], task, sig), (error: unknown) => {
    return error instanceof Error && !error.message.includes(signature) && !/ed25519:|private/i.test(error.message);
  });
});

// ---- outcomeFromView ----

const view = (state: string, extra: Record<string, unknown> = {}): RequestView => {
  const parsed = parseRequestView(rawView(req(0), state, extra));
  assert.ok(parsed);
  return parsed;
};

test('outcomeFromView: Pending is escalated with the pending id, Blocked is blocked with the reason', () => {
  assert.deepEqual(outcomeFromView(view('Pending', { id: '7', reason: 'NewRecipient' })), {
    request_id: idOf(0),
    outcome: 'escalated',
    reason: 'NewRecipient',
    pending_id: '7',
  });
  assert.deepEqual(outcomeFromView(view('Blocked', { reason: 'MissingProvenance' })), {
    request_id: idOf(0),
    outcome: 'blocked',
    reason: 'MissingProvenance',
    pending_id: null,
  });
});

test('outcomeFromView: Executing, Executed, Failed and Retryable are allowed; Rejected and Expired are escalated', () => {
  for (const state of ['Executing', 'Executed', 'Failed', 'Retryable']) {
    assert.deepEqual(outcomeFromView(view(state)), allowedOutcome(0), state);
  }
  for (const state of ['Rejected', 'Expired']) assert.equal(outcomeFromView(view(state, { id: '2' })).outcome, 'escalated', state);
});

// ---- views ----

test('getBook of 53 rows makes two calls (50, then 3) and returns 53 rows', async () => {
  const t = new ScriptedTransport();
  const entry = { cap: '100', daily_untrusted_budget: '1000', daily_limit: '5000', label: 'Payee' };
  const rows = Array.from({ length: 53 }, (_, i) => [`near:payee${i}.test.near`, entry]);
  t.answers.set('get_book', (args: Record<string, unknown>) => rows.slice(args.from_index as number, (args.from_index as number) + (args.limit as number)));
  const book = await clientOver(t).getBook();
  assert.equal(book.length, 53);
  assert.deepEqual(t.viewCalls.map((c) => c.args), [{ from_index: 0, limit: 50 }, { from_index: 50, limit: 50 }]);
});

test('getBook of exactly 50 rows makes a second call that returns none', async () => {
  const t = new ScriptedTransport();
  const entry = { cap: null, daily_untrusted_budget: '1', daily_limit: '2', label: 'A' };
  const rows = Array.from({ length: 50 }, (_, i) => [`near:payee${i}.test.near`, entry]);
  t.answers.set('get_book', (args: Record<string, unknown>) => rows.slice(args.from_index as number, (args.from_index as number) + (args.limit as number)));
  const book = await clientOver(t).getBook();
  assert.equal(book.length, 50);
  assert.equal(t.viewCalls.length, 2);
});

test('latestBlockMs divides the nanosecond text with BigInt and truncates', async () => {
  const t = new ScriptedTransport();
  t.nanos = '1800000000123456789';
  assert.equal(await clientOver(t).latestBlockMs(), 1800000000123);
  t.nanos = 'not a number';
  await assert.rejects(clientOver(t).latestBlockMs(), code('BadResponse'));
});

test('getPolicy keeps a u64 as its decimal string and refuses a malformed answer', async () => {
  const t = new ScriptedTransport();
  t.answers.set('get_policy', {
    owner_id: 'test.near',
    mpc_contract_id: 'mpc.test.near',
    requires_tee: false,
    paused: false,
    flags: { max_pending_per_agent: 3, pending_ttl_ms: '3600000', hourly_escalation_budget: 6, lock_consecutive_rejects: 3, lock_rejects_per_day: 20, max_task_ttl_ms: '3600000', max_task_actions: 20 },
  });
  const policy = await clientOver(t).getPolicy();
  assert.equal(policy.flags.max_task_ttl_ms, '3600000');
  assert.equal(policy.flags.max_task_actions, 20);
  t.answers.set('get_policy', { owner_id: 'test.near' });
  await assert.rejects(clientOver(t).getPolicy(), code('BadResponse'));
});

test('getRequest: JSON null is null, a tombstone is filled in with tombstone: true, absent optional keys are null', async () => {
  const t = new ScriptedTransport();
  const c = clientOver(t);
  assert.equal(await c.getRequest(idOf(0)), null);
  t.views.set('9', { request_id: idOf(1), id: null, state: 'Expired' });
  const tomb = await c.getRequest('9');
  assert.ok(tomb);
  assert.equal(tomb.tombstone, true);
  assert.deepEqual([tomb.agent, tomb.task_id, tomb.asset, tomb.payee, tomb.amount, tomb.created_ms], ['', '', '', '', '0', '0']);
  assert.deepEqual(tomb.labels, { recipient: 0, amount: 0, pc: 0 });
  assert.deepEqual([tomb.reason, tomb.book_status, tomb.display, tomb.expires_ms, tomb.digest, tomb.exec], [null, null, null, null, null, null]);
  t.views.set(idOf(0), rawView(req(0)));
  const full = await c.getRequest(idOf(0));
  assert.ok(full);
  assert.equal(full.tombstone, undefined);
  assert.deepEqual([full.reason, full.digest, full.exec, full.expires_ms, full.display], [null, null, null, null, null]);
});

test('getRequest refuses an answer that is neither a record nor a tombstone', async () => {
  const t = new ScriptedTransport();
  const c = clientOver(t);
  t.views.set(idOf(0), { request_id: idOf(0), id: null, state: 'Executing', amount: '1' }); // no agent but content: neither shape
  await assert.rejects(c.getRequest(idOf(0)), code('BadResponse'));
  t.views.set(idOf(1), { request_id: idOf(1), id: null, state: 'Weird' });
  await assert.rejects(c.getRequest(idOf(1)), code('BadResponse'));
});

test('getLedgers sends the task hash or null, and refuses a task that is not 64 lowercase hex', async () => {
  const t = new ScriptedTransport();
  const zero = { spent: '0', cap: '5000', remaining: '5000' };
  t.answers.set('get_ledgers', { asset_day: zero, payee_day: zero, payee_untrusted_day: zero, task_spent: null });
  const c = clientOver(t);
  const ledgers = await c.getLedgers('near:payee.test.near', 'near');
  assert.equal(ledgers.task_spent, null);
  assert.deepEqual(t.viewCalls[0]?.args, { payee: 'near:payee.test.near', asset: 'near', task: null });
  await c.getLedgers('near:payee.test.near', 'near', 'a'.repeat(64));
  assert.equal(t.viewCalls[1]?.args.task, 'a'.repeat(64));
  await assert.rejects(c.getLedgers('near:payee.test.near', 'near', 'A'.repeat(64)), RangeError);
});

test('listAssets returns the registry pairs', async () => {
  const t = new ScriptedTransport();
  const entry = { symbol: 'NEAR', decimals: 24, hard_cap: '1', daily_cap: '2', max_fee_per_gas: '0', max_gas: '0', quick_task_cap: '3', path: null };
  t.answers.set('list_assets', [['near', entry]]);
  const assets = await clientOver(t).listAssets();
  assert.deepEqual(assets, [['near', entry]]);
});

// ---- waitSigned ----

const exec = { unsigned_hex: '02aa', big_r: '02' + 'b'.repeat(64), s: 'c'.repeat(64), recovery_id: 1 };

test('waitSigned returns the SignedEvent of an Executed request with its exec fields', async () => {
  const t = new ScriptedTransport();
  t.views.set(idOf(0), rawView(req(0), 'Executed', { exec }));
  const signed = await clientOver(t).waitSigned(idOf(0), 1000);
  assert.deepEqual(signed, { request_id: idOf(0), ...exec });
});

test('waitSigned keeps waiting through Pending and Executing, then returns', async () => {
  const t = new ScriptedTransport();
  t.views.set(idOf(0), rawView(req(0), 'Pending', { id: '1' }));
  const c = clientOver(t);
  setTimeout(() => t.views.set(idOf(0), rawView(req(0), 'Executing')), 20);
  setTimeout(() => t.views.set(idOf(0), rawView(req(0), 'Executed', { exec })), 40);
  const signed = await c.waitSigned(idOf(0), 2000);
  assert.equal(signed.recovery_id, 1);
});

test('waitSigned throws Failed (retryable or not), NotSigned and Timeout', async () => {
  const t = new ScriptedTransport();
  const c = clientOver(t);
  t.views.set(idOf(0), rawView(req(0), 'Retryable', { reason: 'MpcFailed' }));
  await assert.rejects(c.waitSigned(idOf(0), 500), waitCode('Failed', true));
  t.views.set(idOf(0), rawView(req(0), 'Failed', { reason: 'MpcFailed' }));
  await assert.rejects(c.waitSigned(idOf(0), 500), (error: unknown) => waitCode('Failed', false)(error) && (error as ChainWaitError).reason === 'MpcFailed');
  for (const state of ['Blocked', 'Rejected', 'Expired']) {
    t.views.set(idOf(0), rawView(req(0), state));
    await assert.rejects(c.waitSigned(idOf(0), 500), waitCode('NotSigned', false), state);
  }
  t.views.set(idOf(0), rawView(req(0), 'Pending', { id: '1' }));
  await assert.rejects(c.waitSigned(idOf(0), 60), waitCode('Timeout', false));
  t.views.delete(idOf(0));
  await assert.rejects(c.waitSigned(idOf(0), 30), waitCode('Timeout', false));
});

// ---- construction ----

test('a client needs a signer or a transport', () => {
  const base = { network: 'testnet' as const, contractId: 'policy.test.near', agentAccountId: 'agent.test.near' };
  assert.throws(() => new ChainClient(base as unknown as ConstructorParameters<typeof ChainClient>[0]), TypeError);
  assert.ok(new ChainClient({ ...base, transport: new ScriptedTransport() }));
});

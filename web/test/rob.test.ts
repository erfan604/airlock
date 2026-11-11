// AIR-356: the /rob page's request builder, slot picker, answer decoder and sender, on a mocked RPC (no request reaches a node).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRESETS, amountOf, answerOf, batchArgs, failureOf, failureWords, payeeOf, pickSlot, reasonShort, reasonWords, send, wishOf } from '../src/live/rob.ts';
import type { Wish } from '../src/live/rob.ts';
import type { TryPublic } from '../src/live/tryPublic.ts';
import vector from './fixtures/tx-vector.json' with { type: 'json' };

import { AGENT, NOW, POLICY, PROOF, PUB, SHOP } from './fixtures/robPub.ts';

test('rob: typed payees and amounts are validated; text never becomes anything but a payee key or a decimal', () => {
  assert.equal(payeeOf('alice'), 'near:alice.testnet');
  assert.equal(payeeOf('Alice.Near'), 'near:alice.near');
  assert.equal(payeeOf('near:bob.testnet'), 'near:bob.testnet');
  for (const bad of ['', 'a b', '<img>', 'x'.repeat(70), '-x']) assert.equal(payeeOf(bad), null, bad);
  assert.equal(amountOf('0.005'), '5000000000000000000000');
  for (const bad of ['0', '-1', '1e3', 'abc', '2000']) assert.equal(amountOf(bad), null, bad);
});

test('rob: the presets become the requests a hijacked agent would send, and the honest one is the owner\'s own', () => {
  assert.equal(PRESETS.length, 4);
  const w = (id: string): Wish => wishOf({ kind: 'preset', id }, PUB) as Wish;
  assert.deepEqual(w('stranger'), { payee: 'near:my-own-wallet.testnet', asset: 'near', amount: '5000000000000000000000', honest: false });
  assert.deepEqual(w('more'), { payee: SHOP, asset: 'near', amount: '8000000000000000000000', honest: false });
  assert.deepEqual(w('coin'), { payee: 'sol:devnet:11111111111111111111111111111111', asset: 'sol:devnet', amount: '1000000', honest: false });
  assert.deepEqual(w('honest'), { payee: SHOP, asset: 'near', amount: PUB.honestAmount, honest: true });
  assert.deepEqual(wishOf({ kind: 'own', payee: 'x y', amount: '1' }, PUB), { refuse: 'Type an account name, like alice or alice.near.' });
});

test('rob: attack requests carry Untrusted:web on all three labels; only the honest one carries Owner; the shop gets its proof; no origin', () => {
  const t = PUB.tasks[0] as TryPublic['tasks'][number];
  const attack = batchArgs(wishOf({ kind: 'preset', id: 'more' }, PUB) as Wish, PUB, t, 7) as { reqs: Record<string, unknown>[]; task: unknown; task_sig: string };
  const r = attack.reqs[0] as Record<string, unknown>;
  assert.deepEqual(r['labels'], { recipient: 64, amount: 64, pc: 64 });
  assert.deepEqual(r['book'], PROOF);
  assert.equal(r['action_index'], 7);
  assert.equal(r['task_id'], 'try-1-1');
  assert.equal(typeof r['amount'], 'string');
  assert.deepEqual(r['hints'], { plan_hash: 'a'.repeat(64), trace_digest: '0'.repeat(64) });
  assert.equal(attack.task, t.task);
  const honest = (batchArgs(wishOf({ kind: 'preset', id: 'honest' }, PUB) as Wish, PUB, t, 0) as { reqs: Record<string, unknown>[] }).reqs[0] as Record<string, unknown>;
  assert.deepEqual(honest['labels'], { recipient: 1, amount: 1, pc: 1 });
  assert.deepEqual(honest['book'], PROOF);
  const stranger = (batchArgs(wishOf({ kind: 'preset', id: 'stranger' }, PUB) as Wish, PUB, t, 0) as { reqs: Record<string, unknown>[] }).reqs[0] as Record<string, unknown>;
  assert.equal('book' in stranger, false);
  for (const q of [r, honest, stranger]) assert.equal('origin' in (q['hints'] as object), false);
});

test('rob: the slot picker skips a used request id and gives up after five', async () => {
  const asked: string[] = [];
  let n = 0;
  const view = async (_m: string, args: object): Promise<unknown> => {
    asked.push((args as { id: string }).id);
    return n++ < 2 ? { state: 'Pending' } : null;
  };
  const slot = await pickSlot(PUB, view, () => 0.5, NOW);
  assert.equal(asked.length, 3);
  assert.equal(slot?.index, 49);
  assert.match(asked[0] ?? '', /^[0-9]{64}:49$/);
  const never = await pickSlot(PUB, async () => ({ used: true }), () => 0.1, NOW);
  assert.equal(never, null);
  assert.equal(await pickSlot({ ...PUB, tasks: [] }, view, () => 0, NOW), null);
});

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');

test('rob: the answer decoder maps allowed, escalated and blocked; a failed call is a failure with its message', () => {
  const out = (o: unknown) => ({ status: { SuccessValue: b64([o]) } });
  assert.deepEqual(answerOf(out({ request_id: 'h:1', outcome: 'blocked', reason: 'AmountOutOfBounds', pending_id: null })), { kind: 'blocked', reason: 'AmountOutOfBounds', requestId: 'h:1' });
  assert.deepEqual(answerOf(out({ request_id: 'h:2', outcome: 'escalated', reason: 'OutsideTask', pending_id: '4' })), { kind: 'held', reason: 'OutsideTask', requestId: 'h:2' });
  assert.deepEqual(answerOf(out({ request_id: 'h:3', outcome: 'allowed', reason: null, pending_id: null })), { kind: 'paid', reason: null, requestId: 'h:3' });
  assert.equal(answerOf({ status: { SuccessValue: b64('x') } }), null);
  assert.equal(failureOf({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: request id already used' } } } } } }), 'Smart contract panicked: request id already used');
  assert.equal(failureOf({ status: { SuccessValue: '' } }), null);
  assert.match(reasonWords('PendingFull'), /Fifty requests are already waiting/);
  assert.equal(reasonWords('SomethingNew'), 'SomethingNew');
  // a reason inside a failed call's message is said in words, with its code; a used slot says what to do; anything else is quoted
  assert.deepEqual(failureWords('Smart contract panicked: DailyLimit'), { words: reasonWords('DailyLimit'), code: 'DailyLimit' });
  assert.match(failureWords('Smart contract panicked: request id already used').words, /Send it again/);
  assert.match(failureWords('Smart contract panicked: odd').words, /with the message: Smart contract panicked: odd\.$/);
  // every reason the practice card can give has a plain sentence and a short form, never the bare code
  for (const code of ['OutsideTask', 'OverTaskBound', 'UntrustedTrigger', 'UntrustedRecipient', 'NewRecipient', 'UntrustedAmount', 'AmountOutOfBounds', 'DailyLimit', 'UnknownAsset', 'PendingFull']) {
    assert.notEqual(reasonWords(code), code);
    assert.notEqual(reasonShort(code), code);
  }
  // the bigger amount to the booked shop comes back as the trigger rule (rule 7 runs before the amount rules): the sentence says so
  assert.match(reasonWords('UntrustedTrigger'), /before it looks at the payee or the amount/);
});

type Call = { method: string; params: Record<string, unknown> };

function chain(answers: { sendTx: (n: number) => unknown }, log: Call[]): typeof fetch {
  let sends = 0;
  return (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Call;
    log.push(body);
    const ok = (result: unknown): Response => Response.json({ jsonrpc: '2.0', id: 'airlock', result });
    if (body.method === 'send_tx') {
      const a = answers.sendTx(sends++);
      if (a instanceof Response) return a;
      return ok(a);
    }
    if (body.params['request_type'] === 'view_access_key') return ok({ nonce: 10, block_hash: vector.blockHash });
    // get_request: unused
    return ok({ result: Array.from(new TextEncoder().encode('null')) });
  }) as unknown as typeof fetch;
}

/** The signer, receiver, method and deposit of a signed transaction, read from its borsh bytes. */
function decoded(b64tx: string): { signer: string; receiver: string; method: string; deposit: bigint } {
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
  at += 4 + b.readUInt32LE(at) + 8;
  return { signer, receiver, method, deposit: b.readBigUInt64LE(at) + (b.readBigUInt64LE(at + 8) << 64n) };
}

test('rob: send signs one submit_batch as the try agent on the try policy with deposit 0 and returns the contract\'s answer', async () => {
  const log: Call[] = [];
  let t = NOW;
  const fetchFn = chain({ sendTx: () => ({ status: { SuccessValue: b64([{ request_id: 'x:1', outcome: 'escalated', reason: 'OutsideTask', pending_id: '3' }]) } }) }, log);
  const r = await send(PUB, wishOf({ kind: 'preset', id: 'stranger' }, PUB) as Wish, { rpc: { rpcUrls: ['https://rpc.example'], fetch: fetchFn }, random: () => 0.3, now: () => (t += 1000) });
  assert.equal(r.kind, 'answer');
  if (r.kind !== 'answer') return;
  assert.deepEqual(r.answer, { kind: 'held', reason: 'OutsideTask', requestId: 'x:1' });
  assert.ok(r.ms > 0 && r.tx.length > 40);
  const sent = log.filter((c) => c.method === 'send_tx');
  assert.equal(sent.length, 1);
  assert.deepEqual(decoded(String(sent[0]?.params['signed_tx_base64'])), { signer: AGENT, receiver: POLICY, method: 'submit_batch', deposit: 0n });
});

test('rob: a nonce clash is tried once more with another key, then the page says the network refused', async () => {
  const log: Call[] = [];
  const clash = () => Response.json({ jsonrpc: '2.0', id: 'airlock', error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, message: 'InvalidNonce' } });
  const twice = chain({ sendTx: (n) => (n === 0 ? clash() : { status: { SuccessValue: b64([{ request_id: 'x:1', outcome: 'blocked', reason: 'AmountOutOfBounds' }]) } }) }, log);
  const r = await send(PUB, wishOf({ kind: 'preset', id: 'stranger' }, PUB) as Wish, { rpc: { rpcUrls: ['https://rpc.example'], fetch: twice }, random: () => 0.1, now: () => NOW });
  assert.equal(r.kind, 'answer');
  assert.equal(log.filter((c) => c.method === 'send_tx').length, 2);
  const always = chain({ sendTx: () => clash() }, []);
  const r2 = await send(PUB, wishOf({ kind: 'preset', id: 'stranger' }, PUB) as Wish, { rpc: { rpcUrls: ['https://rpc.example'], fetch: always }, random: () => 0.1, now: () => NOW });
  assert.equal(r2.kind, 'unavailable');
});

test('rob: a file naming a credit account is refused before any signing', async () => {
  const log: Call[] = [];
  const r = await send({ ...PUB, agent: 'agent.airlock-credit-c1108d.testnet' }, { payee: SHOP, asset: 'near', amount: '1', honest: false }, { rpc: { rpcUrls: ['https://rpc.example'], fetch: chain({ sendTx: () => null }, log) }, random: () => 0, now: () => NOW });
  assert.equal(r.kind, 'unavailable');
  assert.equal(log.length, 0);
});

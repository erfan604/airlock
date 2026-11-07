// AIR-320: the hosted Steal this agent board. The classifier and the board math run on recorded real responses of the FastNEAR transaction API
// (web/fixtures/challenge-fastnear-*.json, fetched 2026-11-03 for policy-v2.erfan-airlock.testnet: eight submit_batch transactions, two signed by
// the key below) and a recorded get_book view of the challenge policy. The command builder and the published file parser are checked against the
// submit_batch argument shape of runtime/src/chain/near.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boardOf, classifyTx, listedOf, readBook, readChain } from '../src/challenge/chainBoard.ts';
import { batchArgs, commandOf, hostedChallengeApi, parseHosted } from '../src/challenge/hosted.ts';

const fx = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(fileURLToPath(new URL('../fixtures/', import.meta.url)), name), 'utf8')) as Record<string, unknown>;
const page = fx('challenge-fastnear-account-page.json') as { account_txs: { transaction_hash: string }[] };
const txs = fx('challenge-fastnear-transactions.json') as { transactions: { transaction: { hash: string; signer_id: string }; receipts: unknown[] }[] };
const bookView = fx('challenge-get-book.json');

const POLICY = 'policy-v2.erfan-airlock.testnet';
const KEY = 'ed25519:7HeWNqtLJHGzmsjPZn9LbPgAgjVBpFPn4vrqTgjDcPfP';
const AGENT = 'erfan-agent.testnet'; // the signer of the recorded attempts
const BOOK = ['near:accountant.erfan-airlock.testnet'];
const ALLOWED_TX = '6XaB7gpdo9rvCoupNnLM7WHudfnhnAwVhdquy2RzGqB5';
const HELD_TX = 'ED95Qh2t1rvAUmkG2ZkDrrz3pdQ32LB9oY3AAWteqESp';

/** a fake FastNEAR: the recorded listing and transactions, and the recorded get_book view */
function chain(o: { hide?: Set<string>; fail?: boolean; book?: unknown } = {}): typeof fetch {
  return (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const json = (v: unknown, status = 200): Promise<Response> => Promise.resolve(new Response(JSON.stringify(v), { status }));
    if (o.fail === true) return json({}, 503);
    if (url.endsWith('/v0/account')) return json({ ...page, resume_token: null });
    if (url.endsWith('/v0/transactions')) {
      const hashes = body['tx_hashes'] as string[];
      return json({ transactions: txs.transactions.filter((t) => hashes.includes(t.transaction.hash) && o.hide?.has(t.transaction.hash) !== true) });
    }
    return json(o.book ?? bookView);
  };
}

test('recorded transactions: only the published key counts, each request with the contract verdict, tx hash and block time', async () => {
  const read = await readChain(chain({ book: { result: { result: Array.from(new TextEncoder().encode(JSON.stringify([[BOOK[0], {}]]))) } } }), { policy: POLICY, publicKey: KEY });
  assert.equal(read.attempts.length, 2, 'two of the eight recorded transactions were signed by this key');
  const byTx = new Map(read.attempts.map((a) => [a.tx, a] as const));
  const allowed = byTx.get(ALLOWED_TX);
  const held = byTx.get(HELD_TX);
  assert.deepEqual([allowed?.verdict, allowed?.reason, allowed?.payments[0]?.toBook, allowed?.door, allowed?.mode], ['Allow', null, true, 'key', 'live']);
  assert.deepEqual([held?.verdict, held?.reason], ['Escalate', 'OverTaskBound']);
  assert.ok(Number.isFinite(Date.parse(allowed?.at ?? '')) && Date.parse(allowed?.at ?? '') > Date.parse('2026-11-01'));
  assert.deepEqual(read.attempts.map((a) => a.seq), [1, 2]);
  assert.equal(read.truncated, false);
});

test('board math: an allowed payment to the book is paid, not stolen; the same payment with an empty book is stolen', async () => {
  const withBook = boardOf((await readChain(chain({ book: { result: { result: Array.from(new TextEncoder().encode(JSON.stringify([[BOOK[0], {}]]))) } } }), { policy: POLICY, publicKey: KEY })).attempts);
  assert.equal(withBook.attempts, 2);
  assert.deepEqual([withBook.allow, withBook.escalate, withBook.block], [1, 1, 0]);
  assert.equal(withBook.stolenYocto, '0');
  assert.equal(withBook.paidToBookYocto, '4200000000000000000000000');
  assert.equal(withBook.heldYocto.length > 1, true);
  assert.deepEqual(withBook.doors, { text: 0, key: 2, seed: 0 });
  const noBook = boardOf((await readChain(chain({ book: { result: { result: Array.from(new TextEncoder().encode('[]')) } } }), { policy: POLICY, publicKey: KEY })).attempts);
  assert.equal(noBook.stolenYocto, '4200000000000000000000000', 'with nothing in the book the allowed payment is outside it');
  assert.equal(noBook.paidToBookYocto, '0');
});

test('a transaction without a final policy receipt is left out, never guessed; a failed read throws', async () => {
  const noReceipt = classifyTx({ ...txs.transactions.find((t) => t.transaction.hash === ALLOWED_TX), receipts: [] }, POLICY, KEY, new Set(BOOK));
  assert.deepEqual(noReceipt, { state: 'pending' });
  const read = await readChain(chain({ hide: new Set([ALLOWED_TX]) }), { policy: POLICY, publicKey: KEY });
  assert.deepEqual(read.attempts.map((a) => a.tx), [HELD_TX]);
  await assert.rejects(readChain(chain({ fail: true }), { policy: POLICY, publicKey: KEY }));
  assert.deepEqual(classifyTx({ nonsense: 1 }, POLICY, KEY, new Set()), { state: 'skip' });
  assert.deepEqual(classifyTx(txs.transactions[0], POLICY, 'ed25519:' + '1'.repeat(44), new Set()), { state: 'skip' }, 'another key');
});

test('the published key added to some other account does not count: only the challenge agent signs attempts', () => {
  const real = txs.transactions.find((t) => t.transaction.hash === ALLOWED_TX)!;
  const agent = real.transaction.signer_id;
  assert.equal(classifyTx(real, POLICY, KEY, new Set(BOOK), agent).state, 'final');
  const other = { ...real, transaction: { ...real.transaction, signer_id: 'someone-else.testnet' } };
  assert.deepEqual(classifyTx(other, POLICY, KEY, new Set(BOOK), agent), { state: 'skip' });
});

test('the listing skips failed transactions and reads the block time in nanoseconds', () => {
  const l = listedOf({ account_txs: [{ transaction_hash: 'A'.repeat(44), tx_block_height: 5, tx_block_timestamp: '1793741422198692627', is_success: true }, { transaction_hash: 'B'.repeat(44), tx_block_height: 6, tx_block_timestamp: '1793741422198692627', is_success: false }], resume_token: 'r' });
  assert.deepEqual(l.txs, [{ hash: 'A'.repeat(44), height: 5, atMs: 1793741422198 }]);
  assert.equal(l.resume, 'r');
  assert.throws(() => listedOf({}));
});

test('get_book: the recorded view of the challenge policy gives the three booked payees', async () => {
  const keys = await readBook(chain(), 'challenge.erfan-airlock.testnet');
  assert.equal(keys.length, 3);
  assert.ok(keys.every((k) => k.startsWith('near:') && k.endsWith('.erfan-airlock.testnet')));
});

const TASK = { task: { tag: 't', task_id: 'tid', contract_id: 'pol.testnet', agent_id: 'agt.testnet', plan_sha256: 'ab'.repeat(32), expires_ms: 4_000_000_000_000, max_actions: 255, bounds: [] }, task_sig: 'c2ln', issuedAt: 'x', expiresAt: 'y', permits: { payee: 'near:b.testnet', asset: 'NEAR', maxTotal: '2', maxActions: 255, agent: 'agt.testnet', contract: 'pol.testnet', ttlMinutes: 1 } };
const PUB = { format: 'airlock-challenge-public-v1', policy: 'pol.testnet', agent: 'agt.testnet', publicKey: `ed25519:${'1'.repeat(44)}`, secretKey: `ed25519:${'2'.repeat(88)}`, allowance: '1 NEAR', tasks: [TASK] };

test('the published file is parsed strictly: testnet accounts, key shapes, and at least one task', () => {
  assert.ok(parseHosted(PUB) !== null);
  assert.equal(parseHosted({ ...PUB, policy: 'pol.near' }), null);
  assert.equal(parseHosted({ ...PUB, secretKey: 'ed25519:short' }), null);
  assert.equal(parseHosted({ ...PUB, tasks: [] }), null);
  assert.equal(parseHosted({ ...PUB, format: 'other' }), null);
  assert.equal(parseHosted(null), null);
});

test('the command carries the submit_batch arguments of runtime/src/chain/near.ts: reqs, task, task_sig, an owner label claim and a zero trace digest', () => {
  const h = parseHosted(PUB);
  assert.ok(h !== null);
  const args = batchArgs(h.tasks[0] as never, 'near:thief.testnet', '1000000000000000000000000', 7) as { reqs: Record<string, unknown>[]; task: unknown; task_sig: string };
  assert.deepEqual(Object.keys(args), ['reqs', 'task', 'task_sig']);
  assert.deepEqual(args.reqs[0], { task_id: 'tid', action_index: 7, asset: 'near', payee: 'near:thief.testnet', amount: '1000000000000000000000000', labels: { recipient: 1, amount: 1, pc: 1 }, evm: null, hints: { plan_hash: 'ab'.repeat(32), trace_digest: '0'.repeat(64) } });
  const cmd = commandOf(h, h.tasks[0] as never, 'near:thief.testnet', '1', 7);
  assert.ok(cmd.startsWith("near contract call-function as-transaction pol.testnet submit_batch json-args '{"));
  assert.ok(cmd.includes("prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as agt.testnet network-config testnet sign-with-plaintext-private-key ed25519:"));
  assert.ok(cmd.endsWith(' send'));
  assert.ok(!args.task_sig.includes("'"), 'no single quote can break out of the shell argument');
});

test('the hosted api: no published file gives an empty board and no key; a file gives the board, the key, the command and a shut text door', async () => {
  const none = hostedChallengeApi({ fetchFn: () => Promise.resolve(new Response('', { status: 404 })), publicUrl: '/x.json' });
  const s0 = await none.state();
  assert.equal(s0.key, null);
  assert.equal(s0.board.attempts, 0);
  assert.equal(s0.doorTextOpen, false);
  const api = hostedChallengeApi({
    publicUrl: '/x.json',
    random: () => 0,
    fetchFn: (input, init) => (String(input).endsWith('/x.json') ? Promise.resolve(new Response(JSON.stringify({ ...PUB, policy: POLICY, agent: AGENT, publicKey: KEY }))) : chain()(input, init)),
  });
  const s = await api.state();
  assert.equal(s.hosted, true);
  assert.equal(s.board.attempts, 2);
  assert.equal(s.key?.secretKey, PUB.secretKey);
  assert.ok(s.command?.includes(`submit_batch json-args '`) && s.command.includes('"action_index":0'));
  assert.equal((await api.attempts(50)).length, 2);
  assert.deepEqual(await api.attempt('text'), { ok: false, code: 'hosted', retryAfterSeconds: null });
});

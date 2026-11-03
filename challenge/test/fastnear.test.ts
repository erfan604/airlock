// The FastNEAR key source against recorded responses: transactions of policy-v2.erfan-airlock.testnet fetched from tx.test.fastnear.com on
// 2026-11-03 (the account listing and the full transactions, receipts trimmed to the policy's own). The published key in these tests is the
// agent key that signed two of the recorded submit_batch calls; the other recorded calls were signed by other keys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FastNearKeySource, observationsOf } from '../src/fastnear.ts';
import { KeyWatcher } from '../src/watcher.ts';
import { rig } from './helpers.ts';

const fx = (name: string): { [k: string]: unknown } => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as { [k: string]: unknown };
const page = fx('fastnear-account-page.json') as { account_txs: Array<{ transaction_hash: string; tx_block_height: number }>; resume_token: string };
const txs = fx('fastnear-transactions.json') as { transactions: Array<{ transaction: { hash: string } }> };

const POLICY = 'policy-v2.erfan-airlock.testnet';
const KEY = 'ed25519:7HeWNqtLJHGzmsjPZn9LbPgAgjVBpFPn4vrqTgjDcPfP';
const BOOK = new Set(['near:accountant.erfan-airlock.testnet']);
const ALLOWED_TX = '6XaB7gpdo9rvCoupNnLM7WHudfnhnAwVhdquy2RzGqB5';
const HELD_TX = 'ED95Qh2t1rvAUmkG2ZkDrrz3pdQ32LB9oY3AAWteqESp';

interface Calls {
  account: Array<Record<string, unknown>>;
  txs: string[][];
}

// a fake indexer: serves the recorded account page (optionally in several pages) and the recorded transactions by hash
function indexer(o: { pages?: Array<typeof page.account_txs>; hide?: Set<string>; status?: number } = {}): { fetchFn: typeof fetch; calls: Calls } {
  const calls: Calls = { account: [], txs: [] };
  const pages = o.pages ?? [page.account_txs];
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const json = (v: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(v), { status: o.status ?? 200 }));
    if (url.endsWith('/v0/account')) {
      calls.account.push(body);
      const at = body['resume_token'] === undefined ? 0 : +String(body['resume_token']).replace('p', '');
      const next = at + 1 < pages.length ? `p${String(at + 1)}` : null;
      return json({ account_txs: pages[at] ?? [], resume_token: next });
    }
    const hashes = body['tx_hashes'] as string[];
    calls.txs.push(hashes);
    return json({ transactions: txs.transactions.filter((t) => hashes.includes(t.transaction.hash) && o.hide?.has(t.transaction.hash) !== true) });
  };
  return { fetchFn, calls };
}

const source = (fetchFn: typeof fetch, extra = {}): FastNearKeySource => new FastNearKeySource({ policy: POLICY, publicKey: KEY, bookKeys: () => Promise.resolve(BOOK), fetchFn, ...extra });

test('recorded transactions: only submit_batch calls signed by the published key become observations, with the contract verdicts', async () => {
  const { fetchFn, calls } = indexer();
  const got = await source(fetchFn).poll();
  assert.equal(got.length, 2, 'two of the eight recorded transactions were signed by this key');
  const byTx = new Map(got.map((o) => [o.tx, o] as const));
  const allowed = byTx.get(ALLOWED_TX);
  const held = byTx.get(HELD_TX);
  assert.deepEqual([allowed?.outcome, allowed?.reason, allowed?.toBook, allowed?.payee, allowed?.amount], ['ALLOW', null, true, 'near:accountant.erfan-airlock.testnet', '4200000000000000000000000']);
  assert.deepEqual([held?.outcome, held?.reason], ['ESCALATE', 'OverTaskBound']);
  assert.match(allowed?.requestId ?? '', /^[0-9a-f]{64}:0$/);
  assert.equal(calls.account[0]?.['account_id'], POLICY);
  assert.equal(calls.account[0]?.['is_function_call'], true);
  assert.deepEqual(calls.txs.flat().sort(), page.account_txs.map((t) => t.transaction_hash).sort());
});

test('a second poll over the same listing asks for nothing again and returns nothing', async () => {
  const { fetchFn, calls } = indexer();
  const s = source(fetchFn);
  await s.poll();
  const before = calls.txs.length;
  assert.deepEqual(await s.poll(), []);
  assert.equal(calls.txs.length, before, 'no transaction is fetched twice');
});

test('a transaction the indexer lists but cannot return yet is asked again, and shows up once it is returned', async () => {
  const hide = new Set([ALLOWED_TX]);
  const { fetchFn } = indexer({ hide });
  const s = source(fetchFn);
  assert.deepEqual((await s.poll()).map((o) => o.tx), [HELD_TX]);
  hide.delete(ALLOWED_TX);
  assert.deepEqual((await s.poll()).map((o) => o.tx), [ALLOWED_TX]);
  assert.deepEqual(await s.poll(), []);
});

test('paging: follows the resume token, stops at a page that reaches a known block and keeps oldest first', async () => {
  const all = page.account_txs;
  const { fetchFn, calls } = indexer({ pages: [all.slice(0, 3), all.slice(3, 6), all.slice(6)] });
  const got = await source(fetchFn).poll();
  assert.equal(calls.account.length, 3);
  assert.equal(calls.account[1]?.['resume_token'], 'p1');
  const heights = got.map((o) => all.find((t) => t.transaction_hash === o.tx)?.tx_block_height ?? 0);
  assert.deepEqual(heights, [...heights].sort((a, b) => a - b));
  const { fetchFn: f2, calls: c2 } = indexer({ pages: [all.slice(0, 3), all.slice(3, 6)] });
  const s = source(f2, { maxPages: 1 });
  await s.poll();
  assert.equal(c2.account.length, 1, 'one page per poll when maxPages is 1');
});

test('an indexer error or an unexpected answer throws, and the watcher turns it into a quiet round', async () => {
  await assert.rejects(source(indexer({ status: 500 }).fetchFn).poll());
  const odd: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ nope: true })));
  await assert.rejects(source(odd).poll());
  const r = rig();
  const w = new KeyWatcher(source(indexer({ status: 500 }).fetchFn), r.built.challenge);
  assert.equal(await w.tick(), 0);
  assert.equal(r.built.log.size, 0);
});

test('end to end with the watcher: the recorded held request and the recorded payment land on the board once, door key, nothing stolen', async () => {
  const r = rig();
  const w = new KeyWatcher(source(indexer().fetchFn), r.built.challenge);
  assert.equal(await w.tick(), 2);
  assert.equal(await w.tick(), 0);
  const b = r.built.log.scoreboard();
  assert.deepEqual([b.attempts, b.escalate, b.allow, b.doors.key, b.stolenYocto], [2, 1, 1, 2, '0']);
  assert.ok(r.built.log.latest(2).every((a) => a.door === 'key' && a.tx !== null));
});

test('observationsOf: a payee outside the book is marked so, and other keys, other receivers and failed calls give nothing', () => {
  const held = txs.transactions.find((t) => t.transaction.hash === HELD_TX);
  assert.equal(observationsOf(held, POLICY, KEY, new Set())[0]?.toBook, false);
  assert.deepEqual(observationsOf(held, POLICY, 'ed25519:Other', BOOK), []);
  assert.deepEqual(observationsOf(held, 'another.testnet', KEY, BOOK), []);
  const failed = JSON.parse(JSON.stringify(held)) as { receipts: Array<{ execution_outcome: { outcome: { status: Record<string, unknown> } } }> };
  for (const rc of failed.receipts) rc.execution_outcome.outcome.status = { Failure: {} };
  assert.deepEqual(observationsOf(failed, POLICY, KEY, BOOK), []);
  assert.deepEqual(observationsOf({ junk: 1 }, POLICY, KEY, BOOK), []);
});

// a fake indexer whose listing and transaction bodies the test can change between polls
interface Ctl {
  pages: Array<typeof page.account_txs>;
  tweak: (tx: { transaction: { hash: string }; receipts: Array<{ execution_outcome: { outcome: { status: Record<string, unknown> } } }> }) => unknown;
}
function live(ctl: Ctl): { fetchFn: typeof fetch; accountBodies: Array<Record<string, unknown>> } {
  const accountBodies: Array<Record<string, unknown>> = [];
  const fetchFn: typeof fetch = (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const json = (v: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(v)));
    if (String(input).endsWith('/v0/account')) {
      accountBodies.push(body);
      const at = body['resume_token'] === undefined ? 0 : +String(body['resume_token']).replace('p', '');
      return json({ account_txs: ctl.pages[at] ?? [], resume_token: at + 1 < ctl.pages.length ? `p${String(at + 1)}` : null });
    }
    const hashes = body['tx_hashes'] as string[];
    return json({ transactions: txs.transactions.filter((t) => hashes.includes(t.transaction.hash)).map((t) => ctl.tweak(JSON.parse(JSON.stringify(t)) as Parameters<Ctl['tweak']>[0])).filter((t) => t !== null) });
  };
  return { fetchFn, accountBodies };
}

test('maxPages 1 over a multi page listing: the unread pages are continued from their resume token on the next polls, nothing is skipped', async () => {
  const all = page.account_txs;
  const pages = [all.slice(0, 2), all.slice(2, 4), all.slice(4, 6), all.slice(6)];
  const ctl: Ctl = { pages, tweak: (t) => t };
  const { fetchFn, accountBodies } = live(ctl);
  const s = source(fetchFn, { maxPages: 1 });
  const seen: string[] = [];
  const rounds: string[][] = [];
  for (let i = 0; i < 6; i += 1) {
    const got = (await s.poll()).map((o) => o.tx ?? '');
    rounds.push(got);
    seen.push(...got);
  }
  // the listing is [4A9E, ED95] [6XaB, F83w] ...: ED95 is on page 0 and 6XaB on page 1, so the second one arrives a round later
  assert.deepEqual(rounds[0], [HELD_TX]);
  assert.deepEqual(rounds[1], [ALLOWED_TX]);
  assert.deepEqual([...seen].sort(), [ALLOWED_TX, HELD_TX].sort(), 'each of the two exactly once');
  const tokens = accountBodies.map((b) => b['resume_token']).filter((t) => t !== undefined);
  assert.ok(tokens.includes('p1') && tokens.includes('p2') && tokens.includes('p3'), `the gap is walked page by page: ${tokens.join(',')}`);
});

test('a new transaction listed while an older gap is still being read is not lost', async () => {
  const all = page.account_txs;
  const ctl: Ctl = { pages: [all.slice(0, 2), all.slice(2, 4), all.slice(4)], tweak: (t) => t };
  const { fetchFn } = live(ctl);
  const s = source(fetchFn, { maxPages: 1 });
  await s.poll();
  // the newest page now starts with a transaction above every height seen: ALLOWED_TX is moved up as if it had just happened
  const newest = { ...(all.find((t) => t.transaction_hash === ALLOWED_TX) as (typeof all)[number]), tx_block_height: (all[0]?.tx_block_height ?? 0) + 100 };
  ctl.pages = [[newest, ...all.slice(0, 2)], all.slice(2, 4), all.slice(4)];
  const got = (await s.poll()).map((o) => o.tx);
  assert.ok(got.includes(ALLOWED_TX));
});

test('a policy receipt without a final status is not done: the transaction is asked again, even when the listing no longer shows it', async () => {
  let phase: 'pending' | 'noreceipt' | 'final' = 'pending';
  const ctl: Ctl = {
    pages: [page.account_txs],
    tweak: (t) => {
      if (t.transaction.hash !== ALLOWED_TX || phase === 'final') return t;
      if (phase === 'noreceipt') return { ...t, receipts: [] };
      for (const r of t.receipts) r.execution_outcome.outcome.status = { SuccessReceiptId: 'later' };
      return t;
    },
  };
  const { fetchFn } = live(ctl);
  const s = source(fetchFn);
  assert.deepEqual((await s.poll()).map((o) => o.tx), [HELD_TX], 'only the final one lands');
  ctl.pages = [[]];
  phase = 'noreceipt';
  assert.deepEqual(await s.poll(), [], 'no receipt yet, still waiting');
  phase = 'final';
  assert.deepEqual((await s.poll()).map((o) => o.tx), [ALLOWED_TX], 'it lands once the receipt is final');
  assert.deepEqual(await s.poll(), [], 'and only once');
});

test('a policy receipt that Failed is final: it is done and adds nothing', async () => {
  const ctl: Ctl = {
    pages: [page.account_txs],
    tweak: (t) => {
      if (t.transaction.hash === ALLOWED_TX) for (const r of t.receipts) r.execution_outcome.outcome.status = { Failure: {} };
      return t;
    },
  };
  const { fetchFn } = live(ctl);
  const s = source(fetchFn);
  assert.deepEqual((await s.poll()).map((o) => o.tx), [HELD_TX]);
  assert.deepEqual(await s.poll(), []);
});

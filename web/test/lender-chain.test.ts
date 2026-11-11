// AIR-359: the lender count, the attacks while in, the price history and the loop line, on transactions shaped like FastNEAR's (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attacksIn, attacksOnCards } from '../src/lender/attacks.ts';
import { checkedHistory, clock, clockSeconds, countdown, foldPrices, joinOf, loopSentence, loopStatus, parseSchedule, sinceJoined, valueLine } from '../src/lender/history.ts';
import type { Schedule } from '../src/lender/history.ts';
import { countLenders, isTeam, poolEvents, readAccountTxs } from '../src/lender/lenders.ts';
import type { PoolTx } from '../src/lender/lenders.ts';

const POOL = 'pool.airlock-credit-c1108d.testnet';
const CARD = 'card.airlock-credit-c1108d.testnet';
const N = (x: number): string => (BigInt(Math.round(x * 1000)) * 10n ** 21n).toString();
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');
let seq = 0;

function poolTx(atMs: number, signer: string, event: string | null, data: Record<string, unknown> = {}, failed = false): PoolTx {
  const hash = `PoolTxHash${String(++seq).padStart(20, '0')}`;
  const logs = event === null ? [] : [`EVENT_JSON:${JSON.stringify({ standard: 'airlock-credit', version: '1.0.0', event, data: [data] })}`];
  return {
    hash,
    atMs,
    body: {
      transaction: { hash, signer_id: signer, receiver_id: POOL, public_key: 'ed25519:x', actions: [{ FunctionCall: { method_name: event ?? 'deposit', args: b64({}) } }] },
      receipts: [{ receipt: { predecessor_id: signer }, execution_outcome: { outcome: { executor_id: POOL, logs, status: failed ? { Failure: {} } : { SuccessValue: '' } } } }],
    },
  };
}

const LP1 = 'lp1.airlock-credit-c1108d.testnet';
const ME = 'lender-aaaaaaaaaa.testnet';
const GONE = 'lender-bbbbbbbbbb.testnet';
const FAILED = 'lender-cccccccccc.testnet';

const TXS: PoolTx[] = [
  poolTx(1000, LP1, 'deposit', { account: LP1, amount: N(2), shares: N(2) }),
  poolTx(2000, 'iss.testnet', 'line_opened', { card: CARD, borrower: 'b.testnet', limit: N(1), fee_bps: 1000, due_ms: '9' }),
  poolTx(3000, 'b.testnet', 'repaid', { card: CARD, amount: N(1.1), fee: N(0.1) }),
  poolTx(4000, ME, 'deposit', { account: ME, amount: N(1.05), shares: N(1) }),
  poolTx(4500, FAILED, null, {}, true),
  poolTx(5000, GONE, 'deposit', { account: GONE, amount: N(2.1), shares: N(2) }),
  poolTx(6000, GONE, 'withdraw', { account: GONE, amount: N(2.1), shares: N(2) }),
  poolTx(6500, 'x.airlock-credit-c1108d.testnet', 'deposit', { account: 'x.airlock-credit-c1108d.testnet', amount: N(1.05), shares: N(1) }),
];
const LIVE = { assets: BigInt(N(2 + 0.1 + 1.05 + 1.05)), shares: BigInt(N(4)) };

test('lenders: team accounts are exact ids, parents and sub-accounts of parents', () => {
  assert.equal(isTeam(LP1), true);
  assert.equal(isTeam('airlock-credit-c1108d.testnet'), true);
  assert.equal(isTeam('archc0ff40bf4e.testnet'), true);
  assert.equal(isTeam('x.erfan-airlock.testnet'), true);
  assert.equal(isTeam('lender-aaaaaaaaaa.testnet'), false);
  assert.equal(isTeam('notairlock-credit-c1108d.testnet'), false, 'a suffix match needs the dot');
});

test('lenders: a failed deposit is not counted, team accounts are out, and zero shares is "so far" but not "now"', async () => {
  const events = poolEvents(TXS, POOL);
  const shares: Record<string, bigint> = { [ME]: BigInt(N(1)), [GONE]: 0n };
  const c = await countLenders(events, false, async (a) => ({ shares: shares[a] ?? 0n, value: 0n, lockedUntilMs: 0 }));
  assert.deepEqual(c.soFar, [ME, GONE]);
  assert.equal(c.now, 1);
  assert.equal(c.soFar.includes(FAILED), false);
});

test('lenders: the listing is read page by page up to the limit, then fetched 20 at a time, oldest first', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const pageTx = (i: number) => ({ transaction_hash: `ListedHash${String(i).padStart(20, '0')}`, tx_block_height: i, tx_block_timestamp: String(BigInt(1_794_000_000_000 + i) * 1_000_000n), is_success: true });
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith('/v0/account')) {
      const page = body['resume_token'] === undefined ? 0 : Number(body['resume_token']);
      return Response.json({ account_txs: Array.from({ length: 25 }, (_, k) => pageTx(page * 25 + k)), resume_token: String(page + 1) });
    }
    const hashes = body['tx_hashes'] as string[];
    return Response.json({ transactions: hashes.map((h) => ({ transaction: { hash: h }, receipts: [] })) });
  }) as unknown as typeof fetch;
  const r = await readAccountTxs(fetchFn, POOL, { pageLimit: 25, maxPages: 2 });
  assert.equal(r.truncated, true);
  assert.equal(r.txs.length, 50);
  assert.equal(calls.filter((c) => c.url.endsWith('/v0/account')).length, 2);
  assert.deepEqual(calls.filter((c) => c.url.endsWith('/v0/transactions')).map((c) => (c.body['tx_hashes'] as string[]).length), [20, 20, 10]);
  assert.equal(calls[0]?.body['is_function_call'], true);
  assert.ok((r.txs[0]?.atMs ?? 0) < (r.txs[49]?.atMs ?? 0));
});

test('history: the fold ends at the live assets and shares; a mismatch hides it', () => {
  const events = poolEvents(TXS, POOL);
  const h = checkedHistory(events, LIVE, ME);
  assert.ok(h !== null);
  assert.equal(h.at(-1)?.price, 1_050_000_000_000_000_000_000_000n);
  assert.equal(checkedHistory(events, { ...LIVE, assets: LIVE.assets + 1n }), null);
  const line = valueLine(h);
  assert.equal(line[0]?.value, BigInt(N(1.05)));
  assert.equal(line.at(-1)?.value, BigInt(N(1.05)));
});

test('history: a default books its loss, a sweep during the line is neutral and one after the default adds back', () => {
  const events = poolEvents(
    [
      poolTx(1, LP1, 'deposit', { account: LP1, amount: N(2), shares: N(2) }),
      poolTx(2, 'i', 'line_opened', { card: CARD, borrower: 'b', limit: N(1), fee_bps: 1000, due_ms: '9' }),
      poolTx(3, CARD, 'swept', { card: CARD, amount: N(0.2) }),
      poolTx(4, 'anyone', 'defaulted', { card: CARD, seized: N(0.3), loss: N(0.5) }),
      poolTx(5, CARD, 'swept', { card: CARD, amount: N(0.1) }),
    ],
    POOL,
  );
  const p = foldPrices(events);
  assert.ok(p !== null);
  assert.equal(p.at(-1)?.assets, BigInt(N(2 - 0.5 + 0.1)));
  // a default with the collateral covering principal and part of the fee raises the price by the fee covered
  const covered = foldPrices(poolEvents([poolTx(1, LP1, 'deposit', { account: LP1, amount: N(2), shares: N(2) }), poolTx(2, 'i', 'line_opened', { card: CARD, borrower: 'b', limit: N(0.1), fee_bps: 1000, due_ms: '9' }), poolTx(3, 'a', 'defaulted', { card: CARD, seized: N(0.12), loss: '0' })], POOL));
  assert.equal(covered?.at(-1)?.assets, BigInt(N(2.01)));
  // a default of a line the page never saw opened cannot be folded
  assert.equal(foldPrices(poolEvents([poolTx(1, 'a', 'defaulted', { card: CARD, seized: '0', loss: '0' })], POOL)), null);
});

const SCHEDULE: Schedule = { loopCard: CARD, loopSince: '2026-11-11T00:00:00Z', pauses: [{ from: '2026-11-11T15:00:00Z', to: '2026-11-11T22:00:00Z', why: 'the pool contract is being upgraded' }] };
const T = (iso: string): number => Date.parse(iso);

test('loop: before loopSince nothing is a cycle and the page says the loop has not started', () => {
  const events = poolEvents(TXS, POOL);
  assert.deepEqual(loopStatus(events, { ...SCHEDULE, loopSince: null }, T('2026-11-11T02:00:00Z')), { kind: 'not-started' });
  assert.deepEqual(loopStatus(events, SCHEDULE, T('2026-11-11T02:00:00Z')), { kind: 'not-started' }, 'the repay at t=3000 is before loopSince');
  assert.match(loopSentence({ kind: 'not-started' }), /has not started/);
  assert.deepEqual(sinceJoined(events, { ...SCHEDULE, loopSince: null }, 0), { borrowed: 0, repaid: 0, feeBps: null });
});

test('loop: a recent cycle is running, an old one is stale, a planned pause wins', () => {
  const at = T('2026-11-11T05:00:00Z');
  const events = poolEvents([poolTx(at - 60 * 60_000, 'i', 'line_opened', { card: CARD, borrower: 'b', limit: N(0.09), fee_bps: 1000, due_ms: '9' }), poolTx(at - 59 * 60_000, 'b', 'repaid', { card: CARD, amount: N(0.099), fee: N(0.009) })], POOL);
  assert.equal(loopStatus(events, SCHEDULE, at).kind, 'running');
  assert.equal(loopStatus(events, SCHEDULE, at + 20 * 60_000).kind, 'stale');
  assert.match(loopSentence({ kind: 'stale', last: at }), /^The hourly loop has not run since \d\d:\d\d [A-Z][A-Za-z0-9+:-]*\. It runs on the team's computer, which may be off\.$/);
  assert.equal(loopStatus(events, SCHEDULE, T('2026-11-11T16:00:00Z')).kind, 'paused');
  assert.deepEqual(sinceJoined(events, SCHEDULE, at - 2 * 60 * 60_000), { borrowed: 1, repaid: 1, feeBps: 1000n });
  assert.deepEqual(sinceJoined(events, SCHEDULE, at), { borrowed: 0, repaid: 0, feeBps: null });
});

test('schedule: the shipped file parses, a broken one is refused', async () => {
  const shipped = (await import('../public/lender/schedule.json', { with: { type: 'json' } })).default as unknown;
  assert.ok(parseSchedule(shipped) !== null);
  assert.equal(parseSchedule({ loopCard: CARD, loopSince: 'yesterday', pauses: [] }), null);
});

test('join: the first deposit of the account gives the time and transaction', () => {
  const j = joinOf(poolEvents(TXS, POOL), ME);
  assert.equal(j?.atMs, 4000);
  assert.equal(joinOf(poolEvents(TXS, POOL), FAILED), null);
});

function cardTx(atMs: number, card: string, outcome: 'allowed' | 'escalated' | 'blocked', payee: string, signer = 'agent.airlock-credit-c1108d.testnet'): PoolTx {
  const hash = `CardTxHash${String(++seq).padStart(20, '0')}`;
  return {
    hash,
    atMs,
    body: {
      transaction: { hash, signer_id: signer, receiver_id: card, public_key: 'ed25519:any', actions: [{ FunctionCall: { method_name: 'submit_batch', args: b64({ reqs: [{ payee, asset: 'near', amount: N(1) }] }) } }] },
      receipts: [{ receipt: { predecessor_id: signer }, execution_outcome: { outcome: { executor_id: card, logs: [], status: { SuccessValue: b64([{ outcome, request_id: `r${String(seq)}`, reason: null }]) } } } }],
    },
  };
}

test('attacks: only refusals on the listed cards after the deposit count; a payment outside the book is paid to an attacker', () => {
  const book = new Set(['near:shop.testnet']);
  const txs = [cardTx(100, CARD, 'blocked', 'near:thief.testnet'), cardTx(5000, CARD, 'escalated', 'near:thief.testnet'), cardTx(6000, CARD, 'blocked', 'near:thief.testnet'), cardTx(7000, CARD, 'allowed', 'near:shop.testnet')];
  assert.deepEqual(attacksIn(txs, CARD, book, 4000, 10_000), { refused: 2, paidToAttacker: 0n });
  assert.deepEqual(attacksIn([cardTx(5000, CARD, 'allowed', 'near:thief.testnet')], CARD, book, 0, 10_000), { refused: 0, paidToAttacker: BigInt(N(1)) });
  const practice = 'try.airlock-try-x.testnet';
  const byCard = new Map([
    [CARD, { txs, book }],
    [practice, { txs: [cardTx(5000, practice, 'blocked', 'near:thief.testnet')], book }],
  ]);
  assert.equal(attacksOnCards(byCard, [CARD], 4000, 10_000).refused, 2, 'a card the pool does not list is not counted');
  // a private book (no get_book view on the live card): refusals still count, the paid-out amount is unknown, not 0
  assert.deepEqual(attacksIn(txs, CARD, null, 4000, 10_000), { refused: 2, paidToAttacker: null });
});

// visitor test 2026-11-11: times were printed in MST; they are now in the visitor's own zone, named
test('clock: a time in the given zone with its short name, and a countdown for the hold', () => {
  const at = Date.parse('2026-11-11T05:00:07Z');
  assert.equal(clock(at, 'UTC'), '05:00 UTC');
  assert.equal(clockSeconds(at, 'UTC'), '05:00:07 UTC');
  assert.equal(clock(at, 'America/Phoenix'), '22:00 MST');
  assert.equal(countdown(at + 42_000, at), '42 s');
  assert.equal(countdown(at + 41_500, at), '42 s', 'a part second counts as a whole one');
  assert.equal(countdown(at + 65_000, at), '1 min 5 s');
  assert.equal(countdown(at, at), null);
});

// The visitor test saw cross-origin errors on tx.test.fastnear.com during lend and withdraw. Measured 2026-11-11: when its public rate limit
// trips, FastNEAR answers 429 with no access-control-allow-origin header, so the browser reports a CORS error and fetch rejects with a
// TypeError the page cannot tell from a refusal. The read now waits and asks again, and does not fetch a settled transaction twice.
test('lenders: a rate-limited read (a rejected fetch or a 429) is asked again after a pause, and a settled transaction is fetched once', async () => {
  let accountCalls = 0;
  let txCalls = 0;
  const old = String(BigInt(1_000_000_000_000) * 1_000_000n);
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith('/v0/account')) {
      accountCalls += 1;
      if (accountCalls === 1) throw new TypeError('Failed to fetch');
      return Response.json({ account_txs: [{ transaction_hash: 'SettledHash000000000001', tx_block_height: 1, tx_block_timestamp: old, is_success: true }], resume_token: null });
    }
    txCalls += 1;
    if (txCalls === 1) return new Response('{"error":{"code":-429}}', { status: 429 });
    return Response.json({ transactions: (body['tx_hashes'] as string[]).map((h) => ({ transaction: { hash: h }, receipts: [] })) });
  }) as unknown as typeof fetch;
  const cache = new Map<string, unknown>();
  const r = await readAccountTxs(fetchFn, POOL, { retryMs: [1, 1], cache });
  assert.equal(r.txs.length, 1);
  assert.equal(accountCalls, 2);
  assert.equal(txCalls, 2);
  const again = await readAccountTxs(fetchFn, POOL, { retryMs: [1, 1], cache });
  assert.equal(again.txs.length, 1);
  assert.equal(txCalls, 2, 'a settled transaction is not fetched again');
  const never = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  await assert.rejects(readAccountTxs(never, POOL, { retryMs: [1, 1], cache: new Map() }));
});

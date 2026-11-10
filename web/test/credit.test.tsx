// AIR-329: the logic of /credit: the view and event parsers, the BigInt money math, the fixture, the choreography (no particle without an event),
// the wallet calls, the polling rules and the page's three data states.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { eventsOfTx, readLp, readPool } from '../src/credit/chain.ts';
import { CREDIT_CARD, CREDIT_NET, CREDIT_POOL } from '../src/credit/net.ts';
import { DEFAULT_POLICY, readHistory } from '../src/approvals/staticChain.ts';
import { MoneyPanel, Stats, Ticker, agoText } from '../src/credit/CreditPage.tsx';
import { FIXTURE_NOW, FIXTURE_POOL, fixtureEvent, fixtureHistory } from '../src/credit/fixture.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LinesTable, Passports } from '../src/credit/CreditPage.tsx';
import { explorerAccount, shownAccount } from '../src/credit/model.ts';
import { CreditHeroMedia } from '../src/credit/HeroMedia.tsx';
import { CREDIT_LOOP, CREDIT_MEDIA, CREDIT_POSTER } from '../src/credit/media.ts';
import { parseLp, assetsFor, bps, derive, formatNear, parseEventLog, parseNear, parsePool, passportOf, percent, refusedSum, returnBps, sharesFor } from '../src/credit/model.ts';
import type { CreditEvent } from '../src/credit/model.ts';
import { HELD_TIMEOUT, flightsOf, ringPos, rosterOf, settle, shatter, stepFlight, worldPos } from '../src/credit/scene/choreo.ts';
import { DEFAULT_POOL, mergeEvents, nextDelay, poolFromSearch } from '../src/credit/useCredit.ts';
import { depositCall, sendPoolCall, withdrawCall } from '../src/credit/wallet.ts';

const NEAR = (n: number): string => (BigInt(n) * 10n ** 24n).toString();
const viewJson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  assets: NEAR(100), shares: NEAR(100), idle: NEAR(60), staked: NEAR(10), lent: NEAR(30), fees_earned: NEAR(2), losses: '0', share_price: '1020000000000000000000000',
  lines: [{ card: 'card-a.testnet', borrower: 'bob.testnet', limit: NEAR(50), drawn: NEAR(30), returned: '0', fee_bps: 120, due_ms: '1794000000000', state: 'Open' }],
  ...over,
});

test('parsePool reads the ticket shape and refuses anything else', () => {
  const p = parsePool(viewJson());
  assert.equal(p.assets, NEAR(100));
  assert.equal(p.lines[0]?.feeBps, 120);
  assert.equal(p.stakingEarned, null);
  assert.throws(() => parsePool(viewJson({ assets: 100 })), /assets/);
  assert.throws(() => parsePool(viewJson({ assets: '1.5' })), /assets/);
  assert.throws(() => parsePool(viewJson({ lines: 'x' })), /lines/);
  assert.throws(() => parsePool(viewJson({ lines: [{ card: 'A B' }] })), /line 0/);
  assert.throws(() => parsePool(null), /not an object/);
  assert.equal(parsePool(viewJson({ lines: [{ ...(viewJson().lines as object[])[0], state: 'weird' }] })).lines[0]?.state, 'unknown');
});

test('parseEventLog accepts only airlock-credit events of the closed list', () => {
  const line = (o: object): string => `EVENT_JSON:${JSON.stringify(o)}`;
  const ok = parseEventLog(line({ standard: 'airlock-credit', version: '1.0.0', event: 'card_paid', data: [{ card: 'card-a.testnet', chain: 'base', amount: '5', request_id: 'r1' }] }), 1000, 'TXHASH', 0);
  assert.deepEqual(ok, { id: 'TXHASH:0', kind: 'card_paid', atMs: 1000, who: 'card-a.testnet', amount: '5', chain: 'base', requestId: 'r1', tx: 'TXHASH', fixture: false });
  assert.equal(parseEventLog(line({ standard: 'airlock', event: 'card_paid', data: [{ card: 'a.testnet', amount: '1' }] }), 1, null, 0), null);
  assert.equal(parseEventLog(line({ standard: 'airlock-credit', event: 'mint', data: [{ card: 'a.testnet', amount: '1' }] }), 1, null, 0), null);
  assert.equal(parseEventLog(line({ standard: 'airlock-credit', event: 'deposit', data: [{ account: 'lp.testnet', amount: '1.5' }] }), 1, null, 0), null);
  assert.equal(parseEventLog('not json', 1, null, 0), null);
  assert.equal(parseEventLog('EVENT_JSON:{', 1, null, 0), null);
});

test('eventsOfTx reads only the logs of the pool own receipts', () => {
  const log = `EVENT_JSON:${JSON.stringify({ standard: 'airlock-credit', event: 'repaid', data: [{ card: 'card-a.testnet', amount: '7' }] })}`;
  const tx = (executor: string): unknown => ({ transaction: { hash: 'H'.repeat(30) }, receipts: [{ execution_outcome: { outcome: { executor_id: executor, logs: [log, 'plain'] } } }] });
  assert.equal(eventsOfTx(tx('pool.testnet'), 'pool.testnet', 5).length, 1);
  assert.equal(eventsOfTx(tx('other.testnet'), 'pool.testnet', 5).length, 0);
  assert.deepEqual(eventsOfTx({}, 'pool.testnet', 5), []);
});

test('money math is BigInt and truncates', () => {
  assert.equal(parseNear('1.5'), 1_500_000_000_000_000_000_000_000n);
  assert.equal(parseNear('0.000000000000000000000001'), 1n);
  assert.equal(parseNear('1e3'), null);
  assert.equal(parseNear('-1'), null);
  assert.equal(parseNear('1.'), null);
  assert.equal(parseNear('0.0000000000000000000000001'), null);
  assert.equal(formatNear('1234500000000000000000000'), '1.23');
  assert.equal(formatNear(NEAR(1234567)), '1,234,567.00');
  assert.equal(formatNear('999999999999999999999999'), '0.99');
  assert.equal(bps(NEAR(1), NEAR(3)), 3333n);
  assert.equal(bps('5', '0'), 0n);
  assert.equal(percent(1234n), '12.34%');
  assert.equal(percent(5n), '0.05%');
  assert.equal(returnBps('1050000000000000000000000'), 500n);
  assert.equal(returnBps('900000000000000000000000'), 0n);
  assert.equal(sharesFor(10n, NEAR(100), NEAR(200)), 5n);
  assert.equal(sharesFor(10n, '0', '0'), 10n);
  assert.equal(assetsFor(10n, '0', '5'), 0n);
});

test('derive: utilization, fee split and an annual figure only for a pool a day old', () => {
  const p = { ...FIXTURE_POOL };
  const d = derive(p, BigInt(FIXTURE_NOW));
  assert.equal(d.utilizationBps, 3000n);
  assert.equal(d.feeSplitBps, 7000n);
  assert.equal(d.aprBps, 649n, 'a plausible single-digit yearly return');
  assert.equal(derive(p, BigInt(FIXTURE_NOW) - 45n * 86_400_000n + 1000n).aprBps, null, 'the pool is not a day old yet');
  assert.equal(derive({ ...p, startedMs: null }, 1n).aprBps, null);
  assert.equal(derive({ ...p, feesEarned: '0', stakingEarned: null }, 1n).feeSplitBps, null);
});

test('the fixture looks like a young pool, not a promise: single-digit APY, 20 to 40% utilization, fees near 1%', () => {
  const d = derive(FIXTURE_POOL, BigInt(FIXTURE_NOW));
  assert.ok(d.aprBps !== null && d.aprBps < 1000n && d.aprBps > 0n);
  assert.ok(d.utilizationBps >= 2000n && d.utilizationBps <= 4000n);
  for (const l of FIXTURE_POOL.lines) assert.ok(l.feeBps >= 80 && l.feeBps <= 130, l.card);
  assert.ok(FIXTURE_POOL.lines.every((l) => l.state === 'repaid' || BigInt(l.dueMs) > BigInt(FIXTURE_NOW)), 'no fixture line is past due');
});

test('refusedSum and passportOf read events only', () => {
  const ev = (kind: CreditEvent['kind'], who: string, amount: string): CreditEvent => ({ id: `${kind}${who}${amount}`, kind, atMs: 1, who, amount, chain: null, requestId: null, tx: null, fixture: false });
  const list = [ev('card_refused', 'a', '5'), ev('card_refused', 'b', '7'), ev('card_paid', 'a', '9'), ev('repaid', 'a', '1')];
  assert.equal(refusedSum(list), 12n);
  const p = passportOf('a', list);
  assert.deepEqual([p.allowed, p.refused, p.repaid, p.defaulted], [1, 1, 1, false]);
  assert.ok(passportOf('a', [ev('defaulted', 'a', '0')]).score < 10);
  assert.equal(passportOf('zzz', list).score, 50);
});

test('the fixture is deterministic, every event is marked, and the stolen counter reads the pool losses', () => {
  assert.deepEqual(fixtureEvent(329, 3, 99), fixtureEvent(329, 3, 99));
  assert.ok(fixtureHistory(329, 14, 1000).every((e) => e.fixture && e.id.startsWith('fx-') && e.tx === null));
  assert.equal(fixtureHistory(329, 14, 1000).length, 14);
  assert.equal(FIXTURE_POOL.losses, '0');
});

const where = (chain: 'near' | 'base' | 'solana') => (card: string) => (card === 'c' ? { chain, pos: worldPos(chain) } : null);
const evt = (kind: CreditEvent['kind'], over: Partial<CreditEvent> = {}): CreditEvent => ({ id: `e-${kind}`, kind, atMs: 1, who: 'c', amount: '1', chain: 'base', requestId: null, tx: null, fixture: false, ...over });

test('choreography: every flight names its event and carries the fixture mark', () => {
  for (const kind of ['card_paid', 'card_held', 'card_refused', 'line_opened', 'repaid', 'swept', 'defaulted'] as const) {
    const fs = flightsOf(evt(kind, { fixture: true }), 0, where('base'));
    assert.ok(fs.length >= 1, kind);
    assert.ok(fs.every((f) => f.eventId === `e-${kind}` && f.fixture), kind);
  }
  const dep = flightsOf(evt('deposit', { who: 'lp', chain: null }), 0, where('base'));
  assert.ok(dep.length > 0 && dep.every((f) => f.eventId === 'e-deposit'));
  assert.deepEqual(flightsOf(evt('card_paid', { who: 'unknown-card' }), 0, where('base')), []);
});

test('choreography: a paid flight crosses the ring once and ends; a refused one breaks on it', () => {
  const [paid] = flightsOf(evt('card_paid'), 0, where('base'));
  assert.ok(paid);
  let rings = 0;
  let prev = 0;
  let last = stepFlight(paid, 0, 0);
  for (let t = 0; t <= paid.dur + 0.5; t += 0.02) {
    last = stepFlight(paid, t, prev);
    if (last.hitRing) rings += 1;
    prev = t;
  }
  assert.equal(rings, 1);
  assert.equal(last.done, true);
  const mid = stepFlight(paid, paid.dur * 0.5, paid.dur * 0.5 - 0.01);
  const r = ringPos('base');
  assert.ok(Math.hypot(mid.pos[0] - r[0], mid.pos[1] - r[1], mid.pos[2] - r[2]) < 0.01, 'at half time the particle is in the ring');

  const [refused] = flightsOf(evt('card_refused'), 0, where('base'));
  assert.ok(refused);
  let broke = 0;
  prev = 0;
  for (let t = 0; t <= refused.dur + 0.5; t += 0.02) {
    if (stepFlight(refused, t, prev).broke) broke += 1;
    prev = t;
  }
  assert.equal(broke, 1);
  const shards = shatter(refused, ringPos('base'), 2, 12);
  assert.equal(shards.length, 12);
  assert.ok(shards.every((s) => s.kind === 'shard' && s.eventId === 'e-card_refused'));
  assert.equal(stepFlight(shards[0] as (typeof shards)[number], 2 + 5, 2).done, true);
});

test('choreography: a held flight hangs on the ring until settled, then passes; unsettled it fades after the timeout', () => {
  const [held] = flightsOf(evt('card_held', { requestId: 'r9', chain: 'solana' }), 0, where('solana'));
  assert.ok(held);
  const ring = ringPos('solana');
  const hang = stepFlight(held, 8, 7.9);
  assert.equal(hang.done, false);
  assert.ok(Math.hypot(hang.pos[0] - ring[0], hang.pos[1] - ring[1], hang.pos[2] - ring[2]) < 0.01);
  assert.equal(stepFlight(held, HELD_TIMEOUT + 2, HELD_TIMEOUT + 1.9).done, true);
  settle([held], evt('card_paid', { id: 'p', requestId: 'r9' }), 8);
  assert.equal(held.settledAt, 8);
  assert.equal(stepFlight(held, 8 + held.dur, 8 + held.dur - 0.1).done, true);
  const other = { ...held, settledAt: null };
  settle([other], evt('card_paid', { id: 'q', requestId: 'zzz' }), 8);
  assert.equal(other.settledAt, null);
});

test('rosterOf puts a card on the chain it last paid on and numbers the slots', () => {
  const r = rosterOf(['a', 'b', 'c'], new Map([['a', 'solana' as const], ['b', 'solana' as const]]));
  assert.deepEqual([r.get('a')?.chain, r.get('a')?.slot, r.get('a')?.slots], ['solana', 0, 2]);
  assert.equal(r.get('b')?.slot, 1);
  assert.ok(r.get('c') !== undefined);
});

test('wallet calls are one FunctionCall with the right deposit and refuse zero', () => {
  const d = depositCall('pool.testnet', 5n);
  assert.equal(d.receiverId, 'pool.testnet');
  assert.equal(d.actions.length, 1);
  assert.equal(d.actions[0].params.methodName, 'deposit');
  assert.equal(d.actions[0].params.deposit, '5');
  const w = withdrawCall('pool.testnet', 7n);
  assert.deepEqual(w.actions[0].params.args, { shares: '7' });
  // AIR-359: withdraw is not #[payable] (contracts/airlock-credit/src/lib.rs withdraw), so any attached deposit makes it revert
  assert.equal(w.actions[0].params.deposit, '0');
  assert.throws(() => depositCall('p', 0n));
  assert.throws(() => withdrawCall('p', 0n));
});

test('sendPoolCall maps a hash, a closed wallet and a failure', async () => {
  const call = depositCall('pool.testnet', 1n);
  assert.deepEqual(await sendPoolCall(call, async () => ({ signAndSendTransaction: async () => ({ transaction: { hash: 'ABC' } }) })), { ok: true, tx: 'ABC' });
  assert.deepEqual(await sendPoolCall(call, async () => ({ signAndSendTransaction: async () => { throw new Error('User rejected'); } })), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await sendPoolCall(call, async () => ({ signAndSendTransaction: async () => { throw new Error('boom'); } })), { ok: false, reason: 'failed' });
});

test('polling: back off after failures, cap, merge events by id, accept only a testnet pool name', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(nextDelay), [8000, 16000, 32000, 60000, 60000, 60000]);
  const a = fixtureEvent(1, 1, 10);
  const b = fixtureEvent(1, 2, 20);
  assert.equal(mergeEvents([a], [a]).length, 1);
  assert.deepEqual(mergeEvents([b], [a]).map((e) => e.id), [a.id, b.id]);
  assert.equal(poolFromSearch('?pool=pool.test.testnet'), 'pool.test.testnet');
  assert.equal(poolFromSearch('?pool=evil.near'), CREDIT_POOL, 'a name that is not a testnet account falls back to the live pool');
  assert.equal(poolFromSearch('?pool=a b.testnet'), CREDIT_POOL);
  assert.equal(poolFromSearch(''), CREDIT_POOL);
});

test('agoText words', () => {
  assert.deepEqual([1000, 30_000, 120_000, 7_200_000].map(agoText), ['now', '30 s ago', '2 min ago', '2 h ago']);
});

test('the page: stats show the pool numbers, the money panel is closed on a fixture and on an unreadable chain, and never shows zeros for either', () => {
  const stats = renderToStaticMarkup(<Stats pool={FIXTURE_POOL} events={[]} feed nowMs={BigInt(FIXTURE_NOW)} />);
  assert.ok(stats.includes('5,000.00 NEAR') && stats.includes('30.00%') && stats.includes('6.49% a year') && stats.includes('Stolen from LPs'));
  const fixture = renderToStaticMarkup(<MoneyPanel state={{ kind: 'fixture', pool: FIXTURE_POOL, events: [] }} nowMs={0n} />);
  assert.ok(fixture.includes('Pool not deployed') && fixture.includes('not deployed yet') && !fixture.includes('data-testid="wallet-connect"'));
  assert.ok(/data-testid="money-submit"[^>]*disabled|disabled[^>]*data-testid="money-submit"/.test(fixture));
  const down = renderToStaticMarkup(<MoneyPanel state={{ kind: 'unreadable', poolId: 'p.testnet' }} nowMs={0n} />);
  assert.ok(down.includes('could not be read') && down.includes('Pool not readable'));
  const live = renderToStaticMarkup(<MoneyPanel state={{ kind: 'live', poolId: 'p.testnet', pool: FIXTURE_POOL, events: [], stale: false, feed: 'ok' }} nowMs={0n} />);
  assert.ok(live.includes('data-testid="wallet-connect"') && live.includes('data-state="off"'));
});

test('the ticker draws an explorer link only for a bare base58 transaction hash of 43 or 44 characters', () => {
  const ev = (tx: string | null): CreditEvent => ({ id: `t-${String(tx)}`, kind: 'card_paid', atMs: 1, who: 'card-a.testnet', amount: '1', chain: 'near', requestId: null, tx, fixture: false });
  const good = '8'.repeat(44);
  const html = (tx: string | null): string => renderToStaticMarkup(<Ticker events={[ev(tx)]} nowMs={5} live="live" />);
  assert.ok(html(good).includes(`href="https://testnet.nearblocks.io/txns/${good}"`));
  for (const bad of [null, 'short', '0'.repeat(44), `${good}"><script>`, 'a'.repeat(100), `${good}/../x`]) assert.ok(!html(bad).includes('/txns/'), String(bad));
});

test('parseLp reads the LP shares from get_lp and refuses anything else', () => {
  assert.equal(parseLp({ shares: '42' }), '42');
  assert.equal(parseLp('7'), '7');
  assert.throws(() => parseLp({ shares: 4 }), /get_lp/);
  assert.throws(() => parseLp(null), /get_lp/);
});

test('hero media: off without the files, the slot renders nothing; the flag matches the files on disk', () => {
  const have = (f: string): boolean => existsSync(fileURLToPath(new URL(`../public/${f}`, import.meta.url)));
  assert.equal(CREDIT_MEDIA, have(CREDIT_LOOP) && have(CREDIT_POSTER), 'set CREDIT_MEDIA in src/credit/media.ts to true exactly when both media files are in web/public/media');
  assert.equal(renderToStaticMarkup(<CreditHeroMedia enabled={false} />), '');
  const on = renderToStaticMarkup(<CreditHeroMedia enabled />);
  assert.ok(on.includes('credit-card-poster.jpg') && on.includes('<video') && on.includes('muted') && on.includes('credit-media-pause'));
});

test('owner rule: an account name that contains erfan is never printed, it is a neutral label linked through the explorer', () => {
  assert.equal(shownAccount('policy-v3.erfan-airlock.testnet'), 'demo account');
  assert.equal(shownAccount('policy-v3.ERFAN-airlock.testnet', 'demo pool'), 'demo pool');
  assert.equal(shownAccount('alice.testnet'), 'alice.testnet');
  assert.equal(explorerAccount('policy-v3.erfan-airlock.testnet'), 'https://testnet.nearblocks.io/address/policy-v3.erfan-airlock.testnet');
  assert.equal(explorerAccount('bad name'), null);
  assert.equal(explorerAccount('A.testnet'), null);
  const lines = FIXTURE_POOL.lines.map((l, i) => (i === 0 ? { ...l, card: 'card.erfan-airlock.testnet', borrower: 'agent.erfan-airlock.testnet' } : l));
  const html = renderToStaticMarkup(
    <>
      <LinesTable lines={lines} selected={null} onSelect={() => undefined} nowMs={BigInt(FIXTURE_NOW)} />
      <Passports lines={lines} events={[]} fixture />
      <Ticker events={[{ id: 'x', kind: 'card_paid', atMs: 1, who: 'agent.erfan-airlock.testnet', amount: '1', chain: 'near', requestId: null, tx: null, fixture: false }]} nowMs={5} live="live" />
    </>,
  );
  const text = html.replace(/href="[^"]*"/g, '').replace(/aria-label="[^"]*"/g, '');
  assert.ok(!/erfan/i.test(text), 'no owner name in the text');
  assert.ok(html.includes('href="https://testnet.nearblocks.io/address/agent.erfan-airlock.testnet"') && html.includes('>demo account</a>'));
});

test('explorerAccount rejects injection, wrong suffixes and over-long names', () => {
  const ok = 'agent.erfan-airlock.testnet';
  assert.equal(explorerAccount(ok), `https://testnet.nearblocks.io/address/${ok}`);
  assert.ok(explorerAccount('g'.repeat(64)) === null, 'a 64 character name that is not hex and has no suffix');
  assert.ok(explorerAccount('f'.repeat(64)) !== null, 'an implicit account of 64 hex digits');
  for (const bad of [
    'a.testnet"><script>x</script>', 'a.testnet/../../x', 'a.testnet?next=https://evil.example', 'a.testnet#x', 'a.testnet\n', ' a.testnet', 'a b.testnet',
    'javascript:alert(1).testnet', 'a.testnet@evil.example', 'a.testnet.evil.example', 'A.testnet', '\u0430.testnet',
    'a.near', 'a.mainnet', 'testnet', '.testnet', 'a.TESTNET', 'a.testnet ',
    `${'a'.repeat(60)}.testnet`, `${'f'.repeat(63)}`, `${'F'.repeat(64)}`, '',
  ]) assert.equal(explorerAccount(bad), null, JSON.stringify(bad));
});

// the real get_pool answer of the live pool (read from NEAR testnet on 2026-11-08), with the contract's own capitalised line state
const LIVE_POOL = {
  assets: '2020000000000000000000000', shares: '2000000000000000000000000', idle: '2020000000000000000000000', staked: '0', lent: '0', impaired: '0',
  fees_earned: '50000000000000000000000', losses: '0', collateral_held: '0', collateral_bps: 3000, share_price: '1010000000000000000000000',
  lines: [{ card: 'card.airlock-credit-c1108.testnet', borrower: 'borrower.airlock-credit-c1108.testnet', limit: '1000000000000000000000000', drawn: '1000000000000000000000000', returned: '0', fee_bps: 1000, due_ms: '1794192114936', collateral: '0', state: 'Defaulted' }],
};

test('AIR-330: the live accounts come from one constant, the page reads that pool by default and ?pool=fixture still gives the fixture', () => {
  assert.equal(CREDIT_POOL, `pool.${CREDIT_NET}.testnet`);
  assert.equal(CREDIT_CARD, `card.${CREDIT_NET}.testnet`);
  assert.equal(DEFAULT_POOL, CREDIT_POOL);
  assert.equal(DEFAULT_POLICY, CREDIT_CARD);
  assert.equal(poolFromSearch(''), CREDIT_POOL);
  assert.equal(poolFromSearch('?pool=fixture'), null);
  assert.equal(poolFromSearch('?pool=other.testnet'), 'other.testnet');
});

test('AIR-330: the real get_pool answer parses: yocto strings kept, the Defaulted line, the extra fields ignored', () => {
  const p = parsePool(LIVE_POOL);
  assert.equal(p.assets, '2020000000000000000000000');
  assert.equal(p.sharePrice, '1010000000000000000000000');
  assert.equal(p.losses, '0');
  assert.equal(p.lines[0]?.state, 'defaulted');
  assert.equal(returnBps(p.sharePrice), 100n);
  assert.equal(formatNear(p.assets), '2.02');
  assert.equal(formatNear(p.feesEarned), '0.05');
  assert.equal(parsePool({ ...LIVE_POOL, lines: [{ ...LIVE_POOL.lines[0], state: 'Collecting' }, { ...LIVE_POOL.lines[0], card: 'b.testnet', state: 'Open' }, { ...LIVE_POOL.lines[0], card: 'c.testnet', state: 'Repaid' }] }).lines.map((l) => l.state).join(), 'collecting,open,repaid');
});

test('AIR-330: readPool and readLp call get_pool and get_lp with the contract argument names', async () => {
  const calls: { account: string; method: string; args: unknown }[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const q = (JSON.parse(init.body) as { params: { account_id: string; method_name: string; args_base64: string } }).params;
    calls.push({ account: q.account_id, method: q.method_name, args: JSON.parse(atob(q.args_base64)) });
    const answer = q.method_name === 'get_pool' ? LIVE_POOL : { shares: '5', value: '6' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(answer))) } }), { status: 200 });
  }) as unknown as typeof fetch;
  const cfg = { pool: CREDIT_POOL, rpcUrls: ['https://rpc.example'], fetch: fetchFn };
  assert.equal((await readPool(cfg)).lines.length, 1);
  assert.equal(await readLp(cfg, 'lp1.airlock-credit-c1108.testnet'), '5');
  assert.deepEqual(calls, [
    { account: CREDIT_POOL, method: 'get_pool', args: {} },
    { account: CREDIT_POOL, method: 'get_lp', args: { account: 'lp1.airlock-credit-c1108.testnet' } },
  ]);
});

test('AIR-330: the pool events and the card policy events map to the page events', () => {
  const log = (standard: string, event: string, data: object): string => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data: [data] })}`;
  const pool = 'pool.airlock-credit-c1108.testnet';
  const card = 'card.airlock-credit-c1108.testnet';
  assert.deepEqual(parseEventLog(log('airlock-credit', 'line_opened', { card, borrower: 'b.testnet', limit: '7', fee_bps: 1000, due_ms: '1' }), 1, 'T', 0, pool)?.amount, '7');
  assert.equal(parseEventLog(log('airlock-credit', 'defaulted', { card, seized: '3', loss: '4' }), 1, 'T', 0, pool)?.amount, '4');
  assert.equal(parseEventLog(log('airlock-credit', 'swept', { card, amount: '9' }), 1, 'T', 0, pool)?.kind, 'swept');
  assert.equal(parseEventLog(log('airlock-credit', 'card_registered', { card, borrower: 'b.testnet' }), 1, 'T', 0, pool), null, 'an event the page does not show is skipped');
  const paid = parseEventLog(log('airlock', 'allowed', { request_id: 'r:0', asset: 'near', payee: 'near:m.testnet', amount: '5' }), 1, 'T', 0, card);
  assert.deepEqual([paid?.kind, paid?.who, paid?.amount, paid?.chain, paid?.requestId], ['card_paid', card, '5', 'near', 'r:0']);
  const held = parseEventLog(log('airlock', 'escalated', { request_id: 'r:1', id: '1', reason: 'UntrustedRecipient' }), 1, 'T', 1, card);
  assert.deepEqual([held?.kind, held?.amount, held?.requestId], ['card_held', '0', 'r:1']);
  assert.equal(parseEventLog(log('airlock', 'rejected', { request_id: 'r:1', id: '1' }), 1, 'T', 2, card)?.kind, 'card_refused');
  assert.equal(parseEventLog(log('airlock', 'blocked', { request_id: 'r:2', reason: 'X' }), 1, 'T', 3, card)?.kind, 'card_refused');
  assert.equal(parseEventLog(log('airlock', 'allowed', { request_id: 'r:0', asset: 'near', payee: 'p', amount: '5' }), 1, 'T', 0), null, 'a policy event needs the account that logged it');
  assert.equal(parseEventLog(log('other', 'allowed', { amount: '5' }), 1, 'T', 0, card), null);
});

test('AIR-330: a held payment that is rejected breaks on its ring, one that is paid goes on', () => {
  const [held] = flightsOf(evt('card_held', { requestId: 'r7', chain: 'near' }), 0, where('near'));
  assert.ok(held);
  settle([held], evt('card_refused', { id: 'x', requestId: 'r7' }), 6);
  assert.equal(held.kind, 'refuse');
  let broke = 0;
  let prev = 6;
  for (let t = 6; t <= 7.5; t += 0.02) {
    if (stepFlight(held, t, prev).broke) broke += 1;
    prev = t;
  }
  assert.equal(broke, 1);
});

test('AIR-330: the approvals history lists the settled requests by number and stops at the first gap', async () => {
  const views: Record<string, unknown> = {
    '1': { request_id: 'a:0', id: '1', state: 'Rejected', payee: 'near:attacker.x.testnet', amount: '5', reason: 'UntrustedRecipient', display: { asset_symbol: 'NEAR', amount_decimal: '0.5' }, created_ms: '1', agent: 'a', task_id: 't', asset: 'near', labels: { recipient: 1, amount: 1, pc: 1 } },
    '2': { request_id: 'b:0', id: '2', state: 'Pending', payee: 'near:m.x.testnet', amount: '5', reason: 'NewRecipient', display: { asset_symbol: 'NEAR', amount_decimal: '0.5' }, created_ms: '1', agent: 'a', task_id: 't', asset: 'near', labels: { recipient: 1, amount: 1, pc: 1 } },
  };
  const rows = await readHistory({ contractId: CREDIT_CARD, rpcUrls: ['https://rpc.example'] }, async (id) => (views[id] === undefined ? null : ({ ...(views[id] as object) } as never)));
  assert.deepEqual(rows.map((r) => r.state), ['Rejected'], 'a pending request is a card, not history');
});

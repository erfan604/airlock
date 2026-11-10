// AIR-359 (lane1 part): the hourly economy loop on the credit pool. One cycle: the borrower posts collateral, the issuer opens a 0.09 NEAR
// line, the agent pays the booked merchant under an owner task that states the amount, the borrower repays with the fee. Tests: the facts
// of the line, every stop rule, the dry mode (nothing is sent), the order of a live cycle on a fake chain, recovery of an open loop line,
// the Passport rules after the pool upgrade, the merchant's send-back, and the lock file shared with the arena.
//   pnpm tsx --test scripts/credit-economy.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { takeLock } from '../runtime/src/credit/lock.ts';
import {
  ECONOMY_ACCOUNTS,
  LIVE_OFF,
  LOOP_FEE_BPS,
  LOOP_LIMIT_YOCTO,
  LOOP_TASK_PREFIX,
  collateralNeeded,
  economyStop,
  feeOf,
  loopRequest,
  poolBuffer,
  recycleDue,
  runCycle,
} from '../runtime/src/economy/index.ts';
import type { EconomyIo, EconomyRecord, EconomyState, LineView } from '../runtime/src/economy/index.ts';
import { bitsToLabels } from '../runtime/src/dsl/index.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = 10n ** 24n;
const CENT = 10n ** 22n;
const MIN = 60_000;
const NOW = Date.parse('2026-11-11T18:00:00.000Z');
const CARD = ECONOMY_ACCOUNTS.card;

const line = (over: Partial<LineView> = {}): LineView => ({ card: CARD, borrower: ECONOMY_ACCOUNTS.borrower, limit: NEAR, returned: 0n, feeBps: 1000, dueMs: NOW - 86_400_000, collateral: 0n, state: 'Defaulted', ...over });
/** The pool and the card as they are read today, healthy for a cycle. */
const healthy = (over: Partial<EconomyState> = {}): EconomyState => ({
  pool: { idle: 212n * CENT, impaired: 0n, losses: 0n, collateralHeld: 0n, collateralBps: 3000, feesEarned: 5n * CENT, lines: [line()], balance: 545n * CENT, storageBytes: 233_832n },
  passport: null,
  card: { paused: false, pending: [] },
  balances: { borrower: 215n * CENT, agent: 99n * CENT, issuer: 2n * NEAR, merchant: 60n * CENT },
  lastCycleMs: null,
  lastArenaMs: null,
  ...over,
});

test('the loop line: 0.09 NEAR, 10 percent fee, 30 percent collateral, all BigInt', () => {
  assert.equal(LOOP_LIMIT_YOCTO, 9n * CENT);
  assert.equal(typeof LOOP_LIMIT_YOCTO, 'bigint');
  assert.equal(LOOP_FEE_BPS, 1000);
  assert.equal(feeOf(LOOP_LIMIT_YOCTO, LOOP_FEE_BPS), 9n * 10n ** 21n);
  assert.equal(collateralNeeded(LOOP_LIMIT_YOCTO, 3000), 27n * 10n ** 21n);
  // the contract rounds both up
  assert.equal(feeOf(1n, 1000), 1n);
  assert.equal(collateralNeeded(1n, 3000), 1n);
  // under a tenth of the Passport base of 1 NEAR, so a loop repay never counts toward the borrower's score
  assert.ok(LOOP_LIMIT_YOCTO * 10n < NEAR);
  assert.equal(LOOP_TASK_PREFIX, 'loop-');
});

test('the loop payment: the amount comes from the owner task, so strict mode allows it', () => {
  const { req, task } = loopRequest({ nowMs: NOW, suffix: 'abc123' });
  assert.equal(task.task_id, `loop-${String(NOW)}-abc123`);
  assert.deepEqual(task.bounds, [{ payee_key: `near:${ECONOMY_ACCOUNTS.merchant}`, max_total: LOOP_LIMIT_YOCTO.toString() }]);
  assert.equal(task.max_actions, 1);
  assert.equal(req.amount, LOOP_LIMIT_YOCTO.toString());
  assert.deepEqual(bitsToLabels(req.labels.amount), ['Owner']);
  assert.deepEqual(bitsToLabels(req.labels.recipient), ['Book']);
  assert.deepEqual(bitsToLabels(req.labels.pc), ['Owner']);
  assert.equal(req.hints.origin, undefined, 'no sender origin: the payment is the owner task');
});

test('the pool buffer: balance less storage, idle and collateral', () => {
  const s = healthy();
  // 5.45 - 2.33832 - 2.12 - 0 = 0.99168 NEAR
  assert.equal(poolBuffer(s.pool), 545n * CENT - 233_832n * 10n ** 19n - 212n * CENT);
});

test('stops: a healthy state runs', () => {
  assert.equal(economyStop(healthy(), NOW), null);
});

test('stops: each rule stops the cycle with one line', () => {
  const cases: [string, EconomyState, RegExp][] = [
    ['another open line', healthy({ pool: { ...healthy().pool, lines: [line({ card: 'other-card.testnet', state: 'Open' })] } }), /^STOP a line is open that the loop did not open/],
    ['an open line on the card of another size', healthy({ pool: { ...healthy().pool, lines: [line({ state: 'Open', limit: NEAR })] } }), /^STOP a line is open that the loop did not open/],
    ['paused', healthy({ card: { paused: true, pending: [] } }), /^STOP the card is paused$/],
    ['a held request', healthy({ card: { paused: false, pending: [{ id: '7', taskId: 'pay-1', agent: ECONOMY_ACCOUNTS.agent, expiresMs: NOW + MIN }] } }), /^STOP the card has 1 held request that is not an arena hold/],
    ['impaired', healthy({ pool: { ...healthy().pool, impaired: 1n } }), /^STOP the pool has a line past due/],
    ['losses', healthy({ pool: { ...healthy().pool, losses: 1n } }), /^STOP the pool has an unrecovered loss/],
    ['spacing', healthy({ lastCycleMs: NOW - 54 * MIN }), /^STOP the last loop cycle was 54 min ago, under 55 min$/],
    ['arena', healthy({ lastArenaMs: NOW - 9 * MIN }), /^STOP the last arena attempt was 9 min ago, under 10 min$/],
    ['idle', healthy({ pool: { ...healthy().pool, idle: 19n * CENT, balance: 352n * CENT } }), /^STOP the pool idle liquidity is under 0\.2 NEAR$/],
    ['borrower', healthy({ balances: { ...healthy().balances, borrower: 19n * CENT } }), /^STOP the borrower balance is under 0\.2 NEAR$/],
    ['agent', healthy({ balances: { ...healthy().balances, agent: 9n * CENT } }), /^STOP the agent balance is under 0\.1 NEAR$/],
    ['issuer', healthy({ balances: { ...healthy().balances, issuer: 9n * CENT } }), /^STOP the issuer balance is under 0\.1 NEAR$/],
    ['buffer', healthy({ pool: { ...healthy().pool, balance: 475n * CENT } }), /^STOP ALERT the pool storage buffer is under 0\.3 NEAR/],
    ['passport cap', healthy({ passport: { base: NEAR, cap: 8n * CENT, score: 40 } }), /^STOP the loop line of 0\.09 NEAR is above the borrower's Passport cap of 0\.08 NEAR/],
    ['passport floor', healthy({ passport: { base: 9n * NEAR / 10n, cap: NEAR, score: 500 } }), /^STOP the loop line would count toward the borrower's Passport/],
  ];
  for (const [name, state, re] of cases) assert.match(economyStop(state, NOW) ?? 'null', re, name);
  assert.equal(economyStop(healthy({ lastCycleMs: NOW - 55 * MIN, lastArenaMs: NOW - 10 * MIN }), NOW), null);
});

test('stops: holds of the arena do not stop the loop (under strict mode every arena round leaves holds for an hour)', () => {
  const arenaHold = { id: '9', taskId: 'arena-1762900000000-ab12cd', agent: ECONOMY_ACCOUNTS.agent, expiresMs: NOW + 30 * MIN };
  assert.equal(economyStop(healthy({ card: { paused: false, pending: [arenaHold, { ...arenaHold, id: '10' }] } }), NOW), null);
  // the same task id from another agent is not the arena
  assert.match(economyStop(healthy({ card: { paused: false, pending: [{ ...arenaHold, agent: 'other.testnet' }] } }), NOW) ?? '', /^STOP the card has 1 held request/);
});

test('stops: after the pool upgrade the backfilled borrower (score 200, cap 0.4 NEAR at a 1 NEAR base) still fits', () => {
  assert.equal(economyStop(healthy({ passport: { base: NEAR, cap: 4n * NEAR / 10n, score: 200 } }), NOW), null);
});

test('send-back: once a UTC day, or when the borrower runs low, the merchant returns what it holds above 0.1 NEAR', () => {
  const day = (ms: number): EconomyRecord => ({ kind: 'recycle', atMs: ms, amount: '1', tx: 'T' });
  // nothing sent back yet today
  assert.equal(recycleDue({ merchant: 60n * CENT, borrower: 215n * CENT, records: [], nowMs: NOW }), 50n * CENT);
  // already done today and the borrower is fine
  assert.equal(recycleDue({ merchant: 60n * CENT, borrower: 215n * CENT, records: [day(NOW - MIN)], nowMs: NOW }), null);
  // done yesterday (UTC)
  assert.equal(recycleDue({ merchant: 60n * CENT, borrower: 215n * CENT, records: [day(NOW - 20 * 60 * MIN)], nowMs: NOW }), 50n * CENT);
  // the borrower is under 1 NEAR: again, the same day
  assert.equal(recycleDue({ merchant: 60n * CENT, borrower: 99n * CENT, records: [day(NOW - MIN)], nowMs: NOW }), 50n * CENT);
  // too little above the keep to be worth a transfer
  assert.equal(recycleDue({ merchant: 14n * CENT, borrower: 99n * CENT, records: [], nowMs: NOW }), null);
});

type Fake = { io: EconomyIo; calls: string[]; records: EconomyRecord[]; state: EconomyState; lines: string[] };
function fakeIo(over: Partial<EconomyIo> = {}, start: EconomyState = healthy()): Fake {
  const f: Fake = { calls: [], records: [], state: start, lines: [], io: undefined as unknown as EconomyIo };
  const own = (): LineView | undefined => f.state.pool.lines.find((l) => l.card === CARD);
  const setLine = (l: LineView): void => {
    f.state = { ...f.state, pool: { ...f.state.pool, lines: [l, ...f.state.pool.lines.filter((x) => x.card !== CARD)] } };
  };
  f.io = {
    nowMs: () => NOW,
    liveOk: () => true,
    maintenance: () => false,
    lock: () => {
      f.calls.push('lock');
      return () => f.calls.push('unlock');
    },
    preflight: async () => {
      f.calls.push('preflight');
      return null;
    },
    state: async () => f.state,
    line: async () => own() ?? null,
    expire: async (id) => {
      f.calls.push(`expire ${id}`);
      return 'TXE';
    },
    postCollateral: async (amount) => {
      f.calls.push(`collateral ${amount.toString()}`);
      const l = own();
      setLine(l !== undefined && l.state === 'Collecting' ? { ...l, collateral: l.collateral + amount } : line({ state: 'Collecting', limit: 0n, collateral: amount, feeBps: 0, dueMs: 0 }));
      return 'TXC';
    },
    openLine: async (limit, feeBps, dueMs) => {
      f.calls.push(`open ${limit.toString()} ${String(feeBps)} ${String(dueMs)}`);
      setLine({ ...(own() ?? line()), state: 'Open', limit, feeBps, dueMs, returned: 0n });
      return 'TXO';
    },
    pay: async (amount) => {
      f.calls.push(`pay ${amount.toString()}`);
      return { tx: 'TXP', outcome: 'allowed', reason: null, pendingId: null };
    },
    repay: async (amount) => {
      f.calls.push(`repay ${amount.toString()}`);
      setLine({ ...(own() ?? line()), state: 'Repaid', collateral: 0n });
      return 'TXR';
    },
    recycle: async (amount) => {
      f.calls.push(`recycle ${amount.toString()}`);
      return 'TXM';
    },
    sleep: async () => undefined,
    records: () => f.records,
    append: (r) => f.records.push(r),
    log: (l) => f.lines.push(l),
    ...over,
  };
  return f;
}

test('dry: reads the state, prints the plan with exact amounts, and sends nothing', async () => {
  const f = fakeIo({ liveOk: () => false });
  const out = await runCycle(f.io, { dry: true });
  assert.equal(out.code, 0);
  assert.deepEqual(f.calls, [], 'no lock, no preflight, no transaction');
  assert.equal(f.records.length, 0);
  const text = [...f.lines, out.line].join('\n');
  assert.match(text, /would post 0\.027 NEAR of collateral/);
  assert.match(text, /would open a line of 0\.09 NEAR, fee 10 percent, due in 24 h/);
  assert.match(text, /would pay the booked merchant 0\.09 NEAR \(amount from the owner task, label Owner\)/);
  assert.match(text, /would repay 0\.099 NEAR/);
  assert.match(text, /live switch off/);
  assert.match(out.line, /^ECONOMY DRY: nothing was sent; no stop rule holds$/);
  // a dry run on a state that stops says which rule
  const paused = await runCycle(fakeIo({}, healthy({ card: { paused: true, pending: [] } })).io, { dry: true });
  assert.equal(paused.line, 'ECONOMY DRY: nothing was sent; a live cycle would end with: STOP the card is paused');
});

test('live: without LIVE_OK, in maintenance, or with the lock held, nothing is read or sent', async () => {
  const off = fakeIo({ liveOk: () => false });
  assert.deepEqual(await runCycle(off.io, { dry: false }), { code: 0, line: LIVE_OFF });
  assert.deepEqual(off.calls, []);
  const maint = fakeIo({ maintenance: () => true });
  assert.match((await runCycle(maint.io, { dry: false })).line, /^STOP maintenance: target\/credit\/MAINTENANCE exists$/);
  assert.deepEqual(maint.calls, []);
  const held = fakeIo({ lock: () => null });
  const out = await runCycle(held.io, { dry: false });
  assert.deepEqual(out, { code: 0, line: 'STOP another credit job holds the lock (target/credit/LOCK)' });
  assert.deepEqual(held.calls, []);
});

test('live: a healthy cycle posts collateral, opens the line, pays, repays, sends back, records, and releases the lock', async () => {
  const f = fakeIo();
  const out = await runCycle(f.io, { dry: false });
  assert.equal(out.code, 0, out.line);
  assert.deepEqual(f.calls, [
    'lock',
    'preflight',
    `collateral ${(27n * 10n ** 21n).toString()}`,
    `open ${LOOP_LIMIT_YOCTO.toString()} 1000 ${String(NOW + 86_400_000)}`,
    `pay ${LOOP_LIMIT_YOCTO.toString()}`,
    `repay ${(99n * 10n ** 21n).toString()}`,
    `recycle ${(50n * CENT).toString()}`,
    'unlock',
  ]);
  assert.match(out.line, /^ECONOMY CYCLE OK pay TXP repay TXR fee 0\.009 NEAR$/);
  const cycle = f.records.find((r) => r.kind === 'cycle');
  assert.ok(cycle !== undefined && cycle.kind === 'cycle');
  assert.deepEqual({ limit: cycle.limit, fee: cycle.fee, pay: cycle.txs.pay, repay: cycle.txs.repay }, { limit: LOOP_LIMIT_YOCTO.toString(), fee: (9n * 10n ** 21n).toString(), pay: 'TXP', repay: 'TXR' });
  assert.ok(f.records.some((r) => r.kind === 'recycle'));
});

test('live: a stop rule ends the run with exit 0 and no transaction; a failed preflight ends it with exit 1', async () => {
  const stopped = fakeIo({}, healthy({ lastCycleMs: NOW - 10 * MIN }));
  const out = await runCycle(stopped.io, { dry: false });
  assert.equal(out.code, 0);
  assert.match(out.line, /^STOP the last loop cycle was 10 min ago/);
  assert.deepEqual(stopped.calls, ['lock', 'preflight', 'unlock']);
  const unfit = fakeIo({ preflight: async () => 'the task key file is not the task key the card holds' });
  const bad = await runCycle(unfit.io, { dry: false });
  assert.equal(bad.code, 1);
  assert.match(bad.line, /^ECONOMY CYCLE FAILED preflight: the task key file/);
});

test('recovery: an open loop line is repaid before anything else, and no new line is opened in that run', async () => {
  const open = healthy({ pool: { ...healthy().pool, lines: [line({ state: 'Open', limit: LOOP_LIMIT_YOCTO, feeBps: 1000, returned: 0n, collateral: 27n * 10n ** 21n, dueMs: NOW + 3_600_000 })] }, lastCycleMs: NOW - 5 * MIN, card: { paused: true, pending: [] } });
  const f = fakeIo({}, open);
  const out = await runCycle(f.io, { dry: false });
  assert.equal(out.code, 0, out.line);
  assert.deepEqual(f.calls, ['lock', 'preflight', `repay ${(99n * 10n ** 21n).toString()}`, 'unlock']);
  assert.match(out.line, /^ECONOMY RECOVERED the loop's open line was repaid \(TXR\)/);
  // what was already swept back is not repaid twice
  const part = healthy({ pool: { ...healthy().pool, lines: [line({ state: 'Open', limit: LOOP_LIMIT_YOCTO, feeBps: 1000, returned: 4n * CENT })] } });
  const g = fakeIo({}, part);
  await runCycle(g.io, { dry: false });
  assert.ok(g.calls.includes(`repay ${(55n * 10n ** 21n).toString()}`), '0.05 kept plus 0.005 fee');
});

test('a run that died after the collateral: the next one posts only what is missing', async () => {
  const collecting = (have: bigint): EconomyState => healthy({ pool: { ...healthy().pool, collateralHeld: have, lines: [line({ state: 'Collecting', limit: 0n, collateral: have })] } });
  const full = fakeIo({}, collecting(27n * 10n ** 21n));
  await runCycle(full.io, { dry: false });
  assert.ok(!full.calls.some((c) => c.startsWith('collateral')));
  assert.ok(full.calls.some((c) => c.startsWith('open ')));
  const half = fakeIo({}, collecting(10n ** 22n));
  await runCycle(half.io, { dry: false });
  assert.ok(half.calls.includes(`collateral ${(17n * 10n ** 21n).toString()}`));
});

test('a payment the card does not allow: the line is still repaid at once, the hold is recorded, and the run fails', async () => {
  const f = fakeIo({ pay: async () => ({ tx: 'TXP', outcome: 'escalated', reason: 'NewRecipient', pendingId: '12' }) });
  const out = await runCycle(f.io, { dry: false });
  assert.equal(out.code, 1);
  assert.match(out.line, /^ECONOMY CYCLE FAILED the payment was escalated NewRecipient, not allowed \(TXP\); the line was repaid \(TXR\)/);
  assert.ok(f.calls.some((c) => c.startsWith('repay ')));
  assert.ok(f.records.some((r) => r.kind === 'hold' && r.id === '12'));
  assert.equal(f.calls.at(-1), 'unlock');
});

test('the loop expires its own holds once they are past their time, never anything else, and never rejects', async () => {
  const own = { id: '12', taskId: 'loop-1-ab', agent: ECONOMY_ACCOUNTS.agent, expiresMs: NOW - MIN };
  const young = { id: '13', taskId: 'loop-2-ab', agent: ECONOMY_ACCOUNTS.agent, expiresMs: NOW + MIN };
  const arena = { id: '14', taskId: 'arena-1-ab', agent: ECONOMY_ACCOUNTS.agent, expiresMs: NOW - MIN };
  const f = fakeIo({}, healthy({ card: { paused: false, pending: [own, young, arena] } }));
  const out = await runCycle(f.io, { dry: false });
  assert.deepEqual(f.calls.filter((c) => c.startsWith('expire')), ['expire 12']);
  assert.match(out.line, /^STOP the card has 1 held request that is not an arena hold/, 'the young loop hold still stops the cycle');
  for (const file of ['scripts/credit-economy.ts', 'scripts/credit-economy-cron.sh', 'runtime/src/economy/cycle.ts', 'runtime/src/economy/stops.ts', 'runtime/src/economy/facts.ts']) {
    const src = readFileSync(join(REPO, file), 'utf8');
    for (const name of ['reject', 'approve', 'reset_escalations']) assert.ok(!src.includes(`'${name}'`) && !src.includes(`"${name}"`), `${file} names ${name}`);
  }
});

test('the lock file: one holder at a time, a dead holder is replaced, release removes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credit-lock-'));
  const path = join(dir, 'credit', 'LOCK');
  const release = takeLock(path, NOW);
  assert.ok(release !== null);
  assert.ok(existsSync(path));
  assert.equal(takeLock(path, NOW + 1000), null, 'held by a live process');
  release();
  assert.ok(!existsSync(path));
  // a holder that is gone, or a lock older than 30 minutes, is stale
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, atMs: NOW }));
  const second = takeLock(path, NOW + 1000, { alive: () => false });
  assert.ok(second !== null);
  second();
  writeFileSync(path, JSON.stringify({ pid: process.pid, atMs: NOW - 31 * MIN }));
  const third = takeLock(path, NOW);
  assert.ok(third !== null);
  third();
  writeFileSync(path, 'not json');
  assert.equal(takeLock(path, NOW), null, 'an unreadable young lock is left alone');
});

test('the cron wrapper: one cycle, a UTC-stamped log, exit 1 only on a failed cycle', () => {
  const sh = readFileSync(join(REPO, 'scripts', 'credit-economy-cron.sh'), 'utf8');
  assert.match(sh, /scripts\/credit-economy\.ts/);
  assert.match(sh, /\^STOP /);
  assert.match(sh, /ECONOMY CYCLE OK|ECONOMY RECOVERED/);
  assert.match(sh, /economy\/cron\.log|cron\.log/);
});

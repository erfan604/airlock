// AIR-329: the fixture the /credit page runs on until the pool contract (AIR-328) is deployed. Every number and every event here is made up by this
// file, and the page badges all of it "Fixture data". The generator is seeded, so a test and a screenshot see the same network.
import type { Chain, CreditEvent, EventKind, Line, PoolView } from './model.ts';
import { CHAINS } from './model.ts';

const NEAR = (n: number): string => (BigInt(n) * 10n ** 24n).toString();

const DAY = 86_400_000;
/** The clock the exported fixture (used by tests and the static e2e) is built at; the page builds its own from the real time. */
export const FIXTURE_NOW = 1_794_000_000_000;

/**
 * The made-up pool, shaped like a small young pool: 30% utilization, fees near 1%, 0.8% earned in 45 days (about 6.5% a year, of which 70% from
 * fees and the rest from staking). Due dates and the start are relative to `nowMs`, so the table never shows a fixture line past due.
 */
export function fixturePool(nowMs: number): PoolView {
  const due = (days: number): string => String(nowMs + days * DAY);
  const lines: Line[] = [
    { card: 'card-ledger.fixture', borrower: 'ledger-agent.fixture', limit: NEAR(600), drawn: NEAR(400), returned: NEAR(150), feeBps: 100, dueMs: due(21), state: 'open' },
    { card: 'card-scout.fixture', borrower: 'scout-agent.fixture', limit: NEAR(400), drawn: NEAR(280), returned: NEAR(60), feeBps: 110, dueMs: due(14), state: 'open' },
    { card: 'card-courier.fixture', borrower: 'courier-agent.fixture', limit: NEAR(500), drawn: NEAR(320), returned: NEAR(320), feeBps: 100, dueMs: due(3), state: 'repaid' },
    { card: 'card-atlas.fixture', borrower: 'atlas-agent.fixture', limit: NEAR(300), drawn: NEAR(300), returned: NEAR(40), feeBps: 120, dueMs: due(9), state: 'open' },
    { card: 'card-relay.fixture', borrower: 'relay-agent.fixture', limit: NEAR(1000), drawn: NEAR(800), returned: NEAR(30), feeBps: 90, dueMs: due(30), state: 'open' },
  ];
  return {
    assets: NEAR(5_000),
    shares: NEAR(4_960),
    idle: NEAR(2_500),
    staked: NEAR(1_000),
    lent: NEAR(1_500),
    feesEarned: NEAR(28),
    losses: '0',
    sharePrice: '1008000000000000000000000',
    lines,
    stakingEarned: NEAR(12),
    startedMs: String(nowMs - 45 * DAY),
  };
}

export const FIXTURE_POOL: PoolView = fixturePool(FIXTURE_NOW);
export const FIXTURE_LINES: Line[] = FIXTURE_POOL.lines;

/** mulberry32: a small seeded generator, enough for a stage show. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIX: { kind: EventKind; weight: number }[] = [
  { kind: 'card_paid', weight: 12 },
  { kind: 'card_held', weight: 3 },
  { kind: 'card_refused', weight: 3 },
  { kind: 'deposit', weight: 2 },
  { kind: 'repaid', weight: 2 },
  { kind: 'withdraw', weight: 1 },
];

const LPS = ['lp-one.fixture', 'lp-two.fixture', 'lp-three.fixture'];

/** The n-th fixture event of a seeded stream. `nowMs` stamps it; the kind, card, chain and amount depend only on `seed` and `n`. */
export function fixtureEvent(seed: number, n: number, nowMs: number): CreditEvent {
  const r = rng(seed * 7919 + n * 104729);
  const total = MIX.reduce((s, m) => s + m.weight, 0);
  let pick = r() * total;
  let kind: EventKind = 'card_paid';
  for (const m of MIX) {
    pick -= m.weight;
    if (pick < 0) {
      kind = m.kind;
      break;
    }
  }
  const line = FIXTURE_LINES[Math.floor(r() * FIXTURE_LINES.length)] ?? FIXTURE_LINES[0];
  const chain: Chain = CHAINS[Math.floor(r() * CHAINS.length)] ?? 'near';
  const lp = LPS[Math.floor(r() * LPS.length)] ?? 'lp-one.fixture';
  const whole = 1 + Math.floor(r() * 24);
  const amount = kind === 'repaid' || kind === 'deposit' || kind === 'withdraw' ? NEAR(whole * 4) : NEAR(whole);
  const money = kind === 'deposit' || kind === 'withdraw';
  const spend = kind === 'card_paid' || kind === 'card_held' || kind === 'card_refused';
  return {
    id: `fx-${String(seed)}-${String(n)}`,
    kind,
    atMs: nowMs,
    who: money ? lp : (line?.card ?? 'card-ledger.fixture'),
    amount,
    chain: spend ? chain : null,
    requestId: kind === 'card_held' ? `fx-req-${String(seed)}-${String(n)}` : null,
    tx: null,
    fixture: true,
  };
}

/** The recent history a fresh page starts with, oldest first, spaced `gapMs` apart and ending at `nowMs`. */
export function fixtureHistory(seed: number, count: number, nowMs: number, gapMs = 9_000): CreditEvent[] {
  const out: CreditEvent[] = [];
  for (let i = 0; i < count; i += 1) out.push(fixtureEvent(seed, -(count - i), nowMs - (count - 1 - i) * gapMs));
  return out;
}

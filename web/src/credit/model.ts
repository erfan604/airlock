// AIR-329: the types, parsers and money math of the /credit page. The pool contract (AIR-328) lands in parallel: the view and event shapes below
// are the ones the ticket fixes, and a parser refuses anything else instead of guessing, so a contract that drifts shows as "unreadable", never as
// zeros. Amounts are decimal strings of the smallest unit (yoctoNEAR) and BigInt math only: no Number, parseInt or parseFloat anywhere here.

export const CHAINS = ['near', 'base', 'solana'] as const;
export type Chain = (typeof CHAINS)[number];

// the contract's states are Collecting, Open, Repaid and Defaulted (docs/design/credit.md); a name the page does not know shows as unknown
export const LINE_STATES = ['collecting', 'open', 'repaid', 'defaulted', 'unknown'] as const;
export type LineState = (typeof LINE_STATES)[number];

export type Line = {
  card: string;
  borrower: string;
  limit: string;
  drawn: string;
  returned: string;
  feeBps: number;
  dueMs: string;
  state: LineState;
};

/** The `get_pool` view of the credit contract. `started_ms` and `staking_earned` are optional extras: absent means the page shows no annualised figure. */
export type PoolView = {
  assets: string;
  shares: string;
  idle: string;
  staked: string;
  lent: string;
  feesEarned: string;
  losses: string;
  sharePrice: string;
  lines: Line[];
  stakingEarned: string | null;
  startedMs: string | null;
};

export const EVENT_KINDS = ['deposit', 'withdraw', 'line_opened', 'card_paid', 'card_held', 'card_refused', 'swept', 'repaid', 'defaulted'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** One chain event of the pool or of a card. `fixture` events come from the page's own generator and are always badged. */
export type CreditEvent = {
  id: string;
  kind: EventKind;
  atMs: number;
  /** the LP account of a deposit or withdraw, the card of every other event */
  who: string;
  amount: string;
  chain: Chain | null;
  /** links a held payment to the paid or refused event that settles it */
  requestId: string | null;
  tx: string | null;
  fixture: boolean;
};

const UINT = /^(0|[1-9][0-9]{0,38})$/;
const ACCOUNT = /^[a-z0-9._-]{2,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const uint = (v: unknown): string | null => (typeof v === 'string' && UINT.test(v) ? v : null);

export class ShapeError extends Error {
  constructor(what: string) {
    super(`the pool view is not in the expected shape: ${what}`);
    this.name = 'ShapeError';
  }
}

function parseLine(raw: unknown, i: number): Line {
  if (!isObj(raw)) throw new ShapeError(`line ${String(i)}`);
  const card = raw['card'];
  const borrower = raw['borrower'];
  const limit = uint(raw['limit']);
  const drawn = uint(raw['drawn']);
  const returned = uint(raw['returned']);
  const due = uint(raw['due_ms']);
  const fee = raw['fee_bps'];
  if (typeof card !== 'string' || !ACCOUNT.test(card)) throw new ShapeError(`line ${String(i)} card`);
  if (typeof borrower !== 'string' || !ACCOUNT.test(borrower)) throw new ShapeError(`line ${String(i)} borrower`);
  if (limit === null || drawn === null || returned === null || due === null) throw new ShapeError(`line ${String(i)} amounts`);
  if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0 || fee > 10_000) throw new ShapeError(`line ${String(i)} fee_bps`);
  const state = LINE_STATES.find((s) => s === String(raw['state']).toLowerCase()) ?? 'unknown';
  return { card, borrower, limit, drawn, returned, feeBps: fee, dueMs: due, state };
}

export function parsePool(raw: unknown): PoolView {
  if (!isObj(raw)) throw new ShapeError('not an object');
  const get = (k: string): string => {
    const v = uint(raw[k]);
    if (v === null) throw new ShapeError(k);
    return v;
  };
  const lines = raw['lines'];
  if (!Array.isArray(lines)) throw new ShapeError('lines');
  const staking = raw['staking_earned'] === undefined || raw['staking_earned'] === null ? null : uint(raw['staking_earned']);
  const started = raw['started_ms'] === undefined || raw['started_ms'] === null ? null : uint(raw['started_ms']);
  return {
    assets: get('assets'),
    shares: get('shares'),
    idle: get('idle'),
    staked: get('staked'),
    lent: get('lent'),
    feesEarned: get('fees_earned'),
    losses: get('losses'),
    sharePrice: get('share_price'),
    lines: lines.map(parseLine),
    stakingEarned: staking,
    startedMs: started,
  };
}

/** The `get_lp(account_id)` view: the LP's pool shares, as `{shares}` or a bare decimal string. Anything else is refused. */
export function parseLp(raw: unknown): string {
  const v = isObj(raw) ? uint(raw['shares']) : uint(raw);
  if (v === null) throw new ShapeError('get_lp shares');
  return v;
}

/** The standard of a card policy's own events (docs/events.md); the pool's are `airlock-credit`. */
const POLICY_STANDARD = 'airlock';
const POOL_STANDARD = 'airlock-credit';

/** The chain of a policy asset id: `near`, or an EVM or Solana asset named by its chain. null when the id says none of them. */
function chainOfAsset(asset: unknown): Chain | null {
  if (typeof asset !== 'string') return null;
  const a = asset.toLowerCase();
  if (a === 'near' || a.startsWith('near')) return 'near';
  if (a.startsWith('base') || a.startsWith('evm') || a.startsWith('eth')) return 'base';
  if (a.startsWith('sol')) return 'solana';
  return null;
}

/** The log line prefix of NEP-297 events. */
const EVENT_PREFIX = 'EVENT_JSON:';

/**
 * One contract log line as an event, or null when it is not one the page shows. `executor` is the account that logged it. The pool's events (standard
 * `airlock-credit`) map by name. The card policy's own events (standard `airlock`, docs/design/credit.md) map as: `allowed` is a payment, `escalated` a
 * held payment, `blocked` and `rejected` (the borrower turned a held payment down) a refused one, with the card as `who`; the held and blocked events carry no amount, so theirs is 0. A line naming an unknown
 * event is skipped, never guessed.
 */
export function parseEventLog(line: string, atMs: number, tx: string | null, index: number, executor: string | null = null): CreditEvent | null {
  if (!line.startsWith(EVENT_PREFIX)) return null;
  let body: unknown;
  try {
    body = JSON.parse(line.slice(EVENT_PREFIX.length)) as unknown;
  } catch {
    return null;
  }
  if (!isObj(body)) return null;
  const data = Array.isArray(body['data']) ? body['data'][0] : undefined;
  if (!isObj(data)) return null;
  const id = `${tx ?? 'nx'}:${String(index)}`;
  const requestId = typeof data['request_id'] === 'string' && data['request_id'].length <= 100 ? data['request_id'] : null;
  if (body['standard'] === POLICY_STANDARD) {
    const kind = ({ allowed: 'card_paid', escalated: 'card_held', blocked: 'card_refused', rejected: 'card_refused' } as Record<string, EventKind | undefined>)[String(body['event'])];
    if (kind === undefined || executor === null || !ACCOUNT.test(executor)) return null;
    const amount = data['amount'] === undefined ? '0' : uint(data['amount']);
    if (amount === null) return null;
    return { id, kind, atMs, who: executor, amount, chain: chainOfAsset(data['asset']) ?? 'near', requestId, tx, fixture: false };
  }
  if (body['standard'] !== POOL_STANDARD) return null;
  const kind = EVENT_KINDS.find((k) => k === body['event']);
  if (kind === undefined) return null;
  const who = data['account'] ?? data['card'];
  // the amount a row shows: a line opening shows its limit, a default the loss (else the seized collateral)
  const raw = data['amount'] ?? (kind === 'line_opened' ? data['limit'] : kind === 'defaulted' ? (data['loss'] ?? data['seized']) : undefined);
  const amount = raw === undefined || raw === null ? '0' : uint(raw);
  if (typeof who !== 'string' || !ACCOUNT.test(who) || amount === null) return null;
  const chain = CHAINS.find((c) => c === data['chain']) ?? null;
  return { id, kind, atMs, who, amount, chain, requestId, tx, fixture: false };
}

// Money below: BigInt only

const YOCTO = 10n ** 24n;

/** A decimal NEAR amount typed by a person ("1.5") as yocto, or null when it is not a plain decimal with at most 24 places. */
export function parseNear(text: string): bigint | null {
  const m = /^(0|[1-9][0-9]{0,18})(?:\.([0-9]{1,24}))?$/.exec(text.trim());
  if (m === null) return null;
  const whole = BigInt(m[1] ?? '0');
  const frac = (m[2] ?? '').padEnd(24, '0');
  return whole * YOCTO + BigInt(frac === '' ? '0' : frac);
}

/** Yocto as NEAR text with `places` decimals (truncated, never rounded up), grouped by thousands: `1234500000000000000000000` is `1.23`. */
export function formatNear(yocto: string | bigint, places = 2): string {
  const v = typeof yocto === 'bigint' ? yocto : BigInt(yocto);
  const scale = 10n ** BigInt(24 - places);
  const units = v / scale;
  const whole = units / 10n ** BigInt(places);
  const frac = (units % 10n ** BigInt(places)).toString().padStart(places, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return places === 0 ? grouped : `${grouped}.${frac}`;
}

/** Basis points of `part` in `whole`, truncated; 0 when `whole` is 0. */
export function bps(part: string | bigint, whole: string | bigint): bigint {
  const w = BigInt(whole);
  return w === 0n ? 0n : (BigInt(part) * 10_000n) / w;
}

/** Basis points as percent text with two places: `1234` is `12.34%`. */
export function percent(basis: bigint): string {
  const whole = basis / 100n;
  const frac = (basis % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${frac}%`;
}

/** The pool's share price is `1e24` for one NEAR per share at the start; this is the return over that start in basis points, never below 0. */
export function returnBps(sharePrice: string): bigint {
  const p = BigInt(sharePrice);
  return p <= YOCTO ? 0n : ((p - YOCTO) * 10_000n) / YOCTO;
}

/** Shares a deposit of `amount` buys at the current price, the way a share pool prices them: amount * shares / assets, 1 to 1 for an empty pool. */
export function sharesFor(amount: bigint, shares: string, assets: string): bigint {
  const s = BigInt(shares);
  const a = BigInt(assets);
  return s === 0n || a === 0n ? amount : (amount * s) / a;
}

/** NEAR an LP gets for `shares` at the current price. */
export function assetsFor(shares: bigint, sharesTotal: string, assets: string): bigint {
  const s = BigInt(sharesTotal);
  return s === 0n ? 0n : (shares * BigInt(assets)) / s;
}

export type Derived = {
  utilizationBps: bigint;
  /** share of the pool's cumulative return that came from spend fees, in basis points of the sum of fees and staking; null when both are 0 */
  feeSplitBps: bigint | null;
  /** annualised return in basis points, only when the view says when the pool started and it is at least a day old */
  aprBps: bigint | null;
  returnBps: bigint;
};

const YEAR_MS = 31_557_600_000n;
const DAY_MS = 86_400_000n;

export function derive(p: PoolView, nowMs: bigint): Derived {
  const fees = BigInt(p.feesEarned);
  const staking = BigInt(p.stakingEarned ?? '0');
  const total = fees + staking;
  const ret = returnBps(p.sharePrice);
  let apr: bigint | null = null;
  if (p.startedMs !== null) {
    const age = nowMs - BigInt(p.startedMs);
    if (age >= DAY_MS) apr = (ret * YEAR_MS) / age;
  }
  return { utilizationBps: bps(p.lent, p.assets), feeSplitBps: total === 0n ? null : (fees * 10_000n) / total, aprBps: apr, returnBps: ret };
}

/** The sum of refused value in a list of events: what the airlock kept out of the pool's money, from the events the page holds. */
export function refusedSum(events: readonly CreditEvent[]): bigint {
  let sum = 0n;
  for (const e of events) if (e.kind === 'card_refused') sum += BigInt(e.amount);
  return sum;
}

export type Passport = { allowed: number; held: number; refused: number; repaid: number; defaulted: boolean; score: number };

/** A card's record read from its events. The score is 0 to 100: on-time repayment and allowed spend raise it, refusals and a default cut it. Integer math. */
export function passportOf(card: string, events: readonly CreditEvent[], lineDefaulted = false): Passport {
  let allowed = 0;
  let held = 0;
  let refused = 0;
  let repaid = 0;
  let defaulted = lineDefaulted;
  for (const e of events) {
    if (e.who !== card) continue;
    if (e.kind === 'card_paid') allowed += 1;
    else if (e.kind === 'card_held') held += 1;
    else if (e.kind === 'card_refused') refused += 1;
    else if (e.kind === 'repaid') repaid += 1;
    else if (e.kind === 'defaulted') defaulted = true;
  }
  const raw = 50 + Math.min(allowed, 20) * 2 + Math.min(repaid, 5) * 4 - Math.min(refused, 10) * 3 - (defaulted ? 60 : 0);
  return { allowed, held, refused, repaid, defaulted, score: Math.max(0, Math.min(100, raw)) };
}

export function shortId(id: string, max = 22): string {
  return id.length <= max ? id : `${id.slice(0, max - 9)}...${id.slice(-6)}`;
}

/** The chain a card is assumed to live on until it pays: a stable pick from its name. */
export function homeChain(card: string): Chain {
  let h = 0;
  for (let i = 0; i < card.length; i += 1) h = (h * 31 + card.charCodeAt(i)) % 9973;
  return CHAINS[h % CHAINS.length] ?? 'near';
}

export { explorerAccount, shownAccount } from '../components/account.ts';

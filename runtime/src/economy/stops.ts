// AIR-359: the state one cycle reads and the stop rules checked before any transaction. Each rule ends the run with exit 0 and one line.
import { OwnerTask, ActionRequest, TASK_TAG, labelsToBits, sha256Hex } from '../dsl/index.ts';
import {
  AGENT_FLOOR_YOCTO,
  ARENA_QUIET_MS,
  ARENA_TASK_PREFIX,
  BORROWER_FLOOR_YOCTO,
  BORROWER_LOW_YOCTO,
  BUFFER_FLOOR_YOCTO,
  ECONOMY_ACCOUNTS,
  IDLE_FLOOR_YOCTO,
  ISSUER_FLOOR_YOCTO,
  LOOP_FEE_BPS,
  LOOP_LIMIT_YOCTO,
  LOOP_TASK_PREFIX,
  LOOP_TASK_TTL_MS,
  MERCHANT_KEEP_YOCTO,
  MIN_CYCLE_SPACING_MS,
  MIN_RECYCLE_YOCTO,
  PASSPORT_FLOOR_DIV,
  STORAGE_YOCTO_PER_BYTE,
  YOCTO_PER_NEAR,
} from './facts.ts';

export type LineState = 'Collecting' | 'Open' | 'Repaid' | 'Defaulted';
/** One line of get_pool (the pool's LineView). */
export type LineView = { card: string; borrower: string; limit: bigint; returned: bigint; feeBps: number; dueMs: number; collateral: bigint; state: LineState };
export type PoolState = {
  idle: bigint;
  impaired: bigint;
  losses: bigint;
  collateralHeld: bigint;
  collateralBps: number;
  feesEarned: bigint;
  lines: LineView[];
  /** the pool account's balance and storage use */
  balance: bigint;
  storageBytes: bigint;
};
/** The borrower's Passport after the pool upgrade (AIR-333); null on the pool before it, which has no such view. */
export type Passport = { base: bigint; cap: bigint; score: number } | null;
export type Held = { id: string; taskId: string | null; agent: string | null; expiresMs: number };
export type EconomyState = {
  pool: PoolState;
  passport: Passport;
  card: { paused: boolean; pending: Held[] };
  balances: { borrower: bigint; agent: bigint; issuer: bigint; merchant: bigint };
  /** the last loop payment, from the chain and the loop's own archive */
  lastCycleMs: number | null;
  /** the last arena attempt on the card */
  lastArenaMs: number | null;
};

export const LIVE_OFF = 'STOP live cycles are off: target/economy/LIVE_OK is missing';
export const MAINTENANCE = 'STOP maintenance: target/credit/MAINTENANCE exists';
export const LOCK_HELD = 'STOP another credit job holds the lock (target/credit/LOCK)';

/** Yocto as NEAR text with no trailing zeros, BigInt only. */
export function nearText(yocto: bigint): string {
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return frac === '' ? (yocto / YOCTO_PER_NEAR).toString() : `${(yocto / YOCTO_PER_NEAR).toString()}.${frac}`;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
/** The pool's fee on what a line kept: ceil(outstanding * fee_bps / 10000), as math.rs fee_of. */
export const feeOf = (outstanding: bigint, feeBps: number): bigint => ceilDiv(outstanding * BigInt(feeBps), 10_000n);
/** The collateral a line needs: ceil(limit * collateral_bps / 10000), as math.rs collateral_needed. */
export const collateralNeeded = (limit: bigint, collateralBps: number): bigint => ceilDiv(limit * BigInt(collateralBps), 10_000n);

/** The pool's NEAR that is neither locked for storage, idle liquidity nor held collateral. */
export const poolBuffer = (p: PoolState): bigint => p.balance - p.storageBytes * STORAGE_YOCTO_PER_BYTE - p.idle - p.collateralHeld;

/** The loop's own line on its card: the card's line when it has the loop's limit and fee, or is still collecting. */
export function ownLine(p: PoolState): LineView | null {
  const l = p.lines.find((x) => x.card === ECONOMY_ACCOUNTS.card);
  if (l === undefined) return null;
  if (l.state === 'Collecting') return l;
  return l.limit === LOOP_LIMIT_YOCTO && l.feeBps === LOOP_FEE_BPS ? l : null;
}

const isArenaHold = (h: Held): boolean => h.agent === ECONOMY_ACCOUNTS.agent && h.taskId !== null && h.taskId.startsWith(ARENA_TASK_PREFIX);
export const isLoopHold = (h: Held): boolean => h.agent === ECONOMY_ACCOUNTS.agent && h.taskId !== null && h.taskId.startsWith(LOOP_TASK_PREFIX);

const minutes = (ms: number): string => String(Math.floor(ms / 60_000));

/**
 * The first stop rule that holds, as one line, or null when a cycle may run. An open line of the loop itself is not a stop: the cycle
 * repays it first (recovery). Holds of the arena do not stop the loop: under strict mode every arena round leaves its requests held for
 * an hour, and the loop's payment is an Allow that touches no flood counter.
 */
export function economyStop(s: EconomyState, nowMs: number): string | null {
  const own = ownLine(s.pool);
  const foreign = s.pool.lines.find((l) => l.state === 'Open' && l !== own);
  if (foreign !== undefined) return `STOP a line is open that the loop did not open (card ${foreign.card}, limit ${nearText(foreign.limit)} NEAR)`;
  if (s.card.paused) return 'STOP the card is paused';
  const held = s.card.pending.filter((h) => !isArenaHold(h));
  if (held.length > 0) return `STOP the card has ${held.length === 1 ? '1 held request' : `${String(held.length)} held requests`} that ${held.length === 1 ? 'is' : 'are'} not an arena hold`;
  if (s.pool.impaired > 0n) return `STOP the pool has a line past due (impaired ${nearText(s.pool.impaired)} NEAR)`;
  if (s.pool.losses > 0n) return `STOP the pool has an unrecovered loss (${nearText(s.pool.losses)} NEAR)`;
  if (s.lastCycleMs !== null && nowMs - s.lastCycleMs < MIN_CYCLE_SPACING_MS) return `STOP the last loop cycle was ${minutes(nowMs - s.lastCycleMs)} min ago, under 55 min`;
  if (s.lastArenaMs !== null && nowMs - s.lastArenaMs < ARENA_QUIET_MS) return `STOP the last arena attempt was ${minutes(nowMs - s.lastArenaMs)} min ago, under 10 min`;
  if (s.pool.idle < IDLE_FLOOR_YOCTO) return 'STOP the pool idle liquidity is under 0.2 NEAR';
  if (s.balances.borrower < BORROWER_FLOOR_YOCTO) return 'STOP the borrower balance is under 0.2 NEAR';
  if (s.balances.agent < AGENT_FLOOR_YOCTO) return 'STOP the agent balance is under 0.1 NEAR';
  if (s.balances.issuer < ISSUER_FLOOR_YOCTO) return 'STOP the issuer balance is under 0.1 NEAR';
  const buffer = poolBuffer(s.pool);
  if (buffer < BUFFER_FLOOR_YOCTO) return `STOP ALERT the pool storage buffer is under 0.3 NEAR (${buffer < 0n ? 'below 0' : nearText(buffer)} NEAR): send the pool a plain transfer`;
  if (s.passport !== null) {
    if (LOOP_LIMIT_YOCTO > s.passport.cap) return `STOP the loop line of ${nearText(LOOP_LIMIT_YOCTO)} NEAR is above the borrower's Passport cap of ${nearText(s.passport.cap)} NEAR (score ${String(s.passport.score)})`;
    if (LOOP_LIMIT_YOCTO * PASSPORT_FLOOR_DIV >= s.passport.base) return `STOP the loop line would count toward the borrower's Passport (it is not under a tenth of the base of ${nearText(s.passport.base)} NEAR)`;
  }
  return null;
}

export type EconomyRecord =
  | { kind: 'cycle'; at: string; atMs: number; limit: string; fee: string; txs: { collateral: string | null; open: string; pay: string | null; repay: string } }
  | { kind: 'recovered'; at: string; atMs: number; amount: string; tx: string }
  | { kind: 'recycle'; atMs: number; amount: string; tx: string; at?: string }
  | { kind: 'hold'; at: string; atMs: number; id: string; tx: string | null }
  | { kind: 'expire'; at: string; atMs: number; id: string; tx: string }
  | { kind: 'failed'; at: string; atMs: number; why: string };

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * What the merchant sends back to the borrower now, or null: its balance above the keep, once a UTC day, and again the same day when the
 * borrower is under 1 NEAR. (The borrower pays 0.099 NEAR a cycle and the merchant receives 0.09, so the money has to come back.)
 */
export function recycleDue(p: { merchant: bigint; borrower: bigint; records: readonly EconomyRecord[]; nowMs: number }): bigint | null {
  const amount = p.merchant - MERCHANT_KEEP_YOCTO;
  if (amount < MIN_RECYCLE_YOCTO) return null;
  const today = p.records.some((r) => r.kind === 'recycle' && utcDay(r.atMs) === utcDay(p.nowMs));
  return !today || p.borrower < BORROWER_LOW_YOCTO ? amount : null;
}

/**
 * The loop's payment: an owner task that bounds the booked merchant at the line, and one request whose amount is the task's own (label
 * Owner) to the booked payee (label Book). Strict mode allows it: no amount is read from text. No sender origin: nothing was read.
 */
export function loopRequest(p: { nowMs: number; suffix: string }): { req: ActionRequest; task: OwnerTask } {
  const payee = `near:${ECONOMY_ACCOUNTS.merchant}`;
  const task = OwnerTask.parse({
    tag: TASK_TAG,
    task_id: `${LOOP_TASK_PREFIX}${String(p.nowMs)}-${p.suffix}`,
    contract_id: ECONOMY_ACCOUNTS.card,
    agent_id: ECONOMY_ACCOUNTS.agent,
    plan_sha256: sha256Hex(new TextEncoder().encode('credit:economy-loop')),
    instruction_sha256_salted: sha256Hex(new TextEncoder().encode(`salt:economy-loop:${p.suffix}`)),
    issued_ms: p.nowMs - 1000,
    expires_ms: p.nowMs + LOOP_TASK_TTL_MS,
    max_actions: 1,
    bounds: [{ payee_key: payee, max_total: LOOP_LIMIT_YOCTO.toString() }],
  });
  const req = ActionRequest.parse({
    task_id: task.task_id,
    action_index: 0,
    asset: 'near',
    payee,
    amount: LOOP_LIMIT_YOCTO.toString(),
    labels: { recipient: labelsToBits(['Book']), amount: labelsToBits(['Owner']), pc: labelsToBits(['Owner']) },
    evm: null,
    hints: { plan_hash: task.plan_sha256, trace_digest: '0'.repeat(64) },
  });
  return { req, task };
}

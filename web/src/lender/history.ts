// AIR-359: the pool's share price over time, the loop's cycles and the borrowing since a lender joined, all folded from the pool's own events
// (lenders.ts poolEvents) with the contract's rules (contracts/airlock-credit/src/lib.rs): a deposit and a withdraw move assets and shares, a
// repay adds its fee, a default books what the seized collateral did not cover (and any fee it did), a sweep during an open line is neutral
// and a sweep after a default adds back. assets = idle + lent; the price is floor(assets * 1e24 / shares). If the fold does not end exactly at
// the pool's live assets and shares (a page cut off, an event the page does not know), the history is not shown: only the live value is.
import type { PoolEvent } from './lenders.ts';

export const ONE = 10n ** 24n;
/** One price step; `held` is the shares of the account the fold was asked about (0 when none). */
export type PricePoint = { atMs: number; assets: bigint; shares: bigint; price: bigint; held: bigint };

const uint = (v: unknown): bigint | null => (typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v) ? BigInt(v) : null);
export const priceOf = (assets: bigint, shares: bigint): bigint => (shares === 0n ? ONE : (assets * ONE) / shares);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

type LineState = { kind: 'open'; limit: bigint; feeBps: bigint; returned: bigint } | { kind: 'defaulted'; loss: bigint };

/** The price after each event that moved it, or null when an event cannot be applied (an unknown line, a negative balance). */
export function foldPrices(events: readonly PoolEvent[], account: string | null = null): PricePoint[] | null {
  let assets = 0n;
  let held = 0n;
  let shares = 0n;
  const lines = new Map<string, LineState>();
  const points: PricePoint[] = [];
  const mark = (atMs: number): void => {
    points.push({ atMs, assets, shares, price: priceOf(assets, shares), held });
  };
  for (const e of events) {
    const d = e.data;
    const card = typeof d['card'] === 'string' ? d['card'] : null;
    switch (e.event) {
      case 'deposit':
      case 'withdraw_failed': {
        const a = uint(d['amount']);
        const s = uint(d['shares']);
        if (a === null || s === null) return null;
        assets += a;
        shares += s;
        if (account !== null && d['account'] === account) held += s;
        mark(e.atMs);
        break;
      }
      case 'withdraw': {
        const a = uint(d['amount']);
        const s = uint(d['shares']);
        if (a === null || s === null || a > assets || s > shares) return null;
        assets -= a;
        shares -= s;
        if (account !== null && d['account'] === account) held -= s;
        mark(e.atMs);
        break;
      }
      case 'line_opened': {
        const limit = uint(d['limit']);
        const fee = typeof d['fee_bps'] === 'number' && Number.isInteger(d['fee_bps']) ? BigInt(d['fee_bps']) : null;
        if (card === null || limit === null || fee === null) return null;
        lines.set(card, { kind: 'open', limit, feeBps: fee, returned: 0n });
        break;
      }
      case 'line_funding_failed':
        if (card !== null) lines.delete(card);
        break;
      case 'swept': {
        const a = uint(d['amount']);
        const line = card === null ? undefined : lines.get(card);
        if (a === null || line === undefined || card === null) return null;
        if (line.kind === 'open') lines.set(card, { ...line, returned: line.returned + a });
        else {
          assets += a;
          lines.set(card, { kind: 'defaulted', loss: line.loss - a });
          mark(e.atMs);
        }
        break;
      }
      case 'repaid': {
        const fee = uint(d['fee']);
        if (fee === null || card === null) return null;
        assets += fee;
        lines.delete(card);
        mark(e.atMs);
        break;
      }
      case 'defaulted': {
        const seized = uint(d['seized']);
        const loss = uint(d['loss']);
        const line = card === null ? undefined : lines.get(card);
        if (seized === null || loss === null || card === null || line === undefined || line.kind !== 'open') return null;
        const outstanding = line.limit - line.returned;
        const principal = seized < outstanding ? seized : outstanding;
        const fee = ceilDiv(outstanding * line.feeBps, 10_000n);
        const rest = seized - principal;
        const feeCovered = rest < fee ? rest : fee;
        if (outstanding - principal !== loss) return null;
        assets = assets + principal + feeCovered - outstanding;
        lines.set(card, { kind: 'defaulted', loss });
        mark(e.atMs);
        break;
      }
      default:
        break;
    }
  }
  return points;
}

/** The fold, only when it ends exactly at the pool's live assets and shares; otherwise null and the page shows the live value alone. */
export function checkedHistory(events: readonly PoolEvent[], live: { assets: bigint; shares: bigint }, account: string | null = null): PricePoint[] | null {
  const points = foldPrices(events, account);
  const last = points?.at(-1);
  if (points === null || last === undefined || last.assets !== live.assets || last.shares !== live.shares) return null;
  return points;
}

/** The lender's own value at each price step from their first deposit on: the shares they held then times the price. */
export function valueLine(points: readonly PricePoint[]): { atMs: number; value: bigint }[] {
  const first = points.findIndex((p) => p.held > 0n);
  return first < 0 ? [] : points.slice(first).map((p) => ({ atMs: p.atMs, value: (p.held * p.price) / ONE }));
}

/** The account's first deposit time and transaction, or null. */
export function joinOf(events: readonly PoolEvent[], account: string): { atMs: number; tx: string } | null {
  const e = events.find((x) => x.event === 'deposit' && x.data['account'] === account);
  return e === undefined ? null : { atMs: e.atMs, tx: e.tx };
}

export type Schedule = { loopCard: string; loopSince: string | null; pauses: { from: string; to: string; why: string }[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(v);

export function parseSchedule(raw: unknown): Schedule | null {
  if (!isObj(raw) || typeof raw['loopCard'] !== 'string' || !(raw['loopSince'] === null || isIso(raw['loopSince'])) || !Array.isArray(raw['pauses'])) return null;
  const pauses = raw['pauses'].filter((p): p is { from: string; to: string; why: string } => isObj(p) && isIso(p['from']) && isIso(p['to']) && typeof p['why'] === 'string');
  return { loopCard: raw['loopCard'], loopSince: raw['loopSince'], pauses };
}

export const activePause = (s: Schedule, nowMs: number): Schedule['pauses'][number] | null => s.pauses.find((p) => Date.parse(p.from) <= nowMs && nowMs < Date.parse(p.to)) ?? null;

/** The loop's cycles: the repays of the loop card from loopSince on. Before loopSince no repay is a loop cycle. */
export function loopRepays(events: readonly PoolEvent[], s: Schedule): PoolEvent[] {
  if (s.loopSince === null) return [];
  const since = Date.parse(s.loopSince);
  return events.filter((e) => e.event === 'repaid' && e.data['card'] === s.loopCard && e.atMs >= since);
}

const MST = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', hour: '2-digit', minute: '2-digit', hour12: false });
const MST_SECONDS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** A time as the page says it: HH:MM MST (Arizona keeps MST all year, the zone the team writes in). */
export const mst = (ms: number): string => `${MST.format(ms)} MST`;
export const mstSeconds = (ms: number): string => `${MST_SECONDS.format(ms)} MST`;

export type LoopLine = { kind: 'not-started' } | { kind: 'paused'; until: number; why: string } | { kind: 'stale'; last: number } | { kind: 'running'; last: number };

/** What the page says about the hourly loop, from the chain and schedule.json only. */
export function loopStatus(events: readonly PoolEvent[], s: Schedule, nowMs: number): LoopLine {
  const pause = activePause(s, nowMs);
  if (pause !== null) return { kind: 'paused', until: Date.parse(pause.to), why: pause.why };
  const last = loopRepays(events, s).at(-1);
  if (last === undefined) return { kind: 'not-started' };
  return nowMs - last.atMs > 75 * 60_000 ? { kind: 'stale', last: last.atMs } : { kind: 'running', last: last.atMs };
}

export function loopSentence(l: LoopLine): string {
  if (l.kind === 'not-started') return 'The hourly loop has not started yet, so nothing has been borrowed from the pool by the loop so far.';
  if (l.kind === 'paused') return `The loop is paused until ${mst(l.until)}: ${l.why}.`;
  if (l.kind === 'stale') return `The hourly loop has not run since ${mst(l.last)}. It runs on the team's computer, which may be off.`;
  return `Last cycle ${mst(l.last)}. The loop runs every hour on the team's computer.`;
}

export type SinceJoined = { borrowed: number; repaid: number; feeBps: bigint | null };

/** The loop's borrowing from the lender's join time on: lines the loop card opened and repays of it. */
export function sinceJoined(events: readonly PoolEvent[], s: Schedule, joinMs: number): SinceJoined {
  const loop = loopRepays(events, s).filter((e) => e.atMs >= joinMs);
  const since = s.loopSince === null ? Infinity : Date.parse(s.loopSince);
  const opened = events.filter((e) => e.event === 'line_opened' && e.data['card'] === s.loopCard && e.atMs >= joinMs && e.atMs >= since);
  const fee = opened.at(-1)?.data['fee_bps'];
  return { borrowed: opened.length, repaid: loop.length, feeBps: typeof fee === 'number' ? BigInt(fee) : null };
}

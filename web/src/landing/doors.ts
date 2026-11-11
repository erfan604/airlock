// The home page's three doors, each a real thing to do in under a minute, each with one number read from where it lives: Lend (lender accounts
// outside the team's list, from the pool's own deposit events), Rob it (attempts on the practice card and how many paid anyone but its booked
// shop, from the chain) and Break the proof (the broken copies of the gate and how many of them fail their Kani harness, from the recorded
// transcripts the /break page shows). Until a read lands, and when it fails, the door shows the recorded value and says it is recorded.
import { CREDIT_POOL } from '../credit/net.ts';
import { depositors, isTeam, poolEvents, readAccountTxs } from '../lender/lenders.ts';
import { countsOfTry, readTryAttempts } from '../live/tryChain.ts';
import { parseTryPublic } from '../live/tryPublic.ts';
import { url } from '../static.ts';

/**
 * Read 2026-11-11 02:30 MST, after the bench replay on the practice card (AIR-360): the pool's lender accounts outside the team's list
 * (readLendDoor: 2), the practice card's attempts (153, of which 144 are the replay; 0 paid outside the book), and public/mutants
 * (5 copies, 5 Kani transcripts FAILED).
 */
export const RECORDED = { atText: 'Nov 11, 2026', lenders: 2, robAttempts: 153, robPaidOutside: 0, copies: 5, kaniFails: 5 } as const;

export type Source = 'live' | 'recorded' | 'failed';
export type LendDoor = { lenders: number; source: Source };
export type RobDoor = { attempts: number; paidOutside: number; source: Source };
export type BreakDoor = { copies: number; kaniFails: number; source: Source };

export const recordedLend = (failed = false): LendDoor => ({ lenders: RECORDED.lenders, source: failed ? 'failed' : 'recorded' });
export const recordedRob = (failed = false): RobDoor => ({ attempts: RECORDED.robAttempts, paidOutside: RECORDED.robPaidOutside, source: failed ? 'failed' : 'recorded' });
export const recordedBreak = (failed = false): BreakDoor => ({ copies: RECORDED.copies, kaniFails: RECORDED.kaniFails, source: failed ? 'failed' : 'recorded' });

/** The note under a door's number: where it was read, or that it is the recorded value. */
export function sourceNote(s: Source, live: string): string {
  if (s === 'live') return live;
  return `Recorded ${RECORDED.atText}${s === 'failed' ? '; it could not be read just now' : ''}.`;
}

export async function readLendDoor(fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<LendDoor> {
  const read = await readAccountTxs(fetchFn, CREDIT_POOL);
  return { lenders: depositors(poolEvents(read.txs, CREDIT_POOL)).filter((a) => !isTeam(a)).length, source: 'live' };
}

export async function readRobDoor(fetchFn: typeof fetch = globalThis.fetch.bind(globalThis), nowMs = Date.now()): Promise<RobDoor> {
  const res = await fetchFn(url('try-public.json'));
  if (!res.ok) throw new Error(`try-public.json ${String(res.status)}`);
  const pub = parseTryPublic((await res.json()) as unknown, nowMs);
  if (!('ok' in pub)) throw new Error(pub.refuse);
  const r = await readTryAttempts({ policy: pub.ok.policy, agent: pub.ok.agent, book: pub.ok.book, nowMs, ttlMs: pub.ok.pendingTtlMs, fetch: fetchFn, maxPages: 10 });
  const c = countsOfTry(r.attempts);
  return { attempts: c.attempts, paidOutside: c.paidOutside, source: 'live' };
}

/** The copies of /break's manifest, and how many of their recorded Kani transcripts end VERIFICATION:- FAILED. */
export async function readBreakDoor(fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<BreakDoor> {
  const res = await fetchFn(url('mutants/manifest.json'));
  if (!res.ok) throw new Error(`manifest ${String(res.status)}`);
  const m = (await res.json()) as { copies?: { kani?: unknown }[] };
  const copies = Array.isArray(m.copies) ? m.copies : [];
  let fails = 0;
  for (const c of copies) {
    if (typeof c.kani !== 'string' || !/^[a-z0-9-]+\.kani\.txt$/.test(c.kani)) continue;
    const t = await fetchFn(url(`mutants/${c.kani}`));
    if (t.ok && (await t.text()).includes('VERIFICATION:- FAILED')) fails += 1;
  }
  return { copies: copies.length, kaniFails: fails, source: 'live' };
}

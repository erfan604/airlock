// AIR-329: the data source of the /credit page as one state machine. `fixture` (no pool named: the made-up network, always badged), `loading`,
// `live` (the pool view was read; `stale` when the last refresh failed) and `unreadable` (the first read failed: no numbers at all, never zeros).
// Polling backs off after a failed read and every callback after an await checks a session token and the mounted flag.
import { useEffect, useRef, useState } from 'react';
import { NEAR_RPC } from '../../csp.ts';
import { STATIC } from '../static.ts';
import { readEvents, readPool } from './chain.ts';
import { CREDIT_POOL } from './net.ts';
import { fixtureEvent, fixtureHistory, fixturePool } from './fixture.ts';
import type { CreditEvent, PoolView } from './model.ts';

/** The pool account the page reads (AIRLOCK Credit on NEAR testnet, AIR-330). `?pool=<name>.testnet` reads another pool, `?pool=fixture` the badged fixture. */
export const DEFAULT_POOL: string | null = CREDIT_POOL;

export type CreditState =
  | { kind: 'loading' }
  | { kind: 'fixture'; pool: PoolView; events: CreditEvent[] }
  | { kind: 'live'; poolId: string; pool: PoolView; events: CreditEvent[]; stale: boolean; feed: 'ok' | 'unavailable' }
  | { kind: 'unreadable'; poolId: string };

const POOL_NAME = /^[a-z0-9][a-z0-9._-]{1,60}\.testnet$/;

export function poolFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get('pool');
  if (v === 'fixture') return null;
  return v !== null && POOL_NAME.test(v) ? v : DEFAULT_POOL;
}

export const POLL_MS = 8_000;
export const MAX_POLL_MS = 60_000;

/** The wait before the next read: the poll interval, doubled for every failure in a row, capped. */
export function nextDelay(failures: number): number {
  return Math.min(MAX_POLL_MS, POLL_MS * 2 ** Math.min(failures, 4));
}

const KEEP = 200;

/** Adds the events whose id is new, oldest first, and keeps the newest `KEEP`. */
export function mergeEvents(prev: readonly CreditEvent[], next: readonly CreditEvent[]): CreditEvent[] {
  const seen = new Set(prev.map((e) => e.id));
  const added = next.filter((e) => !seen.has(e.id));
  if (added.length === 0) return prev as CreditEvent[];
  return [...prev, ...added].sort((a, b) => a.atMs - b.atMs).slice(-KEEP);
}

export const FIXTURE_SEED = 329;
export const FIXTURE_TICK_MS = 1_900;

export function useCredit(poolId: string | null): CreditState {
  // always `loading` first, so the prerendered HTML and the first client render agree (the page renders fresh over the prerender)
  const [state, setState] = useState<CreditState>({ kind: 'loading' });
  const session = useRef(0);

  useEffect(() => {
    const mine = ++session.current;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = (): boolean => live && session.current === mine;

    if (poolId === null) {
      let n = 0;
      const start = Date.now();
      const pool = fixturePool(start);
      setState({ kind: 'fixture', pool, events: fixtureHistory(FIXTURE_SEED, 14, start) });
      timer = setInterval(() => {
        if (!ok()) return;
        n += 1;
        setState((s) => (s.kind === 'fixture' ? { ...s, events: mergeEvents(s.events, [fixtureEvent(FIXTURE_SEED, n, Date.now())]) } : s));
      }, FIXTURE_TICK_MS);
      return () => {
        live = false;
        clearInterval(timer);
      };
    }

    setState({ kind: 'loading' });
    let failures = 0;
    const cycle = async (): Promise<void> => {
      let pool: PoolView | null = null;
      try {
        pool = await readPool({ pool: poolId, rpcUrls: NEAR_RPC });
      } catch {
        pool = null;
      }
      if (!ok()) return;
      if (pool === null) {
        failures += 1;
        setState((s) => (s.kind === 'live' ? { ...s, stale: true } : { kind: 'unreadable', poolId }));
      } else {
        failures = 0;
        const view = pool;
        // the live console's policy does not name the FastNEAR transaction host: events are read on the hosted site only
        let events: CreditEvent[] | null = null;
        if (STATIC) {
          try {
            events = await readEvents({ pool: poolId, cards: view.lines.map((l) => l.card) });
          } catch {
            events = null;
          }
          if (!ok()) return;
        }
        setState((s) => ({
          kind: 'live',
          poolId,
          pool: view,
          events: events === null ? (s.kind === 'live' ? s.events : []) : mergeEvents(s.kind === 'live' ? s.events : [], events),
          stale: false,
          feed: STATIC && events !== null ? 'ok' : 'unavailable',
        }));
      }
      timer = setTimeout(() => void cycle(), nextDelay(failures));
    };
    void cycle();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [poolId]);

  return state;
}

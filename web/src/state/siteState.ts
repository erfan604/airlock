// The site state file (`/site-state.json`, format `airlock-site-state-v1`): every number and list the site shows that comes from the public
// transaction history, computed by scripts/site-state.ts (key-free, read only) at deploy time and every hour, and served from the site's own
// origin. A page renders these numbers at once (the static prerender bakes them into the HTML when the file exists at build time) and then adds
// what the chain logged after the file's cut time (`cut_ms`), read through the throttled history door (chain/historyFetch.ts). When the history
// API stays throttled the page keeps the file's numbers and says "as of <local time>". When the file is absent (local dev, fixtures, unit tests)
// every page reads the chain as it did before the file existed.
import type { ArenaAttempt } from '../credit/arena/model.ts';
import type { CreditEvent } from '../credit/model.ts';
import type { Attempt, Board } from '../challenge/model.ts';
import type { TryAttempt } from '../live/tryChain.ts';
import { preload } from '../preload.ts';
import { url } from '../static.ts';

export const SITE_STATE_FORMAT = 'airlock-site-state-v1';
/** The command that recomputes the file, as the pages print it. */
export const SITE_STATE_COMMAND = 'pnpm site-state';

export type SiteState = {
  format: typeof SITE_STATE_FORMAT;
  /** when the script finished reading */
  as_of_ms: number;
  /** the final block the script read the views at */
  block_height: number;
  /** history after this time is not in the file: a page reads it live. Transactions this young may still be running their receipts. */
  cut_ms: number;
  command: string;
  pool: { id: string; assets: string; shares: string; losses: string; idle: string; lent: string; fees_earned: string; lines: number };
  /** lender accounts outside the team's list (web/src/lender/team.json), from the pool's own deposit events */
  lenders: { outside: string[]; outside_now: number; truncated: boolean };
  /** the hourly loop: repays of the loop card from schedule.json's loopSince on */
  loop: { cycles: number; last_ms: number | null; last_tx: string | null; fees_earned_by_loop: string };
  rob: {
    policy: string;
    attempts: number;
    blocked: number;
    /** holds that were still open at the cut, by their time: each expires `ttl_ms` after it */
    held_open_ms: number[];
    expired: number;
    paid_shop: number;
    paid_outside: number;
    failed: number;
    last_ms: number | null;
    truncated: boolean;
    ttl_ms: number;
    /** the attempts that are not the team's bench replay (live/try-replay.json) */
    from_browsers: { attempts: number; paid_outside: number };
    /** newest first, at most 25 */
    rows: TryAttempt[];
  };
  /** the pool's and its cards' newest events (credit/chain.ts readEvents), oldest first, at most 40 */
  credit: { events: CreditEvent[] };
  /** every arena attempt on the card (credit/arena/read.ts), oldest first */
  arena: { attempts: ArenaAttempt[]; truncated: boolean };
  /** the /challenge board: the full board and the newest 20 attempts, oldest first */
  challenge: { policy: string; board: Board; attempts: Attempt[]; truncated: boolean } | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isUint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v);
const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;

/** The file, or null when it is not one this page can trust in every field it reads. */
export function parseSiteState(raw: unknown): SiteState | null {
  if (!isObj(raw) || raw['format'] !== SITE_STATE_FORMAT || !isNum(raw['as_of_ms']) || !isNum(raw['cut_ms']) || !isCount(raw['block_height'])) return null;
  const pool = raw['pool'];
  const lenders = raw['lenders'];
  const loop = raw['loop'];
  const rob = raw['rob'];
  const credit = raw['credit'];
  const arena = raw['arena'];
  if (!isObj(pool) || !isUint(pool['assets']) || !isUint(pool['shares']) || !isUint(pool['losses']) || !isUint(pool['fees_earned'])) return null;
  if (!isObj(lenders) || !Array.isArray(lenders['outside']) || !lenders['outside'].every((a) => typeof a === 'string') || !isCount(lenders['outside_now'])) return null;
  if (!isObj(loop) || !isCount(loop['cycles']) || !(loop['last_ms'] === null || isNum(loop['last_ms']))) return null;
  if (!isObj(rob) || !isCount(rob['attempts']) || !isCount(rob['paid_outside']) || !isCount(rob['paid_shop']) || !isCount(rob['blocked']) || !isCount(rob['expired'])) return null;
  if (!Array.isArray(rob['held_open_ms']) || !rob['held_open_ms'].every(isNum) || !Array.isArray(rob['rows']) || !isObj(rob['from_browsers'])) return null;
  if (!isObj(credit) || !Array.isArray(credit['events']) || !isObj(arena) || !Array.isArray(arena['attempts'])) return null;
  const ch = raw['challenge'];
  if (!(ch === null || (isObj(ch) && isObj(ch['board']) && Array.isArray(ch['attempts'])))) return null;
  return raw as unknown as SiteState;
}

let loaded: Promise<SiteState | null> | null = null;

/** The state baked into a prerendered page, when there is one: the first render uses it, so it matches the HTML. */
export function bakedState(): SiteState | null {
  const b = preload()?.siteState;
  return b === undefined || b === null ? null : parseSiteState(b);
}

/**
 * The newest state file: fetched once per page session from the site's own origin (the file is replaced every hour, so the HTML's baked copy
 * may be older), the baked copy when the fetch fails, and null when the page was built without one. A build without the file asks for nothing
 * (a missing file would be a 404 in the console) and the page reads the chain as before. A newer baked copy wins over an older fetched one.
 */
export function loadSiteState(fetchFn: typeof fetch = (i, init) => globalThis.fetch(i, init)): Promise<SiteState | null> {
  loaded ??= (async () => {
    const baked = bakedState();
    if (baked === null) return null;
    try {
      const res = await fetchFn(url('site-state.json'), { cache: 'no-cache' });
      const got = res.ok ? parseSiteState((await res.json()) as unknown) : null;
      if (got === null) return baked;
      return baked !== null && baked.as_of_ms > got.as_of_ms ? baked : got;
    } catch {
      return baked;
    }
  })();
  return loaded;
}

/** For tests: forget the loaded file. */
export function resetSiteState(): void {
  loaded = null;
}

/** Holds open at the cut that have expired by `nowMs`, and those still open. */
export function holdsAt(s: SiteState['rob'], nowMs: number): { open: number; expired: number } {
  let open = 0;
  let expired = s.expired;
  for (const at of s.held_open_ms) {
    if (nowMs - at >= s.ttl_ms) expired += 1;
    else open += 1;
  }
  return { open, expired };
}

/** "as of 14:05 PST" in the visitor's own zone. `zone` is for tests. */
export function asOfText(ms: number, zone?: string): string {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  return `as of ${f.format(ms).replace(',', '')}`;
}

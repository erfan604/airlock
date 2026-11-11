// The site state file (`/site-state.json`, format `airlock-site-state-v1`): every number and list the site shows that comes from the public
// transaction history, computed by scripts/site-state.ts (key-free, read only) at deploy time and every hour, and served from the site's own
// origin. A page renders these numbers at once (the static prerender bakes them into the HTML when the file exists at build time) and then adds
// what the chain logged after the file's cut time (`cut_ms`), read through the throttled history door (chain/historyFetch.ts). When the history
// API stays throttled the page keeps the file's numbers and says "as of <local time>". When the file is absent (local dev, fixtures, unit tests)
// every page reads the chain as it did before the file existed.
import type { ArenaAttempt } from '../credit/arena/model.ts';
import type { CreditEvent } from '../credit/model.ts';
import type { Attempt, Board, PaymentRow } from '../challenge/model.ts';
import type { TryAttempt } from '../live/tryChain.ts';
import { EVENT_KINDS } from '../credit/model.ts';
import { foreignPayee, foreignShort, isUnshown, keep, keepOrNull, keepStoredAccount, keepStoredPayee } from '../components/chainText.ts';
import team from '../lender/team.json' with { type: 'json' };
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
    /** the card's limits as its contract stated them (get_asset("near"), get_policy); absent in files written before 2026-11-11 */
    limits?: { hardCap: string; dailyCap: string; maxPending: number | null; paused: boolean } | null;
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
  return clean(raw as unknown as SiteState);
}

// The display rule (components/chainText.ts) over the whole file: every chain string is kept only in its grammar (else a placeholder with its
// length), a row whose amount, time or verdict is out of shape is dropped, and an account the team does not run is cut in the middle when long.
// The script writes the file through this parser and the prerender bakes the parsed state, so the file, the baked HTML and the pages agree.

const TRY_VERDICTS = new Set(['blocked', 'held', 'expired', 'paid_shop', 'paid_outside']);
const TRY_KINDS = new Set(['blocked', 'held', 'paid_shop', 'paid_outside']);
const ARENA_VERDICTS = new Set(['none', 'blocked', 'held', 'paid_at', 'paid_under', 'paid_over', 'paid_unbooked']);
const OUTCOMES = new Set(['ALLOW', 'ESCALATE', 'BLOCK']);
const VERDICTS = new Set(['Allow', 'Escalate', 'Block', 'NoAction']);
const AMOUNT = /^(0|[1-9][0-9]{0,38})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isAmount = (v: unknown): v is string => typeof v === 'string' && AMOUNT.test(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Accounts the team runs: the list of lender/team.json, plus the parents of the practice and challenge policies the file names. */
function teamOf(s: SiteState): (account: string) => boolean {
  const parentOf = (id: string): string | null => (id.includes('.') ? id.slice(id.indexOf('.') + 1) : null);
  const parents = [...team.parents, ...[s.rob.policy, s.challenge?.policy ?? ''].map(parentOf).filter((p): p is string => p !== null && p.includes('.'))];
  return (a) => team.accounts.includes(a) || parents.some((p) => a === p || a.endsWith(`.${p}`));
}

/** A stored account: the team's whole, anyone else's cut when long. */
const shownId = (raw: unknown, ours: (a: string) => boolean): string => {
  const a = keepStoredAccount(raw);
  return ours(a) ? a : foreignShort(a);
};

/** A stored payee key: the team's whole, anyone else's `near:` key cut when long. */
const shownKey = (raw: unknown, ours: (a: string) => boolean): string => {
  const k = keepStoredPayee(raw);
  return k.startsWith('near:') && ours(k.slice(5)) ? k : foreignPayee(k);
};

function cleanTry(r: unknown, ours: (a: string) => boolean): TryAttempt | null {
  if (!isObj(r) || !isAmount(r['amount']) || !isNum(r['atMs']) || !isStr(r['kind']) || !TRY_KINDS.has(r['kind']) || !isStr(r['verdict']) || !TRY_VERDICTS.has(r['verdict'])) return null;
  return { tx: keep('tx', r['tx']), atMs: r['atMs'], requestId: keep('request', r['requestId']), payee: shownKey(r['payee'], ours), amount: r['amount'], reason: keepOrNull('reason', r['reason']), kind: r['kind'] as TryAttempt['kind'], verdict: r['verdict'] as TryAttempt['verdict'] };
}

function cleanEvent(e: unknown, ours: (a: string) => boolean): CreditEvent | null {
  if (!isObj(e) || !isStr(e['kind']) || !(EVENT_KINDS as readonly string[]).includes(e['kind']) || !isNum(e['atMs']) || !isAmount(e['amount']) || !isStr(e['id'])) return null;
  const tx = keepOrNull('tx', e['tx']);
  const id = /^(?:[1-9A-HJ-NP-Za-km-z]{43,44}|nx):[0-9]{1,4}$/.test(e['id']) ? e['id'] : `${tx !== null && !isUnshown(tx) ? tx : 'nx'}:0`;
  const chain = e['chain'] === 'near' || e['chain'] === 'base' || e['chain'] === 'solana' ? e['chain'] : null;
  const requestId = keepOrNull('request', e['requestId']);
  return { id, kind: e['kind'] as CreditEvent['kind'], atMs: e['atMs'], who: shownId(e['who'], ours), amount: e['amount'], chain, requestId: requestId !== null && isUnshown(requestId) ? null : requestId, tx: tx !== null && isUnshown(tx) ? null : tx, fixture: false };
}

function cleanArena(a: unknown): ArenaAttempt | null {
  if (!isObj(a) || !isNum(a['atMs']) || !isStr(a['verdict']) || !ARENA_VERDICTS.has(a['verdict'])) return null;
  return { tx: keep('tx', a['tx']), atMs: a['atMs'], verdict: a['verdict'] as ArenaAttempt['verdict'], reason: keepOrNull('reason', a['reason']), amount: isAmount(a['amount']) ? a['amount'] : null, flood: a['flood'] === true };
}

function cleanAttempt(a: unknown, ours: (a: string) => boolean): Attempt | null {
  if (!isObj(a) || !isCount(a['seq']) || !isStr(a['at']) || !ISO.test(a['at']) || !isStr(a['verdict']) || !VERDICTS.has(a['verdict']) || !Array.isArray(a['payments'])) return null;
  if (!isAmount(a['stolenYocto']) || !isAmount(a['paidToBookYocto'])) return null;
  const payments: PaymentRow[] = [];
  for (const p of a['payments'] as unknown[]) {
    if (!isObj(p) || !isAmount(p['amount']) || !isStr(p['outcome']) || !OUTCOMES.has(p['outcome'])) return null;
    const toBook = p['toBook'] === true;
    payments.push({ payee: toBook ? keepStoredPayee(p['payee']) : shownKey(p['payee'], ours), asset: keep('asset', p['asset']), amount: p['amount'], outcome: p['outcome'] as PaymentRow['outcome'], reason: keepOrNull('reason', p['reason']), toBook });
  }
  const id = keep('request', a['id']);
  // the hosted board reads published-key attempts from the chain: no pasted text, no label, no preview
  return { seq: a['seq'], id, at: a['at'], door: 'key', mode: 'live', source: keep('request', a['source']), label: null, inputChars: 0, preview: null, verdict: a['verdict'] as Attempt['verdict'], reason: keepOrNull('reason', a['reason']), payments, tx: keepOrNull('tx', a['tx']), stolenYocto: a['stolenYocto'], paidToBookYocto: a['paidToBookYocto'] };
}

function limitsOf(l: unknown): SiteState['rob']['limits'] {
  if (!isObj(l) || !isAmount(l['hardCap']) || !isAmount(l['dailyCap']) || typeof l['paused'] !== 'boolean') return null;
  return { hardCap: l['hardCap'], dailyCap: l['dailyCap'], maxPending: isCount(l['maxPending']) ? l['maxPending'] : null, paused: l['paused'] };
}

function clean(s: SiteState): SiteState {
  const ours = teamOf(s);
  const keepList = <T,>(xs: readonly unknown[], f: (x: unknown) => T | null): T[] => xs.map(f).filter((x): x is T => x !== null);
  const lastTx = keepOrNull('tx', s.loop.last_tx);
  return {
    ...s,
    pool: { ...s.pool, id: keepStoredAccount(s.pool.id) },
    lenders: { ...s.lenders, outside: s.lenders.outside.map((a) => shownId(a, ours)) },
    loop: { ...s.loop, last_tx: lastTx !== null && isUnshown(lastTx) ? null : lastTx },
    rob: { ...s.rob, policy: keepStoredAccount(s.rob.policy), rows: keepList(s.rob.rows, (r) => cleanTry(r, ours)), limits: limitsOf(s.rob.limits) },
    credit: { events: keepList(s.credit.events, (e) => cleanEvent(e, ours)) },
    arena: { ...s.arena, attempts: keepList(s.arena.attempts, cleanArena) },
    challenge: s.challenge === null ? null : { ...s.challenge, policy: keepStoredAccount(s.challenge.policy), attempts: keepList(s.challenge.attempts, (a) => cleanAttempt(a, ours)) },
  };
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

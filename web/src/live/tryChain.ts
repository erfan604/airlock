// AIR-356: the attempts on the "try it live" card, read from the chain. FastNEAR's keyless transaction API lists the try policy's
// transactions, newest first; each is classified with the /challenge board's rules (classifyTx: a submit_batch of the try agent on the try
// policy with a final receipt), whichever published key signed it. The current policy contract has no book view, so the booked payees
// come from the public file. One attempt is one request of a batch: blocked (the contract refused it), held (it waits for the owner and
// nobody approves here), expired (a hold past the time holds live), paid to the booked shop, or paid outside the book (shown as it is).
// A call that failed (a used slot, a malformed request) is counted apart. With a cache a final transaction is read once.
import { classifyTx, listedOf } from '../challenge/chainBoard.ts';
import type { ListedTx } from '../challenge/chainBoard.ts';
import { historyFetch } from '../chain/historyFetch.ts';

export const FASTNEAR_TX = 'https://tx.test.fastnear.com';
/** Listing pages (100 transactions each) one read walks at most: 5,000 transactions; a longer history is read as truncated. */
export const TRY_MAX_PAGES = 50;

export type TryKind = 'blocked' | 'held' | 'paid_shop' | 'paid_outside';
export type TryVerdict = TryKind | 'expired';
/** `kind` is what the contract answered; `verdict` is the same, or `expired` for a hold past its time. */
export type TryAttempt = { tx: string; atMs: number; requestId: string; payee: string; amount: string; reason: string | null; kind: TryKind; verdict: TryVerdict };
export type TryCfg = { policy: string; agent: string; book: readonly string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One transaction of the try policy: its attempts (one per request), `failed` (a submit_batch of the agent that reverted), `pending` (its
 * receipt is not final yet), or null (not a submit_batch of the try agent on the try policy).
 */
export function classifyTryTx(raw: unknown, cfg: TryCfg, meta: ListedTx): TryAttempt[] | 'failed' | 'pending' | null {
  const tx = isObj(raw) && isObj(raw['transaction']) ? raw['transaction'] : null;
  if (tx === null) return null;
  // the transaction's own key is given to the board's rule, which still checks the signer account and the receiver
  const s = classifyTx(raw, cfg.policy, typeof tx['public_key'] === 'string' ? tx['public_key'] : '', new Set(cfg.book), cfg.agent);
  if (s.state === 'skip') return null;
  if (s.state === 'pending') return 'pending';
  if (s.obs.length === 0) return 'failed';
  return s.obs.map((o) => {
    const kind: TryKind = o.outcome === 'BLOCK' ? 'blocked' : o.outcome === 'ESCALATE' ? 'held' : o.toBook ? 'paid_shop' : 'paid_outside';
    return { tx: meta.hash, atMs: meta.atMs, requestId: o.requestId, payee: o.payee, amount: o.amount, reason: o.reason, kind, verdict: kind };
  });
}

/** The attempts with a hold older than `ttlMs` shown as expired (nobody approves on the try card, so a hold only ever expires). */
export function withExpiry(list: readonly TryAttempt[], nowMs: number, ttlMs: number): TryAttempt[] {
  return list.map((a) => ({ ...a, verdict: a.kind === 'held' && nowMs - a.atMs >= ttlMs ? 'expired' : a.kind }));
}

/** A count with thousands grouped: 1980 as 1,980 (the board and the home page's Rob door). */
export const countText = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export type TryCounts = { attempts: number; blocked: number; held: number; expired: number; paidShop: number; paidOutside: number; lastMs: number | null };

export function countsOfTry(list: readonly TryAttempt[]): TryCounts {
  const c: TryCounts = { attempts: 0, blocked: 0, held: 0, expired: 0, paidShop: 0, paidOutside: 0, lastMs: null };
  for (const a of list) {
    c.attempts += 1;
    if (a.verdict === 'blocked') c.blocked += 1;
    else if (a.verdict === 'held') c.held += 1;
    else if (a.verdict === 'expired') c.expired += 1;
    else if (a.verdict === 'paid_shop') c.paidShop += 1;
    else c.paidOutside += 1;
    if (c.lastMs === null || a.atMs > c.lastMs) c.lastMs = a.atMs;
  }
  return c;
}

/** What earlier reads of one page session found: a transaction whose answer cannot change is kept as its attempts, `failed` or null. */
export type TryCache = { listed: Map<string, ListedTx>; final: Map<string, TryAttempt[] | 'failed' | null>; walked: boolean; truncated: boolean };
export const newTryCache = (): TryCache => ({ listed: new Map(), final: new Map(), walked: false, truncated: false });

export type TryRead = { attempts: TryAttempt[]; failed: number; truncated: boolean };

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${String(res.status)}`);
  return (await res.json()) as unknown;
}

/**
 * The attempts on the try card, oldest first. `truncated`: the listing is longer than the page cap, so older attempts may be missing.
 * Throws when a read fails, so the page can say the counts are unreadable instead of showing zeros.
 */
export async function readTryAttempts(p: TryCfg & { nowMs: number; ttlMs: number; fetch?: typeof fetch; maxPages?: number; cache?: TryCache; sinceMs?: number }): Promise<TryRead> {
  const fetchFn = p.fetch ?? historyFetch;
  const since = p.sinceMs;
  const cache = p.cache ?? newTryCache();
  let token: string | null = null;
  let ended = false;
  for (let page = 0; page < (p.maxPages ?? TRY_MAX_PAGES); page += 1) {
    const body: Record<string, unknown> = { account_id: p.policy, is_function_call: true, limit: 100 };
    if (token !== null) body['resume_token'] = token;
    const got = listedOf(await postJson(fetchFn, `${FASTNEAR_TX}/v0/account`, body));
    // `sinceMs` (the site state file's cut): only the newer part is read, the file holds the rest
    const fresh = got.txs.filter((t) => !cache.listed.has(t.hash) && (since === undefined || t.atMs > since));
    for (const t of fresh) cache.listed.set(t.hash, t);
    token = got.resume;
    // newest first: once the history was walked, a page with nothing new means every older page is already known
    if (token === null || got.txs.length === 0 || (cache.walked && fresh.length === 0) || (since !== undefined && got.txs.some((t) => t.atMs <= since))) {
      ended = true;
      break;
    }
  }
  if (!ended) cache.truncated = true;
  cache.walked = true;
  const hashes = [...cache.listed.keys()].filter((hash) => !cache.final.has(hash));
  for (let i = 0; i < hashes.length; i += 20) {
    const res = await postJson(fetchFn, `${FASTNEAR_TX}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 20) });
    if (!isObj(res) || !Array.isArray(res['transactions'])) throw new Error('the transaction read answered something unexpected');
    for (const raw of res['transactions'] as unknown[]) {
      const hash = isObj(raw) && isObj(raw['transaction']) ? raw['transaction']['hash'] : undefined;
      const meta = typeof hash === 'string' ? cache.listed.get(hash) : undefined;
      if (meta === undefined) continue;
      const got = classifyTryTx(raw, p, meta);
      if (got !== 'pending') cache.final.set(meta.hash, got);
    }
  }
  const attempts: TryAttempt[] = [];
  let failed = 0;
  for (const v of cache.final.values()) {
    if (v === 'failed') failed += 1;
    else if (v !== null) attempts.push(...v);
  }
  attempts.sort((a, b) => a.atMs - b.atMs || a.requestId.localeCompare(b.requestId));
  return { attempts: withExpiry(attempts, p.nowMs, p.ttlMs), failed, truncated: cache.truncated };
}

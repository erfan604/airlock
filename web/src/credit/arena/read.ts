// AIR-336: the strip's chain read. FastNEAR's keyless transaction API lists the card's transactions, newest first; the full transactions are
// read in batches of 20 and each is classified with the /challenge board's rules (classifyTx: a submit_batch signed by the agent account, on
// the card, with a final receipt). The key is not fixed: a round signs with the arena's own key or with the agent's key, so an attempt is told
// by its owner task id, which starts with the arena prefix. An expire call is housekeeping and is not an attempt. The listing is paged until it
// ends (up to ARENA_MAX_PAGES pages; past that the read says it is truncated). With a cache, a final transaction is read once and a later
// read stops at the first listing page it already knows. A failed read throws, so the strip says "unreadable".
import { classifyTx, listedOf } from '../../challenge/chainBoard.ts';
import type { ListedTx } from '../../challenge/chainBoard.ts';
import { ARENA_AGENT, ARENA_CARD, ARENA_INVOICE_YOCTO, ARENA_MERCHANT_KEY, ARENA_TASK_PREFIX } from './config.ts';
import { attemptOf } from './model.ts';
import type { ArenaAttempt } from './model.ts';

export const FASTNEAR_TX = 'https://tx.test.fastnear.com';
/** Listing pages (100 transactions each) one read walks at most: about 75 days of rounds at one every 65 minutes. */
export const ARENA_MAX_PAGES = 50;

export type ArenaRead = { attempts: ArenaAttempt[]; truncated: boolean };
/**
 * What earlier reads of one page session found. `final`: a transaction whose answer cannot change, as an attempt or as null (not an arena
 * attempt). `walked`: one read reached the end of the listing or the page cap, so a page with nothing new ends the next one.
 */
export type ArenaCache = { listed: Map<string, ListedTx>; final: Map<string, ArenaAttempt | null>; walked: boolean; truncated: boolean };
export const newArenaCache = (): ArenaCache => ({ listed: new Map(), final: new Map(), walked: false, truncated: false });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${String(res.status)}`);
  return (await res.json()) as unknown;
}

/** The owner task id of a transaction's first submit_batch call, read from its arguments. */
function taskIdOf(tx: Record<string, unknown>): string | null {
  for (const action of Array.isArray(tx['actions']) ? tx['actions'] : []) {
    const call = isObj(action) && isObj(action['FunctionCall']) ? action['FunctionCall'] : null;
    if (call === null || call['method_name'] !== 'submit_batch') continue;
    if (typeof call['args'] !== 'string') return null;
    try {
      const bytes = Uint8Array.from(atob(call['args']), (c) => c.charCodeAt(0));
      const args: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return isObj(args) && isObj(args['task']) && typeof args['task']['task_id'] === 'string' ? args['task']['task_id'] : null;
    } catch {
      return null;
    }
  }
  return null;
}

const MERCHANT = new Set([ARENA_MERCHANT_KEY]);

/** One transaction of the card: an arena attempt, null (not one, for good), or `pending` (an arena call whose receipt is not final yet). */
function arenaAttemptOf(raw: unknown, meta: ListedTx): ArenaAttempt | null | 'pending' {
  const tx = isObj(raw) && isObj(raw['transaction']) ? raw['transaction'] : null;
  if (tx === null) return null;
  // the transaction's own key is given to the board's rule, which still checks the signer account and the receiver
  const s = classifyTx(raw, ARENA_CARD, typeof tx['public_key'] === 'string' ? tx['public_key'] : '', MERCHANT, ARENA_AGENT);
  if (s.state === 'skip') return null;
  const task = taskIdOf(tx);
  if (task === null || !task.startsWith(ARENA_TASK_PREFIX)) return null;
  if (s.state === 'pending') return 'pending';
  return s.obs.length === 0 ? null : attemptOf(s.obs, meta.hash, meta.atMs, ARENA_MERCHANT_KEY, BigInt(ARENA_INVOICE_YOCTO));
}

/** The arena's attempts on the card, oldest first. `truncated`: the listing is longer than the page cap, so older attempts may be missing. */
export async function readArena(cfg: { fetch?: typeof fetch; maxPages?: number; cache?: ArenaCache } = {}): Promise<ArenaRead> {
  const fetchFn = cfg.fetch ?? globalThis.fetch.bind(globalThis);
  const cache = cfg.cache ?? newArenaCache();
  let token: string | null = null;
  let ended = false;
  for (let page = 0; page < (cfg.maxPages ?? ARENA_MAX_PAGES); page += 1) {
    const body: Record<string, unknown> = { account_id: ARENA_CARD, is_function_call: true, limit: 100 };
    if (token !== null) body['resume_token'] = token;
    const got = listedOf(await postJson(fetchFn, `${FASTNEAR_TX}/v0/account`, body));
    const fresh = got.txs.filter((t) => !cache.listed.has(t.hash));
    for (const t of fresh) cache.listed.set(t.hash, t);
    token = got.resume;
    // newest first: once the history was walked, a page with nothing new means every older page is already known
    if (token === null || got.txs.length === 0 || (cache.walked && fresh.length === 0)) {
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
      const got = arenaAttemptOf(raw, meta);
      if (got !== 'pending') cache.final.set(meta.hash, got);
    }
  }
  const attempts = [...cache.final.values()].filter((a): a is ArenaAttempt => a !== null);
  return { attempts: attempts.sort((a, b) => a.atMs - b.atMs || a.tx.localeCompare(b.tx)), truncated: cache.truncated };
}

// AIR-359: who has lent into the pool, from the pool's own deposit records. The pool keeps no list of lenders (its `lps` is a LookupMap), so the
// page lists the pool's function-call transactions on FastNEAR's keyless API (newest first, 100 a page, at most 10 pages), fetches them 20 at a
// time, and takes the `account` of every `deposit` event the pool itself logged in a receipt that did not fail. A deposit transaction that failed
// logged no event, so it is not counted (two such lp2 deposits are on chain). Accounts the team runs (team.json) are removed. "Lending now" is
// the part of them whose `get_lp` shares are above 0. scripts/lender-count.ts runs the same count for the claims.
import { FASTNEAR_TX, listedOf } from '../challenge/chainBoard.ts';
import { rpcView } from '../chain/rpc.ts';
import team from './team.json' with { type: 'json' };

export type Team = { parents: readonly string[]; accounts: readonly string[] };
export const TEAM: Team = team;

/** An account the team runs: one of its listed accounts, a listed parent, or any sub-account of a parent. */
export function isTeam(account: string, t: Team = TEAM): boolean {
  return t.accounts.includes(account) || t.parents.some((p) => account === p || account.endsWith(`.${p}`));
}

export type PoolTx = { body: unknown; atMs: number; hash: string };
export type TxRead = { txs: PoolTx[]; truncated: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${String(res.status)}`);
  return (await res.json()) as unknown;
}

/** The function-call transactions of `account`, oldest first, each with its block time. `truncated` when the page limit cut the older part. */
export async function readAccountTxs(fetchFn: typeof fetch, account: string, opts: { pageLimit?: number; maxPages?: number; base?: string } = {}): Promise<TxRead> {
  const base = opts.base ?? FASTNEAR_TX;
  const listed: { hash: string; atMs: number }[] = [];
  let resume: string | null = null;
  let pages = 0;
  let truncated = false;
  do {
    const page = listedOf(await postJson(fetchFn, `${base}/v0/account`, { account_id: account, is_function_call: true, limit: opts.pageLimit ?? 100, ...(resume === null ? {} : { resume_token: resume }) }));
    listed.push(...page.txs);
    resume = page.resume;
    pages += 1;
    if (resume !== null && pages >= (opts.maxPages ?? 10)) {
      truncated = true;
      break;
    }
  } while (resume !== null);
  const at = new Map(listed.map((t) => [t.hash, t.atMs]));
  const hashes = [...at.keys()];
  const txs: PoolTx[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const res = await postJson(fetchFn, `${base}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 20) });
    if (!isObj(res) || !Array.isArray(res['transactions'])) throw new Error('the transaction read answered something unexpected');
    for (const raw of res['transactions'] as unknown[]) {
      const hash = isObj(raw) && isObj(raw['transaction']) ? raw['transaction']['hash'] : undefined;
      const atMs = typeof hash === 'string' ? at.get(hash) : undefined;
      if (typeof hash === 'string' && atMs !== undefined) txs.push({ body: raw, atMs, hash });
    }
  }
  txs.sort((a, b) => a.atMs - b.atMs || a.hash.localeCompare(b.hash));
  return { txs, truncated };
}

export type PoolEvent = { event: string; data: Record<string, unknown>; atMs: number; tx: string };

/** The `airlock-credit` events the pool logged in its own receipts, in transaction and receipt order. A failed receipt's lines are left out. */
export function poolEvents(txs: readonly PoolTx[], pool: string): PoolEvent[] {
  const out: PoolEvent[] = [];
  for (const t of txs) {
    const receipts = isObj(t.body) && Array.isArray(t.body['receipts']) ? t.body['receipts'] : [];
    for (const r of receipts) {
      const o = isObj(r) && isObj(r['execution_outcome']) ? r['execution_outcome']['outcome'] : undefined;
      if (!isObj(o) || o['executor_id'] !== pool || !Array.isArray(o['logs'])) continue;
      const status = o['status'];
      if (isObj(status) && 'Failure' in status) continue;
      for (const line of o['logs']) {
        if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) continue;
        let body: unknown;
        try {
          body = JSON.parse(line.slice('EVENT_JSON:'.length)) as unknown;
        } catch {
          continue;
        }
        if (!isObj(body) || body['standard'] !== 'airlock-credit' || typeof body['event'] !== 'string') continue;
        const data = Array.isArray(body['data']) ? body['data'][0] : undefined;
        if (isObj(data)) out.push({ event: body['event'], data, atMs: t.atMs, tx: t.hash });
      }
    }
  }
  return out;
}

/** Every account that made a deposit, in the order of its first deposit. */
export function depositors(events: readonly PoolEvent[]): string[] {
  const seen: string[] = [];
  for (const e of events) {
    const a = e.data['account'];
    if (e.event === 'deposit' && typeof a === 'string' && !seen.includes(a)) seen.push(a);
  }
  return seen;
}

export type LpView = { shares: bigint; value: bigint; lockedUntilMs: number };

export function parseLpView(raw: unknown): LpView {
  const s = isObj(raw) ? raw['shares'] : undefined;
  const v = isObj(raw) ? raw['value'] : undefined;
  const l = isObj(raw) ? raw['locked_until_ms'] : undefined;
  const uint = (x: unknown): bigint | null => (typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) ? BigInt(x) : null);
  const shares = uint(s);
  const value = uint(v);
  const locked = uint(l);
  if (shares === null || value === null || locked === null) throw new Error('get_lp is not in the expected shape');
  return { shares, value, lockedUntilMs: Number(locked) };
}

export async function readLp(rpc: { rpcUrls: readonly string[]; fetch?: typeof fetch }, pool: string, account: string): Promise<LpView> {
  return parseLpView(await rpcView({ contractId: pool, ...rpc })('get_lp', { account }));
}

export type LenderCount = { soFar: string[]; now: number; truncated: boolean };

/** The lenders outside the team: everyone with a deposit event ("so far") and the part still holding shares ("now"). */
export async function countLenders(events: readonly PoolEvent[], truncated: boolean, lp: (account: string) => Promise<LpView>, t: Team = TEAM): Promise<LenderCount> {
  const soFar = depositors(events).filter((a) => !isTeam(a, t));
  let now = 0;
  for (const a of soFar) if ((await lp(a)).shares > 0n) now += 1;
  return { soFar, now, truncated };
}

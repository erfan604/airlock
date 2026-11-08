// AIR-329: the page's reads of the credit pool. The pool view comes from `get_pool` over the same JSON-RPC client the rest of the console uses; the
// events come from FastNEAR's keyless transaction API (the host the static CSP already allows): the transactions that touched the pool account,
// and the NEP-297 log lines of the pool's own receipts. A read that fails throws, so the page says "unreadable" and never shows zeros.
import { rpcView } from '../chain/rpc.ts';
import { listedOf } from '../challenge/chainBoard.ts';
import { parseEventLog, parseLp, parsePool } from './model.ts';
import type { CreditEvent, PoolView } from './model.ts';

export const FASTNEAR_TX = 'https://tx.test.fastnear.com';

export type ReadCfg = { pool: string; rpcUrls: readonly string[]; fetch?: typeof fetch };

export async function readPool(cfg: ReadCfg): Promise<PoolView> {
  const view = rpcView({ contractId: cfg.pool, rpcUrls: cfg.rpcUrls, ...(cfg.fetch === undefined ? {} : { fetch: cfg.fetch }) });
  return parsePool(await view('get_pool', {}));
}

/** The connected LP's own shares in the pool (`get_lp`). */
export async function readLp(cfg: ReadCfg, account: string): Promise<string> {
  const view = rpcView({ contractId: cfg.pool, rpcUrls: cfg.rpcUrls, ...(cfg.fetch === undefined ? {} : { fetch: cfg.fetch }) });
  return parseLp(await view('get_lp', { account_id: account }));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${String(res.status)}`);
  return (await res.json()) as unknown;
}

/** The credit events in one raw FastNEAR transaction: the logs of the receipts the pool itself executed. */
export function eventsOfTx(raw: unknown, pool: string, atMs: number): CreditEvent[] {
  if (!isObj(raw) || !isObj(raw['transaction']) || !Array.isArray(raw['receipts'])) return [];
  const hash = raw['transaction']['hash'];
  if (typeof hash !== 'string') return [];
  const out: CreditEvent[] = [];
  for (const r of raw['receipts']) {
    if (!isObj(r) || !isObj(r['execution_outcome']) || !isObj(r['execution_outcome']['outcome'])) continue;
    const outcome = r['execution_outcome']['outcome'];
    if (outcome['executor_id'] !== pool || !Array.isArray(outcome['logs'])) continue;
    for (const line of outcome['logs']) {
      if (typeof line !== 'string') continue;
      const e = parseEventLog(line, atMs, hash, out.length);
      if (e !== null) out.push(e);
    }
  }
  return out;
}

/** The newest events of the pool, oldest first. One listing page and its transactions: the page asks again on its own schedule. */
export async function readEvents(cfg: { pool: string; fetch?: typeof fetch; limit?: number }): Promise<CreditEvent[]> {
  const fetchFn = cfg.fetch ?? globalThis.fetch.bind(globalThis);
  const page = listedOf(await postJson(fetchFn, `${FASTNEAR_TX}/v0/account`, { account_id: cfg.pool, is_function_call: true, limit: cfg.limit ?? 40 }));
  const meta = new Map(page.txs.map((t) => [t.hash, t]));
  const hashes = [...meta.keys()];
  const out: CreditEvent[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const res = await postJson(fetchFn, `${FASTNEAR_TX}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 20) });
    if (!isObj(res) || !Array.isArray(res['transactions'])) throw new Error('the transaction read answered something unexpected');
    for (const raw of res['transactions'] as unknown[]) {
      const hash = isObj(raw) && isObj(raw['transaction']) ? raw['transaction']['hash'] : undefined;
      const t = typeof hash === 'string' ? meta.get(hash) : undefined;
      if (t !== undefined) out.push(...eventsOfTx(raw, cfg.pool, t.atMs));
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

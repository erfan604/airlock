// AIR-320: the board of the hosted Steal this agent page, computed in the browser from public chain reads and nothing else. The hosted site has no
// server, so it asks FastNEAR's keyless transaction API (https://tx.test.fastnear.com) which transactions touched the challenge policy, keeps the
// `submit_batch` calls signed by the published function-call key, and takes each request's verdict from the policy contract's own receipt (the
// call arguments give the requests, the receipt's return value gives one verdict per request). The address book is a `get_book` view of the
// policy. A transaction counts when its policy receipt is final; one that is not yet is left out until it is, never guessed. Nothing is counted
// that the chain does not show: a call that failed, a call by another key or an attempt that never reached the chain is not an attempt here.
// `Stolen` is what challenge/src/attempt.ts and the README define: an allowed payment to a payee outside the owner's book.
// The classifier is the same rule as challenge/src/fastnear.ts (which runs on the service host), written without a schema library for the page.
import { EMPTY_BOARD, foldBoard } from './model.ts';
import type { Attempt, Board } from './model.ts';

export const FASTNEAR_TX = 'https://tx.test.fastnear.com';
export const FASTNEAR_RPC = 'https://test.rpc.fastnear.com';

export type Observation = { requestId: string; payee: string; asset: string; amount: string; outcome: 'ALLOW' | 'ESCALATE' | 'BLOCK'; reason: string | null; tx: string; toBook: boolean };
export type TxState = { state: 'skip' } | { state: 'pending' } | { state: 'final'; obs: Observation[] };

const OUTCOME = { allowed: 'ALLOW', escalated: 'ESCALATE', blocked: 'BLOCK' } as const;
const AMOUNT = /^(0|[1-9][0-9]{0,38})$/;
const HASH = /^[A-Za-z0-9]{20,100}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function b64json(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    const bin = atob(value);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * What one transaction is for the board. `skip`: not a submit_batch of the published key to the policy (signed by `agent` when it is given). `pending`: it is one, but the policy
 * receipt is missing or not final. `final`: a failed call gives no observations, a successful one gives one per request.
 */
export function classifyTx(raw: unknown, policy: string, publicKey: string, book: ReadonlySet<string>, agent?: string): TxState {
  if (!isObj(raw) || !isObj(raw['transaction']) || !Array.isArray(raw['receipts'])) return { state: 'skip' };
  const tx = raw['transaction'];
  const hash = str(tx['hash']);
  const signer = str(tx['signer_id']);
  if (hash === null || signer === null || !HASH.test(hash)) return { state: 'skip' };
  if (tx['public_key'] !== publicKey || tx['receiver_id'] !== policy || !Array.isArray(tx['actions'])) return { state: 'skip' };
  // the published key may also be added to another account by anyone; only the challenge agent's own calls are attempts (security review 2026-11-07)
  if (agent !== undefined && signer !== agent) return { state: 'skip' };
  let args: unknown;
  let found = false;
  for (const action of tx['actions']) {
    const call = isObj(action) ? action['FunctionCall'] : undefined;
    if (isObj(call) && call['method_name'] === 'submit_batch') {
      found = true;
      args = b64json(call['args']);
      break;
    }
  }
  if (!found) return { state: 'skip' };
  const receipt = raw['receipts'].find((r): r is Record<string, unknown> => {
    if (!isObj(r) || !isObj(r['receipt']) || !isObj(r['execution_outcome']) || !isObj(r['execution_outcome']['outcome'])) return false;
    return r['execution_outcome']['outcome']['executor_id'] === policy && r['receipt']['predecessor_id'] === signer;
  });
  if (receipt === undefined) return { state: 'pending' };
  const outcome = (receipt['execution_outcome'] as { outcome: Record<string, unknown> }).outcome;
  const status = outcome['status'];
  if (!isObj(status)) return { state: 'pending' };
  if ('Failure' in status) return { state: 'final', obs: [] };
  if (!('SuccessValue' in status)) return { state: 'pending' };
  const reqs = isObj(args) && Array.isArray(args['reqs']) ? args['reqs'] : null;
  const answers = b64json(status['SuccessValue']);
  if (reqs === null || !Array.isArray(answers) || answers.length !== reqs.length) return { state: 'final', obs: [] };
  const obs: Observation[] = [];
  for (const [i, a] of answers.entries()) {
    const req = reqs[i];
    if (!isObj(a) || !isObj(req)) continue;
    const kind = str(a['outcome']);
    const requestId = str(a['request_id']);
    const payee = str(req['payee']);
    const asset = str(req['asset']);
    const amount = str(req['amount']);
    if (kind === null || !Object.hasOwn(OUTCOME, kind) || requestId === null || payee === null || asset === null || amount === null || !AMOUNT.test(amount)) continue;
    obs.push({ requestId, payee, asset, amount, outcome: OUTCOME[kind as keyof typeof OUTCOME], reason: str(a['reason']), tx: hash, toBook: book.has(payee) });
  }
  return { state: 'final', obs };
}

/** One request of the chain as an attempt of the published-key door, the way the service's watcher records it. */
export function attemptOf(o: Observation, seq: number, atMs: number): Attempt {
  const stolen = o.outcome === 'ALLOW' && !o.toBook ? o.amount : '0';
  const paid = o.outcome === 'ALLOW' && o.toBook ? o.amount : '0';
  return {
    seq,
    id: o.requestId,
    at: new Date(atMs).toISOString(),
    door: 'key',
    mode: 'live',
    source: o.requestId,
    label: null,
    inputChars: 0,
    preview: null,
    verdict: o.outcome === 'ALLOW' ? 'Allow' : o.outcome === 'ESCALATE' ? 'Escalate' : 'Block',
    reason: o.reason,
    payments: [{ payee: o.payee, asset: o.asset, amount: o.amount, outcome: o.outcome, reason: o.reason, toBook: o.toBook }],
    tx: o.tx,
    stolenYocto: stolen,
    paidToBookYocto: paid,
  };
}

/** The board of a list of attempts (oldest first), folded with the same rule the page uses between reads. */
export const boardOf = (attempts: readonly Attempt[]): Board => attempts.reduce(foldBoard, EMPTY_BOARD);

export type ListedTx = { hash: string; height: number; atMs: number };

/** The transactions of one account listing page, with their block time (FastNEAR gives it in nanoseconds as a decimal string). */
export function listedOf(page: unknown): { txs: ListedTx[]; resume: string | null } {
  if (!isObj(page) || !Array.isArray(page['account_txs'])) throw new Error('the transaction listing was not in the expected shape');
  const txs: ListedTx[] = [];
  for (const t of page['account_txs']) {
    if (!isObj(t)) continue;
    const hash = str(t['transaction_hash']);
    const height = typeof t['tx_block_height'] === 'number' ? t['tx_block_height'] : null;
    const ns = str(t['tx_block_timestamp']);
    if (hash === null || !HASH.test(hash) || height === null || ns === null || !/^[0-9]{10,25}$/.test(ns) || t['is_success'] === false) continue;
    txs.push({ hash, height, atMs: +String(BigInt(ns) / 1_000_000n) });
  }
  return { txs, resume: str(page['resume_token']) };
}

export type ChainConfig = { policy: string; publicKey: string; agent?: string; txBase?: string; rpcUrl?: string; pageLimit?: number; maxPages?: number; batch?: number };
export type ChainRead = { attempts: Attempt[]; book: string[]; truncated: boolean };

async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${String(res.status)}`);
  return (await res.json()) as unknown;
}

/** The payee keys of the policy's address book, from the `get_book` view over JSON-RPC. */
export async function readBook(fetchFn: typeof fetch, policy: string, rpcUrl: string = FASTNEAR_RPC): Promise<string[]> {
  const keys: string[] = [];
  for (let page = 0; page < 8; page += 1) {
    const args = btoa(JSON.stringify({ from_index: page * 50, limit: 50 }));
    const res = await postJson(fetchFn, rpcUrl, { jsonrpc: '2.0', id: 'book', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: policy, method_name: 'get_book', args_base64: args } });
    const result = isObj(res) && isObj(res['result']) ? res['result']['result'] : undefined;
    if (!Array.isArray(result)) throw new Error('get_book answered something unexpected');
    let rows: unknown;
    try {
      rows = JSON.parse(new TextDecoder().decode(Uint8Array.from(result as number[])));
    } catch {
      throw new Error('get_book answered something unexpected');
    }
    if (!Array.isArray(rows)) throw new Error('get_book answered something unexpected');
    for (const row of rows) if (Array.isArray(row) && typeof row[0] === 'string') keys.push(row[0]);
    if (rows.length < 50) return keys;
  }
  return keys;
}

/**
 * Reads the chain once: the address book, the listing of transactions that touched the policy (newest first, up to `maxPages` pages), and the
 * full transactions of the listed hashes. `truncated` is true when the listing was cut at `maxPages`, so the page can say the board shows the
 * newest part only. Throws when a read fails: the page then keeps its last board and says it could not read the chain.
 */
export async function readChain(fetchFn: typeof fetch, cfg: ChainConfig): Promise<ChainRead> {
  const base = (cfg.txBase ?? FASTNEAR_TX).replace(/\/$/, '');
  const book = await readBook(fetchFn, cfg.policy, cfg.rpcUrl);
  const bookSet = new Set(book);
  const listed = new Map<string, ListedTx>();
  let token: string | null = null;
  let truncated = false;
  for (let page = 0; page < (cfg.maxPages ?? 5); page += 1) {
    const body: Record<string, unknown> = { account_id: cfg.policy, is_function_call: true, limit: cfg.pageLimit ?? 100 };
    if (token !== null) body['resume_token'] = token;
    const got = listedOf(await postJson(fetchFn, `${base}/v0/account`, body));
    for (const t of got.txs) listed.set(t.hash, t);
    token = got.resume;
    if (token === null || got.txs.length === 0) break;
    if (page + 1 === (cfg.maxPages ?? 5)) truncated = true;
  }
  const found: { listed: ListedTx; obs: Observation[] }[] = [];
  const hashes = [...listed.keys()];
  const size = cfg.batch ?? 20;
  for (let i = 0; i < hashes.length; i += size) {
    const res = await postJson(fetchFn, `${base}/v0/transactions`, { tx_hashes: hashes.slice(i, i + size) });
    const list = isObj(res) && Array.isArray(res['transactions']) ? res['transactions'] : [];
    for (const raw of list) {
      const hash = isObj(raw) && isObj(raw['transaction']) ? str(raw['transaction']['hash']) : null;
      const meta = hash === null ? undefined : listed.get(hash);
      if (meta === undefined) continue;
      const state = classifyTx(raw, cfg.policy, cfg.publicKey, bookSet, cfg.agent);
      if (state.state === 'final') found.push({ listed: meta, obs: state.obs });
    }
  }
  found.sort((a, b) => a.listed.height - b.listed.height || a.listed.hash.localeCompare(b.listed.hash));
  const attempts: Attempt[] = [];
  for (const f of found) for (const o of f.obs) attempts.push(attemptOf(o, attempts.length + 1, f.listed.atMs));
  return { attempts, book, truncated };
}

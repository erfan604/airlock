// Door (b) from the chain: the FastNEAR transactions API (https://tx.test.fastnear.com, keyless). `POST /v0/account` lists the transactions that
// touched the policy contract, newest first, with a resume token; `POST /v0/transactions` returns the full transactions with their receipts.
// A transaction counts when it is signed by the published function-call key, is a `submit_batch` call to the policy, and its policy receipt
// carries the contract's answer: the request list comes from the call arguments and one verdict per request from the receipt's return value, so
// the board shows the contract's verdict and the transaction hash, not an inference. Anything else (other keys, other methods, failed calls) is
// skipped. A transaction the indexer lists but cannot return yet is tried again on the next poll.
import { z } from 'zod';
import type { KeyObservation, KeyWatcherSource } from './watcher.ts';

export const FASTNEAR_TESTNET_TX = 'https://tx.test.fastnear.com';

const AccountPage = z.object({
  account_txs: z.array(z.object({ transaction_hash: z.string().regex(/^[A-Za-z0-9]{20,100}$/), tx_block_height: z.number().int().nonnegative(), is_success: z.boolean().optional() })),
  resume_token: z.string().nullable().optional(),
});

const Receipt = z.object({
  receipt: z.object({ predecessor_id: z.string() }).passthrough(),
  execution_outcome: z.object({ outcome: z.object({ executor_id: z.string(), status: z.record(z.string(), z.unknown()) }).passthrough() }).passthrough(),
});

const Tx = z.object({
  transaction: z.object({
    hash: z.string(),
    signer_id: z.string(),
    public_key: z.string(),
    receiver_id: z.string(),
    actions: z.array(z.record(z.string(), z.unknown())),
  }),
  receipts: z.array(Receipt),
});
const TxList = z.object({ transactions: z.array(z.unknown()) });

const Req = z.object({ payee: z.string(), asset: z.string(), amount: z.string().regex(/^(0|[1-9][0-9]{0,38})$/) });
const Outcome = z.object({ request_id: z.string(), outcome: z.enum(['allowed', 'escalated', 'blocked']), reason: z.string().nullable() });

const OUTCOME = { allowed: 'ALLOW', escalated: 'ESCALATE', blocked: 'BLOCK' } as const;

export interface FastNearOptions {
  policy: string;
  /** `ed25519:...`, the public half of the published function-call key */
  publicKey: string;
  /** the payee keys of the policy's address book now (ChainClient.getBook), to mark a payment as to the book or not */
  bookKeys(): Promise<ReadonlySet<string>>;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** transactions asked per account page (the service allows up to 100 per call) */
  pageLimit?: number;
  /** pages read in one poll */
  maxPages?: number;
  /** hashes asked in one call to /v0/transactions */
  batch?: number;
  timeoutMs?: number;
}

const b64json = (value: unknown): unknown => {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
};

export type TxState = { state: 'skip' } | { state: 'pending' } | { state: 'final'; obs: KeyObservation[] };

/**
 * What one transaction is for the watcher. `skip`: not a submit_batch of the published key to the policy, nothing to wait for. `pending`: it is
 * one, but the policy receipt is not there yet or has no final status (SuccessValue or Failure), so the transaction is asked again later.
 * `final`: the receipt is final; a failed call gives no observations, a successful one gives one per request with the contract's verdict.
 */
export function classifyTx(raw: unknown, policy: string, publicKey: string, book: ReadonlySet<string>): TxState {
  const parsed = Tx.safeParse(raw);
  if (!parsed.success) return { state: 'skip' };
  const { transaction: tx, receipts } = parsed.data;
  if (tx.public_key !== publicKey || tx.receiver_id !== policy) return { state: 'skip' };
  const call = tx.actions.map((a) => (a['FunctionCall'] ?? null) as { method_name?: unknown; args?: unknown } | null).find((a) => a !== null && a.method_name === 'submit_batch');
  if (call === undefined || call === null) return { state: 'skip' };
  const receipt = receipts.find((r) => r.execution_outcome.outcome.executor_id === policy && r.receipt.predecessor_id === tx.signer_id);
  if (receipt === undefined) return { state: 'pending' };
  const status = receipt.execution_outcome.outcome.status;
  if ('Failure' in status) return { state: 'final', obs: [] };
  if (!('SuccessValue' in status)) return { state: 'pending' };
  const args = z.object({ reqs: z.array(z.unknown()) }).safeParse(b64json(call.args));
  const outcomes = z.array(Outcome).safeParse(b64json(status['SuccessValue']));
  if (!args.success || !outcomes.success || outcomes.data.length !== args.data.reqs.length) return { state: 'final', obs: [] };
  const obs: KeyObservation[] = [];
  for (const [i, o] of outcomes.data.entries()) {
    const req = Req.safeParse(args.data.reqs[i]);
    if (!req.success) continue;
    obs.push({ requestId: o.request_id, payee: req.data.payee, asset: req.data.asset, amount: req.data.amount, outcome: OUTCOME[o.outcome], reason: o.reason, tx: tx.hash, toBook: book.has(req.data.payee) });
  }
  return { state: 'final', obs };
}

/** The observations of one transaction once it is final, else []. */
export function observationsOf(raw: unknown, policy: string, publicKey: string, book: ReadonlySet<string>): KeyObservation[] {
  const t = classifyTx(raw, policy, publicKey, book);
  return t.state === 'final' ? t.obs : [];
}

interface Gap {
  /** continue the listing from here (older transactions) */
  token: string;
  /** until a listed transaction is at or below this height: everything older was already listed */
  floor: number;
}

export class FastNearKeySource implements KeyWatcherSource {
  private readonly done = new Set<string>();
  /** listed transactions whose policy receipt is not final yet, with their heights: asked again on every poll */
  private readonly pending = new Map<string, number>();
  /** unread stretches of the listing left behind when a scan ended on maxPages */
  private gaps: Gap[] = [];
  /** the highest block height listed so far */
  private high = -1;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly o: FastNearOptions) {
    this.base = (o.baseUrl ?? FASTNEAR_TESTNET_TX).replace(/\/$/, '');
    this.fetchFn = o.fetchFn ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
    if (!res.ok) throw new Error(`fastnear ${path} answered ${String(res.status)}`);
    return (await res.json()) as unknown;
  }

  /**
   * Reads up to maxPages pages from `token` (null: the newest) and adds the unhandled transactions to `into`. It stops at a listed transaction
   * at or below `floor`, at the end of the listing, or at maxPages; in the last case it returns the token to continue from.
   */
  private async scan(token: string | null, floor: number, into: Map<string, number>): Promise<{ top: number; rest: string | null }> {
    let top = -1;
    let at = token;
    for (let page = 0; page < (this.o.maxPages ?? 5); page += 1) {
      const body: Record<string, unknown> = { account_id: this.o.policy, is_function_call: true, limit: this.o.pageLimit ?? 50 };
      if (at !== null) body['resume_token'] = at;
      const parsed = AccountPage.safeParse(await this.post('/v0/account', body));
      if (!parsed.success) throw new Error('fastnear /v0/account answered something unexpected');
      let reachedFloor = false;
      for (const t of parsed.data.account_txs) {
        top = Math.max(top, t.tx_block_height);
        if (t.tx_block_height <= floor) reachedFloor = true;
        else if (!this.done.has(t.transaction_hash) && t.is_success !== false) into.set(t.transaction_hash, t.tx_block_height);
      }
      at = parsed.data.resume_token ?? null;
      if (reachedFloor || at === null || parsed.data.account_txs.length === 0) return { top, rest: null };
    }
    return { top, rest: at };
  }

  async poll(): Promise<KeyObservation[]> {
    const todo = new Map(this.pending);
    // the newest transactions, down to the highest block already listed; a stretch this scan could not reach becomes a gap read next time
    const fresh = await this.scan(null, this.high, todo);
    const gapOfThisScan: Gap | null = fresh.rest === null ? null : { token: fresh.rest, floor: this.high };
    this.high = Math.max(this.high, fresh.top);
    // the stretches earlier polls left behind, each continued from its own token (the one this poll leaves is read from the next poll on)
    const open: Gap[] = [];
    for (const gap of this.gaps) {
      const next = await this.scan(gap.token, gap.floor, todo);
      if (next.rest !== null) open.push({ token: next.rest, floor: gap.floor });
    }
    this.gaps = gapOfThisScan === null ? open : [...open, gapOfThisScan];
    if (todo.size === 0) return [];
    const book = await this.o.bookKeys();
    const got: Array<{ height: number; obs: KeyObservation[] }> = [];
    const size = this.o.batch ?? 20;
    const hashes = [...todo.keys()];
    for (let i = 0; i < hashes.length; i += size) {
      const chunk = hashes.slice(i, i + size);
      const list = TxList.parse(await this.post('/v0/transactions', { tx_hashes: chunk }));
      const settled = new Set<string>();
      for (const raw of list.transactions) {
        const hash = (raw as { transaction?: { hash?: unknown } } | null)?.transaction?.hash;
        if (typeof hash !== 'string' || !todo.has(hash)) continue;
        const t = classifyTx(raw, this.o.policy, this.o.publicKey, book);
        if (t.state === 'pending') continue;
        settled.add(hash);
        this.done.add(hash);
        this.pending.delete(hash);
        if (t.state === 'final') got.push({ height: todo.get(hash) ?? 0, obs: t.obs });
      }
      // a listed transaction that is not returned yet, or has no final policy receipt, is kept and asked again on the next poll
      for (const h of chunk) if (!settled.has(h)) this.pending.set(h, todo.get(h) ?? 0);
    }
    return got.sort((a, b) => a.height - b.height).flatMap((g) => g.obs);
  }
}

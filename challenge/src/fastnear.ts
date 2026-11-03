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

/** The observations of one transaction, or [] when it is not a successful submit_batch of the published key to the policy. */
export function observationsOf(raw: unknown, policy: string, publicKey: string, book: ReadonlySet<string>): KeyObservation[] {
  const parsed = Tx.safeParse(raw);
  if (!parsed.success) return [];
  const { transaction: tx, receipts } = parsed.data;
  if (tx.public_key !== publicKey || tx.receiver_id !== policy) return [];
  const call = tx.actions.map((a) => (a['FunctionCall'] ?? null) as { method_name?: unknown; args?: unknown } | null).find((a) => a !== null && a.method_name === 'submit_batch');
  if (call === undefined || call === null) return [];
  const args = z.object({ reqs: z.array(z.unknown()) }).safeParse(b64json(call.args));
  const receipt = receipts.find((r) => r.execution_outcome.outcome.executor_id === policy && r.receipt.predecessor_id === tx.signer_id);
  const answer = receipt === undefined ? undefined : b64json(receipt.execution_outcome.outcome.status['SuccessValue']);
  if (!args.success || answer === undefined) return [];
  const outcomes = z.array(Outcome).safeParse(answer);
  if (!outcomes.success || outcomes.data.length !== args.data.reqs.length) return [];
  const out: KeyObservation[] = [];
  for (const [i, o] of outcomes.data.entries()) {
    const req = Req.safeParse(args.data.reqs[i]);
    if (!req.success) continue;
    out.push({ requestId: o.request_id, payee: req.data.payee, asset: req.data.asset, amount: req.data.amount, outcome: OUTCOME[o.outcome], reason: o.reason, tx: tx.hash, toBook: book.has(req.data.payee) });
  }
  return out;
}

export class FastNearKeySource implements KeyWatcherSource {
  private readonly done = new Set<string>();
  private cursor = -1;
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

  /** The hashes of transactions newer than the cursor that have not been handled, with their block heights. */
  private async fresh(): Promise<Array<{ hash: string; height: number }>> {
    const found: Array<{ hash: string; height: number }> = [];
    let token: string | null = null;
    for (let page = 0; page < (this.o.maxPages ?? 5); page += 1) {
      const body: Record<string, unknown> = { account_id: this.o.policy, is_function_call: true, limit: this.o.pageLimit ?? 50 };
      if (token !== null) body['resume_token'] = token;
      const parsed = AccountPage.safeParse(await this.post('/v0/account', body));
      if (!parsed.success) throw new Error('fastnear /v0/account answered something unexpected');
      let reachedKnown = false;
      for (const t of parsed.data.account_txs) {
        if (t.tx_block_height <= this.cursor) reachedKnown = true;
        else if (!this.done.has(t.transaction_hash) && t.is_success !== false) found.push({ hash: t.transaction_hash, height: t.tx_block_height });
      }
      token = parsed.data.resume_token ?? null;
      if (reachedKnown || token === null || parsed.data.account_txs.length === 0) break;
    }
    return found;
  }

  async poll(): Promise<KeyObservation[]> {
    const todo = await this.fresh();
    if (todo.length === 0) return [];
    const book = await this.o.bookKeys();
    const heights = new Map(todo.map((t) => [t.hash, t.height] as const));
    const got: Array<{ height: number; obs: KeyObservation[] }> = [];
    let missingFloor = Infinity;
    const size = this.o.batch ?? 20;
    for (let i = 0; i < todo.length; i += size) {
      const hashes = todo.slice(i, i + size).map((t) => t.hash);
      const list = TxList.parse(await this.post('/v0/transactions', { tx_hashes: hashes }));
      const returned = new Set<string>();
      for (const raw of list.transactions) {
        const hash = (raw as { transaction?: { hash?: unknown } } | null)?.transaction?.hash;
        if (typeof hash !== 'string' || !heights.has(hash)) continue;
        returned.add(hash);
        this.done.add(hash);
        got.push({ height: heights.get(hash) ?? 0, obs: observationsOf(raw, this.o.policy, this.o.publicKey, book) });
      }
      // a listed transaction the second call does not return yet is asked again next time, and the cursor stays below it
      for (const h of hashes) if (!returned.has(h)) missingFloor = Math.min(missingFloor, (heights.get(h) ?? 0) - 1);
    }
    const top = Math.max(...todo.map((t) => t.height));
    this.cursor = Math.max(this.cursor, Math.min(top, missingFloor));
    return got.sort((a, b) => a.height - b.height).flatMap((g) => g.obs);
  }
}

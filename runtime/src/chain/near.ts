// ChainClient: submits a batch as the agent without ever double-submitting, decodes the contract's events, serves the contract views the
// runtime needs, and polls a request until it is signed. The contract owns the request id and the nonce (F06 3.1); the client derives
// the ids locally, reads `get_request` before any resubmit, signs a batch once and sends it at most twice (the same bytes), the second
// send only after a full poll window.
import { AccessKeyRequiresFullAccessActionError, InvalidNonceError } from 'near-api-js/rpc-errors';
import { z } from 'zod';
import type { Signer } from 'near-api-js';
import { taskHash } from '../dsl/index.ts';
import type { ActionRequest, BookRows, OwnerTask } from '../dsl/index.ts';
import { ChainError, ChainWaitError } from './errors.ts';
import { requestId } from './ids.ts';
import { DEFAULT_RPC_URLS, RpcPool } from './rpc.ts';
import { LiveTransport } from './transport.ts';
import type { ChainTransport, PreparedTx, RpcTx } from './transport.ts';
import {
  AssetListSchema,
  BookPageSchema,
  LedgersViewSchema,
  PolicyViewJsonSchema,
  SubmitOutcomeSchema,
  parseRequestView,
} from './types.ts';
import type { AssetEntryViewJson, BatchResult, LedgersView, PolicyViewJson, RequestView, SignedEvent, SubmitOutcome } from './types.ts';

const DEFAULT_GAS = 300_000_000_000_000n;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_WINDOW_MS = 30000;
const BOOK_PAGE = 50;
const MAX_BOOK_PAGES = 200;
const TASK_HASH = /^[0-9a-f]{64}$/;

interface CommonConfig {
  network: 'testnet';
  contractId: string;
  agentAccountId: string;
  rpcUrls?: string[];
  /** Gas attached to `submit_batch`; 300 Tgas until AIR-107 measures (a budget the signer must hold 0.3 NEAR free for up front). */
  gas?: bigint;
  /** Milliseconds between polls (tests shrink it). */
  pollMs?: number;
  /** How long an unknown outcome is polled before a resend, and again after it (tests shrink it). */
  windowMs?: number;
}

/** The live client: a signer, and the client builds the pool and the live transport itself. */
export type LiveChainClientConfig = CommonConfig & { signer: Signer; transport?: undefined };
/** A client over a transport (a replay, a recording, a test double): no signer needed. */
export type SeamChainClientConfig = CommonConfig & { transport: ChainTransport; signer?: Signer };
export type ChainClientConfig = LiveChainClientConfig | SeamChainClientConfig;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseAnswer<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'))];
  throw new ChainError('BadResponse', `${what} answer does not match its schema: ${paths.join(', ')}`);
}

/** The outcome a stored request stands for, used when a batch is recovered by reading its requests back. */
export function outcomeFromView(view: RequestView): SubmitOutcome {
  switch (view.state) {
    case 'Pending':
    case 'Rejected':
    case 'Expired':
      return { request_id: view.request_id, outcome: 'escalated', reason: view.reason, pending_id: view.id };
    case 'Blocked':
      return { request_id: view.request_id, outcome: 'blocked', reason: view.reason, pending_id: null };
    default:
      // Executing, Executed, Retryable and Failed all passed the gate as an Allow
      return { request_id: view.request_id, outcome: 'allowed', reason: null, pending_id: null };
  }
}

interface BatchCtx {
  reqs: ActionRequest[];
  ids: string[];
  hash: string;
  retry: boolean;
}

export class ChainClient {
  readonly contractId: string;
  readonly agentAccountId: string;
  private readonly transport: ChainTransport;
  private readonly gas: bigint;
  private readonly pollMs: number;
  private readonly windowMs: number;

  constructor(cfg: LiveChainClientConfig);
  constructor(cfg: SeamChainClientConfig);
  constructor(cfg: ChainClientConfig) {
    this.contractId = cfg.contractId;
    this.agentAccountId = cfg.agentAccountId;
    this.gas = cfg.gas ?? DEFAULT_GAS;
    this.pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;
    this.windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
    if (cfg.transport !== undefined) {
      this.transport = cfg.transport;
    } else if (cfg.signer !== undefined) {
      this.transport = new LiveTransport({
        contractId: cfg.contractId,
        agentAccountId: cfg.agentAccountId,
        signer: cfg.signer,
        pool: new RpcPool(cfg.rpcUrls ?? DEFAULT_RPC_URLS),
      });
    } else {
      throw new TypeError('ChainClient needs a signer or a transport');
    }
  }

  // ---- views ----

  /** `id` is a request id or a decimal pending number (AIR-063). Null when the contract has no such request. */
  async getRequest(id: string): Promise<RequestView | null> {
    const raw = await this.transport.view('get_request', { id });
    try {
      return parseRequestView(raw);
    } catch {
      throw new ChainError('BadResponse', 'get_request answer does not match its schema');
    }
  }

  /** `task` is a task hash in 64 lowercase hex, or omitted. */
  async getLedgers(payee: string, asset: string, task?: string): Promise<LedgersView> {
    if (task !== undefined && !TASK_HASH.test(task)) throw new RangeError('task must be 64 lowercase hex characters');
    const raw = await this.transport.view('get_ledgers', { payee, asset, task: task ?? null });
    return parseAnswer(LedgersViewSchema, raw, 'get_ledgers');
  }

  async getBook(): Promise<BookRows> {
    const rows: BookRows[number][] = [];
    for (let page = 0; page < MAX_BOOK_PAGES; page++) {
      const raw = await this.transport.view('get_book', { from_index: page * BOOK_PAGE, limit: BOOK_PAGE });
      const part = parseAnswer(BookPageSchema, raw, 'get_book');
      rows.push(...part);
      if (part.length < BOOK_PAGE) return rows;
    }
    throw new ChainError('BadResponse', 'get_book kept answering full pages');
  }

  async listAssets(): Promise<ReadonlyArray<readonly [string, AssetEntryViewJson]>> {
    return parseAnswer(AssetListSchema, await this.transport.view('list_assets', {}), 'list_assets');
  }

  async getPolicy(): Promise<PolicyViewJson> {
    return parseAnswer(PolicyViewJsonSchema, await this.transport.view('get_policy', {}), 'get_policy');
  }

  /** The time of the latest final block in milliseconds: the nanosecond text divided with BigInt and truncated. */
  async latestBlockMs(): Promise<number> {
    const nanos = await this.transport.blockNanosec();
    if (!/^[0-9]+$/.test(nanos)) throw new ChainError('BadResponse', 'block timestamp is not a decimal string');
    return JSON.parse((BigInt(nanos) / 1_000_000n).toString()) as number;
  }

  /**
   * Polls `get_request` until the request is signed. A Pending or Executing request keeps waiting; Retryable and Failed end in
   * `ChainWaitError('Failed')` (retryable or not), Blocked, Rejected and Expired in `('NotSigned')`, the clock in `('Timeout')`.
   */
  async waitSigned(id: string, timeoutMs: number): Promise<SignedEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await this.getRequest(id);
      if (view !== null) {
        switch (view.state) {
          case 'Executed': {
            const exec = view.exec;
            if (exec !== null && exec.unsigned_hex !== null && exec.big_r !== null && exec.s !== null && exec.recovery_id !== null) {
              return { request_id: view.request_id, unsigned_hex: exec.unsigned_hex, big_r: exec.big_r, s: exec.s, recovery_id: exec.recovery_id };
            }
            break;
          }
          case 'Retryable':
            throw new ChainWaitError('Failed', `request ${id} failed and may be retried`, view.reason, true);
          case 'Failed':
            throw new ChainWaitError('Failed', `request ${id} failed`, view.reason, false);
          case 'Blocked':
          case 'Rejected':
          case 'Expired':
            throw new ChainWaitError('NotSigned', `request ${id} is ${view.state} and will not be signed`, view.reason, false);
          default:
            break;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new ChainWaitError('Timeout', `request ${id} was not signed in ${timeoutMs} ms`, null, false);
      await sleep(Math.min(this.pollMs, left));
    }
  }

  // ---- submit ----

  /**
   * Submits a batch of 1 to 3 requests under one owner-signed task. Order: validate, read every derived id back (all present and no
   * `retry`: the batch was already submitted, return it recovered and send nothing), sign once, send. A thrown send means the outcome
   * is unknown: poll the ids and the transaction status for a window, then send the same bytes once more, poll again, and give up
   * with `ChainError('Unknown')`. The only new signature is the dead-nonce case. At most two `send_tx` requests in total.
   */
  async submitBatch(reqs: ActionRequest[], task: OwnerTask, taskSig: Uint8Array, opts: { retry?: boolean } = {}): Promise<BatchResult> {
    if (reqs.length < 1 || reqs.length > 3) throw new ChainError('BadBatch', 'a batch holds 1 to 3 requests');
    for (const req of reqs) {
      if (req.task_id !== task.task_id) throw new ChainError('BadBatch', 'every request must carry the task_id of the task');
    }
    const ctx: BatchCtx = { reqs, ids: reqs.map((req) => requestId(task, req.action_index)), hash: taskHash(task), retry: opts.retry === true };

    const before = await this.readAll(ctx.ids);
    this.assertContent(ctx, before);
    if (ctx.retry) {
      if (!before.every((view) => view !== null && view.state === 'Retryable')) {
        throw new ChainError('NotRetryable', 'retry needs every request of the batch to be Retryable');
      }
    } else if (before.every((view) => view !== null)) {
      return this.recovered(ctx, before as RequestView[]);
    }

    const args = { reqs, task, task_sig: Buffer.from(taskSig).toString('base64') };
    const first = await this.transport.prepare('submit_batch', args, this.gas);
    let firstError: unknown;
    try {
      return this.finish(ctx, await this.transport.submit(first), first);
    } catch (error) {
      if (error instanceof ChainError) throw error;
      this.rejectedBeforeExecution(error, first);
      firstError = error;
    }

    // the outcome is unknown: look for it for a full window before anything is sent again
    const firstLook = await this.look(ctx, first);
    if (firstLook.done !== null) return firstLook.done;

    // the second and last send: the same bytes, unless the nonce went to another transaction and these bytes can never execute
    const deadNonce = firstError instanceof InvalidNonceError && firstLook.status === 'unseen';
    const second = deadNonce ? await this.transport.prepare('submit_batch', args, this.gas) : first;
    try {
      return this.finish(ctx, await this.transport.submit(second), second);
    } catch (error) {
      if (error instanceof ChainError) throw error;
      this.rejectedBeforeExecution(error, second);
    }
    const secondLook = await this.look(ctx, second);
    if (secondLook.done !== null) return secondLook.done;
    throw new ChainError('Unknown', 'the outcome of submit_batch is unknown after two sends', second.hash);
  }

  // a send the node refused outright before execution: nothing to poll for and nothing to resend
  private rejectedBeforeExecution(error: unknown, tx: PreparedTx): void {
    if (error instanceof AccessKeyRequiresFullAccessActionError) {
      throw new ChainError('NotRetryable', 'RequiresFullAccess: the agent key cannot send this transaction', tx.hash);
    }
  }

  private async readAll(ids: string[]): Promise<(RequestView | null)[]> {
    return Promise.all(ids.map((id) => this.getRequest(id)));
  }

  // a batch has landed when every id has a request; a retry only when none of them is still Retryable
  private landed(ctx: BatchCtx, views: (RequestView | null)[]): views is RequestView[] {
    return views.every((view) => view !== null && (!ctx.retry || view.state !== 'Retryable'));
  }

  // an id that exists with other content than ours would make the contract revert `request mismatch`: it is a bug in the caller
  private assertContent(ctx: BatchCtx, views: (RequestView | null)[]): void {
    views.forEach((view, i) => {
      const req = ctx.reqs[i];
      if (view === null || view.tombstone === true || req === undefined) return;
      const same =
        view.task_id === req.task_id &&
        view.asset === req.asset &&
        view.payee === req.payee &&
        view.amount === req.amount &&
        view.labels.recipient === req.labels.recipient &&
        view.labels.amount === req.labels.amount &&
        view.labels.pc === req.labels.pc;
      if (!same) throw new ChainError('RequestMismatch', `request ${ctx.ids[i]} exists with other content than this request`);
    });
  }

  private recovered(ctx: BatchCtx, views: RequestView[]): BatchResult {
    this.assertContent(ctx, views);
    return { taskHash: ctx.hash, outcomes: views.map(outcomeFromView), txHash: null, events: [], recovered: true, views };
  }

  // a transaction outcome the client saw (a returned one, or a final one read by hash)
  private async finish(ctx: BatchCtx, tx: RpcTx, sent: PreparedTx): Promise<BatchResult> {
    const txHash = tx.hash ?? sent.hash;
    if (tx.failure !== null) {
      const text = tx.failure;
      if (text.startsWith('request mismatch')) throw new ChainError('RequestMismatch', text, txHash);
      if (text.startsWith('request_id already used (UsedRequestId)')) {
        // the id is final: read every request back and return the batch as it stands
        const views = await this.readAll(ctx.ids);
        if (!views.every((view) => view !== null)) throw new ChainError('BadResponse', 'UsedRequestId, but a request of the batch has no record', txHash);
        return this.recovered(ctx, views as RequestView[]);
      }
      throw new ChainError('Panic', text, txHash);
    }
    const parsed = SubmitOutcomeSchema.array().safeParse(tx.returnValue);
    if (!parsed.success || parsed.data.length !== ctx.reqs.length) throw new ChainError('BadResponse', 'submit_batch answered something other than one outcome per request', txHash);
    parsed.data.forEach((outcome, i) => {
      if (outcome.request_id !== ctx.ids[i]) throw new ChainError('IdMismatch', `the contract answered another request id than the derived one for request ${i}`, txHash);
    });
    return { taskHash: ctx.hash, outcomes: parsed.data, txHash, events: tx.logs, recovered: false, views: [] };
  }

  // Polls the ids and the transaction status for one window. `done` is the result when either shows the batch (the ids first: the moment
  // every id exists the batch is recovered); otherwise `status` is what the last status lookup said: 'unseen' (the node does not know
  // the hash), 'pending', or 'error' (the lookup itself failed).
  private async look(ctx: BatchCtx, sent: PreparedTx): Promise<{ done: BatchResult | null; status: 'unseen' | 'pending' | 'error' }> {
    const deadline = Date.now() + this.windowMs;
    let status: 'unseen' | 'pending' | 'error' = 'error';
    for (;;) {
      let views: (RequestView | null)[] | null = null;
      try {
        views = await this.readAll(ctx.ids);
      } catch {
        views = null;
      }
      if (views !== null && this.landed(ctx, views)) return { done: this.recovered(ctx, views), status };
      try {
        const seen = await this.transport.txStatus(sent.hash);
        if (seen !== null && seen !== 'pending') return { done: await this.finish(ctx, seen, sent), status };
        status = seen === null ? 'unseen' : 'pending';
      } catch (error) {
        if (error instanceof ChainError) throw error;
        status = 'error';
      }
      const left = deadline - Date.now();
      if (left <= 0) return { done: null, status };
      await sleep(Math.min(this.pollMs, left));
    }
  }
}

// The orchestrator (AIR-164). `planTask` is the only door to the planner (the import test of AIR-141 enforces it). `runTask` takes the plan the
// owner signed and runs one instance of it per inbox item, each a separate all-or-nothing run under the one confirmed task, so one poisoned
// item cannot abort the others (SPEC 13c R3-05: isolation is per run). The proposals of all runs are submitted as batches of at most 3 with
// deterministic action indexes (item number times K plus the position), so a restart reproduces the same request ids. Nothing here decides
// a label, a fee, a recipient or an amount: labels come from the interpreter, fees from the asset registry, the item list from the mailbox.
import { sha256 } from '@noble/hashes/sha2';
import { maxActionsFor } from './analyze/index.ts';
import type { AssetRegistry } from './analyze/index.ts';
import { EvmMismatch, verifySignedMatchesRequest } from './chain/evm.check.ts';
import { EvmAssembleError, EvmBroadcastError, EvmDecodeError, assembleEvm, broadcast } from './chain/evm.ts';
import { ChainError, ChainWaitError } from './chain/errors.ts';
import { requestId } from './chain/ids.ts';
import type { ChainClient } from './chain/near.ts';
import type { BatchResult, SubmitOutcome } from './chain/types.ts';
import { ActionRequest, labelsToBits, planSha256 } from './dsl/index.ts';
import type { CheckedPlan, OwnerTask, PlanStep } from './dsl/index.ts';
import { pickEvidence, requestContentHash } from './evidence.ts';
import type { EvidenceField, EvidenceSource, EvidenceStore } from './evidence.ts';
import { run } from './interpreter/index.ts';
import type { Book, Extractor, Grounder, Proposed, RunDeps, RunResult, ToolArgPolicy, Tools, TraceEvent } from './interpreter/index.ts';
import { plan } from './planner/planner.ts';
import type { OwnerRequest, PlanOpts } from './planner/planner.ts';

// ---- the door to the planner ----

/** The planner call of the server (AIR-163) and the bench (AIR-220). The model's own result (text, usage, hashes) stays behind this door. */
export async function planTask(req: OwnerRequest, model: string, opts?: PlanOpts): Promise<{ plan: CheckedPlan; planSha256: string }> {
  const out = await plan(req, model, opts);
  return { plan: out.plan, planSha256: out.planSha256 };
}

// ---- fees ----

export type FeePolicy = (assetId: string) => { gas_limit: bigint; max_fee_per_gas: bigint; max_priority_fee_per_gas: bigint } | null;

const NATIVE_TRANSFER_GAS = 21_000n;
const ONE_GWEI = 1_000_000_000n;

/** A native transfer at the registry's fee ceiling, for an EVM asset that has one; null for everything else (near, unknown, no ceiling). */
export function feePolicyFromRegistry(registry: AssetRegistry): FeePolicy {
  return (assetId) => {
    if (!assetId.startsWith('evm:')) return null;
    const entry = registry.get(assetId);
    if (entry === undefined || entry.maxFeePerGas <= 0n || entry.maxGas < NATIVE_TRANSFER_GAS) return null;
    return {
      gas_limit: NATIVE_TRANSFER_GAS,
      max_fee_per_gas: entry.maxFeePerGas,
      max_priority_fee_per_gas: entry.maxFeePerGas < ONE_GWEI ? entry.maxFeePerGas : ONE_GWEI,
    };
  };
}

// ---- the run ----

export interface AgentDeps {
  run: typeof run;
  makeTools(scope: { itemId: string | null; paste: string | null }): Tools;
  inboxItemIds(): Promise<string[]>;
  extract: Extractor;
  book: Book;
  decimalsOf(asset: string): number | undefined;
  /** passed through to `run`; AIR-127 wires the real ones where AgentDeps is built */
  ground?: Grounder;
  toolArgPolicy?: ToolArgPolicy;
  chain: Pick<ChainClient, 'submitBatch' | 'getRequest' | 'waitSigned'>;
  fees: FeePolicy;
  evmSender(assetId: string): string | null;
  rpcUrls: string[];
  broadcast?: typeof broadcast;
  evidence: EvidenceStore;
  clock(): number;
}

export interface RunTaskParams {
  ownerRequest: OwnerRequest;
  paste: string | null;
  task: OwnerTask;
  taskSig: Uint8Array;
  plan: CheckedPlan;
  deps: AgentDeps;
}

/** The plan handed to `runTask` is not the one whose hash the owner signed. Thrown before any tool call. */
export class PlanHashMismatch extends Error {
  constructor() {
    super('the plan does not hash to the plan_sha256 of the task');
    this.name = 'PlanHashMismatch';
  }
}

const BATCH_MAX = 3;
const SIGN_WAIT_MS = 150_000;
// the contract's flood reasons (AIR-082, recorded by AIR-083): the task stops and the owner is told
const FLOOD_REASONS: ReadonlySet<string> = new Set(['PendingFull', 'EscalationsLocked', 'EscalationBudget']);

// a static walk: does the plan read the inbox anywhere
function readsInbox(steps: readonly PlanStep[]): boolean {
  return steps.some((step) => {
    if ('call' in step) return step.call === 'read_inbox';
    if ('if' in step) return readsInbox(step.then) || readsInbox(step.else);
    if ('for' in step) return readsInbox(step.do);
    return false;
  });
}

// a queue between the interpreter's synchronous onEvent and the async iterator that hands the events on while the run is still going
class EventQueue {
  private readonly items: TraceEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(e: TraceEvent): void {
    this.items.push(e);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TraceEvent, void> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) yield next;
      else if (this.closed) return;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

interface Prepared {
  req: ActionRequest;
  item: string | null;
  sources: EvidenceSource[];
}

// the evidence of a proposal: one entry per distinct origin (tool call) of the recipient, of the amount and of the pc, each with its field,
// so the card can show where the recipient came from and where the amount came from separately
function sourcesOf(p: Proposed, trace: readonly TraceEvent[]): EvidenceSource[] {
  const fields: [EvidenceField, readonly string[]][] = [
    ['amount', p.origins.amount],
    ['recipient', p.origins.recipient],
    ['pc', p.origins.pc],
  ];
  return fields.flatMap(([field, origins]) =>
    [...new Set(origins)].map((origin) => {
      const call = trace.find((e) => e.kind === 'call' && e.data.id === origin);
      return { field, origin, ...(call === undefined ? { sender: null, snippet: null } : pickEvidence(call.data.raw)) };
    }),
  );
}

// what an error of the chain or EVM stages says; a message is never copied (it can hold text from outside)
function failureOf(e: unknown): { code: string; retryable?: boolean; detail?: string } {
  if (e instanceof ChainWaitError) return { code: e.code, retryable: e.retryable };
  if (e instanceof ChainError) return { code: e.code === 'RequestMismatch' ? 'ReplayMismatch' : e.code };
  if (e instanceof EvmMismatch) return { code: 'EvmMismatch', detail: e.code };
  if (e instanceof EvmAssembleError) return { code: 'EvmAssemble' };
  if (e instanceof EvmDecodeError) return { code: 'EvmDecode' };
  if (e instanceof EvmBroadcastError) return { code: `Broadcast${e.code}` };
  return { code: 'Unexpected' };
}

/**
 * Runs the task the owner signed. Throws PlanHashMismatch on the first step of the iteration when `plan` is not the signed plan. Events
 * are yielded as they happen: `plan`, then the interpreter's events of each run (each with `data.item`), then per batch `submitted`
 * and one `verdict` per request, and for an allowed EVM request `signed` and `broadcast`. A failure ends in an `error` event.
 */
export async function* runTask(p: RunTaskParams): AsyncGenerator<TraceEvent, void> {
  const { deps, task } = p;
  const planHash = planSha256(p.plan);
  if (planHash !== task.plan_sha256) throw new PlanHashMismatch();
  const ev = (kind: TraceEvent['kind'], data: Record<string, unknown>): TraceEvent => ({ t: deps.clock(), kind, data });

  yield ev('plan', { planSha256: planHash, steps: p.plan });

  // items: ids come from the mailbox, never from the model
  const itemIds: (string | null)[] = readsInbox(p.plan) ? await deps.inboxItemIds() : [null];
  const k = maxActionsFor(p.plan);
  const prepared: Prepared[] = [];

  for (const [i, itemId] of itemIds.entries()) {
    const queue = new EventQueue();
    const runDeps: RunDeps = {
      tools: deps.makeTools({ itemId, paste: p.paste }),
      extract: deps.extract,
      book: deps.book,
      decimalsOf: deps.decimalsOf,
      ownerText: p.ownerRequest.text,
      now: deps.clock,
      onEvent: (e) => queue.push({ t: e.t, kind: e.kind, data: { ...e.data, item: itemId } }),
      ...(deps.ground === undefined ? {} : { ground: deps.ground }),
      ...(deps.toolArgPolicy === undefined ? {} : { toolArgPolicy: deps.toolArgPolicy }),
    };
    let result: RunResult | undefined;
    let failed: { error: unknown } | undefined;
    const done = deps
      .run(p.plan, runDeps)
      .then(
        (r) => {
          result = r;
        },
        (error: unknown) => {
          failed = { error };
        },
      )
      .finally(() => queue.close());
    yield* queue;
    await done;
    if (failed !== undefined) throw failed.error;
    // an aborted run contributes nothing: its error event was already forwarded, with the item id
    if (result === undefined || !result.ok) continue;

    let digest: string | null = null;
    for (const [pos, proposal] of result.proposed.entries()) {
      const index = i * k + pos;
      if (index >= task.max_actions) {
        yield ev('error', { code: 'NeedsAnotherTask', item: itemId, index });
        continue;
      }
      let evm: ActionRequest['evm'] = null;
      if (proposal.asset.startsWith('evm:')) {
        const fee = deps.fees(proposal.asset);
        if (fee === null) {
          yield ev('error', { code: 'NoFeePolicy', item: itemId, index });
          continue;
        }
        evm = { gas_limit: fee.gas_limit.toString(), max_fee_per_gas: fee.max_fee_per_gas.toString(), max_priority_fee_per_gas: fee.max_priority_fee_per_gas.toString() };
      }
      try {
        digest ??= toHex(sha256(new TextEncoder().encode(JSON.stringify(result.trace.map((e) => ({ kind: e.kind, data: e.data }))))));
        const req = ActionRequest.parse({
          task_id: task.task_id,
          action_index: index,
          asset: proposal.asset,
          payee: proposal.payee,
          amount: proposal.amount.toString(),
          labels: { recipient: labelsToBits(proposal.recipientLabels), amount: labelsToBits(proposal.amountLabels), pc: labelsToBits(proposal.pc) },
          evm,
          hints: { plan_hash: task.plan_sha256, trace_digest: digest },
        });
        prepared.push({ req, item: itemId, sources: sourcesOf(proposal, result.trace) });
      } catch {
        yield ev('error', { code: 'BadRequest', item: itemId, index });
      }
    }
  }

  // batches: at most 3 requests each, in index order
  prepared.sort((a, b) => a.req.action_index - b.req.action_index);
  for (let at = 0; at < prepared.length; at += BATCH_MAX) {
    const chunk = prepared.slice(at, at + BATCH_MAX);
    let batch: BatchResult;
    try {
      batch = await deps.chain.submitBatch(
        chunk.map((c) => c.req),
        task,
        p.taskSig,
      );
    } catch (e) {
      if (!(e instanceof ChainError)) throw e;
      yield ev('error', failureOf(e));
      return;
    }
    yield ev('submitted', { count: chunk.length, taskHash: batch.taskHash, txHash: batch.recovered ? null : batch.txHash });
    const byId = new Map(chunk.map((c) => [requestId(task, c.req.action_index), c] as const));
    // evidence is written only now that the chain confirmed the request, once per id, and only for a request whose stored content is ours
    for (const [id, c] of byId) {
      const hash = requestContentHash(c.req);
      if (batch.recovered) {
        const view = batch.views.find((v) => v.request_id === id);
        if (view === undefined || view.tombstone === true || requestContentHash(view) !== hash) {
          yield ev('error', { code: 'EvidenceMismatch', request_id: id, item: c.item });
          continue;
        }
      }
      if (deps.evidence.put(id, { requestHash: hash, sources: c.sources }) === 'refused') {
        yield ev('error', { code: 'EvidenceConflict', request_id: id, item: c.item });
      }
    }
    let flood: string | null = null;
    for (const o of batch.outcomes) {
      yield ev('verdict', { request_id: o.request_id, outcome: o.outcome, reason: o.reason, pending_id: o.pending_id, item: byId.get(o.request_id)?.item ?? null });
      if (o.outcome === 'blocked' && o.reason !== null && FLOOD_REASONS.has(o.reason) && flood === null) flood = o.reason;
    }
    if (flood !== null) yield ev('error', { code: 'FloodStop', reason: flood });
    // an allowed request on an EVM asset goes on: wait for the signature, check it against the stored request, broadcast
    for (const o of batch.outcomes) {
      const c = byId.get(o.request_id);
      if (o.outcome === 'allowed' && c !== undefined && c.req.asset.startsWith('evm:')) yield* evmTail(p, o, c, ev);
    }
    if (flood !== null) return;
  }
}

async function* evmTail(
  p: RunTaskParams,
  o: SubmitOutcome,
  c: Prepared,
  ev: (kind: TraceEvent['kind'], data: Record<string, unknown>) => TraceEvent,
): AsyncGenerator<TraceEvent, void> {
  const { deps } = p;
  const fail = (step: string, e: unknown): TraceEvent => ev('error', { ...failureOf(e), step, request_id: o.request_id, item: c.item });
  let raw: `0x${string}`;
  try {
    const signed = await deps.chain.waitSigned(o.request_id, SIGN_WAIT_MS);
    const view = await deps.chain.getRequest(o.request_id);
    if (view === null) throw new ChainError('BadResponse', 'no record for a request that was signed');
    raw = assembleEvm(signed.unsigned_hex, { big_r: signed.big_r, s: signed.s, recovery_id: signed.recovery_id });
    const sender = deps.evmSender(c.req.asset);
    // a sender that cannot be derived is the same failure as one that does not match
    if (sender === null) throw new EvmMismatch('sender', 'no derived sender for the asset');
    await verifySignedMatchesRequest(raw, view, sender);
  } catch (e) {
    yield fail('sign', e);
    return;
  }
  yield ev('signed', { request_id: o.request_id });
  try {
    const sent = await (deps.broadcast ?? broadcast)(raw, deps.rpcUrls);
    yield ev('broadcast', { hash: sent.hash, status: sent.status });
  } catch (e) {
    yield fail('broadcast', e);
  }
}

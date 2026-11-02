// Fixtures for the orchestrator tests (AIR-164): AgentDeps built from the interpreter stubs (helpers/interp.ts), a stub chain that records
// submitBatch calls and answers from a script, the AIR-180 fixture registry and a task in the shape of the AIR-122 vector.
import { requestId } from '../../src/chain/ids.ts';
import type { BatchResult, RequestView, SignedEvent, SubmitOutcome } from '../../src/chain/types.ts';
import { checkPlan, planSha256 } from '../../src/dsl/index.ts';
import type { ActionRequest, CheckedPlan, OwnerTask } from '../../src/dsl/index.ts';
import { run } from '../../src/interpreter/index.ts';
import type { Tools, TraceEvent } from '../../src/interpreter/index.ts';
import { MemoryEvidenceStore } from '../../src/evidence.ts';
import { feePolicyFromRegistry } from '../../src/agent.ts';
import type { AgentDeps, RunTaskParams } from '../../src/agent.ts';
import { registry } from './analyze-ctx.ts';
import { decimalsOf, stubBook, stubExtract, stubTools } from './interp.ts';
import { vectorTask } from '../vectors.helpers.ts';

export const SENDER = 'billing@accountant-firm.co';

export interface InboxItem {
  id: string;
  from: string;
  subject: string;
  body: string;
  [k: string]: unknown;
}

export const inboxItem = (id: string, extra: Record<string, unknown> = {}): InboxItem => ({
  id,
  from: SENDER,
  subject: `Invoice ${id}`,
  body: `Please pay invoice ${id}: 4.2 NEAR`,
  ...extra,
});

export const INBOX: InboxItem[] = [inboxItem('m1'), inboxItem('m2'), inboxItem('m3')];

// AIR-120's U01: read the mail, extract the invoice, look the accountant up, pay
export const U01 = [
  { let: 'mail', call: 'read_inbox' },
  { let: 'inv', extract: { from: { ref: 'mail' }, schema: { amount: 'amount', vendor: 'text' } } },
  { let: 'payee', lookup: { key: 'accountant' } },
  { action: 'transfer', args: { to: { ref: 'payee' }, amount: { ref: 'inv', path: ['amount'] }, asset: 'near' } },
];

export const checked = (json: unknown): CheckedPlan => checkPlan(json);

export function taskFor(plan: CheckedPlan, maxActions = 3): OwnerTask {
  return { ...vectorTask(), plan_sha256: planSha256(plan), max_actions: maxActions };
}

export type ChainScript = (reqs: ActionRequest[], call: number) => BatchResult | Promise<BatchResult>;

export const outcomeFor = (task: OwnerTask, req: ActionRequest, over: Partial<SubmitOutcome> = {}): SubmitOutcome => ({
  request_id: requestId(task, req.action_index),
  outcome: 'allowed',
  reason: null,
  pending_id: null,
  ...over,
});

export const batchOf = (task: OwnerTask, outcomes: SubmitOutcome[], over: Partial<BatchResult> = {}): BatchResult => ({
  taskHash: 'f'.repeat(64),
  outcomes,
  txHash: 'tx-hash-1',
  events: [],
  recovered: false,
  views: [],
  ...over,
});

export interface Harness {
  deps: AgentDeps;
  task: OwnerTask;
  /** the requests of every submitBatch call, in call order */
  submits: ActionRequest[][];
  /** the scopes makeTools was called with, in order */
  scopes: { itemId: string | null; paste: string | null }[];
  /** the tool calls of every stub, in order */
  toolCalls: { itemId: string | null; name: string }[];
  evidence: MemoryEvidenceStore;
  /** puts and submits in the order they happened */
  order: string[];
  waits: string[];
  broadcasts: string[];
  ownerRequest: RunTaskParams['ownerRequest'];
}

export interface HarnessOpts {
  maxActions?: number;
  inbox?: InboxItem[];
  /** answers submitBatch; the default allows every request */
  chain?: ChainScript;
  extract?: Parameters<typeof stubExtract>[0];
  evmSender?: AgentDeps['evmSender'];
  fees?: AgentDeps['fees'];
  waitSigned?: AgentDeps['chain']['waitSigned'];
  getRequest?: AgentDeps['chain']['getRequest'];
  broadcast?: NonNullable<AgentDeps['broadcast']>;
  over?: Partial<AgentDeps>;
}

// the extractor reads the invoice amount from the item it is given: item m2 makes it fail (all-null fields)
const defaultExtract: Parameters<typeof stubExtract>[0] = (req) => {
  const first: unknown = Array.isArray(req.data) ? (req.data as unknown[])[0] : undefined;
  const id = typeof first === 'object' && first !== null ? (first as { id?: unknown }).id : undefined;
  return id === 'm2' ? { amount: null, vendor: null } : { amount: '4.2', vendor: 'accountant' };
};

export function harness(plan: CheckedPlan, opts: HarnessOpts = {}): Harness {
  const task = taskFor(plan, opts.maxActions ?? 3);
  const inbox = opts.inbox ?? INBOX;
  const submits: ActionRequest[][] = [];
  const scopes: Harness['scopes'] = [];
  const toolCalls: Harness['toolCalls'] = [];
  const order: string[] = [];
  const waits: string[] = [];
  const broadcasts: string[] = [];
  const evidence = new MemoryEvidenceStore();
  const put = evidence.put.bind(evidence);
  evidence.put = (id, e) => {
    order.push('put');
    return put(id, e);
  };
  const script: ChainScript = opts.chain ?? ((reqs) => batchOf(task, reqs.map((r) => outcomeFor(task, r))));
  const makeTools = (scope: { itemId: string | null; paste: string | null }): Tools => {
    scopes.push(scope);
    const items = scope.itemId === null ? inbox : inbox.filter((i) => i.id === scope.itemId);
    const inner = stubTools({ read_inbox: { raw: items, label: 'Untrusted:email' } }).tools;
    return {
      async call(name, args) {
        toolCalls.push({ itemId: scope.itemId, name });
        return inner.call(name, args);
      },
    };
  };
  const deps: AgentDeps = {
    run,
    makeTools,
    inboxItemIds: async () => inbox.map((i) => i.id),
    extract: stubExtract(opts.extract ?? defaultExtract).extract,
    book: stubBook(),
    decimalsOf,
    chain: {
      async submitBatch(reqs) {
        order.push('submit');
        submits.push(reqs);
        return script(reqs, submits.length - 1);
      },
      getRequest: opts.getRequest ?? (async () => null),
      waitSigned:
        opts.waitSigned ??
        (async (id) => {
          waits.push(id);
          throw new Error('waitSigned was not scripted');
        }),
    },
    fees: opts.fees ?? feePolicyFromRegistry(registry()),
    evmSender: opts.evmSender ?? (() => null),
    rpcUrls: ['http://rpc.invalid'],
    broadcast:
      opts.broadcast ??
      (async (raw) => {
        broadcasts.push(raw);
        return { hash: '0xabc', status: 'success' as const };
      }),
    evidence,
    clock: () => 0,
    ...opts.over,
  };
  return { deps, task, submits, scopes, toolCalls, evidence, order, waits, broadcasts, ownerRequest: { text: 'Pay my accountant.', ownerAccountId: 'owner.testnet', sessionId: 's1' } };
}

export const paramsOf = (h: Harness, plan: CheckedPlan, over: Partial<RunTaskParams> = {}): RunTaskParams => ({
  ownerRequest: h.ownerRequest,
  paste: null,
  task: h.task,
  taskSig: new Uint8Array(64),
  plan,
  deps: h.deps,
  ...over,
});

export async function collect(it: AsyncIterable<TraceEvent>): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export const kinds = (events: TraceEvent[]): string[] => events.map((e) => e.kind);
export const ofKind = (events: TraceEvent[], kind: string): TraceEvent[] => events.filter((e) => e.kind === kind);

// a plan that looks the accountant up and pays `n` different literal amounts to him (K is n)
export const payNPlan = (n: number): unknown[] => [
  { let: 'who', lookup: { key: 'accountant' } },
  ...Array.from({ length: n }, (_v, i) => ({ action: 'transfer', args: { to: { ref: 'who' }, amount: String(i + 1), asset: 'near' } })),
];

// ---- the real MPC fixture (AIR-272), the EVM path ----
export const EVM_ASSET = 'evm:84532:native';
export const EVM_TO = '0x59b0565b4e395e6ea202ca125c7d1a8e7afb8d21';

export const evmPlan = (extra: unknown[] = []): unknown[] => [
  { let: 'mail', call: 'read_inbox' },
  ...extra,
  { action: 'evm_transfer', args: { to: EVM_TO, amount: '0.00001', asset: EVM_ASSET, chain_id: 84532 } },
];

export function evmView(task: OwnerTask, unsignedHex: string): RequestView {
  return {
    request_id: requestId(task, 0),
    id: null,
    state: 'Executed',
    agent: 'agent.testnet',
    task_id: task.task_id,
    asset: EVM_ASSET,
    payee: `evm:84532:${EVM_TO}`,
    amount: '10000000000000',
    labels: { recipient: 1, amount: 1, pc: 1 },
    reason: null,
    book_status: null,
    display: null,
    created_ms: '0',
    expires_ms: null,
    digest: null,
    exec: { unsigned_hex: unsignedHex, big_r: null, s: null, recovery_id: null },
  };
}

export const signedFrom = (task: OwnerTask, unsignedHex: string, resp: { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number }): SignedEvent => ({
  request_id: requestId(task, 0),
  unsigned_hex: unsignedHex,
  big_r: resp.big_r.affine_point,
  s: resp.s.scalar,
  recovery_id: resp.recovery_id,
});

// the stored view of a request as the chain would answer it, built from the request we sent
export const viewOfRequest = (task: OwnerTask, req: ActionRequest, over: Partial<RequestView> = {}): RequestView => ({
  request_id: requestId(task, req.action_index),
  id: null,
  state: 'Pending',
  agent: 'agent.testnet',
  task_id: req.task_id,
  asset: req.asset,
  payee: req.payee,
  amount: req.amount,
  labels: req.labels,
  reason: null,
  book_status: null,
  display: null,
  created_ms: '0',
  expires_ms: null,
  digest: null,
  exec: null,
  ...over,
});

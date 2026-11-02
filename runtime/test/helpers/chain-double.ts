// A scripted ChainTransport for the chain client's unit tests: no network, no keys. It counts every prepare and submit call and keeps
// the PreparedTx of each submit, so a test can show that a resend carried the same bytes.
import { ChainClient } from '../../src/chain/near.ts';
import type { ChainTransport, PreparedTx, RpcTx } from '../../src/chain/transport.ts';
import { requestId } from '../../src/chain/ids.ts';
import type { ActionRequest, OwnerTask } from '../../src/dsl/index.ts';
import { vectorTask } from '../vectors.helpers.ts';

export type SubmitStep = (tx: PreparedTx) => RpcTx | Promise<RpcTx>;
export type StatusStep = RpcTx | 'pending' | null | Error;

export class ScriptedTransport implements ChainTransport {
  readonly contractId = 'policy.test.near';
  prepared: PreparedTx[] = [];
  sent: PreparedTx[] = [];
  viewCalls: { method: string; args: Record<string, unknown> }[] = [];
  statusCalls = 0;
  /** raw `get_request` answers by request id (a missing key answers null) */
  views = new Map<string, unknown>();
  /** answers of every other view, by method; a function gets the args */
  answers = new Map<string, unknown | ((args: Record<string, unknown>) => unknown)>();
  /** one step per submit call, consumed in order */
  submitSteps: SubmitStep[] = [];
  /** one step per txStatus call, consumed in order; the last repeats; an empty script answers null */
  statusSteps: StatusStep[] = [];
  nanos = '1800000000123456789';
  lastArgs: Record<string, unknown> | null = null;

  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    this.viewCalls.push({ method, args });
    if (method === 'get_request') {
      const id = args.id;
      return typeof id === 'string' && this.views.has(id) ? this.views.get(id) : null;
    }
    const answer = this.answers.get(method);
    if (typeof answer === 'function') return (answer as (a: Record<string, unknown>) => unknown)(args);
    if (answer === undefined) throw new Error(`no scripted answer for ${method}`);
    return answer;
  }

  async prepare(_method: 'submit_batch', args: Record<string, unknown>): Promise<PreparedTx> {
    this.lastArgs = args;
    const n = this.prepared.length + 1;
    const tx = { hash: `HASH${n}`, signed: { n } };
    this.prepared.push(tx);
    return tx;
  }

  async submit(tx: PreparedTx): Promise<RpcTx> {
    this.sent.push(tx);
    const step = this.submitSteps.shift();
    if (step === undefined) throw new Error('no scripted submit step left');
    return step(tx);
  }

  async txStatus(): Promise<RpcTx | 'pending' | null> {
    this.statusCalls += 1;
    const step = this.statusSteps.length > 1 ? this.statusSteps.shift() : this.statusSteps[0];
    if (step === undefined) return null;
    if (step instanceof Error) throw step;
    return step;
  }

  async blockNanosec(): Promise<string> {
    return this.nanos;
  }
}

export const task: OwnerTask = vectorTask();
export const AGENT = 'agent.test.near';
export const sig = new Uint8Array(64).fill(7);

/** A valid request of the vector task: NEAR asset, book payee label, Owner amount and pc. */
export function req(index: number, over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    task_id: task.task_id,
    action_index: index,
    asset: 'near',
    payee: 'near:accountant.test.near',
    amount: '1000000000000000000000000',
    labels: { recipient: 2, amount: 1, pc: 1 },
    evm: null,
    hints: { plan_hash: task.plan_sha256, trace_digest: '0'.repeat(64) },
    ...over,
  };
}

export const idOf = (index: number): string => requestId(task, index);

/** The raw `get_request` answer of a stored request, as the contract writes it (None fields left out). */
export function rawView(r: ActionRequest, state = 'Executing', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: idOf(r.action_index),
    id: null,
    state,
    agent: AGENT,
    task_id: r.task_id,
    asset: r.asset,
    payee: r.payee,
    amount: r.amount,
    labels: r.labels,
    created_ms: '1800000000000',
    ...extra,
  };
}

export function allowedOutcome(index: number): Record<string, unknown> {
  return { request_id: idOf(index), outcome: 'allowed', reason: null, pending_id: null };
}

export function okTx(indexes: number[], hash = 'HASH1'): RpcTx {
  return { hash, returnValue: indexes.map(allowedOutcome), logs: [], failure: null };
}

export function failTx(text: string, hash = 'HASH1'): RpcTx {
  return { hash, returnValue: undefined, logs: [], failure: text };
}

/** A client over the double with the poll times the unit tests use. */
export function clientOver(transport: ChainTransport): ChainClient {
  return new ChainClient({ network: 'testnet', contractId: 'policy.test.near', agentAccountId: AGENT, transport, pollMs: 5, windowMs: 100 });
}

/** Shows the requests as stored (the batch executed even though the reply was lost). */
export function storeAll(t: ScriptedTransport, reqs: ActionRequest[], state = 'Executing'): void {
  for (const r of reqs) t.views.set(idOf(r.action_index), rawView(r, state));
}

export const transportError = (): Error => new TypeError('fetch failed');

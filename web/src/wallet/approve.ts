// Approve and reject through the connected wallet (AIR-182): one transaction to the policy contract with exactly one FunctionCall action
// and exactly 1 yoctoNEAR. The arguments are the object `approveArgs` built from the stored request, so the five values the wallet shows are
// the five values the card shows. The failure counter and the state machine are AIR-181's cardReducer; this file only maps results.
import type { RequestState, RequestView } from '@airlock/runtime/chain-types';
import type { NearWalletBase } from '@hot-labs/near-connect';
import type { ApproveArgs, ApproveResult } from '../approvals/Card.tsx';
import type { RememberArgs } from '../approvals/cardModel.ts';
import { waitForRequest } from './status.ts';

export const APPROVE_PREPAID_TGAS = 65;
export const REJECT_PREPAID_TGAS = 30;

const TGAS = 1_000_000_000_000n;
const APPROVED: ReadonlySet<RequestState> = new Set<RequestState>(['Executing', 'Executed', 'Retryable', 'Failed']);
const REJECTED: ReadonlySet<RequestState> = new Set<RequestState>(['Rejected']);
const CONTRACT_REFUSAL = /(?:approve|remember) rejected: ([A-Za-z:]{1,40})/;
const UI_TIMEOUT_MS = 120_000;

export type ApproveDeps = {
  wallet(): Promise<Pick<NearWalletBase, 'signAndSendTransaction'>>;
  contractId: string;
  read: (id: string) => Promise<RequestView | null>;
  /** tests only: how long to wait for the wallet (default 120000) and for the chain (60000), and the poll interval (1000) */
  uiTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollMs?: number;
};

/** `signAndSendTransaction` is typed with a `FinalExecutionOutcome` that is not installed, so it is `any` at compile time: read it narrowed. */
type Outcome = { status?: unknown; transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } };

type Call = { receiverId?: string; signerId?: unknown; actions: unknown[] };

/** Throws unless `call` is exactly one FunctionCall of approve, approve_and_remember or reject with a plain object for args, 1 yoctoNEAR and no signerId. */
export function assertOneAction(call: Call): void {
  if (call.signerId !== undefined) throw new Error('a signerId is not allowed');
  if (call.actions.length !== 1) throw new Error('exactly one action is allowed');
  const a = call.actions[0] as { type?: unknown; params?: { methodName?: unknown; args?: unknown; gas?: unknown; deposit?: unknown } };
  if (a.type !== 'FunctionCall') throw new Error('the action is not a FunctionCall');
  const p = a.params;
  if (p === undefined || (p.methodName !== 'approve' && p.methodName !== 'approve_and_remember' && p.methodName !== 'reject')) throw new Error('the method is not approve, approve_and_remember or reject');
  if (p.deposit !== '1') throw new Error('the deposit is not exactly 1 yoctoNEAR');
  if (typeof p.gas !== 'string' || !/^[1-9][0-9]*$/.test(p.gas)) throw new Error('the gas is not a decimal string');
  if (typeof p.args !== 'object' || p.args === null || Array.isArray(p.args) || ArrayBuffer.isView(p.args)) throw new Error('args is not a plain object');
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : '');

function refusalName(text: string): string | null {
  return CONTRACT_REFUSAL.exec(text)?.[1] ?? null;
}

/** The failure text of an outcome whose `status.Failure` is set, as JSON text; null for a success or a shape that has none. */
function failureText(o: Outcome | null | undefined): string | null {
  const status = o?.status;
  if (typeof status !== 'object' || status === null || !('Failure' in status)) return null;
  try {
    return JSON.stringify((status as { Failure: unknown }).Failure) ?? '';
  } catch {
    return '';
  }
}

function txOf(o: Outcome | null | undefined): string {
  if (typeof o?.transaction?.hash === 'string') return o.transaction.hash;
  if (typeof o?.transaction_outcome?.id === 'string') return o.transaction_outcome.id;
  return '';
}

class UiTimeout extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UiTimeout()), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function makeApprove(deps: ApproveDeps): {
  approve(a: ApproveArgs): Promise<ApproveResult>;
  approveAndRemember(a: RememberArgs): Promise<ApproveResult>;
  reject(id: string): Promise<ApproveResult>;
} {
  async function send(methodName: 'approve' | 'approve_and_remember' | 'reject', args: Record<string, string>, tgas: number, id: string, until: ReadonlySet<RequestState>): Promise<ApproveResult> {
    const call = {
      receiverId: deps.contractId,
      actions: [{ type: 'FunctionCall' as const, params: { methodName, args, gas: (BigInt(tgas) * TGAS).toString(), deposit: '1' } }],
    };
    assertOneAction(call);
    let outcome: Outcome | null | undefined;
    try {
      const wallet = await deps.wallet();
      outcome = (await withTimeout(wallet.signAndSendTransaction(call), deps.uiTimeoutMs ?? UI_TIMEOUT_MS)) as Outcome | null | undefined;
    } catch (e) {
      if (e instanceof UiTimeout) return { ok: false, kind: 'wallet', name: 'timeout' };
      const text = errorText(e);
      const name = refusalName(text);
      if (name !== null) return { ok: false, kind: 'contract', name };
      if (text.includes('Iframe not loaded')) return { ok: false, kind: 'wallet', name: 'cancelled' };
      return { ok: false, kind: 'wallet' };
    }
    const failure = failureText(outcome);
    if (failure !== null) {
      const name = refusalName(failure);
      return name !== null ? { ok: false, kind: 'contract', name } : { ok: false, kind: 'wallet' };
    }
    const reached = await waitForRequest(deps.read, id, until, { timeoutMs: deps.pollTimeoutMs, pollMs: deps.pollMs });
    if (reached === null) return { ok: false, kind: 'wallet' };
    return { ok: true, tx: txOf(outcome) };
  }

  return {
    approve: (a) => send('approve', { id: a.id, to: a.to, asset: a.asset, amount: a.amount, why: a.why, book: a.book }, APPROVE_PREPAID_TGAS, a.id, APPROVED),
    approveAndRemember: (a) =>
      send(
        'approve_and_remember',
        { id: a.id, to: a.to, asset: a.asset, amount: a.amount, why: a.why, book: a.book, cap: a.cap, daily_limit: a.daily_limit, label: a.label },
        APPROVE_PREPAID_TGAS,
        a.id,
        APPROVED,
      ),
    reject: (id) => send('reject', { id }, REJECT_PREPAID_TGAS, id, REJECTED),
  };
}

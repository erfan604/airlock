// Request status from the chain, through the console's own RPC (AIR-183's rpcView), never through the runtime.
import { parseRequestView } from '@airlock/runtime/chain-types';
import type { RequestState, RequestView } from '@airlock/runtime/chain-types';
import { NEAR_RPC } from '../../csp.ts';
import { rpcView } from '../chain/rpc.ts';
import { keep, keepOrNull, fits } from '../components/chainText.ts';

/**
 * A request view under the display rule (components/chainText.ts): /approvals reads whatever contract `?policy=` names, so every string of the
 * view is kept only in its grammar, else as a placeholder with its length; a display line that is not a symbol and a decimal is dropped.
 */
export function shownView(v: RequestView): RequestView {
  const display = v.display !== null && fits('symbol', v.display.asset_symbol) && fits('decimal', v.display.amount_decimal) ? v.display : null;
  return {
    ...v,
    request_id: keep('request', v.request_id),
    id: v.id === null ? null : /^[0-9]{1,10}$/.test(v.id) ? v.id : keep('amount', v.id),
    agent: v.tombstone === true && v.agent === '' ? v.agent : keep('account', v.agent),
    task_id: v.tombstone === true && v.task_id === '' ? v.task_id : keep('task', v.task_id),
    asset: v.tombstone === true && v.asset === '' ? v.asset : keep('asset', v.asset),
    payee: v.tombstone === true && v.payee === '' ? v.payee : keep('payee', v.payee),
    reason: keepOrNull('reason', v.reason),
    book_status: keepOrNull('word', v.book_status),
    display,
    digest: v.digest === null || /^[0-9a-f]{64}$/.test(v.digest) ? v.digest : null,
  };
}

export type StatusConfig = { contractId: string; rpcUrls: readonly string[]; fetch?: typeof fetch };

/** `get_request` by pending number or request id; null when nothing is stored. */
export function rpcGetRequest(cfg: StatusConfig): (id: string) => Promise<RequestView | null> {
  const view = rpcView(cfg);
  return async (id) => {
    const v = parseRequestView(await view('get_request', { id }));
    return v === null ? null : shownView(v);
  };
}

/** `get_pending` at its page cap (20), as parsed views. */
export function rpcGetPending(cfg: StatusConfig): () => Promise<RequestView[]> {
  const view = rpcView(cfg);
  return async () => {
    const rows = await view('get_pending', { from_index: 0, limit: 20 });
    if (!Array.isArray(rows)) throw new Error('get_pending is not a list');
    const out: RequestView[] = [];
    for (const raw of rows) {
      const v = parseRequestView(raw);
      if (v !== null) out.push(shownView(v));
    }
    return out;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Reads until the request is in one of `until`. A read that throws is a transient RPC failure and is tried again. Null on timeout
 * (default 60000 ms, polled every 1000 ms).
 */
export async function waitForRequest(
  read: (id: string) => Promise<RequestView | null>,
  id: string,
  until: ReadonlySet<RequestState>,
  o: { timeoutMs?: number; pollMs?: number } = {},
): Promise<RequestView | null> {
  const timeoutMs = o.timeoutMs ?? 60_000;
  const pollMs = o.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await read(id);
      if (v !== null && until.has(v.state)) return v;
    } catch {
      // try again until the deadline
    }
    if (Date.now() + pollMs > deadline) return null;
    await sleep(pollMs);
  }
}

type Env = Record<string, string | undefined>;

/** `VITE_CONTRACT_ID` (the variable AIR-185 reads too) and the NEAR testnet nodes of plan/STACK.md section RPC, in order. */
export function walletConfig(env: Env = import.meta.env as Env): { contractId: string; rpcUrls: string[] } {
  const contractId = env.VITE_CONTRACT_ID;
  if (contractId === undefined || contractId === '') throw new Error('VITE_CONTRACT_ID is not set');
  return { contractId, rpcUrls: [...NEAR_RPC] };
}

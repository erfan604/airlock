// Request status from the chain, through the console's own RPC (AIR-183's rpcView), never through the runtime.
import { parseRequestView } from '@airlock/runtime/chain-types';
import type { RequestState, RequestView } from '@airlock/runtime/chain-types';
import { NEAR_RPC } from '../../csp.ts';
import { rpcView } from '../chain/rpc.ts';

export type StatusConfig = { contractId: string; rpcUrls: readonly string[]; fetch?: typeof fetch };

/** `get_request` by pending number or request id; null when nothing is stored. */
export function rpcGetRequest(cfg: StatusConfig): (id: string) => Promise<RequestView | null> {
  const view = rpcView(cfg);
  return async (id) => parseRequestView(await view('get_request', { id }));
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
      if (v !== null) out.push(v);
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

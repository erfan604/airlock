// AIR-166: the one place that turns a failure of the live path into advice. Every message is a fixed string from the table below: it never
// contains tool output, a node's text, a key, a signature or a hash, so printing it can leak nothing. `retryable` means "a whole fresh case
// is safe": the failure happened where nothing can have been paid (the signer refused and the contract refunded, or the network was down
// before any request existed). A lost response is never retryable: the first request may still land, and a second task would pay twice.
import { ChainError, ChainWaitError } from '../../runtime/src/chain/errors.ts';
import { EvmBroadcastError } from '../../runtime/src/chain/evm.ts';

export type FlakeClass =
  | 'mpc_timeout'
  | 'mpc_failed'
  | 'rpc_down'
  | 'lost_response'
  | 'nonce_low'
  | 'underpriced'
  | 'insufficient_funds'
  | 'replay_mismatch'
  | 'budget_exhausted'
  | 'unknown';

export interface Flake {
  class: FlakeClass;
  plain: string;
  retryable: boolean;
  next: string;
}

/** The untrusted budget of the payee for the UTC day cannot cover a case that expected `allowed` (thrown by the e2e script). */
export class BudgetExhaustedError extends Error {
  constructor() {
    super('the payee untrusted budget for today is below the amount');
    this.name = 'BudgetExhaustedError';
  }
}

/** What the e2e script throws after `runTask` ended in `error` events: the codes of those events, and the raw error when one was thrown. */
export interface RunFailureLike {
  runErrors: ReadonlyArray<{ code: string; retryable?: boolean | undefined }>;
  cause?: unknown;
}

const isRunFailureLike = (e: unknown): e is RunFailureLike => typeof e === 'object' && e !== null && Array.isArray((e as { runErrors?: unknown }).runErrors);

const TABLE: Record<FlakeClass, { plain: string; retryable: boolean; next: string }> = {
  mpc_timeout: {
    plain: 'The signer did not answer. Nothing was paid and nothing was spent.',
    retryable: true,
    next: 'Check python3 scripts/signer-weather.py, then run the case again as a new task. If the weather stays bad, use the recorded run.',
  },
  mpc_failed: {
    plain: 'The signer failed for this request. Nothing was paid.',
    retryable: false,
    next: 'The request cannot be retried. Start a new task once the signer weather is good.',
  },
  rpc_down: {
    plain: 'No network node answered. Nothing was confirmed.',
    retryable: true,
    next: 'Wait a minute and run the preflight (pnpm tsx scripts/preflight.ts) before starting again.',
  },
  lost_response: {
    plain: 'The network did not confirm the request. It may or may not have gone through.',
    retryable: false,
    next: 'Read the request with get_request on its id and look at the explorer. Do not start a new task until you know.',
  },
  nonce_low: {
    plain: 'The chain is ahead of the contract on the payment counter.',
    retryable: false,
    next: 'pnpm tsx scripts/nonce-status.ts prints the owner command that sets the counter.',
  },
  underpriced: {
    plain: 'The network refused the payment because its fee is too low. The fee is fixed when the request is made.',
    retryable: false,
    next: 'Raise max_fee_per_gas of the asset with asset_set, then start a new task.',
  },
  insufficient_funds: {
    plain: 'The payment address does not hold enough to pay and cover the fee.',
    retryable: false,
    next: 'Fund the derived address on Base Sepolia, then run pnpm tsx scripts/preflight.ts.',
  },
  replay_mismatch: {
    plain: 'The contract holds a different request under this id. This is a bug, not a flake.',
    retryable: false,
    next: 'Stop. Compare the stored request with the one the script built, and do not retry.',
  },
  budget_exhausted: {
    plain: "Today's untrusted budget for this payee is used up, so the payment was held instead of paid.",
    retryable: false,
    next: "Wait for the next UTC day, or raise the payee's daily_untrusted_budget in the book.",
  },
  unknown: {
    plain: 'The run failed for a reason this script does not know. Nothing is known to have been paid.',
    retryable: false,
    next: 'Read the lines above, check get_request and the explorer, and do not start a second task until you know.',
  },
};

const make = (c: FlakeClass, retryable?: boolean): Flake => {
  const row = TABLE[c];
  return { class: c, plain: row.plain, retryable: retryable ?? row.retryable, next: row.next };
};

const TRANSPORT_TEXT = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|HTTP 5\d\d|retries exceeded|timed out|timeout|network/i;

/** A failure of the network itself (a refused connection, a timeout, a 5xx), as `RpcPool` rethrows it after every URL failed. */
export function isTransportError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e instanceof ChainError || e instanceof ChainWaitError || e instanceof EvmBroadcastError) return false;
  if (e instanceof TypeError || e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'ProviderError') return true;
  return TRANSPORT_TEXT.test(e.message);
}

function ofBroadcast(e: EvmBroadcastError): Flake {
  if (e.code === 'NoRpc') return make('rpc_down');
  if (e.code === 'Timeout') return make('lost_response');
  const text = e.message.toLowerCase();
  if (text.includes('nonce too low')) return make('nonce_low');
  if (text.includes('underpriced')) return make('underpriced');
  if (text.includes('insufficient funds')) return make('insufficient_funds');
  return make('unknown');
}

function ofWait(e: ChainWaitError): Flake {
  if (e.code === 'Failed') {
    if (e.retryable && e.reason !== 'MpcBadResponse') return make('mpc_timeout');
    return make('mpc_failed');
  }
  // the clock ran out while the request was still open: it may yet be signed, so a second task would risk a second payment
  if (e.code === 'Timeout') return make('mpc_timeout', false);
  return make('unknown');
}

/** The advice for one `error` event code of `runTask` (agent.ts `failureOf`): the node's text never reaches an event. */
function ofRunCode(code: string, retryable: boolean | undefined): Flake {
  switch (code) {
    case 'Failed':
      return retryable === true ? make('mpc_timeout') : make('mpc_failed');
    case 'Timeout':
      return make('mpc_timeout', false);
    case 'Unknown':
    case 'BroadcastTimeout':
      return make('lost_response');
    case 'ReplayMismatch':
      return make('replay_mismatch');
    case 'BroadcastNoRpc':
      return make('rpc_down');
    default:
      return make('unknown');
  }
}

/** Never throws. The class, a plain sentence, whether a whole fresh case is safe, and the next step. All fixed strings. */
export function describeFailure(e: unknown): Flake {
  if (e instanceof BudgetExhaustedError) return make('budget_exhausted');
  if (isRunFailureLike(e)) {
    if (e.cause !== undefined) {
      const inner = describeFailure(e.cause);
      if (inner.class !== 'unknown') return inner;
    }
    const first = e.runErrors[0];
    return first === undefined ? make('unknown') : ofRunCode(first.code, first.retryable);
  }
  if (e instanceof ChainWaitError) return ofWait(e);
  if (e instanceof ChainError) {
    if (e.code === 'Unknown') return make('lost_response');
    if (e.code === 'RequestMismatch') return make('replay_mismatch');
    return make('unknown');
  }
  if (e instanceof EvmBroadcastError) return ofBroadcast(e);
  if (isTransportError(e)) return make('rpc_down');
  return make('unknown');
}

/** The line `e2e-testnet.ts` and `golden.ts` print for a failure. */
export function flakeLine(f: Flake): string {
  return `FLAKE ${f.class}: ${f.plain} | next: ${f.next}`;
}

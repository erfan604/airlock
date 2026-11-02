// RpcPool: the failover the chain client uses instead of near-api-js 7.3.1's own failover provider (four measured defects: a race on
// its shared index on a cold client, 85 s on a 503 URL with the default options, every error turned into RetriesExceeded, console.error
// noise). One provider per URL. `run` carries reads and fails over only on a transport error; `send` carries the one transaction send
// of a batch, makes one HTTP attempt, and never fails over.
//
// near-api-js 7.3.1 `retries` is the total number of HTTP attempts for one call on one URL: only HTTP 500, 503 and 408 are retried,
// waiting `wait`, then `wait * backoff`, and so on; a refused connection (TypeError: fetch failed) and a 429 are thrown at once; after
// the last attempt the last error is thrown as is. So DEFAULT_RETRY costs a 503 URL 3 calls and 250 + 500 ms before the next URL.
import { JsonRpcProvider } from 'near-api-js';
import { RpcError } from 'near-api-js/rpc-errors';

export interface RetryOptions {
  retries: number;
  wait: number;
  backoff: number;
}

export const DEFAULT_RETRY: RetryOptions = { retries: 3, wait: 250, backoff: 2 };

const SINGLE_ATTEMPT: RetryOptions = { retries: 1, wait: 0, backoff: 1 };

/** NEAR testnet regular nodes in the order of plan/STACK.md section RPC (the one place that sets it). */
export const DEFAULT_RPC_URLS: readonly string[] = [
  'https://test.rpc.fastnear.com',
  'https://near-testnet.drpc.org',
  'https://testnet-rpc.intea.rs',
  'https://rpc.testnet.near.org',
];

export class RpcPool {
  readonly urls: readonly string[];
  private readonly readProviders: JsonRpcProvider[];
  private readonly sendProviders: JsonRpcProvider[];
  private preferred = 0;

  constructor(urls: readonly string[], retry: RetryOptions = DEFAULT_RETRY) {
    if (urls.length === 0) throw new RangeError('RpcPool needs at least one URL');
    this.urls = [...urls];
    this.readProviders = this.urls.map((url) => new JsonRpcProvider({ url }, retry));
    this.sendProviders = this.urls.map((url) => new JsonRpcProvider({ url }, SINGLE_ATTEMPT));
  }

  /**
   * Runs a read on the preferred URL (the last one that worked) and moves to the next URL only on a transport error, one that is not
   * an RpcError: a TypeError, the internal ProviderError of an HTTP 5xx, an abort. Every RpcError is a node's answer (a contract panic,
   * an unknown access key, a bad request) and is rethrown at once. After the last URL the last error is rethrown. Reads only: `op` may
   * run once per URL.
   */
  async run<T>(op: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
    const count = this.urls.length;
    const start = this.preferred;
    let last: unknown;
    for (let step = 0; step < count; step++) {
      const index = (start + step) % count;
      try {
        const result = await op(this.readProviders[index] as JsonRpcProvider);
        this.preferred = index;
        return result;
      } catch (error) {
        if (error instanceof RpcError) throw error;
        last = error;
      }
    }
    throw last;
  }

  /**
   * Runs `op` once on the preferred URL with a single-attempt provider (one `send_tx` request is exactly one HTTP request) and never
   * fails over. On a transport error the preferred URL moves to the next one for later calls and the error is rethrown: only the
   * caller decides about a resend.
   */
  async send<T>(op: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
    const index = this.preferred;
    try {
      return await op(this.sendProviders[index] as JsonRpcProvider);
    } catch (error) {
      if (!(error instanceof RpcError)) this.preferred = (index + 1) % this.urls.length;
      throw error;
    }
  }
}

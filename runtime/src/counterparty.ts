// AIR-304 (D27): the counterparty signal. For a payee that is NOT in the owner's book, the runtime looks the account up (NEAR: does it exist and
// did it exist a week ago; Base Sepolia: nonce, balance and code) and attaches a named note to the evidence of the request, which the approval
// card shows: `counterparty_new` (no history) or `counterparty_unverified` (the lookup failed, which fails closed).
//
// Why runtime-side and not an input of the verdict (decision in AIR-304 Notes): a new verdict input would change the Rust verdict, the Lean model
// and the 40,000 case differential, and an unbooked payee already never passes the gate (P3, harness p03; the contract answers NewRecipient or
// Block). The signal therefore can only add information to a request the contract already holds back. It never touches the verdict, never
// removes an escalation, never turns anything into an Allow, and a booked payee is never looked up. The note is not authenticated by the
// contract (like plan_hash and the evidence snippets): it is a hint for the owner, not a control.
import type { Book } from './interpreter/index.ts';

export type CounterpartyReason = 'counterparty_new' | 'counterparty_unverified';
export const COUNTERPARTY_REASONS: readonly CounterpartyReason[] = ['counterparty_new', 'counterparty_unverified'];

/** A closed code and a fixed-vocabulary detail; no text from outside is ever copied into it. */
export type CounterpartyNote = { reason: CounterpartyReason; detail: 'account_absent' | 'account_recent' | 'no_history' | 'lookup_failed' };

/** What a probe saw. `young` is a NEAR account that did not exist a week ago. */
export type NearSeen = 'absent' | 'young' | 'established';
export type EvmSeen = { nonce: bigint; balance: bigint; hasCode: boolean };

export interface CounterpartyProbe {
  nearAccount(accountId: string): Promise<NearSeen>;
  evmAddress(chainId: number, address: string): Promise<EvmSeen>;
}

export interface CounterpartyAssessor {
  /** The note for a payee key, or null when the payee is established. Never throws: a failed lookup is `counterparty_unverified`. */
  assess(payeeKey: string): Promise<CounterpartyNote | null>;
}

const NEAR_KEY = /^near:([a-z0-9._-]{2,64})$/;
const EVM_KEY = /^evm:(\d{1,10}):(0x[0-9a-f]{40})$/;

/** A positive answer is cached (an established account stays established); a note for a new account is cached for a short time, a failure never. */
export function createCounterparty(opts: { probe: CounterpartyProbe; now?: () => number; newTtlMs?: number; establishedTtlMs?: number }): CounterpartyAssessor {
  const now = opts.now ?? Date.now;
  const newTtl = opts.newTtlMs ?? 60_000;
  const estTtl = opts.establishedTtlMs ?? 3_600_000;
  const cache = new Map<string, { until: number; note: CounterpartyNote | null }>();
  return {
    async assess(payeeKey) {
      const hit = cache.get(payeeKey);
      if (hit !== undefined && hit.until > now()) return hit.note;
      let note: CounterpartyNote | null;
      try {
        note = await lookup(opts.probe, payeeKey);
      } catch {
        return { reason: 'counterparty_unverified', detail: 'lookup_failed' };
      }
      cache.set(payeeKey, { until: now() + (note === null ? estTtl : newTtl), note });
      return note;
    },
  };
}

async function lookup(probe: CounterpartyProbe, key: string): Promise<CounterpartyNote | null> {
  const near = NEAR_KEY.exec(key);
  if (near !== null) {
    const seen = await probe.nearAccount(near[1] as string);
    if (seen === 'absent') return { reason: 'counterparty_new', detail: 'account_absent' };
    if (seen === 'young') return { reason: 'counterparty_new', detail: 'account_recent' };
    return null;
  }
  const evm = EVM_KEY.exec(key);
  if (evm !== null) {
    const seen = await probe.evmAddress(Number(evm[1]), evm[2] as string);
    return seen.nonce === 0n && seen.balance === 0n && !seen.hasCode ? { reason: 'counterparty_new', detail: 'no_history' } : null;
  }
  // a key of a shape the lookup does not know is not vouched for
  return { reason: 'counterparty_unverified', detail: 'lookup_failed' };
}

/** True when the key is in the book (the book resolves a canonical key to itself); an unresolved key is treated as not booked, which only adds a lookup. */
export function isBooked(book: Book, payeeKey: string): boolean {
  return book.resolve(payeeKey) === payeeKey;
}

// ---- the real probe: plain JSON-RPC over fetch, reads only, no key ----

export const NEAR_BLOCKS_PER_DAY = 86_400; // testnet block time is about one second
export const NEAR_MIN_AGE_DAYS = 7;
export const ARCHIVAL_NEAR_TESTNET = 'https://archival-rpc.testnet.fastnear.com';

type Fetch = typeof fetch;

async function rpc(f: Fetch, url: string, method: string, params: unknown, timeoutMs: number): Promise<{ result?: any; error?: any }> {
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('http ' + res.status);
  return (await res.json()) as { result?: any; error?: any };
}

const isUnknownAccount = (body: { result?: any; error?: any }): boolean => {
  const cause = body.error?.cause?.name;
  if (cause === 'UNKNOWN_ACCOUNT') return true;
  const r = body.result?.error;
  return typeof r === 'string' && r.includes('does not exist');
};

/** Reads in order of the URL lists; the first answer wins, a transport error moves on, all failing throws. */
export function httpProbe(cfg: { nearUrls: readonly string[]; archivalUrl?: string; evmUrls: Record<number, readonly string[]>; fetch?: Fetch; timeoutMs?: number }): CounterpartyProbe {
  const f = cfg.fetch ?? fetch;
  const timeout = cfg.timeoutMs ?? 5000;
  const first = async <T>(urls: readonly string[], run: (u: string) => Promise<T>): Promise<T> => {
    let last: unknown = new Error('no url');
    for (const u of urls) {
      try {
        return await run(u);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
  return {
    async nearAccount(accountId) {
      const now = await first(cfg.nearUrls, (u) => rpc(f, u, 'query', { request_type: 'view_account', finality: 'final', account_id: accountId }, timeout));
      if (isUnknownAccount(now)) return 'absent';
      const height = now.result?.block_height;
      if (typeof height !== 'number') throw new Error('no block height');
      const old = await rpc(f, cfg.archivalUrl ?? ARCHIVAL_NEAR_TESTNET, 'query', { request_type: 'view_account', block_id: Math.max(1, height - NEAR_MIN_AGE_DAYS * NEAR_BLOCKS_PER_DAY), account_id: accountId }, timeout);
      if (isUnknownAccount(old)) return 'young';
      if (old.result?.amount === undefined) throw new Error('archival answer without an account');
      return 'established';
    },
    async evmAddress(chainId, address) {
      const urls = cfg.evmUrls[chainId];
      if (urls === undefined) throw new Error('no RPC for chain ' + chainId);
      const call = async (method: string, tag: string): Promise<string> => {
        const body = await first(urls, (u) => rpc(f, u, method, [address, tag], timeout));
        if (typeof body.result !== 'string') throw new Error('bad result');
        return body.result;
      };
      const [nonce, balance, code] = await Promise.all([call('eth_getTransactionCount', 'latest'), call('eth_getBalance', 'latest'), call('eth_getCode', 'latest')]);
      return { nonce: BigInt(nonce), balance: BigInt(balance), hasCode: code !== '0x' };
    },
  };
}

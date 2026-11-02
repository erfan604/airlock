// The console's own chain reads (AIR-185), never routed through the runtime: the contract is the one source of the book, the asset
// registry, the policy limits, the task key and the time. Built on the shared JSON-RPC client of AIR-183 (rpc.ts), so failover and
// result decoding live there. No number parsing: the block time is a digit string divided with BigInt.
import type { AssetEntryViewJson } from '@airlock/runtime/analyze';
import type { BookRows } from '@airlock/runtime/dsl';
import { RpcError, rpcCall, rpcView } from './rpc.ts';

export type AssetRows = ReadonlyArray<readonly [string, AssetEntryViewJson]>;
export type PolicyFlags = { flags: { max_task_actions: number; max_task_ttl_ms: string } };

export interface ChainReads {
  getBook(): Promise<BookRows>;
  listAssets(): Promise<AssetRows>;
  getPolicy(): Promise<PolicyFlags>;
  getTaskKey(): Promise<string | null>;
  latestBlockMs(): Promise<number>;
}

export type ChainSnapshot = { book: BookRows; assets: AssetRows; policy: PolicyFlags; taskKey: string | null; blockMs: number };

const PAGE = 50;
const NANOS_PER_MS = 1_000_000n;

export function rpcChainReads(cfg: { contractId: string; rpcUrls: readonly string[]; fetch?: typeof fetch }): ChainReads {
  const view = rpcView(cfg);
  return {
    async getBook() {
      const rows: [string, BookRows[number][1]][] = [];
      for (let from = 0; ; from += PAGE) {
        const page = await view('get_book', { from_index: from, limit: PAGE });
        if (!Array.isArray(page)) throw new RpcError('get_book is not a list');
        rows.push(...(page as [string, BookRows[number][1]][]));
        if (page.length < PAGE) return rows;
      }
    },
    async listAssets() {
      const rows = await view('list_assets', {});
      if (!Array.isArray(rows)) throw new RpcError('list_assets is not a list');
      return rows as AssetRows;
    },
    async getPolicy() {
      return (await view('get_policy', {})) as PolicyFlags;
    },
    async getTaskKey() {
      const key = await view('get_task_key', {});
      if (key !== null && typeof key !== 'string') throw new RpcError('get_task_key is not a string');
      return key;
    },
    async latestBlockMs() {
      const block = (await rpcCall(cfg, 'block', { finality: 'final' })) as { header?: { timestamp_nanosec?: unknown } } | null;
      const nanos = block?.header?.timestamp_nanosec;
      // the numeric header.timestamp is above 2^53 and loses digits, so only the string is read
      if (typeof nanos !== 'string' || !/^[0-9]{1,30}$/.test(nanos)) throw new RpcError('block has no timestamp_nanosec');
      // a millisecond count is a safe integer, and JSON.parse of its digits is the exact conversion with no float step
      return JSON.parse((BigInt(nanos) / NANOS_PER_MS).toString()) as number;
    },
  };
}

/** All five reads at once. */
export async function readSnapshot(reads: ChainReads): Promise<ChainSnapshot> {
  const [book, assets, policy, taskKey, blockMs] = await Promise.all([reads.getBook(), reads.listAssets(), reads.getPolicy(), reads.getTaskKey(), reads.latestBlockMs()]);
  return { book, assets, policy, taskKey, blockMs };
}

// AIR-350: the Base payments the pool has asked NEAR's MPC network about. `base-checks.json` only says where to look (a Base tx id, the NEAR
// transaction of its check and, when the card made the payment, the NEAR transaction of its request); every value shown is read from the pool's own `get_base_check` view. A null answer, a failed read or a malformed answer
// drops the entry. With an empty list no request is made.
import { rpcView } from '../chain/rpc.ts';
import { explorerTx } from '../approvals/staticChain.ts';
import list from './base-checks.json' with { type: 'json' };

export type BaseCheckEntry = { txId: string; nearTx: string; requestTx?: string };
export type BaseCheckRow = { txId: string; payloadHash: string; askedBy: string; recordedMs: number; nearTx: string; requestTx?: string };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX64_ANY = /^[0-9a-fA-F]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The committed list of checks to look up. */
export const BASE_CHECK_LIST: readonly BaseCheckEntry[] = parseBaseCheckList(list);

/** The Base Sepolia explorer page of a transaction id: only exactly 64 lowercase hex characters (no 0x), else null. */
export function explorerBaseTx(txId: string): string | null {
  return HEX64.test(txId) ? `https://sepolia.basescan.org/tx/0x${txId}` : null;
}

/** The well-formed entries of the list file, one per tx_id (the first). Anything else is dropped. */
export function parseBaseCheckList(raw: unknown): BaseCheckEntry[] {
  const checks = isObj(raw) && Array.isArray(raw['checks']) ? (raw['checks'] as unknown[]) : [];
  const out = new Map<string, BaseCheckEntry>();
  for (const c of checks) {
    if (!isObj(c)) continue;
    const txId = c['tx_id'];
    const nearTx = c['near_tx'];
    if (typeof txId !== 'string' || !HEX64.test(txId) || typeof nearTx !== 'string' || explorerTx(nearTx) === null || out.has(txId)) continue;
    const req = c['request_tx'];
    out.set(txId, typeof req === 'string' && explorerTx(req) !== null ? { txId, nearTx, requestTx: req } : { txId, nearTx });
  }
  return [...out.values()];
}

/** One `get_base_check` answer as a row, or null for null or anything malformed (including a tx_id other than the one asked for). */
export function baseCheckRowOf(entry: BaseCheckEntry, raw: unknown): BaseCheckRow | null {
  if (!isObj(raw)) return null;
  const { tx_id: txId, payload_hash: payloadHash, asked_by: askedBy, recorded_ms: recorded } = raw;
  if (txId !== entry.txId || typeof payloadHash !== 'string' || !HEX64_ANY.test(payloadHash) || typeof askedBy !== 'string' || askedBy === '') return null;
  if (typeof recorded !== 'string' || !/^[0-9]{1,15}$/.test(recorded)) return null;
  return { txId: entry.txId, payloadHash, askedBy, recordedMs: Number(recorded), nearTx: entry.nearTx, ...(entry.requestTx === undefined ? {} : { requestTx: entry.requestTx }) };
}

/** Reads every listed check from the pool's view; entries that fail or answer null are left out. Newest first by recorded_ms. */
export async function readBaseChecks(cfg: { pool: string; rpcUrls: readonly string[]; fetch?: typeof fetch }, entries: readonly BaseCheckEntry[] = BASE_CHECK_LIST): Promise<BaseCheckRow[]> {
  if (entries.length === 0) return [];
  const view = rpcView({ contractId: cfg.pool, rpcUrls: cfg.rpcUrls, ...(cfg.fetch === undefined ? {} : { fetch: cfg.fetch }) });
  const rows = await Promise.all(entries.map((e) => view('get_base_check', { tx_id: e.txId }).then((raw) => baseCheckRowOf(e, raw), () => null)));
  return rows.filter((r): r is BaseCheckRow => r !== null).sort((a, b) => b.recordedMs - a.recordedMs);
}

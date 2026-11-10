// AIR-350: the Base payments the pool has asked NEAR's MPC network about. Each `base_payment_checked` event of the pool carries the Base
// transaction id, the hash of the signed answer and the account that asked; the page lists them. `base_payment_unchecked` stores nothing and is ignored.
import type { PoolEvent } from '../lender/lenders.ts';

export type BaseCheckRow = { txId: string; payloadHash: string; askedBy: string; atMs: number; nearTx: string };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX64_ANY = /^[0-9a-fA-F]{64}$/;

/** The Base Sepolia explorer page of a transaction id: only exactly 64 lowercase hex characters (no 0x), else null. */
export function explorerBaseTx(txId: string): string | null {
  return HEX64.test(txId) ? `https://sepolia.basescan.org/tx/0x${txId}` : null;
}

/** The well-formed `base_payment_checked` events as rows, one per Base transaction (the earliest answer), newest first. */
export function baseChecksOf(events: readonly PoolEvent[]): BaseCheckRow[] {
  const byTx = new Map<string, BaseCheckRow>();
  for (const e of events) {
    if (e.event !== 'base_payment_checked') continue;
    const { tx_id: txId, payload_hash: payloadHash, asked_by: askedBy } = e.data;
    if (typeof txId !== 'string' || !HEX64.test(txId) || typeof payloadHash !== 'string' || !HEX64_ANY.test(payloadHash) || typeof askedBy !== 'string') continue;
    const row: BaseCheckRow = { txId, payloadHash, askedBy, atMs: e.atMs, nearTx: e.tx };
    const have = byTx.get(txId);
    if (have === undefined || row.atMs < have.atMs) byTx.set(txId, row);
  }
  return [...byTx.values()].sort((a, b) => b.atMs - a.atMs);
}

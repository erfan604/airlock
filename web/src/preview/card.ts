// The text of the task card (AIR-185). It is decoded from the exact bytes the owner key signs and nothing else: there is no second path that
// produces card text, so the card cannot say anything the contract will not verify.
import type { AssetRegistry } from '@airlock/runtime/analyze';
import { assetForPayeeKey, decodeOwnerTask } from '@airlock/runtime/dsl';
import { formatBaseUnits } from '@airlock/runtime/money';

export type CardLine = { label: string; value: string };

export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardError';
  }
}

/** `YYYY-MM-DD HH:MM:SS UTC` from a millisecond timestamp. */
function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** Throws TaskError for bytes that are not a task and CardError for a bound whose asset the registry does not hold. */
export function renderTaskCard(bytes: Uint8Array, registry: AssetRegistry): CardLine[] {
  const t = decodeOwnerTask(bytes);
  const lines: CardLine[] = [
    { label: 'Agent', value: t.agent_id },
    { label: 'Contract', value: t.contract_id },
    { label: 'Plan', value: t.plan_sha256.slice(0, 12) },
    { label: 'Valid until', value: utc(t.expires_ms) },
    { label: 'Max payments', value: String(t.max_actions) },
  ];
  for (const b of t.bounds) {
    const assetId = assetForPayeeKey(b.payee_key);
    const asset = registry.get(assetId);
    if (asset === undefined) throw new CardError('asset is not in the registry');
    lines.push({ label: 'Pay up to', value: `${formatBaseUnits(BigInt(b.max_total), asset.decimals)} ${asset.symbol} to ${b.payee_key}` });
    lines.push({ label: 'Asset id', value: assetId });
  }
  return lines;
}

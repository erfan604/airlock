// The baselines V0, V1 and V1-tight (AIR-220): the vanilla twin of AIR-146 with the ledger signer of the bench. Each payment the agent
// attempts becomes a PaymentFact in run.ts: ALLOW when the signer executed it, BLOCK with reason `policy` when the V1 wrapper refused it.
import { LedgerSigner } from '../agents/signers.ts';
import type { SimWorld } from '../oracles/index.ts';
import { benchAssets } from './assets.ts';
import { BENCH_T0_MS } from './task.ts';

/** The signer behind V0, V1 and V1-tight: it moves value in the SimWorld the oracle reads, with the decimals of assets.json. */
export function ledgerSignerFor(world: SimWorld): LedgerSigner {
  return new LedgerSigner(world, { nowMs: BENCH_T0_MS, decimalsOf: (asset) => benchAssets().decimalsOf(asset) });
}

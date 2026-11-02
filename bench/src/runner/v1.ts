// The V1 baseline rule of the bench (AIR-224, SPEC R5-17): an allowlist and origin-blind limits that equal AIRLOCK's own numbers, so V1 is
// the strongest policy a wallet can state without provenance. `bench/policy/v1.json` names which book field is the per-payee limit: V1 uses
// the entry's daily_limit, V1-tight its cap and falls back to daily_limit when the cap is null. The asset limits are the hard cap and the
// daily cap of assets.json. The rule is not keyed to the legitimate amount of a case (a rule chosen so that V1 loses would be a strawman).
// Amounts are bigint, converted with toBaseUnits through `bookRowsOf` and the asset registry; there is no clock and no model.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BENCH_ROOT, benchAssets } from './assets.ts';
import { bookRowsOf } from './cases.ts';
import type { CaseWorld } from './cases.ts';

/** The shape of AIR-146's `V1Policy`, written out here so this module does not wait for it (AIR-220 passes it to `withContentPolicy`). */
export interface V1PolicyData {
  allow: ReadonlySet<string>;
  perTxLimit: ReadonlyMap<string, bigint>;
  assetLimits: Record<string, { hardCap: bigint; dailyCap: bigint }>;
}

export type V1Variant = 'V1' | 'V1-tight';

const RuleFile = z.strictObject({
  rule: z.string(),
  payee_limit: z.strictObject({ V1: z.literal('daily_limit'), 'V1-tight': z.literal('cap') }),
});

let rule: z.infer<typeof RuleFile> | undefined;

function readRule(): z.infer<typeof RuleFile> {
  rule ??= RuleFile.parse(JSON.parse(readFileSync(join(BENCH_ROOT, 'policy', 'v1.json'), 'utf8')));
  return rule;
}

/**
 * The V1 policy of a case world: the allowlist is the book keys, the per-payee limit of each is the book field `bench/policy/v1.json`
 * names for `variant` (a null cap under V1-tight falls back to daily_limit), and the asset limits are those of assets.json.
 */
export function v1PolicyFor(world: CaseWorld, variant: V1Variant): V1PolicyData {
  const field = readRule().payee_limit[variant];
  const allow = new Set<string>();
  const perTxLimit = new Map<string, bigint>();
  for (const [key, row] of bookRowsOf(world)) {
    allow.add(key);
    const limit = field === 'cap' && row.cap !== null ? row.cap : row.daily_limit;
    perTxLimit.set(key, BigInt(limit));
  }
  const assetLimits: V1PolicyData['assetLimits'] = {};
  for (const [id, a] of benchAssets().rows) assetLimits[id] = { hardCap: BigInt(a.hard_cap), dailyCap: BigInt(a.daily_cap) };
  return { allow, perTxLimit, assetLimits };
}

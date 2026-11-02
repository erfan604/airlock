// The asset registry of the bench (AIR-277): bench/policy/assets.json read once, converted to base units with toBaseUnits, and handed out in
// the three shapes the bench needs: the `list_assets` rows (AnalyzeCtx and the CLI setup), the decimals lookup (interpreter and oracles) and
// the task limits. Amounts are bigint or decimal strings end to end.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { registryFromRows } from '@airlock/runtime/analyze';
import type { AnalyzeCtx, AssetEntryViewJson, AssetRegistry } from '@airlock/runtime/analyze';
import { toBaseUnits } from '@airlock/runtime/money';

/** The folder that holds `fixtures/` and `policy/`: the real `bench/` directory. */
export const BENCH_ROOT = join(import.meta.dirname, '..', '..');

const Decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
const Integer = z.string().regex(/^(0|[1-9][0-9]*)$/);

const AssetsFile = z.strictObject({
  note: z.string().optional(),
  assets: z.record(
    z.string(),
    z.strictObject({
      symbol: z.string(),
      decimals: z.int().min(0).max(38),
      hard_cap: Decimal,
      daily_cap: Decimal,
      quick_task_cap: Decimal,
      max_fee_per_gas: Integer,
      max_gas: Integer,
      path: z.string().nullable(),
    }),
  ),
  limits: z.strictObject({ maxTaskActions: z.int().min(1).max(255), maxTaskTtlMs: z.int().min(1) }),
});

export interface BenchAssets {
  /** `list_assets` rows, u128 values as decimal strings in base units. */
  rows: ReadonlyArray<readonly [string, AssetEntryViewJson]>;
  registry: AssetRegistry;
  limits: AnalyzeCtx['limits'];
  /** The decimals of a registered asset, undefined for any other (the `decimalsOf` of RunDeps). */
  decimalsOf(asset: string): number | undefined;
}

/** Reads and converts an assets file. A file that does not parse is an error naming the zod issue paths, never a repaired value. */
export function loadAssets(path: string): BenchAssets {
  const parsed = AssetsFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`assets file ${path}: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const rows: Array<readonly [string, AssetEntryViewJson]> = Object.entries(parsed.data.assets).map(([id, a]) => [
    id,
    {
      symbol: a.symbol,
      decimals: a.decimals,
      hard_cap: toBaseUnits(a.hard_cap, a.decimals).toString(),
      daily_cap: toBaseUnits(a.daily_cap, a.decimals).toString(),
      max_fee_per_gas: a.max_fee_per_gas,
      max_gas: a.max_gas,
      quick_task_cap: toBaseUnits(a.quick_task_cap, a.decimals).toString(),
      path: a.path,
    },
  ]);
  const registry = registryFromRows(rows);
  return {
    rows,
    registry,
    limits: { maxTaskActions: parsed.data.limits.maxTaskActions, maxTaskTtlMs: BigInt(parsed.data.limits.maxTaskTtlMs) },
    decimalsOf: (asset) => registry.get(asset)?.decimals,
  };
}

let cached: BenchAssets | undefined;

/** The registry of `bench/policy/assets.json`, read once per process. */
export function benchAssets(): BenchAssets {
  cached ??= loadAssets(join(BENCH_ROOT, 'policy', 'assets.json'));
  return cached;
}

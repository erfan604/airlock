// The owner's task and the CLI setup of a bench case (AIR-277). The gate path and the runner (AIR-220) build the task one way: the analyzer's
// output on the reference plan, computed once from the A2 book. A1 (strict) shares that task and differs from A2 only in a null payee cap in
// the CLI setup, so a strict owner who cleared the caps still signs the same bounds. Every clock value is derived from BENCH_T0_MS.
import { createHash } from 'node:crypto';
import { bookFromRows, toOwnerBounds } from '@airlock/runtime/analyze';
import type { Analysis, AnalyzeCtx } from '@airlock/runtime/analyze';
import { TASK_TAG, planSha256 } from '@airlock/runtime/dsl';
import type { CheckedPlan, OwnerTask } from '@airlock/runtime/dsl';
import { benchAssets } from './assets.ts';
import type { CliSetup } from './backend.ts';
import { bookRowsOf } from './cases.ts';
import type { Case } from './cases.ts';

/** A UTC day start (20749 days after the epoch); every `now_ms` and `clock` of the bench is derived from it. */
export const BENCH_T0_MS = 20749 * 86_400_000;

/** The task lives one hour, the `maxTaskTtlMs` of assets.json. */
const TASK_TTL_MS = 3_600_000;

/** The analyzer context of a case: the owner's words, the case book (A2 caps), the asset registry and the task limits of assets.json. */
export function analyzeCtxFor(c: Case): AnalyzeCtx {
  const assets = benchAssets();
  return { ownerText: c.request, book: bookFromRows(bookRowsOf(c.world)), registry: assets.registry, limits: assets.limits };
}

/**
 * The task the owner signs for a case: `<case id>:<run>` as the id, the hash of the checked plan, the salted instruction hash of the
 * ASCII string `bench-` plus the request, one hour from BENCH_T0_MS, and the analyzer's bounds. The caller checks `analysis.errors` first:
 * a non-empty list is NO_TASK (the console would refuse to sign), and `toOwnerBounds` throws on it.
 */
export function benchTask(c: Case, run: number, plan: CheckedPlan, analysis: Analysis): OwnerTask {
  return {
    tag: TASK_TAG,
    task_id: `${c.id}:${run}`,
    contract_id: 'policy.test.near',
    agent_id: 'agent.test.near',
    plan_sha256: planSha256(plan),
    instruction_sha256_salted: createHash('sha256').update(`bench-${c.request}`, 'ascii').digest('hex'),
    issued_ms: BENCH_T0_MS,
    expires_ms: BENCH_T0_MS + TASK_TTL_MS,
    max_actions: analysis.maxActions,
    bounds: toOwnerBounds(analysis),
  };
}

/**
 * The `reset` setup of the verdict CLI for a case: the assets of assets.json in base units, the case book, the task's bounds under its id,
 * and not paused. Under A1 every payee `cap` is null; nothing else differs from A2.
 */
export function cliSetupFor(c: Case, config: 'A1' | 'A2', task: OwnerTask): CliSetup {
  const assets: CliSetup['assets'] = {};
  for (const [id, a] of benchAssets().rows) {
    assets[id] = { hard_cap: a.hard_cap, daily_cap: a.daily_cap, max_fee_per_gas: a.max_fee_per_gas, max_gas: a.max_gas };
  }
  const book: CliSetup['book'] = {};
  for (const [key, e] of bookRowsOf(c.world)) {
    book[key] = { cap: config === 'A1' ? null : e.cap, daily_untrusted_budget: e.daily_untrusted_budget, daily_limit: e.daily_limit };
  }
  const bounds: Record<string, string> = {};
  for (const b of task.bounds) bounds[b.payee_key] = b.max_total;
  return { assets, book, tasks: { [task.task_id]: { bounds } }, flags: { paused: false } };
}

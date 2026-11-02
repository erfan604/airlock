// Several runs of one gate plan in one session (AIR-289): the same attacker content delivered again and again to an owner who keeps asking for the same
// thing. One backend session is begun once, with one owner task per run (`<case id>:<k>`, all built from the reference plan of the case and all
// registered in the CLI setup), and the gate plan runs once per task at BENCH_T0_MS, so the ledgers of the verdict CLI and the simulated world carry
// over from run to run on one UTC day. Nothing here reads a clock, and nothing calls a model.
import { analyzePlan } from '@airlock/runtime/analyze';
import { checkPlan, resolveAlias } from '@airlock/runtime/dsl';
import type { ActionRequest } from '@airlock/runtime/dsl';
import { defaultToolArgPolicy, run } from '@airlock/runtime/interpreter';
import type { Book } from '@airlock/runtime/interpreter';
import { fixtureTools } from '@airlock/runtime/tools';
import { SimWorld, classify } from '../oracles/index.ts';
import { benchAssets } from '../runner/assets.ts';
import { VerdictCliBackend } from '../runner/backend.ts';
import type { PaymentClassifier } from '../runner/backend.ts';
import { bookRowsOf, worldOfCase } from '../runner/cases.ts';
import type { Case } from '../runner/cases.ts';
import { proposalToRequest, scriptedExtract, traceDigest } from '../runner/gate.ts';
import type { GateSeam } from '../runner/gate.ts';
import { BENCH_T0_MS, analyzeCtxFor, benchTask, cliSetupFor } from '../runner/task.ts';
import type { PaymentFact } from '../runner/types.ts';
import { tagOf } from '../scripts/check-cases.ts';

const BATCH = 3;
const NO_SIGNATURE = new Uint8Array(0);
const MAX_RUNS = 5;

/** The one tag of the payments classified attacker: `none` when there is none, the tag when all agree, the tags joined by a comma otherwise. */
export function attackerTag(payments: readonly PaymentFact[]): string {
  const tags = payments.filter((p) => p.attackerInfluenced).map(tagOf);
  const first = tags[0];
  return first === undefined ? 'none' : tags.every((t) => t === first) ? first : tags.join(',');
}

/**
 * Runs the gate plan of `c` `n` times (2 to 5; 1 is allowed for a test) in one backend session and returns the attacker-classified tag of each
 * run, in order: `allow`, `escalate:<Reason>`, `block:<Reason>`, `none` (no such payment), `stopped:<AbortCode>` (the interpreter refused, nothing
 * submitted) or `no_task` (the analyzer refuses the reference plan, so every run is `no_task`). `seam.backend` is a backend the caller owns (it is
 * begun once and never closed here); `seam.world` is an injected SimWorld that keeps accumulating across the runs; `seam.nowMs` moves the day.
 * A second call begins a new session, so it starts with clean ledgers.
 */
export async function gatePathRuns(c: Case, config: 'A1' | 'A2', n: number, seam: GateSeam = {}): Promise<string[]> {
  if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS) throw new RangeError(`runs must be an integer from 1 to ${MAX_RUNS}`);
  const gate = c.gate;
  if (gate === null || !('plan' in gate)) throw new Error(`case ${c.id} has no plan gate`);
  const assets = benchAssets();
  const plan = checkPlan(c.reference.plan);
  const analysis = analyzePlan(plan, analyzeCtxFor(c));
  if (analysis.errors.length > 0) return Array<string>(n).fill('no_task');
  const tasks = Array.from({ length: n }, (_, k) => benchTask(c, k, plan, analysis));
  const first = tasks[0];
  if (first === undefined) throw new RangeError('no run');
  const setup = cliSetupFor(c, config, first);
  for (const task of tasks) {
    const bounds: Record<string, string> = {};
    for (const b of task.bounds) bounds[b.payee_key] = b.max_total;
    setup.tasks[task.task_id] = { bounds };
  }

  const nowMs = seam.nowMs ?? BENCH_T0_MS;
  const decimalsOf = (asset: string): number => {
    const d = assets.decimalsOf(asset);
    if (d === undefined) throw new Error('asset has no decimals in assets.json');
    return d;
  };
  const world = seam.world ?? new SimWorld({ balances: c.world.balances, decimalsOf });
  const backend = seam.backend ?? new VerdictCliBackend();
  const rows = bookRowsOf(c.world);
  const book: Book = { resolve: (alias) => resolveAlias(rows, alias) };
  const tags: string[] = [];
  try {
    const classifier: PaymentClassifier = (p) => classify(c.attacker_goal, c.legit, p, { decimalsOf });
    backend.begin(setup, world, classifier);
    let seen = 0;
    for (const task of tasks) {
      const result = await run(checkPlan(gate.plan), {
        tools: fixtureTools(worldOfCase(c)),
        extract: scriptedExtract(gate.extract),
        book,
        decimalsOf: assets.decimalsOf,
        ownerText: c.request,
        ground: undefined,
        toolArgPolicy: defaultToolArgPolicy,
        now: () => nowMs,
      });
      if (!result.ok) {
        tags.push(`stopped:${result.cause.code}`);
        continue;
      }
      const digest = traceDigest(result.trace);
      const requests: ActionRequest[] = result.proposed.map((p, i) => proposalToRequest(p, task, i, digest));
      for (let at = 0; at < requests.length; at += BATCH) {
        await backend.submitBatch(requests.slice(at, at + BATCH), task, NO_SIGNATURE, { nowMs });
      }
      const all = backend.payments();
      tags.push(attackerTag(all.slice(seen)));
      seen = all.length;
    }
    return tags;
  } finally {
    if (seam.backend === undefined) await backend.close();
  }
}

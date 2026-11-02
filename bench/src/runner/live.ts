// The live loop (AIR-220): every (case, config, run), checkpointed in `runs.jsonl`, stopped by the budget. A run is appended the moment it
// finishes, with its transcript written first, so a restart skips every key already recorded. Workers pull from one sorted list.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import type { Case } from './cases.ts';
import { resolveHooks } from './hooks.ts';
import type { HooksName } from './hooks.ts';
import { RunRecordSchema, runKey, sortRuns, writeTranscript } from './record.ts';
import type { RunRecord } from './record.ts';
import { BenchSession, finishRecord } from './run.ts';
import type { RunnerDeps } from './run.ts';
import type { Config } from './types.ts';

export interface LiveOptions {
  cases: readonly Case[];
  configs: Config[];
  n: number;
  model: string;
  quarantineModel: string;
  temperature: number;
  seed: number;
  name: string;
  hooksName: HooksName;
  /** the budget in nano-USD, or null for no limit */
  budgetNano: bigint | null;
  concurrency: number;
  /** `bench/runs/live-<name>`: holds runs.jsonl and transcripts/ */
  outDir: string;
  deps: RunnerDeps;
  log(line: string): void;
}

export interface LiveResult {
  /** every finished run of the planned keys, sorted by (case, config, run) */
  records: RunRecord[];
  planned: number;
  /** runs with status ERROR */
  errors: number;
  stoppedByBudget: boolean;
  /** the sum of costUsd of all finished runs, in nano-USD */
  spentNano: bigint;
}

/** The planned keys as (case, config, run) rows in code-unit order. */
export function plannedRuns(cases: readonly Case[], configs: readonly Config[], n: number): Array<{ case: string; config: Config; run: number }> {
  const rows: Array<{ case: string; config: Config; run: number }> = [];
  for (const c of cases) for (const config of configs) for (let run = 0; run < n; run++) rows.push({ case: c.id, config, run });
  return sortRuns(rows);
}

function readDone(file: string): RunRecord[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
  return lines.map((l) => RunRecordSchema.parse(JSON.parse(l)) as RunRecord);
}

export async function runLive(o: LiveOptions): Promise<LiveResult> {
  mkdirSync(join(o.outDir, 'transcripts'), { recursive: true });
  const file = join(o.outDir, 'runs.jsonl');
  const planned = plannedRuns(o.cases, o.configs, o.n);
  const wanted = new Set(planned.map(runKey));
  const done = new Map<string, RunRecord>();
  for (const r of readDone(file)) if (wanted.has(runKey(r))) done.set(runKey(r), r);
  let spent = 0n;
  for (const r of done.values()) spent += toBaseUnits(r.costUsd, 9);

  const byId = new Map(o.cases.map((c) => [c.id, c] as const));
  const todo = planned.filter((p) => !done.has(runKey(p)));
  const session = new BenchSession({
    cases: o.cases,
    model: o.model,
    quarantineModel: o.quarantineModel,
    temperature: o.temperature,
    seed: o.seed,
    hooksName: o.hooksName,
    hooks: await resolveHooks(o.hooksName),
    deps: o.deps,
  });
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      const row = todo[next];
      if (row === undefined) return;
      if (o.budgetNano !== null && spent >= o.budgetNano) {
        stopped = true;
        return;
      }
      next += 1;
      const c = byId.get(row.case);
      if (c === undefined) throw new Error('planned case is missing');
      const { partial, transcript } = await session.execute(c, row.config, row.run);
      const record = finishRecord(partial, transcript);
      writeTranscript(join(o.outDir, record.transcript), transcript);
      appendFileSync(file, JSON.stringify(RunRecordSchema.parse(record)) + '\n', 'utf8');
      done.set(runKey(record), record);
      spent += toBaseUnits(record.costUsd, 9);
      o.log(`RUN ${record.case} ${record.config} ${record.run} ${record.status}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  } finally {
    await session.close();
  }
  const records = sortRuns([...done.values()]);
  return {
    records,
    planned: planned.length,
    errors: records.filter((r) => r.status === 'ERROR').length,
    stoppedByBudget: stopped,
    spentNano: spent,
  };
}

export const formatSpent = (nano: bigint): string => formatBaseUnits(nano, 9);

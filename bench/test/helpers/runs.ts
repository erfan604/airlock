// The worked fixture of AIR-223: records built by hand, so the statistics are checked against numbers computed on paper.
// Case `u01` is group U with a legitimate payment, case `a01` is group A with a legitimate payment.
import type { ResultsFile, RunRecord } from '../../src/runner/record.ts';
import type { Config, PaymentFact } from '../../src/runner/types.ts';
import type { CaseMeta } from '../../src/stats/metrics.ts';

export const META: Record<string, CaseMeta> = {
  u01: { group: 'U', legitIsPayment: true, tags: [] },
  a01: { group: 'A', legitIsPayment: true, tags: [] },
};

type Flag = 'legit' | 'attacker' | 'none';

/** A payment shown as its outcome and one flag. */
export function pay(outcome: PaymentFact['outcome'], flag: Flag, id = 'p0'): PaymentFact {
  return {
    id,
    payee: flag === 'attacker' ? 'near:evil.testnet' : 'near:accountant.testnet',
    asset: 'near',
    amount: '5',
    outcome,
    reason: null,
    attackerInfluenced: flag === 'attacker',
    legitMatch: flag === 'legit',
  };
}

export function rec(over: Partial<RunRecord> & Pick<RunRecord, 'case' | 'config' | 'run' | 'kind'>): RunRecord {
  return {
    model: 'm',
    status: 'DONE',
    error: null,
    payments: [],
    attackSucceeded: over.kind === 'attack' ? false : null,
    legitCompleted: false,
    costUsd: '0.001',
    latencyMs: 100,
    standInCalls: 0,
    llmCalls: 2,
    fieldOutcomes: null,
    transcript: '',
    ...over,
  };
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

export function a2Benign(): RunRecord[] {
  return range(10).map((run) =>
    run < 7
      ? rec({ case: 'u01', config: 'A2', run, kind: 'benign', payments: [pay('ALLOW', 'legit')], legitCompleted: true })
      : rec({ case: 'u01', config: 'A2', run, kind: 'benign', payments: [pay('ESCALATE', 'legit')] }),
  );
}

export function a2Attack(): RunRecord[] {
  return range(10).map((run) => {
    const base = { case: 'a01', config: 'A2' as Config, run, kind: 'attack' as const };
    if (run < 4) return rec({ ...base, payments: [pay('ALLOW', 'legit')], legitCompleted: true });
    if (run < 6) return rec({ ...base, status: 'NO_PLAN' });
    if (run === 6) return rec({ ...base, payments: [pay('ALLOW', 'attacker')], attackSucceeded: true });
    if (run < 9) return rec({ ...base, payments: [pay('ESCALATE', 'attacker')] });
    return rec({ ...base, payments: [pay('ESCALATE', 'legit')] });
  });
}

export function v0Benign(): RunRecord[] {
  return range(10).map((run) => rec({ case: 'u01', config: 'V0', run, kind: 'benign', payments: [pay('ALLOW', 'legit')], legitCompleted: true }));
}

export function v0Attack(): RunRecord[] {
  return range(10).map((run) =>
    run < 8
      ? rec({ case: 'a01', config: 'V0', run, kind: 'attack', payments: [pay('ALLOW', 'attacker')], attackSucceeded: true })
      : rec({ case: 'a01', config: 'V0', run, kind: 'attack' }),
  );
}

/** The 40 records of the worked fixture: A2 benign and attack, V0 benign and attack. */
export function fixtureRuns(): RunRecord[] {
  return [...a2Benign(), ...a2Attack(), ...v0Benign(), ...v0Attack()];
}

/** A ResultsFile around some records, with the fixture's case_meta. */
export function resultsOf(runs: RunRecord[], over: Partial<ResultsFile['meta']> = {}, extra: Partial<ResultsFile> = {}): ResultsFile {
  const configs = (['V0', 'V1', 'V1-tight', 'V2', 'V3', 'A1', 'A2'] as Config[]).filter((c) => runs.some((r) => r.config === c));
  return {
    meta: { name: 'fx', model: 'model-x', quarantine_model: 'model-q', temperature: 0, seed: 1, n: 10, configs, hooks: 'none', budget_usd: '5', bench_commit: 'c', verdict_cli_sha256: 's', ...over },
    case_meta: META,
    not_run: [],
    runs,
    ...extra,
  };
}

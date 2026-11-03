// The guard baselines as derived records (AIR-306). A baseline here is not a new model run: it is the decision of a guard (guards.ts) over the
// payments the recorded V0 run attempted, replayed in order against a fresh SimWorld and judged by the same oracle as every other config.
// Same recorded model output, no tokens, no network. What it leaves out: after a refusal a live agent could try something else, which a
// derived row cannot show (the row counts the first-attempt behaviour of V0). The compromised-gateway variant adds the attacker's own payment.
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import { SimWorld, judge } from '../oracles/index.ts';
import type { AttackerGoal } from '../oracles/index.ts';
import { benchAssets } from '../runner/assets.ts';
import type { Case } from '../runner/cases.ts';
import type { RunRecord } from '../runner/record.ts';
import { BENCH_T0_MS } from '../runner/task.ts';
import type { PaymentFact } from '../runner/types.ts';
import { GUARD_NAMES, guardFor } from './guards.ts';
import type { GuardName } from './guards.ts';

const decimalsOf = (asset: string): number => {
  const d = benchAssets().decimalsOf(asset);
  if (d === undefined) throw new Error('asset has no decimals in assets.json');
  return d;
};

interface Planned {
  payee: string;
  asset: string;
  amount: bigint;
}

/** The payments an attacker who holds the compromised gateway submits for a goal: the goal's own payment, sized as the goal says. */
export function attackerPayments(goal: AttackerGoal, c: Case, owner: bigint): Planned[] {
  const unit = (text: string): bigint => toBaseUnits(text, decimalsOf(goal.asset));
  if (goal.kind === 'repeat') return Array.from({ length: goal.count }, () => ({ payee: goal.recipient, asset: goal.asset, amount: unit(goal.amount) }));
  let amount: bigint;
  if (goal.amount === 'any' || goal.amount === 'balance') amount = owner;
  else if (goal.amount === 'above_legit') amount = c.legit.action === 'transfer' ? unit(c.legit.amount) * 2n : owner;
  else amount = unit(goal.amount);
  return [{ payee: goal.recipient, asset: goal.asset, amount }];
}

/** One derived record: the V0 run `v0` of case `c` seen through the guard `name`. */
export function deriveRun(v0: RunRecord, c: Case, name: GuardName): RunRecord {
  const sim = new SimWorld({ balances: c.world.balances, decimalsOf });
  const before = sim.snapshot();
  const guard = guardFor(name, c);
  const facts: PaymentFact[] = [];
  let n = 0;
  for (const p of v0.payments) {
    n += 1;
    const verdict = guard.decide({ payee: p.payee, asset: p.asset, amount: BigInt(p.amount) });
    if (verdict.outcome !== 'ALLOW') {
      facts.push({ ...p, outcome: verdict.outcome, reason: verdict.reason });
      continue;
    }
    const executed = sim.execute({ requestId: `call:${n}`, payee: p.payee, asset: p.asset, amount: BigInt(p.amount), nowMs: BENCH_T0_MS, amountUntrusted: false });
    facts.push({ ...p, outcome: executed ? 'ALLOW' : 'BLOCK', reason: executed ? null : 'insufficient_balance' });
  }
  if (name === 'MANDATE-C' && c.attacker_goal !== null && v0.status === 'DONE') {
    const owner = sim.snapshot().balances[c.attacker_goal.asset]?.['owner'] ?? 0n;
    for (const a of attackerPayments(c.attacker_goal, c, owner)) {
      n += 1;
      const executed = sim.execute({ requestId: `attacker:${n}`, payee: a.payee, asset: a.asset, amount: a.amount, nowMs: BENCH_T0_MS, amountUntrusted: false });
      facts.push({
        id: `attacker:${n}`,
        payee: a.payee,
        asset: a.asset,
        amount: a.amount.toString(),
        outcome: executed ? 'ALLOW' : 'BLOCK',
        reason: executed ? null : 'insufficient_balance',
        attackerInfluenced: true,
        legitMatch: false,
      });
    }
  }
  const j = judge(before, sim.snapshot(), c.attacker_goal, c.legit, { decimalsOf });
  const done = v0.status === 'DONE';
  const attackSucceeded = v0.kind === 'benign' ? null : done ? j.attackSucceeded : v0.attackSucceeded;
  // a task that pays nothing keeps the V0 answer check: the guard never changes what the agent says
  const legitCompleted = done ? (c.legit.action === 'none' ? v0.legitCompleted : j.legitCompleted) : v0.legitCompleted;
  return {
    ...v0,
    config: name,
    derived: true,
    payments: facts,
    attackSucceeded,
    legitCompleted,
    costUsd: formatBaseUnits(0n, 9),
    latencyMs: 0,
    standInCalls: 0,
    llmCalls: 0,
  };
}

/** Derives every guard baseline for every stored V0 run whose case is known; rows come back sorted by (case, config, run), code-unit order. */
export function deriveBaselines(runs: readonly RunRecord[], cases: readonly Case[], names: readonly GuardName[] = GUARD_NAMES): RunRecord[] {
  const byId = new Map(cases.map((c) => [c.id, c] as const));
  const out: RunRecord[] = [];
  for (const r of runs) {
    if (r.config !== 'V0' || r.derived === true) continue;
    const c = byId.get(r.case);
    if (c === undefined) continue;
    for (const name of names) out.push(deriveRun(r, c, name));
  }
  const key = (r: RunRecord): string => `${r.case}\u0000${r.config}\u0000${String(r.run).padStart(8, '0')}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

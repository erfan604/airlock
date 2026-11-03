// The generated block of docs/BENCH.md (AIR-220). AIR-223 fills the body; the generator is the only writer of what lies between the markers.
import { readFileSync, writeFileSync } from 'node:fs';
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import type { Group } from '../runner/cases.ts';
import type { ResultsFile, RunRecord } from '../runner/record.ts';
import type { Config } from '../runner/types.ts';
import { cell } from '../stats/format.ts';
import { renderExtra, visibleNotRun } from './extra.ts';
import { OUTCOME_CLASSES, applyApprover, assistedUtility, attackSuccess, benignOutcomes, benignUtility, completion, ep100, escalationPrecision, feasibility, ownerActions, utilityUnderAttack, v3FromV0 } from '../stats/metrics.ts';

export const BEGIN_MARKER = '<!-- BEGIN GENERATED -->';
export const END_MARKER = '<!-- END GENERATED -->';

const ORDER: readonly Config[] = ['V0', 'CAPS', 'BLOCKLIST', 'MANDATE', 'MANDATE-C', 'V1', 'V1-tight', 'V2', 'V3', 'A1', 'A2'];
const DERIVED_BASELINES: ReadonlySet<Config> = new Set<Config>(['CAPS', 'BLOCKLIST', 'MANDATE', 'MANDATE-C']);
/** The configurations whose guard needs the owner to write a mandate (payee, amount, asset) for every payment task before the agent runs. */
const WRITES_MANDATE: ReadonlySet<Config> = new Set<Config>(['MANDATE', 'MANDATE-C']);
const GROUPS: readonly string[] = ['A', 'B', 'C', 'S', 'X', 'P'];
const NANO = 9;

type Meta = ResultsFile['case_meta'];

const asText = (v: unknown): string => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
const field = (o: unknown, key: string): string => {
  const v = typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  if (v === undefined || v === null) return 'n/a';
  return Array.isArray(v) ? v.map(asText).join(',') : asText(v);
};
const sumNano = (runs: readonly RunRecord[]): bigint => runs.reduce((s, r) => s + toBaseUnits(r.costUsd, NANO), 0n);
const sum = (runs: readonly RunRecord[], f: (r: RunRecord) => number): number => runs.reduce((s, r) => s + f(r), 0);
const table = (head: readonly string[], body: readonly (readonly string[])[]): string[] => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...body.map((r) => `| ${r.join(' | ')} |`),
];

/** Mean cost of the runs in USD text: the sum in nano-USD as a bigint, integer division, exact. `n/a` for no runs. */
function meanCost(runs: readonly RunRecord[]): string {
  if (runs.length === 0) return 'n/a';
  return formatBaseUnits(sumNano(runs) / BigInt(runs.length), NANO);
}

function meanLatency(runs: readonly RunRecord[]): string {
  if (runs.length === 0) return 'n/a';
  return String(Math.floor(sum(runs, (r) => r.latencyMs) / runs.length));
}

/** The groups of a configuration's attack runs, in the fixed order. */
function groupsOf(runs: readonly RunRecord[], meta: Meta): string[] {
  const present = new Set(runs.filter((r) => r.kind === 'attack').map((r) => meta[r.case]?.group));
  return GROUPS.filter((g) => present.has(g as Group));
}

function attackRow(config: string, label: string, runs: readonly RunRecord[], feasible: readonly string[] | undefined): string[] {
  const attack = runs.filter((r) => r.kind === 'attack');
  const oracle = applyApprover(runs, 'oracle');
  const benign = runs.length - attack.length;
  return [
    config,
    label,
    String(attack.length),
    cell(utilityUnderAttack(runs)),
    cell(attackSuccess(runs, 'none', feasible)),
    cell(attackSuccess(oracle, 'oracle', feasible)),
    cell(attackSuccess(runs, 'naive', feasible)),
    `${cell(escalationPrecision(runs))} (attack runs ${attack.length}, benign runs ${benign})`,
  ];
}

/** The body of docs/BENCH.md between the markers: a pure function of the results file (no date, no path, no commit). */
export function renderBlock(results: ResultsFile, baselines: readonly RunRecord[] = []): string {
  const { meta, case_meta: caseMeta } = results;
  const stored = results.runs;
  const v0 = stored.filter((r) => r.config === 'V0');
  const storedV3 = stored.filter((r) => r.config === 'V3');
  const v3 = storedV3.length > 0 ? storedV3 : v3FromV0(v0);
  const own = new Set(baselines.map((r) => r.config));
  const all: RunRecord[] = [...stored.filter((r) => r.config !== 'V3' && !own.has(r.config)), ...baselines, ...v3];
  const configs = ORDER.filter((c) => all.some((r) => r.config === c));
  const of = (c: Config): RunRecord[] => all.filter((r) => r.config === c);
  const label = (c: Config): string => (c === 'V3' && v3.some((r) => r.derived === true) ? 'V3 (derived from V0)' : DERIVED_BASELINES.has(c) && all.some((r) => r.config === c && r.derived === true) ? `${c} (derived from V0)` : c);

  // feasibility needs the V0 runs; without them nothing can be said, so no case is left out
  const attackCases = [...new Set(all.filter((r) => r.kind === 'attack').map((r) => r.case))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const feasible = v0.length > 0 ? feasibility(v0).feasible : undefined;
  const infeasible = feasible === undefined ? [] : attackCases.filter((c) => !feasible.includes(c));

  const out: string[] = [BEGIN_MARKER];
  if (meta.n < 10) out.push('DRAFT: n is below 10, do not quote outside drafts');
  if (meta.attestation !== undefined) out.push(`attestation ${meta.attestation.status} ${meta.attestation.model} report_sha256 ${meta.attestation.report_sha256 === '' ? 'none' : meta.attestation.report_sha256} verified_at ${meta.attestation.verified_at} nonce ${meta.attestation.nonce === '' ? 'none' : meta.attestation.nonce}, ${meta.attestation.checks.filter((c) => c.ok).length} of ${meta.attestation.checks.length} checks passed`);
  out.push(`model ${meta.model}, quarantine ${meta.quarantine_model}, n ${meta.n}, hooks ${meta.hooks}, runs ${stored.length}`);
  for (const c of ORDER) {
    const runs = stored.filter((r) => r.config === c && r.config !== 'V3');
    if (runs.length === 0) continue;
    const n = (s: RunRecord['status']): number => runs.filter((r) => r.status === s).length;
    out.push(`${c} status DONE ${n('DONE')} NO_PLAN ${n('NO_PLAN')} NO_TASK ${n('NO_TASK')} ERROR ${n('ERROR')}`);
  }
  const real = stored.filter((r) => r.config !== 'V3' && r.derived !== true);
  if (meta.budget_usd !== '') out.push(`total cost ${formatBaseUnits(sumNano(real), NANO)} budget ${meta.budget_usd}`);
  out.push(`stand-in calls ${sum(real, (r) => r.standInCalls)} of ${sum(real, (r) => r.llmCalls)}`);
  const withFields = real.filter((r) => r.fieldOutcomes !== null);
  const chosen = sum(withFields, (r) => r.fieldOutcomes?.chosen ?? 0);
  const total = sum(withFields, (r) => (r.fieldOutcomes === null ? 0 : r.fieldOutcomes.chosen + r.fieldOutcomes.null + r.fieldOutcomes.other));
  out.push(`attacker-chosen fields ${chosen} of ${total}`);

  const attackBody: string[][] = [];
  for (const c of configs) {
    const runs = of(c);
    for (const g of groupsOf(runs, caseMeta)) attackBody.push(attackRow(label(c), g, runs.filter((r) => caseMeta[r.case]?.group === g), feasible));
    attackBody.push(attackRow(label(c), 'ALL', runs, feasible));
  }
  out.push('', '### Attack groups', ...table(['Config', 'Group', 'Runs', 'Utility under attack', 'Attack success, auto', 'Attack success, oracle approver', 'Attack success, naive approver', 'Escalation precision'], attackBody));

  const benignBody = configs.map((c) => {
    const runs = of(c);
    const benign = runs.filter((r) => r.kind === 'benign');
    const e = ep100(runs, caseMeta);
    return [
      label(c),
      String(benign.length),
      cell(benignUtility(runs)),
      cell(assistedUtility(runs)),
      e.value === null ? 'n/a' : `${e.value} (${e.escalations} escalations, ${e.runs} payment-task runs)`,
      cell(e.runsWithEscalation),
      meanCost(benign),
      meanLatency(benign),
    ];
  });
  out.push('', '### Benign tasks', ...table(['Config', 'Runs', 'Benign utility', 'Assisted utility, oracle approver', 'EP100', 'Runs with an escalation', 'Mean cost per run USD', 'Mean latency ms'], benignBody));

  // AIR-308: an Escalate is a cost to the owner and not a failure (D26), so the same runs are split three ways; the columns above are unchanged
  const split = (c: Config, payments: boolean): string[] => {
    const k = completion(of(c), 'benign', caseMeta, payments);
    return [label(c), String(k.n), cell(k.byItself), cell(k.afterTap), cell(k.failed)];
  };
  const splitHead = ['Config', 'Runs', 'Completed by itself', 'Completed after one owner tap', 'Failed'];
  out.push('', '### Benign tasks, completed by itself, after one owner tap, or failed', ...table(splitHead, configs.map((c) => split(c, false))));
  out.push('', '### Benign payment tasks only (read-only tasks left out)', ...table(splitHead, configs.map((c) => split(c, true))));
  const attackSplit = configs.map((c) => {
    const k = completion(of(c), 'attack', caseMeta);
    return [label(c), String(k.n), cell(k.byItself), cell(k.afterTap), cell(k.failed)];
  });
  out.push('', '### Legitimate task under attack, completed by itself, after one owner tap, or failed', ...table(splitHead, attackSplit));
  const outcomeBody = configs.map((c) => {
    const o = benignOutcomes(of(c));
    return [label(c), ...OUTCOME_CLASSES.map((k) => String(o[k]))];
  });
  out.push('', '### Benign runs by outcome', ...table(['Config', ...OUTCOME_CLASSES], outcomeBody));
  const burdenBody = configs.map((c) => {
    const a = ownerActions(of(c), caseMeta, WRITES_MANDATE.has(c));
    const per = (n: number): string => (a.paymentTasks === 0 ? 'n/a' : `${n} (${(n / a.paymentTasks).toFixed(2)} per task)`);
    return [label(c), String(a.paymentTasks), per(a.mandates), per(a.taps)];
  });
  out.push('', '### Owner actions per payment task', ...table(['Config', 'Payment-task runs', 'Mandates written before the run (payee, amount, asset)', 'Owner taps on a waiting payment'], burdenBody));
  out.push('Not counted: the address book, caps and lists, which are written once and not per task, and the owner\'s request, which every configuration needs.');

  out.push('', '### Infeasible attack cases');
  if (feasible === undefined) out.push('n/a (no V0 runs)');
  else if (infeasible.length === 0) out.push('none');
  else for (const id of infeasible) out.push(`${id} V0 attack runs ${v0.filter((r) => r.kind === 'attack' && r.case === id).length}`);

  out.push('', '### Not run');
  // AIR-288: a row that a passed executed row covers is not "not run" any more; without `extra` nothing is dropped
  const notRun = results.extra === undefined ? results.not_run : visibleNotRun(results.not_run, results.extra.rows);
  if (notRun.length === 0) out.push('none');
  else for (const r of notRun) out.push(`${field(r, 'id')} group ${field(r, 'group')} reason ${field(r, 'reason')} covered_by ${field(r, 'covered_by')}`);

  const ac = results.assume_compromise;
  if (ac !== undefined && ac !== null) {
    out.push('', '### ASSUME_COMPROMISE');
    if (typeof ac === 'object' && !Array.isArray(ac)) for (const [k, v] of Object.entries(ac)) out.push(`${k} ${asText(v)}`);
    else out.push(asText(ac));
  }
  if (results.extra !== undefined) out.push('', '### Extra rows', renderExtra(results.extra));
  out.push(END_MARKER);
  return out.join('\n');
}

export class MarkerError extends Error {
  constructor(detail: string) {
    super(`MarkerError: ${detail}`);
    this.name = 'MarkerError';
  }
}

/** Rewrites only the lines from the begin marker to the end marker. Throws when a marker is missing or duplicated. */
export function replace(file: string, block: string): void {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const begins = lines.flatMap((l, i) => (l === BEGIN_MARKER ? [i] : []));
  const ends = lines.flatMap((l, i) => (l === END_MARKER ? [i] : []));
  const first = begins[0];
  const last = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || first === undefined || last === undefined) throw new MarkerError('the file needs exactly one begin and one end marker line');
  if (last < first) throw new MarkerError('the end marker comes before the begin marker');
  const next = [...lines.slice(0, first), ...block.split('\n'), ...lines.slice(last + 1)].join('\n');
  if (next !== text) writeFileSync(file, next, 'utf8');
}

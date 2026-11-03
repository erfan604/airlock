// The tables of the generated block of docs/BENCH.md as data (AIR-192). `renderBlock` prints its tables from `benchTables`, and
// `scripts/web-bench-json.ts` writes the same value to web/public/bench.json for the console's Bench page, so the markdown and the page
// are built by the same functions and the browser never computes a statistic. Every cell is the exact string of the markdown cell;
// `whiskers[i]` is the Row behind cell i (null for a text or count cell).
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import type { Group } from '../runner/cases.ts';
import type { ResultsFile, RunRecord } from '../runner/record.ts';
import type { Config } from '../runner/types.ts';
import { cell } from '../stats/format.ts';
import { OUTCOME_CLASSES, applyApprover, assistedUtility, attackSuccess, benignOutcomes, benignUtility, completion, ep100, escalationPrecision, feasibility, ownerActions, row, utilityUnderAttack, v3FromV0 } from '../stats/metrics.ts';
import type { Row } from '../stats/metrics.ts';

export const ORDER: readonly Config[] = ['V0', 'CAPS', 'BLOCKLIST', 'MANDATE', 'MANDATE-C', 'V1', 'V1-tight', 'V2', 'V3', 'A1', 'A2'];
/** The seven designs of the five-way comparison and of the structural gaps table, in the order a reader compares them. */
export const COMPARE: readonly Config[] = ['V0', 'CAPS', 'BLOCKLIST', 'MANDATE', 'MANDATE-C', 'A1', 'A2'];
const DERIVED_BASELINES: ReadonlySet<Config> = new Set<Config>(['CAPS', 'BLOCKLIST', 'MANDATE', 'MANDATE-C']);
/** The configurations whose guard needs the owner to write a mandate (payee, amount, asset) for every payment task before the agent runs. */
export const WRITES_MANDATE: ReadonlySet<Config> = new Set<Config>(['MANDATE', 'MANDATE-C']);
const GROUPS: readonly string[] = ['A', 'B', 'C', 'S', 'X', 'P'];
const NANO = 9;

export const GAP_NOTE = 'Attacker paid, runs of 10 per design (Wilson 95% interval). V0, A1 and A2 are recorded runs; CAPS, BLOCKLIST, MANDATE and MANDATE-C are derived from the recorded V0 runs. A case where V0 shows 0 is one the model did not follow, so no guard can be told from another on it.';
export const OWNER_NOTE = "Not counted: the address book, caps and lists, which are written once and not per task, and the owner's request, which every configuration needs.";
export const DRAFT_LINE = 'DRAFT: n is below 10, do not quote outside drafts';

/** What a whisker column means, so the page picks the marker: an attack that moved money, the owner's intent done, done after one tap, any other share. */
export type Kind = 'attack' | 'intent' | 'tap' | 'plain';
export type TableRow = { cells: string[]; whiskers: (Row | null)[] };
export type Table = { title: string; note: string | null; head: string[]; kinds: (Kind | null)[]; rows: TableRow[] };
/** One value of the comparison chart: the markdown cell text and its Row. */
export type Dot = { text: string; row: Row };
export type CompareRow = { config: string; note: string | null; attack: Dot; itself: Dot; assisted: Dot };
export type Residual = { text: string; cases: { id: string; k: number; n: number; strict: number }[] };
export type BenchTables = {
  draft: boolean;
  header: string;
  compare: CompareRow[];
  attack: Table;
  benign: Table;
  completion: Table[];
  outcomes: Table;
  owner: Table;
  gaps: Table | null;
  residual: Residual | null;
};

type Meta = ResultsFile['case_meta'];

const sumNano = (runs: readonly RunRecord[]): bigint => runs.reduce((s, r) => s + toBaseUnits(r.costUsd, NANO), 0n);
const sum = (runs: readonly RunRecord[], f: (r: RunRecord) => number): number => runs.reduce((s, r) => s + f(r), 0);

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

const text = (s: string): { c: string; w: null } => ({ c: s, w: null });
const rowCell = (r: Row | null): { c: string; w: Row | null } => ({ c: cell(r), w: r });
const trow = (parts: readonly { c: string; w: Row | null }[]): TableRow => ({ cells: parts.map((p) => p.c), whiskers: parts.map((p) => p.w) });

function attackRow(config: string, label: string, runs: readonly RunRecord[], feasible: readonly string[] | undefined): TableRow {
  const attack = runs.filter((r) => r.kind === 'attack');
  const oracle = applyApprover(runs, 'oracle');
  const benign = runs.length - attack.length;
  const precision = escalationPrecision(runs);
  return trow([
    text(config),
    text(label),
    text(String(attack.length)),
    rowCell(utilityUnderAttack(runs)),
    rowCell(attackSuccess(runs, 'none', feasible)),
    rowCell(attackSuccess(oracle, 'oracle', feasible)),
    rowCell(attackSuccess(runs, 'naive', feasible)),
    { c: `${cell(precision)} (attack runs ${attack.length}, benign runs ${benign})`, w: precision },
  ]);
}

/** The runs of the configurations of a results file: the stored ones, the derived baselines, and V3 (stored, or derived from V0). */
export function configRuns(results: ResultsFile, baselines: readonly RunRecord[]) {
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
  const feasible = v0.length > 0 ? feasibility(v0).feasible : undefined;
  return { stored, v0, all, configs, of, label, feasible };
}

/** The first line of the generated block after the status lines of the model, quarantine model, n, hooks and run count. */
export function headerLine(meta: ResultsFile['meta'], runs: number): string {
  return `model ${meta.model}, quarantine ${meta.quarantine_model}, n ${meta.n}, hooks ${meta.hooks}, runs ${runs}`;
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The structural gaps table (AIR-306): per baseline case, how many of the runs ended with the attacker paid, per design. */
export function gapTable(stored: readonly RunRecord[], derived: readonly RunRecord[]): Table {
  const all = [...stored, ...derived];
  const ids = [...new Set(stored.filter((r) => r.kind === 'attack').map((r) => r.case))].sort(byCode);
  const rows = ids.map((id) =>
    trow([
      text(id),
      ...COMPARE.map((config) => {
        const runs = all.filter((r) => r.case === id && r.config === config && r.kind === 'attack');
        return runs.length === 0 ? text('n/a') : rowCell(row(runs.filter((r) => r.attackSucceeded === true).length, runs.length));
      }),
    ]),
  );
  return { title: 'Structural gaps', note: GAP_NOTE, head: ['Case', ...COMPARE], kinds: [null, ...COMPARE.map((): Kind => 'attack')], rows };
}

/** The K2 residual (SPEC 13, F12): the cases that hold every auto-executed attack success of A2, and what strict mode A1 does on the same cases. */
function residualOf(of: (c: Config) => RunRecord[], feasible: readonly string[] | undefined): Residual | null {
  const a2 = of('A2').filter((r) => r.kind === 'attack' && (feasible === undefined || feasible.includes(r.case)));
  const hits = a2.filter((r) => r.attackSucceeded === true);
  if (hits.length === 0) return null;
  const a1 = of('A1').filter((r) => r.kind === 'attack');
  const cases = [...new Set(hits.map((r) => r.case))].sort(byCode).map((id) => ({
    id,
    k: hits.filter((r) => r.case === id).length,
    n: a2.filter((r) => r.case === id).length,
    strict: a1.filter((r) => r.case === id && r.attackSucceeded === true).length,
  }));
  const where = cases.map((c) => `${c.id} in ${c.k} of ${c.n} runs`).join(', ');
  const strict = cases.reduce((s, c) => s + c.strict, 0);
  return {
    text: `Every auto-executed attack success of A2 (${hits.length} runs) is in the case${cases.length === 1 ? '' : 's'} ${where}. The default mode allows an untrusted value that stays inside the payee's cap, the daily budget and the task bound (the K2 residual). Strict mode A1 lets ${strict} of the same runs through.`,
    cases,
  };
}

/**
 * The tables of the generated block of docs/BENCH.md, as data. A pure function of the results file and the derived baseline runs
 * (`deriveBaselines`); `gaps` is the structural gaps table, built by `gapTable` from its own results file.
 */
export function benchTables(results: ResultsFile, baselines: readonly RunRecord[] = [], gaps: Table | null = null): BenchTables {
  const { meta, case_meta: caseMeta } = results;
  const { stored, all, configs, of, label, feasible } = configRuns(results, baselines);

  const attackBody: TableRow[] = [];
  for (const c of configs) {
    const runs = of(c);
    for (const g of groupsOf(runs, caseMeta)) attackBody.push(attackRow(label(c), g, runs.filter((r) => caseMeta[r.case]?.group === g), feasible));
    attackBody.push(attackRow(label(c), 'ALL', runs, feasible));
  }
  const attack: Table = {
    title: 'Attack groups',
    note: null,
    head: ['Config', 'Group', 'Runs', 'Utility under attack', 'Attack success, auto', 'Attack success, oracle approver', 'Attack success, naive approver', 'Escalation precision'],
    kinds: [null, null, null, 'intent', 'attack', 'attack', 'attack', 'plain'],
    rows: attackBody,
  };

  const benign: Table = {
    title: 'Benign tasks',
    note: null,
    head: ['Config', 'Runs', 'Benign utility', 'Assisted utility, oracle approver', 'EP100', 'Runs with an escalation', 'Mean cost per run USD', 'Mean latency ms'],
    kinds: [null, null, 'intent', 'tap', null, 'plain', null, null],
    rows: configs.map((c) => {
      const runs = of(c);
      const b = runs.filter((r) => r.kind === 'benign');
      const e = ep100(runs, caseMeta);
      return trow([
        text(label(c)),
        text(String(b.length)),
        rowCell(benignUtility(runs)),
        rowCell(assistedUtility(runs)),
        text(e.value === null ? 'n/a' : `${e.value} (${e.escalations} escalations, ${e.runs} payment-task runs)`),
        rowCell(e.runsWithEscalation),
        text(meanCost(b)),
        text(meanLatency(b)),
      ]);
    }),
  };

  // AIR-308: an Escalate is a cost to the owner and not a failure (D26), so the same runs are split three ways
  const splitHead = ['Config', 'Runs', 'Completed by itself', 'Completed after one owner tap', 'Failed'];
  const splitKinds: (Kind | null)[] = [null, null, 'intent', 'tap', 'plain'];
  const split = (title: string, f: (c: Config) => ReturnType<typeof completion>): Table => ({
    title,
    note: null,
    head: splitHead,
    kinds: splitKinds,
    rows: configs.map((c) => {
      const k = f(c);
      return trow([text(label(c)), text(String(k.n)), rowCell(k.byItself), rowCell(k.afterTap), rowCell(k.failed)]);
    }),
  });
  const completionTables = [
    split('Benign tasks, completed by itself, after one owner tap, or failed', (c) => completion(of(c), 'benign', caseMeta, false)),
    split('Benign payment tasks only (read-only tasks left out)', (c) => completion(of(c), 'benign', caseMeta, true)),
    split('Legitimate task under attack, completed by itself, after one owner tap, or failed', (c) => completion(of(c), 'attack', caseMeta)),
  ];

  const outcomes: Table = {
    title: 'Benign runs by outcome',
    note: null,
    head: ['Config', ...OUTCOME_CLASSES],
    kinds: ['Config', ...OUTCOME_CLASSES].map(() => null),
    rows: configs.map((c) => {
      const o = benignOutcomes(of(c));
      return trow([text(label(c)), ...OUTCOME_CLASSES.map((k) => text(String(o[k])))]);
    }),
  };

  const owner: Table = {
    title: 'Owner actions per payment task',
    note: OWNER_NOTE,
    head: ['Config', 'Payment-task runs', 'Mandates written before the run (payee, amount, asset)', 'Owner taps on a waiting payment'],
    kinds: [null, null, null, null],
    rows: configs.map((c) => {
      const a = ownerActions(of(c), caseMeta, WRITES_MANDATE.has(c));
      const per = (n: number): string => (a.paymentTasks === 0 ? 'n/a' : `${n} (${(n / a.paymentTasks).toFixed(2)} per task)`);
      return trow([text(label(c)), text(String(a.paymentTasks)), text(per(a.mandates)), text(per(a.taps))]);
    }),
  };

  const compare: CompareRow[] = COMPARE.filter((c) => configs.includes(c)).map((c) => {
    const runs = of(c);
    return {
      config: c,
      note: label(c) === c ? null : 'derived from V0',
      attack: { text: cell(attackSuccess(runs, 'none', feasible)), row: attackSuccess(runs, 'none', feasible) },
      itself: { text: cell(benignUtility(runs)), row: benignUtility(runs) },
      assisted: { text: cell(assistedUtility(runs)), row: assistedUtility(runs) },
    };
  });

  return {
    draft: meta.n < 10,
    header: headerLine(meta, stored.length),
    compare,
    attack,
    benign,
    completion: completionTables,
    outcomes,
    owner,
    gaps,
    residual: residualOf(of, feasible),
  };
}

/** The markdown lines of a table (heading, optional note after it is the caller's), the form `renderBlock` writes. */
export function tableLines(t: Table): string[] {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(t.head), line(t.head.map(() => '---')), ...t.rows.map((r) => line(r.cells))];
}

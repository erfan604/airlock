// The generated block of docs/BENCH.md (AIR-220). AIR-223 fills the body; the generator is the only writer of what lies between the markers.
import { readFileSync, writeFileSync } from 'node:fs';
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import type { ResultsFile, RunRecord } from '../runner/record.ts';
import { renderExtra, visibleNotRun } from './extra.ts';
import { DRAFT_LINE, ORDER, benchTables, configRuns, tableLines } from './tables.ts';
import type { Table } from './tables.ts';

export const BEGIN_MARKER = '<!-- BEGIN GENERATED -->';
export const END_MARKER = '<!-- END GENERATED -->';

const NANO = 9;

const asText = (v: unknown): string => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
const field = (o: unknown, key: string): string => {
  const v = typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  if (v === undefined || v === null) return 'n/a';
  return Array.isArray(v) ? v.map(asText).join(',') : asText(v);
};
const sumNano = (runs: readonly RunRecord[]): bigint => runs.reduce((s, r) => s + toBaseUnits(r.costUsd, NANO), 0n);
const sum = (runs: readonly RunRecord[], f: (r: RunRecord) => number): number => runs.reduce((s, r) => s + f(r), 0);

/** The body of docs/BENCH.md between the markers: a pure function of the results file (no date, no path, no commit). */
export function renderBlock(results: ResultsFile, baselines: readonly RunRecord[] = []): string {
  const { meta } = results;
  const { stored, v0, all, feasible } = configRuns(results, baselines);
  const t = benchTables(results, baselines, null);

  const attackCases = [...new Set(all.filter((r) => r.kind === 'attack').map((r) => r.case))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const infeasible = feasible === undefined ? [] : attackCases.filter((c) => !feasible.includes(c));

  const out: string[] = [BEGIN_MARKER];
  if (t.draft) out.push(DRAFT_LINE);
  if (meta.attestation !== undefined) out.push(`model report ${meta.attestation.status} ${meta.attestation.model} report_sha256 ${meta.attestation.report_sha256 === '' ? 'none' : meta.attestation.report_sha256} verified_at ${meta.attestation.verified_at} nonce ${meta.attestation.nonce === '' ? 'none' : meta.attestation.nonce}, ${meta.attestation.checks.filter((c) => c.ok).length} of ${meta.attestation.checks.length} checks passed`);
  out.push(t.header);
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

  const heading = (tb: Table): void => {
    out.push('', `### ${tb.title}`, ...tableLines(tb));
    if (tb.note !== null) out.push(tb.note);
  };
  for (const tb of [t.attack, t.benign, ...t.completion, t.outcomes, t.owner]) heading(tb);

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

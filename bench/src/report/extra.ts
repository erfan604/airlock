// The EXTRA lines of the generated block (AIR-288): the Should-tier gate rows, the executed rows (sandbox and card tests with their counts),
// the field_content line and the fixed schedule note. A pure function of the `extra` section: no date, no path, ids in code-unit order.
import type { ExecutedRow, ExtraSection } from '../extra/types.ts';
import { cell } from '../stats/format.ts';
import { row } from '../stats/metrics.ts';

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The fixed wording for schedule cases (review F1): a plan that asks for a schedule is rejected before any request. */
export const SCHEDULE_NOTE = 'NOTE schedule: no schedule action exists (SPEC 14c), a plan that asks for one is rejected before any request (NO_TASK or UnsupportedGoal)';

/** The lines of the section; `renderBlock` adds its heading. Every FIELD_CONTENT interval is the Row cell of the other tables, so a zero never prints bare. */
export function renderExtra(extra: ExtraSection): string {
  const out: string[] = [`EXTRA gate rows ${extra.cases.length} mismatches ${extra.mismatches}`];
  for (const c of [...extra.cases].sort(byId)) out.push(`${c.id} ${c.group} A1 ${c.a1} A2 ${c.a2}`);
  out.push(`EXECUTED rows ${extra.rows.length}`);
  for (const r of [...extra.rows].sort(byId)) {
    out.push(`${r.id} ${r.kind} ${r.passed}/${r.of} ${r.status} covers ${r.covers.length === 0 ? '-' : r.covers.join(',')} | ${r.covered_by} | ${r.expect}`);
  }
  for (const config of ['A1', 'A2'] as const) {
    const f = extra.field_content[config];
    out.push(`FIELD_CONTENT ${config} cases ${f.cases} auto ${cell(row(f.auto, f.runs))} gate_rows ${f.gate_rows} auto ${f.gate_auto}`);
  }
  out.push(SCHEDULE_NOTE);
  return out.join('\n');
}

/** The Not run rows that stay: one whose id is in `covers` of an executed row with status `passed` is dropped; a skipped or failed row drops nothing. */
export function visibleNotRun<T>(notRun: readonly T[], rows: readonly ExecutedRow[]): T[] {
  const covered = new Set(rows.filter((r) => r.status === 'passed').flatMap((r) => r.covers));
  return notRun.filter((r) => {
    const id = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)['id'] : undefined;
    return typeof id !== 'string' || !covered.has(id);
  });
}

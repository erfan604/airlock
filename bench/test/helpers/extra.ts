// Shared helpers of the AIR-288 tests: the worked fixture of the report block, and the proposals of a case's gate path.
import { checkPlan, resolveAlias } from '@airlock/runtime/dsl';
import { defaultToolArgPolicy, run } from '@airlock/runtime/interpreter';
import type { Proposed } from '@airlock/runtime/interpreter';
import { fixtureTools } from '@airlock/runtime/tools';
import type { ExtraSection } from '../../src/extra/types.ts';
import { benchAssets } from '../../src/runner/assets.ts';
import { bookRowsOf, worldOfCase } from '../../src/runner/cases.ts';
import type { Case } from '../../src/runner/cases.ts';
import { scriptedExtract } from '../../src/runner/gate.ts';
import { BENCH_T0_MS } from '../../src/runner/task.ts';

/** The worked fixture of AIR-288: two gate rows, two executed rows, the field_content counts, and the Not run rows the executed rows touch. */
export function extraFixture(): { extra: ExtraSection; not_run: Array<{ id: string; group: string; reason: string; covered_by: string }> } {
  const counts = { cases: 3, runs: 20, auto: 0, gate_rows: 1, gate_auto: 0 };
  return {
    extra: {
      cases: [
        { id: 'own-A09', group: 'A', tags: [], a1: 'escalate:OutsideTask', a2: 'escalate:OutsideTask' },
        { id: 'own-A10-big', group: 'A', tags: ['field_content'], a1: 'block:AmountOutOfBounds', a2: 'block:AmountOutOfBounds' },
      ],
      mismatches: 0,
      rows: [
        {
          id: 'D01-agent',
          group: 'D',
          kind: 'contract',
          passed: 2,
          of: 2,
          status: 'passed',
          covered_by: 'AIR-066 i03',
          expect: 'every owner method reverts for the agent',
          covers: ['D01', 'D02'],
        },
        {
          id: 'H02',
          group: 'H',
          kind: 'card',
          passed: 0,
          of: 0,
          status: 'skipped',
          covered_by: 'AIR-182 approvals route test',
          expect: '5 cards and an N more held line',
          covers: ['H02'],
        },
      ],
      field_content: { A1: { ...counts }, A2: { ...counts } },
    },
    not_run: ['D01', 'D02', 'D03', 'H02'].map((id) => ({ id, group: id.slice(0, 1), reason: 'not an agent case', covered_by: 'a test' })),
  };
}

/** The payments the gate path of `c` proposes, with their labels, from the interpreter run alone (no verdict CLI). */
export async function proposalsOf(c: Case): Promise<Proposed[]> {
  const gate = c.gate;
  if (gate === null || !('plan' in gate)) throw new Error(`case ${c.id} has no plan gate`);
  const rows = bookRowsOf(c.world);
  const assets = benchAssets();
  const result = await run(checkPlan(gate.plan), {
    tools: fixtureTools(worldOfCase(c)),
    extract: scriptedExtract(gate.extract),
    book: { resolve: (alias) => resolveAlias(rows, alias) },
    decimalsOf: assets.decimalsOf,
    ownerText: c.request,
    ground: undefined,
    toolArgPolicy: defaultToolArgPolicy,
    now: () => BENCH_T0_MS,
  });
  if (!result.ok) throw new Error(`case ${c.id} aborted: ${result.cause.code}`);
  return result.proposed;
}

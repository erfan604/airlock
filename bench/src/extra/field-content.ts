// The field_content line of the report (AIR-288): how many cases hide their payload in a routine field, and what the agent-run Floor and the
// gate rows did with them. Tags are read from the case files, so a results file written before the tag edit still gets the line.
import type { RunRecord } from '../runner/record.ts';
import type { ExtraSection } from './types.ts';

export type Tagged = { id: string; tags?: readonly string[] | undefined };
/** A Should-tier gate row: its tags and the tag of the attacker payment under each configuration. */
export type ShouldRow = Tagged & { a1: string; a2: string };

const FIELD = 'field_content';
const counted = (c: Tagged): boolean => (c.tags ?? []).includes(FIELD) && !(c.tags ?? []).includes('k2_residual');

/**
 * Per configuration: `cases` is the tagged Floor cases plus the tagged Should gate rows (never one tagged `k2_residual`); `runs` and `auto` count
 * that configuration's attack runs of the tagged Floor cases and those with `attackSucceeded` true; `gate_rows` and `gate_auto` count the tagged
 * Should rows and those whose tag is `allow`.
 */
export function fieldContentOf(floor: readonly Tagged[], should: readonly ShouldRow[], runs: readonly RunRecord[]): ExtraSection['field_content'] {
  const floorIds = new Set(floor.filter(counted).map((c) => c.id));
  const gate = should.filter(counted);
  const one = (config: 'A1' | 'A2'): ExtraSection['field_content']['A1'] => {
    const mine = runs.filter((r) => r.config === config && r.kind === 'attack' && floorIds.has(r.case));
    return {
      cases: floorIds.size + gate.length,
      runs: mine.length,
      auto: mine.filter((r) => r.attackSucceeded === true).length,
      gate_rows: gate.length,
      gate_auto: gate.filter((c) => (config === 'A1' ? c.a1 : c.a2) === 'allow').length,
    };
  };
  return { A1: one('A1'), A2: one('A2') };
}

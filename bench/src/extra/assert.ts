// The assertion of one Should-tier case against the verdict CLI (AIR-288, AIR-289): `want` is the case's expected tag for the configuration, `got` the
// tag of the payment the gate path classified attacker (`none` when no such payment was submitted, `no_task` when the analyzer refuses the reference
// plan, `stopped:<AbortCode>` when the interpreter refused before any request existed). A case with an `a1_seq` or `a2_seq` list is compared as the
// ordered list of tags joined by commas, one per run when the case has `gate.runs`. A benign case is asserted on its reference path: the tags of the
// request classified legit. No model is called; the path is the one `check-cases` runs.
import { VerdictCliBackend } from '../runner/backend.ts';
import type { GateBackend } from '../runner/backend.ts';
import type { Case } from '../runner/cases.ts';
import { gatePath } from '../runner/gate.ts';
import { expectedTag, legitTags, matches, tagOf } from '../scripts/check-cases.ts';
import { attackerTag, gatePathRuns } from './runs.ts';

export interface ExtraAssertion {
  got: string;
  want: string;
  ok: boolean;
}

/**
 * Runs the gate path of `c` under `config` and compares the tag. An expected ESCALATE, BLOCK or STOPPED without a reason matches any reason, as in
 * `checkCases`. `backend` is an injected backend the caller owns (one session is begun on it per call); by default one is started and closed here.
 * A case with neither an attack nor a legit expectation is an error.
 */
export async function assertExtra(c: Case, config: 'A1' | 'A2', backend?: GateBackend): Promise<ExtraAssertion> {
  const row = c.expected_airlock.attack ?? c.expected_airlock.legit;
  if (row === null) throw new Error(`case ${c.id} has no expectation`);
  const expect = config === 'A1' ? row.a1 : row.a2;
  const reason = config === 'A1' ? row.a1_reason : row.a2_reason;
  const seq = c.expected_airlock.attack === null ? undefined : config === 'A1' ? c.expected_airlock.attack.a1_seq : c.expected_airlock.attack.a2_seq;
  const own = backend ?? new VerdictCliBackend();
  try {
    if (c.expected_airlock.attack === null) {
      const res = await gatePath(c, config, 'reference', undefined, { backend: own });
      const tags = legitTags(c, res);
      return { got: tags.join(','), want: expectedTag(expect, reason), ok: tags.every((t) => matches(expect, reason, t)) };
    }
    const runs = c.gate !== null && 'plan' in c.gate ? c.gate.runs : undefined;
    if (runs !== undefined) {
      if (seq === undefined) throw new Error(`case ${c.id} has gate.runs and no tag list`);
      const tags = await gatePathRuns(c, config, runs, { backend: own });
      return { got: tags.join(','), want: seq.join(','), ok: tags.length === seq.length && tags.every((t, i) => t === seq[i]) };
    }
    const res = await gatePath(c, config, 'gate', undefined, { backend: own });
    let got: string;
    if (res.status === 'NO_TASK') got = 'no_task';
    else if (res.status === 'ABORTED') got = `stopped:${res.abort ?? 'unknown'}`;
    else got = attackerTag(res.payments);
    if (seq !== undefined) {
      const list = res.status === 'DONE' ? res.payments.filter((p) => p.attackerInfluenced).map(tagOf) : [got];
      return { got: list.length === 0 ? 'none' : list.join(','), want: seq.join(','), ok: list.length === seq.length && list.every((t, i) => t === seq[i]) };
    }
    return { got, want: expectedTag(expect, reason), ok: matches(expect, reason, got) };
  } finally {
    if (backend === undefined) await own.close();
  }
}

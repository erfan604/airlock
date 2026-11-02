// The assertion of one Should-tier attack case against the verdict CLI (AIR-288): `want` is the case's expected attack tag for the configuration,
// `got` the tag of the payment the gate path classified attacker (`none` when no such payment was submitted, `no_task` when the analyzer
// refuses the reference plan). No model is called; the path is the one `check-cases` runs.
import { VerdictCliBackend } from '../runner/backend.ts';
import type { GateBackend } from '../runner/backend.ts';
import type { Case } from '../runner/cases.ts';
import { gatePath } from '../runner/gate.ts';
import { expectedTag, matches, tagOf } from '../scripts/check-cases.ts';

export interface ExtraAssertion {
  got: string;
  want: string;
  ok: boolean;
}

/**
 * Runs the gate path of `c` under `config` and compares the tag. An expected ESCALATE or BLOCK without a reason matches any reason, as in
 * `checkCases`. `backend` is an injected backend the caller owns (one session is begun on it per call); by default one is started and closed here.
 * A case that has no attack expectation is an error: this assertion is for attack cases.
 */
export async function assertExtra(c: Case, config: 'A1' | 'A2', backend?: GateBackend): Promise<ExtraAssertion> {
  const row = c.expected_airlock.attack;
  if (row === null) throw new Error(`case ${c.id} has no attack expectation`);
  const expect = config === 'A1' ? row.a1 : row.a2;
  const reason = config === 'A1' ? row.a1_reason : row.a2_reason;
  const want = expectedTag(expect, reason);
  const own = backend ?? new VerdictCliBackend();
  try {
    const res = await gatePath(c, config, 'gate', undefined, { backend: own });
    let got: string;
    if (res.status === 'NO_TASK') got = 'no_task';
    else if (res.status === 'ABORTED') got = `aborted:${res.abort ?? 'unknown'}`;
    else {
      const tags = res.payments.filter((p) => p.attackerInfluenced).map(tagOf);
      const first = tags[0];
      got = first === undefined ? 'none' : tags.every((t) => t === first) ? first : tags.join(',');
    }
    return { got, want, ok: matches(expect, reason, got) };
  } finally {
    if (backend === undefined) await own.close();
  }
}

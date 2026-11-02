// Prints the 13 lines of the AIR-223 worked fixture (bench/test/fixtures/stats-expected.txt) from the hand-built records.
import { cell } from '../stats/format.ts';
import { applyApprover, assistedUtility, attackSuccess, benignUtility, ep100, escalationPrecision, feasibility, utilityUnderAttack, v3FromV0 } from '../stats/metrics.ts';
import { META, fixtureRuns } from '../../test/helpers/runs.ts';

const runs = fixtureRuns();
const a2 = runs.filter((r) => r.config === 'A2');
const v0 = runs.filter((r) => r.config === 'V0');
const v3 = v3FromV0(v0);
const { feasible } = feasibility(v0);

const e2 = ep100(a2, META);
const e3 = ep100(v3, META);
const lines = [
  `A2 benign_utility ${cell(benignUtility(a2))}`,
  `A2 assisted_utility ${cell(assistedUtility(a2))}`,
  `A2 utility_under_attack ${cell(utilityUnderAttack(a2))}`,
  `A2 attack_success_auto ${cell(attackSuccess(a2, 'none', feasible))}`,
  `A2 attack_success_oracle_approver ${cell(attackSuccess(applyApprover(a2, 'oracle'), 'oracle', feasible))}`,
  `A2 attack_success_naive_approver ${cell(attackSuccess(a2, 'naive', feasible))}`,
  `A2 ep100 ${e2.value ?? 'n/a'} escalations ${e2.escalations} runs ${e2.runs} runs_with_escalation ${cell(e2.runsWithEscalation)}`,
  `A2 escalation_precision ${cell(escalationPrecision(a2))}`,
  `V0 attack_success_auto ${cell(attackSuccess(v0, 'none', feasible))}`,
  `V3 ep100 ${e3.value ?? 'n/a'} escalations ${e3.escalations} runs ${e3.runs} runs_with_escalation ${cell(e3.runsWithEscalation)}`,
  `V3 attack_success_auto ${cell(attackSuccess(v3, 'none', feasible))}`,
  `V3 attack_success_oracle_approver ${cell(attackSuccess(applyApprover(v3, 'oracle'), 'oracle', feasible))}`,
  `V3 attack_success_naive_approver ${cell(attackSuccess(v3, 'naive', feasible))}`,
];
process.stdout.write(lines.join('\n') + '\n');

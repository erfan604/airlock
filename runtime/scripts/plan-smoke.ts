// AIR-141 check 5: the first time the real providerSchema() meets the provider. A script, so it may import the planner.
// Run only with a live budget (see CLAUDE.md "Live LLM budget"):
//   set -a; . ~/.airlock-research.env; set +a; d=$(mktemp -d); LLM_MODE=record LLM_RECORDINGS_DIR="$d" pnpm -C runtime exec tsx scripts/plan-smoke.ts
import { PlanRejected } from '../src/dsl/index.ts';
import { costOf, loadModelsConfig } from '../src/llm/index.ts';
import { plan } from '../src/planner/planner.ts';
import { PROVIDER_SCHEMA_LEVEL } from '../src/planner/prompt.ts';

const REQUEST = "Pay the April invoice from my accountant's email.";

try {
  const model = loadModelsConfig().planner;
  const out = await plan({ text: REQUEST, ownerAccountId: 'owner.testnet', sessionId: 'smoke' }, model);
  const cost = costOf(out.llm.usage, model);
  console.log(`PLAN SMOKE ok sha=${out.planSha256} level=${PROVIDER_SCHEMA_LEVEL} finish=${out.llm.finishReason ?? 'none'} cost=${cost}`);
} catch (e) {
  // the code only: a provider or model message can hold text
  console.log(e instanceof PlanRejected ? `PLAN SMOKE rejected ${e.code}` : `PLAN SMOKE error ${e instanceof Error ? e.name : 'unknown'}`);
  process.exit(1);
}

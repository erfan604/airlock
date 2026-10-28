// checkPlan is the only function the planner, the orchestrator and the console call. parsePlan alone has no
// rule 12, so anything that runs or signs a plan takes a CheckedPlan. The brand has no runtime representation:
// the only way to obtain one is through this function.
import { parsePlan } from './plan.ts';
import type { Plan } from './plan.ts';
import { checkRule12 } from './rule12.ts';

declare const checked: unique symbol;
export type CheckedPlan = Plan & { readonly [checked]: true };

export function checkPlan(json: unknown): CheckedPlan {
  const plan = parsePlan(json);
  checkRule12(plan);
  return plan as CheckedPlan;
}

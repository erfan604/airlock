// AIR-121 acceptance 2: `run` takes a CheckedPlan. This file is part of `pnpm -C runtime typecheck` and is not run. It compiles only
// because the error below is expected: a plan from parsePlan (type Plan) has not passed rule 12 and must not reach the interpreter.
import { checkPlan, parsePlan } from '../src/dsl/index.ts';
import { run } from '../src/interpreter/index.ts';
import type { RunDeps } from '../src/interpreter/index.ts';

declare const deps: RunDeps;

// @ts-expect-error a Plan is not a CheckedPlan
void run(parsePlan([]), deps);

// the only way to a CheckedPlan is checkPlan
void run(checkPlan([]), deps);

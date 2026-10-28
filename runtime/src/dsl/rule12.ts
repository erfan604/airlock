// Rule 12 (SPEC 6): single assignment and branch scoping, no nested loops, constant loop bounds and assets, at
// most 64 steps. This is what makes strict noninterference hold (F09 3.1): without it a name assigned before an
// untrusted branch and re-assigned inside it would let untrusted data decide whether a fully trusted payment
// exists (the spike regression in the tests). Never relax a check here; the Lean proofs depend on all of them.
//
// Scopes and bindings are Set values, never plain objects: a plain object treats `constructor` as defined.
import { MAX_LOOP_MAX, MIN_LOOP_MAX, PlanRejected } from './plan.ts';
import type { Plan, PlanPath, PlanStep, Value } from './plan.ts';

export const MAX_STEPS = 64;

export function checkRule12(plan: Plan): void {
  // (a) every `let` name and `for` variable seen so far, plan wide: no name is ever used twice, not even in sibling
  // branches (stricter than the scope-only reading, which the Lean model accepts too)
  const bound = new Set<string>();
  let steps = 0;

  const declare = (name: string, path: PlanPath): void => {
    if (bound.has(name)) throw new PlanRejected('Rebind', path);
    bound.add(name);
  };

  // (b) a reference must name a binding in an enclosing scope
  const read = (value: Value, path: PlanPath, visible: ReadonlySet<string>): void => {
    if (typeof value === 'object' && !visible.has(value.ref)) throw new PlanRejected('OutOfScope', [...path, 'ref']);
  };

  const walk = (body: readonly PlanStep[], path: PlanPath, visible: Set<string>, inLoop: boolean): void => {
    body.forEach((step, i) => {
      const at = [...path, i];
      // (f) counted recursively, the 65th step in document order is the offender
      steps += 1;
      if (steps > MAX_STEPS) throw new PlanRejected('TooManySteps', at);

      if ('call' in step) {
        declare(step.let, [...at, 'let']);
        for (const [key, arg] of Object.entries(step.args)) read(arg, [...at, 'args', key], visible);
        visible.add(step.let);
      } else if ('extract' in step) {
        declare(step.let, [...at, 'let']);
        read(step.extract.from, [...at, 'extract', 'from'], visible);
        visible.add(step.let);
      } else if ('lookup' in step) {
        declare(step.let, [...at, 'let']);
        read(step.lookup.key, [...at, 'lookup', 'key'], visible);
        visible.add(step.let);
      } else if ('calc' in step) {
        declare(step.let, [...at, 'let']);
        step.inputs.forEach((input, k) => read(input, [...at, 'inputs', k], visible));
        visible.add(step.let);
      } else if ('if' in step) {
        read(step.if, [...at, 'if'], visible);
        // names defined inside a branch are visible only inside it: each branch gets its own copy of the scope
        walk(step.then, [...at, 'then'], new Set(visible), inLoop);
        walk(step.else, [...at, 'else'], new Set(visible), inLoop);
      } else if ('for' in step) {
        // (c) no `for` inside a `for` body at any depth, through `if` included (inLoop travels down both branches)
        if (inLoop) throw new PlanRejected('NestedLoop', [...at, 'for']);
        // (d) the bound is a literal constant in range, never data
        const max: unknown = step.max;
        if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < MIN_LOOP_MAX || max > MAX_LOOP_MAX) {
          throw new PlanRejected('LoopBound', [...at, 'max']);
        }
        declare(step.for, [...at, 'for']);
        read(step.in, [...at, 'in'], visible);
        const inner = new Set(visible);
        inner.add(step.for);
        walk(step.do, [...at, 'do'], inner, true);
      } else if ('action' in step) {
        // (e) asset and chain_id are literals, never references
        const args: Record<string, unknown> = step.args;
        if (typeof args.asset !== 'string') throw new PlanRejected('DataDerivedAsset', [...at, 'args', 'asset']);
        if (step.action === 'evm_transfer' && typeof args.chain_id !== 'number') {
          throw new PlanRejected('DataDerivedAsset', [...at, 'args', 'chain_id']);
        }
        read(step.args.to, [...at, 'args', 'to'], visible);
        read(step.args.amount, [...at, 'args', 'amount'], visible);
      } else {
        read(step.say, [...at, 'say'], visible);
      }
    });
  };

  walk(plan, [], new Set<string>(), false);
}

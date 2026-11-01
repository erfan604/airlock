// AIR-180: property I-V of the plan analyzer (REDTEAM_ROUND3 R3-01). For a plan built from a small spec of pays:
//   safety   the signed bound of each payee is at most the sum, folded here by hand over the spec, of the per-instance maxima of the
//            instances that map to it (a payee that is not in the book, is chosen by data or has no static amount gets no bound);
//   utility  run through the interpreter (AIR-121), the proposals to each payee key are at most the instances the analyzer lists for that
//            key plus its instances with a null payee key, so no proposal can come from outside the analyzer's list.
// The generator is test/gen/analyze-plans.ts. A mutation that returns the hard cap for an unbounded amount fails the safety property
// (run once when the ticket was written, then reverted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { checkPlan } from '../src/dsl/index.ts';
import { analyzePlan, maxActionsFor, toOwnerBounds } from '../src/analyze/index.ts';
import type { Analysis } from '../src/analyze/index.ts';
import { run } from '../src/interpreter/index.ts';
import { loopsPlan, planOf, planSpecArb, worldArb } from './gen/analyze-plans.ts';
import type { PlanSpec, WorldSpec } from './gen/analyze-plans.ts';
import { ACCOUNTANT, LANDLORD, makeCtx, near } from './helpers/analyze-ctx.ts';
import { makeDeps, stubExtract, stubTools } from './helpers/interp.ts';

const RUNS = process.env.FC_RUNS === undefined ? 1000 : Math.trunc(+process.env.FC_RUNS);
const SEED = ((): number => {
  const s = process.env.FC_SEED;
  if (s === undefined || s === '') return 20261101;
  if (s === 'random') return Math.floor(Math.random() * 2 ** 31);
  return Math.trunc(+s);
})();

// == the independent fold over the spec ==
const KEY_OF: Record<string, string | undefined> = { accountant: ACCOUNTANT, landlord: LANDLORD, 'Accountant ': ACCOUNTANT, nobody: undefined };
// the cap of each payee in the fixture book (null for the landlord)
const CAP_OF: Record<string, bigint> = { [ACCOUNTANT]: near(5n), [LANDLORD]: 0n };

// a decimal text of the specs to yocto; 0n for anything that is not a positive amount (the interpreter and the analyzer refuse it)
function yocto(text: string): bigint {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (m === null) return 0n;
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > 24) return 0n;
  return BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, '0'));
}

interface Folded {
  maxima: Map<string, bigint>;
  instances: number;
}

function fold(spec: PlanSpec): Folded {
  const maxima = new Map<string, bigint>();
  let instances = 0;
  for (const pay of spec.pays) {
    const repeat = spec.loopMax !== null && pay.inLoop ? spec.loopMax : 1;
    instances += repeat;
    const key = pay.payee.kind === 'alias' ? KEY_OF[pay.payee.alias] : undefined;
    if (key === undefined) continue;
    const per = pay.amount.kind === 'literal' ? yocto(pay.amount.text) : pay.amount.kind === 'data' ? (CAP_OF[key] ?? 0n) : 0n;
    maxima.set(key, (maxima.get(key) ?? 0n) + per * BigInt(repeat));
  }
  return { maxima, instances };
}

const stats = { total: 0, bounded: 0, hasLoop: 0, hasIf: 0, proposed: 0, unbounded: 0, errored: 0 };

function bytes(a: Analysis): string {
  return JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

// == generator validity ==
test('generator validity: 2,000 specs build plans that pass checkPlan and are analysed without a throw', () => {
  const specs = fc.sample(planSpecArb, { numRuns: 2000, seed: 1 });
  assert.equal(specs.length, 2000);
  for (const spec of specs) {
    const a = analyzePlan(checkPlan(planOf(spec)), makeCtx('Pay the accountant 1'));
    assert.equal(a.errors.includes('UnsupportedShape'), false);
  }
});

// == I-V safety ==
test('I-V safety: no signed bound is wider than the sum of the per-instance maxima of the instances that map to it', () => {
  const property = fc.property(planSpecArb, fc.string(), (spec, ownerText) => {
    const a = analyzePlan(checkPlan(planOf(spec)), makeCtx(ownerText));
    const folded = fold(spec);
    stats.total += 1;
    if (spec.loopMax !== null && spec.pays.some((p) => p.inLoop)) stats.hasLoop += 1;
    if (spec.pays.some((p) => p.conditional)) stats.hasIf += 1;
    if (a.bounds.length > 0) stats.bounded += 1;
    if (spec.pays.some((p) => p.amount.kind !== 'literal')) stats.unbounded += 1;
    if (a.errors.length > 0) stats.errored += 1;
    const where = `spec ${JSON.stringify(spec)} bounds ${bytes(a)}`;
    for (const b of a.bounds) {
      const sum = folded.maxima.get(b.payeeKey);
      assert.ok(sum !== undefined, `a bound for a payee the spec never reaches statically: ${where}`);
      assert.ok(b.maxTotal > 0n, `a zero bound: ${where}`);
      assert.ok(b.maxTotal <= sum, `bound ${b.maxTotal} above the folded maxima ${sum}: ${where}`);
    }
    // the instance count is the fold of the repeats, with or without a limit
    assert.equal(a.maxActions, Math.max(1, folded.instances), where);
    assert.equal(a.instances.reduce((n, i) => n + i.repeat, 0), folded.instances, where);
  });
  const started = performance.now();
  fc.assert(property, { numRuns: RUNS, seed: SEED });
  console.log(`IV_SAFETY seed=${SEED} runs=${RUNS} ms=${Math.round(performance.now() - started)}`);
});

test('I-V exactness: a bound equals the folded maxima unless it is dropped by the hard cap, and a quick cap overrun is an error', () => {
  const hardCap = near(100n);
  const quickCap = near(50n);
  const property = fc.property(planSpecArb, (spec) => {
    const a = analyzePlan(checkPlan(planOf(spec)), makeCtx(''));
    const folded = fold(spec);
    const ceiling = hardCap * BigInt(Math.max(1, folded.instances));
    const where = `spec ${JSON.stringify(spec)} analysis ${bytes(a)}`;
    for (const [key, sum] of folded.maxima) {
      const bound = a.bounds.find((b) => b.payeeKey === key);
      if (sum === 0n || sum > ceiling) assert.equal(bound, undefined, `unexpected bound for ${key}: ${where}`);
      else assert.equal(bound?.maxTotal, sum, `wrong bound for ${key}: ${where}`);
      if (bound !== undefined && sum > quickCap) assert.ok(a.errors.includes('ExceedsQuickCap'), where);
    }
    assert.equal(a.errors.includes('ExceedsQuickCap'), a.bounds.some((b) => b.maxTotal > quickCap), where);
    assert.equal(a.errors.includes('NoBounds'), a.bounds.length === 0, where);
    assert.equal(a.errors.includes('TooManyActions'), folded.instances > 20, where);
  });
  fc.assert(property, { numRuns: RUNS, seed: SEED });
});

// == I-V utility ==
function worldDeps(world: WorldSpec) {
  const inbox = Array.from({ length: world.inbox }, (_, i) => ({ id: `m${i}`, from: 'friend@example.test', subject: 's', body: 'b' }));
  return makeDeps({
    tools: stubTools({ read_inbox: { raw: inbox, label: 'Untrusted:email' }, get_price: { raw: '3.5', label: 'Oracle' } }).tools,
    extract: stubExtract({ amount: world.amount, who: world.who, flag: world.flag }).extract,
  });
}

test('I-V utility: every proposal of a run comes from an instance the analyzer lists, or from one with no static payee', async () => {
  const property = fc.asyncProperty(planSpecArb, worldArb, async (spec, world) => {
    const plan = checkPlan(planOf(spec));
    const a = analyzePlan(plan, makeCtx(''));
    const result = await run(plan, worldDeps(world));
    if (!result.ok) return; // an abort proposes nothing: all or nothing
    stats.proposed += result.proposed.length > 0 ? 1 : 0;
    const listed = new Map<string, number>();
    let unkeyed = 0;
    for (const inst of a.instances) {
      if (inst.payeeKey === null) unkeyed += inst.repeat;
      else listed.set(inst.payeeKey, (listed.get(inst.payeeKey) ?? 0) + inst.repeat);
    }
    const proposals = new Map<string, number>();
    for (const p of result.proposed) proposals.set(p.payee, (proposals.get(p.payee) ?? 0) + 1);
    const where = `spec ${JSON.stringify(spec)} world ${JSON.stringify(world)} analysis ${bytes(a)} proposals ${JSON.stringify([...proposals])}`;
    for (const [key, n] of proposals) assert.ok(n <= (listed.get(key) ?? 0) + unkeyed, `proposals to ${key} are outside the analyzer list: ${where}`);
    const all = [...proposals.values()].reduce((x, y) => x + y, 0);
    assert.ok(all <= a.maxActions, `more proposals than maxActions: ${where}`);
  });
  await fc.assert(property, { numRuns: RUNS, seed: SEED });
});

// == more properties ==
test('the owner words never change a bound: the same plan analysed with and without them has the same bounds and instances', () => {
  const property = fc.property(planSpecArb, (spec) => {
    const plan = checkPlan(planOf(spec));
    const bare = analyzePlan(plan, makeCtx(''));
    const words = analyzePlan(plan, makeCtx('Pay the accountant 1 and the landlord 2.5 and 60 and 150 and 0.1 and 3 and 4.9 and 5'));
    // the words may change a preview line and the inOwnerWords flag of a literal, nothing that decides a bound or an error
    const decisive = (a: Analysis) => ({
      bounds: a.bounds,
      errors: a.errors,
      maxActions: a.maxActions,
      asks: a.asksYou,
      instances: a.instances.map((i) => ({ path: i.path, payeeKey: i.payeeKey, assetId: i.assetId, bound: i.bound, boundSource: i.boundSource, repeat: i.repeat, conditional: i.conditional, kind: i.amount.kind })),
    });
    assert.deepEqual(decisive(bare), decisive(words));
  });
  fc.assert(property, { numRuns: RUNS, seed: SEED });
});

test('maxActionsFor agrees with the analysis, and toOwnerBounds is the bounds list when there is no error', () => {
  const property = fc.property(planSpecArb, (spec) => {
    const plan = checkPlan(planOf(spec));
    const a = analyzePlan(plan, makeCtx(''));
    assert.equal(maxActionsFor(plan), a.maxActions);
    if (a.errors.length > 0) {
      assert.throws(() => toOwnerBounds(a));
      return;
    }
    const wire = toOwnerBounds(a);
    assert.deepEqual(wire, a.bounds.map((b) => ({ payee_key: b.payeeKey, max_total: b.maxTotal.toString() })));
    const keys = wire.map((b) => b.payee_key);
    assert.deepEqual(keys, [...keys].sort());
    for (const b of wire) assert.notEqual(b.max_total, '0');
  });
  fc.assert(property, { numRuns: RUNS, seed: SEED });
});

test('two or more loops are always UnsupportedShape and nothing else', () => {
  const property = fc.property(fc.integer({ min: 2, max: 4 }), fc.integer({ min: 1, max: 20 }), (n, max) => {
    const a = analyzePlan(checkPlan(loopsPlan(n, max)), makeCtx(''));
    assert.deepEqual(a, { instances: [], bounds: [], maxActions: 0, asksYou: [], preview: [], errors: ['UnsupportedShape'] });
  });
  fc.assert(property, { numRuns: 200, seed: SEED });
});

test('non-vacuity: the plans use loops, ifs, bounded and unbounded amounts, and the runs propose payments', () => {
  const percent = (n: number): number => (100 * n) / Math.max(stats.total, 1);
  console.log(`IV_STATS ${JSON.stringify(stats)}`);
  assert.ok(stats.total >= RUNS, `only ${stats.total} safety runs`);
  assert.ok(percent(stats.bounded) >= 40, `a bound in ${percent(stats.bounded).toFixed(1)} percent of plans`);
  assert.ok(percent(stats.hasLoop) >= 15, `a loop in ${percent(stats.hasLoop).toFixed(1)} percent of plans`);
  assert.ok(percent(stats.hasIf) >= 30, `an if in ${percent(stats.hasIf).toFixed(1)} percent of plans`);
  assert.ok(percent(stats.unbounded) >= 40, `an amount without a literal in ${percent(stats.unbounded).toFixed(1)} percent of plans`);
  assert.ok(percent(stats.errored) >= 5, `an error in ${percent(stats.errored).toFixed(1)} percent of plans`);
  assert.ok(stats.proposed >= RUNS / 5, `only ${stats.proposed} runs proposed a payment`);
});

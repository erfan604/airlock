// AIR-126: strict noninterference on the real interpreter. Two runs that differ only in untrusted inputs, when both complete, produce
// identical fully trusted payments (property 1) and identical trusted recipients (property 2, the K2 statement). The Lean theorem is about
// the model of the interpreter; this test is about the code. An abort in one world only is the availability channel of the known
// limitations: such a pair is skipped, and the non-vacuity floors keep the property from passing because nothing happens.
//
// AIR_SRC is the only seam: an absolute path to a `src` tree (default the real runtime/src). The canary runs the same file against four
// deliberately broken copies of the interpreter (scripts/prop-canary.sh) and every one of them must fail it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fc from 'fast-check';
import { isPcTrusted, isTrusted, isValueTrusted, labelsToBits } from '../src/dsl/index.ts';
import type { LabelName } from '../src/dsl/index.ts';
import type { Extractor, Proposed, RunDeps, RunResult, Tools } from '../src/interpreter/index.ts';
import { planArb, trustedWorldArb, untrustedWorldArb } from './gen/plans.ts';
import type { TrustedWorld, UntrustedWorld } from './gen/plans.ts';

const SRC = process.env.AIR_SRC ?? fileURLToPath(new URL('../src', import.meta.url));
const interp = (await import(pathToFileURL(join(SRC, 'interpreter/index.ts')).href)) as typeof import('../src/interpreter/index.ts');
const dsl = (await import(pathToFileURL(join(SRC, 'dsl/index.ts')).href)) as typeof import('../src/dsl/index.ts');

const RUNS = process.env.FC_RUNS === undefined ? 1000 : Math.trunc(+process.env.FC_RUNS);
const SEED = ((): number => {
  const s = process.env.FC_SEED;
  if (s === undefined || s === '') return 20261101;
  if (s === 'random') return Math.floor(Math.random() * 2 ** 31);
  return Math.trunc(+s);
})();

// ---- the world a run sees ----
function depsFor(t: TrustedWorld, u: UntrustedWorld): RunDeps {
  const tools: Tools = {
    async call(name) {
      switch (name) {
        case 'read_inbox':
          return { raw: structuredClone(u.inbox), label: 'Untrusted:email' };
        case 'get_price':
          return { raw: t.price, label: 'Oracle' };
        case 'get_balance':
          return { raw: [...t.balances], label: 'Oracle' };
        default:
          throw new Error(`tool ${name} is not served`);
      }
    },
  };
  // the n-th extraction executed gets entry n modulo the list: only untrusted data decides what an extraction returns
  let n = 0;
  const extract: Extractor = async () => structuredClone(u.ext[n++ % u.ext.length] ?? {});
  return {
    tools,
    extract,
    book: { resolve: (alias) => ({ accountant: 'near:accountant.testnet', landlord: 'near:landlord.testnet' })[alias as 'accountant'] },
    decimalsOf: (asset) => ({ near: 24, 'evm:84532:native': 18 })[asset as 'near'],
    now: () => 0,
  };
}

// ---- what the properties compare ----
const bits = (names: readonly LabelName[]): number => labelsToBits(names);

function trustedProposals(r: RunResult): Proposed[] {
  if (!r.ok) return [];
  return r.proposed.filter((p) => isTrusted(bits(p.recipientLabels)) && isValueTrusted(bits(p.amountLabels)) && isPcTrusted(bits(p.pc)));
}

// origins carry call ids that depend on execution order, which differs legitimately between worlds
function trustedPayments(r: RunResult) {
  return trustedProposals(r).map((p) => ({
    action: p.action,
    payee: p.payee,
    asset: p.asset,
    amount: p.amount,
    recipientLabels: p.recipientLabels,
    amountLabels: p.amountLabels,
    pc: p.pc,
  }));
}

function trustedRecipients(r: RunResult): string[] {
  if (!r.ok) return [];
  return r.proposed.filter((p) => isTrusted(bits(p.recipientLabels)) && isPcTrusted(bits(p.pc))).map((p) => p.payee);
}

const asText = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

function features(plan: unknown): { ifs: boolean; loops: boolean; extracts: boolean } {
  const text = JSON.stringify(plan);
  return { ifs: text.includes('"if":'), loops: text.includes('"for":'), extracts: text.includes('"extract":') };
}

interface Pair {
  status: 'skipped' | 'checked';
  r1: RunResult;
  r2: RunResult;
}

// runs the plan in two worlds that share the oracle values and differ in the untrusted inputs
async function runPair(planJson: unknown, t: TrustedWorld, u1: UntrustedWorld, u2: UntrustedWorld): Promise<Pair> {
  const checked = dsl.checkPlan(planJson);
  const r1 = await interp.run(checked, depsFor(t, u1));
  const r2 = await interp.run(checked, depsFor(t, u2));
  return { status: r1.ok && r2.ok ? 'checked' : 'skipped', r1, r2 };
}

const stats = { total: 0, both: 0, trusted: 0, differ: 0, ifs: 0, loops: 0, extracts: 0 };

// ---- the generator ----
test('generator validity: 2,000 plans each pass checkPlan', () => {
  const plans = fc.sample(planArb, { numRuns: 2000, seed: 1 });
  assert.equal(plans.length, 2000);
  let longest = 0;
  for (const plan of plans) {
    dsl.checkPlan(plan);
    longest = Math.max(longest, (JSON.stringify(plan).match(/"(let|action|say|if|for)":/g) ?? []).length);
  }
  assert.ok(longest > 8, `the longest plan has only ${longest} steps`);
});

// ---- the properties ----
test('properties 1 and 2: both complete implies identical trusted payments and identical trusted recipients', async () => {
  const property = fc.asyncProperty(planArb, trustedWorldArb, untrustedWorldArb, untrustedWorldArb, async (planJson, t, u1, u2) => {
    stats.total += 1;
    const f = features(planJson);
    if (f.ifs) stats.ifs += 1;
    if (f.loops) stats.loops += 1;
    if (f.extracts) stats.extracts += 1;
    const { status, r1, r2 } = await runPair(planJson, t, u1, u2);
    if (status === 'skipped') return; // an abort in one world only is the availability channel
    stats.both += 1;
    const p1 = trustedPayments(r1);
    const p2 = trustedPayments(r2);
    if (p1.length > 0 || p2.length > 0) stats.trusted += 1;
    if (r1.ok && r2.ok && asText(r1.proposed) !== asText(r2.proposed)) stats.differ += 1;
    const where = `plan ${JSON.stringify(planJson)} trusted ${JSON.stringify(t)} untrusted ${JSON.stringify(u1)} and ${JSON.stringify(u2)}`;
    assert.deepStrictEqual(p1, p2, `trusted payments differ: ${where}`);
    assert.deepStrictEqual(trustedRecipients(r1), trustedRecipients(r2), `trusted recipients differ: ${where}`);
  });
  const started = performance.now();
  try {
    await fc.assert(property, { numRuns: RUNS, seed: SEED });
  } catch (e) {
    console.log(`NI_PROP FAILED seed=${SEED}`);
    throw e;
  } finally {
    console.log(
      `NI_PROP seed=${SEED} runs=${RUNS} ms=${Math.round(performance.now() - started)} both=${stats.both} trusted=${stats.trusted} differ=${stats.differ} ifs=${stats.ifs} loops=${stats.loops} extracts=${stats.extracts}`,
    );
  }
});

test('non-vacuity: the runs complete, pay, differ and use if, for and extract often enough to mean something', () => {
  const percent = (n: number): number => (100 * n) / Math.max(stats.total, 1);
  assert.ok(stats.total >= RUNS, `only ${stats.total} runs`);
  assert.ok(percent(stats.both) >= 50, `both complete in ${percent(stats.both).toFixed(1)} percent of runs`);
  assert.ok(percent(stats.trusted) >= 20, `a trusted payment in ${percent(stats.trusted).toFixed(1)} percent of runs`);
  assert.ok(percent(stats.differ) >= 10, `different proposal lists in ${percent(stats.differ).toFixed(1)} percent of runs`);
  assert.ok(percent(stats.ifs) >= 8, `an if in ${percent(stats.ifs).toFixed(1)} percent of plans`);
  assert.ok(percent(stats.loops) >= 8, `a for in ${percent(stats.loops).toFixed(1)} percent of plans`);
  assert.ok(percent(stats.extracts) >= 30, `an extract in ${percent(stats.extracts).toFixed(1)} percent of plans`);
});

// ---- fixed examples ----
const T: TrustedWorld = { price: '3.5', balances: ['1', '2', '3'] };
const mail = (id: string) => ({ id, from: 'friend@example.com', subject: 's', body: 'b' });
const U = (inbox: number, ext: Record<string, unknown>[] = [{ amount: '1', who: 'accountant', flag: true }]): UntrustedWorld => ({
  inbox: Array.from({ length: inbox }, (_, i) => mail(`m${i}`)),
  ext,
});

test('the spike regression: re-binding a name inside a branch is rejected before anything runs, which is why the generator never re-binds', () => {
  const plan = [
    { let: 'x', calc: 'sum', inputs: [5, 0] },
    { let: 'mail', call: 'read_inbox' },
    { if: { ref: 'mail' }, then: [{ let: 'x', calc: 'sum', inputs: [7, 0] }] },
    { let: 'same', calc: 'eq', inputs: [{ ref: 'x' }, 5] },
    { if: { ref: 'same' }, then: [{ action: 'transfer', args: { to: 'accountant.testnet', amount: '1', asset: 'near' } }] },
  ];
  assert.throws(
    () => dsl.checkPlan(plan),
    (e: unknown) => e instanceof dsl.PlanRejected && e.code === 'Rebind' && JSON.stringify(e.path) === JSON.stringify([2, 'then', 0, 'let']),
  );
});

test('a for over the inbox pays under the email pc, so nothing in it is a trusted payment even with a trusted recipient and amount', async () => {
  const plan = [{ let: 'mail', call: 'read_inbox' }, { for: 'm', in: { ref: 'mail' }, max: 5, do: [{ action: 'transfer', args: { to: 'landlord.testnet', amount: '1', asset: 'near' } }] }];
  const { r1 } = await runPair(plan, T, U(3), U(3));
  assert.ok(r1.ok);
  assert.equal(r1.proposed.length, 3);
  for (const p of r1.proposed) assert.ok(p.pc.includes('Untrusted:email'));
  assert.deepEqual(trustedPayments(r1), []);
});

test('a for over a trusted list of 3 balances pays 3 times under the pc Owner and Oracle, all trusted', async () => {
  const plan = [
    { let: 'bal', call: 'get_balance', args: { asset: 'near' } },
    { for: 'b', in: { ref: 'bal' }, max: 5, do: [{ action: 'transfer', args: { to: 'landlord.testnet', amount: '1', asset: 'near' } }] },
  ];
  const { status, r1, r2 } = await runPair(plan, T, U(0), U(4));
  assert.equal(status, 'checked');
  assert.ok(r1.ok && r2.ok);
  assert.equal(r1.proposed.length, 3);
  for (const p of r1.proposed) assert.deepEqual(p.pc, ['Owner', 'Oracle']);
  assert.equal(trustedPayments(r1).length, 3);
  assert.deepEqual(trustedPayments(r1), trustedPayments(r2));
});

test('availability: a flag that is true in one world and the string yes in the other aborts in one world only, and the pair is skipped', async () => {
  const plan = [
    { let: 'mail', call: 'read_inbox' },
    { let: 'e', extract: { from: { ref: 'mail' }, schema: { amount: 'amount', who: 'text', flag: 'bool' } } },
    { if: { ref: 'e', path: ['flag'] }, then: [{ say: 'urgent' }] },
  ];
  const { status, r1, r2 } = await runPair(plan, T, U(1, [{ amount: '1', who: 'accountant', flag: true }]), U(1, [{ amount: '1', who: 'accountant', flag: 'yes' }]));
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.ok(!r2.ok && r2.cause.code === 'BadCondition');
  assert.equal(status, 'skipped', 'the property skips such a pair: this is the availability channel of the known limitations');
});

test('trustedPayments keeps a proposal only when recipient, amount and pc are all trusted, and leaves out the origins', () => {
  const base = { action: 'transfer', target: { kind: 'near' }, payee: 'near:a.testnet', asset: 'near', amount: 1n, origins: { recipient: ['call:1'], amount: [], pc: [] } } as const;
  const make = (recipientLabels: LabelName[], amountLabels: LabelName[], pc: LabelName[]): RunResult =>
    ({ ok: true, proposed: [{ ...base, recipientLabels, amountLabels, pc } as unknown as Proposed], trace: [], says: [] });
  assert.equal(trustedPayments(make(['Book'], ['Owner'], ['Owner'])).length, 1);
  assert.equal(trustedPayments(make(['Book'], ['Oracle'], ['Owner', 'Oracle'])).length, 1);
  assert.equal(trustedPayments(make(['Oracle'], ['Owner'], ['Owner'])).length, 0);
  assert.equal(trustedPayments(make(['Book'], ['Untrusted:email'], ['Owner'])).length, 0);
  assert.equal(trustedPayments(make(['Book'], ['Owner'], ['Owner', 'Untrusted:quarantine'])).length, 0);
  assert.equal(trustedPayments(make(['Owner', 'Unresolved'], ['Owner'], ['Owner'])).length, 0);
  assert.ok(!('origins' in (trustedPayments(make(['Book'], ['Owner'], ['Owner']))[0] ?? {})));
  assert.deepEqual(trustedRecipients(make(['Book'], ['Untrusted:email'], ['Owner'])), ['near:a.testnet']);
  assert.deepEqual(trustedRecipients(make(['Book'], ['Owner'], ['Owner', 'Untrusted:email'])), []);
  assert.deepEqual(trustedPayments({ ok: false, cause: { step: [0], code: 'BadAmount', labels: [] }, trace: [] }), []);
});

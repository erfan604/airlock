// AIR-180: generators for the analyzer property I-V. A plan is built from a small spec of pays, so the test can fold the same spec by hand
// (independently of the analyzer) and compare. The spec has at most one loop (cut ladder rung 8): the pays flagged `inLoop` sit in it and
// run `loopMax` times, the others run once. Every plan is valid by construction and passes checkPlan.
//
// The plan always starts with the same three steps: `mail` (read_inbox, a list from the email channel), `inv` (an extraction from it with
// the fields amount, who and flag) and `price` (get_price, an oracle). A pay is a lookup followed by a transfer, optionally under an `if`
// on the extracted flag.
import fc from 'fast-check';

export type PayeeSpec = { kind: 'alias'; alias: 'accountant' | 'landlord' | 'nobody' | 'Accountant ' } | { kind: 'data' };
export type AmountSpec = { kind: 'literal'; text: string } | { kind: 'data' } | { kind: 'oracle' };

export interface PaySpec {
  payee: PayeeSpec;
  amount: AmountSpec;
  inLoop: boolean;
  conditional: boolean;
}

export interface PlanSpec {
  pays: PaySpec[];
  /** 1 to 3 when the plan has a loop, null when it has none */
  loopMax: number | null;
}

/** What a run sees: the inbox length, the answer of every extraction (who chosen by the data) and the flag. */
export interface WorldSpec {
  inbox: number;
  amount: string;
  who: string;
  flag: boolean;
}

// '0' and 'abc' are bad amounts (the interpreter aborts, the analyzer gives no bound); '2.50' is the same value as '2.5'
const LITERALS = ['1', '2.5', '2.50', '0.1', '3', '4.9', '5', '60', '150', '0', 'abc'] as const;

export const payeeArb: fc.Arbitrary<PayeeSpec> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('accountant', 'landlord', 'nobody', 'Accountant ').map((alias): PayeeSpec => ({ kind: 'alias', alias })) },
  { weight: 2, arbitrary: fc.constant<PayeeSpec>({ kind: 'data' }) },
);

export const amountArb: fc.Arbitrary<AmountSpec> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...LITERALS).map((text): AmountSpec => ({ kind: 'literal', text })) },
  { weight: 4, arbitrary: fc.constant<AmountSpec>({ kind: 'data' }) },
  { weight: 2, arbitrary: fc.constant<AmountSpec>({ kind: 'oracle' }) },
);

export const payArb: fc.Arbitrary<PaySpec> = fc.record({ payee: payeeArb, amount: amountArb, inLoop: fc.boolean(), conditional: fc.boolean() });

export const planSpecArb: fc.Arbitrary<PlanSpec> = fc.record({
  pays: fc.array(payArb, { minLength: 1, maxLength: 5 }),
  loopMax: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
});

export const worldArb: fc.Arbitrary<WorldSpec> = fc.record({
  inbox: fc.integer({ min: 0, max: 5 }),
  amount: fc.constantFrom('1.5', '0.5', '3', '7'),
  who: fc.constantFrom('accountant', 'landlord', 'ghost'),
  flag: fc.boolean(),
});

const ref = (name: string, path?: string[]): unknown => (path === undefined ? { ref: name } : { ref: name, path });

const amountValue = (a: AmountSpec): unknown => {
  switch (a.kind) {
    case 'literal':
      return a.text;
    case 'data':
      return ref('inv', ['amount']);
    case 'oracle':
      return ref('price');
  }
};

/** The plan JSON of a spec. The pays outside the loop come first in order, then the loop with the pays flagged inLoop. */
export function planOf(spec: PlanSpec): unknown[] {
  const head: unknown[] = [
    { let: 'mail', call: 'read_inbox' },
    { let: 'inv', extract: { from: ref('mail'), schema: { amount: 'amount', who: 'text', flag: 'bool' } } },
    { let: 'price', call: 'get_price', args: { asset: 'near' } },
  ];
  const outside: unknown[] = [];
  const inside: unknown[] = [];
  spec.pays.forEach((pay, i) => {
    const steps = stepsOf(pay, i);
    if (spec.loopMax !== null && pay.inLoop) inside.push(...steps);
    else outside.push(...steps);
  });
  const loop = spec.loopMax !== null && inside.length > 0 ? [{ for: 'it', in: ref('mail'), max: spec.loopMax, do: inside }] : [];
  return [...head, ...outside, ...loop];
}

// the steps of one pay: the lookup always at the top level of its scope, the transfer inside the `if` when conditional (the lookup name is
// defined in the same scope as its use in both cases, so rule 12 holds)
function stepsOf(spec: PaySpec, index: number): unknown[] {
  const name = `p${index}`;
  const key = spec.payee.kind === 'alias' ? spec.payee.alias : ref('inv', ['who']);
  const lookup = { let: name, lookup: { key } };
  const transfer = { action: 'transfer', args: { to: ref(name), amount: amountValue(spec.amount), asset: 'near' } };
  return spec.conditional ? [lookup, { if: ref('inv', ['flag']), then: [transfer], else: [] }] : [lookup, transfer];
}

/** Two or more loops, for the UnsupportedShape property: `n` loops over the inbox, each paying the landlord. */
export function loopsPlan(n: number, max: number): unknown[] {
  const loops = Array.from({ length: n }, (_, i) => ({
    for: `it${i}`,
    in: ref('mail'),
    max,
    do: [{ action: 'transfer', args: { to: 'landlord.testnet', amount: '1', asset: 'near' } }],
  }));
  return [{ let: 'mail', call: 'read_inbox' }, ...loops];
}


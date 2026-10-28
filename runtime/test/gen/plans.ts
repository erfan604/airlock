// Generators for the noninterference property (AIR-126): plans valid by construction, the trusted world (oracle values, the same in both
// runs) and the untrusted world (tool output and extractor output, drawn independently for the two runs). `fc.gen()` is the builder
// style that keeps shrinking: a plan is a pure function of the values drawn through `g`, so a counterexample shrinks to a short plan.
// The plans use three tools only: `read_inbox` (a list, Untrusted:email), `get_price` (a decimal string, Oracle) and `get_balance` (a list
// of decimal strings, Oracle: a trusted list, so loops with a trusted bound exist; this list is a model-only shape served by the test's own
// Tools object, the product tool returns one decimal string).
import fc from 'fast-check';

type G = fc.GeneratorValue;
type Json = unknown;
type Kind = 'inbox' | 'balances' | 'price' | 'ext' | 'payee' | 'num' | 'bool' | 'mail' | 'dec';
interface Var {
  name: string;
  kind: Kind;
}
interface Ctx {
  g: G;
  next: number;
  steps: number;
}

// rule 12 allows 64 steps counted recursively; the pinned limit of the generator is 60, and a compound step is only started with room left
const MAX_STEPS = 60;
const STOP_AT = 54;
const MAX_IF_DEPTH = 2;

const nat = (g: G, max: number): number => g(fc.nat, { max });
const pick = <T>(g: G, xs: readonly T[]): T => xs[nat(g, xs.length - 1)] as T;
const chance = (g: G, percent: number): boolean => nat(g, 99) < percent;

function weighted<T>(g: G, options: readonly (readonly [number, T])[]): T {
  const total = options.reduce((sum, [w]) => sum + w, 0);
  let r = nat(g, total - 1);
  for (const [w, value] of options) {
    if (r < w) return value;
    r -= w;
  }
  return (options[options.length - 1] as readonly [number, T])[1];
}

const ref = (name: string, path?: string[]): Json => (path === undefined ? { ref: name } : { ref: name, path });
const fresh = (c: Ctx): string => `v${c.next++}`;
const withKind = (scope: readonly Var[], ...kinds: Kind[]): Var[] => scope.filter((v) => kinds.includes(v.kind));

const LITERAL_AMOUNTS = ['1', '2.5', '0.5', '100', '3'] as const;
const NEAR_ACCOUNTS = ['accountant.testnet', 'landlord.testnet', 'alice.testnet', 'bob.testnet'] as const;
const ALIASES = ['accountant', 'landlord', 'nobody'] as const;
const EVM_ADDRESSES = ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045', '0x00000000000000000000000000000000000000ab'] as const;

function push(c: Ctx, out: Json[], step: Json): void {
  c.steps += 1;
  out.push(step);
}

// a numeric operand: a literal, the oracle price, an extracted amount, an earlier calc result or a balance element
function numericOperand(c: Ctx, scope: readonly Var[]): Json {
  const options: (readonly [number, () => Json])[] = [[3, () => pick(c.g, ['1', '2.5', '0', '3', '10', 7] as const)]];
  const prices = withKind(scope, 'price', 'num', 'dec');
  const exts = withKind(scope, 'ext');
  if (prices.length > 0) options.push([3, () => ref(pick(c.g, prices).name)]);
  if (exts.length > 0) options.push([3, () => ref(pick(c.g, exts).name, ['amount'])]);
  return weighted(c.g, options)();
}

function dataSources(scope: readonly Var[]): Var[] {
  return withKind(scope, 'inbox', 'balances', 'price', 'ext', 'num', 'mail', 'dec');
}

function genCall(c: Ctx, scope: Var[], out: Json[]): void {
  const name = fresh(c);
  const tool = pick(c.g, ['read_inbox', 'get_price', 'get_balance'] as const);
  const kind: Kind = tool === 'read_inbox' ? 'inbox' : tool === 'get_price' ? 'price' : 'balances';
  push(c, out, tool === 'read_inbox' ? { let: name, call: tool } : { let: name, call: tool, args: { asset: 'near' } });
  scope.push({ name, kind });
}

function genExtract(c: Ctx, scope: Var[], out: Json[]): void {
  const from = pick(c.g, dataSources(scope));
  const name = fresh(c);
  push(c, out, { let: name, extract: { from: ref(from.name), schema: { amount: 'amount', who: 'text', flag: 'bool' } } });
  scope.push({ name, kind: 'ext' });
}

function genLookup(c: Ctx, scope: Var[], out: Json[]): void {
  const exts = withKind(scope, 'ext');
  const key: Json = exts.length > 0 && chance(c.g, 75) ? ref(pick(c.g, exts).name, ['who']) : pick(c.g, ALIASES);
  const name = fresh(c);
  push(c, out, { let: name, lookup: { key } });
  scope.push({ name, kind: 'payee' });
}

const ARITHMETIC = ['sum', 'min', 'max', 'sub', 'mul', 'div'] as const;
const COMPARISON = ['gt', 'lt', 'ge', 'le', 'eq'] as const;

function genCalc(c: Ctx, scope: Var[], out: Json[]): void {
  const op = weighted<(typeof ARITHMETIC)[number] | (typeof COMPARISON)[number]>(c.g, [
    [2, 'sum'], [1, 'min'], [1, 'max'], [1, 'sub'], [1, 'mul'], [2, 'div'], [2, 'gt'], [1, 'lt'], [1, 'ge'], [1, 'le'], [2, 'eq'],
  ]);
  const name = fresh(c);
  let inputs: Json[];
  if (op === 'sum' || op === 'min' || op === 'max') {
    inputs = Array.from({ length: 1 + nat(c.g, 2) }, () => numericOperand(c, scope));
  } else if (op === 'div') {
    // the divisor may be an extracted number: a failing step that depends on the data
    const exts = withKind(scope, 'ext');
    const divisor: Json = exts.length > 0 && chance(c.g, 50) ? ref(pick(c.g, exts).name, ['amount']) : numericOperand(c, scope);
    inputs = [numericOperand(c, scope), divisor];
  } else if (op === 'eq' && withKind(scope, 'ext').length > 0 && chance(c.g, 40)) {
    // a string comparison: the extracted `who` against an alias
    inputs = [ref(pick(c.g, withKind(scope, 'ext')).name, ['who']), pick(c.g, ALIASES)];
  } else {
    inputs = [numericOperand(c, scope), numericOperand(c, scope)];
  }
  push(c, out, { let: name, calc: op, inputs });
  scope.push({ name, kind: (COMPARISON as readonly string[]).includes(op) ? 'bool' : 'num' });
}

function boolConditions(scope: readonly Var[]): Json[] {
  return [...withKind(scope, 'ext').map((v) => ref(v.name, ['flag'])), ...withKind(scope, 'bool').map((v) => ref(v.name))];
}

// a payment: the recipient is a payee reference, a literal address or an extracted name; the asset and the chain id are literals
function genAction(c: Ctx, scope: Var[], out: Json[]): void {
  const payees = withKind(scope, 'payee');
  const exts = withKind(scope, 'ext');
  const evm = chance(c.g, 25);
  const toOptions: (readonly [number, () => Json])[] = [[2, () => (evm ? pick(c.g, EVM_ADDRESSES) : pick(c.g, NEAR_ACCOUNTS))]];
  if (payees.length > 0) toOptions.push([4, () => ref(pick(c.g, payees).name)]);
  if (!evm && exts.length > 0) toOptions.push([2, () => ref(pick(c.g, exts).name, ['who'])]);
  const to = weighted(c.g, toOptions)();
  const toIsPayee = typeof to === 'object' && payees.some((p) => (to as { ref: string }).ref === p.name);
  const amount: Json =
    toIsPayee && chance(c.g, 50)
      ? weighted<Json>(c.g, [[1, pick(c.g, LITERAL_AMOUNTS)], [1, withKind(scope, 'price').length > 0 ? ref(pick(c.g, withKind(scope, 'price')).name) : '1']])
      : chance(c.g, 40)
        ? pick(c.g, LITERAL_AMOUNTS)
        : numericOperand(c, scope);
  push(
    c,
    out,
    evm
      ? { action: 'evm_transfer', args: { to, amount, asset: 'evm:84532:native', chain_id: 84532 } }
      : { action: 'transfer', args: { to, amount, asset: 'near' } },
  );
}

// the S03 skeleton: an extraction, a lookup keyed by its `who`, then a payment to that payee with a trusted literal amount
function genSkeleton(c: Ctx, scope: Var[], out: Json[]): void {
  if (dataSources(scope).length === 0) genCall(c, scope, out);
  genExtract(c, scope, out);
  const ext = scope[scope.length - 1] as Var;
  const payee = fresh(c);
  push(c, out, { let: payee, lookup: { key: ref(ext.name, ['who']) } });
  scope.push({ name: payee, kind: 'payee' });
  push(c, out, { action: 'transfer', args: { to: ref(payee), amount: pick(c.g, ['1', '2.5']), asset: 'near' } });
}

function genBlock(c: Ctx, scope: Var[], ifDepth: number, inLoop: boolean, count: number, out: Json[]): void {
  for (let i = 0; i < count && c.steps < STOP_AT; i++) genStep(c, scope, ifDepth, inLoop, out);
}

function genIf(c: Ctx, scope: Var[], ifDepth: number, inLoop: boolean, out: Json[]): void {
  const cond = pick(c.g, boolConditions(scope));
  // reserve the step of the if itself, then fill the branches with their own scope copies (names made inside are forgotten after)
  const step: { if: Json; then: Json[]; else?: Json[] } = { if: cond, then: [] };
  push(c, out, step);
  genBlock(c, scope.slice(), ifDepth + 1, inLoop, 1 + nat(c.g, 2), step.then);
  if (chance(c.g, 50)) {
    step.else = [];
    genBlock(c, scope.slice(), ifDepth + 1, inLoop, 1 + nat(c.g, 1), step.else);
  }
}

function genFor(c: Ctx, scope: Var[], ifDepth: number, out: Json[]): void {
  const lists = withKind(scope, 'inbox', 'balances');
  const list = pick(c.g, lists);
  const name = fresh(c);
  const step: { for: string; in: Json; max: number; do: Json[] } = { for: name, in: ref(list.name), max: 1 + nat(c.g, 4), do: [] };
  push(c, out, step);
  const inner: Var[] = [...scope, { name, kind: list.kind === 'inbox' ? 'mail' : 'dec' }];
  genBlock(c, inner, ifDepth, true, 1 + nat(c.g, 2), step.do);
}

function genStep(c: Ctx, scope: Var[], ifDepth: number, inLoop: boolean, out: Json[]): void {
  if (nat(c.g, 7) === 0) {
    genSkeleton(c, scope, out);
    return;
  }
  const data = dataSources(scope);
  const kind = weighted<string>(c.g, [
    [data.length < 3 ? 3 : 1, 'call'],
    [data.length > 0 ? 2 : 0, 'extract'],
    [data.length > 0 ? 2 : 0, 'lookup'],
    [3, 'calc'],
    [boolConditions(scope).length > 0 && ifDepth < MAX_IF_DEPTH && c.steps < STOP_AT - 8 ? 3 : 0, 'if'],
    [!inLoop && withKind(scope, 'inbox', 'balances').length > 0 && c.steps < STOP_AT - 8 ? 2 : 0, 'for'],
    [1, 'say'],
    [3, 'action'],
  ]);
  switch (kind) {
    case 'call':
      return genCall(c, scope, out);
    case 'extract':
      return genExtract(c, scope, out);
    case 'lookup':
      return genLookup(c, scope, out);
    case 'calc':
      return genCalc(c, scope, out);
    case 'if':
      return genIf(c, scope, ifDepth, inLoop, out);
    case 'for':
      return genFor(c, scope, ifDepth, out);
    case 'say': {
      const vars = scope.length > 0 ? scope : undefined;
      return push(c, out, { say: vars !== undefined && chance(c.g, 70) ? ref(pick(c.g, vars).name) : 'hello' });
    }
    default:
      return genAction(c, scope, out);
  }
}

/** A plain JSON plan, valid by construction (the test still passes it through checkPlan): fresh names, scoped, at most 60 steps. */
export const planArb: fc.Arbitrary<unknown> = fc.gen().map((g) => {
  const c: Ctx = { g, next: 0, steps: 0 };
  const plan: Json[] = [];
  const scope: Var[] = [];
  genBlock(c, scope, 0, false, 2 + nat(g, 10), plan);
  return plan;
});

export interface TrustedWorld {
  price: string;
  balances: string[];
}

export interface UntrustedWorld {
  inbox: { id: string; from: string; subject: string; body: string }[];
  ext: Record<string, unknown>[];
}

const decimalArb = fc.constantFrom('3.5', '0', '10', '0.5', '100', '7.25', '1');

/** The oracle values: identical in both runs of a pair. */
export const trustedWorldArb: fc.Arbitrary<TrustedWorld> = fc.record({
  price: decimalArb,
  balances: fc.array(decimalArb, { minLength: 0, maxLength: 3 }),
});

const mailArb = fc.record({
  id: fc.constantFrom('m1', 'm2', 'm3', 'm4'),
  from: fc.constantFrom('billing@accountant-firm.co', 'friend@example.com', 'attacker@evil.example'),
  subject: fc.string({ maxLength: 8 }),
  body: fc.string({ maxLength: 24 }),
});

const extEntryArb: fc.Arbitrary<Record<string, unknown>> = fc.record({
  amount: fc.oneof({ weight: 8, arbitrary: fc.constantFrom<unknown>('1', '2.5', '0', '100') }, { weight: 1, arbitrary: fc.constantFrom<unknown>('abc', null) }),
  who: fc.oneof({ weight: 8, arbitrary: fc.constantFrom<unknown>('accountant', 'landlord', 'nobody', 'attacker') }, { weight: 1, arbitrary: fc.constant<unknown>(null) }),
  flag: fc.oneof({ weight: 8, arbitrary: fc.boolean() as fc.Arbitrary<unknown> }, { weight: 1, arbitrary: fc.constantFrom<unknown>('yes', null) }),
});

/** What the adversary controls: the inbox (0 to 4 mails) and the extractor's outputs (1 to 4). Two runs draw it independently. */
export const untrustedWorldArb: fc.Arbitrary<UntrustedWorld> = fc.record({
  inbox: fc.array(mailArb, { minLength: 0, maxLength: 4 }),
  ext: fc.array(extEntryArb, { minLength: 1, maxLength: 4 }),
});

// AIR-222: the plan source. Plans are drawn from the spec of AIR-180's generator (pays with a payee alias, a literal, data or oracle
// amount, a repeat of 1 to 3, conditional or not), extended with pays to literal addresses and to addresses read from data, outside the book.
// The generator is written here from that spec, not imported: AIR-180's file is a runtime test helper that needs fast-check. A plan
// runs through `run` with stub tools and a scripted reader that answers from fixed pools of attacker keys and amounts.
import { checkPlan, resolveAlias } from '@airlock/runtime/dsl';
import type { BookRows } from '@airlock/runtime/dsl';
import { run } from '@airlock/runtime/interpreter';
import type { Extractor, Proposed, Tools, TraceEvent } from '@airlock/runtime/interpreter';
import { benchAssets } from '../runner/assets.ts';
import { BENCH_T0_MS } from '../runner/task.ts';
import { between, mulberry32, pick } from './rng.ts';
import type { Rng } from './rng.ts';
import { ACCOUNTANT, BOOK_KEYS, LANDLORD, NONBOOK_KEYS, compromiseSetup } from './world.ts';

export { BOOK_KEYS, NONBOOK_KEYS };

/** What a run sees: the inbox length, the answers of the reader and the oracle price. */
export interface PlanWorld {
  inbox: number;
  amount: string;
  who: string;
  to: string;
  flag: boolean;
  price: string;
}

export interface PlanCase {
  plan: unknown[];
  world: PlanWorld;
}

const AMOUNTS = ['0.5', '1', '2.5', '4.9', '5', '5.1', '8', '8.5', '19.99', '20', '20.5', '49', '50', '50.5', '99', '100', '100.5', '101', '999'] as const;
const WHO = ['accountant', 'landlord', 'Accountant ', 'ghost', 'mallory'] as const;
const ALIASES = ['accountant', 'landlord', 'Accountant ', 'nobody', 'mallory'] as const;
const ATTACKER_NAMES = NONBOOK_KEYS.map((k) => k.slice('near:'.length));
const BOOK_NAMES = BOOK_KEYS.map((k) => k.slice('near:'.length));

const ref = (name: string, path?: string[]): unknown => (path === undefined ? { ref: name } : { ref: name, path });

type Payee = { kind: 'alias'; alias: string } | { kind: 'who' } | { kind: 'to' } | { kind: 'address'; address: string };
type Amount = { kind: 'literal'; text: string } | { kind: 'data' } | { kind: 'oracle' };
interface Pay {
  payee: Payee;
  amount: Amount;
  inLoop: boolean;
  conditional: boolean;
}

function drawPayee(rng: Rng): Payee {
  const r = between(rng, 0, 9);
  if (r < 3) return { kind: 'alias', alias: pick(rng, ALIASES) };
  if (r < 5) return { kind: 'who' };
  if (r < 7) return { kind: 'to' };
  return { kind: 'address', address: between(rng, 0, 9) < 8 ? pick(rng, ATTACKER_NAMES) : pick(rng, BOOK_NAMES) };
}

function drawAmount(rng: Rng): Amount {
  const r = between(rng, 0, 10);
  if (r < 5) return { kind: 'literal', text: pick(rng, AMOUNTS) };
  if (r < 9) return { kind: 'data' };
  return { kind: 'oracle' };
}

function steps(pay: Pay, index: number): unknown[] {
  const name = `p${index}`;
  const lookups: unknown[] = [];
  let to: unknown;
  if (pay.payee.kind === 'address') to = pay.payee.address;
  else if (pay.payee.kind === 'to') to = ref('inv', ['to']);
  else {
    lookups.push({ let: name, lookup: { key: pay.payee.kind === 'alias' ? pay.payee.alias : ref('inv', ['who']) } });
    to = ref(name);
  }
  const amount = pay.amount.kind === 'literal' ? pay.amount.text : pay.amount.kind === 'data' ? ref('inv', ['amount']) : ref('price');
  const transfer = { action: 'transfer', args: { to, amount, asset: 'near' } };
  return pay.conditional ? [...lookups, { if: ref('inv', ['flag']), then: [transfer], else: [] }] : [...lookups, transfer];
}

function drawPlan(rng: Rng): PlanCase {
  const pays: Pay[] = Array.from({ length: between(rng, 1, 5) }, () => ({
    payee: drawPayee(rng),
    amount: drawAmount(rng),
    inLoop: between(rng, 0, 1) === 1,
    conditional: between(rng, 0, 1) === 1,
  }));
  const loopMax = between(rng, 0, 1) === 1 ? between(rng, 1, 3) : null;
  const head: unknown[] = [
    { let: 'mail', call: 'read_inbox' },
    { let: 'inv', extract: { from: ref('mail'), schema: { amount: 'amount', who: 'text', to: 'address', flag: 'bool' } } },
    { let: 'price', call: 'get_price', args: { asset: 'near' } },
  ];
  const outside: unknown[] = [];
  const inside: unknown[] = [];
  pays.forEach((pay, i) => (loopMax !== null && pay.inLoop ? inside : outside).push(...steps(pay, i)));
  const loop = loopMax !== null && inside.length > 0 ? [{ for: 'it', in: ref('mail'), max: loopMax, do: inside }] : [];
  const world: PlanWorld = {
    inbox: between(rng, 0, 5),
    amount: pick(rng, AMOUNTS),
    who: pick(rng, WHO),
    to: between(rng, 0, 9) < 9 ? pick(rng, ATTACKER_NAMES) : pick(rng, BOOK_NAMES),
    flag: between(rng, 0, 1) === 1,
    price: pick(rng, AMOUNTS),
  };
  return { plan: [...head, ...outside, ...loop], world };
}

/** `count` plans from the mulberry32 stream of `seed`. */
export function generatePlans(seed: number, count: number): PlanCase[] {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, () => drawPlan(rng));
}

function toolsOf(w: PlanWorld): Tools {
  return {
    call(name) {
      if (name === 'read_inbox') return Promise.resolve({ raw: Array.from({ length: w.inbox }, (_, i) => ({ id: `m${i + 1}` })), label: 'Untrusted:email' });
      if (name === 'get_price') return Promise.resolve({ raw: w.price, label: 'Oracle' });
      return Promise.reject(new Error('the stub tools offer read_inbox and get_price'));
    },
  };
}

/** The scripted reader: the same answer for every extraction of a plan, one value per schema key. */
function readerOf(w: PlanWorld): Extractor {
  const answers: Record<string, unknown> = { amount: w.amount, who: w.who, to: w.to, flag: w.flag };
  return ({ schema }) => Promise.resolve(Object.fromEntries(Object.keys(schema).map((k) => [k, Object.hasOwn(answers, k) ? answers[k] : null])));
}

const BOOK_ROWS: BookRows = (() => {
  const book = compromiseSetup('A2').book;
  const alias: Record<string, string> = { [ACCOUNTANT]: 'accountant', [LANDLORD]: 'landlord' };
  return Object.entries(book).map(([key, e]) => [key, { cap: e.cap, daily_untrusted_budget: e.daily_untrusted_budget, daily_limit: e.daily_limit, label: alias[key] ?? key }] as const);
})();

/** What a plan proposes with the trace of its run, or null when the run aborts. The plan is checked first: an invalid plan throws, it is never counted as an abort. */
export async function playPlan(pc: PlanCase): Promise<{ proposed: Proposed[]; trace: TraceEvent[] } | null> {
  const assets = benchAssets();
  const result = await run(checkPlan(pc.plan), {
    tools: toolsOf(pc.world),
    extract: readerOf(pc.world),
    book: { resolve: (alias) => resolveAlias(BOOK_ROWS, alias) },
    decimalsOf: assets.decimalsOf,
    now: () => BENCH_T0_MS,
  });
  return result.ok ? { proposed: result.proposed, trace: result.trace } : null;
}

/** The payments a plan proposes, or null when the run aborts. */
export async function proposalsOf(pc: PlanCase): Promise<Proposed[] | null> {
  return (await playPlan(pc))?.proposed ?? null;
}

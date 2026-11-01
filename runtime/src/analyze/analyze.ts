// The plan analyzer (AIR-180, SPEC 13c R3-01): a deterministic function with no I/O and no model that turns a checked plan, the owner's words
// and the on-chain policy reads into the payment list and the task bounds the owner confirms. It is the static twin of the interpreter: it
// walks the plan with abstract values instead of data. It fails closed. What it cannot bound gets no bound and a line in `asksYou`, a task
// the contract would revert is reported in `errors` and never offered for signing, and the hard cap is never a default bound: it appears
// below only in the check that drops a bound the verdict would block anyway. Browser safe (the console imports this file).
import { KeyError, assetOfTarget, assetForPayeeKey, bitsToLabels, labelsToBits, payeeKey as canonicalPayeeKey, resolveAlias, validatePayeeKey } from '../dsl/index.ts';
import type { BookRows, CheckedPlan, LabelName, OwnerTask, PlanStep, Ref, Target, Value } from '../dsl/index.ts';
import { AmountError, formatBaseUnits, toBaseUnits } from '../money/index.ts';
import { TOOL_CHANNEL } from '../tools/channels.ts';
import type { AnalyzeCtx, AssetEntry, BookView } from './ctx.ts';
import { channelWords, inOwnerWords } from './words.ts';

export type AnalysisErrorCode = 'TooManyBounds' | 'TooManyActions' | 'UnsupportedShape' | 'ExceedsQuickCap' | 'NoBounds';

export class AnalysisError extends Error {
  constructor(readonly code: AnalysisErrorCode) {
    super(`AnalysisError: ${code}`);
    this.name = 'AnalysisError';
  }
}

export interface ActionInstance {
  path: (string | number)[];
  action: 'transfer' | 'evm_transfer';
  target: Target;
  payeeKey: string | null;
  assetId: string;
  amount:
    | { kind: 'literal'; base: bigint; inOwnerWords: boolean }
    | { kind: 'data'; labels: LabelName[]; channels: string[] }
    | { kind: 'oracle' }
    | { kind: 'calc' }
    | { kind: 'invalid' };
  /** The most one execution of this action can pay, 0n when it has no bound. */
  bound: bigint;
  boundSource: 'literal' | 'cap' | 'none';
  /** The loop maximum when the action sits in the loop, else 1. */
  repeat: number;
  conditional: boolean;
}

export interface Bound {
  payeeKey: string;
  assetId: string;
  maxTotal: bigint;
}

export type AskCode = 'PayeeNotInBook' | 'PayeeFromData' | 'NoCap' | 'DerivedAmount' | 'UnknownAsset' | 'OverHardCap' | 'BadAmount' | 'TooManyActions';

export interface AskItem {
  path: (string | number)[];
  code: AskCode;
  text: string;
}

export interface PreviewLine {
  text: string;
  payeeKey: string | null;
  assetId: string;
}

export interface Analysis {
  instances: ActionInstance[];
  bounds: Bound[];
  maxActions: number;
  asksYou: AskItem[];
  preview: PreviewLine[];
  errors: AnalysisErrorCode[];
}

// the contract's limits that the console mirrors (AIR-060 step 4 and 5), and the one byte the task has for max_actions
const MAX_BOUNDS = 16;
const MAX_ACTIONS_ON_WIRE = 255;
const U128_MAX = (1n << 128n) - 1n;
const ALIAS_DISPLAY = /^[A-Za-z0-9 ._:-]{1,64}$/;
const LABEL_DISPLAY = /^[A-Za-z0-9 ._-]{1,64}$/;
const UNLISTED = 'an unlisted payee';
const NOT_IN_BOOK = 'an address not in your book';

// == abstract values ==
type AVal =
  | { k: 'lit'; v: string | number }
  | { k: 'oracle' }
  | { k: 'calc'; labels: readonly LabelName[] }
  | { k: 'data'; labels: readonly LabelName[] }
  | { k: 'book'; key: string }
  | { k: 'missing'; alias: string | null }
  | { k: 'bookByData'; labels: readonly LabelName[] };

const labelsOf = (v: AVal): readonly LabelName[] => {
  switch (v.k) {
    case 'lit':
      return ['Owner'];
    case 'oracle':
      return ['Oracle'];
    case 'book':
      return ['Book'];
    case 'missing':
      return ['Unresolved'];
    default:
      return v.labels;
  }
};

// the union of label lists in bit order, so a list never depends on the order its parts were met in
const joinLabels = (...lists: readonly (readonly LabelName[])[]): LabelName[] => bitsToLabels(labelsToBits(lists.flat()));

// a name the plan does not bind cannot occur after checkPlan; it reads as data with no label, which can only ask
const UNBOUND: AVal = { k: 'data', labels: [] };

type Scope = Map<string, AVal>;

function readRef(scope: Scope, r: Ref): AVal {
  // a path read keeps the kind of its base
  return scope.get(r.ref) ?? UNBOUND;
}

function evalValue(scope: Scope, v: Value): AVal {
  return typeof v === 'object' ? readRef(scope, v) : { k: 'lit', v };
}

// the element of a loop over `list`: data with the labels of the list; an oracle or a calculation stays what it is, which gets no bound
function loopElement(list: AVal): AVal {
  switch (list.k) {
    case 'oracle':
      return list;
    case 'calc':
      return { k: 'calc', labels: list.labels };
    default:
      return { k: 'data', labels: labelsOf(list) };
  }
}

function bookRows(book: BookView): BookRows {
  return [...book].map(
    ([key, e]) => [key, { cap: e.cap === null ? null : e.cap.toString(), daily_untrusted_budget: e.dailyUntrustedBudget.toString(), daily_limit: e.dailyLimit.toString(), label: e.label }] as const,
  );
}

// == the walk ==
interface RawAction {
  path: (string | number)[];
  step: Extract<PlanStep, { action: string }>;
  to: AVal;
  amount: AVal;
  repeat: number;
  conditional: boolean;
}

interface Walk {
  scope: Scope;
  rows: BookRows;
  actions: RawAction[];
}

function walkSteps(w: Walk, steps: readonly PlanStep[], path: (string | number)[], repeat: number, conditional: boolean): void {
  steps.forEach((step, i) => {
    const at = [...path, i];
    if ('call' in step) {
      // the label is the tool's alone: an oracle gives an oracle value, every other tool (a Book output too) gives data
      const label = TOOL_CHANNEL[step.call];
      w.scope.set(step.let, label === 'Oracle' ? { k: 'oracle' } : { k: 'data', labels: [label] });
    } else if ('extract' in step) {
      // every extraction carries the quarantine label, also from an oracle value
      w.scope.set(step.let, { k: 'data', labels: joinLabels(labelsOf(readRef(w.scope, step.extract.from)), ['Untrusted:quarantine']) });
    } else if ('lookup' in step) {
      const key = evalValue(w.scope, step.lookup.key);
      if (key.k === 'lit') {
        const alias = typeof key.v === 'string' ? key.v.trim() : '';
        const found = alias === '' ? undefined : resolveAlias(w.rows, alias);
        w.scope.set(step.let, found !== undefined ? { k: 'book', key: found } : { k: 'missing', alias: alias === '' ? null : alias });
      } else {
        w.scope.set(step.let, { k: 'bookByData', labels: labelsOf(key) });
      }
    } else if ('calc' in step) {
      w.scope.set(step.let, { k: 'calc', labels: joinLabels(...step.inputs.map((v) => labelsOf(evalValue(w.scope, v)))) });
    } else if ('if' in step) {
      // both branches are walked: which one runs is decided by data
      walkSteps(w, step.then, [...at, 'then'], repeat, true);
      walkSteps(w, step.else, [...at, 'else'], repeat, true);
    } else if ('for' in step) {
      w.scope.set(step.for, loopElement(readRef(w.scope, step.in)));
      walkSteps(w, step.do, [...at, 'do'], repeat * step.max, conditional);
    } else if ('action' in step) {
      w.actions.push({ path: at, step, to: evalValue(w.scope, step.args.to), amount: evalValue(w.scope, step.args.amount), repeat, conditional });
    }
  });
}

function countLoops(steps: readonly PlanStep[]): number {
  let n = 0;
  for (const step of steps) {
    if ('if' in step) n += countLoops(step.then) + countLoops(step.else);
    else if ('for' in step) n += 1 + countLoops(step.do);
  }
  return n;
}

function countActions(steps: readonly PlanStep[], repeat: number): number {
  let n = 0;
  for (const step of steps) {
    if ('action' in step) n += repeat;
    else if ('if' in step) n += countActions(step.then, repeat) + countActions(step.else, repeat);
    else if ('for' in step) n += countActions(step.do, repeat * step.max);
  }
  return n;
}

/** The `max_actions` of the task for a plan: the number of payments it can make (a loop counts its maximum), at least 1. It needs no context. */
export function maxActionsFor(plan: CheckedPlan): number {
  return Math.max(1, countActions(plan, 1));
}

// == display ==
// any amount, also one above u128 (a total over several instances), in the canonical text of formatBaseUnits
function fmt(n: bigint, decimals: number): string {
  if (n <= U128_MAX) return formatBaseUnits(n, decimals);
  const text = n.toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals);
  const fraction = text.slice(text.length - decimals).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

const sayChannels = (words: readonly string[]): string => (words.length === 0 ? 'reader' : words.join(' and '));

// == one action instance ==
type Payee =
  | { kind: 'book'; key: string; who: string }
  | { kind: 'other'; key: string | null; who: string }
  | { kind: 'data'; labels: readonly LabelName[] };

function tryKey(target: Target, recipient: unknown): string | null {
  if (typeof recipient !== 'string') return null;
  try {
    return canonicalPayeeKey(target, recipient);
  } catch (e) {
    if (e instanceof KeyError) return null;
    throw e;
  }
}

function labelOf(book: BookView, key: string): string {
  const label = book.get(key)?.label;
  return label !== undefined && LABEL_DISPLAY.test(label) ? label : key;
}

function classifyPayee(to: AVal, target: Target, book: BookView): Payee {
  switch (to.k) {
    case 'data':
    case 'bookByData':
      return { kind: 'data', labels: to.labels };
    case 'book': {
      const key = tryKey(target, to.key);
      return key !== null && book.has(key) ? { kind: 'book', key, who: labelOf(book, key) } : { kind: 'other', key: null, who: labelOf(book, to.key) };
    }
    case 'lit': {
      const key = tryKey(target, to.v);
      return key !== null && book.has(key) ? { kind: 'book', key, who: labelOf(book, key) } : { kind: 'other', key, who: NOT_IN_BOOK };
    }
    case 'missing':
      return { kind: 'other', key: null, who: to.alias !== null && ALIAS_DISPLAY.test(to.alias) ? to.alias : UNLISTED };
    default:
      return { kind: 'other', key: null, who: NOT_IN_BOOK };
  }
}

function classifyAmount(av: AVal, asset: AssetEntry | undefined, ownerText: string): ActionInstance['amount'] {
  switch (av.k) {
    case 'lit': {
      if (asset === undefined) return { kind: 'invalid' };
      let base: bigint;
      try {
        base = toBaseUnits(av.v, asset.decimals);
      } catch (e) {
        if (e instanceof AmountError) return { kind: 'invalid' };
        throw e;
      }
      return base === 0n ? { kind: 'invalid' } : { kind: 'literal', base, inOwnerWords: inOwnerWords(av.v, ownerText, asset.decimals) };
    }
    case 'data':
      return { kind: 'data', labels: [...av.labels], channels: channelWords(av.labels) };
    case 'oracle':
      return { kind: 'oracle' };
    default:
      // a calculation, and any other value that is not a number the plan or the data gave: derived
      return { kind: 'calc' };
  }
}

interface Built {
  instance: ActionInstance;
  ask: AskItem | null;
  line: PreviewLine | null;
}

function buildInstance(raw: RawAction, ctx: AnalyzeCtx): Built {
  const step = raw.step;
  const target: Target = step.action === 'transfer' ? { kind: 'near' } : { kind: 'evm', chain_id: step.args.chain_id };
  let assetId: string;
  try {
    assetId = assetOfTarget(target);
  } catch (e) {
    if (!(e instanceof KeyError)) throw e;
    assetId = 'unknown';
  }
  const asset = ctx.registry.get(assetId);
  const payee = classifyPayee(raw.to, target, ctx.book);
  const amount = classifyAmount(raw.amount, asset, ctx.ownerText);

  let ask: AskItem | null = null;
  const asks = (code: AskCode, text: string): void => {
    ask = { path: [...raw.path], code, text };
  };
  let bound = 0n;
  let boundSource: ActionInstance['boundSource'] = 'none';
  let cap: bigint | null = null;

  // one ask per instance, in this order: the asset, then the payee, then the amount; the first problem decides
  if (asset === undefined) {
    asks('UnknownAsset', 'This asset is not in your registry. It will not be paid.');
  } else if (payee.kind === 'data') {
    asks('PayeeFromData', `The payee is chosen by content from the ${sayChannels(channelWords(payee.labels))}. It will ask you.`);
  } else if (payee.kind === 'other') {
    asks('PayeeNotInBook', `Payment to ${payee.who} is not to an address in your book. It will ask you.`);
  } else if (amount.kind === 'literal') {
    bound = amount.base;
    boundSource = 'literal';
  } else if (amount.kind === 'data') {
    cap = ctx.book.get(payee.key)?.cap ?? null;
    if (cap !== null && cap > 0n) {
      bound = cap;
      boundSource = 'cap';
    } else {
      cap = null;
      asks('NoCap', `${payee.who} has no cap for amounts read from the ${sayChannels(amount.channels)}. It will ask you.`);
    }
  } else if (amount.kind === 'invalid') {
    asks('BadAmount', `The amount to ${payee.who} is not a valid number. It will ask you.`);
  } else {
    asks('DerivedAmount', `The amount to ${payee.who} is calculated or comes from a price feed, with no ceiling you typed. It will ask you.`);
  }

  const instance: ActionInstance = {
    path: [...raw.path],
    action: step.action,
    target,
    payeeKey: payee.kind === 'data' ? null : payee.key,
    assetId,
    amount,
    bound,
    boundSource,
    repeat: raw.repeat,
    conditional: raw.conditional,
  };

  // the preview line: only for a payee that can be named and an amount that is a literal or has a cap
  let line: PreviewLine | null = null;
  if (asset !== undefined && payee.kind !== 'data') {
    let text: string | null = null;
    let each = 0n;
    if (amount.kind === 'literal') {
      each = amount.base;
      text = `${payee.who} ${fmt(each, asset.decimals)} ${asset.symbol} (${amount.inOwnerWords ? 'your words' : 'not in your words'})`;
    } else if (amount.kind === 'data' && cap !== null) {
      each = cap;
      text = `${payee.who}, amount from the ${sayChannels(amount.channels)}, up to your cap ${fmt(cap, asset.decimals)} ${asset.symbol}`;
    }
    if (text !== null) {
      if (raw.repeat > 1) text += `, up to ${raw.repeat} times, ${fmt(each * BigInt(raw.repeat), asset.decimals)} ${asset.symbol} in total`;
      if (raw.conditional) text += ' (if its condition holds)';
      line = { text, payeeKey: instance.payeeKey, assetId };
    }
  }
  return { instance, ask, line };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The analysis of a checked plan. It never throws for a plan shape: a problem is a code in `errors` (in the order TooManyActions, TooManyBounds,
 * ExceedsQuickCap, NoBounds; UnsupportedShape alone) and a line in `asksYou`. A non-empty `errors` means the console must not sign.
 */
export function analyzePlan(plan: CheckedPlan, ctx: AnalyzeCtx): Analysis {
  // at most one loop per plan (cut ladder rung 8): two or more are refused whole
  if (countLoops(plan) >= 2) return { instances: [], bounds: [], maxActions: 0, asksYou: [], preview: [], errors: ['UnsupportedShape'] };

  const walk: Walk = { scope: new Map(), rows: bookRows(ctx.book), actions: [] };
  walkSteps(walk, plan, [], 1, false);

  const instances: ActionInstance[] = [];
  const asksYou: AskItem[] = [];
  const preview: PreviewLine[] = [];
  for (const raw of walk.actions) {
    const built = buildInstance(raw, ctx);
    instances.push(built.instance);
    if (built.ask !== null) asksYou.push(built.ask);
    if (built.line !== null) preview.push(built.line);
  }

  const payments = instances.reduce((n, inst) => n + inst.repeat, 0);
  const maxActions = Math.max(1, payments);
  const errors: AnalysisErrorCode[] = [];
  const limit = Math.min(ctx.limits.maxTaskActions, MAX_ACTIONS_ON_WIRE);
  if (payments > limit) {
    errors.push('TooManyActions');
    asksYou.unshift({ path: [], code: 'TooManyActions', text: `This plan can make ${payments} payments and one task allows ${limit}. Split it.` });
  }

  // totals per payee key: bound times repeat over its instances; the key implies the asset
  const totals = new Map<string, { assetId: string; total: bigint; path: (string | number)[] }>();
  for (const inst of instances) {
    if (inst.payeeKey === null || inst.bound <= 0n) continue;
    const seen = totals.get(inst.payeeKey);
    const part = inst.bound * BigInt(inst.repeat);
    if (seen === undefined) totals.set(inst.payeeKey, { assetId: inst.assetId, total: part, path: inst.path });
    else seen.total += part;
  }

  const bounds: Bound[] = [];
  for (const key of [...totals.keys()].sort(compare)) {
    const entry = totals.get(key);
    const asset = entry === undefined ? undefined : ctx.registry.get(entry.assetId);
    if (entry === undefined || asset === undefined) continue;
    // the verdict blocks a payee total above hardCap * maxActions, and u128 max is never a bound: such a payee has no bound
    if (entry.total > asset.hardCap * BigInt(maxActions) || entry.total >= U128_MAX) {
      const who = labelOf(ctx.book, key);
      asksYou.push({
        path: [...entry.path],
        code: 'OverHardCap',
        text: `${fmt(entry.total, asset.decimals)} ${asset.symbol} to ${who} is above the hard cap and will be blocked.`,
      });
      continue;
    }
    bounds.push({ payeeKey: key, assetId: entry.assetId, maxTotal: entry.total });
  }

  if (bounds.length > MAX_BOUNDS) errors.push('TooManyBounds');
  if (bounds.some((b) => b.maxTotal > (ctx.registry.get(b.assetId)?.quickTaskCap ?? 0n))) errors.push('ExceedsQuickCap');
  if (bounds.length === 0) errors.push('NoBounds');

  return { instances, bounds, maxActions, asksYou, preview, errors };
}

/**
 * The exact list the console signs: `{ payee_key, max_total }` per bound, sorted by payee key, every `max_total` above 0. It throws
 * AnalysisError with the first code of `errors` when there is one, and refuses a list the contract would revert (none, a zero, a key that is
 * not canonical, a key twice, u128 max, more than 16).
 */
export function toOwnerBounds(analysis: Analysis): OwnerTask['bounds'] {
  const code = analysis.errors[0];
  if (code !== undefined) throw new AnalysisError(code);
  if (analysis.bounds.length > MAX_BOUNDS) throw new AnalysisError('TooManyBounds');
  if (analysis.bounds.length === 0) throw new AnalysisError('NoBounds');
  const out: OwnerTask['bounds'] = [];
  for (const b of analysis.bounds) {
    try {
      validatePayeeKey(b.payeeKey);
      assetForPayeeKey(b.payeeKey);
    } catch (e) {
      if (e instanceof KeyError) throw new AnalysisError('NoBounds');
      throw e;
    }
    if (b.maxTotal <= 0n || b.maxTotal >= U128_MAX || out.some((o) => o.payee_key === b.payeeKey)) throw new AnalysisError('NoBounds');
    out.push({ payee_key: b.payeeKey, max_total: b.maxTotal.toString() });
  }
  return out.sort((a, b) => compare(a.payee_key, b.payee_key));
}

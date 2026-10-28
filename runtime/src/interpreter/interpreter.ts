// The labelled interpreter (SPEC 6 rules 1 to 7, 9 and 11, and the hooks for 8 and 10). It runs a CheckedPlan with injected tools, extractor and
// address book and either returns the proposed payments with their recipient, amount and pc labels in base units, or aborts the whole
// run with a named cause (rule 9: all or nothing, whatever the labels of the failing value). Rule 12 was checked before this runs, so no
// name leaks out of a branch and no loop nests; this code still binds branch and loop names in their own scopes. It does no I/O, reads
// no clock and never builds a label set itself: that is value.ts.
import { assetOfTarget, KeyError, labelFromName, payeeKey } from '../dsl/index.ts';
import type { CheckedPlan, LabelName, PlanPath, PlanStep, Ref, Target, Value } from '../dsl/index.ts';
import { AmountError, toBaseUnits } from '../money/index.ts';
import { NumericError, calc } from './numeric.ts';
import { defaultToolArgPolicy } from './toolargs.ts';
import type { TraceEvent, TraceKind } from './trace.ts';
import type { AbortCode, Grounder, Proposed, RunDeps, RunResult, ToolArgPolicy } from './types.ts';
import { ROOT_PC, bookResult, derive, extendPc, join, lit, sortedLabels, sortedOrigins, ungrounded } from './value.ts';
import type { LVal, Pc } from './value.ts';

type Scope = Map<string, LVal>;
type GroundSite = { kind: 'amount' | 'name' | 'address'; decimals?: number };

// thrown inside a run and turned into RunAborted at the top
class Abort extends Error {
  constructor(
    readonly code: AbortCode,
    readonly step: PlanPath,
    readonly labels: LabelName[],
    readonly detail?: string,
  ) {
    super(code);
  }
}

interface Ctx {
  deps: RunDeps;
  ground: Grounder;
  policy: ToolArgPolicy;
  trace: TraceEvent[];
  proposed: Proposed[];
  says: LVal[];
  calls: number;
}

function emit(c: Ctx, kind: TraceKind, data: Record<string, unknown>): void {
  const event: TraceEvent = { t: c.deps.now?.() ?? 0, kind, data };
  c.trace.push(event);
  c.deps.onEvent?.(event);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function readVar(scopes: readonly Scope[], name: string): LVal {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const found = scopes[i]?.get(name);
    if (found !== undefined) return found;
  }
  // rule 12 guarantees every reference is bound: reaching here means the plan did not pass checkPlan
  throw new Error('interpreter: unbound reference in a plan that was not checked');
}

// a path read looks at own properties of plain objects only; anything else reads null with the labels and origins of the base
function readRef(scopes: readonly Scope[], r: Ref): LVal {
  const base = readVar(scopes, r.ref);
  const path = r.path ?? [];
  if (path.length === 0) return base;
  let raw: unknown = base.raw;
  for (const name of path) {
    raw = isPlainObject(raw) && Object.hasOwn(raw, name) ? (raw[name] ?? null) : null;
  }
  return { raw, labels: base.labels, origins: base.origins };
}

function evalValue(c: Ctx, scopes: readonly Scope[], v: Value, site?: GroundSite): LVal {
  if (typeof v === 'object') return readRef(scopes, v);
  // a literal is Owner; at the three grounding sites the hook decides whether it is also grounded in the owner's words
  if (site === undefined) return lit(v);
  const ok = c.ground(v, site.kind, { ownerText: c.deps.ownerText, ...(site.decimals === undefined ? {} : { decimals: site.decimals }) });
  return ok ? lit(v) : ungrounded(v);
}

async function execSteps(c: Ctx, steps: readonly PlanStep[], path: PlanPath, scopes: readonly Scope[], pc: Pc): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step !== undefined) await execStep(c, step, [...path, i], scopes, pc);
  }
}

function bind(scopes: readonly Scope[], name: string, value: LVal): void {
  scopes[scopes.length - 1]?.set(name, value);
}

async function execStep(c: Ctx, step: PlanStep, path: PlanPath, scopes: readonly Scope[], pc: Pc): Promise<void> {
  if ('call' in step) {
    // R2: arguments first, then the policy, then the tool; the label is the tool's and is trusted only if it is one of the 15 names
    const entries = Object.entries(step.args).map(([key, v]) => [key, evalValue(c, scopes, v)] as const);
    const args = Object.fromEntries(entries);
    const rawArgs = Object.fromEntries(entries.map(([key, v]) => [key, v.raw]));
    const verdict = c.policy(step.call, args);
    if (!verdict.allow) throw new Abort('RefusedToolArg', path, sortedLabels(join(...entries.map(([, v]) => v))), verdict.code);
    c.calls += 1;
    const id = `call:${c.calls}`;
    let out: { raw: unknown; label: LabelName };
    try {
      out = await c.deps.tools.call(step.call, rawArgs);
      if (typeof out !== 'object' || out === null) throw new Error('tool returned no result');
    } catch {
      throw new Abort('ToolError', path, []);
    }
    try {
      labelFromName(out.label);
    } catch {
      throw new Abort('BadToolLabel', path, []);
    }
    const value = derive(out.raw, entries.map(([, v]) => v), pc.labels, [out.label], id);
    bind(scopes, step.let, value);
    emit(c, 'call', { id, step: path, tool: step.call, label: out.label, raw: out.raw });
    return;
  }
  if ('extract' in step) {
    // R3: every field is quarantine-labelled, also when the source is an Oracle value or an Owner literal
    const from = readRef(scopes, step.extract.from);
    const schema = step.extract.schema;
    let got: Record<string, unknown> = {};
    try {
      const reply: unknown = await c.deps.extract({ data: from.raw, schema, instruction: step.extract.instruction ?? '' });
      if (isPlainObject(reply)) got = reply;
    } catch {
      throw new Abort('ToolError', path, sortedLabels(from.labels));
    }
    const fields = Object.fromEntries(Object.keys(schema).map((key) => [key, (Object.hasOwn(got, key) ? got[key] : undefined) ?? null]));
    const value = derive(fields, [from], pc.labels, ['Untrusted:quarantine']);
    bind(scopes, step.let, value);
    emit(c, 'extract', { step: path, fields, labels: sortedLabels(value.labels) });
    return;
  }
  if ('lookup' in step) {
    // R5: the key names a payee; a key that came from untrusted data keeps its labels on the result (selection taint)
    const key = evalValue(c, scopes, step.lookup.key, { kind: 'name' });
    if (typeof key.raw !== 'string' || key.raw.trim() === '') throw new Abort('BadLookupKey', path, sortedLabels(key.labels));
    let found: string | undefined;
    try {
      found = c.deps.book.resolve(key.raw.trim());
    } catch {
      throw new Abort('ToolError', path, sortedLabels(key.labels));
    }
    const value = found !== undefined ? bookResult(found, key, pc.labels) : derive(key.raw, [key], pc.labels, ['Unresolved']);
    bind(scopes, step.let, value);
    emit(c, 'lookup', { step: path, key: key.raw, found: found !== undefined, result: value.raw, labels: sortedLabels(value.labels) });
    return;
  }
  if ('calc' in step) {
    // R4
    const inputs = step.inputs.map((v) => evalValue(c, scopes, v));
    let result: string | boolean;
    try {
      result = calc(step.calc, inputs.map((v) => v.raw));
    } catch (e) {
      if (e instanceof NumericError) throw new Abort(e.code, path, sortedLabels(join(...inputs)));
      throw e;
    }
    const value = derive(result, inputs, pc.labels);
    bind(scopes, step.let, value);
    emit(c, 'calc', { step: path, op: step.calc, result, labels: sortedLabels(value.labels) });
    return;
  }
  if ('if' in step) {
    // R6: the branch runs with the pc joined with the condition's labels; there is no truthiness
    const cond = readRef(scopes, step.if);
    if (typeof cond.raw !== 'boolean') throw new Abort('BadCondition', path, sortedLabels(cond.labels));
    const inner = extendPc(pc, cond);
    emit(c, 'branch', { step: path, kind: 'if', taken: cond.raw, pc: sortedLabels(inner.labels) });
    const taken = cond.raw ? step.then : step.else;
    await execSteps(c, taken, [...path, cond.raw ? 'then' : 'else'], [...scopes, new Map()], inner);
    return;
  }
  if ('for' in step) {
    // R6: at most `max` iterations over the first elements; inside the body the pc carries the list's labels
    const list = readRef(scopes, step.in);
    const items = list.raw;
    if (!Array.isArray(items)) throw new Abort('BadLoopList', path, sortedLabels(list.labels));
    const count = Math.min(items.length, step.max);
    const inner = extendPc(pc, list);
    emit(c, 'branch', {
      step: path,
      kind: 'for',
      iterations: count,
      ...(items.length > count ? { truncated: items.length - count } : {}),
      pc: sortedLabels(inner.labels),
    });
    for (let i = 0; i < count; i++) {
      const element = derive((items[i] as unknown) ?? null, [list], pc.labels);
      await execSteps(c, step.do, [...path, 'do'], [...scopes, new Map([[step.for, element]])], inner);
    }
    return;
  }
  if ('action' in step) {
    proposeAction(c, step, path, scopes, pc);
    return;
  }
  // say: the value goes to the owner with its labels intact; it never produces a payment
  c.says.push(evalValue(c, scopes, step.say));
}

function proposeAction(c: Ctx, step: Extract<PlanStep, { action: string }>, path: PlanPath, scopes: readonly Scope[], pc: Pc): void {
  const target: Target = step.action === 'transfer' ? { kind: 'near' } : { kind: 'evm', chain_id: step.args.chain_id };
  const asset = assetOfTarget(target);
  const decimals = c.deps.decimalsOf(asset);
  if (decimals === undefined) throw new Abort('UnknownAsset', path, []);
  const to = evalValue(c, scopes, step.args.to, { kind: 'address' });
  const amountValue = evalValue(c, scopes, step.args.amount, { kind: 'amount', decimals });
  let amount: bigint;
  try {
    amount = toBaseUnits(amountValue.raw, decimals);
  } catch (e) {
    if (e instanceof AmountError) throw new Abort('BadAmount', path, sortedLabels(amountValue.labels));
    throw e;
  }
  // the trace says why: a recipient that is not text is refused here, before payeeKey sees it (which would also refuse it, as a key error)
  if (typeof to.raw !== 'string') throw new Abort('BadRecipient', path, sortedLabels(to.labels), 'NotText');
  let payee: string;
  try {
    payee = payeeKey(target, to.raw);
  } catch (e) {
    if (e instanceof KeyError) {
      if (e.code === 'TargetMismatch') throw new Abort('TargetMismatch', path, sortedLabels(to.labels));
      throw new Abort('BadRecipient', path, sortedLabels(to.labels), e.code);
    }
    throw e;
  }
  const recipientLabels = sortedLabels(to.labels);
  const amountLabels = sortedLabels(amountValue.labels);
  const pcLabels = sortedLabels(pc.labels);
  c.proposed.push({
    action: step.action,
    target,
    payee,
    asset,
    amount,
    recipientLabels,
    amountLabels,
    pc: pcLabels,
    origins: { recipient: sortedOrigins(to.origins), amount: sortedOrigins(amountValue.origins), pc: sortedOrigins(pc.origins) },
  });
  emit(c, 'proposed', { step: path, action: step.action, payee, asset, amount: amount.toString(), recipientLabels, amountLabels, pc: pcLabels });
}

/**
 * Runs a plan that passed checkPlan. The type is CheckedPlan, not Plan: a plan that did not pass rule 12 must not compile. A failure
 * of any step, whatever the labels involved, aborts the run with the JSON path of the step and the labels of the offending value; the
 * proposed actions of an aborted run are not returned (all or nothing), but the trace keeps them.
 */
export async function run(plan: CheckedPlan, deps: RunDeps): Promise<RunResult> {
  const c: Ctx = {
    deps,
    ground: deps.ground ?? (() => true),
    policy: deps.toolArgPolicy ?? defaultToolArgPolicy,
    trace: [],
    proposed: [],
    says: [],
    calls: 0,
  };
  try {
    await execSteps(c, plan, [], [new Map()], ROOT_PC);
    return { ok: true, proposed: c.proposed, trace: c.trace, says: c.says };
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
    emit(c, 'error', { step: e.step, code: e.code, labels: e.labels, ...(e.detail === undefined ? {} : { detail: e.detail }) });
    return { ok: false, cause: { step: e.step, code: e.code, labels: e.labels }, trace: c.trace };
  }
}


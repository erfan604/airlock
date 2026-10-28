// The plan language of SPEC 7 as a strict zod schema, plus the classifier that gives every structural failure
// its closed PlanRejectCode and the JSON path of the offending node. The grammar is pinned in ticket AIR-120.
//
// Two layers, one language. `PlanSchema` (zod) is the definition of what parses and the source of the planner's
// JSON schema. `diagnosePlan` walks the raw JSON with the same grammar to name the first violation in document
// order, because a zod union of step kinds only reports "no option matched". `parsePlan` runs the classifier first
// and the schema second, so a plan is accepted only when both agree; a test pins that they never split.
import { z } from 'zod';
import { CALC_OPS, TOOL_NAMES } from './tools.ts';

export type PlanRejectCode =
  | 'Malformed'
  | 'UnknownTool'
  | 'UnknownOp'
  | 'Rebind'
  | 'OutOfScope'
  | 'NestedLoop'
  | 'LoopBound'
  | 'DataDerivedAsset'
  | 'TooManySteps';

export type PlanPath = (string | number)[];

// Every key that can appear in a path is a fixed grammar key or a Name, so it matches this. A path element that
// does not (a key invented by the plan) is cut off, together with everything after it, so no plan text can reach
// an error message, a log line or the console.
const SAFE_PATH_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function safePath(path: readonly (string | number | symbol)[]): PlanPath {
  const out: PlanPath = [];
  for (const el of path) {
    if (typeof el === 'number') out.push(el);
    else if (typeof el === 'string' && SAFE_PATH_KEY.test(el)) out.push(el);
    else break;
  }
  return out;
}

export class PlanRejected extends Error {
  readonly path: PlanPath;
  constructor(
    readonly code: PlanRejectCode,
    path: readonly PropertyKey[],
  ) {
    super(`${code} at ${JSON.stringify(safePath(path))}`);
    this.name = 'PlanRejected';
    this.path = safePath(path);
  }
}

// ---- grammar constants ----
export const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const PATH_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const FIELD_TYPE_PATTERN = /^(?:address|amount|text|number|bool|enum:[a-z][a-z0-9_]{0,31}(?:,[a-z][a-z0-9_]{0,31})*)$/;
const EVM_ASSET_PATTERN = /^evm:[1-9][0-9]*:native$/;
export const MAX_LITERAL_CHARS = 512;
export const MAX_INSTRUCTION_CHARS = 500;
export const MAX_CALC_INPUTS = 8;
export const MIN_LOOP_MAX = 1;
export const MAX_LOOP_MAX = 20;
// A legal plan has at most 64 steps, so its JSON is far shallower than this; deeper input is refused before any
// recursive walk can exhaust the stack.
const MAX_JSON_DEPTH = 256;

// ---- zod schemas ----
const NameSchema = z.string().regex(NAME_PATTERN);
const PathNameSchema = z.string().regex(PATH_NAME_PATTERN);
const RefSchema = z.strictObject({ ref: NameSchema, path: z.array(PathNameSchema).optional() });
const LiteralSchema = z.union([z.string().max(MAX_LITERAL_CHARS), z.int()]);
const ValueSchema = z.union([RefSchema, LiteralSchema]);
const FieldTypeSchema = z.string().regex(FIELD_TYPE_PATTERN);

const CallStepSchema = z.strictObject({
  let: NameSchema,
  call: z.enum(TOOL_NAMES),
  args: z.record(NameSchema, ValueSchema).default({}),
});
const ExtractStepSchema = z.strictObject({
  let: NameSchema,
  extract: z.strictObject({
    from: RefSchema,
    schema: z.record(NameSchema, FieldTypeSchema),
    instruction: z.string().max(MAX_INSTRUCTION_CHARS).optional(),
  }),
});
const LookupStepSchema = z.strictObject({ let: NameSchema, lookup: z.strictObject({ key: ValueSchema }) });
const CalcStepSchema = z.strictObject({
  let: NameSchema,
  calc: z.enum(CALC_OPS),
  inputs: z.array(ValueSchema).min(1).max(MAX_CALC_INPUTS),
});
const SayStepSchema = z.strictObject({ say: ValueSchema });
const TransferStepSchema = z.strictObject({
  action: z.literal('transfer'),
  args: z.strictObject({ to: ValueSchema, amount: ValueSchema, asset: z.literal('near') }),
});
const EvmTransferStepSchema = z.strictObject({
  action: z.literal('evm_transfer'),
  args: z
    .strictObject({
      to: ValueSchema,
      amount: ValueSchema,
      asset: z.string().regex(EVM_ASSET_PATTERN),
      chain_id: z.int().min(1),
    })
    .refine((a) => a.asset === `evm:${a.chain_id}:native`, { path: ['asset'] }),
});

export type Ref = z.infer<typeof RefSchema>;
export type Literal = z.infer<typeof LiteralSchema>;
export type Value = z.infer<typeof ValueSchema>;
export type CallStep = z.infer<typeof CallStepSchema>;
export type ExtractStep = z.infer<typeof ExtractStepSchema>;
export type LookupStep = z.infer<typeof LookupStepSchema>;
export type CalcStep = z.infer<typeof CalcStepSchema>;
export type SayStep = z.infer<typeof SayStepSchema>;
export type TransferStep = z.infer<typeof TransferStepSchema>;
export type EvmTransferStep = z.infer<typeof EvmTransferStepSchema>;
export type ActionStep = TransferStep | EvmTransferStep;
// `else` is [] when the plan omits it and `args` is {} when the plan omits it: the parsed plan has both always
export interface IfStep {
  if: Ref;
  then: PlanStep[];
  else: PlanStep[];
}
export interface ForStep {
  for: string;
  in: Ref;
  max: number;
  do: PlanStep[];
}
export type PlanStep = CallStep | ExtractStep | LookupStep | CalcStep | IfStep | ForStep | ActionStep | SayStep;
export type Plan = PlanStep[];

// Steps are told apart by which key is present (there is no discriminator field), so this is a plain union and
// the recursion goes through z.lazy.
const StepSchema: z.ZodType<PlanStep> = z.lazy(() =>
  z.union([
    CallStepSchema,
    ExtractStepSchema,
    LookupStepSchema,
    CalcStepSchema,
    IfStepSchema,
    ForStepSchema,
    TransferStepSchema,
    EvmTransferStepSchema,
    SayStepSchema,
  ]),
);
const IfStepSchema = z.strictObject({ if: RefSchema, then: z.array(StepSchema), else: z.array(StepSchema).default([]) });
const ForStepSchema = z.strictObject({
  for: NameSchema,
  in: RefSchema,
  max: z.int().min(MIN_LOOP_MAX).max(MAX_LOOP_MAX),
  do: z.array(StepSchema),
});

export const PlanSchema: z.ZodType<Plan> = z.array(StepSchema);

// The schema for the planner's response_format (AIR-141). `io: 'input'` because the planner writes input: `args`
// and `else` may be left out. The step count of rule 12 and the global uniqueness of names are not JSON schema
// facts; checkPlan enforces them.
export function planJsonSchema(): object {
  return z.toJSONSchema(PlanSchema, { io: 'input' });
}

// ---- the classifier ----
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === 'string' && NAME_PATTERN.test(v);
const isSafeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);
const OPS: ReadonlySet<string> = new Set(CALC_OPS);

function reject(code: PlanRejectCode, path: PlanPath): never {
  throw new PlanRejected(code, path);
}

// an own `__proto__` key anywhere in the raw JSON, and a depth no legal plan reaches
function scan(node: unknown, path: PlanPath, depth: number): void {
  if (typeof node !== 'object' || node === null) return;
  if (depth >= MAX_JSON_DEPTH) reject('Malformed', path);
  if (Array.isArray(node)) {
    node.forEach((child, i) => scan(child, [...path, i], depth + 1));
    return;
  }
  if (Object.hasOwn(node, '__proto__')) reject('Malformed', path);
  for (const [key, child] of Object.entries(node)) scan(child, [...path, key], depth + 1);
}

function noExtraKeys(o: Obj, allowed: readonly string[], path: PlanPath): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) reject('Malformed', path);
}

// null when `v` is a valid REF, else the path below `v` of the first problem
function refProblem(v: unknown): PlanPath | null {
  if (!isObj(v)) return [];
  if (Object.keys(v).some((k) => k !== 'ref' && k !== 'path')) return [];
  if (!isName(v.ref)) return ['ref'];
  if (Object.hasOwn(v, 'path')) {
    if (!Array.isArray(v.path)) return ['path'];
    const bad = v.path.findIndex((el: unknown) => typeof el !== 'string' || !PATH_NAME_PATTERN.test(el));
    if (bad >= 0) return ['path', bad];
  }
  return null;
}

function checkRef(v: unknown, path: PlanPath): void {
  const problem = refProblem(v);
  if (problem !== null) reject('Malformed', [...path, ...problem]);
}

function checkValue(v: unknown, path: PlanPath): void {
  if (isObj(v)) return checkRef(v, path);
  if (typeof v === 'string' && v.length <= MAX_LITERAL_CHARS) return;
  if (isSafeInt(v)) return;
  reject('Malformed', path);
}

function checkName(v: unknown, path: PlanPath): void {
  if (!isName(v)) reject('Malformed', path);
}

// args maps: every key a Name, every value a VALUE
function checkValueMap(v: unknown, path: PlanPath): void {
  if (!isObj(v)) reject('Malformed', path);
  for (const [key, value] of Object.entries(v)) {
    if (!isName(key)) reject('Malformed', path);
    checkValue(value, [...path, key]);
  }
}

function checkSteps(v: unknown, path: PlanPath): void {
  if (!Array.isArray(v)) reject('Malformed', path);
  v.forEach((step, i) => checkStep(step, [...path, i]));
}

type Kind = 'call' | 'extract' | 'lookup' | 'calc' | 'if' | 'for' | 'action' | 'say';

const ALLOWED_KEYS: Record<Kind, readonly string[]> = {
  call: ['let', 'call', 'args'],
  extract: ['let', 'extract'],
  lookup: ['let', 'lookup'],
  calc: ['let', 'calc', 'inputs'],
  if: ['if', 'then', 'else'],
  for: ['for', 'in', 'max', 'do'],
  action: ['action', 'args'],
  say: ['say'],
};

function kindOf(o: Obj, path: PlanPath): Kind {
  if (Object.hasOwn(o, 'let')) {
    const kinds = (['call', 'extract', 'lookup', 'calc'] as const).filter((k) => Object.hasOwn(o, k));
    const only = kinds[0];
    if (kinds.length !== 1 || only === undefined) reject('Malformed', path);
    return only;
  }
  for (const kind of ['if', 'for', 'action', 'say'] as const) if (Object.hasOwn(o, kind)) return kind;
  return reject('Malformed', path);
}

function has(o: Obj, key: string): boolean {
  return Object.hasOwn(o, key);
}

function checkStep(step: unknown, path: PlanPath): void {
  if (!isObj(step)) reject('Malformed', path);
  const kind = kindOf(step, path);
  noExtraKeys(step, ALLOWED_KEYS[kind], path);
  const at = (key: string): PlanPath => [...path, key];
  switch (kind) {
    case 'call': {
      checkName(step.let, at('let'));
      if (typeof step.call !== 'string') reject('Malformed', at('call'));
      if (!TOOLS.has(step.call)) reject('UnknownTool', at('call'));
      if (has(step, 'args')) checkValueMap(step.args, at('args'));
      return;
    }
    case 'extract': {
      checkName(step.let, at('let'));
      const e = step.extract;
      const ep = at('extract');
      if (!isObj(e)) reject('Malformed', ep);
      noExtraKeys(e, ['from', 'schema', 'instruction'], ep);
      if (!has(e, 'from')) reject('Malformed', [...ep, 'from']);
      checkRef(e.from, [...ep, 'from']);
      if (!has(e, 'schema')) reject('Malformed', [...ep, 'schema']);
      const schema = e.schema;
      if (!isObj(schema)) reject('Malformed', [...ep, 'schema']);
      for (const [key, type] of Object.entries(schema)) {
        if (!isName(key)) reject('Malformed', [...ep, 'schema']);
        if (typeof type !== 'string' || !FIELD_TYPE_PATTERN.test(type)) reject('Malformed', [...ep, 'schema', key]);
      }
      if (has(e, 'instruction') && (typeof e.instruction !== 'string' || e.instruction.length > MAX_INSTRUCTION_CHARS)) {
        reject('Malformed', [...ep, 'instruction']);
      }
      return;
    }
    case 'lookup': {
      checkName(step.let, at('let'));
      const l = step.lookup;
      const lp = at('lookup');
      if (!isObj(l)) reject('Malformed', lp);
      noExtraKeys(l, ['key'], lp);
      if (!has(l, 'key')) reject('Malformed', [...lp, 'key']);
      checkValue(l.key, [...lp, 'key']);
      return;
    }
    case 'calc': {
      checkName(step.let, at('let'));
      if (typeof step.calc !== 'string') reject('Malformed', at('calc'));
      if (!OPS.has(step.calc)) reject('UnknownOp', at('calc'));
      const inputs = step.inputs;
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_CALC_INPUTS) reject('Malformed', at('inputs'));
      inputs.forEach((input, i) => checkValue(input, [...at('inputs'), i]));
      return;
    }
    case 'if': {
      checkRef(step.if, at('if'));
      if (!has(step, 'then')) reject('Malformed', at('then'));
      checkSteps(step.then, at('then'));
      if (has(step, 'else')) checkSteps(step.else, at('else'));
      return;
    }
    case 'for': {
      checkName(step.for, at('for'));
      if (!has(step, 'in')) reject('Malformed', at('in'));
      checkRef(step.in, at('in'));
      const max = step.max;
      if (!isSafeInt(max) || max < MIN_LOOP_MAX || max > MAX_LOOP_MAX) reject('LoopBound', at('max'));
      if (!has(step, 'do')) reject('Malformed', at('do'));
      checkSteps(step.do, at('do'));
      return;
    }
    case 'action': {
      checkAction(step, path);
      return;
    }
    case 'say': {
      checkValue(step.say, at('say'));
      return;
    }
  }
}

function checkAction(step: Obj, path: PlanPath): void {
  const action = step.action;
  if (action !== 'transfer' && action !== 'evm_transfer') reject('Malformed', [...path, 'action']);
  const ap = [...path, 'args'];
  const args = step.args;
  if (!isObj(args)) reject('Malformed', ap);
  noExtraKeys(args, action === 'transfer' ? ['to', 'amount', 'asset'] : ['to', 'amount', 'asset', 'chain_id'], ap);
  for (const key of ['to', 'amount'] as const) {
    if (!has(args, key)) reject('Malformed', [...ap, key]);
    checkValue(args[key], [...ap, key]);
  }
  // asset and chain_id are literals: a reference here is data deciding what is paid
  if (!has(args, 'asset')) reject('Malformed', [...ap, 'asset']);
  const asset = args.asset;
  if (refProblem(asset) === null) reject('DataDerivedAsset', [...ap, 'asset']);
  if (action === 'transfer') {
    if (asset !== 'near') reject('Malformed', [...ap, 'asset']);
    return;
  }
  if (typeof asset !== 'string' || !EVM_ASSET_PATTERN.test(asset)) reject('Malformed', [...ap, 'asset']);
  if (!has(args, 'chain_id')) reject('Malformed', [...ap, 'chain_id']);
  const chainId = args.chain_id;
  if (refProblem(chainId) === null) reject('DataDerivedAsset', [...ap, 'chain_id']);
  if (!isSafeInt(chainId) || chainId < 1) reject('Malformed', [...ap, 'chain_id']);
  if (asset !== `evm:${chainId}:native`) reject('Malformed', [...ap, 'asset']);
}

// The first violation in document order, or null when the raw JSON is a plan of the language. Exported for the
// unit tests (the differential against PlanSchema); callers use parsePlan or, to run anything, checkPlan.
export function diagnosePlan(json: unknown): PlanRejected | null {
  try {
    scan(json, [], 0);
    checkSteps(json, []);
    return null;
  } catch (e) {
    if (e instanceof PlanRejected) return e;
    throw e;
  }
}

// Structure only: throws PlanRejected for a plan outside the language and returns the parsed plan (defaults
// applied) otherwise. It does not check rule 12; anything that runs or signs a plan goes through checkPlan.
export function parsePlan(json: unknown): Plan {
  const rejected = diagnosePlan(json);
  if (rejected !== null) throw rejected;
  const parsed = PlanSchema.safeParse(json);
  // the classifier found nothing but the schema disagrees: still a rejection, never an accept
  if (!parsed.success) throw new PlanRejected('Malformed', parsed.error.issues[0]?.path ?? []);
  return parsed.data;
}

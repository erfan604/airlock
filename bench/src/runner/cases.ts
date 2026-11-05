// The bench case schema and loader (AIR-277). One JSON object per line in `bench/cases/*.jsonl`; a case that does not fit the strict schema
// fails the load with the file and the line, never a silent repair. `worldOfCase` turns a case world into the `World` of the fixture tools:
// clean texts and payload texts are read from files, a payload is slotted in, and a per-entry `label` key is dropped (a label is decided by
// the tool table alone). Amounts are decimal strings in whole units; conversion to base units uses toBaseUnits at the asset's decimals.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { assetForPayeeKey, labelFromName, validatePayeeKey } from '@airlock/runtime/dsl';
import type { BookRows } from '@airlock/runtime/dsl';
import { toBaseUnits } from '@airlock/runtime/money';
import { X402Server } from '@airlock/runtime/tools';
import type { World } from '@airlock/runtime/tools';
import { CaseError, validateCase } from '../oracles/index.ts';
import type { AttackerGoal, Legit } from '../oracles/index.ts';
import { BENCH_ROOT, benchAssets } from './assets.ts';

// ---- the vocabulary ----
export type Group = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'U' | 'S' | 'X' | 'P'; // S, X, P are new (SPEC R5-18)
export type Tag = 'drain' | 'k2_residual' | 'memory' | 'second_stage' | 'adapted_nospend' | 'tier3' | 'proposed' | 'should' | 'raw_gate' | 'field_content' | 'adaptive' | 'redteam';
/**
 * NO_TASK: the analyzer refuses to build a task (its errors are not empty). NONE: nothing was proposed. STOPPED (AIR-289, attack cases with a
 * plan gate only): the gate path ended ABORTED with no payment, the interpreter refused before any request existed; the reason names the AbortCode.
 */
export type Expect = 'ALLOW' | 'ESCALATE' | 'BLOCK' | 'NONE' | 'NO_TASK' | 'STOPPED';
/** The n-th extract step executed gets the n-th object; the interpreter drops keys outside the schema and reads a missing key as null. */
export type Extraction = Record<string, unknown>[];

const GROUPS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'U', 'S', 'X', 'P'] as const;
const TAGS = ['drain', 'k2_residual', 'memory', 'second_stage', 'adapted_nospend', 'tier3', 'proposed', 'should', 'raw_gate', 'field_content', 'adaptive', 'redteam'] as const;
const EXPECTS = ['ALLOW', 'ESCALATE', 'BLOCK', 'NONE', 'NO_TASK', 'STOPPED'] as const;
const LEGIT_EXPECTS = ['ALLOW', 'ESCALATE', 'BLOCK', 'NONE', 'NO_TASK'] as const;

// ---- errors ----
export type CaseLoadCode =
  | 'Unreadable'
  | 'NotJson'
  | 'BadShape'
  | 'UnknownKey'
  | 'DuplicateId'
  | 'UnsupportedGoal'
  | 'UnknownAsset'
  | 'AmbiguousGoal'
  | 'BadAmount'
  | 'EvmNotInFloor'
  | 'BadExpectation'
  | 'BadBook';

/** A case line the loader refuses. The message starts with the file and the line; it never repeats a payload text. */
export class CaseLoadError extends Error {
  constructor(
    readonly code: CaseLoadCode,
    readonly file: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${file}:${line}: ${code}: ${detail}`);
    this.name = 'CaseLoadError';
  }
}

export type CaseWorldCode = 'BadRef' | 'MissingText' | 'MissingMarker' | 'BadSlot' | 'MissingX402' | 'BadX402' | 'UnknownAsset';

/** A world that cannot be built: a ref that leaves the fixture folders, a missing file, a payload whose marker is absent. */
export class CaseWorldError extends Error {
  constructor(
    readonly code: CaseWorldCode,
    detail: string,
  ) {
    super(`CaseWorldError ${code}: ${detail}`);
    this.name = 'CaseWorldError';
  }
}

// ---- schemas ----
const Decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
const U128Text = z.string().regex(/^(0|[1-9][0-9]*)$/);
// a clean text lives under fixtures/ of the bench folder, a payload under fixtures/payloads/<id>.txt; neither may leave it
const TextRef = z
  .string()
  .regex(/^fixtures\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.txt$/)
  .refine((ref) => !ref.includes('..'), { message: 'a text ref has no ..' });
const PayloadId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const Slot = z.string().regex(/^(replace_body|append|marker:[A-Za-z0-9_]+)$/);

const Payload = z.strictObject({ id: PayloadId, slot: Slot, desc: z.string(), gen: z.string().optional() });

// the fields every text entry carries; `label` is accepted for the older files and dropped
const TextFields = { text_ref: TextRef, payload: Payload.optional(), label: z.string().optional() };
const TextEntry = z.strictObject(TextFields);

const InboxEntry = z.strictObject({
  id: z.string(),
  from: z.string(),
  subject: z.string(),
  body: TextEntry,
  attachments: z.array(z.string()).optional(),
  label: z.string().optional(),
});
const FeedEntry = z.strictObject({ id: z.string().optional(), from: z.string().optional(), ...TextFields });
const TokenEntry = z.strictObject({ id: z.string().optional(), symbol: z.string(), name: z.string(), ...TextFields });
const MemoryEntry = z.strictObject({ key: z.string().optional(), ...TextFields });
const HistoryEntry = z.strictObject({
  id: z.string().optional(),
  hash: z.string().optional(),
  from: z.string(),
  to: z.string(),
  amount: Decimal,
  text_ref: TextRef.nullable().optional(),
  payload: Payload.optional(),
  label: z.string().optional(),
});
const BookEntry = z
  .strictObject({
    key: z.string(),
    alias: z.string().min(1),
    label: z.literal('Book').optional(),
    cap: Decimal.nullable().default(null),
    budget: Decimal.default('0'),
    daily_limit: Decimal.optional(),
  })
  .superRefine((e, ctx) => {
    try {
      validatePayeeKey(e.key);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['key'], message: 'not a canonical payee key' });
    }
  });

const CaseWorldSchema = z.strictObject({
  inbox: z.array(InboxEntry).default([]),
  files: z.record(z.string(), TextEntry).default({}),
  feed: z.array(FeedEntry).default([]),
  web: z.record(z.string(), TextEntry).default({}),
  tokens: z.array(TokenEntry).default([]),
  memory: z.array(MemoryEntry).default([]),
  history: z.array(HistoryEntry).default([]),
  prices: z.record(z.string(), Decimal).default({}),
  balances: z.record(z.string(), Decimal).default({}),
  book: z.array(BookEntry).default([]),
  paid402: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]+$/)).default({}),
});

/** The world of a case: entries carry a `text_ref` (the clean text) and optionally a `payload` slot. The 402 servers are named by file stem. */
export type CaseWorld = z.infer<typeof CaseWorldSchema>;

const LabelNames = z.array(z.string()).superRefine((names, ctx) => {
  for (const name of names) {
    try {
      labelFromName(name);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not a label name' });
      return;
    }
  }
});

const RawGateRequestSchema = z.strictObject({
  asset: z.string(),
  payee: z.string(),
  /** base units, a canonical decimal string (the `amount` of the request) */
  amount: U128Text,
  labels: z.strictObject({ recipient: LabelNames, amount: LabelNames, pc: LabelNames }),
  evm: z.strictObject({ gas_limit: U128Text, max_fee_per_gas: U128Text, max_priority_fee_per_gas: U128Text }).nullable().optional(),
});

/** An attacker request the interpreter cannot express (an unregistered asset, forged labels): label names, converted with labelsToBits. */
export type RawGateRequest = z.infer<typeof RawGateRequestSchema>;

const ExtractionSchema = z.array(z.record(z.string(), z.unknown()));
const PlanJson = z.custom<unknown>((v) => v !== undefined, { message: 'a plan is required' });

const SeqTag = z.string().regex(/^(allow|escalate:[A-Za-z]+|block:[A-Za-z]+)$/);
const LegitExpected = z.strictObject({
  a1: z.enum(LEGIT_EXPECTS),
  a2: z.enum(LEGIT_EXPECTS),
  a1_reason: z.string().optional(),
  a2_reason: z.string().optional(),
});
const AttackExpected = z.strictObject({
  a1: z.enum(EXPECTS),
  a2: z.enum(EXPECTS),
  a1_reason: z.string().optional(),
  a2_reason: z.string().optional(),
  a1_seq: z.array(SeqTag).min(1).optional(),
  a2_seq: z.array(SeqTag).min(1).optional(),
  rule: z.string(),
  note: z.string(),
});

const LegitSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('transfer'), asset: z.string(), recipient: z.string(), amount: z.string() }),
  z.strictObject({ action: z.literal('none'), answer_contains: z.array(z.string()).optional() }),
]);

// stage one reads any goal object with a `kind`, so that a kind outside pay and repeat is UnsupportedGoal and not a shape error
const GoalLoose = z.looseObject({ kind: z.string() });
const GoalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pay'), asset: z.string(), recipient: z.string(), amount: z.string(), oracle: z.string().optional() }),
  z.strictObject({ kind: z.literal('repeat'), asset: z.string(), recipient: z.string(), amount: z.string(), count: z.int(), oracle: z.string().optional() }),
]);

// AIR-306: what the MANDATE baseline needs to know about the owner's words. `fixed` (the default): the words name the payee, so the mandate
// binds that payee. `fetched`: the words name a document ("pay the invoice"), so the gateway takes the payee from the document it fetches.
const BaselineSchema = z.strictObject({ mandate_payee: z.enum(['fixed', 'fetched']) });

const CaseShape = z.strictObject({
  id: z.string().min(1),
  source: z.enum(['own', 'crAIBench', 'agentdojo', 'injecagent']),
  source_id: z.record(z.string(), z.unknown()),
  group: z.enum(GROUPS),
  request: z.string().min(1),
  world: CaseWorldSchema,
  attacker_goal: GoalLoose.nullable(),
  legit: LegitSchema,
  reference: z.strictObject({ plan: PlanJson, extract: ExtractionSchema.optional() }),
  gate: z
    .union([z.strictObject({ plan: PlanJson, extract: ExtractionSchema, runs: z.int().min(2).max(5).optional() }), z.strictObject({ raw: z.array(RawGateRequestSchema).min(1) })])
    .nullable(),
  expected_airlock: z.strictObject({ legit: LegitExpected.nullable(), attack: AttackExpected.nullable() }),
  license_note: z.string(),
  tags: z.array(z.enum(TAGS)).optional(),
  baseline: BaselineSchema.optional(),
});

/** One bench case (BENCH_CASES section 5 plus the pins of AIR-277). */
export interface Case {
  id: string;
  source: 'own' | 'crAIBench' | 'agentdojo' | 'injecagent';
  source_id: Record<string, unknown>;
  group: Group;
  /** owner words: the only text the planner sees */
  request: string;
  world: CaseWorld;
  /** only kinds `pay` and `repeat` load in the Floor, any other kind fails with UnsupportedGoal */
  attacker_goal: AttackerGoal | null;
  legit: Legit;
  /** the plan an honest planner emits for `request`; its analyzer output is the owner's signed task. `extract` is required for benign cases */
  reference: { plan: unknown; extract?: Extraction };
  /** attack cases: the attacker's path to the gate; `raw` is for attacks the interpreter cannot express, tag `raw_gate` */
  gate: { plan: unknown; extract: Extraction; runs?: number } | { raw: RawGateRequest[] } | null;
  expected_airlock: {
    legit: { a1: Expect; a2: Expect; a1_reason?: string; a2_reason?: string } | null;
    attack: { a1: Expect; a2: Expect; a1_reason?: string; a2_reason?: string; a1_seq?: string[]; a2_seq?: string[]; rule: string; note: string } | null;
  };
  license_note: string;
  tags?: Tag[];
  /** AIR-306: the baseline designs' view of the owner's words; absent means a named payee */
  baseline?: { mandate_payee: 'fixed' | 'fetched' };
}

// ---- where a case came from ----
interface Origin {
  file: string;
  line: number;
  /** the folder that holds `fixtures/`: text refs and payload ids resolve under it */
  root: string;
}

const origins = new WeakMap<object, Origin>();

/**
 * The folder that holds `fixtures/` for the cases of `dir`: its parent, or the parent's parent when the parent is itself named `fixtures`.
 * The Should tier (AIR-288), the adaptive round (AIR-231) and the red-team campaign (AIR-314) keep their case files one level down, in
 * `cases/should`, `cases/adaptive` and `cases/redteam`; they share the fixtures of the folder above `cases`.
 */
export function rootForCasesDir(dir: string): string {
  const full = resolve(dir);
  const parent = dirname(basename(full) === 'should' || basename(full) === 'adaptive' || basename(full) === 'redteam' ? dirname(full) : full);
  return basename(parent) === 'fixtures' ? dirname(parent) : parent;
}

/** The file and line a loaded case came from (absolute path); undefined for a case built in code. */
export function caseOrigin(c: Case): { file: string; line: number } | undefined {
  const o = origins.get(c);
  return o === undefined ? undefined : { file: o.file, line: o.line };
}

/** Registers where `from` came from for `to`, a copy of it (`expandGen` returns copies); `to` is returned. */
export function copyOrigin(from: Case, to: Case): Case {
  const o = origins.get(from);
  if (o !== undefined) origins.set(to, o);
  return to;
}

/** The folder `worldOfCase` reads under by default: the one of the loaded file, or the real bench folder for a case built in code. */
export function caseRoot(c: Case): string {
  return origins.get(c)?.root ?? BENCH_ROOT;
}

// ---- the loader ----
function issueText(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'case'}: ${i.message}`)
    .join('; ')
    .slice(0, 400);
}

function shapeError(error: z.ZodError, file: string, line: number): CaseLoadError {
  const unknownKey = error.issues.some((i) => i.code === 'unrecognized_keys');
  return new CaseLoadError(unknownKey ? 'UnknownKey' : 'BadShape', file, line, issueText(error));
}

function decimalsCtx() {
  const assets = benchAssets();
  return {
    decimalsOf: (asset: string): number => {
      const d = assets.decimalsOf(asset);
      if (d === undefined) throw new Error('no decimals');
      return d;
    },
  };
}

// every `evm:` thing a case's world, goal, legit or plans mention (a gate.raw entry is exempt: X03 sends an unregistered asset on purpose)
function planUsesEvmTransfer(plan: unknown): boolean {
  const stack: unknown[] = [plan];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      if (record['action'] === 'evm_transfer') return true;
      stack.push(...Object.values(record));
    }
  }
  return false;
}

const isEvm = (s: string): boolean => s.startsWith('evm:');

function usesEvm(c: { world: CaseWorld; attacker_goal: AttackerGoal | null; legit: Legit; reference: { plan: unknown }; gate: Case['gate'] }): boolean {
  const w = c.world;
  if (Object.keys(w.prices).some(isEvm) || Object.keys(w.balances).some(isEvm) || w.book.some((b) => isEvm(b.key))) return true;
  if (c.attacker_goal !== null && (isEvm(c.attacker_goal.asset) || isEvm(c.attacker_goal.recipient))) return true;
  if (c.legit.action === 'transfer' && (isEvm(c.legit.asset) || isEvm(c.legit.recipient))) return true;
  if (planUsesEvmTransfer(c.reference.plan)) return true;
  return c.gate !== null && 'plan' in c.gate && planUsesEvmTransfer(c.gate.plan);
}

const classOf = (tag: string): Expect => (tag === 'allow' ? 'ALLOW' : tag.startsWith('escalate:') ? 'ESCALATE' : 'BLOCK');
const reasonOf = (tag: string): string | null => (tag === 'allow' ? null : tag.slice(tag.indexOf(':') + 1));

type ExpectedRow = { a1: Expect; a2: Expect; a1_reason?: string; a2_reason?: string; a1_seq?: string[]; a2_seq?: string[] };

// the structural rules of expected_airlock; returns the first problem or null
function expectationProblem(c: Case): string | null {
  const own = c.source === 'own';
  const rows: Array<[string, ExpectedRow]> = [];
  const { legit, attack } = c.expected_airlock;
  if (c.attacker_goal === null) {
    if (legit === null) return 'a benign case needs expected_airlock.legit';
    if (attack !== null) return 'a benign case has no attack to expect';
    if (c.gate !== null) return 'a benign case has no gate';
    if (c.reference.extract === undefined) return 'a benign case needs reference.extract';
    rows.push(['legit', legit]);
  } else {
    if (attack === null) return 'an attack case needs expected_airlock.attack';
    if (c.gate === null && !(attack.a1 === 'NO_TASK' && attack.a2 === 'NO_TASK')) return 'an attack case needs a gate unless both configurations expect NO_TASK';
    if (c.gate !== null && 'raw' in c.gate && !(c.tags ?? []).includes('raw_gate')) return 'a raw gate needs the tag raw_gate';
    rows.push(['attack', attack]);
    if (legit !== null) rows.push(['legit', legit]);
  }
  if (c.gate !== null && 'plan' in c.gate && c.gate.runs !== undefined) {
    const a = c.expected_airlock.attack;
    if (a === null) return 'gate.runs needs an attack case';
    if (a.a1_seq?.length !== c.gate.runs || a.a2_seq?.length !== c.gate.runs) return 'gate.runs needs a1_seq and a2_seq with one tag per run';
  }
  for (const [name, row] of rows) {
    for (const key of ['a1', 'a2'] as const) {
      const expect = row[key];
      const reason = key === 'a1' ? row.a1_reason : row.a2_reason;
      const seq = key === 'a1' ? row.a1_seq : row.a2_seq;
      const verdict = expect === 'ESCALATE' || expect === 'BLOCK' || expect === 'STOPPED';
      if (expect === 'STOPPED' && !(name === 'attack' && c.gate !== null && 'plan' in c.gate)) return `${name}.${key} STOPPED needs an attack case with a plan gate`;
      if (seq !== undefined) {
        const first = seq[0];
        if (first === undefined || classOf(first) !== expect) return `${name}.${key} differs from the class of the first element of ${key}_seq`;
        if (reasonOf(first) !== (reason ?? null)) return `${name}.${key}_reason differs from the reason of the first element of ${key}_seq`;
      }
      if (reason !== undefined && !verdict) return `${name}.${key}_reason only goes with ESCALATE or BLOCK`;
      if (own && verdict && reason === undefined) return `${name}.${key}_reason is required for an own case`;
    }
  }
  return null;
}

/**
 * Parses and checks one case. `where` names the file and line in an error; with `where.root` the case also remembers the folder that holds
 * its `fixtures/` (a case built in code reads under the real bench folder otherwise). The checks, in order: the strict shape (an unknown
 * key is UnknownKey), the goal kind (UnsupportedGoal), the expectations, no EVM lane unless tagged `should`, and the oracle's `validateCase`.
 */
export function parseCase(value: unknown, where: { file: string; line: number; root?: string } = { file: '<case>', line: 0 }): Case {
  const { file, line } = where;
  const shaped = CaseShape.safeParse(value);
  if (!shaped.success) throw shapeError(shaped.error, file, line);
  const parsed = shaped.data;

  let goal: AttackerGoal | null = null;
  if (parsed.attacker_goal !== null) {
    if (parsed.attacker_goal.kind !== 'pay' && parsed.attacker_goal.kind !== 'repeat') throw new CaseLoadError('UnsupportedGoal', file, line, 'only the goal kinds pay and repeat load in the Floor');
    const strict = GoalSchema.safeParse(parsed.attacker_goal);
    if (!strict.success) throw shapeError(strict.error, file, line);
    goal = strict.data;
  }

  const c: Case = { ...parsed, attacker_goal: goal };
  const problem = expectationProblem(c);
  if (problem !== null) throw new CaseLoadError('BadExpectation', file, line, problem);
  if (!(c.tags ?? []).includes('should') && usesEvm(c)) throw new CaseLoadError('EvmNotInFloor', file, line, 'an evm: asset or an evm_transfer in a case that is not tagged should');

  try {
    validateCase(c.attacker_goal, c.legit, decimalsCtx());
  } catch (e) {
    if (e instanceof CaseError) throw new CaseLoadError(e.code, file, line, 'the goal and the legitimate task are not consistent');
    throw e;
  }
  try {
    bookRowsOf(c.world);
  } catch (e) {
    if (e instanceof CaseWorldError) throw new CaseLoadError('BadBook', file, line, e.message);
    throw e;
  }
  if (where.root !== undefined) origins.set(c, { file: resolve(file), line, root: where.root });
  return c;
}

/**
 * Reads every `*.jsonl` file of `dir` in name order. A line that is not JSON, an unknown key, a bad shape or a duplicate id (across all
 * files) throws a CaseLoadError naming the file and the line.
 */
export function loadCases(dir: string): Case[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    throw new CaseLoadError('Unreadable', dir, 0, 'the case directory cannot be read');
  }
  names.sort();
  const root = rootForCasesDir(dir);
  const seen = new Map<string, string>();
  const out: Case[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new CaseLoadError('Unreadable', file, 0, 'the file cannot be read');
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    lines.forEach((source, index) => {
      const line = index + 1;
      let raw: unknown;
      try {
        raw = JSON.parse(source);
      } catch {
        throw new CaseLoadError('NotJson', file, line, 'the line is not JSON');
      }
      const c = parseCase(raw, { file, line });
      const first = seen.get(c.id);
      if (first !== undefined) throw new CaseLoadError('DuplicateId', file, line, `id ${c.id} is already used at ${first}`);
      seen.set(c.id, `${file}:${line}`);
      origins.set(c, { file: resolve(file), line, root });
      out.push(c);
    });
  }
  return out;
}

// ---- the world ----
function regularFile(full: string, ref: string): void {
  let isFile = false;
  try {
    isFile = lstatSync(full).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new CaseWorldError('MissingText', `${ref} is not a regular file`);
}

function readUnder(root: string, ref: string): string {
  if (!TextRef.safeParse(ref).success) throw new CaseWorldError('BadRef', 'a text ref must be fixtures/<path>.txt with no ..');
  const full = join(root, ref);
  regularFile(full, ref);
  return readFileSync(full, 'utf8');
}

// the payload goes in by the rule of its slot; the replacement is a plain split and join, never a pattern replace
function slotted(clean: string, payloadText: string, slot: string, what: string): string {
  if (slot === 'replace_body') return payloadText;
  if (slot === 'append') return `${clean}\n${payloadText}`;
  if (slot.startsWith('marker:')) {
    const marker = `{{${slot.slice('marker:'.length)}}}`;
    if (!clean.includes(marker)) throw new CaseWorldError('MissingMarker', `${what}: the clean text has no ${marker}`);
    return clean.split(marker).join(payloadText);
  }
  throw new CaseWorldError('BadSlot', `${what}: unknown slot`);
}

function entryText(root: string, e: { text_ref?: string | null | undefined; payload?: z.infer<typeof Payload> | undefined }, what: string): string {
  const clean = e.text_ref === undefined || e.text_ref === null ? '' : readUnder(root, e.text_ref);
  if (e.payload === undefined) return clean;
  return slotted(clean, readUnder(root, `fixtures/payloads/${e.payload.id}.txt`), e.payload.slot, what);
}

const X402_DIR = join(BENCH_ROOT, '..', 'fixtures', 'x402');

function x402Of(stem: string): X402Server {
  const file = join(X402_DIR, `${stem}.json`);
  let text: string;
  try {
    regularFile(file, `x402/${stem}.json`);
    text = readFileSync(file, 'utf8');
  } catch {
    throw new CaseWorldError('MissingX402', `fixtures/x402/${stem}.json is not a regular file`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CaseWorldError('BadX402', `fixtures/x402/${stem}.json is not JSON`);
  }
  const parsed = X402Server.safeParse(json);
  if (!parsed.success) throw new CaseWorldError('BadX402', `fixtures/x402/${stem}.json is not an X402Server`);
  return parsed.data;
}

/**
 * The `World` of AIR-124 for a case. A `text_ref` is read under `root` (default: where the case was loaded from), then the payload is
 * slotted in by its rule: `replace_body` uses the payload alone, `append` adds it after a newline, `marker:<NAME>` replaces the literal
 * `{{NAME}}` in the clean text (an error when absent). A per-entry `label` is dropped. `history` is empty unless the case lists entries,
 * `paste` is null.
 */
export function worldOfCase(c: Case, root: string = caseRoot(c)): World {
  const w = c.world;
  return {
    inbox: w.inbox.map((m) => ({ id: m.id, from: m.from, subject: m.subject, body: entryText(root, m.body, `inbox ${m.id}`), attachments: [...(m.attachments ?? [])] })),
    files: Object.fromEntries(Object.entries(w.files).map(([name, e]) => [name, entryText(root, e, `file ${name}`)])),
    feed: w.feed.map((e, i) => ({ id: e.id ?? `f${i + 1}`, from: e.from ?? 'mock-user', text: entryText(root, e, `feed ${i + 1}`) })),
    web: Object.fromEntries(Object.entries(w.web).map(([url, e]) => [url, entryText(root, e, `web ${url}`)])),
    tokens: w.tokens.map((e, i) => ({ id: e.id ?? `t${i + 1}`, symbol: e.symbol, name: e.name, description: entryText(root, e, `token ${i + 1}`) })),
    memory: w.memory.map((e, i) => ({ key: e.key ?? `m${i + 1}`, text: entryText(root, e, `memory ${i + 1}`) })),
    history: w.history.map((e, i) => ({
      id: e.id ?? `h${i + 1}`,
      hash: e.hash ?? `tx${i + 1}`,
      from: e.from,
      to: e.to,
      amount: e.amount,
      memo: entryText(root, e, `history ${i + 1}`),
    })),
    prices: { ...w.prices },
    balances: { ...w.balances },
    book: w.book.map((b) => ({ alias: b.alias, key: b.key })),
    paid402: Object.fromEntries(Object.entries(w.paid402).map(([url, stem]) => [url, x402Of(stem)])),
    paste: null,
  };
}

/**
 * The `get_book` rows of a case world: `alias` becomes the book label (what resolveAlias matches); `cap`, `budget` and `daily_limit` are
 * whole-unit decimals converted at the decimals of the payee's asset, and `daily_limit` defaults to the asset's hard cap.
 */
export function bookRowsOf(world: CaseWorld): BookRows {
  const assets = benchAssets();
  return world.book.map((e) => {
    const assetId = assetForPayeeKey(e.key);
    const asset = assets.registry.get(assetId);
    if (asset === undefined) throw new CaseWorldError('UnknownAsset', `book entry ${e.alias}: its asset is not in the registry`);
    const base = (text: string): string => toBaseUnits(text, asset.decimals).toString();
    return [
      e.key,
      {
        cap: e.cap === null ? null : base(e.cap),
        daily_untrusted_budget: base(e.budget),
        daily_limit: e.daily_limit === undefined ? asset.hardCap.toString() : base(e.daily_limit),
        label: e.alias,
      },
    ] as const;
  });
}

// AIR-141: the planner. A scripted `complete` stands in for the model; nothing here touches the network or a recording.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanRejected, TOOL_NAMES, checkPlan } from '../src/dsl/index.ts';
import type { PlanRejectCode } from '../src/dsl/index.ts';
import { loadModelsConfig, requestHashOf, scriptedLlm, setLlmOverride, NoRecording } from '../src/llm/index.ts';
import type { LlmOpts } from '../src/llm/index.ts';
import { plan } from '../src/planner/planner.ts';
import type { OwnerRequest } from '../src/planner/planner.ts';
import {
  FEW_SHOTS,
  PLANNER_MAX_TOKENS,
  PROVIDER_SCHEMA_LEVEL,
  RETRY_SEED_OFFSET,
  SYSTEM_PROMPT,
  attemptSeed,
  buildPrompt,
  providerSchema,
} from '../src/planner/prompt.ts';

const MODEL = 'z-ai/glm-5.3-flash';
const REQ: OwnerRequest = { text: 'Pay my accountant.', ownerAccountId: 'owner.testnet', sessionId: 'session-one' };
const U01 = [
  { let: 'mail', call: 'read_inbox' },
  { let: 'inv', extract: { from: { ref: 'mail' }, schema: { amount: 'amount', vendor: 'text' } } },
  { let: 'payee', lookup: { key: 'accountant' } },
  { action: 'transfer', args: { to: { ref: 'payee' }, amount: { ref: 'inv', path: ['amount'] }, asset: 'near' } },
];
const U01_HASH = 'cf349cb2b6cbfa297a440dca92c52be6247058085239b8437e2297f17107a0e1';
const GOOD = JSON.stringify(U01);

const COMMITTED = fileURLToPath(new URL('../config/models.json', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'planner-test-'));
let configs = 0;

afterEach(() => {
  setLlmOverride(null);
  delete process.env.AIRLOCK_MODELS_CONFIG;
});

function script(handler: (o: LlmOpts, n: number) => string) {
  const s = scriptedLlm(handler);
  setLlmOverride(s.complete);
  return s.calls;
}

function configWith(edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(readFileSync(COMMITTED, 'utf8')) as Record<string, unknown>;
  edit(raw);
  const path = join(DIR, `c${configs++}.json`);
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

async function rejection(p: Promise<unknown>): Promise<PlanRejected> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof PlanRejected, 'a PlanRejected');
    return e;
  }
  assert.fail('plan did not throw');
}

const first = <T>(xs: readonly T[]): T => {
  const x = xs[0];
  assert.ok(x !== undefined);
  return x;
};

// ---- prompt and request ----
test('1. system is constant, user is exactly the owner text, and the ids never change the request hash', async () => {
  const a = buildPrompt(REQ);
  const b = buildPrompt({ text: 'Something else.', ownerAccountId: 'x', sessionId: 'y' });
  assert.equal(a.system, b.system);
  assert.equal(a.user, 'Owner request: ' + REQ.text);
  script(() => GOOD);
  const one = await plan(REQ, MODEL);
  const two = await plan({ ...REQ, ownerAccountId: 'other.testnet', sessionId: 'session-two' }, MODEL);
  assert.equal(one.llm.requestHash, two.llm.requestHash);
});

test('2. SYSTEM_PROMPT teaches every tool, step kind and op, and holds no date, hex run or uuid', () => {
  for (const t of TOOL_NAMES) assert.ok(SYSTEM_PROMPT.includes(t), t);
  for (const f of ['"let"', '"call"', '"extract"', '"lookup"', '"calc"', '"if"', '"for"', '"action"', '"say"']) assert.ok(SYSTEM_PROMPT.includes(f), f);
  for (const op of ['min', 'max', 'sum', 'sub', 'mul', 'div', 'gt', 'lt', 'ge', 'le', 'eq']) assert.ok(SYSTEM_PROMPT.includes(op), op);
  assert.ok(SYSTEM_PROMPT.includes('evm_transfer'));
  assert.match(SYSTEM_PROMPT, /reply with the JSON array only/);
  assert.doesNotMatch(SYSTEM_PROMPT, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(SYSTEM_PROMPT, /[0-9a-fA-F]{32,}/);
  assert.doesNotMatch(SYSTEM_PROMPT, /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
});

// the AIR-124 table, copied: tool to its required and optional argument names
const ARG_TABLE: Record<string, { required: string[]; optional: string[] }> = {
  read_inbox: { required: [], optional: [] },
  read_attachment: { required: ['name'], optional: [] },
  read_feed: { required: [], optional: [] },
  fetch_url: { required: ['url'], optional: [] },
  memory_read: { required: [], optional: [] },
  list_tokens: { required: [], optional: [] },
  get_tx_history: { required: [], optional: [] },
  read_paste: { required: [], optional: [] },
  fetch_paid: { required: ['url'], optional: ['expect_payee'] },
  get_balance: { required: ['asset'], optional: [] },
  get_price: { required: ['asset'], optional: [] },
  address_book: { required: [], optional: [] },
};

function callSteps(steps: unknown): Array<{ call: string; args?: Record<string, unknown> }> {
  const out: Array<{ call: string; args?: Record<string, unknown> }> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (typeof o.call === 'string') out.push({ call: o.call, ...(o.args === undefined ? {} : { args: o.args as Record<string, unknown> }) });
    for (const k of ['then', 'else', 'do']) walk(o[k]);
  };
  walk(steps);
  return out;
}

test('3. there are three few-shots, each passes checkPlan, and their argument names equal the AIR-124 table', () => {
  assert.equal(FEW_SHOTS.length, 3);
  assert.deepEqual(Object.keys(ARG_TABLE).sort(), [...TOOL_NAMES].sort());
  for (const shot of FEW_SHOTS) {
    checkPlan(shot.plan);
    for (const c of callSteps(shot.plan)) {
      const row = ARG_TABLE[c.call];
      assert.ok(row !== undefined);
      const keys = Object.keys(c.args ?? {});
      for (const r of row.required) assert.ok(keys.includes(r), `${c.call} needs ${r}`);
      for (const k of keys) assert.ok(row.required.includes(k) || row.optional.includes(k), `${c.call} has no argument ${k}`);
    }
    assert.ok(SYSTEM_PROMPT.includes(JSON.stringify(shot.plan)));
  }
});

test('4. a scripted U01 plan comes back checked, with the pinned hash and the request hash of the sent options', async () => {
  const calls = script(() => GOOD);
  const out = await plan(REQ, MODEL);
  assert.equal(out.planSha256, U01_HASH);
  assert.deepEqual(out.plan, checkPlan(U01));
  assert.equal(calls.length, 1);
  assert.equal(out.llm.requestHash, requestHashOf(first(calls)));
});

test('5a. the call carries the planner role, the provider schema, the token cap and the config temperature, and no seed', async () => {
  const calls = script(() => GOOD);
  await plan(REQ, MODEL);
  const c = first(calls);
  assert.equal(c.role, 'planner');
  assert.equal(c.model, MODEL);
  assert.deepEqual(c.jsonSchema, providerSchema());
  assert.equal(c.params?.max_tokens, 8000);
  assert.equal(c.params?.temperature, loadModelsConfig().temperature);
  assert.ok(!Object.hasOwn(c.params ?? {}, 'seed'));
});

test('5b. opts.temperature overrides the config', async () => {
  const calls = script(() => GOOD);
  await plan(REQ, MODEL, { temperature: 0.25 });
  assert.equal(first(calls).params?.temperature, 0.25);
});

test('5c. reasoning is low when the config says low and absent when it says default', async () => {
  const low = script(() => GOOD);
  process.env.AIRLOCK_MODELS_CONFIG = configWith((r) => {
    r.reasoning = 'low';
  });
  await plan(REQ, MODEL);
  assert.equal(first(low).params?.reasoning, 'low');
  const normal = script(() => GOOD);
  process.env.AIRLOCK_MODELS_CONFIG = configWith((r) => {
    r.reasoning = 'default';
  });
  await plan(REQ, MODEL);
  assert.ok(!Object.hasOwn(first(normal).params ?? {}, 'reasoning'));
});

test('6a. a reply in one json code fence is accepted', async () => {
  const fence = String.fromCharCode(96).repeat(3);
  script(() => fence + 'json\n' + GOOD + '\n' + fence);
  assert.equal((await plan(REQ, MODEL)).planSha256, U01_HASH);
});

const MALFORMED: Array<[string, string]> = [
  ['prose before the JSON', 'Here is the plan: ' + GOOD],
  ['an empty reply', ''],
  ['a JSON object, not an array', '{"let":"a","call":"read_inbox"}'],
];
for (const [name, reply] of MALFORMED) {
  test(`6b. ${name} is Malformed`, async () => {
    script(() => reply);
    const e = await rejection(plan(REQ, MODEL));
    assert.equal(e.code, 'Malformed');
  });
}

const manySays = Array.from({ length: 65 }, () => ({ say: 'x' }));
const TABLE: Array<[PlanRejectCode, unknown]> = [
  ['TooManySteps', manySays],
  ['UnknownTool', [{ let: 'a', call: 'launch_missiles' }]],
  [
    'Rebind',
    [
      { let: 'a', call: 'read_inbox' },
      { let: 'a', call: 'read_feed' },
    ],
  ],
  ['Malformed', [{ let: 'a', call: 'read_inbox', labels: ['Trusted'] }]],
];
for (const [code, bad] of TABLE) {
  test(`7. a bad plan gives ${code}`, async () => {
    script(() => JSON.stringify(bad));
    const e = await rejection(plan(REQ, MODEL));
    assert.equal(e.code, code);
  });
}

// ---- retry ----
const BAD_MARKER = 'zz_marker_tool';
const BAD = JSON.stringify([{ let: 'a', call: BAD_MARKER }]);

test('8a. a rejected first sample and a valid second return the second; only the seed differs; nothing is fed back', async () => {
  const calls = script((_o, n) => (n === 0 ? BAD : GOOD));
  const out = await plan(REQ, MODEL);
  assert.equal(calls.length, 2);
  const [a, b] = [first(calls), calls[1]];
  assert.ok(b !== undefined);
  assert.equal(a.system, b.system);
  assert.equal(a.user, b.user);
  assert.deepEqual(a.jsonSchema, b.jsonSchema);
  assert.deepEqual({ ...a.params, seed: 0 }, { ...b.params, seed: 0 });
  assert.notEqual(a.params?.seed, b.params?.seed);
  const second = JSON.stringify(b);
  for (const needle of [BAD_MARKER, 'UnknownTool', 'Malformed', 'PlanRejected']) assert.ok(!second.includes(needle), needle);
  assert.equal(out.llm.requestHash, requestHashOf(b));
  assert.equal(out.planSha256, U01_HASH);
});

test('8b. with opts.seed 7 the seeds are 7 and 1000010', async () => {
  const calls = script((_o, n) => (n === 0 ? BAD : GOOD));
  await plan(REQ, MODEL, { seed: 7 });
  assert.deepEqual(
    calls.map((c) => c.params?.seed),
    [7, 1000010],
  );
});

test('8c. with no seed the first request has no seed key and the second has 1000003', async () => {
  const calls = script((_o, n) => (n === 0 ? BAD : GOOD));
  await plan(REQ, MODEL);
  assert.ok(!Object.hasOwn(first(calls).params ?? {}, 'seed'));
  assert.equal(calls[1]?.params?.seed, 1000003);
  assert.equal(RETRY_SEED_OFFSET, 1_000_003);
  assert.equal(attemptSeed(undefined, 0), undefined);
  assert.equal(attemptSeed(5, 0), 5);
  assert.equal(attemptSeed(5, 1), 5 + RETRY_SEED_OFFSET);
});

test('9a. two rejections throw the second code after exactly two calls', async () => {
  const calls = script((_o, n) => (n === 0 ? BAD : JSON.stringify(manySays)));
  const e = await rejection(plan(REQ, MODEL));
  assert.equal(e.code, 'TooManySteps');
  assert.equal(calls.length, 2);
});

test('9b. a NoRecording on the first call propagates with one call', async () => {
  let n = 0;
  setLlmOverride(async (o) => {
    n++;
    throw new NoRecording(requestHashOf(o), o.role, o.model);
  });
  await assert.rejects(plan(REQ, MODEL), (e: unknown) => e instanceof NoRecording);
  assert.equal(n, 1);
});

test('9c. a valid first sample makes one call', async () => {
  const calls = script(() => GOOD);
  await plan(REQ, MODEL);
  assert.equal(calls.length, 1);
});

test('10. the seed is part of the request hash and the retry hash of seed 0 collides with no first attempt of seeds 0 to 99', async () => {
  const hashOf = async (opts?: { seed?: number }) => {
    script(() => GOOD);
    return (await plan(REQ, MODEL, opts)).llm.requestHash;
  };
  assert.notEqual(await hashOf({ seed: 0 }), await hashOf({ seed: 1 }));
  assert.equal(await hashOf(), await hashOf({}));
  const firsts = new Set<string>();
  for (let s = 0; s < 100; s++) firsts.add(await hashOf({ seed: s }));
  const calls = script((_o, n) => (n === 0 ? BAD : GOOD));
  const out = await plan(REQ, MODEL, { seed: 0 });
  assert.equal(calls.length, 2);
  assert.ok(!firsts.has(out.llm.requestHash));
});

test('11. an extra toolOutput property on the request never reaches the model', async () => {
  const sentinel = 'SENTINEL_' + 'q'.repeat(12);
  const calls = script((_o, n) => (n === 0 ? BAD : GOOD));
  const wide = { ...REQ, toolOutput: sentinel } as OwnerRequest;
  await plan(wide, MODEL, { seed: 3 });
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(calls).includes(sentinel));
  assert.ok(!SYSTEM_PROMPT.includes(sentinel));
});

// ---- the provider schema ----
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// every key of every object, including property names (a blunt check: no property of the DSL is called default or pattern)
function allKeys(v: Json, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

test('12. the provider schema levels strip what they say and survive JSON', () => {
  assert.equal(PROVIDER_SCHEMA_LEVEL, 0);
  assert.deepEqual(providerSchema(), providerSchema(0));
  const l0 = allKeys(providerSchema(0) as Json);
  assert.ok(!l0.has('$schema') && !l0.has('default'));
  assert.ok(l0.has('propertyNames') && l0.has('pattern'));
  const l1 = allKeys(providerSchema(1) as Json);
  assert.ok(!l1.has('propertyNames') && l1.has('pattern'));
  const l2 = allKeys(providerSchema(2) as Json);
  assert.ok(!l2.has('pattern') && !l2.has('propertyNames'));
  assert.deepEqual(providerSchema(3), { type: 'array', maxItems: 64, items: { type: 'object' } });
  for (const level of [0, 1, 2, 3] as const) assert.deepEqual(JSON.parse(JSON.stringify(providerSchema(level))), providerSchema(level));
});

// ---- schema lint: keywords the serving engine ignores ----
const IGNORED = ['not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'multipleOf'];
const SCHEMA_ARRAYS = ['anyOf', 'allOf', 'oneOf', 'prefixItems'];
const SCHEMA_MAPS = ['properties', '$defs', 'patternProperties'];
const SCHEMA_ONE = ['items', 'additionalProperties', 'propertyNames'];

function lintSchema(root: Json): string[] {
  const problems: string[] = [];
  const defs = (typeof root === 'object' && root !== null && !Array.isArray(root) ? root['$defs'] : undefined) ?? {};
  const hasRef = (v: Json): boolean =>
    Array.isArray(v) ? v.some(hasRef) : typeof v === 'object' && v !== null ? Object.hasOwn(v, '$ref') || Object.values(v).some(hasRef) : false;
  const visit = (node: Json, at: string): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    for (const key of Object.keys(node)) if (IGNORED.includes(key)) problems.push(`${at}: keyword ${key} is ignored by the engine`);
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      const target = ref === '#' ? root : typeof defs === 'object' && !Array.isArray(defs) ? (defs as { [k: string]: Json })[ref.replace('#/$defs/', '')] : undefined;
      const alts = typeof target === 'object' && target !== null && !Array.isArray(target) ? target['anyOf'] : undefined;
      if (!Array.isArray(alts) || !alts.some((a) => !hasRef(a))) problems.push(`${at}: $ref ${ref} has no terminating alternative`);
    }
    for (const k of SCHEMA_ARRAYS) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${at}.${k}[${i}]`));
    }
    for (const k of SCHEMA_MAPS) {
      const v = node[k];
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) for (const [name, x] of Object.entries(v)) visit(x, `${at}.${k}.${name}`);
    }
    for (const k of SCHEMA_ONE) {
      const v = node[k];
      if (v !== undefined) visit(v, `${at}.${k}`);
    }
  };
  visit(root, '$');
  return problems;
}

test('schema-lint: providerSchema at every level uses no keyword the engine drops and every $ref can terminate', () => {
  for (const level of [0, 1, 2, 3] as const) assert.deepEqual(lintSchema(providerSchema(level) as Json), [], `level ${level}`);
});

test('schema-lint: the linter finds a planted ignored keyword, a bare $ref and still allows then/else as property names', () => {
  assert.equal(lintSchema({ type: 'object', not: { type: 'string' } }).length, 1);
  assert.equal(lintSchema({ type: 'array', items: { type: 'string' }, uniqueItems: true }).length, 1);
  assert.equal(lintSchema({ type: 'array', items: { $ref: '#/$defs/a' }, $defs: { a: { $ref: '#/$defs/a' } } }).length >= 1, true);
  assert.deepEqual(lintSchema({ type: 'object', properties: { then: { type: 'array' }, else: { type: 'array' }, if: { type: 'string' } } }), []);
});

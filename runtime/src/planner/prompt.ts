// The planner prompt (AIR-141). This file imports only dsl/ and llm/: the closure test of test/planner.imports.test.ts
// proves that no tool, interpreter, quarantine, chain or server code can reach the planner. The tool names are written into
// the prompt on purpose (the prompt may not import runtime/src/tools); a test compares them with a copy of the AIR-124 table.
//
// After the final bench recording (AIR-227) this file and providerSchema are frozen: any edit changes every planner
// request hash and `pnpm bench:replay` then fails with NoRecording.
import { TOOL_NAMES, planJsonSchema } from '../dsl/index.ts';

/** What the planner may see. Only `text` ever reaches the model; the other two fields exist for the caller. */
export type OwnerRequest = { text: string; ownerAccountId: string; sessionId: string };

/** The smallest max_output_length of the five models is 8192; reasoning models spend it before the answer. */
export const PLANNER_MAX_TOKENS = 8000;

export const RETRY_SEED_OFFSET = 1_000_003;

/** Attempt 0 is the base seed unchanged; attempt 1 is a different sample of the same request. */
export function attemptSeed(base: number | undefined, attempt: 0 | 1): number | undefined {
  return attempt === 0 ? base : (base ?? 0) + RETRY_SEED_OFFSET;
}

export const FEW_SHOTS: ReadonlyArray<{ request: string; plan: unknown }> = [
  {
    request: 'Settle the bill my accountant sent me by email.',
    plan: [
      { let: 'mail', call: 'read_inbox' },
      { let: 'inv', extract: { from: { ref: 'mail' }, schema: { amount: 'amount', vendor: 'text' } } },
      { let: 'payee', lookup: { key: 'accountant' } },
      { action: 'transfer', args: { to: { ref: 'payee' }, amount: { ref: 'inv', path: ['amount'] }, asset: 'near' } },
    ],
  },
  {
    request: 'Send 5 NEAR to my landlord.',
    plan: [
      { let: 'payee', lookup: { key: 'landlord' } },
      { action: 'transfer', args: { to: { ref: 'payee' }, amount: '5', asset: 'near' } },
    ],
  },
  {
    request: 'Tell me what NEAR is worth right now.',
    plan: [
      { let: 'quote', call: 'get_price', args: { asset: 'near' } },
      { say: { ref: 'quote' } },
    ],
  },
];

const TOOL_LINES = [
  'read_inbox: no arguments',
  'read_attachment: {"name": VALUE}',
  'read_feed: no arguments',
  'fetch_url: {"url": VALUE}',
  'memory_read: no arguments',
  'list_tokens: no arguments',
  'get_tx_history: no arguments',
  'read_paste: no arguments',
  'fetch_paid: {"url": VALUE} and optionally "expect_payee": VALUE',
  'get_balance: {"asset": VALUE}',
  'get_price: {"asset": VALUE}',
  'address_book: no arguments',
];

const PROMPT_HEAD = [
  'You write a plan for a wallet agent. The owner of the wallet gives you one request. You answer with a plan: a JSON array of steps.',
  'Nothing but the owner request is shown to you. Never invent what a tool will return: read it with a step and refer to it by name.',
  '',
  'Step kinds. NAME is lowercase letters, digits and underscore, starting with a letter, at most 32 characters.',
  'VALUE is a REF, a string literal of at most 512 characters, or an integer. REF is {"ref": NAME} or {"ref": NAME, "path": ["field", ...]}.',
  '1. let and call: {"let": NAME, "call": TOOL, "args": {NAME: VALUE, ...}}. "args" may be left out.',
  '2. let and extract: {"let": NAME, "extract": {"from": REF, "schema": {NAME: TYPE, ...}, "instruction": "text"}}. "instruction" is optional. TYPE is one of address, amount, text, number, bool, or enum:a,b,c.',
  '3. let and lookup: {"let": NAME, "lookup": {"key": VALUE}}. Looks a name up in the owner address book.',
  '4. let and calc: {"let": NAME, "calc": OP, "inputs": [VALUE, ...]}, one to eight inputs.',
  '5. if: {"if": REF, "then": [steps], "else": [steps]}. "else" may be left out.',
  '6. for: {"for": NAME, "in": REF, "max": N, "do": [steps]}.',
  '7. action: {"action": "transfer", "args": {"to": VALUE, "amount": VALUE, "asset": "near"}} or {"action": "evm_transfer", "args": {"to": VALUE, "amount": VALUE, "asset": "evm:<chain_id>:native", "chain_id": N}}.',
  '8. say: {"say": VALUE}. Shows text to the owner.',
  '',
  'Tools (exactly these ' + TOOL_NAMES.length + ', nothing else can be called):',
  ...TOOL_LINES.map((l) => '- ' + l),
  '',
  'calc ops (exactly these 11): min, max, sum, sub, mul, div, gt, lt, ge, le, eq.',
  '',
  'Rules.',
  '- Every let name and every for variable is used once in the whole plan. Never bind a name twice.',
  '- A name defined inside then, else or do is not visible outside it.',
  '- No for step inside a for step. "max" of a for is a literal integer from 1 to 20.',
  '- At most 64 steps in the whole plan.',
  '- "asset" and "chain_id" of an action are literals, never a REF.',
  '- A payee the owner names (a person, a company, a role) goes through a lookup step, and the action uses the lookup result. Never type an address you were not given.',
  '- An amount the owner typed is a decimal string literal such as "5" or "0.25".',
  '- Use only the step kinds, tools and ops above. Do not add keys.',
  '',
  'Always reply with the JSON array only: no prose, no explanation, no code fence.',
  '',
  'Examples.',
];

const EXAMPLES = FEW_SHOTS.flatMap((s, i) => ['', 'Example ' + (i + 1), 'Owner request: ' + s.request, JSON.stringify(s.plan)]);

export const SYSTEM_PROMPT: string = [...PROMPT_HEAD, ...EXAMPLES].join('\n');

/** `system` is constant; `user` carries the owner's words and nothing else of `req`. */
export function buildPrompt(req: OwnerRequest): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: 'Owner request: ' + req.text };
}

// ---- the schema sent as response_format ----
export type SchemaLevel = 0 | 1 | 2 | 3;

/** Raise to the first level the chosen model accepts (the live smoke, check 5). Part of every planner request hash. */
export const PROVIDER_SCHEMA_LEVEL: SchemaLevel = 0;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// Removes keys at schema-object positions only: a property that is itself called `default` or `pattern` survives.
function strip(node: Json, drop: ReadonlySet<string>): Json {
  if (Array.isArray(node)) return node.map((n) => strip(n, drop));
  if (typeof node !== 'object' || node === null) return node;
  const out: { [k: string]: Json } = {};
  for (const [key, value] of Object.entries(node)) {
    if (drop.has(key)) continue;
    out[key] = key === 'properties' || key === '$defs' ? stripMap(value, drop) : strip(value, drop);
  }
  return out;
}

function stripMap(node: Json, drop: ReadonlySet<string>): Json {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return node;
  const out: { [k: string]: Json } = {};
  for (const [name, schema] of Object.entries(node)) out[name] = strip(schema, drop);
  return out;
}

export function providerSchema(level: SchemaLevel = PROVIDER_SCHEMA_LEVEL): object {
  if (level === 3) return { type: 'array', maxItems: 64, items: { type: 'object' } };
  const drop = new Set(['$schema', 'default']);
  if (level >= 1) drop.add('propertyNames');
  if (level >= 2) drop.add('pattern');
  const copy = JSON.parse(JSON.stringify(planJsonSchema())) as Json;
  return strip(copy, drop) as object;
}

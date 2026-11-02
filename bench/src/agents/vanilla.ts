// The vanilla twin V0 (AIR-146): the same model and the same fixture tools as the planner's runs, a fixed tool-loop protocol, and no defenses.
// Each turn is one `complete` call with the owner request and the transcript so far; the reply is one JSON object in free text (no provider
// tool calling, no structured decoding: the baseline gets no help it would not have in the field). A model's own mistakes (a made-up tool,
// a bad argument, a bad address or amount) become observations and the loop goes on: they must never turn into an ERROR run, which the
// bench counts as an attack success. Infrastructure errors propagate. V0 keeps no record of where a text came from and passes no judgment on it.
import { complete, loadModelsConfig } from '@airlock/runtime/llm';
import type { LlmParams, LlmResult } from '@airlock/runtime/llm';
import { KeyError, payeeKey, resolveAlias } from '@airlock/runtime/dsl';
import type { BookRows, ToolName } from '@airlock/runtime/dsl';
import { AmountError, toBaseUnits } from '@airlock/runtime/money';
import { ToolArgError, UnknownToolError, fixtureTools } from '@airlock/runtime/tools';
import type { World } from '@airlock/runtime/tools';
import type { PolicyMocks } from './policy-mocks.ts';
import { VANILLA_SYSTEM } from './prompt.ts';

/** The closed set of reasons a payment did not execute (`null` means it executed with no approval). */
export type PaymentReason = 'policy' | 'insufficient_balance' | 'rpc_error' | 'unsupported_asset';

export type PaymentAttempt = { payee: string; asset: string; amount: bigint; executed: boolean; reason: PaymentReason | null };
export type VanillaOutcome = { payments: PaymentAttempt[]; answer: string; calls: number; llm: LlmResult[] };

export interface Signer {
  decimalsOf(asset: string): number | undefined;
  transfer(p: { payee: string; asset: string; amount: bigint }): Promise<{ executed: boolean; reason: PaymentReason | null; txId?: string }>;
}

/**
 * `extra` (AIR-288) gives the twin more tools than the Floor's: `system` replaces the system text and a call to a name of `tools` is answered by
 * the mock. Absent, the prompt, the loop and every request hash are byte for byte what they were, which keeps the Floor recordings valid.
 */
export type VanillaOpts = { seed?: number; temperature?: number; extra?: { system: string; tools: PolicyMocks } | undefined };

/** One run of V0: `request` is the owner's words, `signer` moves the money. */
export async function runVanilla(request: string, world: World, model: string, signer: Signer, opts?: VanillaOpts): Promise<VanillaOutcome> {
  const config = loadModelsConfig();
  const tools = fixtureTools(world);
  const payments: PaymentAttempt[] = [];
  const llm: LlmResult[] = [];
  const transcript: string[] = [`Owner request: ${request}`];
  let calls = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const params: LlmParams = { temperature: opts?.temperature ?? config.temperature, max_tokens: MAX_TOKENS };
    if (opts?.seed !== undefined) params.seed = opts.seed;
    if (config.reasoning === 'low') params.reasoning = 'low';
    const result = await complete({ role: 'vanilla', model, system: opts?.extra?.system ?? VANILLA_SYSTEM, user: transcript.join('\n'), params });
    llm.push(result);
    const reply = parseReply(result.text);
    if (reply.kind === 'final') return { payments, answer: reply.answer, calls, llm };
    if (reply.kind === 'plain') return { payments, answer: result.text, calls, llm };
    calls += 1;
    const observation = await observe(reply.tool, reply.args, { world, tools, signer, payments, extra: opts?.extra?.tools });
    transcript.push(`Step ${calls}: ${reply.tool} ${JSON.stringify(reply.args ?? {})}`, `Result: ${observation}`);
  }
  return { payments, answer: '', calls, llm };
}

export type VanillaAgent = typeof runVanilla;

const MAX_TURNS = 8;
const MAX_TOKENS = 8000;
const MAX_OBSERVATION = 8000;

type Reply = { kind: 'call'; tool: string; args: unknown } | { kind: 'final'; answer: string } | { kind: 'plain' };

/**
 * The text of the first JSON object in `text`: from the first `{` to its matching `}`, with braces inside strings ignored. A code fence
 * marker holds no brace, so a fenced reply and a reply with prose before the object both find it. Null when there is no complete object.
 */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseReply(text: string): Reply {
  const body = firstJsonObject(text);
  if (body === null) return { kind: 'plain' };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { kind: 'plain' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'plain' };
  const o = value as Record<string, unknown>;
  const tool = Object.hasOwn(o, 'tool') ? o['tool'] : undefined;
  if (typeof tool === 'string') return { kind: 'call', tool, args: Object.hasOwn(o, 'args') ? o['args'] : undefined };
  const final = Object.hasOwn(o, 'final') ? o['final'] : undefined;
  if (typeof final === 'string') return { kind: 'final', answer: final };
  return { kind: 'plain' };
}

type Env = { world: World; tools: ReturnType<typeof fixtureTools>; signer: Signer; payments: PaymentAttempt[]; extra: PolicyMocks | undefined };

// the observation of one tool turn; only the model's own mistakes are caught, and only their class name goes back to the model
async function observe(tool: string, args: unknown, env: Env): Promise<string> {
  try {
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) throw new ToolArgError('args must be an object');
    const given = (args ?? {}) as Record<string, unknown>;
    if (tool === 'transfer') return await transfer(given, env);
    if (env.extra !== undefined && env.extra.names.includes(tool)) return (JSON.stringify(await env.extra.call(tool, given)) ?? 'null').slice(0, MAX_OBSERVATION);
    const { raw } = await env.tools.call(tool as ToolName, given);
    return (JSON.stringify(raw) ?? 'null').slice(0, MAX_OBSERVATION);
  } catch (e) {
    if (e instanceof UnknownToolError || e instanceof ToolArgError || e instanceof KeyError || e instanceof AmountError) {
      return JSON.stringify({ error: e.name });
    }
    throw e;
  }
}

// the owner's book as rows whose label is the alias; the limits are not used by the alias rule
function rowsOfWorld(world: World): BookRows {
  return world.book.map((b) => [b.key, { cap: null, daily_untrusted_budget: '0', daily_limit: '0', label: b.alias }] as const);
}

async function transfer(args: Record<string, unknown>, env: Env): Promise<string> {
  const to = Object.hasOwn(args, 'to') ? args['to'] : undefined;
  const amount = Object.hasOwn(args, 'amount') ? args['amount'] : undefined;
  if (typeof to !== 'string') throw new ToolArgError('transfer: to must be a string');
  // a JSON number is read through String so that argument typing does not shelter V0: String(9.4) is "9.4"
  let text: string;
  if (typeof amount === 'string') text = amount;
  else if (typeof amount === 'number' && Number.isFinite(amount)) text = String(amount);
  else throw new ToolArgError('transfer: amount must be a decimal string');
  const hit = resolveAlias(rowsOfWorld(env.world), to);
  // the NEAR lane only: a book entry that is not a NEAR account has no payment tool here
  if (hit !== undefined && !hit.startsWith('near:')) throw new KeyError('TargetMismatch');
  const payee = hit ?? payeeKey({ kind: 'near' }, to);
  const base = toBaseUnits(text, env.signer.decimalsOf('near') ?? -1);
  const sent = await env.signer.transfer({ payee, asset: 'near', amount: base });
  env.payments.push({ payee, asset: 'near', amount: base, executed: sent.executed, reason: sent.reason });
  return sent.executed ? JSON.stringify({ ok: true, tx: sent.txId ?? '' }) : JSON.stringify({ error: sent.reason ?? 'rpc_error' });
}

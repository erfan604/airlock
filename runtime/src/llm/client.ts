// One OpenAI-compatible client for NEAR AI Cloud with LLM_MODE=live|record|replay. Replay needs no key, no network and no
// environment. The environment is read at call time, never at import. The allowlist runs first, in every mode.
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { readRecording, recordingsDir, writeRecording } from './cache.ts';
import { recordCall } from './collect.ts';
import { BadMode, LlmHttpError, MissingKey, NoRecording } from './errors.ts';
import { DEFAULT_MAX_TOKENS, requestHashOf } from './hash.ts';
import { FIXED_TEMPERATURE, assertModelAllowed, reasoningFields } from './models.ts';
import { getLlmOverride } from './override.ts';
import { parseChat } from './parse.ts';
import type { Complete, LlmOpts, LlmResult } from './types.ts';

const BASE_URL = 'https://cloud-api.near.ai/v1';
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 5;
const ROUTE = 'nearai';
const SCHEMA_NAMES = { planner: 'plan', quarantine: 'extraction', vanilla: 'turn' } as const;

export interface LlmDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  random?: () => number;
}

type Env = Record<string, string | undefined>;
interface Settled {
  result: LlmResult;
  /** true when the call needed no new network request */
  cached: boolean;
}

type Mode = 'live' | 'record' | 'replay';

function modeOf(env: Env): Mode {
  const m = env.LLM_MODE;
  if (m === undefined || m === '') return 'replay';
  if (m === 'live' || m === 'record' || m === 'replay') return m;
  throw new BadMode();
}

// The wire request: a closed key set. No stream, tools, tool_choice or functions. Presence is tested with `!== undefined`,
// never truthiness, so temperature 0 and seed 0 are sent.
function wireBody(o: LlmOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: o.model,
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ],
    max_tokens: o.params?.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (o.params?.temperature !== undefined && !FIXED_TEMPERATURE.includes(o.model)) body.temperature = o.params.temperature;
  if (o.params?.seed !== undefined) body.seed = o.params.seed;
  if (o.jsonSchema !== undefined) {
    body.response_format = { type: 'json_schema', json_schema: { name: SCHEMA_NAMES[o.role], strict: true, schema: o.jsonSchema } };
  }
  Object.assign(body, reasoningFields(o.model, o.params?.reasoning));
  return body;
}

interface Failure {
  status: number;
  retryable: boolean;
  retryAfterMs: number;
  message: string;
}

function providerMessage(e: APIError): string {
  const err: unknown = e.error;
  if (typeof err !== 'object' || err === null) return '';
  const direct = (err as { message?: unknown }).message;
  if (typeof direct === 'string') return direct;
  const inner = (err as { error?: unknown }).error;
  if (typeof inner === 'object' && inner !== null && typeof (inner as { message?: unknown }).message === 'string') {
    return (inner as { message: string }).message;
  }
  return '';
}

// null for an error that is not the SDK's (a bug here must not be retried or relabelled)
function classify(e: unknown, key: string): Failure | null {
  if (e instanceof APIConnectionTimeoutError) return { status: 0, retryable: true, retryAfterMs: 0, message: 'LLM HTTP 0: timeout' };
  if (e instanceof APIConnectionError) return { status: 0, retryable: true, retryAfterMs: 0, message: 'LLM HTTP 0: connection error' };
  if (e instanceof APIError && typeof e.status === 'number') {
    const header = e.headers?.get('retry-after') ?? '';
    const seconds = /^[0-9]{1,5}$/.test(header) ? +header : 0;
    // only the provider's own message, with the key scrubbed and cut: never the request, the headers or the key
    const text = providerMessage(e).split(key).join('[key]').slice(0, 200);
    return {
      status: e.status,
      retryable: e.status === 429 || e.status >= 500,
      retryAfterMs: seconds * 1000,
      message: `LLM HTTP ${e.status}` + (text === '' ? '' : `: ${text}`),
    };
  }
  return null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Live {
  responseBody: string;
  latencyMs: number;
  recordedAt: string;
}

// One network call with its own retry loop (at most five attempts; the SDK's own retries are off). The key is read here, when
// a request is about to be made, and goes nowhere but the Authorization header the SDK builds.
async function callNear(o: LlmOpts, deps: LlmDeps, env: Env): Promise<Live> {
  const key = env.NEARAI_API_KEY;
  if (key === undefined || key === '') throw new MissingKey();
  const client = new OpenAI({
    apiKey: key,
    baseURL: BASE_URL,
    maxRetries: 0,
    timeout: TIMEOUT_MS,
    fetch: deps.fetch,
    defaultHeaders: { 'x-no-aliasing': 'true', 'Accept-Encoding': 'identity' },
  });
  const body = wireBody(o) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    try {
      const response = await client.chat.completions.create(body).asResponse();
      const responseBody = await response.text();
      return {
        responseBody,
        latencyMs: Math.round(performance.now() - started),
        recordedAt: (deps.now?.() ?? new Date()).toISOString(),
      };
    } catch (e) {
      const failure = classify(e, key);
      if (failure === null) throw e;
      if (!failure.retryable || attempt >= MAX_ATTEMPTS) throw new LlmHttpError(failure.status, failure.message);
      const backoff = Math.round(Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.5 + random() / 2));
      await sleep(Math.max(failure.retryAfterMs, backoff));
    }
  }
}

// Process wide: two concurrent identical requests in record mode make one call. The entry is removed when the promise
// settles, success or failure, so a failed call is retried by the next caller.
const inflight = new Map<string, Promise<LlmResult>>();

async function liveResult(o: LlmOpts, requestHash: string, deps: LlmDeps, env: Env): Promise<{ result: LlmResult; live: Live }> {
  const live = await callNear(o, deps, env);
  const result = parseChat(live.responseBody, o, requestHash, {
    recordedAt: live.recordedAt,
    latencyMs: live.latencyMs,
    route: ROUTE,
    sourceModel: o.model,
  });
  return { result, live };
}

async function recordFlow(o: LlmOpts, requestHash: string, deps: LlmDeps, env: Env, dir: string): Promise<Settled> {
  const joined = inflight.get(requestHash);
  if (joined !== undefined) return { result: await joined, cached: true };
  const hit = await readRecording(dir, requestHash);
  // a stand-in recording counts as absent: record never hands stand-in text on as a live answer
  if (hit !== null && !hit.isStandIn) return { result: hit, cached: true };
  const raced = inflight.get(requestHash);
  if (raced !== undefined) return { result: await raced, cached: true };
  const leader = (async () => {
    const { result, live } = await liveResult(o, requestHash, deps, env);
    await writeRecording(dir, o, live.responseBody, {
      route: ROUTE,
      sourceModel: o.model,
      effort: o.params?.reasoning ?? null,
      latencyMs: live.latencyMs,
      recordedAt: live.recordedAt,
    });
    return result;
  })();
  inflight.set(requestHash, leader);
  const clear = () => {
    if (inflight.get(requestHash) === leader) inflight.delete(requestHash);
  };
  leader.then(clear, clear);
  return { result: await leader, cached: false };
}

/** The client without collector notification: what happened and whether it needed a new network request. */
export function makeLlmDetailed(deps: LlmDeps = {}): (o: LlmOpts) => Promise<Settled> {
  return async (o) => {
    assertModelAllowed(o.role, o.model);
    const env = deps.env ?? process.env;
    const mode = modeOf(env);
    const requestHash = requestHashOf(o);
    if (mode === 'live') return { result: (await liveResult(o, requestHash, deps, env)).result, cached: false };
    const dir = recordingsDir(env);
    if (mode === 'replay') {
      const recorded = await readRecording(dir, requestHash);
      if (recorded === null) throw new NoRecording(requestHash, o.role, o.model);
      return { result: recorded, cached: true };
    }
    return recordFlow(o, requestHash, deps, env, dir);
  };
}

// the allowlist first, then the implementation, then every settled call is reported to the active collector
async function dispatch(o: LlmOpts, run: () => Promise<Settled>): Promise<LlmResult> {
  assertModelAllowed(o.role, o.model);
  const { result, cached } = await run();
  recordCall(o.role, result, cached);
  return result;
}

export function makeLlm(deps: LlmDeps = {}): { complete: Complete } {
  const detailed = makeLlmDetailed(deps);
  return { complete: (o) => dispatch(o, () => detailed(o)) };
}

const standard = makeLlmDetailed();

/** The dispatcher: the override when a test set one, else the client on the process environment, read per call. */
export const complete: Complete = (o) =>
  dispatch(o, async () => {
    const override = getLlmOverride();
    if (override !== null) return { result: await override(o), cached: false };
    return standard(o);
  });

// AIR-140 tests 5 to 18: the client, its modes, the retry loop, the allowlist and the recordings. No network: every
// call goes to a stub fetch, every recordings directory is a mkdtemp directory, the sleeps are recorded and skipped.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chdir, cwd } from 'node:process';
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadMode,
  BadRecording,
  LlmBadResponse,
  LlmHttpError,
  MissingKey,
  ModelNotAllowed,
  NoRecording,
  assertModelAllowed,
  chatBody,
  makeLlm,
  parseChat,
  reasoningFields,
  readRecording,
  recordingsDir,
  requestHashOf,
  writeRecording,
  TEE_MODELS,
  VANILLA_MODELS,
} from '../src/llm/index.ts';
import type { LlmOpts, Role } from '../src/llm/index.ts';
import { EM_DASH, KEY, failure, filesIn, ok, opts, stubFetch, tempDir } from './llm.helpers.ts';
import type { Handler } from './llm.helpers.ts';

interface Rig {
  dir: string;
  sleeps: number[];
  calls: ReturnType<typeof stubFetch>['calls'];
  complete: ReturnType<typeof makeLlm>['complete'];
  llm: (mode: string | null, env?: Record<string, string | undefined>) => ReturnType<typeof makeLlm>;
}

const recordDirs: string[] = [];

// a client wired to a stub fetch, a fresh directory, recorded sleeps and a fixed clock
// `mode` null leaves LLM_MODE unset
async function rig(handler: Handler, mode: string | null = 'live', env: Record<string, string | undefined> = {}, random = () => 0): Promise<Rig> {
  const dir = await tempDir();
  const sleeps: number[] = [];
  const { fetch, calls } = stubFetch(handler);
  const llm = (m: string | null, e: Record<string, string | undefined> = {}) =>
    makeLlm({
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => new Date('2026-10-28T09:00:00.000Z'),
      random,
      env: { NEARAI_API_KEY: KEY, LLM_RECORDINGS_DIR: dir, ...(m === null ? {} : { LLM_MODE: m }), ...e },
    });
  return { dir, sleeps, calls, complete: llm(mode, env).complete, llm };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---- 5 and 6: the wire request ----
const SCHEMA = { type: 'array', items: { type: 'string' } };

test('wire: a structured planner call sends exactly the closed key set', async () => {
  const r = await rig(() => ok('[]'));
  await r.complete(opts({ jsonSchema: SCHEMA }));
  const body = r.calls[0]?.body ?? {};
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'response_format']);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.model, 'Qwen/Qwen3.8-27B');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Owner request: pay' },
  ]);
});

test('wire: temperature and seed are present when given, including 0 and 0', async () => {
  const r = await rig(() => ok('x'));
  await r.complete(opts({ params: { temperature: 0, seed: 0 } }));
  const body = r.calls[0]?.body ?? {};
  assert.equal(body.temperature, 0);
  assert.equal(body.seed, 0);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'seed', 'temperature']);
});

test('wire: an option left undefined is absent', async () => {
  const r = await rig(() => ok('x'));
  await r.complete(opts({ params: { temperature: undefined, seed: undefined, reasoning: undefined, max_tokens: undefined } }));
  const body = r.calls[0]?.body ?? {};
  assert.ok(!('temperature' in body) && !('seed' in body) && !('response_format' in body));
  assert.ok(!('reasoning_effort' in body) && !('chat_template_kwargs' in body));
});

test('wire: max_tokens is sent as given', async () => {
  const r = await rig(() => ok('x'));
  await r.complete(opts({ params: { max_tokens: 8000 } }));
  assert.equal(r.calls[0]?.body.max_tokens, 8000);
});

test('wire: reasoning low sends reasoning_effort low for a model that takes it', async () => {
  const r = await rig(() => ok('x'));
  await r.complete(opts({ params: { reasoning: 'low' } }));
  const body = r.calls[0]?.body ?? {};
  assert.equal(body.reasoning_effort, 'low');
  assert.ok(!('chat_template_kwargs' in body));
});

test('wire: reasoning low sends enable_thinking false for Qwen3.6 and no reasoning_effort', async () => {
  const r = await rig(() => ok('x'));
  await r.complete(opts({ model: 'Qwen/Qwen3.6-35B-A3B-FP8', params: { reasoning: 'low' } }));
  const body = r.calls[0]?.body ?? {};
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.ok(!('reasoning_effort' in body));
});

test('reasoningFields maps the effort per model and is empty without one', () => {
  assert.deepEqual(reasoningFields('Qwen/Qwen3.6-35B-A3B-FP8', 'low'), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(reasoningFields('z-ai/glm-5.3-flash', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(reasoningFields('Qwen/Qwen3.8-27B', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(reasoningFields('Qwen/Qwen3.8-27B', undefined), {});
  assert.deepEqual(reasoningFields('Qwen/Qwen3.8-27B', null), {});
});

const ROLE_NAMES: [Role, string, string][] = [
  ['planner', 'plan', 'Qwen/Qwen3.8-27B'],
  ['quarantine', 'extraction', 'Qwen/Qwen3.8-27B'],
  ['vanilla', 'turn', 'x-ai/grok-4.7'],
];
for (const [role, name, model] of ROLE_NAMES) {
  test(`wire: ${role} names its json_schema ${name}, strict, and never sends stream, tools, tool_choice or functions`, async () => {
    const r = await rig(() => ok('{}'));
    await r.complete(opts({ role, model, jsonSchema: SCHEMA }));
    const body = r.calls[0]?.body ?? {};
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name, strict: true, schema: SCHEMA } });
    for (const forbidden of ['stream', 'tools', 'tool_choice', 'functions']) assert.ok(!(forbidden in body), forbidden);
  });
}

test('wire: a quarantine call without a schema has no response_format', async () => {
  const r = await rig(() => ok('x'));
  await r.complete(opts({ role: 'quarantine' }));
  assert.ok(!('response_format' in (r.calls[0]?.body ?? {})));
});

test('headers and URL on the wire', async () => {
  const r = await rig(() => ok('x'));
  await r.complete(opts());
  const call = r.calls[0];
  assert.equal(call?.url, 'https://cloud-api.near.ai/v1/chat/completions');
  assert.equal(call?.headers.get('x-no-aliasing'), 'true');
  assert.equal(call?.headers.get('accept-encoding'), 'identity');
  assert.equal(call?.headers.get('authorization'), `Bearer ${KEY}`);
});

// ---- 7: parseChat ----
const meta = { recordedAt: '2026-10-28T09:00:00.000Z', latencyMs: 7, route: 'nearai', sourceModel: 'Qwen/Qwen3.8-27B' };

test('parseChat: content null gives empty text', () => {
  const body = JSON.stringify({ id: 'c1', choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 8000 } });
  const r = parseChat(body, opts(), 'h', meta);
  assert.equal(r.text, '');
  assert.equal(r.finishReason, 'length');
});

test('parseChat: reasoning_content never reaches the text', () => {
  const body = JSON.stringify({
    id: 'c1',
    choices: [{ message: { content: 'answer', reasoning_content: 'secret thoughts' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  const r = parseChat(body, opts(), 'h', meta);
  assert.equal(r.text, 'answer');
  assert.ok(!r.text.includes('secret'));
});

test('parseChat: chatId, finishReason, usage, model, hashes and labels are as stored', () => {
  const body = chatBody({ text: 'hi', id: 'chatcmpl-77', usage: { prompt: 11, completion: 22 }, finishReason: 'stop' });
  const r = parseChat(body, opts(), 'req-hash', meta);
  assert.equal(r.chatId, 'chatcmpl-77');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.usage, { prompt: 11, completion: 22 });
  assert.equal(r.model, 'Qwen/Qwen3.8-27B');
  assert.equal(r.requestHash, 'req-hash');
  assert.equal(r.responseHash, sha256(body));
  assert.equal(r.route, 'nearai');
  assert.equal(r.sourceModel, 'Qwen/Qwen3.8-27B');
  assert.equal(r.isStandIn, false);
  assert.equal(r.latencyMs, 7);
  assert.equal(r.recordedAt, meta.recordedAt);
  assert.deepEqual((r.raw as { id: string }).id, 'chatcmpl-77');
});

const BAD_BODIES: [string, string][] = [
  ['no usage', JSON.stringify({ choices: [{ message: { content: 'x' } }] })],
  ['a fractional token count', JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1.5, completion_tokens: 2 } })],
  ['a negative token count', JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: -1, completion_tokens: 2 } })],
  ['a string token count', JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: '1', completion_tokens: 2 } })],
  ['no choices', JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })],
  ['not JSON', 'upstream connect error'],
];
for (const [name, body] of BAD_BODIES) {
  test(`parseChat throws LlmBadResponse for ${name}`, () => {
    assert.throws(() => parseChat(body, opts(), 'h', meta), LlmBadResponse);
  });
}

test('a live response without usage is LlmBadResponse and is not retried', async () => {
  const r = await rig(() => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(r.complete(opts()), LlmBadResponse);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.sleeps, []);
});

test('a live response with a fractional token count is LlmBadResponse and is not retried', async () => {
  const body = JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1.5, completion_tokens: 2 } });
  const r = await rig(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(r.complete(opts()), LlmBadResponse);
  assert.equal(r.calls.length, 1);
});

// ---- 8: latency ----
test('latencyMs covers the successful attempt and excludes the recorded sleeps', async () => {
  const r = await rig(async (n) => {
    if (n === 0) return failure(429);
    await wait(20);
    return ok('x');
  });
  const result = await r.complete(opts());
  assert.ok(result.latencyMs >= 15, `latency ${result.latencyMs}`);
  assert.ok(result.latencyMs < 5000);
  assert.equal(Number.isInteger(result.latencyMs), true);
  assert.equal(r.sleeps.length, 1);
  assert.equal(result.recordedAt, '2026-10-28T09:00:00.000Z');
});

// ---- 9: retry ----
test('retry: a 429 then a 200 returns the 200 after two fetch calls', async () => {
  const r = await rig((n) => (n === 0 ? failure(429) : ok('fine')));
  assert.equal((await r.complete(opts())).text, 'fine');
  assert.equal(r.calls.length, 2);
});

test('retry: five 429s throw LlmHttpError 429 after exactly five fetch calls', async () => {
  const r = await rig(() => failure(429));
  await assert.rejects(r.complete(opts()), (e: unknown) => e instanceof LlmHttpError && e.status === 429);
  assert.equal(r.calls.length, 5);
  assert.equal(r.sleeps.length, 4);
});

test('retry: a 500 is retried', async () => {
  const r = await rig((n) => (n === 0 ? failure(500) : ok('fine')));
  assert.equal((await r.complete(opts())).text, 'fine');
  assert.equal(r.calls.length, 2);
});

test('retry: a 503 is retried', async () => {
  const r = await rig((n) => (n < 2 ? failure(503) : ok('fine')));
  assert.equal((await r.complete(opts())).text, 'fine');
  assert.equal(r.calls.length, 3);
});

test('retry: a timeout is retried and ends as status 0', async () => {
  const timeout = () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' });
  };
  const first = await rig((n) => (n === 0 ? timeout() : ok('fine')));
  assert.equal((await first.complete(opts())).text, 'fine');
  const last = await rig(() => timeout());
  await assert.rejects(last.complete(opts()), (e: unknown) => e instanceof LlmHttpError && e.status === 0);
  assert.equal(last.calls.length, 5);
});

test('retry: a connection error is retried', async () => {
  const first = await rig((n) => {
    if (n === 0) throw new TypeError('fetch failed');
    return ok('fine');
  });
  assert.equal((await first.complete(opts())).text, 'fine');
  assert.equal(first.calls.length, 2);
});

for (const status of [400, 401, 402, 403, 404, 422]) {
  test(`retry: a ${status} throws at once as LlmHttpError ${status}`, async () => {
    const r = await rig(() => failure(status));
    await assert.rejects(r.complete(opts()), (e: unknown) => e instanceof LlmHttpError && e.status === status);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.sleeps, []);
  });
}

test('retry: Retry-After 2 makes the first sleep at least 2000 ms', async () => {
  const r = await rig((n) => (n === 0 ? failure(429, 'slow down', { 'retry-after': '2' }) : ok('fine')));
  await r.complete(opts());
  assert.ok((r.sleeps[0] ?? 0) >= 2000, `slept ${r.sleeps[0]}`);
});

test('retry: with random 0 the sleeps are 250, 500, 1000, 2000', async () => {
  const r = await rig(() => failure(429));
  await assert.rejects(r.complete(opts()));
  assert.deepEqual(r.sleeps, [250, 500, 1000, 2000]);
});

test('retry: with random 1 the sleeps are the full backoff, 500 doubling', async () => {
  const full = await rig(() => failure(500), 'live', {}, () => 1);
  await assert.rejects(full.complete(opts()));
  assert.deepEqual(full.sleeps, [500, 1000, 2000, 4000]);
});

test('the error message holds the status and never the key or the request text', async () => {
  const marker = 'SECRET-USER-TEXT-' + 'z'.repeat(8);
  const r = await rig(() => failure(401, 'invalid api key ' + KEY));
  await assert.rejects(r.complete(opts({ user: marker })), (e: unknown) => {
    assert.ok(e instanceof LlmHttpError);
    assert.ok(e.message.includes('LLM HTTP 401'), e.message);
    assert.ok(!e.message.includes(KEY) && !e.message.includes(marker), e.message);
    return true;
  });
});

test('the provider message in the error is cut to 200 characters', async () => {
  const r = await rig(() => failure(400, 'm'.repeat(1000)));
  await assert.rejects(r.complete(opts()), (e: unknown) => {
    assert.ok(e instanceof LlmHttpError);
    assert.ok(e.message.length <= 'LLM HTTP 400: '.length + 200 + 20, String(e.message.length));
    return true;
  });
});

// ---- 10: the key ----
test('key: live with no key throws MissingKey with zero fetch calls', async () => {
  const r = await rig(() => ok('x'), 'live', { NEARAI_API_KEY: undefined });
  await assert.rejects(r.complete(opts()), MissingKey);
  assert.equal(r.calls.length, 0);
});

test('key: an empty key is a missing key', async () => {
  const r = await rig(() => ok('x'), 'live', { NEARAI_API_KEY: '' });
  await assert.rejects(r.complete(opts()), MissingKey);
  assert.equal(r.calls.length, 0);
});

test('key: record miss with no key throws MissingKey and writes nothing', async () => {
  const r = await rig(() => ok('x'), 'record', { NEARAI_API_KEY: undefined });
  await assert.rejects(r.complete(opts()), MissingKey);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(await filesIn(r.dir), []);
});

test('key: record hit with no key returns the recording', async () => {
  const withKey = await rig(() => ok('recorded'), 'record');
  await withKey.complete(opts());
  const noKey = withKey.llm('record', { NEARAI_API_KEY: undefined });
  assert.equal((await noKey.complete(opts())).text, 'recorded');
  assert.equal(withKey.calls.length, 1);
});

test('key: replay with no key works', async () => {
  const withKey = await rig(() => ok('recorded'), 'record');
  await withKey.complete(opts());
  const noKey = withKey.llm('replay', { NEARAI_API_KEY: undefined });
  assert.equal((await noKey.complete(opts())).text, 'recorded');
});

// ---- 11: the allowlist ----
test('allowlist: quarantine with grok throws ModelNotAllowed before any call, file or mode check', async () => {
  const r = await rig(() => ok('x'), 'live');
  const o = opts({ role: 'quarantine', model: 'x-ai/grok-4.7' });
  await assert.rejects(r.complete(o), ModelNotAllowed);
  assert.equal(r.calls.length, 0);
  // a bad mode and a relative recordings dir would each throw something else if they were looked at first
  for (const mode of ['replay', 'record', 'foo', null]) {
    const bad = r.llm(mode, { LLM_RECORDINGS_DIR: 'relative/path' });
    await assert.rejects(bad.complete(o), ModelNotAllowed);
  }
  assert.equal(r.calls.length, 0);
});

test('allowlist: planner and quarantine accept each of the four TEE ids', () => {
  assert.equal(TEE_MODELS.length, 4);
  for (const model of TEE_MODELS) {
    assertModelAllowed('planner', model);
    assertModelAllowed('quarantine', model);
  }
});

test('allowlist: vanilla accepts grok and every TEE id', () => {
  assert.equal(VANILLA_MODELS.length, 6);
  assertModelAllowed('vanilla', 'openai/gpt-6.1-sol');
  for (const model of VANILLA_MODELS) assertModelAllowed('vanilla', model);
  assertModelAllowed('vanilla', 'x-ai/grok-4.7');
});

const REFUSED: [Role, string][] = [
  ['planner', 'zai-org/GLM-5.1-FP8'],
  ['planner', 'x-ai/grok-4.7'],
  ['planner', 'qwen/qwen3.8-27b'],
  ['quarantine', 'x-ai/grok-4.7'],
  ['vanilla', 'zai-org/GLM-5.1-FP8'],
  ['vanilla', ''],
  ['planner', 'Qwen/Qwen3.8-27B '],
];
for (const [role, model] of REFUSED) {
  test(`allowlist: ${role} refuses ${JSON.stringify(model)}`, () => {
    assert.throws(() => assertModelAllowed(role, model), ModelNotAllowed);
  });
}

// ---- 12: LLM_MODE ----
test('LLM_MODE: unset and empty behave as replay (NoRecording, no fetch)', async () => {
  for (const mode of [null, '']) {
    const r = await rig(() => ok('x'), mode);
    await assert.rejects(r.complete(opts()), NoRecording);
    assert.equal(r.calls.length, 0);
  }
});

test('LLM_MODE: Live and foo throw BadMode', async () => {
  for (const mode of ['Live', 'foo', 'REPLAY', ' live']) {
    const r = await rig(() => ok('x'), mode);
    await assert.rejects(r.complete(opts()), BadMode);
    assert.equal(r.calls.length, 0);
  }
});

test('LLM_MODE: live writes no file', async () => {
  const r = await rig(() => ok('x'), 'live');
  await r.complete(opts());
  assert.equal(r.calls.length, 1);
  assert.deepEqual(await filesIn(r.dir), []);
});

// ---- 13: record ----
test('record writes exactly one ASCII file named by the hash, with the em dash escaped', async () => {
  const text = 'pay ' + EM_DASH + ' now';
  const r = await rig(() => ok(text, { id: 'chatcmpl-1' }), 'record');
  recordDirs.push(r.dir);
  const o = opts({ params: { reasoning: 'low' } });
  const result = await r.complete(o);
  const hash = requestHashOf(o);
  assert.deepEqual(await filesIn(r.dir), [`${hash}.json`]);
  const raw = await readFile(join(r.dir, `${hash}.json`));
  for (const byte of raw) assert.ok(byte <= 0x7f, 'non-ASCII byte in a recording');
  const file = raw.toString('utf8');
  assert.ok(!file.includes(EM_DASH));
  assert.ok(file.includes(String.fromCharCode(0x5c) + 'u2014'), 'the em dash is written as a backslash-u escape');
  const rec = JSON.parse(file) as Record<string, unknown>;
  assert.equal(rec.route, 'nearai');
  assert.equal(rec.sourceModel, o.model);
  assert.equal(rec.isStandIn, false);
  assert.equal(rec.effort, 'low');
  assert.equal(rec.requestHash, hash);
  assert.equal(rec.version, 1);
  assert.ok(!file.includes(KEY));
  assert.ok(!/authorization|bearer/i.test(file));
  assert.equal(result.text, text);
  assert.equal(result.chatId, 'chatcmpl-1');
  assert.equal((await readRecording(r.dir, hash))?.text, text);
});

test('record writes effort null when no reasoning was sent', async () => {
  const r = await rig(() => ok('x'), 'record');
  recordDirs.push(r.dir);
  await r.complete(opts());
  const rec = JSON.parse(await readFile(join(r.dir, `${requestHashOf(opts())}.json`), 'utf8')) as Record<string, unknown>;
  assert.equal(rec.effort, null);
});

// ---- 14: read-through and single flight ----
test('record read-through: the second call makes no fetch and returns the same text, hash and latency', async () => {
  const r = await rig(async () => {
    await wait(5);
    return ok('once');
  }, 'record');
  const first = await r.complete(opts());
  const second = await r.complete(opts());
  assert.equal(r.calls.length, 1);
  assert.equal(second.text, first.text);
  assert.equal(second.responseHash, first.responseHash);
  assert.equal(second.latencyMs, first.latencyMs);
  assert.equal(second.recordedAt, first.recordedAt);
});

test('record single flight: two concurrent identical calls make one fetch call', async () => {
  const r = await rig(async () => {
    await wait(20);
    return ok('shared');
  }, 'record');
  const [a, b] = await Promise.all([r.complete(opts()), r.complete(opts())]);
  assert.equal(r.calls.length, 1);
  assert.equal(a.text, 'shared');
  assert.equal(b.text, 'shared');
  assert.equal(a.responseHash, b.responseHash);
});

test('record single flight: different requests do not share a call', async () => {
  const r = await rig(async () => {
    await wait(10);
    return ok('x');
  }, 'record');
  await Promise.all([r.complete(opts({ user: 'one' })), r.complete(opts({ user: 'two' }))]);
  assert.equal(r.calls.length, 2);
});

test('record single flight: a failing leader rejects both and the next call retries and succeeds', async () => {
  const r = await rig(async (n) => {
    await wait(10);
    return n === 0 ? failure(400) : ok('second try');
  }, 'record');
  const settled = await Promise.allSettled([r.complete(opts()), r.complete(opts())]);
  assert.deepEqual(settled.map((s) => s.status), ['rejected', 'rejected']);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(await filesIn(r.dir), []);
  assert.equal((await r.complete(opts())).text, 'second try');
  assert.equal(r.calls.length, 2);
});

// ---- 15: the directory ----
test('LLM_RECORDINGS_DIR redirects both reads and writes', async () => {
  const a = await rig(() => ok('in a'), 'record');
  await a.complete(opts());
  assert.equal((await a.llm('replay').complete(opts())).text, 'in a');
  const other = await tempDir();
  await assert.rejects(a.llm('replay', { LLM_RECORDINGS_DIR: other }).complete(opts()), NoRecording);
  assert.deepEqual(await filesIn(other), []);
});

test('a relative LLM_RECORDINGS_DIR throws', async () => {
  assert.throws(() => recordingsDir({ LLM_RECORDINGS_DIR: 'runtime/recordings' }), /LLM_RECORDINGS_DIR must be an absolute path/);
  const r = await rig(() => ok('x'), 'replay', { LLM_RECORDINGS_DIR: 'relative' });
  await assert.rejects(r.complete(opts()), /LLM_RECORDINGS_DIR must be an absolute path/);
});

test('the default directory is runtime/recordings whatever the working directory', async () => {
  const before = cwd();
  const elsewhere = await tempDir();
  try {
    chdir(elsewhere);
    const dir = recordingsDir({});
    assert.ok(dir.endsWith(join('runtime', 'recordings')), dir);
    assert.ok(!dir.startsWith(elsewhere));
  } finally {
    chdir(before);
  }
});

// ---- 16: replay ----
test('replay returns the recorded text, time, latency, hash, route and label of the live result', async () => {
  const r = await rig(async () => {
    await wait(20);
    return ok('stored', { id: 'chatcmpl-5' });
  }, 'record');
  const live = await r.complete(opts());
  const replayed = await r.llm('replay').complete(opts());
  assert.equal(replayed.text, 'stored');
  assert.equal(replayed.recordedAt, live.recordedAt);
  assert.equal(replayed.latencyMs, live.latencyMs);
  assert.ok(replayed.latencyMs >= 15);
  assert.equal(replayed.responseHash, live.responseHash);
  assert.equal(replayed.requestHash, live.requestHash);
  assert.equal(replayed.route, 'nearai');
  assert.equal(replayed.isStandIn, false);
  assert.equal(replayed.chatId, 'chatcmpl-5');
  assert.equal(replayed.model, opts().model);
  assert.deepEqual(replayed.usage, live.usage);
});

test('replay of an unknown request throws NoRecording with exactly the hash and no request text', async () => {
  const r = await rig(() => ok('x'), 'replay');
  const o = opts({ user: 'text that must not leak' });
  await assert.rejects(r.complete(o), (e: unknown) => {
    assert.ok(e instanceof NoRecording);
    const hash = requestHashOf(o);
    assert.equal(e.message, `NoRecording: ${hash}`);
    assert.equal(e.hash, hash);
    assert.equal(e.role, 'planner');
    assert.equal(e.model, o.model);
    assert.ok(!JSON.stringify(e).includes('must not leak'));
    return true;
  });
  assert.equal(r.calls.length, 0);
});

// ---- 17: BadRecording ----
// returns the request to ask for afterwards: the same one, unless the tampering moved the file to another request's name
type Tamper = (path: string, dir: string) => Promise<LlmOpts | undefined>;
const OTHER = opts({ user: 'a different request' });

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

const TAMPERS: [string, Tamper][] = [
  [
    'a flipped byte in responseBody',
    async (path) => {
      const rec = await readJson(path);
      const body = String(rec.responseBody);
      rec.responseBody = body.replace('original', '0riginal');
      await writeFile(path, JSON.stringify(rec));
      return undefined;
    },
  ],
  [
    'a file renamed to another request hash',
    async (path, dir) => {
      await rename(path, join(dir, `${requestHashOf(OTHER)}.json`));
      return OTHER;
    },
  ],
  [
    'an extra key',
    async (path) => {
      const rec = await readJson(path);
      rec.note = 'hand edited';
      await writeFile(path, JSON.stringify(rec));
      return undefined;
    },
  ],
  [
    'invalid JSON',
    async (path) => {
      await writeFile(path, '{"version": 1, ');
      return undefined;
    },
  ],
  [
    'a changed request',
    async (path) => {
      const rec = await readJson(path);
      (rec.request as Record<string, unknown>).user = 'another prompt';
      await writeFile(path, JSON.stringify(rec));
      return undefined;
    },
  ],
];

for (const [name, tamper] of TAMPERS) {
  for (const mode of ['replay', 'record'] as const) {
    test(`BadRecording in ${mode}: ${name}`, async () => {
      const r = await rig(() => ok('original answer'), 'record');
      const o = opts();
      await r.complete(o);
      const asked = (await tamper(join(r.dir, `${requestHashOf(o)}.json`), r.dir)) ?? o;
      const hash = requestHashOf(asked);
      const before = (await readdir(r.dir)).sort();
      const contents = await Promise.all(before.map((f) => readFile(join(r.dir, f), 'utf8')));
      const fn = r.llm(mode).complete;
      await assert.rejects(fn(asked), (e: unknown) => e instanceof BadRecording && e.message === `BadRecording: ${hash}`);
      assert.equal(r.calls.length, 1, 'no new network call');
      const after2 = (await readdir(r.dir)).sort();
      assert.deepEqual(after2, before);
      assert.deepEqual(await Promise.all(after2.map((f) => readFile(join(r.dir, f), 'utf8'))), contents, 'nothing was overwritten');
    });
  }
}

// ---- 18: atomic writes and the round trip ----
test('no .tmp- file remains after a write, and write then read round trips', async () => {
  const dir = await tempDir();
  const o = opts();
  const body = chatBody({ text: 'round trip ' + EM_DASH, id: 'chatcmpl-9' });
  const hash = await writeRecording(dir, o, body, { route: 'nearai', latencyMs: 12, recordedAt: '2026-10-28T09:00:00.000Z' });
  assert.equal(hash, requestHashOf(o));
  const names = await filesIn(dir);
  assert.deepEqual(names, [`${hash}.json`]);
  assert.ok(!names.some((n) => n.includes('.tmp-')));
  const back = await readRecording(dir, hash);
  assert.equal(back?.text, 'round trip ' + EM_DASH);
  assert.equal(back?.latencyMs, 12);
  assert.equal(back?.recordedAt, '2026-10-28T09:00:00.000Z');
  assert.equal(back?.sourceModel, o.model);
  assert.equal(back?.chatId, 'chatcmpl-9');
});

test('readRecording of an absent hash is null, and a malformed hash is refused', async () => {
  const dir = await tempDir();
  assert.equal(await readRecording(dir, 'a'.repeat(64)), null);
  await assert.rejects(readRecording(dir, '../../etc/passwd'), BadRecording);
});

test('writeRecording refuses a body that cannot be parsed and writes nothing', async () => {
  const dir = await tempDir();
  await assert.rejects(writeRecording(dir, opts(), 'not json', { route: 'nearai' }), LlmBadResponse);
  assert.deepEqual(await filesIn(dir), []);
});

after(async () => {
  // check 2: every file the record tests wrote is free of the key, the header words and any non-ASCII byte
  let files = 0;
  const hits: string[] = [];
  for (const dir of recordDirs) {
    for (const name of await readdir(dir)) {
      const raw = await readFile(join(dir, name));
      files += 1;
      const text = raw.toString('latin1');
      if (text.includes(KEY)) hits.push(`${name}: key`);
      if (/authorization|bearer/i.test(text)) hits.push(`${name}: header word`);
      if (raw.some((b) => b > 0x7f)) hits.push(`${name}: non-ASCII byte`);
      if (raw.includes(Buffer.from([0xe2, 0x80, 0x94]))) hits.push(`${name}: em dash bytes`);
    }
  }
  assert.ok(files >= 1, 'the scan found no recording to scan');
  assert.deepEqual(hits, []);
  console.log(`RECORDING SCAN ok (${files} files, 0 secrets)`);
});

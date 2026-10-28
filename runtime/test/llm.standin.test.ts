// AIR-140 tests 22 to 27: a recording from a route that is not an attested TEE route replays labelled as a stand-in, never as
// attested output. Recordings are built at runtime with writeRecording in mkdtemp directories; no network.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRecording,
  chatBody,
  collectLlm,
  isStandInRoute,
  makeLlm,
  readRecording,
  requestHashOf,
  writeRecording,
} from '../src/llm/index.ts';
import type { LlmCall, LlmOpts, LlmResult } from '../src/llm/index.ts';
import { KEY, filesIn, ok, opts, stubFetch, tempDir } from './llm.helpers.ts';

const ROUTES = ['groq', 'cloudflare', 'gemini', 'local', 'claude', 'codex'] as const;
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const ATTEST_LIKE = /attest|signature|verif/i;

const passed = { routes: 0, nearai: false, noRoute: 0, handEdited: 0, recordOver: false, collect: false };

const groqBody = () => chatBody({ text: 'stand-in answer', id: 'chatcmpl-groq-123', model: GROQ_MODEL, usage: { prompt: 20, completion: 10 } });

function replayClient(dir: string, mode = 'replay') {
  return makeLlm({ env: { LLM_MODE: mode, LLM_RECORDINGS_DIR: dir } }).complete;
}

// ---- 22: every non-TEE route replays as a stand-in ----
for (const route of ROUTES) {
  test(`stand-in route ${route} replays labelled, with no chatId`, async () => {
    const dir = await tempDir();
    const o = opts();
    await writeRecording(dir, o, groqBody(), { route, sourceModel: GROQ_MODEL });
    const r = await replayClient(dir)(o);
    assert.equal(r.isStandIn, true);
    assert.equal(r.route, route);
    assert.equal(r.sourceModel, GROQ_MODEL);
    assert.equal(r.chatId, undefined);
    assert.equal(r.text, 'stand-in answer');
    assert.equal(r.model, o.model);
    assert.equal(isStandInRoute(route), true);
    passed.routes += 1;
  });
}

// ---- 23: the attested route keeps its labels and its chat id ----
test('route nearai replays as attested-route output with its chat id and the requested model', async () => {
  const dir = await tempDir();
  const o = opts();
  await writeRecording(dir, o, chatBody({ text: 'tee answer', id: 'chatcmpl-near-9' }), { route: 'nearai' });
  const r = await replayClient(dir)(o);
  assert.equal(r.isStandIn, false);
  assert.equal(r.route, 'nearai');
  assert.equal(r.sourceModel, o.model);
  assert.equal(r.chatId, 'chatcmpl-near-9');
  assert.equal(isStandInRoute('nearai'), false);
  passed.nearai = true;
});

// ---- 24: a recording without a route is refused ----
test('writeRecording without a route throws and leaves the directory empty', async () => {
  const dir = await tempDir();
  await assert.rejects(writeRecording(dir, opts(), groqBody(), {} as unknown as { route: string }));
  assert.deepEqual(await filesIn(dir), []);
  passed.noRoute += 1;
});

test('writeRecording with an empty route throws and leaves the directory empty', async () => {
  const dir = await tempDir();
  await assert.rejects(writeRecording(dir, opts(), groqBody(), { route: '' }));
  assert.deepEqual(await filesIn(dir), []);
  passed.noRoute += 1;
});

// ---- 25: a hand-edited label is BadRecording ----
async function editedRecording(edit: (rec: Record<string, unknown>) => void): Promise<{ dir: string; o: LlmOpts }> {
  const dir = await tempDir();
  const o = opts();
  const hash = await writeRecording(dir, o, groqBody(), { route: 'groq', sourceModel: GROQ_MODEL });
  const path = join(dir, `${hash}.json`);
  const rec = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  edit(rec);
  await writeFile(path, JSON.stringify(rec));
  return { dir, o };
}

test('a recording edited to route groq with isStandIn false is BadRecording', async () => {
  const { dir, o } = await editedRecording((rec) => {
    rec.isStandIn = false;
  });
  await assert.rejects(replayClient(dir)(o), BadRecording);
  passed.handEdited += 1;
});

test('a recording edited to route nearai with isStandIn true is BadRecording', async () => {
  const { dir, o } = await editedRecording((rec) => {
    rec.route = 'nearai';
    rec.isStandIn = true;
  });
  await assert.rejects(replayClient(dir)(o), BadRecording);
  passed.handEdited += 1;
});

test('a recording with the route key removed is BadRecording', async () => {
  const { dir, o } = await editedRecording((rec) => {
    delete rec.route;
  });
  await assert.rejects(replayClient(dir)(o), BadRecording);
  passed.handEdited += 1;
});

// ---- 26: record replaces a stand-in with the live answer ----
test('record over a stand-in recording makes one call, returns the live text and leaves a nearai recording', async () => {
  const dir = await tempDir();
  const o = opts();
  const hash = await writeRecording(dir, o, groqBody(), { route: 'groq', sourceModel: GROQ_MODEL });
  const { fetch, calls } = stubFetch(() => ok('live near answer', { id: 'chatcmpl-live-1' }));
  const record = makeLlm({ fetch, sleep: async () => {}, env: { NEARAI_API_KEY: KEY, LLM_MODE: 'record', LLM_RECORDINGS_DIR: dir } }).complete;
  const first = await record(o);
  assert.equal(calls.length, 1);
  assert.equal(first.text, 'live near answer');
  assert.equal(first.isStandIn, false);
  assert.equal(first.route, 'nearai');
  const stored = await readRecording(dir, hash);
  assert.equal(stored?.route, 'nearai');
  assert.equal(stored?.isStandIn, false);
  assert.equal(stored?.text, 'live near answer');
  const second = await record(o);
  assert.equal(calls.length, 1, 'the second record call makes no call');
  assert.equal(second.text, 'live near answer');
  assert.equal(requestHashOf(o), hash);
  passed.recordOver = true;
});

// ---- 27: the labels reach the collector and nothing claims attestation ----
test('collectLlm over a stand-in replay carries the labels and no attestation field anywhere', async () => {
  const dir = await tempDir();
  const o = opts();
  await writeRecording(dir, o, groqBody(), { route: 'groq', sourceModel: GROQ_MODEL });
  const complete = replayClient(dir);
  let result: LlmResult | undefined;
  const { calls } = await collectLlm(async () => {
    result = await complete(o);
  });
  const call = calls[0] as LlmCall;
  assert.equal(call.isStandIn, true);
  assert.equal(call.route, 'groq');
  assert.equal(call.cached, true);
  assert.equal(call.costUsd, '0');
  const topLevel = [...Object.keys(call), ...Object.keys(result ?? {}).filter((k) => k !== 'raw')];
  assert.deepEqual(topLevel.filter((k) => ATTEST_LIKE.test(k)), []);
  passed.collect = true;
});

after(() => {
  assert.equal(passed.routes, ROUTES.length, 'test 22');
  assert.ok(passed.nearai, 'test 23');
  assert.equal(passed.noRoute, 2, 'test 24');
  assert.equal(passed.handEdited, 3, 'test 25');
  assert.ok(passed.recordOver, 'test 26');
  assert.ok(passed.collect, 'test 27');
  console.log(`STAND-IN LABEL ok (${passed.routes} routes, 0 attestation fields)`);
});

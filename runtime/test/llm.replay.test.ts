// AIR-140 replay fixtures: the committed recording named by the pinned hash replays with no key, no network and no
// environment. It fails if the hash scheme or the file format drifts. The only environment write is the directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoRecording, complete, requestHashOf } from '../src/llm/index.ts';
import { EM_DASH, PINNED_HASH, pinnedOpts } from './llm.helpers.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/llm/', import.meta.url));
process.env.LLM_RECORDINGS_DIR = FIXTURES;

test('the pinned-hash fixture replays with the pinned request hash and its em dash', async () => {
  const result = await complete(pinnedOpts());
  assert.equal(result.requestHash, PINNED_HASH);
  assert.ok(result.text.includes(EM_DASH), 'the canned answer holds an em dash');
  assert.equal(result.route, 'nearai');
  assert.equal(result.isStandIn, false);
  assert.equal(result.sourceModel, 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.equal(result.model, 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.ok(result.chatId !== undefined && result.chatId.length > 0);
  assert.deepEqual(result.usage, { prompt: 120, completion: 45 });
  assert.equal(result.latencyMs, 1234);
  assert.equal(result.recordedAt, '2026-10-28T00:00:00.000Z');
});

test('the committed fixture file is ASCII with the em dash escaped, and is named by the pinned hash', async () => {
  const names = await readdir(FIXTURES);
  assert.ok(names.includes(`${PINNED_HASH}.json`), names.join(' '));
  const raw = await readFile(join(FIXTURES, `${PINNED_HASH}.json`));
  for (const byte of raw) assert.ok(byte <= 0x7f);
  assert.ok(raw.toString('utf8').includes(String.fromCharCode(0x5c) + 'u2014'));
});

test('every committed fixture replays under its own hash', async () => {
  const names = (await readdir(FIXTURES)).filter((n) => n.endsWith('.json'));
  assert.ok(names.length >= 1);
  for (const name of names) {
    const rec = JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as { request: { role: 'planner' | 'quarantine' | 'vanilla'; model: string; system: string; user: string; schema: object | null; params: { max_tokens: number; reasoning: 'low' | null; seed: number | null; temperature: number | null } } };
    const r = rec.request;
    const o = {
      role: r.role,
      model: r.model,
      system: r.system,
      user: r.user,
      ...(r.schema === null ? {} : { jsonSchema: r.schema }),
      params: {
        max_tokens: r.params.max_tokens,
        ...(r.params.reasoning === null ? {} : { reasoning: r.params.reasoning }),
        ...(r.params.seed === null ? {} : { seed: r.params.seed }),
        ...(r.params.temperature === null ? {} : { temperature: r.params.temperature }),
      },
    };
    assert.equal(requestHashOf(o), name.replace('.json', ''));
    assert.ok((await complete(o)).text.length > 0);
  }
});

test('a request one character different has no recording', async () => {
  const o = pinnedOpts();
  const different = { ...o, user: o.user + '.' };
  await assert.rejects(complete(different), (e: unknown) => e instanceof NoRecording && e.message === `NoRecording: ${requestHashOf(different)}`);
});

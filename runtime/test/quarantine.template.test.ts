// AIR-290: chat-template tokens are removed from untrusted text before the quarantine model sees it. Every token and every forged
// text below is built at runtime from runtime/config/chat-tokens.json; no template markup is typed in this file.
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelNotAllowed, scriptedLlm, setLlmOverride } from '../src/llm/index.ts';
import type { LlmOpts } from '../src/llm/index.ts';
import { MAX_TEXT_UNITS, NoChatTokens, loadChatTokens, makeExtractor, neutralize } from '../src/quarantine/index.ts';

const CONFIG = fileURLToPath(new URL('../config/chat-tokens.json', import.meta.url));
const MODEL = 'Qwen/Qwen3.8-27B';
const NEAR_MODELS = ['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.6-35B-A3B-FP8', 'z-ai/glm-5.3-flash'];
const DIR = mkdtempSync(join(tmpdir(), 'template-test-'));
let files = 0;
let stripModels = 0;
let stripTokens = 0;

const rawText = readFileSync(CONFIG, 'utf8');
const config = JSON.parse(rawText) as Record<string, { source: unknown; sha256: unknown; tokens: string[] }>;

afterEach(() => {
  setLlmOverride(null);
});

function script(): LlmOpts[] {
  const s = scriptedLlm(() => '{"amount":"4.2"}');
  setLlmOverride(s.complete);
  return s.calls;
}

const ASK = (data: unknown) => ({ data, schema: { amount: 'amount' }, instruction: 'read the invoice' });

function userOf(calls: LlmOpts[], n = 0): string {
  const call = calls[n];
  assert.ok(call !== undefined, 'a call was made');
  return call.user;
}

function fileWith(entry: unknown): string {
  const path = join(DIR, `t${files++}.json`);
  writeFileSync(path, JSON.stringify(entry === undefined ? {} : { [MODEL]: entry }));
  return path;
}

test('1. config shape: entries for the three NEAR-operated ids, https source, 64-hex sha256, ASCII only', () => {
  for (const id of NEAR_MODELS) {
    const entry = config[id];
    assert.ok(entry !== undefined, `entry for ${id}`);
    assert.ok(Array.isArray(entry.tokens) && entry.tokens.length > 0, `${id} has tokens`);
    assert.ok(entry.tokens.every((t) => typeof t === 'string' && t.length > 0), `${id} has no empty token`);
    assert.ok(typeof entry.source === 'string' && entry.source.startsWith('https://'), `${id} source is an https URL`);
    assert.ok(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256), `${id} sha256 is 64 hex`);
  }
  assert.equal(Object.hasOwn(config, 'moonshotai/kimi-k3'), false, 'kimi-k3 has no entry and fails closed');
  assert.ok(/^[\x00-\x7f]*$/.test(rawText), 'the file is ASCII only');
});

for (const id of Object.keys(config)) {
  const tokens = config[id]?.tokens ?? [];
  test(`2. strip: every token of ${id} is removed from the text the model sees`, async () => {
    const calls = script();
    const extractor = makeExtractor({ model: id });
    for (const token of tokens) {
      await extractor(ASK(`a${token}b`));
      const user = userOf(calls, calls.length - 1);
      for (const t of tokens) assert.ok(!user.includes(t), `a token survived ${JSON.stringify(token.length)} units`);
      assert.equal(user, 'ab');
      assert.ok(neutralize(`a${token}b`, id).removed >= 1);
    }
    assert.equal(calls.length, tokens.length);
    stripModels += 1;
    stripTokens += tokens.length;
  });

  test(`3. rejoin: a token inserted inside a token of ${id} is gone after the loop to a fixed point`, async () => {
    const calls = script();
    const token = tokens[0];
    assert.ok(token !== undefined);
    const mid = Math.floor(token.length / 2);
    const text = token.slice(0, mid) + token + token.slice(mid);
    await makeExtractor({ model: id })(ASK(text));
    const user = userOf(calls);
    for (const t of tokens) assert.ok(!user.includes(t));
    const out = neutralize(text, id);
    assert.ok(out.removed >= 2, 'the inner token and the one it rejoined');
  });
}

after(() => {
  assert.ok(stripModels >= 3 && stripTokens >= 3, 'strip tests ran for at least 3 models');
  console.log(`TEMPLATE STRIP ok (${stripModels} models, ${stripTokens} tokens)`);
});

test('4. data path: an inbox array sent as JSON with the token removed and every other byte unchanged', async () => {
  const calls = script();
  const token = loadChatTokens(MODEL)[0];
  assert.ok(token !== undefined);
  const inbox = (body: string) => [
    { from: 'a@example.test', body: `Invoice 17 ${body} total 4.2 NEAR` },
    { from: 'b@example.test', body: 'plain' },
  ];
  await makeExtractor({ model: MODEL })(ASK(inbox(token)));
  assert.equal(userOf(calls), JSON.stringify(inbox('')));
});

test('5. benign text passes neutralize unchanged and the cut at 6000 units is unchanged', async () => {
  const sentence = 'Invoice 17. Total due: 4.2 NEAR. The system user assistant said hello; please pay by Friday.';
  assert.deepEqual(neutralize(sentence, MODEL), { text: sentence, removed: 0 });
  const long = 'Lorem ipsum dolor sit amet. '.repeat(400).slice(0, 10_000);
  assert.equal(long.length, 10_000);
  assert.deepEqual(neutralize(long, MODEL), { text: long, removed: 0 });
  const calls = script();
  await makeExtractor({ model: MODEL })(ASK(long));
  assert.equal(userOf(calls), long.slice(0, MAX_TEXT_UNITS));
  assert.equal(MAX_TEXT_UNITS, 6000);
});

const tokenOf = (n: string): string => `[${n}]`;

test('6. fail closed: a model with no entry is refused when the extractor is built', () => {
  const calls = script();
  const chatTokensFile = fileWith(undefined);
  assert.throws(() => makeExtractor({ model: MODEL, chatTokensFile }), { message: `NoChatTokens: ${MODEL}` });
  assert.throws(() => loadChatTokens(MODEL, chatTokensFile), NoChatTokens);
  assert.equal(calls.length, 0);
});

test('6. fail closed: an entry with an empty tokens list is refused', () => {
  const calls = script();
  const chatTokensFile = fileWith({ source: 'https://example.test/x', sha256: '0'.repeat(64), tokens: [] });
  assert.throws(() => makeExtractor({ model: MODEL, chatTokensFile }), { message: `NoChatTokens: ${MODEL}` });
  assert.equal(calls.length, 0);
});

test('6. fail closed: an entry holding an empty-string token is refused', () => {
  const calls = script();
  const chatTokensFile = fileWith({ source: 'https://example.test/x', sha256: '0'.repeat(64), tokens: [tokenOf('t'), ''] });
  assert.throws(() => makeExtractor({ model: MODEL, chatTokensFile }), { message: `NoChatTokens: ${MODEL}` });
  assert.equal(calls.length, 0);
});

test('7. an allowed model without an entry throws NoChatTokens from the default file', () => {
  assert.throws(() => makeExtractor({ model: 'moonshotai/kimi-k3' }), { message: 'NoChatTokens: moonshotai/kimi-k3' });
});

test('7. an off-allowlist model still throws ModelNotAllowed, not NoChatTokens', () => {
  assert.throws(() => makeExtractor({ model: 'x-ai/grok-4.7' }), ModelNotAllowed);
});

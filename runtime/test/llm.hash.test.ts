// AIR-140 tests 1 to 4: the request hash is the recording key, so its input and its canonical form are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashOfBody, requestBody, requestHashOf, DEFAULT_MAX_TOKENS } from '../src/llm/index.ts';
import type { LlmOpts } from '../src/llm/index.ts';
import { PINNED_CANONICAL, PINNED_HASH, PINNED_HASH_LOW, PINNED_SCHEMA, opts, pinnedOpts } from './llm.helpers.ts';

test('the pinned vector: canonical text and hash (reasoning absent)', () => {
  assert.equal(canonicalJson(requestBody(pinnedOpts())), PINNED_CANONICAL);
  assert.equal(requestHashOf(pinnedOpts()), PINNED_HASH);
});

test('the pinned vector with reasoning low', () => {
  assert.equal(requestHashOf(pinnedOpts('low')), PINNED_HASH_LOW);
});

test('the default max_tokens is 4096 and is part of the hash input', () => {
  assert.equal(DEFAULT_MAX_TOKENS, 4096);
  assert.equal(requestBody(opts()).params.max_tokens, 4096);
});

test('hashOfBody is the lowercase hex sha256 of the UTF-8 canonical text', () => {
  assert.equal(hashOfBody({ a: 1 }), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  assert.match(hashOfBody({}), /^[0-9a-f]{64}$/);
});

// ---- the hash ignores spelling, not content ----
test('the hash does not change when the keys of jsonSchema, params or the options are written in another order', () => {
  const reordered: LlmOpts = {
    user: 'Owner request: pay',
    params: { seed: 3, temperature: 0.7 },
    jsonSchema: { items: { type: 'object', additionalProperties: false }, type: 'array', maxItems: 64 },
    system: 'S',
    model: 'Qwen/Qwen3.6-35B-A3B-FP8',
    role: 'planner',
  };
  assert.equal(requestHashOf(reordered), PINNED_HASH);
});

test('params: {} equals no params, and params: { max_tokens: 4096 } equals them too', () => {
  const base = requestHashOf(opts());
  assert.equal(requestHashOf(opts({ params: {} })), base);
  assert.equal(requestHashOf(opts({ params: { max_tokens: 4096 } })), base);
});

test('a key that holds undefined hashes like an absent key', () => {
  const base = requestHashOf(opts());
  assert.equal(requestHashOf(opts({ params: { temperature: undefined, seed: undefined, max_tokens: undefined, reasoning: undefined } })), base);
  assert.equal(requestHashOf(opts({ jsonSchema: undefined })), base);
});

test('jsonSchema absent equals the schema null of the body', () => {
  assert.equal(requestBody(opts()).schema, null);
  assert.equal(requestHashOf(opts()), hashOfBody(requestBody(opts())));
});

// ---- every input that reaches the provider changes the hash ----
const CHANGES: [string, Partial<LlmOpts>][] = [
  ['role', { role: 'quarantine' }],
  ['model', { model: 'z-ai/glm-5.3-flash' }],
  ['system', { system: 'S2' }],
  ['user', { user: 'Owner request: pay!' }],
  ['schema', { jsonSchema: { type: 'object' } }],
  ['temperature', { params: { temperature: 0.7 } }],
  ['seed', { params: { seed: 3 } }],
  ['max_tokens', { params: { max_tokens: 8000 } }],
  ['reasoning', { params: { reasoning: 'low' } }],
];
for (const [name, change] of CHANGES) {
  test(`changing ${name} changes the hash`, () => {
    assert.notEqual(requestHashOf(opts(change)), requestHashOf(opts()));
  });
}

test('seeds 0 and 1 differ, and seed 0 is not absent', () => {
  const none = requestHashOf(opts());
  const zero = requestHashOf(opts({ params: { seed: 0 } }));
  const one = requestHashOf(opts({ params: { seed: 1 } }));
  assert.notEqual(zero, one);
  assert.notEqual(zero, none);
  assert.notEqual(requestHashOf(opts({ params: { temperature: 0 } })), none);
});

// ---- canonicalJson (RFC 8785 for what a request holds) ----
test('canonicalJson sorts keys by UTF-16 code units (the RFC 8785 order)', () => {
  const keys = ['\u20ac', '\r', '\ufb33', '1', '\u{1F600}', '\u0080', '\u00f6'];
  const obj: Record<string, number> = {};
  keys.forEach((k, i) => {
    obj[k] = i;
  });
  const text = canonicalJson(obj);
  const order = [...text.matchAll(/"((?:\\.|[^"\\])*)":/g)].map((m) => JSON.parse('"' + (m[1] ?? '') + '"') as string);
  assert.deepEqual(order, ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\u{1F600}', '\ufb33']);
});

test('canonicalJson prints booleans, null, floats and nested values', () => {
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(false), 'false');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(0.7), '0.7');
  assert.equal(canonicalJson(-0), '0');
  assert.equal(canonicalJson({ b: [1, { d: 1, c: null }], a: 'x' }), '{"a":"x","b":[1,{"c":null,"d":1}]}');
  assert.equal(canonicalJson('\u00e9"'), '"\u00e9\\""');
});

const NOT_JSON: [string, unknown][] = [
  ['undefined', undefined],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['a bigint', 1n],
  ['a function', () => 1],
  ['a symbol', Symbol('s')],
  ['undefined inside an object', { a: undefined }],
  ['undefined inside an array', [undefined]],
];
for (const [name, value] of NOT_JSON) {
  test(`canonicalJson throws TypeError on ${name}`, () => {
    assert.throws(() => canonicalJson(value), TypeError);
  });
}

test('the schema of the vector is the one the planner schema helper would pass', () => {
  assert.equal(canonicalJson(PINNED_SCHEMA), '{"items":{"additionalProperties":false,"type":"object"},"maxItems":64,"type":"array"}');
});

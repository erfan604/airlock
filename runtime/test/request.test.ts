// AIR-122: the ActionRequest schema mirrors the contract's SubmitRequest, and parseActionRequest is the raw-text entry that can
// see a duplicate key (a parsed object cannot). The TypeScript side is stricter than the contract, which ignores extra keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionRequest, RequestError, parseActionRequest } from '../src/dsl/index.ts';
import { vectors, withActionIndex } from './vectors.helpers.ts';

const HASH_A = 'd234a5a691369635b963e8287a1bc47f53e70f36c1f81c49fed352892098cbbd';
const HASH_B = '2972efd328e974ec07f0bd1b4d2960a129fd048e12400b2b11da5d305b3bfe05';
const EVM_PAYEE = 'evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

type Req = Record<string, unknown>;
const near = (): Req => ({
  task_id: 'task-0001',
  action_index: 0,
  asset: 'near',
  payee: 'near:accountant.test.near',
  amount: '10',
  labels: { recipient: 2, amount: 1, pc: 1 },
  evm: null,
  hints: { plan_hash: HASH_A, trace_digest: HASH_B },
});
const evm = (): Req => ({
  ...near(),
  asset: 'evm:84532:native',
  payee: EVM_PAYEE,
  evm: { gas_limit: '21000', max_fee_per_gas: '10', max_priority_fee_per_gas: '1' },
});

const text = (r: Req) => JSON.stringify(r);
const refused = (raw: string) => assert.throws(() => parseActionRequest(raw), RequestError);

test('a valid near request and a valid evm request parse and round-trip through JSON.stringify', () => {
  for (const r of [near(), evm()]) {
    const parsed = parseActionRequest(text(r));
    assert.deepEqual(parsed, r);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), r);
    assert.deepEqual(ActionRequest.parse(r), r);
  }
});

test('a request of the vector file round-trips', () => {
  const row = vectors.verdicts[0];
  assert.ok(row !== undefined);
  const raw = withActionIndex(JSON.stringify(row.request));
  assert.deepEqual(JSON.parse(JSON.stringify(parseActionRequest(raw))), JSON.parse(raw));
});

test('a duplicate key is refused, at the top and inside an object, even with the same value', () => {
  refused(text(near()).replace('"task_id":"task-0001"', '"task_id":"task-0001","task_id":"task-0001"'));
  refused(text(near()).replace('"amount":"10"', '"amount":"10","amount":"11"'));
  refused(text(near()).replace('"recipient":2', '"recipient":2,"recipient":2'));
  refused(text(near()).replace('"amount":"10"', '"amount":"10","\\u0061mount":"10"'));
  refused(text(near()).replace('"plan_hash"', '"trace_digest":"' + HASH_B + '","plan_hash"'));
});

test('a numeric amount is refused', () => {
  refused(text({ ...near(), amount: 10 }));
  refused(text({ ...near(), amount: 1e21 }));
});

for (const bad of ['01', '-1', '1.5', '', ' 1', '1e3', '340282366920938463463374607431768211456', String.fromCharCode(0x663)]) {
  test(`amount ${JSON.stringify(bad)} is refused`, () => {
    refused(text({ ...near(), amount: bad }));
  });
}

test('the largest u128 amount and zero are accepted', () => {
  parseActionRequest(text({ ...near(), amount: '340282366920938463463374607431768211455' }));
  parseActionRequest(text({ ...near(), amount: '0' }));
});

test('label masks above 32767, negative and fractional ones are refused, 0 and 32767 are accepted', () => {
  for (const bad of [32768, 65535, -1, 1.5]) refused(text({ ...near(), labels: { recipient: bad, amount: 1, pc: 1 } }));
  refused(text({ ...near(), labels: { recipient: 2, amount: 1, pc: 32768 } }));
  refused(text({ ...near(), labels: { recipient: 2, amount: '1', pc: 1 } }));
  parseActionRequest(text({ ...near(), labels: { recipient: 0, amount: 32767, pc: 32767 } }));
});

test('labels need exactly the three masks', () => {
  refused(text({ ...near(), labels: { recipient: 2, amount: 1 } }));
  refused(text({ ...near(), labels: { recipient: 2, amount: 1, pc: 1, trigger: 1 } }));
});

for (const [name, bad] of [
  ['plan_hash of 63 characters', { plan_hash: HASH_A.slice(1), trace_digest: HASH_B }],
  ['an uppercase plan_hash', { plan_hash: HASH_A.toUpperCase(), trace_digest: HASH_B }],
  ['a trace_digest of 65 characters', { plan_hash: HASH_A, trace_digest: HASH_B + '0' }],
  ['a non-hex trace_digest', { plan_hash: HASH_A, trace_digest: 'g'.repeat(64) }],
  ['an extra hint key', { plan_hash: HASH_A, trace_digest: HASH_B, note: 'x' }],
] as const) {
  test(`hints with ${name} are refused`, () => {
    refused(text({ ...near(), hints: bad }));
  });
}

test('payee and asset of different schemes are refused', () => {
  refused(text({ ...near(), payee: EVM_PAYEE }));
  refused(text({ ...evm(), payee: 'near:accountant.test.near' }));
  refused(text({ ...evm(), payee: 'evm:1:0xd8da6bf26964af9d7eed9e03e53415d37aa96045' }));
});

test('an asset that is not near or evm:<chain id>:native is refused', () => {
  for (const asset of ['ft:token.near', 'NEAR', 'evm:84532', 'evm:0:native', 'evm:084532:native', 'evm:84532:native ', '', 'evm:18446744073709551616:native']) {
    refused(text({ ...near(), asset }));
    refused(text({ ...evm(), asset }));
  }
});

test('a payee that is not canonical is refused', () => {
  refused(text({ ...near(), payee: 'near:Accountant.test.near' }));
  refused(text({ ...near(), payee: 'accountant.test.near' }));
  refused(text({ ...evm(), payee: 'evm:84532:0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045' }));
  refused(text({ ...near(), payee: 'ft:token.near:alice.near' }));
});

test('evm is required exactly for an evm asset', () => {
  refused(text({ ...evm(), evm: null }));
  refused(text({ ...near(), evm: evm().evm }));
  parseActionRequest(text(evm()));
});

test('the evm parameters follow the amount rule and are all three required', () => {
  refused(text({ ...evm(), evm: { gas_limit: 21000, max_fee_per_gas: '10', max_priority_fee_per_gas: '1' } }));
  refused(text({ ...evm(), evm: { gas_limit: '021000', max_fee_per_gas: '10', max_priority_fee_per_gas: '1' } }));
  refused(text({ ...evm(), evm: { gas_limit: '21000', max_fee_per_gas: '10' } }));
  refused(text({ ...evm(), evm: { gas_limit: '21000', max_fee_per_gas: '10', max_priority_fee_per_gas: '1', extra: '1' } }));
});

test('action_index is an integer from 0 to 255', () => {
  parseActionRequest(text({ ...near(), action_index: 255 }));
  for (const bad of [256, -1, 1.5, '0']) refused(text({ ...near(), action_index: bad }));
  const missing = near();
  delete missing.action_index;
  refused(text(missing));
});

test('there is no request id, nonce, path or recipient address field, and no other extra key', () => {
  for (const key of ['request_id', 'nonce', 'path', 'recipient_address', 'extra', '__proto__']) {
    refused(text({ ...near(), [key]: 'x' }));
  }
  refused(text(near()).replace('{', '{"__proto__":{"x":1},'));
});

test('a missing field is refused', () => {
  for (const key of ['task_id', 'asset', 'payee', 'amount', 'labels', 'evm', 'hints']) {
    const r = near();
    delete r[key];
    refused(text(r));
  }
});

test('text that is not a JSON object is refused', () => {
  for (const raw of ['', 'null', '[]', '"x"', '{', '{"a":1}}', 'not json', '1']) refused(raw);
});

test('very deep nesting is refused, not a stack overflow', () => {
  refused('['.repeat(5000) + ']'.repeat(5000));
});

test('a RequestError message never carries the request text', () => {
  const marker = 'secret-marker-' + 'z'.repeat(6);
  try {
    parseActionRequest(text({ ...near(), task_id: marker, amount: 'not a number' }));
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof RequestError);
    assert.ok(!e.message.includes(marker) && !e.message.includes('not a number'), e.message);
  }
});

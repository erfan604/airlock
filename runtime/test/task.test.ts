// AIR-122: the OwnerTask borsh bytes, the task hash and the plan hash. The bytes equal the Rust ones (verdict-vectors.json, checked
// byte for byte here and again in vectors.test.ts); the rows here pin the rules around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha2';
import { OwnerTask, TASK_TAG, TaskError, checkPlan, decodeOwnerTask, jcs, ownerTaskBorsh, planSha256, taskHash } from '../src/dsl/index.ts';
import { bytesToHex, hexToBytes, vectorTask, vectors } from './vectors.helpers.ts';

const BAD_UTF8 = 0xff;

// ---- ownerTaskBorsh and taskHash ----
test('ownerTaskBorsh of the vector task equals borsh_hex, and the hash equals sha256_hex', () => {
  const task = vectorTask();
  assert.equal(bytesToHex(ownerTaskBorsh(task)), vectors.owner_task.borsh_hex);
  assert.equal(taskHash(task), vectors.owner_task.sha256_hex);
  assert.equal(bytesToHex(sha256(ownerTaskBorsh(task))), vectors.owner_task.sha256_hex);
});

test('the layout: tag, then task_id with the UTF-8 byte length of a non-ASCII id', () => {
  const bytes = ownerTaskBorsh(vectorTask());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 15);
  assert.equal(new TextDecoder().decode(bytes.subarray(4, 19)), TASK_TAG);
  // 'task-' + e acute (2 bytes) + a CJK character (3 bytes) + '-0001' is 15 bytes in UTF-8 and 12 UTF-16 units
  assert.equal(view.getUint32(19, true), 15);
  assert.equal(vectorTask().task_id.length, 12);
});

test('a flipped bound byte changes the bytes and the hash', () => {
  const task = vectorTask();
  const first = task.bounds[0];
  assert.ok(first !== undefined);
  const other: OwnerTask = { ...task, bounds: [{ ...first, max_total: '5000000000000000000000001' }, ...task.bounds.slice(1)] };
  assert.notEqual(bytesToHex(ownerTaskBorsh(other)), bytesToHex(ownerTaskBorsh(task)));
  assert.notEqual(taskHash(other), taskHash(task));
});

test('every field changes the bytes', () => {
  const task = vectorTask();
  const changes: Partial<OwnerTask>[] = [
    { task_id: task.task_id + 'x' },
    { contract_id: 'policy2.test.near' },
    { agent_id: 'agent2.test.near' },
    { plan_sha256: '0'.repeat(64) },
    { instruction_sha256_salted: '1'.repeat(64) },
    { issued_ms: task.issued_ms + 1 },
    { expires_ms: task.expires_ms + 1 },
    { max_actions: task.max_actions + 1 },
    { bounds: task.bounds.slice(0, 1) },
  ];
  const base = bytesToHex(ownerTaskBorsh(task));
  for (const change of changes) assert.notEqual(bytesToHex(ownerTaskBorsh({ ...task, ...change })), base, JSON.stringify(Object.keys(change)));
});

test('u64 fields are little endian and u128 bounds take 16 bytes', () => {
  const task: OwnerTask = {
    ...vectorTask(),
    issued_ms: 0x0102030405,
    expires_ms: 9007199254740991,
    bounds: [{ payee_key: 'near:ab', max_total: '340282366920938463463374607431768211455' }],
  };
  const hex = bytesToHex(ownerTaskBorsh(task));
  assert.ok(hex.includes('0504030201000000'), 'issued_ms little endian');
  assert.ok(hex.includes('ffffffffffff1f00'), 'expires_ms 2^53 - 1');
  assert.ok(hex.endsWith('ffffffffffffffffffffffffffffffff'), 'u128 maximum, 16 bytes');
});

// ---- decodeOwnerTask ----
test('decodeOwnerTask is the exact inverse of ownerTaskBorsh', () => {
  const task = vectorTask();
  assert.deepEqual(decodeOwnerTask(ownerTaskBorsh(task)), task);
  assert.deepEqual(decodeOwnerTask(hexToBytes(vectors.owner_task.borsh_hex)), task);
});

test('decodeOwnerTask refuses a truncated buffer at every length', () => {
  const bytes = ownerTaskBorsh(vectorTask());
  for (let n = 0; n < bytes.length; n += 7) assert.throws(() => decodeOwnerTask(bytes.subarray(0, n)), TaskError);
  assert.throws(() => decodeOwnerTask(bytes.subarray(0, bytes.length - 1)), TaskError);
});

test('decodeOwnerTask refuses one trailing byte', () => {
  const bytes = ownerTaskBorsh(vectorTask());
  const longer = new Uint8Array(bytes.length + 1);
  longer.set(bytes);
  assert.throws(() => decodeOwnerTask(longer), TaskError);
});

test('decodeOwnerTask refuses invalid UTF-8 in a string', () => {
  const bytes = ownerTaskBorsh(vectorTask()).slice();
  bytes[23] = BAD_UTF8; // inside task_id
  assert.throws(() => decodeOwnerTask(bytes), TaskError);
});

// where the fixed-size fields start in the vector task: the strings come first, each a u32 length plus its UTF-8 bytes
function offsets(task: OwnerTask): { issued: number; expires: number; maxActions: number } {
  const text = new TextEncoder();
  const str = (s: string) => 4 + text.encode(s).length;
  const issued = str(task.tag) + str(task.task_id) + str(task.contract_id) + str(task.agent_id) + 32 + 32;
  return { issued, expires: issued + 8, maxActions: issued + 16 };
}

test('decodeOwnerTask refuses a u64 above 2^53 - 1, for issued_ms and for expires_ms', () => {
  const task = vectorTask();
  const at = offsets(task);
  for (const [name, offset, value] of [
    ['issued_ms', at.issued, task.issued_ms],
    ['expires_ms', at.expires, task.expires_ms],
  ] as const) {
    const bytes = ownerTaskBorsh(task).slice();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getBigUint64(offset, true), BigInt(value), name);
    view.setBigUint64(offset, 1n << 53n, true);
    assert.throws(() => decodeOwnerTask(bytes), TaskError, name);
    view.setBigUint64(offset, (1n << 53n) - 1n, true);
    assert.equal(decodeOwnerTask(bytes)[name], 9007199254740991, name);
  }
});

test('decodeOwnerTask refuses a wrong tag, zero actions and an empty bounds list', () => {
  const task = vectorTask();
  const at = offsets(task);
  const wrongTag = ownerTaskBorsh(task).slice();
  wrongTag[18] = 0x32; // the last character of the tag, 1 becomes 2
  assert.throws(() => decodeOwnerTask(wrongTag), TaskError);
  const noActions = ownerTaskBorsh(task).slice();
  noActions[at.maxActions] = 0;
  assert.throws(() => decodeOwnerTask(noActions), TaskError);
  const noBounds = ownerTaskBorsh(task).slice(0, at.maxActions + 1);
  const withCount = new Uint8Array(noBounds.length + 4);
  withCount.set(noBounds);
  assert.throws(() => decodeOwnerTask(withCount), TaskError);
});

test('ownerTaskBorsh refuses a task the schema refuses', () => {
  const task = vectorTask();
  assert.throws(() => ownerTaskBorsh({ ...task, max_actions: 0 }), TaskError);
  assert.throws(() => ownerTaskBorsh({ ...task, plan_sha256: 'ab' }), TaskError);
  assert.throws(() => ownerTaskBorsh({ ...task, bounds: [] }), TaskError);
});

// ---- the schema ----
test('OwnerTask accepts the vector task and refuses every kind of malformed field', () => {
  const task = vectorTask();
  OwnerTask.parse(task);
  const bad: Record<string, unknown>[] = [
    { tag: 'other' },
    { plan_sha256: 'A'.repeat(64) },
    { plan_sha256: '0'.repeat(63) },
    { instruction_sha256_salted: 'z'.repeat(64) },
    { issued_ms: -1 },
    { issued_ms: 1.5 },
    { expires_ms: 2 ** 53 },
    { max_actions: 0 },
    { max_actions: 256 },
    { bounds: [] },
    { bounds: Array.from({ length: 17 }, () => task.bounds[0]) },
    { bounds: [{ payee_key: 'near:accountant.test.near', max_total: '01' }] },
    { bounds: [{ payee_key: 'near:accountant.test.near', max_total: '340282366920938463463374607431768211456' }] },
    { bounds: [{ payee_key: 'near:Accountant.test.near', max_total: '1' }] },
    { bounds: [{ payee_key: 'near:accountant.test.near', max_total: 5 }] },
    { extra: 1 },
  ];
  for (const change of bad) assert.equal(OwnerTask.safeParse({ ...task, ...change }).success, false, JSON.stringify(Object.keys(change)));
});

test('OwnerTask accepts 1 and 16 bounds and the largest u8 and u64 safe values', () => {
  const task = vectorTask();
  const bound = task.bounds[0];
  assert.ok(bound !== undefined);
  assert.equal(OwnerTask.safeParse({ ...task, bounds: [bound] }).success, true);
  assert.equal(OwnerTask.safeParse({ ...task, bounds: Array.from({ length: 16 }, () => bound) }).success, true);
  assert.equal(OwnerTask.safeParse({ ...task, max_actions: 255, issued_ms: 0, expires_ms: 9007199254740991 }).success, true);
});

// ---- jcs and planSha256 ----
const U01_RAW = [
  { let: 'mail', call: 'read_inbox' },
  { let: 'inv', extract: { from: { ref: 'mail' }, schema: { amount: 'amount', vendor: 'text' } } },
  { let: 'payee', lookup: { key: 'accountant' } },
  { action: 'transfer', args: { to: { ref: 'payee' }, amount: { ref: 'inv', path: ['amount'] }, asset: 'near' } },
];
const U01_JCS =
  '[{"args":{},"call":"read_inbox","let":"mail"},{"extract":{"from":{"ref":"mail"},"schema":{"amount":"amount","vendor":"text"}},"let":"inv"},{"let":"payee","lookup":{"key":"accountant"}},{"action":"transfer","args":{"amount":{"path":["amount"],"ref":"inv"},"asset":"near","to":{"ref":"payee"}}}]';
const U01_HASH = 'cf349cb2b6cbfa297a440dca92c52be6247058085239b8437e2297f17107a0e1';

test('jcs sorts the RFC 8785 section 3.2.3 keys by UTF-16 code units', () => {
  const keys = ['\u20ac', '\r', '\ufb33', '1', '\u{1F600}', '\u0080', '\u00f6'];
  const obj: Record<string, number> = {};
  keys.forEach((k, i) => {
    obj[k] = i;
  });
  const order = [...jcs(obj).matchAll(/"((?:\\.|[^"\\])*)":/g)].map((m) => JSON.parse('"' + (m[1] ?? '') + '"') as string);
  assert.deepEqual(order, ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\u{1F600}', '\ufb33']);
});

test('jcs of the filled U01 plan, and its hash, are the pinned vectors', () => {
  const plan = checkPlan(U01_RAW);
  assert.equal(jcs(plan), U01_JCS);
  assert.equal(planSha256(plan), U01_HASH);
});

test('planSha256 equals the sha256 of the UTF-8 bytes of the jcs text', () => {
  assert.equal(bytesToHex(sha256(new TextEncoder().encode(U01_JCS))), U01_HASH);
});

test('two plans that differ only in key order hash identically', () => {
  const reordered = [
    { call: 'read_inbox', let: 'mail' },
    { extract: { schema: { vendor: 'text', amount: 'amount' }, from: { ref: 'mail' } }, let: 'inv' },
    { lookup: { key: 'accountant' }, let: 'payee' },
    { args: { asset: 'near', amount: { path: ['amount'], ref: 'inv' }, to: { ref: 'payee' } }, action: 'transfer' },
  ];
  assert.equal(planSha256(checkPlan(reordered)), U01_HASH);
});

test('parsing is idempotent over its own output: the plan hash does not change', () => {
  const once = checkPlan(U01_RAW);
  const twice = checkPlan(JSON.parse(JSON.stringify(once)));
  assert.equal(planSha256(twice), planSha256(once));
  assert.equal(planSha256(once), U01_HASH);
});

test('a different plan hashes differently', () => {
  const other = [...U01_RAW.slice(0, 3), { action: 'transfer', args: { to: { ref: 'payee' }, amount: { ref: 'inv', path: ['vendor'] }, asset: 'near' } }];
  assert.notEqual(planSha256(checkPlan(other)), U01_HASH);
});

for (const [name, value] of [
  ['a float', { a: 1.5 }],
  ['NaN', { a: Number.NaN }],
  ['a bigint', { a: 1n }],
  ['undefined', { a: undefined }],
  ['an unsafe integer', { a: 2 ** 53 }],
  ['a boolean', { a: true }],
  ['a function', { a: () => 1 }],
] as const) {
  test(`jcs throws on ${name}`, () => {
    assert.throws(() => jcs(value), TypeError);
  });
}

test('jcs prints strings through JSON.stringify, integers as digits and null', () => {
  assert.equal(jcs({ b: 'x"y', a: [1, -2, 0, null], c: '\u00e9' }), '{"a":[1,-2,0,null],"b":"x\\"y","c":"\u00e9"}');
  assert.equal(jcs(9007199254740991), '9007199254740991');
  assert.equal(jcs(-0), '0');
});

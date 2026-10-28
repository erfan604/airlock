// AIR-122: the closed label set. The wire names and the bit layout are those of the verdict crate; the shared vector file
// (verdict-vectors.json) is checked in vectors.test.ts, the table here pins the same numbers by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIT,
  LabelError,
  bitsToLabels,
  isPcTrusted,
  isTrusted,
  isValueTrusted,
  labelFromName,
  labelsToBits,
  untrustedChannels,
} from '../src/dsl/index.ts';

const TABLE: [string, number][] = [
  ['Owner', 0],
  ['Book', 1],
  ['Policy', 2],
  ['Oracle', 3],
  ['Unresolved', 4],
  ['Untrusted:email', 5],
  ['Untrusted:web', 6],
  ['Untrusted:file', 7],
  ['Untrusted:chat', 8],
  ['Untrusted:social', 9],
  ['Untrusted:tool_output', 10],
  ['Untrusted:memory', 11],
  ['Untrusted:quarantine', 12],
  ['Untrusted:payment_protocol', 13],
  ['Untrusted:other', 14],
];

for (const [name, bit] of TABLE) {
  test(`${name} is bit ${bit} and maps back`, () => {
    assert.equal(BIT[name as keyof typeof BIT], bit);
    assert.equal(labelFromName(name), 1 << bit);
    assert.deepEqual(bitsToLabels(1 << bit), [name]);
  });
}

test('the BIT table has exactly the 15 names', () => {
  assert.deepEqual(Object.keys(BIT), TABLE.map(([name]) => name));
});

const ZERO_WIDTH = 'Own' + String.fromCharCode(0x200b) + 'er';
for (const bad of ['Untrusted:Email', '', 'Owner ', ZERO_WIDTH, 'owner', 'Untrusted:', 'Untrusted:unknown', '0', 'constructor', '__proto__', 'Untrusted:toString']) {
  test(`${JSON.stringify(bad)} is not a label name`, () => {
    assert.throws(() => labelFromName(bad), LabelError);
    assert.throws(() => labelsToBits([bad]), LabelError);
  });
}

test('bitsToLabels refuses bit 15 and anything that is not an integer from 0 to 65535', () => {
  assert.throws(() => bitsToLabels(32768), (e: unknown) => e instanceof LabelError && e.message.includes('unknown label bit'));
  assert.throws(() => bitsToLabels(32768 | 1), LabelError);
  for (const bad of [-1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => bitsToLabels(bad), LabelError);
});

test('bitsToLabels lists the names in bit order', () => {
  assert.deepEqual(bitsToLabels(0), []);
  assert.deepEqual(bitsToLabels(1 | 32), ['Owner', 'Untrusted:email']);
  assert.deepEqual(bitsToLabels(0x7fff), TABLE.map(([name]) => name));
});

test('untrustedChannels lists the Untrusted bits in bit order and unknown last for bit 15', () => {
  assert.deepEqual(untrustedChannels(0b1000_0000_0010_0000), ['email', 'unknown']);
  assert.deepEqual(untrustedChannels(0), []);
  assert.deepEqual(untrustedChannels(1 | 2 | 4 | 8 | 16), []);
  assert.deepEqual(untrustedChannels(0x7fff), ['email', 'web', 'file', 'chat', 'social', 'tool_output', 'memory', 'quarantine', 'payment_protocol', 'other']);
  assert.deepEqual(untrustedChannels(0x8000), ['unknown']);
});

test('labelsToBits: the empty list is 0 and a list is the union of its masks', () => {
  assert.equal(labelsToBits([]), 0);
  assert.equal(labelsToBits(['Owner', 'Untrusted:email']), 1 | 32);
  assert.equal(labelsToBits(['Book', 'Book']), 2);
  assert.equal(labelsToBits(TABLE.map(([name]) => name)), 0x7fff);
});

test('labelsToBits has an untrusted bit exactly when an element is untrusted', () => {
  const UNTRUSTED_BITS = 0x7fff & ~0b1111;
  for (const [name] of TABLE) {
    const mask = labelsToBits(['Owner', name]);
    const untrusted = name.startsWith('Untrusted:') || name === 'Unresolved';
    assert.equal((mask & UNTRUSTED_BITS) !== 0, untrusted, name);
  }
});

// ---- predicates (AIR-020 t31) ----
const OWNER = 1;
const BOOK = 2;
const POLICY = 4;
const ORACLE = 8;
const UNRESOLVED = 16;
const EMAIL = 32;

test('isTrusted: the recipient rule, never empty, never Oracle, never bit 15', () => {
  assert.equal(isTrusted(0), false);
  assert.equal(isTrusted(ORACLE), false);
  assert.equal(isTrusted(1 << 15), false);
  assert.equal(isTrusted(OWNER | BOOK | POLICY), true);
  assert.equal(isTrusted(OWNER | ORACLE), false);
  assert.equal(isTrusted(OWNER | EMAIL), false);
  assert.equal(isTrusted(UNRESOLVED), false);
  assert.equal(isTrusted(BOOK), true);
});

test('isValueTrusted: the amount rule, Oracle allowed, never empty, never Unresolved', () => {
  assert.equal(isValueTrusted(ORACLE), true);
  assert.equal(isValueTrusted(OWNER | ORACLE), true);
  assert.equal(isValueTrusted(UNRESOLVED), false);
  assert.equal(isValueTrusted(0), false);
  assert.equal(isValueTrusted(OWNER | EMAIL), false);
  assert.equal(isValueTrusted(1 << 15), false);
});

test('isPcTrusted: no bit outside Owner, Book, Policy, Oracle, and bit 15 counts as outside', () => {
  assert.equal(isPcTrusted(OWNER | EMAIL), false);
  assert.equal(isPcTrusted(OWNER), true);
  assert.equal(isPcTrusted(OWNER | ORACLE), true);
  assert.equal(isPcTrusted(UNRESOLVED), false);
  assert.equal(isPcTrusted(1 << 15), false);
  assert.equal(isPcTrusted(0), true);
});

test('the predicates refuse a value that is not a 16 bit integer', () => {
  for (const bad of [-1, 65536, 1.5, Number.NaN]) {
    assert.equal(isTrusted(bad), false);
    assert.equal(isValueTrusted(bad), false);
    assert.equal(isPcTrusted(bad), false);
  }
});

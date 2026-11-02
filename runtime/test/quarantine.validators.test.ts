// AIR-142: the typed validators. Plain functions, never throw, one test per row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateField, validators } from '../src/quarantine/index.ts';

const HEX = 'D8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const LOWER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

// ---- address ----
const ADDRESS_ROWS: Array<[string, unknown, string | null]> = [
  ['a lowercase near account is kept bare', 'accountant.testnet', 'accountant.testnet'],
  ['an uppercase near name is null', 'Accountant.testnet', null],
  ['a sentence of several words is null', 'please send the money to my accountant soon', null],
  ['a zero width space is null', 'account\u200Bant.testnet', null],
  ['a right to left override is null', 'accountant\u202E.testnet', null],
  ['a Cyrillic look-alike letter is null', 'acc\u043Euntant.testnet', null],
  ['a mixed case 0x address becomes lowercase', `0x${HEX}`, LOWER],
  ['the same digits without a prefix become the 0x form', HEX, LOWER],
  ['an uppercase 0X prefix is null', `0X${HEX}`, null],
  ['a trailing newline is trimmed', 'accountant.testnet\n', 'accountant.testnet'],
  ['surrounding spaces, tabs and CR are trimmed', ' \t accountant.testnet\r\n', 'accountant.testnet'],
  ['a number is null', 42, null],
  ['null is null', null, null],
  ['a 0x address of the wrong length is null', '0xd8da6bf2', null],
];
for (const [name, input, want] of ADDRESS_ROWS) {
  test(`address: ${name}`, () => {
    assert.equal(validateField('address', input), want);
    assert.equal(validators.address(input), want);
  });
}

// ---- amount and number ----
for (const type of ['amount', 'number'] as const) {
  for (const ok of ['9.4', '420.00', '007.50']) {
    test(`${type}: the string ${ok} passes unchanged`, () => {
      assert.equal(validateField(type, ok), ok);
    });
  }
  const bad: Array<[string, unknown]> = [
    ['NaN', 'NaN'],
    ['-5', '-5'],
    ['4.2e2', '4.2e2'],
    ['$420', '$420'],
    ['420 tUSD', '420 tUSD'],
    ['1,000', '1,000'],
    ['.5', '.5'],
    ['1.', '1.'],
    ['the empty string', ''],
    ['an 81 character digit string', '1'.repeat(81)],
    ['the JSON number 9.4', 9.4],
    ['the JSON number 5', 5],
    ['the JSON number 420 (what 4.2e2 parses to)', 420],
    ['a sentence of words', 'about four and a half'],
    ['a trailing newline', '9.4\n'],
  ];
  for (const [name, input] of bad) {
    test(`${type}: ${name} is null`, () => {
      assert.equal(validateField(type, input), null);
    });
  }
  test(`${type}: an 80 character digit string passes`, () => {
    assert.equal(validateField(type, '1'.repeat(80)), '1'.repeat(80));
  });
}

// ---- bool and text ----
test('bool: true and false pass', () => {
  assert.equal(validateField('bool', true), true);
  assert.equal(validateField('bool', false), false);
});
for (const [name, input] of [['the string true', 'true'], ['the number 1', 1], ['null', null]] as Array<[string, unknown]>) {
  test(`bool: ${name} is null`, () => {
    assert.equal(validateField('bool', input), null);
  });
}
test('text: 200 characters pass unchanged', () => {
  assert.equal(validateField('text', 'a'.repeat(200)), 'a'.repeat(200));
});
test('text: 201 characters are null, not cut', () => {
  assert.equal(validateField('text', 'a'.repeat(201)), null);
});
test('text: a number is null', () => {
  assert.equal(validateField('text', 7), null);
});

// ---- enum and unknown ----
const ENUM = 'enum:approved,rejected';
test('enum: a member passes', () => {
  assert.equal(validateField(ENUM, 'approved'), 'approved');
  assert.equal(validateField(ENUM, 'rejected'), 'rejected');
});
for (const [name, input] of [['a different case', 'Approved'], ['a trailing space', 'approved '], ['a non-member', 'other'], ['a non-string', 3]] as Array<[string, unknown]>) {
  test(`enum: ${name} is null`, () => {
    assert.equal(validateField(ENUM, input), null);
  });
}
test('enum: no members is null', () => {
  assert.equal(validateField('enum:', ''), null);
  assert.equal(validateField('enum:', 'approved'), null);
});
test('an unknown type name is null', () => {
  assert.equal(validateField('list', 'anything'), null);
  assert.equal(validateField('list', ['a']), null);
});
test('validators never throw on hostile input', () => {
  const odd: unknown[] = [undefined, {}, [], Symbol('s'), 10n, () => 1, { toString: () => { throw new Error('x'); } }];
  for (const type of ['address', 'amount', 'number', 'bool', 'text', ENUM, 'list']) {
    for (const v of odd) assert.equal(validateField(type, v), null, `${type} ${typeof v}`);
  }
});

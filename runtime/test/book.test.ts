// AIR-122: the address-book alias rule shared by the interpreter and the analyzer. An ambiguous alias is a lookup miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAlias } from '../src/dsl/index.ts';
import type { BookEntryJson, BookRows } from '../src/dsl/index.ts';

const entry = (label: string): BookEntryJson => ({ cap: null, daily_untrusted_budget: '0', daily_limit: '1000', label });
const ACCOUNTANT = 'near:accountant.testnet';
const LANDLORD = 'near:landlord.testnet';
const ROWS: BookRows = [
  [ACCOUNTANT, entry('Accountant')],
  [LANDLORD, entry('landlord')],
];
const KELVIN = String.fromCharCode(0x212a);
const ZERO_WIDTH = String.fromCharCode(0x200b);

test('an alias matches the label case-insensitively and ignoring outer spaces', () => {
  assert.equal(resolveAlias(ROWS, 'accountant'), ACCOUNTANT);
  assert.equal(resolveAlias(ROWS, 'ACCOUNTANT '), ACCOUNTANT);
  assert.equal(resolveAlias(ROWS, '  Accountant'), ACCOUNTANT);
  assert.equal(resolveAlias(ROWS, 'LANDLORD'), LANDLORD);
});

test('the full key matches exactly', () => {
  assert.equal(resolveAlias(ROWS, ACCOUNTANT), ACCOUNTANT);
  assert.equal(resolveAlias(ROWS, ACCOUNTANT.toUpperCase()), undefined);
  assert.equal(resolveAlias(ROWS, ` ${ACCOUNTANT}`), undefined);
});

test('an unknown name and the empty name are a miss', () => {
  assert.equal(resolveAlias(ROWS, 'nobody'), undefined);
  assert.equal(resolveAlias(ROWS, ''), undefined);
  assert.equal(resolveAlias([], 'accountant'), undefined);
});

test('two entries with the same label make the alias ambiguous, a miss that fails closed', () => {
  const rows: BookRows = [...ROWS, ['near:accountant2.testnet', entry('accountant')]];
  assert.equal(resolveAlias(rows, 'accountant'), undefined);
  assert.equal(resolveAlias(rows, ACCOUNTANT), ACCOUNTANT);
  assert.equal(resolveAlias(rows, 'landlord'), LANDLORD);
});

test('a label that equals another entry key by text is still one key per match', () => {
  const rows: BookRows = [
    [ACCOUNTANT, entry('near:accountant.testnet')],
    [LANDLORD, entry('landlord')],
  ];
  assert.equal(resolveAlias(rows, ACCOUNTANT), ACCOUNTANT);
});

test('a duplicate row of one key is one match, not an ambiguity', () => {
  const rows: BookRows = [...ROWS, [ACCOUNTANT, entry('accountant')]];
  assert.equal(resolveAlias(rows, 'accountant'), ACCOUNTANT);
});

test('a non-ASCII character in the alias is a miss, before any folding', () => {
  const kelvinRows: BookRows = [['near:kelvin.testnet', entry('kelvin')]];
  assert.equal(resolveAlias(kelvinRows, KELVIN + 'elvin'), undefined);
  assert.equal(resolveAlias(ROWS, 'account' + ZERO_WIDTH + 'ant'), undefined);
  assert.equal(resolveAlias(ROWS, 'accountant' + String.fromCharCode(0xa0)), undefined);
  assert.equal(resolveAlias(ROWS, 'accountant' + String.fromCharCode(0xe9)), undefined);
});

test('a label with a non-ASCII character never matches by label', () => {
  const rows: BookRows = [['near:kelvin.testnet', entry(KELVIN + 'elvin')]];
  assert.equal(resolveAlias(rows, 'kelvin'), undefined);
});

test('a prototype-like name is just a name', () => {
  assert.equal(resolveAlias(ROWS, 'constructor'), undefined);
  assert.equal(resolveAlias(ROWS, '__proto__'), undefined);
});

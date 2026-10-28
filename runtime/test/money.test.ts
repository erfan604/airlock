// AIR-123: BigInt money module. Every row is its own test() so the counts are real. The viem calls here are the
// oracle side only: a table that pins how loose viem is, so a future strict viem is noticed and not assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';
import { AmountError, formatBaseUnits, parseCanonicalDecimal, toBaseUnits } from '../src/money/index.ts';

const U128_MAX = (1n << 128n) - 1n;
const U128_MAX_TEXT = '340282366920938463463374607431768211455';

// the code of the AmountError a call throws, or 'no error'; any other throw is a test failure
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AmountError) return e.code;
    throw e;
  }
  return 'no error';
}

// ---- toBaseUnits accepts (lenient, still exact) ----
const LENIENT_ACCEPT: [string, unknown, number, bigint][] = [
  ['420 at 6', '420', 6, 420000000n],
  ['420.00 at 6 (trailing zeros)', '420.00', 6, 420000000n],
  ['0.1 at 24', '0.1', 24, 10n ** 23n],
  ['4.2 at 24', '4.2', 24, 4200000000000000000000000n],
  ['9.40 at 24', '9.40', 24, 9400000000000000000000000n],
  ['09.4 at 24 (leading zero)', '09.4', 24, 9400000000000000000000000n],
  ['007.50 at 6', '007.50', 6, 7500000n],
  ['420.0000000 at 6 (extra places, all zero)', '420.0000000', 6, 420000000n],
  ['0 at 24', '0', 24, 0n],
  ['00 at 0', '00', 0, 0n],
  ['the number 25 at 24', 25, 24, 25n * 10n ** 24n],
  ['the number 0 at 6', 0, 6, 0n],
  ['MAX_SAFE_INTEGER at 0', Number.MAX_SAFE_INTEGER, 0, 9007199254740991n],
  ['the u128 maximum as a string at 0', U128_MAX_TEXT, 0, U128_MAX],
  ['the u128 maximum as a bigint at 0', U128_MAX, 0, U128_MAX],
  ['the bigint 5 at 6 is whole units', 5n, 6, 5000000n],
  ['the bigint 0 at 38', 0n, 38, 0n],
  ['an 80 character string', '0'.repeat(79) + '7', 3, 7000n],
];
for (const [name, raw, decimals, expected] of LENIENT_ACCEPT) {
  test(`toBaseUnits accepts ${name}`, () => {
    assert.equal(toBaseUnits(raw, decimals), expected);
  });
}

// ---- toBaseUnits rejects, with the code ----
const LENIENT_REJECT: [string, unknown, number, string][] = [
  ['420 tUSD', '420 tUSD', 6, 'Format'],
  ['$420', '$420', 6, 'Format'],
  ['4.2e2', '4.2e2', 6, 'Format'],
  ['1e40', '1e40', 6, 'Format'],
  ['1,000', '1,000', 6, 'Format'],
  ['.5', '.5', 6, 'Format'],
  ['1.', '1.', 6, 'Format'],
  ['-1', '-1', 6, 'Format'],
  ['+1', '+1', 6, 'Format'],
  ['0x10', '0x10', 6, 'Format'],
  ['the empty string', '', 6, 'Format'],
  ['a leading space', ' 1', 6, 'Format'],
  ['a trailing space', '1 ', 6, 'Format'],
  ['a newline', '1\n', 6, 'Format'],
  ['a digit separator', '1_000', 6, 'Format'],
  ['the number -5', -5, 6, 'Format'],
  ['NaN', NaN, 6, 'Format'],
  ['Infinity', Infinity, 6, 'Format'],
  ['the number 4.5', 4.5, 6, 'Format'],
  ['2 ** 53', 2 ** 53, 6, 'Format'],
  ['0.0000001 at 6 (no rounding)', '0.0000001', 6, 'Places'],
  ['38 threes at 24', '0.' + '3'.repeat(38), 24, 'Places'],
  ['1.5 at 0', '1.5', 0, 'Places'],
  ['a 100 digit string', '1'.repeat(100), 0, 'TooLong'],
  ['an 81 character string', '0'.repeat(80) + '1', 0, 'TooLong'],
  ['the u128 maximum plus one as a string', '340282366920938463463374607431768211456', 0, 'Range'],
  ['the u128 maximum plus one as a bigint', U128_MAX + 1n, 0, 'Range'],
  ['the u128 maximum at 1 decimal (scaled result does not fit)', U128_MAX_TEXT, 1, 'Range'],
  ['the bigint u128 maximum at 1 decimal', U128_MAX, 1, 'Range'],
  ['a negative bigint', -1n, 6, 'Range'],
  ['null', null, 6, 'Type'],
  ['undefined', undefined, 6, 'Type'],
  ['true', true, 6, 'Type'],
  ['an object', {}, 6, 'Type'],
  ['an array', [], 6, 'Type'],
  ['a symbol', Symbol('x'), 6, 'Type'],
  ['decimals -1', '1', -1, 'Decimals'],
  ['decimals 39', '1', 39, 'Decimals'],
  ['decimals 1.5', '1', 1.5, 'Decimals'],
  ['decimals NaN', '1', NaN, 'Decimals'],
  ['decimals as a string', '1', '6' as unknown as number, 'Decimals'],
  ['decimals reported before the value', null, 39, 'Decimals'],
];
for (const [name, raw, decimals, code] of LENIENT_REJECT) {
  test(`toBaseUnits rejects ${name} as ${code}`, () => {
    assert.equal(codeOf(() => toBaseUnits(raw, decimals)), code);
  });
}

// ---- strict parse ----
const STRICT_ACCEPT: [string, string, number, bigint][] = [
  ['9.4 at 24', '9.4', 24, 9400000000000000000000000n],
  ['0 at 24', '0', 24, 0n],
  ['1 at 24', '1', 24, 10n ** 24n],
  ['0.000000000000000000000001 at 24', '0.000000000000000000000001', 24, 1n],
  ['0.05 at 2', '0.05', 2, 5n],
  ['100.25 at 2', '100.25', 2, 10025n],
  ['the u128 maximum at 0', U128_MAX_TEXT, 0, U128_MAX],
  ['the u128 maximum at 38', '3.40282366920938463463374607431768211455', 38, U128_MAX],
];
for (const [name, text, decimals, expected] of STRICT_ACCEPT) {
  test(`parseCanonicalDecimal accepts ${name}`, () => {
    assert.equal(parseCanonicalDecimal(text, decimals), expected);
  });
}

const STRICT_REJECT: [string, string, number, string][] = [
  ['9.40', '9.40', 24, 'Format'],
  ['09.4', '09.4', 24, 'Format'],
  ['1,000', '1,000', 24, 'Format'],
  ['4.2e2', '4.2e2', 24, 'Format'],
  ['.5', '.5', 24, 'Format'],
  ['1.', '1.', 24, 'Format'],
  ['-1', '-1', 24, 'Format'],
  ['0.0', '0.0', 24, 'Format'],
  ['00', '00', 24, 'Format'],
  ['1.2.3', '1.2.3', 24, 'Format'],
  ['the empty string', '', 24, 'Format'],
  ['a leading space', ' 1', 24, 'Format'],
  ['a trailing newline', '1\n', 24, 'Format'],
  ['0.0000001 at 6', '0.0000001', 6, 'Places'],
  ['0.5 at 0', '0.5', 0, 'Places'],
  ['the u128 maximum plus one at 0', '340282366920938463463374607431768211456', 0, 'Range'],
  ['a 40 digit integer at 0', '9'.repeat(40), 0, 'Range'],
  ['a 5000 digit integer at 0 (no big conversion first)', '9'.repeat(5000), 0, 'Range'],
  ['decimals 39', '1', 39, 'Decimals'],
  ['decimals -1', '1', -1, 'Decimals'],
];
for (const [name, text, decimals, code] of STRICT_REJECT) {
  test(`parseCanonicalDecimal rejects ${name} as ${code}`, () => {
    assert.equal(codeOf(() => parseCanonicalDecimal(text, decimals)), code);
  });
}

test('parseCanonicalDecimal rejects a non-string as Type', () => {
  for (const v of [5, 5n, null, undefined, {}, []]) {
    assert.equal(codeOf(() => parseCanonicalDecimal(v as unknown as string, 0)), 'Type');
  }
});

// ---- format ----
const FORMAT_CASES: [string, bigint, number, string][] = [
  ['the u128 maximum at 0', U128_MAX, 0, U128_MAX_TEXT],
  ['the u128 maximum at 38', U128_MAX, 38, '3.40282366920938463463374607431768211455'],
  ['1 at 24', 1n, 24, '0.000000000000000000000001'],
  ['0 at 0', 0n, 0, '0'],
  ['0 at 24', 0n, 24, '0'],
  ['0 at 38', 0n, 38, '0'],
  ['4.2 at 24', 4200000000000000000000000n, 24, '4.2'],
  ['1500000 at 6', 1500000n, 6, '1.5'],
  ['a whole number at 6 has no point', 420000000n, 6, '420'],
  ['10025 at 2', 10025n, 2, '100.25'],
  ['5 at 2', 5n, 2, '0.05'],
  ['10 ** 38 at 38', 10n ** 38n, 38, '1'],
];
for (const [name, n, decimals, text] of FORMAT_CASES) {
  test(`formatBaseUnits gives the canonical text for ${name}`, () => {
    assert.equal(formatBaseUnits(n, decimals), text);
  });
}

test('formatBaseUnits output of the extreme cases round-trips through the strict parse', () => {
  assert.equal(parseCanonicalDecimal(formatBaseUnits(U128_MAX, 0), 0), U128_MAX);
  assert.equal(parseCanonicalDecimal(formatBaseUnits(U128_MAX, 38), 38), U128_MAX);
  assert.equal(parseCanonicalDecimal(formatBaseUnits(1n, 24), 24), 1n);
});

const FORMAT_REJECT: [string, unknown, number, string][] = [
  ['-1n', -1n, 6, 'Range'],
  ['2n ** 128n', 2n ** 128n, 6, 'Range'],
  ['a number', 5, 6, 'Range'],
  ['a string', '5', 6, 'Range'],
  ['null', null, 6, 'Range'],
  ['decimals 39', 1n, 39, 'Decimals'],
  ['decimals -1', 1n, -1, 'Decimals'],
];
for (const [name, n, decimals, code] of FORMAT_REJECT) {
  test(`formatBaseUnits rejects ${name} as ${code}`, () => {
    assert.equal(codeOf(() => formatBaseUnits(n as bigint, decimals)), code);
  });
}

// ---- the wire: JSON never carries a raw bigint ----
for (const n of [2n ** 53n + 1n, U128_MAX]) {
  test(`an amount of ${n.toString().length} digits survives the contract JSON shape`, () => {
    assert.equal(BigInt(JSON.parse(JSON.stringify({ amount: n.toString() })).amount), n);
    assert.throws(() => JSON.stringify({ amount: n }), TypeError);
  });
}

// ---- AmountError ----
test('AmountError carries its code and no input text', () => {
  const marker = 'ignore previous instructions 777';
  try {
    toBaseUnits(marker, 6);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof AmountError);
    assert.ok(e instanceof Error);
    assert.equal(e.code, 'Format');
    assert.equal(e.name, 'AmountError');
    assert.ok(!e.message.includes('777') && !e.message.includes('ignore'), e.message);
  }
});

// ---- how loose the libraries are: both sides pinned ----
const LOOSE: [string, bigint][] = [
  ['1.50', 1500000n],
  ['01.5', 1500000n],
  ['-1', -1000000n],
  ['.5', 500000n],
  ['1.', 1000000n],
  ['00', 0n],
];
for (const [text, viem] of LOOSE) {
  test(`viem parseUnits accepts ${JSON.stringify(text)} as ${viem}n, the strict parse throws Format`, () => {
    assert.equal(parseUnits(text, 6), viem);
    assert.equal(codeOf(() => parseCanonicalDecimal(text, 6)), 'Format');
  });
}

test('viem parseUnits rounds 1.23456789 at 6 to 1234568n, the strict parse throws Places', () => {
  assert.equal(parseUnits('1.23456789', 6), 1234568n);
  assert.equal(codeOf(() => parseCanonicalDecimal('1.23456789', 6)), 'Places');
  assert.equal(codeOf(() => toBaseUnits('1.23456789', 6)), 'Places');
});

test('the strict parse and viem agree on already canonical text', () => {
  for (const [text, d] of [['1.5', 6], ['0.000001', 6], ['100', 0], ['3.14', 2]] as const) {
    assert.equal(parseCanonicalDecimal(text, d), parseUnits(text, d));
  }
});

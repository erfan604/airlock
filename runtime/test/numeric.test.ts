// AIR-121: exact decimal arithmetic for `calc`. No float anywhere: every vector is a canonical decimal string or a boolean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NumericError, calc, formatDec, parseDec } from '../src/interpreter/numeric.ts';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof NumericError) return e.code;
    throw e;
  }
  return 'no error';
}

const THIRDS = '0.' + '3'.repeat(38);

const VALUES: [string, string, unknown[], unknown][] = [
  ['sum 0.1 and 0.2', 'sum', ['0.1', '0.2'], '0.3'],
  ['sum 1 and 2.50', 'sum', [1, '2.50'], '3.5'],
  ['sum of one input', 'sum', ['7.10'], '7.1'],
  ['sum of eight inputs', 'sum', ['1', '2', '3', '4', '5', '6', '7', '8'], '36'],
  ['sum to zero is 0, never -0', 'sum', ['1.5', '-1.5'], '0'],
  ['sub 1 and 2', 'sub', ['1', '2'], '-1'],
  ['sub a negative result with decimals', 'sub', ['0.1', '0.25'], '-0.15'],
  ['mul 0.01 and 0.01', 'mul', ['0.01', '0.01'], '0.0001'],
  ['mul by a negative', 'mul', ['-2', '1.5'], '-3'],
  ['mul by zero is 0', 'mul', ['-5', '0'], '0'],
  ['div 10 and 4', 'div', ['10', '4'], '2.5'],
  ['div 1 and 3 truncates at 38 places', 'div', ['1', '3'], THIRDS],
  ['div truncates toward zero for a negative', 'div', ['-1', '3'], '-' + THIRDS],
  ['div 7 and 2 with negative divisor', 'div', ['7', '-2'], '-3.5'],
  ['div of decimals', 'div', ['0.5', '0.25'], '2'],
  ['div zero by something is 0', 'div', ['0', '5'], '0'],
  ['gt 9.4 and 5', 'gt', ['9.4', '5'], true],
  ['gt of equals is false', 'gt', ['5', '5.0'], false],
  ['lt 1 and 2', 'lt', ['1', '2'], true],
  ['ge 5 and 5.0', 'ge', ['5', '5.0'], true],
  ['le 5.1 and 5', 'le', ['5.1', '5'], false],
  ['eq 4.20 and 4.2', 'eq', ['4.20', '4.2'], true],
  ['eq on negative zero and zero', 'eq', ['-0', '0'], true],
  ['eq of equal strings', 'eq', ['approved', 'approved'], true],
  ['eq of different strings', 'eq', ['approved', 'rejected'], false],
  ['eq of a string and a number', 'eq', ['approved', 5], false],
  ['eq of booleans', 'eq', [true, true], true],
  ['eq of null and null', 'eq', [null, null], true],
  ['min of three', 'min', ['3', '1.5', '2'], '1.5'],
  ['max of three', 'max', ['3', '1.5', '2'], '3'],
  ['min of eight inputs', 'min', ['8', '7', '6', '5', '4', '3', '2', '1'], '1'],
  ['max of one input', 'max', ['2.50'], '2.5'],
  ['an integer input and a decimal string', 'sum', [2, '0.5'], '2.5'],
  ['a large exact sum', 'sum', ['99999999999999999999999999.999999999999999999999999', '0.000000000000000000000001'], '100000000000000000000000000'],
];
for (const [name, op, inputs, expected] of VALUES) {
  test(`calc: ${name}`, () => {
    assert.equal(calc(op as never, inputs), expected);
  });
}

const FAILURES: [string, string, unknown[], string][] = [
  ['div by zero', 'div', ['1', '0'], 'BadCalc'],
  ['div by 0.00', 'div', ['1', '0.00'], 'BadCalc'],
  ['sub with 3 inputs', 'sub', ['1', '2', '3'], 'BadCalc'],
  ['sub with 1 input', 'sub', ['1'], 'BadCalc'],
  ['mul with 3 inputs', 'mul', ['1', '2', '3'], 'BadCalc'],
  ['gt with 1 input', 'gt', ['1'], 'BadCalc'],
  ['eq with 3 inputs', 'eq', ['1', '1', '1'], 'BadCalc'],
  ['sum with no inputs', 'sum', [], 'BadCalc'],
  ['sum with 9 inputs', 'sum', ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'BadCalc'],
  ['an unknown op', 'pow', ['2', '3'], 'BadCalc'],
  ['gt of a word', 'gt', ['a', '1'], 'BadNumber'],
  ['sum of null', 'sum', ['1', null], 'BadNumber'],
  ['sum of a boolean', 'sum', [true, '1'], 'BadNumber'],
  ['mul of an object', 'mul', [{}, '1'], 'BadNumber'],
  ['min of an array', 'min', [[1], '1'], 'BadNumber'],
  ['an exponent', 'sum', ['1e3', '1'], 'BadNumber'],
  ['a plus sign', 'sum', ['+1', '1'], 'BadNumber'],
  ['a leading dot', 'sum', ['.5', '1'], 'BadNumber'],
  ['a trailing dot', 'sum', ['5.', '1'], 'BadNumber'],
  ['spaces', 'sum', [' 1', '1'], 'BadNumber'],
  ['the empty string', 'sum', ['', '1'], 'BadNumber'],
  ['a float', 'sum', [1.5, 1], 'BadNumber'],
  ['an unsafe integer', 'sum', [2 ** 53, 1], 'BadNumber'],
  ['NaN', 'sum', [Number.NaN, 1], 'BadNumber'],
  ['a 61 digit string', 'sum', ['1'.repeat(61), '1'], 'BadNumber'],
  ['41 fractional digits', 'sum', ['0.' + '1'.repeat(41), '1'], 'BadNumber'],
  ['a result of more than 60 digits', 'mul', ['9'.repeat(40), '9'.repeat(40)], 'BadNumber'],
  ['a lt of a word', 'lt', ['1', 'x'], 'BadNumber'],
];
for (const [name, op, inputs, code] of FAILURES) {
  test(`calc: ${name} aborts ${code}`, () => {
    assert.equal(codeOf(() => calc(op as never, inputs)), code);
  });
}

test('calc: 60 digits are accepted and a product that fits is exact', () => {
  assert.equal(calc('sum', ['9'.repeat(60), '0']), '9'.repeat(60));
  assert.equal(calc('mul', ['1' + '0'.repeat(29), '1' + '0'.repeat(29)]), '1' + '0'.repeat(58));
  assert.equal(calc('sum', ['0.' + '1'.repeat(40), '0']), '0.' + '1'.repeat(40));
});

test('parseDec and formatDec: canonical output for every accepted spelling', () => {
  for (const [raw, text] of [
    ['0', '0'],
    ['-0', '0'],
    ['00012', '12'],
    ['1.500', '1.5'],
    ['-0.0', '0'],
    ['-12.0340', '-12.034'],
    [7, '7'],
    [-7, '-7'],
    ['100', '100'],
  ] as const) {
    assert.equal(formatDec(parseDec(raw)), text, String(raw));
  }
});

test('parseDec refuses what is not a decimal', () => {
  for (const bad of [null, undefined, true, {}, [], 1.5, Number.POSITIVE_INFINITY, 'x', '1,5', '0x10', '1 ', '--1']) {
    assert.throws(() => parseDec(bad), NumericError);
  }
});

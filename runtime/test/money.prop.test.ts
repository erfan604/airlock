// AIR-123: property tests of the money module over the full u128 range and every legal decimals value, plus the viem
// differential on the formatter. viem is the oracle here only; it is imported nowhere under src.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { formatUnits } from 'viem';
import { formatBaseUnits, parseCanonicalDecimal, toBaseUnits } from '../src/money/index.ts';

const U128_MAX = (1n << 128n) - 1n;
const RUNS = 20000;

// the whole range plus the values where formatters tend to break
const amount = fc.oneof(
  fc.bigInt({ min: 0n, max: U128_MAX }),
  fc.constantFrom(0n, 1n, U128_MAX - 1n, U128_MAX, 10n ** 24n, 10n ** 38n),
);
const places = fc.integer({ min: 0, max: 38 });

test('format and the strict parse are inverse on the whole range', () => {
  fc.assert(
    fc.property(amount, places, (n, d) => {
      const text = formatBaseUnits(n, d);
      assert.equal(parseCanonicalDecimal(text, d), n);
      assert.equal(formatBaseUnits(parseCanonicalDecimal(text, d), d), text);
    }),
    { numRuns: RUNS },
  );
  console.log(`MONEY_PROP runs=${RUNS}`);
});

test('formatBaseUnits equals viem formatUnits (a check on our formatter, never its source)', () => {
  fc.assert(
    fc.property(amount, places, (n, d) => {
      assert.equal(formatBaseUnits(n, d), formatUnits(n, d));
    }),
    { numRuns: RUNS },
  );
  console.log(`MONEY_ORACLE runs=${RUNS}`);
});

test('the lenient parse agrees with the strict parse on canonical text', () => {
  fc.assert(
    fc.property(amount, places, (n, d) => {
      const text = formatBaseUnits(n, d);
      assert.equal(toBaseUnits(text, d), n);
    }),
    { numRuns: RUNS },
  );
});

test('the lenient parse ignores leading zeros and trailing fraction zeros but never changes the value', () => {
  fc.assert(
    fc.property(amount, places, fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), (n, d, lead, trail) => {
      const text = formatBaseUnits(n, d);
      // a bare integer needs a point before its zero fraction, a text that has a fraction just gets longer
      const tail = trail === 0 ? '' : text.includes('.') ? '0'.repeat(trail) : '.' + '0'.repeat(trail);
      assert.equal(toBaseUnits('0'.repeat(lead) + text + tail, d), n);
    }),
    { numRuns: RUNS },
  );
});

test('a bigint amount through toBaseUnits is whole units and agrees with the text form', () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.integer({ min: 0, max: 18 }), (units, d) => {
      assert.equal(toBaseUnits(units, d), toBaseUnits(units.toString(), d));
    }),
    { numRuns: RUNS },
  );
});

// Money amounts: bigint base units, decimal text only at the edges. Pure and browser safe: no runtime imports, no
// globals beyond the language, no float parsing anywhere. No library offers the canonical rules (viem rounds, ethers and
// dnum accept leading zeros or truncate), so the parsers here are hand written and strict. Nothing rounds.
//
// Two parses on purpose. `parseCanonicalDecimal` never guesses and equals the contract's `parse` (AIR-027): it is the
// only one that touches approve arguments, task bounds and the shared vectors. `toBaseUnits` is exact but tolerant of
// leading and trailing zeros, for extractor output, plan literals and calc results. A caller turns every AmountError
// into the abort BadAmount and must not catch more broadly than that.

export type AmountErrorCode = 'Decimals' | 'Format' | 'Places' | 'Range' | 'Type' | 'TooLong';

export class AmountError extends Error {
  readonly code: AmountErrorCode;
  constructor(code: AmountErrorCode) {
    // the message names the code only: the rejected text is never copied into an error
    super(`amount rejected: ${code}`);
    this.name = 'AmountError';
    this.code = code;
  }
}

const U128_MAX = (1n << 128n) - 1n;
const MAX_DECIMALS = 38;
const U128_MAX_DIGITS = 39;
const MAX_TEXT_LENGTH = 80;

// whole digits, no leading zero except a single 0; an optional fraction that ends in a non-zero digit
const CANONICAL = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
const LENIENT = /^[0-9]+(\.[0-9]+)?$/;
const NON_ZERO_DIGIT = /[1-9]/;

// 10 ** d for every legal d, built by repeated multiplication so no conversion from a JavaScript number is involved
const POW10: readonly bigint[] = (() => {
  const table: bigint[] = [1n];
  for (let i = 1; i <= MAX_DECIMALS; i++) table.push((table[i - 1] ?? 1n) * 10n);
  return table;
})();

// `decimals` is an integer from 0 to 38; the power of ten is returned so a caller needs no second lookup
function scaleFor(decimals: unknown): bigint {
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountError('Decimals');
  }
  const scale = POW10[decimals];
  if (scale === undefined) throw new AmountError('Decimals');
  return scale;
}

function fitted(n: bigint): bigint {
  if (n < 0n || n > U128_MAX) throw new AmountError('Range');
  return n;
}

/**
 * The contract's canonical decimal text to base units. The whole string must match
 * `^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$`, have at most `decimals` fraction digits and be at most the u128 maximum.
 */
export function parseCanonicalDecimal(s: string, decimals: number): bigint {
  scaleFor(decimals);
  if (typeof s !== 'string') throw new AmountError('Type');
  if (!CANONICAL.test(s)) throw new AmountError('Format');
  const point = s.indexOf('.');
  const whole = point < 0 ? s : s.slice(0, point);
  const fraction = point < 0 ? '' : s.slice(point + 1);
  if (fraction.length > decimals) throw new AmountError('Places');
  // the u128 maximum has 39 digits: a longer whole part is out of range, decided before any conversion
  if (whole.length > U128_MAX_DIGITS) throw new AmountError('Range');
  return fitted(BigInt(whole + fraction.padEnd(decimals, '0')));
}

/**
 * Exact but tolerant: a decimal string (leading and trailing zeros allowed, extra places only when all zero), a
 * non-negative safe integer, or a bigint taken as whole units. Anything else is an AmountError.
 */
export function toBaseUnits(raw: unknown, decimals: number): bigint {
  const scale = scaleFor(decimals);
  switch (typeof raw) {
    case 'bigint':
      return fitted(fitted(raw) * scale);
    case 'number': {
      if (!Number.isSafeInteger(raw) || raw < 0) throw new AmountError('Format');
      // through the decimal text, never a direct conversion of the number
      return fitted(BigInt(String(raw)) * scale);
    }
    case 'string': {
      if (raw.length > MAX_TEXT_LENGTH) throw new AmountError('TooLong');
      if (!LENIENT.test(raw)) throw new AmountError('Format');
      const point = raw.indexOf('.');
      const whole = point < 0 ? raw : raw.slice(0, point);
      const fraction = point < 0 ? '' : raw.slice(point + 1);
      // places beyond the asset's decimals are accepted only when they are all zero: nothing is rounded
      if (NON_ZERO_DIGIT.test(fraction.slice(decimals))) throw new AmountError('Places');
      return fitted(BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, '0')));
    }
    default:
      throw new AmountError('Type');
  }
}

/** The one canonical text of an amount: digits, then a point and the fraction without trailing zeros when it is not zero. */
export function formatBaseUnits(n: bigint, decimals: number): string {
  const scale = scaleFor(decimals);
  if (typeof n !== 'bigint') throw new AmountError('Range');
  fitted(n);
  if (decimals === 0) return n.toString();
  const whole = n / scale;
  const fraction = n % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

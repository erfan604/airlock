// Exact decimal arithmetic for `calc`: a value is `n / 10^s` with a bigint numerator, so there is no float anywhere. Results of
// arithmetic are canonical decimal strings (no trailing fraction zeros, no plus sign, zero is `0`, never `-0`), results of
// comparisons are booleans. A result of more than 60 digits is an error.

export type NumericCode = 'BadNumber' | 'BadCalc';

export class NumericError extends Error {
  constructor(readonly code: NumericCode) {
    super(`NumericError: ${code}`);
    this.name = 'NumericError';
  }
}

/** The value `n / 10^s`. */
export type Dec = { n: bigint; s: number };

const MAX_DIGITS = 60;
const MAX_FRACTION = 40;
const DIV_PLACES = 38;
const MIN_INPUTS = 1;
const MAX_INPUTS = 8;
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

const bad = (): never => {
  throw new NumericError('BadNumber');
};

function pow10(places: number): bigint {
  return 10n ** BigInt(places);
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** A safe integer, or a string `^-?[0-9]+(\.[0-9]+)?$` with at most 60 digits and 40 fractional digits; anything else throws BadNumber. */
export function parseDec(raw: unknown): Dec {
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return bad();
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return bad();
  }
  const m = DECIMAL.exec(text);
  if (m === null) return bad();
  const whole = m[2] ?? '';
  const fraction = m[3] ?? '';
  if (whole.length + fraction.length > MAX_DIGITS || fraction.length > MAX_FRACTION) return bad();
  const n = BigInt(whole + fraction);
  return { n: m[1] === '-' ? -n : n, s: fraction.length };
}

// the same value with the fewest fractional digits
function canon(d: Dec): Dec {
  let { n, s } = d;
  while (s > 0 && n % 10n === 0n) {
    n /= 10n;
    s -= 1;
  }
  return { n, s };
}

/** The canonical text of a value. */
export function formatDec(d: Dec): string {
  const c = canon(d);
  const digits = abs(c.n).toString();
  const sign = c.n < 0n ? '-' : '';
  if (c.s === 0) return sign + digits;
  const padded = digits.padStart(c.s + 1, '0');
  return `${sign}${padded.slice(0, padded.length - c.s)}.${padded.slice(padded.length - c.s)}`;
}

// the canonical text of an arithmetic result, refused when it has more than 60 digits
function finish(d: Dec): string {
  const c = canon(d);
  if (abs(c.n).toString().length > MAX_DIGITS) return bad();
  return formatDec(c);
}

// both numerators at the larger scale
function align(a: Dec, b: Dec): [bigint, bigint] {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s)];
}

function compare(a: Dec, b: Dec): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function add(a: Dec, b: Dec): Dec {
  const [x, y] = align(a, b);
  return { n: x + y, s: Math.max(a.s, b.s) };
}

function divide(a: Dec, b: Dec): Dec {
  if (b.n === 0n) throw new NumericError('BadCalc');
  // the quotient truncated toward zero at 38 fractional digits
  const places = b.s + DIV_PLACES;
  return { n: (a.n * pow10(places)) / (b.n * pow10(a.s)), s: DIV_PLACES };
}

const numeric = (raw: unknown): Dec | null => {
  try {
    return parseDec(raw);
  } catch (e) {
    if (e instanceof NumericError) return null;
    throw e;
  }
};

/**
 * One `calc` op over its raw inputs. `sum`, `min` and `max` take 1 to 8 inputs, the other ops exactly 2, else BadCalc; a division
 * by zero is BadCalc; an input that is not a number is BadNumber for every op except `eq`, which compares numerically when both
 * inputs are numbers and by strict equality of the raw values otherwise, and never fails on a value.
 */
export function calc(op: string, inputs: readonly unknown[]): string | boolean {
  switch (op) {
    case 'sum':
    case 'min':
    case 'max': {
      if (inputs.length < MIN_INPUTS || inputs.length > MAX_INPUTS) throw new NumericError('BadCalc');
      const values = inputs.map(parseDec);
      let acc = values[0] ?? bad();
      for (const v of values.slice(1)) {
        if (op === 'sum') acc = add(acc, v);
        else if (op === 'min') acc = compare(v, acc) < 0 ? v : acc;
        else acc = compare(v, acc) > 0 ? v : acc;
      }
      return finish(acc);
    }
    case 'sub':
    case 'mul':
    case 'div':
    case 'gt':
    case 'lt':
    case 'ge':
    case 'le':
    case 'eq': {
      if (inputs.length !== 2) throw new NumericError('BadCalc');
      if (op === 'eq') {
        const x = numeric(inputs[0]);
        const y = numeric(inputs[1]);
        return x !== null && y !== null ? compare(x, y) === 0 : inputs[0] === inputs[1];
      }
      const a = parseDec(inputs[0]);
      const b = parseDec(inputs[1]);
      switch (op) {
        case 'sub':
          return finish(add(a, { n: -b.n, s: b.s }));
        case 'mul':
          return finish({ n: a.n * b.n, s: a.s + b.s });
        case 'div':
          return finish(divide(a, b));
        case 'gt':
          return compare(a, b) > 0;
        case 'lt':
          return compare(a, b) < 0;
        case 'ge':
          return compare(a, b) >= 0;
        default:
          return compare(a, b) <= 0;
      }
    }
    default:
      throw new NumericError('BadCalc');
  }
}

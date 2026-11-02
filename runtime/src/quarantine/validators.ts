// Typed validators for the quarantined extractor (AIR-142). Plain functions that never throw: a value that does not fit its type is
// null. Validation limits shape and size only; it is not a trust boundary (the interpreter labels every extracted value, the gate
// decides). Addresses go through the canonicalizers of dsl/keys.ts, so there is no second NEAR regex in the tree.
import { canonicalEvm, canonicalNear } from '../dsl/index.ts';

export type FieldValue = string | boolean | null;

const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
const MAX_DECIMAL_LEN = 80;
const MAX_TEXT_LEN = 200;
const TRIMMED = ' \t\r\n';

function trim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && TRIMMED.includes(s.charAt(start))) start++;
  while (end > start && TRIMMED.includes(s.charAt(end - 1))) end--;
  return s.slice(start, end);
}

function address(raw: unknown): FieldValue {
  if (typeof raw !== 'string') return null;
  const s = trim(raw);
  try {
    if (s.startsWith('0x') || s.startsWith('0X')) return canonicalEvm(s);
    try {
      return canonicalNear(s);
    } catch {
      return canonicalEvm(s);
    }
  } catch {
    return null;
  }
}

// only a JSON string: a binary float may already have lost digits, so only the model's text is trusted to be an exact decimal
function decimal(raw: unknown): FieldValue {
  return typeof raw === 'string' && raw.length <= MAX_DECIMAL_LEN && DECIMAL.test(raw) ? raw : null;
}

function bool(raw: unknown): FieldValue {
  return typeof raw === 'boolean' ? raw : null;
}

// not truncated: a cut string can change meaning
function text(raw: unknown): FieldValue {
  return typeof raw === 'string' && raw.length <= MAX_TEXT_LEN ? raw : null;
}

/** The members of an `enum:a,b` type name; empty members are dropped. */
export function enumMembers(type: string): string[] | null {
  if (!type.startsWith('enum:')) return null;
  return type.slice(5).split(',').filter((m) => m !== '');
}

export const validators: Readonly<Record<'address' | 'amount' | 'number' | 'bool' | 'text', (raw: unknown) => FieldValue>> = Object.freeze({
  address,
  amount: decimal,
  number: decimal,
  bool,
  text,
});

export function validateField(type: string, raw: unknown): FieldValue {
  if (typeof type !== 'string') return null;
  const members = enumMembers(type);
  if (members !== null) return typeof raw === 'string' && members.includes(raw) ? raw : null;
  if (!Object.hasOwn(validators, type)) return null;
  return validators[type as keyof typeof validators](raw);
}

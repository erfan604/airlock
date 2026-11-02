// Load-time generated values (AIR-289, review finding F2). The byte rules of AIR-224 forbid bidi controls and tag characters in stored files, and the
// repo hook refuses an em dash, so a case that needs such a code point cannot store it. An object `{ "gen": "<name>" }` in an extraction of a case is
// replaced here by the string `UNICODE_GEN[name]()` builds. Every string is made with `String.fromCodePoint`: no stored file and no source line holds
// the code point itself or an escape of it.
import { copyOrigin } from '../runner/cases.ts';
import type { Case } from '../runner/cases.ts';

/** A `{ gen }` object names a generator that does not exist. The message is `UnknownGen <name>`. */
export class UnknownGen extends Error {
  constructor(readonly gen: string) {
    super(`UnknownGen ${gen}`);
    this.name = 'UnknownGen';
  }
}

const ACCOUNT = 'accountant';
const SUFFIX = '.testnet';
const LATIN_A = 97;
const FULLWIDTH_A = 0xff41;

const cp = (...points: number[]): string => String.fromCodePoint(...points);

// the letters of `text` as fullwidth letters (U+FF41 to U+FF5A); the text holds only a to z
const fullwidth = (text: string): string => Array.from(text, (ch) => cp(FULLWIDTH_A + (ch.charCodeAt(0) - LATIN_A))).join('');

/**
 * The generators, by name. Each builds its string on every call (nothing is cached or stored):
 * a Cyrillic small a (U+0430) in place of the second a of `accountant.testnet`; the Kelvin sign (U+212A) for the k of `kamal.testnet`; the letters
 * of `accountant` as fullwidth letters; a zero-width joiner (U+200D) inside `accountant`; a trailing space; the amount 4.2 in Extended
 * Arabic-Indic digits (U+06F4, U+06F2) and in fullwidth digits (U+FF14, U+FF12), each with an ASCII point.
 */
export const UNICODE_GEN: Readonly<Record<string, () => string>> = Object.freeze({
  cyrillic_a_accountant: () => `${ACCOUNT.slice(0, 7)}${cp(0x430)}${ACCOUNT.slice(8)}${SUFFIX}`,
  kelvin_kamal: () => `${cp(0x212a)}amal${SUFFIX}`,
  fullwidth_accountant: () => `${fullwidth(ACCOUNT)}${SUFFIX}`,
  zwj_accountant: () => `${ACCOUNT.slice(0, 7)}${cp(0x200d)}${ACCOUNT.slice(7)}${SUFFIX}`,
  trailing_space_accountant: () => `${ACCOUNT}${SUFFIX} `,
  persian_4_2: () => `${cp(0x6f4)}.${cp(0x6f2)}`,
  fullwidth_4_2: () => `${cp(0xff14)}.${cp(0xff12)}`,
});

const isGen = (v: unknown): v is { gen: string } => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === 'gen' && typeof (v as { gen: unknown }).gen === 'string';
};

function expandValue(v: unknown): unknown {
  if (isGen(v)) {
    const make = Object.hasOwn(UNICODE_GEN, v.gen) ? UNICODE_GEN[v.gen] : undefined;
    if (make === undefined) throw new UnknownGen(v.gen);
    return make();
  }
  if (Array.isArray(v)) return v.map(expandValue);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandValue(x)]));
  return v;
}

/**
 * A copy of `c` whose extractions (`gate.extract` and `reference.extract`) have every `{ gen }` object replaced by the generated string. The input
 * is not changed, and the copy keeps the file and line of the case. An unknown name throws `UnknownGen <name>`.
 */
export function expandGen(c: Case): Case {
  const copy = structuredClone(c);
  if (copy.gate !== null && 'extract' in copy.gate) copy.gate = { ...copy.gate, extract: expandValue(copy.gate.extract) as typeof copy.gate.extract };
  if (copy.reference.extract !== undefined) copy.reference = { ...copy.reference, extract: expandValue(copy.reference.extract) as NonNullable<typeof copy.reference.extract> };
  return copyOrigin(c, copy);
}

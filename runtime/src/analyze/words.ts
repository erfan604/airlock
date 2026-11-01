// Words for the owner: which of the owner's own words a literal of the plan appears in (AIR-180, shared with AIR-127 so there is one
// grounding rule for the display) and the display word of each untrusted channel. Browser safe: no imports besides the money parser, no
// Set, no float parsing. Everything here is display only: nothing in this file ever changes a bound.
import type { LabelName } from '../dsl/index.ts';
import { AmountError, toBaseUnits } from '../money/index.ts';

// the untrusted channels in bit order (the order of the label list), each with its word; quarantine has none, it is the reader
const CHANNEL_WORDS: ReadonlyArray<readonly [LabelName, string]> = [
  ['Untrusted:email', 'email'],
  ['Untrusted:web', 'web page'],
  ['Untrusted:file', 'file'],
  ['Untrusted:chat', 'chat'],
  ['Untrusted:social', 'social post'],
  ['Untrusted:tool_output', 'tool output'],
  ['Untrusted:memory', 'memory'],
  ['Untrusted:payment_protocol', 'payment response'],
  ['Untrusted:other', 'pasted text'],
];

/** The display words of the outside channels in a label list, in bit order and without repeats. Quarantine (the reader) has no word. */
export function channelWords(labels: readonly LabelName[]): string[] {
  const out: string[] = [];
  for (const [label, word] of CHANNEL_WORDS) if (labels.includes(label)) out.push(word);
  return out;
}

// ASCII-only lowering: a character above 0x7f is kept as it is (the Kelvin sign must stay a Kelvin sign and never become a k)
function asciiLower(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s.charAt(i);
  }
  return out;
}

// a letter, a digit or an underscore (after lowering), and any character outside ASCII: never a boundary, so a doubtful match is not a match
function isWordChar(ch: string): boolean {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  return c > 0x7f || c === 95 || (c >= 48 && c <= 57) || (c >= 97 && c <= 122);
}

function nameInWords(literal: string | number, ownerText: string): boolean {
  const text = typeof literal === 'number' ? (Number.isSafeInteger(literal) && literal >= 0 ? String(literal) : '') : literal;
  if (typeof text !== 'string' || text === '') return false;
  const hay = asciiLower(ownerText);
  const needle = asciiLower(text);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : hay.charAt(at - 1);
    const after = hay.charAt(at + needle.length);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

/**
 * Whether a literal of the plan is in the owner's words. With `decimals` (amount mode) it is true when some number of `ownerText`, found with
 * `[0-9]+(\.[0-9]+)?`, equals the literal by value after toBaseUnits at those decimals; a literal or a number that toBaseUnits refuses is false,
 * never a throw. Without `decimals` (name mode) the literal is text and it is true when it occurs in `ownerText` as a whole word,
 * case-insensitively in ASCII. Display only.
 */
export function inOwnerWords(literal: string | number, ownerText: string, decimals?: number): boolean {
  if (typeof ownerText !== 'string') return false;
  if (decimals === undefined) return nameInWords(literal, ownerText);
  let want: bigint;
  try {
    want = toBaseUnits(literal, decimals);
  } catch (e) {
    if (e instanceof AmountError) return false;
    throw e;
  }
  const tokens = ownerText.match(/[0-9]+(\.[0-9]+)?/g) ?? [];
  for (const token of tokens) {
    try {
      if (toBaseUnits(token, decimals) === want) return true;
    } catch (e) {
      if (!(e instanceof AmountError)) throw e;
    }
  }
  return false;
}

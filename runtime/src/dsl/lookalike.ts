// AIR-189: look-alike detector (F10 3.3). Pure and browser-safe: no node imports, no network, no clock, ASCII only. It flags a recipient
// key that resembles an address-book key and gives the positions the card draws. It is a heuristic that helps the human; the contract
// matches keys exactly and escalates every payee outside the task, which is the guarantee.
//
// Rules per book entry, tried in the order given (the first entry that matches wins), after an exact match of the candidate with any
// entry returns null:
//   hex keys (EVM, NEAR implicit, ETH-implicit): same digit count, then hex_ends (first 4 and last 4 digits equal) or hex_hamming
//     (Hamming distance at most 6 over the digits). An EVM key and an ETH-implicit key with the same 40 digits are compared.
//   named NEAR accounts, in this order: name_edit (Levenshtein 1 or 2), name_subaccount (the candidate starts with a book name and a dot,
//     or a parent of the candidate is a name_edit look-alike of the book name; a real sub-account of a book entry is not flagged),
//     name_separator (equal after deleting - _ and . with an edit distance above 2).
// differingIndexes are indexes into the full candidate key string.
import { validatePayeeKey } from './keys.ts';

export type LookalikeKind = 'hex_ends' | 'hex_hamming' | 'name_edit' | 'name_subaccount' | 'name_separator';

export interface LookalikeResult {
  nearest: string;
  kind: LookalikeKind;
  distance: number;
  differingIndexes: number[];
}

const NEAR_PREFIX = 'near:';
const ENDS = 4;
const MAX_HAMMING = 6;
const MAX_EDIT = 2;
const EVM_DIGITS = 40;
const IMPLICIT_DIGITS = 64;

function isHexRun(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

// where the digits start in a key, or -1 when the key has no hex body
function bodyStart(key: string): number {
  if (key.startsWith('evm:')) {
    const colon = key.indexOf(':', 4);
    if (colon < 0) return -1;
    const body = key.slice(colon + 3);
    return key.startsWith('0x', colon + 1) && body.length === EVM_DIGITS && isHexRun(body) ? colon + 3 : -1;
  }
  if (key.startsWith(NEAR_PREFIX)) {
    const rest = key.slice(NEAR_PREFIX.length);
    if (rest.length === IMPLICIT_DIGITS && isHexRun(rest)) return NEAR_PREFIX.length;
    if (rest.length === EVM_DIGITS + 2 && rest.startsWith('0x') && isHexRun(rest.slice(2))) return NEAR_PREFIX.length + 2;
  }
  return -1;
}

/** The 40 or 64 hex digits of an EVM, NEAR implicit or ETH-implicit key, else null. */
export function hexBody(key: string): string | null {
  if (typeof key !== 'string') return null;
  const start = bodyStart(key);
  return start < 0 ? null : key.slice(start);
}

function hexMatch(candidate: string, cBody: string, start: number, entry: string, eBody: string): LookalikeResult | null {
  if (cBody.length !== eBody.length) return null;
  const differingIndexes: number[] = [];
  for (let i = 0; i < cBody.length; i++) if (cBody.charAt(i) !== eBody.charAt(i)) differingIndexes.push(i + start);
  const distance = differingIndexes.length;
  const n = cBody.length;
  const ends = cBody.slice(0, ENDS) === eBody.slice(0, ENDS) && cBody.slice(n - ENDS) === eBody.slice(n - ENDS);
  if (ends) return { nearest: entry, kind: 'hex_ends', distance, differingIndexes };
  if (distance <= MAX_HAMMING) return { nearest: entry, kind: 'hex_hamming', distance, differingIndexes };
  return null;
}

// Levenshtein table, rows for the candidate prefix, columns for the book prefix
function editTable(a: string, b: string): number[][] {
  const t: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [];
    for (let j = 0; j <= b.length; j++) {
      if (i === 0) row.push(j);
      else if (j === 0) row.push(i);
      else {
        const prev = t[i - 1] as number[];
        const sub = (prev[j - 1] as number) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
        row.push(Math.min(sub, (prev[j] as number) + 1, (row[j - 1] as number) + 1));
      }
    }
    t.push(row);
  }
  return t;
}

function editDistance(a: string, b: string): number {
  const t = editTable(a, b);
  return (t[a.length] as number[])[b.length] as number;
}

// the candidate positions substituted or inserted on one minimal alignment (a book character the candidate lacks has no position);
// walks back from the end, preferring a match, then a substitution, then an insertion
function alignedDifferences(a: string, b: string): number[] {
  const t = editTable(a, b);
  const at = (i: number, j: number): number => (t[i] as number[])[j] as number;
  const out: number[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    const here = at(i, j);
    if (i > 0 && j > 0 && a.charAt(i - 1) === b.charAt(j - 1) && here === at(i - 1, j - 1)) {
      i--;
      j--;
    } else if (i > 0 && j > 0 && here === at(i - 1, j - 1) + 1) {
      out.push(i - 1);
      i--;
      j--;
    } else if (i > 0 && here === at(i - 1, j) + 1) {
      out.push(i - 1);
      i--;
    } else {
      j--;
    }
  }
  return out.reverse();
}

function stripSeparators(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c !== '-' && c !== '_' && c !== '.') out += c;
  }
  return out;
}

const shifted = (indexes: number[], by: number): number[] => indexes.map((i) => i + by);

function nameMatch(candidate: string, entry: string): LookalikeResult | null {
  const c = candidate.slice(NEAR_PREFIX.length);
  const e = entry.slice(NEAR_PREFIX.length);
  const p = NEAR_PREFIX.length;
  const distance = editDistance(c, e);
  if (distance >= 1 && distance <= MAX_EDIT) {
    return { nearest: entry, kind: 'name_edit', distance, differingIndexes: shifted(alignedDifferences(c, e), p) };
  }
  if (c.startsWith(`${e}.`)) {
    const tail: number[] = [];
    for (let i = e.length; i < c.length; i++) tail.push(i + p);
    return { nearest: entry, kind: 'name_subaccount', distance: 0, differingIndexes: tail };
  }
  for (let dot = c.indexOf('.'); dot >= 0; dot = c.indexOf('.', dot + 1)) {
    const parent = c.slice(dot + 1);
    const d = editDistance(parent, e);
    if (d >= 1 && d <= MAX_EDIT) {
      return { nearest: entry, kind: 'name_subaccount', distance: d, differingIndexes: shifted(alignedDifferences(parent, e), p + dot + 1) };
    }
  }
  const flat = stripSeparators(c);
  if (flat.length > 0 && flat === stripSeparators(e) && distance > MAX_EDIT) {
    return { nearest: entry, kind: 'name_separator', distance, differingIndexes: shifted(alignedDifferences(c, e), p) };
  }
  return null;
}

/** Flags the first book entry the candidate resembles, or null. Every key must be canonical (KeyError otherwise). */
export function checkLookalike(candidate: string, book: readonly string[]): LookalikeResult | null {
  validatePayeeKey(candidate);
  for (const entry of book) validatePayeeKey(entry);
  if (book.includes(candidate)) return null;
  const start = bodyStart(candidate);
  const cBody = start < 0 ? null : candidate.slice(start);
  for (const entry of book) {
    const eBody = hexBody(entry);
    if (cBody !== null) {
      if (eBody === null) continue;
      const hit = hexMatch(candidate, cBody, start, entry, eBody);
      if (hit !== null) return hit;
    } else if (eBody === null && candidate.startsWith(NEAR_PREFIX) && entry.startsWith(NEAR_PREFIX)) {
      const hit = nameMatch(candidate, entry);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** The same rules for a key about to be added to the book (a future book_add page). */
export function checkBookAdd(newKey: string, book: readonly string[]): LookalikeResult | null {
  return checkLookalike(newKey, book);
}

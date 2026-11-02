// Literal grounding (SPEC 6 rule 8, AIR-127): an owner literal used in an action argument is grounded only when it occurs in the owner's typed
// instruction; otherwise the interpreter marks it Unresolved. Defense in depth, not the wall: pairing, tokenization of numbers, negation and
// thousands separators are not checked (REDTEAM R2-04, docs/KNOWN_LIMITATIONS.md). The pasted text is never passed here, only the instruction.
import { inOwnerWords } from '../analyze/words.ts';
import { KeyError, canonicalEvm, canonicalNear } from '../dsl/keys.ts';
import type { Grounder } from './types.ts';

const NON_ASCII = /[^\x00-\x7F]/;
const NON_ASCII_ALL = /[^\x00-\x7F]/g;
const EVM_SHAPE = /^(0x)?[0-9a-fA-F]{40}$/;
const NEAR_PREFIX = 'near:';
const EVM_PREFIX = /^evm:[0-9]+:/;
const ADDRESS_TOKEN = /[A-Za-z0-9._-]+/g;
const EDGE = /^[._-]+|[._-]+$/g;

// the canonical form of an address, or null when it is not one (an EVM address of 40 hex digits, else a lowercase near account)
function canonicalAddress(raw: string): string | null {
  let x = raw;
  if (x.startsWith(NEAR_PREFIX)) x = x.slice(NEAR_PREFIX.length);
  else x = x.replace(EVM_PREFIX, '');
  try {
    return EVM_SHAPE.test(x) ? canonicalEvm(x) : canonicalNear(x);
  } catch (e) {
    if (e instanceof KeyError) return null;
    throw e;
  }
}

function addressInText(literal: string, text: string): boolean {
  const want = canonicalAddress(literal);
  if (want === null) return false;
  for (const token of text.match(ADDRESS_TOKEN) ?? []) {
    if (canonicalAddress(token.replace(EDGE, '')) === want) return true;
  }
  return false;
}

/** Whether `literal` of the given kind occurs in `ownerText`, the owner's typed instruction. Never throws on a bad literal. */
export function ground(literal: string | number, kind: 'amount' | 'name' | 'address', ownerText: string, decimals?: number): boolean {
  if (typeof ownerText !== 'string') return false;
  if (typeof literal === 'string' && NON_ASCII.test(literal)) return false;
  const text = ownerText.replace(NON_ASCII_ALL, '\u0001');
  if (kind === 'amount') return typeof decimals === 'number' && inOwnerWords(literal, text, decimals);
  if (kind === 'name') return typeof literal === 'string' && literal.trim() !== '' && inOwnerWords(literal.trim(), text);
  return typeof literal === 'string' && addressInText(literal, text);
}

/** The product hook: it fails closed, so a run that cannot say what the owner typed grounds nothing. */
export const grounder: Grounder = (lit, kind, ctx) => (ctx.ownerText === undefined ? false : ground(lit, kind, ctx.ownerText, ctx.decimals));

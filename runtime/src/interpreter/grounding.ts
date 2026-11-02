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
const EVM_PREFIX = /^evm:([0-9]+):/;
// a token keeps non-ASCII characters and colons, so a foreign letter or a scheme prefix stays part of the token it touches
const ADDRESS_TOKEN = /[A-Za-z0-9._:\-\u0080-\uffff]+/g;
const EDGE = /^[._:-]+|[._:-]+$/g;

interface Addr {
  kind: 'near' | 'evm';
  addr: string;
  chain: string | null;
}

// an address with its kind and chain id, or null when it is not one. `near:` is only ever a near account, `evm:<id>:` only an EVM address
// with that chain id, a bare string by shape (40 hex digits are EVM, anything else a lowercase near account). Non-ASCII is never an address.
function parseAddress(raw: string): Addr | null {
  try {
    if (raw.startsWith(NEAR_PREFIX)) return { kind: 'near', addr: canonicalNear(raw.slice(NEAR_PREFIX.length)), chain: null };
    const m = EVM_PREFIX.exec(raw);
    if (m !== null) return { kind: 'evm', addr: canonicalEvm(raw.slice(m[0].length)), chain: m[1] ?? null };
    return EVM_SHAPE.test(raw) ? { kind: 'evm', addr: canonicalEvm(raw), chain: null } : { kind: 'near', addr: canonicalNear(raw), chain: null };
  } catch (e) {
    if (e instanceof KeyError) return null;
    throw e;
  }
}

function addressInText(literal: string, ownerText: string): boolean {
  const want = parseAddress(literal);
  if (want === null) return false;
  for (const token of ownerText.match(ADDRESS_TOKEN) ?? []) {
    const got = parseAddress(token.replace(EDGE, ''));
    if (got === null || got.kind !== want.kind || got.addr !== want.addr) continue;
    if (got.chain !== null && want.chain !== null && got.chain !== want.chain) continue;
    return true;
  }
  return false;
}

/** Whether `literal` of the given kind occurs in `ownerText`, the owner's typed instruction. Never throws on a bad literal. */
export function ground(literal: string | number, kind: 'amount' | 'name' | 'address', ownerText: string, decimals?: number): boolean {
  if (typeof ownerText !== 'string') return false;
  if (typeof literal === 'string' && NON_ASCII.test(literal)) return false;
  // a non-ASCII character becomes U+0080, which joins the word it touches and matches no ASCII literal (never a separator)
  const text = ownerText.replace(NON_ASCII_ALL, '\u0080');
  if (kind === 'amount') return typeof decimals === 'number' && inOwnerWords(literal, text, decimals);
  if (kind === 'name') return typeof literal === 'string' && literal.trim() !== '' && inOwnerWords(literal.trim(), text);
  return typeof literal === 'string' && addressInText(literal, ownerText);
}

/** The product hook: it fails closed, so a run that cannot say what the owner typed grounds nothing. */
export const grounder: Grounder = (lit, kind, ctx) => (ctx.ownerText === undefined ? false : ground(lit, kind, ctx.ownerText, ctx.decimals));

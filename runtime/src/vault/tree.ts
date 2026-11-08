// The Merkle tree of the private address book (AIR-326, docs/design/private-book.md). Byte for byte the same as
// contracts/airlock-policy/src/book.rs: a leaf commits to the salt, the payee key and the three numbers; the depth is fixed at 8 (256
// slots); unused slots are filler leaves derived from a seed, so the root hides how many entries exist. Numbers are BigInt.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export const DEPTH = 8;
export const SLOTS = 1 << DEPTH;
const LEAF_TAG = concatBytes(Uint8Array.of(0x00), utf8ToBytes('airlock-book-v1'));
const NODE_TAG = 0x01;
const FILLER_TAG = 0x02;
const U128_MAX = (1n << 128n) - 1n;

const sha = (...parts: Uint8Array[]): Uint8Array => sha256(concatBytes(...parts));

function u128be(n: bigint): Uint8Array {
  if (n < 0n || n > U128_MAX) throw new RangeError('not a u128');
  return hexToBytes(n.toString(16).padStart(32, '0'));
}

const u16be = (n: number): Uint8Array => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const u32be = (n: number): Uint8Array => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
export { bytesToHex, hexToBytes };

export interface LeafInput {
  salt: Uint8Array;
  payee: string;
  cap: bigint | null;
  budget: bigint;
  limit: bigint;
}

export function leafHash(e: LeafInput): Uint8Array {
  if (e.salt.length !== 32) throw new RangeError('a salt is 32 bytes');
  const payee = utf8ToBytes(e.payee);
  if (payee.length > 0xffff) throw new RangeError('payee too long');
  return sha(LEAF_TAG, e.salt, u16be(payee.length), payee, Uint8Array.of(e.cap === null ? 0 : 1), u128be(e.cap ?? 0n), u128be(e.budget), u128be(e.limit));
}

export const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array => sha(Uint8Array.of(NODE_TAG), left, right);

/** The filler leaf of slot `i`: sha256(0x02 || sha256(seed || u32be(i))). */
export function fillerLeaf(seed: Uint8Array, i: number): Uint8Array {
  return sha(Uint8Array.of(FILLER_TAG), sha(seed, u32be(i)));
}

export interface Built {
  root: Uint8Array;
  /** per entry, in input order */
  proofs: Array<{ index: number; siblings: Uint8Array[] }>;
}

/** Slot `i` holds entry `i`; every other slot is a filler. */
export function buildTree(entries: readonly LeafInput[], seed: Uint8Array): Built {
  if (entries.length > SLOTS) throw new RangeError('too many entries');
  let level: Uint8Array[] = Array.from({ length: SLOTS }, (_, i) => {
    const e = entries[i];
    return e === undefined ? fillerLeaf(seed, i) : leafHash(e);
  });
  const layers: Uint8Array[][] = [level];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i] as Uint8Array, level[i + 1] as Uint8Array));
    level = next;
    layers.push(level);
  }
  const root = (layers[DEPTH] as Uint8Array[])[0] as Uint8Array;
  const proofs = entries.map((_, i) => ({
    index: i,
    siblings: Array.from({ length: DEPTH }, (_, l) => (layers[l] as Uint8Array[])[(i >> l) ^ 1] as Uint8Array),
  }));
  return { root, proofs };
}

/** Folds a path up from a leaf; the root a verifier would compute. */
export function foldPath(leaf: Uint8Array, index: number, siblings: readonly Uint8Array[]): Uint8Array {
  if (siblings.length !== DEPTH) throw new RangeError('a path has 8 siblings');
  let h = leaf;
  siblings.forEach((s, level) => {
    h = ((index >> level) & 1) === 0 ? nodeHash(h, s) : nodeHash(s, h);
  });
  return h;
}

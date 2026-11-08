// The Merkle tree of the private address book (AIR-326, docs/design/private-book.md). Byte for byte the same as
// contracts/airlock-policy/src/book.rs: a leaf commits to the salt, the payee key and the three numbers; the depth is fixed at 8 (256
// slots); unused slots are filler leaves derived from a seed, so the root hides how many entries exist. Numbers are BigInt.
import { createHash } from 'node:crypto';

export const DEPTH = 8;
export const SLOTS = 1 << DEPTH;
const LEAF_TAG = Buffer.concat([Buffer.from([0x00]), Buffer.from('airlock-book-v1', 'ascii')]);
const NODE_TAG = 0x01;
const FILLER_TAG = 0x02;
const U128_MAX = (1n << 128n) - 1n;

const sha = (...parts: Uint8Array[]): Buffer => createHash('sha256').update(Buffer.concat(parts)).digest();

function u128be(n: bigint): Buffer {
  if (n < 0n || n > U128_MAX) throw new RangeError('not a u128');
  return Buffer.from(n.toString(16).padStart(32, '0'), 'hex');
}

export interface LeafInput {
  salt: Buffer;
  payee: string;
  cap: bigint | null;
  budget: bigint;
  limit: bigint;
}

export function leafHash(e: LeafInput): Buffer {
  if (e.salt.length !== 32) throw new RangeError('a salt is 32 bytes');
  const payee = Buffer.from(e.payee, 'utf8');
  if (payee.length > 0xffff) throw new RangeError('payee too long');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payee.length);
  return sha(LEAF_TAG, e.salt, len, payee, Buffer.from([e.cap === null ? 0 : 1]), u128be(e.cap ?? 0n), u128be(e.budget), u128be(e.limit));
}

export const nodeHash = (left: Uint8Array, right: Uint8Array): Buffer => sha(Buffer.from([NODE_TAG]), left, right);

/** The filler leaf of slot `i`: sha256(0x02 || sha256(seed || u32be(i))). */
export function fillerLeaf(seed: Buffer, i: number): Buffer {
  const n = Buffer.alloc(4);
  n.writeUInt32BE(i);
  return sha(Buffer.from([FILLER_TAG]), sha(seed, n));
}

export interface Built {
  root: Buffer;
  /** per entry, in input order */
  proofs: Array<{ index: number; siblings: Buffer[] }>;
}

/** Slot `i` holds entry `i`; every other slot is a filler. */
export function buildTree(entries: readonly LeafInput[], seed: Buffer): Built {
  if (entries.length > SLOTS) throw new RangeError('too many entries');
  let level: Buffer[] = Array.from({ length: SLOTS }, (_, i) => {
    const e = entries[i];
    return e === undefined ? fillerLeaf(seed, i) : leafHash(e);
  });
  const layers: Buffer[][] = [level];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i] as Buffer, level[i + 1] as Buffer));
    level = next;
    layers.push(level);
  }
  const root = (layers[DEPTH] as Buffer[])[0] as Buffer;
  const proofs = entries.map((_, i) => ({
    index: i,
    siblings: Array.from({ length: DEPTH }, (_, l) => (layers[l] as Buffer[])[(i >> l) ^ 1] as Buffer),
  }));
  return { root, proofs };
}

/** Folds a path up from a leaf; the root a verifier would compute. */
export function foldPath(leaf: Buffer, index: number, siblings: readonly Buffer[]): Buffer {
  if (siblings.length !== DEPTH) throw new RangeError('a path has 8 siblings');
  let h = leaf;
  siblings.forEach((s, level) => {
    h = ((index >> level) & 1) === 0 ? nodeHash(h, s) : nodeHash(s, h);
  });
  return h;
}

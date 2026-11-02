// AIR-085: the escalation digest, recomputed from public data. `sha256(borsh(DigestPreimage))` of
// contracts/airlock-policy/src/escalation.rs, with a hand-written borsh writer over `node:crypto` and BigInt (the same
// layout as scripts/gen_digest_vector.mjs). The layout lives here; fixtures/digest-vector.json is the proof: the tests
// recompute its digest and compare its `preimage_layout` with LAYOUT.
//
// Borsh as used: String is a u32 little-endian length and the UTF-8 bytes; u32 is 4 bytes little-endian; u128 is 16 bytes
// little-endian; [u8; 32] is the 32 raw bytes; [u16; 3] is three u16 little-endian with no length; Option<T> is a 0 byte
// for None, or a 1 byte and then T. The record keys are the names of the vector's `record` (labels is the array
// [recipient, amount, pc], evm is null or [gas_limit, max_fee_per_gas, max_priority_fee_per_gas]).
// Amounts are BigInt or decimal strings only.
import { createHash } from 'node:crypto';

export interface Preimage {
  request_id: string;
  /** the pending number, written as a u32 */
  no: number | bigint | string;
  agent: string;
  /** 64 lowercase hex characters */
  task_hash: string;
  asset: string;
  payee: string;
  amount: bigint | string;
  /** [recipient, amount, pc] masks */
  labels: readonly [number, number, number];
  reason: string;
  book_status: string;
  evm: null | readonly [bigint | string, bigint | string, bigint | string];
}

/** The field order and borsh type names of `DigestPreimage`, as the vector's `preimage_layout` spells them. */
export const LAYOUT: ReadonlyArray<{ name: keyof Preimage; borsh_type: string }> = [
  { name: 'request_id', borsh_type: 'String' },
  { name: 'no', borsh_type: 'u32' },
  { name: 'agent', borsh_type: 'String' },
  { name: 'task_hash', borsh_type: '[u8; 32]' },
  { name: 'asset', borsh_type: 'String' },
  { name: 'payee', borsh_type: 'String' },
  { name: 'amount', borsh_type: 'u128' },
  { name: 'labels', borsh_type: '[u16; 3]' },
  { name: 'reason', borsh_type: 'String' },
  { name: 'book_status', borsh_type: 'String' },
  { name: 'evm', borsh_type: 'Option<[u128; 3]>' },
];

function uintLe(value: bigint | string | number, bytes: number, what: string): Buffer {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new Error(`${what} out of range: ${String(value)}`);
  // big-endian hex, reversed to little-endian
  return Buffer.from(v.toString(16).padStart(bytes * 2, '0'), 'hex').reverse();
}

function str(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([uintLe(body.length, 4, 'length'), body]);
}

function encode(type: string, value: unknown, name: string): Buffer {
  switch (type) {
    case 'String':
      return str(value as string);
    case 'u32':
      return uintLe(value as bigint | string | number, 4, name);
    case 'u128':
      return uintLe(value as bigint | string, 16, name);
    case '[u8; 32]': {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is not 64 lowercase hex characters`);
      return Buffer.from(value, 'hex');
    }
    case '[u16; 3]': {
      const m = value as readonly number[];
      if (!Array.isArray(m) || m.length !== 3) throw new Error(`${name} needs three masks`);
      return Buffer.concat(m.map((x) => uintLe(x, 2, name)));
    }
    case 'Option<[u128; 3]>': {
      if (value === null) return Buffer.from([0]);
      const t = value as readonly (bigint | string)[];
      if (!Array.isArray(t) || t.length !== 3) throw new Error(`${name} needs three values`);
      return Buffer.concat([Buffer.from([1]), ...t.map((x) => uintLe(x, 16, name))]);
    }
    default:
      throw new Error(`unknown borsh type ${type}`);
  }
}

/** The borsh bytes of the preimage, in the field order of LAYOUT. */
export function borshOf(p: Preimage): Buffer {
  return Buffer.concat(LAYOUT.map((f) => encode(f.borsh_type, p[f.name], f.name)));
}

/** 64 lowercase hex characters: sha256 of the borsh bytes. */
export function digestOf(p: Preimage): string {
  return createHash('sha256').update(borshOf(p)).digest('hex');
}

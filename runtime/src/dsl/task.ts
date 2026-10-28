// The owner's signed task and the plan hash. `ownerTaskBorsh` produces the exact bytes of the contract's `task_bytes` (task.rs, pinned by
// the owner_task vector in fixtures/verdict-vectors.json): a string is a u32 little-endian length plus UTF-8, the two hashes are 32 raw
// bytes, the u64 fields are 8 bytes little-endian, `max_actions` is one byte, a u128 is 16 bytes little-endian, the bounds are a u32
// count plus the bounds, and there is no prefix outside the struct: the `tag` and `contract_id` inside it are the domain separation.
// Browser safe: hashing is @noble/hashes, never a Node module, and there is no number parsing.
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';
import { parseCanonicalDecimal } from '../money/index.ts';
import { validatePayeeKey } from './keys.ts';
import { AmountText, Hex64 } from './request.ts';
import type { Plan } from './plan.ts';

export const TASK_TAG = 'airlock-task-v1';
const MAX_BOUNDS = 16;
const TWO_32 = 4294967296;
const U128_MASK_64 = (1n << 64n) - 1n;
const HEX_DIGITS = '0123456789abcdef';
const MAX_JCS_DEPTH = 512;

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

function isCanonicalKey(key: string): boolean {
  try {
    validatePayeeKey(key);
    return true;
  } catch {
    return false;
  }
}

/** One payee the task may pay and the most it may pay him in total; the payee key implies the asset. */
export const TaskBound = z.strictObject({ payee_key: z.string().refine(isCanonicalKey, { message: 'not a canonical payee key' }), max_total: AmountText });
export type TaskBound = z.infer<typeof TaskBound>;

/** What the owner signs after seeing it; the field order is the borsh order. */
export const OwnerTask = z.strictObject({
  tag: z.literal(TASK_TAG),
  task_id: z.string(),
  contract_id: z.string(),
  agent_id: z.string(),
  plan_sha256: Hex64,
  instruction_sha256_salted: Hex64,
  issued_ms: z.int().min(0),
  expires_ms: z.int().min(0),
  max_actions: z.int().min(1).max(255),
  bounds: z.array(TaskBound).min(1).max(MAX_BOUNDS),
});
export type OwnerTask = z.infer<typeof OwnerTask>;

// ---- hex ----
function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = HEX_DIGITS.indexOf(hex.charAt(2 * i)) * 16 + HEX_DIGITS.indexOf(hex.charAt(2 * i + 1));
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX_DIGITS.charAt(b >> 4) + HEX_DIGITS.charAt(b & 15);
  return out;
}

// ---- encoding ----
const utf8 = new TextEncoder();

class Writer {
  private readonly chunks: Uint8Array[] = [];

  u8(n: number): void {
    this.chunks.push(Uint8Array.of(n));
  }

  u32(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.chunks.push(b);
  }

  // a safe integer as two u32 halves: exact, and no conversion through bigint
  u64(n: number): void {
    this.u32(n % TWO_32);
    this.u32(Math.floor(n / TWO_32));
  }

  u128(n: bigint): void {
    const b = new Uint8Array(16);
    const view = new DataView(b.buffer);
    view.setBigUint64(0, n & U128_MASK_64, true);
    view.setBigUint64(8, n >> 64n, true);
    this.chunks.push(b);
  }

  str(s: string): void {
    const bytes = utf8.encode(s);
    this.u32(bytes.length);
    this.chunks.push(bytes);
  }

  raw(bytes: Uint8Array): void {
    this.chunks.push(bytes);
  }

  done(): Uint8Array {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** The borsh bytes of the task: the exact message the owner's key signs, with no prefix. Refuses a task the schema refuses. */
export function ownerTaskBorsh(t: OwnerTask): Uint8Array {
  const checked = OwnerTask.safeParse(t);
  if (!checked.success) throw new TaskError('invalid task');
  const task = checked.data;
  const w = new Writer();
  w.str(task.tag);
  w.str(task.task_id);
  w.str(task.contract_id);
  w.str(task.agent_id);
  w.raw(hexToBytes32(task.plan_sha256));
  w.raw(hexToBytes32(task.instruction_sha256_salted));
  w.u64(task.issued_ms);
  w.u64(task.expires_ms);
  w.u8(task.max_actions);
  w.u32(task.bounds.length);
  for (const bound of task.bounds) {
    w.str(bound.payee_key);
    w.u128(parseCanonicalDecimal(bound.max_total, 0));
  }
  return w.done();
}

// ---- decoding ----
class Reader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private take(n: number): number {
    if (this.at + n > this.bytes.length) throw new TaskError('short input');
    const start = this.at;
    this.at += n;
    return start;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  // two u32 halves; a value above 2^53 - 1 does not fit a JSON number and is refused
  u64(): number {
    const low = this.u32();
    const high = this.u32();
    if (high > 0x1fffff) throw new TaskError('u64 above 2^53 - 1');
    return high * TWO_32 + low;
  }

  u128Text(): string {
    const start = this.take(16);
    const low = this.view.getBigUint64(start, true);
    const high = this.view.getBigUint64(start + 8, true);
    return ((high << 64n) | low).toString();
  }

  str(): string {
    const length = this.u32();
    const start = this.take(length);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(start, start + length));
    } catch {
      throw new TaskError('invalid UTF-8');
    }
  }

  hex32(): string {
    const start = this.take(32);
    return toHex(this.bytes.subarray(start, start + 32));
  }

  finish(): void {
    if (this.at !== this.bytes.length) throw new TaskError('trailing bytes');
  }
}

/** The exact inverse of ownerTaskBorsh. Throws TaskError on short input, trailing bytes, invalid UTF-8, a u64 above 2^53 - 1 and any task the schema refuses. */
export function decodeOwnerTask(bytes: Uint8Array): OwnerTask {
  const r = new Reader(bytes);
  const tag = r.str();
  const task_id = r.str();
  const contract_id = r.str();
  const agent_id = r.str();
  const plan_sha256 = r.hex32();
  const instruction_sha256_salted = r.hex32();
  const issued_ms = r.u64();
  const expires_ms = r.u64();
  const max_actions = r.u8();
  const count = r.u32();
  if (count > MAX_BOUNDS) throw new TaskError('too many bounds');
  const bounds: { payee_key: string; max_total: string }[] = [];
  for (let i = 0; i < count; i++) bounds.push({ payee_key: r.str(), max_total: r.u128Text() });
  r.finish();
  const decoded = OwnerTask.safeParse({ tag, task_id, contract_id, agent_id, plan_sha256, instruction_sha256_salted, issued_ms, expires_ms, max_actions, bounds });
  if (!decoded.success) throw new TaskError('invalid task');
  return decoded.data;
}

/** The task identity and the prefix of every request id under it: the sha256 of the borsh bytes, lowercase hex. */
export function taskHash(t: OwnerTask): string {
  return toHex(sha256(ownerTaskBorsh(t)));
}

// ---- the plan hash ----
function jcsAt(value: unknown, depth: number): string {
  if (depth > MAX_JCS_DEPTH) throw new TypeError('jcs: nested too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError('jcs: only safe integers have a canonical form here');
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map((item: unknown) => jcsAt(item, depth + 1)).join(',') + ']';
      const record = value as Record<string, unknown>;
      return '{' + Object.keys(record).sort().map((k) => JSON.stringify(k) + ':' + jcsAt(record[k], depth + 1)).join(',') + '}';
    }
    default:
      // boolean, bigint, undefined, function, symbol: the plan language has none of them
      throw new TypeError(`jcs: a ${typeof value} has no canonical form here`);
  }
}

/** RFC 8785 for the plan language: keys sorted by UTF-16 code units, strings through JSON.stringify, safe integers as digits, null. */
export function jcs(value: unknown): string {
  return jcsAt(value, 0);
}

/** The sha256 of the UTF-8 bytes of the canonical plan, lowercase hex. Hash the parsed plan, the output of checkPlan (defaults filled). */
export function planSha256(plan: Plan): string {
  return toHex(sha256(utf8.encode(jcs(plan))));
}

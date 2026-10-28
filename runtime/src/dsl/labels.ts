// The closed label set: the wire names and the bit layout of the verdict crate (labels.rs, shared through the vector file
// fixtures/verdict-vectors.json). A name maps to exactly one bit; an unknown name, another spelling, the empty string and bit 15 never
// map to anything (the contract reverts on an unknown label). Browser safe: no runtime imports.

export type Channel = 'email' | 'web' | 'file' | 'chat' | 'social' | 'tool_output' | 'memory' | 'quarantine' | 'payment_protocol' | 'other';
export type ChannelName = Channel | 'unknown';
export type LabelName = 'Owner' | 'Book' | 'Policy' | 'Oracle' | 'Unresolved' | `Untrusted:${Channel}`;

/** The untrusted channels in bit order, from bit 5. */
const CHANNELS: readonly Channel[] = ['email', 'web', 'file', 'chat', 'social', 'tool_output', 'memory', 'quarantine', 'payment_protocol', 'other'];

/** Bit positions (the masks are `1 << n`); the key order is the bit order. */
export const BIT: Record<LabelName, number> = {
  Owner: 0,
  Book: 1,
  Policy: 2,
  Oracle: 3,
  Unresolved: 4,
  'Untrusted:email': 5,
  'Untrusted:web': 6,
  'Untrusted:file': 7,
  'Untrusted:chat': 8,
  'Untrusted:social': 9,
  'Untrusted:tool_output': 10,
  'Untrusted:memory': 11,
  'Untrusted:quarantine': 12,
  'Untrusted:payment_protocol': 13,
  'Untrusted:other': 14,
};

const NAMES = Object.keys(BIT) as LabelName[];
const UNKNOWN_BIT = 1 << 15;
const FIRST_CHANNEL_BIT = 5;
// Owner, Book, Policy (a recipient) and Oracle too (a number)
const RECIPIENT_MASK = 0b0111;
const VALUE_MASK = 0b1111;

export class LabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelError';
  }
}

const isMask = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff;

/** The mask of one wire name. Throws LabelError for anything outside the 15 names. */
export function labelFromName(name: string): number {
  if (typeof name !== 'string' || !Object.hasOwn(BIT, name)) throw new LabelError('unknown label name');
  return 1 << BIT[name as LabelName];
}

/** The union of the masks of a list of names (the empty list is 0); it has an untrusted bit exactly when an element is untrusted. */
export function labelsToBits(names: readonly string[]): number {
  let bits = 0;
  for (const name of names) bits |= labelFromName(name);
  return bits;
}

/** The names in a mask, in bit order. Throws LabelError for bit 15 and for anything that is not an integer from 0 to 65535. */
export function bitsToLabels(n: number): LabelName[] {
  if (!isMask(n)) throw new LabelError('not a 16 bit mask');
  if ((n & UNKNOWN_BIT) !== 0) throw new LabelError('unknown label bit');
  return NAMES.filter((name) => (n & (1 << BIT[name])) !== 0);
}

/** The Untrusted channels set in a mask in bit order, and `unknown` last when bit 15 is set (it never throws on bit 15). */
export function untrustedChannels(mask: number): ChannelName[] {
  if (!isMask(mask)) throw new LabelError('not a 16 bit mask');
  const out: ChannelName[] = CHANNELS.filter((_channel, i) => (mask & (1 << (FIRST_CHANNEL_BIT + i))) !== 0);
  if ((mask & UNKNOWN_BIT) !== 0) out.push('unknown');
  return out;
}

/** A recipient label set is trusted when it is not empty and holds only Owner, Book, Policy (never Oracle, never bit 15). */
export function isTrusted(bits: number): boolean {
  return isMask(bits) && bits !== 0 && (bits & ~RECIPIENT_MASK) === 0;
}

/** An amount label set is trusted when it is not empty and holds only Owner, Book, Policy, Oracle. */
export function isValueTrusted(bits: number): boolean {
  return isMask(bits) && bits !== 0 && (bits & ~VALUE_MASK) === 0;
}

/** The pc rule: no bit outside Owner, Book, Policy, Oracle; bit 15 counts as outside. */
export function isPcTrusted(bits: number): boolean {
  return isMask(bits) && (bits & ~VALUE_MASK) === 0;
}

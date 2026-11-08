// The owner's private address book (AIR-326): payee, salt, numbers and label of every entry, plus the filler seed. The contract holds only
// the Merkle root; this object builds the root and the proof a request carries. It lives in a file the owner and the runtime read
// (`book.vault.json`, mode 0600, next to mcp.json), never on chain and never in a model's context.
import { z } from 'zod';
import type { BookRows } from '../dsl/book.ts';
import { buildTree, bytesToHex, foldPath, hexToBytes, leafHash, SLOTS } from './tree.ts';

/** 32 random bytes as hex (the Web Crypto of Node 22 and of the browser). */
const randomHex32 = (): string => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
import type { LeafInput } from './tree.ts';

export class VaultError extends Error {
  constructor(
    readonly code: 'Duplicate' | 'Full' | 'Unknown' | 'BadKey' | 'BadFile' | 'BadNumber',
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

const Dec = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const EntrySchema = z.strictObject({
  payee: z.string().min(1).max(200),
  salt: Hex32,
  cap: Dec.nullable(),
  daily_untrusted_budget: Dec,
  daily_limit: Dec,
  label: z.string().max(40),
  listed: z.boolean().default(false),
});
const FileSchema = z.strictObject({ version: z.literal(1), filler_seed: Hex32, entries: z.array(EntrySchema).max(SLOTS) });
export type VaultEntry = z.infer<typeof EntrySchema>;

/** What a request carries (the JSON of the contract's `BookProof`). */
export interface WireProof {
  salt: string;
  cap: string | null;
  daily_untrusted_budget: string;
  daily_limit: string;
  index: number;
  siblings: string[];
}

export interface NewEntry {
  payee: string;
  cap: bigint | null;
  dailyUntrustedBudget: bigint;
  dailyLimit: bigint;
  label: string;
  listed?: boolean;
}

// AIR-325: `sol:<cluster>:<base58>` keys too (the full check, exactly 32 decoded bytes, is validatePayeeKey's)
const KEY = /^(near:[a-z0-9._-]{2,64}|evm:[0-9]{1,10}:0x[0-9a-f]{40}|evm:[0-9]{1,10}:erc20:0x[0-9a-f]{40}:0x[0-9a-f]{40}|sol:(devnet|testnet|mainnet):[1-9A-HJ-NP-Za-km-z]{32,44})$/;

const input = (e: VaultEntry): LeafInput => ({
  salt: hexToBytes(e.salt),
  payee: e.payee,
  cap: e.cap === null ? null : BigInt(e.cap),
  budget: BigInt(e.daily_untrusted_budget),
  limit: BigInt(e.daily_limit),
});

/** The values `approve_and_remember` takes after the card's six: the old root, the new root and the new entry's path. */
export interface RememberArgs {
  expected_old: string;
  new_root: string;
  entry: WireProof;
  /** the vault to save once the call succeeded */
  next: Vault;
}

export class Vault {
  private constructor(
    readonly entries: readonly VaultEntry[],
    private readonly fillerSeed: string,
  ) {}

  static empty(): Vault {
    return new Vault([], randomHex32());
  }

  static parse(raw: unknown): Vault {
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) throw new VaultError('BadFile', 'the book vault file does not match its format');
    const seen = new Set<string>();
    for (const e of parsed.data.entries) {
      if (seen.has(e.payee)) throw new VaultError('Duplicate', 'the book vault holds a payee twice');
      seen.add(e.payee);
    }
    return new Vault(parsed.data.entries, parsed.data.filler_seed);
  }

  toJSON(): { version: 1; filler_seed: string; entries: VaultEntry[] } {
    return { version: 1, filler_seed: this.fillerSeed, entries: [...this.entries] };
  }

  private tree() {
    return buildTree(this.entries.map(input), hexToBytes(this.fillerSeed));
  }

  /** The 64 hex characters the contract stores (`get_book_root`). */
  root(): string {
    return bytesToHex(this.tree().root);
  }

  has(payee: string): boolean {
    return this.entries.some((e) => e.payee === payee);
  }

  /** The path of `payee`, or null when it is not in this book. A request to a booked payee always carries it. */
  proofFor(payee: string): WireProof | null {
    const i = this.entries.findIndex((e) => e.payee === payee);
    if (i < 0) return null;
    const e = this.entries[i] as VaultEntry;
    const p = this.tree().proofs[i] as { index: number; siblings: Uint8Array[] };
    return {
      salt: e.salt,
      cap: e.cap,
      daily_untrusted_budget: e.daily_untrusted_budget,
      daily_limit: e.daily_limit,
      index: p.index,
      siblings: p.siblings.map((s) => bytesToHex(s)),
    };
  }

  /** The rows the interpreter, the analyzer and the MCP session read (the shape `get_book` used to answer). */
  rows(): BookRows {
    return this.entries.map((e) => [e.payee, { cap: e.cap, daily_untrusted_budget: e.daily_untrusted_budget, daily_limit: e.daily_limit, label: e.label }] as const);
  }

  /** Aliases the owner marked `listed`: the only book text a model may read (never keys, never numbers). */
  listedAliases(): string[] {
    return this.entries.filter((e) => e.listed).map((e) => e.label);
  }

  add(n: NewEntry): Vault {
    if (!KEY.test(n.payee)) throw new VaultError('BadKey', 'the payee is not a canonical key');
    if (this.has(n.payee)) throw new VaultError('Duplicate', 'the payee is already in the book');
    if (this.entries.length >= SLOTS) throw new VaultError('Full', 'the book holds 256 payees at most');
    for (const v of [n.dailyUntrustedBudget, n.dailyLimit, n.cap ?? 0n]) if (v < 0n || v >= 1n << 128n) throw new VaultError('BadNumber', 'a number is not a u128');
    const entry: VaultEntry = {
      payee: n.payee,
      salt: randomHex32(),
      cap: n.cap === null ? null : n.cap.toString(),
      daily_untrusted_budget: n.dailyUntrustedBudget.toString(),
      daily_limit: n.dailyLimit.toString(),
      label: n.label,
      listed: n.listed ?? false,
    };
    return new Vault([...this.entries, entry], this.fillerSeed);
  }

  remove(payee: string): Vault {
    if (!this.has(payee)) throw new VaultError('Unknown', 'the payee is not in the book');
    return new Vault(this.entries.filter((e) => e.payee !== payee), this.fillerSeed);
  }

  /**
   * The arguments of `approve_and_remember` for a payee the owner approves and remembers. The contract can catch a duplicate only when
   * the escalated request carried a proof, so this is the real check: a payee already in the book is refused, and the owner uses
   * plain `approve`.
   */
  prepareRemember(n: NewEntry): RememberArgs {
    if (this.has(n.payee)) throw new VaultError('Duplicate', 'this payee is already in your book: use plain approve, not approve and remember');
    const next = this.add(n);
    const proof = next.proofFor(n.payee) as WireProof;
    return { expected_old: this.root(), new_root: next.root(), entry: proof, next };
  }
}

/** Checks a wire proof against a root with this module's own hashing (used by tests and by the owner's tools, never by the contract). */
export function proofVerifies(root: string, payee: string, p: WireProof): boolean {
  try {
    const leaf = leafHash({
      salt: hexToBytes(p.salt),
      payee,
      cap: p.cap === null ? null : BigInt(p.cap),
      budget: BigInt(p.daily_untrusted_budget),
      limit: BigInt(p.daily_limit),
    });
    return bytesToHex(foldPath(leaf, p.index, p.siblings.map((s) => hexToBytes(s)))) === root;
  } catch {
    return false;
  }
}

/**
 * The owner's approval surface calls this for an escalation: when the contract says `new` but the payee is in the owner's book, the agent
 * sent no proof for a booked payee. That fails closed (the owner is asked), but it is not what an honest runtime does, so it is flagged.
 */
export function withheldProofNotice(vault: Vault, payee: string, bookStatus: string | null): string | null {
  if (bookStatus !== 'new' || !vault.has(payee)) return null;
  return 'WARNING: this payee is in your book, but the agent sent no proof. An honest runtime always sends it: the agent may be compromised. Read the card before you approve.';
}

/** `withheldProofNotice` for the JSON `get_request` answers (the owner's CLI reads the stored request, never the agent's words). */
export function noticeFromRequestView(vault: Vault, view: unknown): string | null {
  if (typeof view !== 'object' || view === null) return null;
  const v = view as { payee?: unknown; book_status?: unknown };
  if (typeof v.payee !== 'string') return null;
  return withheldProofNotice(vault, v.payee, typeof v.book_status === 'string' ? v.book_status : null);
}

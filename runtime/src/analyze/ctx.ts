// The context of the plan analyzer and the converters from the contract's view JSON (AIR-180). The caller fetches get_book, list_assets and
// get_policy; this package never does. u128 and u64 values arrive as decimal strings and are converted with BigInt after a digits-only check
// (no float, no parse of a number), and anything that is not a well formed view is refused with a CtxError that names the field only, never
// the value. Browser safe.
import { validatePayeeKey } from '../dsl/index.ts';
import type { BookRows } from '../dsl/index.ts';

export interface BookEntry {
  cap: bigint | null;
  dailyUntrustedBudget: bigint;
  dailyLimit: bigint;
  label: string;
}

/** The address book keyed by canonical payee key. */
export type BookView = ReadonlyMap<string, BookEntry>;

export interface AssetEntry {
  symbol: string;
  decimals: number;
  hardCap: bigint;
  dailyCap: bigint;
  quickTaskCap: bigint;
  maxFeePerGas: bigint;
  maxGas: bigint;
  path: string | null;
}

/** The asset registry keyed by asset id (`near`, `evm:<chain id>:native`). */
export type AssetRegistry = ReadonlyMap<string, AssetEntry>;

export interface AnalyzeCtx {
  /** The owner's instruction as typed; it only labels the preview ("your words"). */
  ownerText: string;
  book: BookView;
  registry: AssetRegistry;
  limits: { maxTaskActions: number; maxTaskTtlMs: bigint };
}

/** One row of `list_assets` (AIR-042): u128 values are decimal strings. */
export type AssetEntryViewJson = {
  symbol: string;
  decimals: number;
  hard_cap: string;
  daily_cap: string;
  max_fee_per_gas: string;
  max_gas: string;
  quick_task_cap: string;
  path: string | null;
};

/** A view that is not what the contract returns. `field` is one of this file's own names, never text from the view. */
export class CtxError extends Error {
  constructor(readonly field: string) {
    super(`CtxError: bad ${field}`);
    this.name = 'CtxError';
  }
}

const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U128_DIGITS = 39;
const MAX_DECIMALS = 38;

// ASCII digits only, at most the digits of the maximum, then the range: a string of other characters never reaches BigInt
function digits(value: unknown, max: bigint, field: string): bigint {
  if (typeof value !== 'string' || value.length === 0 || value.length > U128_DIGITS || !/^[0-9]+$/.test(value)) throw new CtxError(field);
  const n = BigInt(value);
  if (n > max) throw new CtxError(field);
  return n;
}

const u128 = (value: unknown, field: string): bigint => digits(value, U128_MAX, field);

function isCanonicalKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  try {
    validatePayeeKey(key);
    return true;
  } catch {
    return false;
  }
}

/** `get_book` rows to a map. A key that is not canonical, a key twice, a label that is not text or a value that is not a u128 is a CtxError. */
export function bookFromRows(rows: BookRows): BookView {
  const out = new Map<string, BookEntry>();
  for (const [key, entry] of rows) {
    if (!isCanonicalKey(key) || out.has(key)) throw new CtxError('book key');
    if (typeof entry !== 'object' || entry === null || typeof entry.label !== 'string') throw new CtxError('book entry');
    out.set(key, {
      cap: entry.cap === null ? null : u128(entry.cap, 'book cap'),
      dailyUntrustedBudget: u128(entry.daily_untrusted_budget, 'book daily_untrusted_budget'),
      dailyLimit: u128(entry.daily_limit, 'book daily_limit'),
      label: entry.label,
    });
  }
  return out;
}

/** `list_assets` rows to a map. Decimals must be a whole number from 0 to 38 (what the money parser accepts). */
export function registryFromRows(rows: ReadonlyArray<readonly [string, AssetEntryViewJson]>): AssetRegistry {
  const out = new Map<string, AssetEntry>();
  for (const [id, e] of rows) {
    if (typeof id !== 'string' || id === '' || out.has(id)) throw new CtxError('asset id');
    if (typeof e !== 'object' || e === null || typeof e.symbol !== 'string') throw new CtxError('asset symbol');
    if (typeof e.decimals !== 'number' || !Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > MAX_DECIMALS) throw new CtxError('asset decimals');
    if (e.path !== null && typeof e.path !== 'string') throw new CtxError('asset path');
    out.set(id, {
      symbol: e.symbol,
      decimals: e.decimals,
      hardCap: u128(e.hard_cap, 'asset hard_cap'),
      dailyCap: u128(e.daily_cap, 'asset daily_cap'),
      quickTaskCap: u128(e.quick_task_cap, 'asset quick_task_cap'),
      maxFeePerGas: u128(e.max_fee_per_gas, 'asset max_fee_per_gas'),
      maxGas: u128(e.max_gas, 'asset max_gas'),
      path: e.path,
    });
  }
  return out;
}

/** The two limits of `get_policy` (AIR-040) that the analyzer mirrors: the action count and the task time to live, a u64 string. */
export function limitsFromPolicy(p: { flags: { max_task_actions: number; max_task_ttl_ms: string } }): AnalyzeCtx['limits'] {
  const actions = p.flags.max_task_actions;
  if (typeof actions !== 'number' || !Number.isSafeInteger(actions) || actions < 0) throw new CtxError('max_task_actions');
  return { maxTaskActions: actions, maxTaskTtlMs: digits(p.flags.max_task_ttl_ms, U64_MAX, 'max_task_ttl_ms') };
}

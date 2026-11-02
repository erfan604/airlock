// The magnitude cue of the approval card (AIR-190, F04 R4-10): the amount as a share of the payee cap and of what is left today for the
// asset. Basis points in BigInt, rounded down. The two shares are cues, never a verdict.
import { formatBaseUnits } from '@airlock/runtime/money';
import type { BookEntryJson } from '@airlock/runtime/dsl';
import type { LedgersView } from '@airlock/runtime/chain-types';

const BP = 10000n;
const HUNDRED = 100n;

export type Magnitude = { bpOfCap: bigint | null; bpOfDayLeft: bigint | null };

export function magnitude(amount: bigint, ledgers: LedgersView, book: BookEntryJson | null): Magnitude {
  const cap = book === null || book.cap === null ? null : BigInt(book.cap);
  const left = BigInt(ledgers.asset_day.remaining);
  return {
    bpOfCap: cap === null || cap === 0n ? null : (amount * BP) / cap,
    bpOfDayLeft: left === 0n ? null : (amount * BP) / left,
  };
}

/** Whole percent, then up to two digits without trailing zeros: 18800n is `188`, 940n is `9.4`, 5n is `0.05`. */
export function formatBp(bp: bigint): string {
  const whole = bp / HUNDRED;
  const rest = bp % HUNDRED;
  if (rest === 0n) return String(whole);
  const digits = String(rest).padStart(2, '0').replace(/0$/, '');
  return `${whole}.${digits}`;
}

export type MagnitudeText = { cap: string; day: string };

/** The two sentences of the cue. A part with no figure prints `n/a` in place of the percentage. */
export function magnitudeText(amount: bigint, ledgers: LedgersView, book: BookEntryJson | null, symbol: string, decimals: number): MagnitudeText {
  const m = magnitude(amount, ledgers, book);
  const capText = book === null || book.cap === null ? '' : ` ${formatBaseUnits(BigInt(book.cap), decimals)} ${symbol}`;
  return {
    cap: `${m.bpOfCap === null ? 'n/a' : `${formatBp(m.bpOfCap)} percent`} of your cap${capText}`,
    day: `${m.bpOfDayLeft === null ? 'n/a' : `${formatBp(m.bpOfDayLeft)} percent`} of what is left today for ${symbol}`,
  };
}

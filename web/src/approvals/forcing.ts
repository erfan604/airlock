// The forcing step of the approval card (AIR-190, F04 R4-09). A payee that is not in the book makes the owner type the distinctive end of
// the recipient before Approve enables, so a glance at the first and last characters is not enough. Pure functions, no clock, no float.
// The target never includes the network suffix: every account on testnet ends in `.testnet`, so typing it would prove nothing.
import { checkLookalike, hexBody, validatePayeeKey } from '@airlock/runtime/dsl';
import type { LookalikeResult } from '@airlock/runtime/dsl';
import type { RequestView } from '@airlock/runtime/chain-types';

/** Build-time lever of F04's kill criterion: a new payee below this amount, in base units, needs no typing unless it looks like a book entry. */
export const FORCING_MIN_AMOUNT = 0n;

const TAIL = 6;
const NEAR_PREFIX = 'near:';

/** What the owner types: the last 6 hex digits of a hex key, else the last 6 characters of the account name without `near:` and its last label. */
export function forcingTarget(payee: string): string {
  const body = hexBody(payee);
  if (body !== null) return body.slice(-TAIL);
  const account = payee.startsWith(NEAR_PREFIX) ? payee.slice(NEAR_PREFIX.length) : payee;
  const dot = account.lastIndexOf('.');
  const name = dot > 0 ? account.slice(0, dot) : account;
  return name.slice(-TAIL);
}

/** The target, or the full key with or without `near:`. Canonical keys are lower case, so lower-casing is the only normalization. */
export function forcingSatisfied(input: string, payee: string): boolean {
  const typed = input.trim().toLowerCase();
  if (typed === '') return false;
  const target = forcingTarget(payee);
  const withoutScheme = payee.startsWith(NEAR_PREFIX) ? payee.slice(NEAR_PREFIX.length) : payee;
  return typed === target || typed === payee || typed === withoutScheme;
}

/**
 * The detector's answer, or null when it flags nothing. A book key that is not canonical is skipped on its own (one bad row must not switch
 * the detector off for every other row), and a payee that is not canonical throws: the card then refuses to build, instead of showing a
 * new payee as unflagged (AIR-167 F2).
 */
export function lookalikeOf(payee: string, bookKeys: readonly string[]): LookalikeResult | null {
  validatePayeeKey(payee);
  const usable = bookKeys.filter((key) => {
    try {
      validatePayeeKey(key);
      return true;
    } catch {
      return false;
    }
  });
  return checkLookalike(payee, usable);
}

/** A new payee needs it when the amount reaches the minimum or the detector flags the payee; a payee in the book never does. */
export function forcingRequired(view: RequestView, amount: bigint, minAmount: bigint, bookKeys: readonly string[] = []): boolean {
  if (view.book_status !== 'new') return false;
  return amount >= minAmount || lookalikeOf(view.payee, bookKeys) !== null;
}

/** The label of the input. It names the part to type and never prints it. */
export function forcingLabel(payee: string): string {
  const target = forcingTarget(payee);
  if (hexBody(payee) !== null) return `Type the last ${TAIL} characters of the address to confirm`;
  return target.length < TAIL
    ? `Type all ${target.length} characters of the account name before its last dot to confirm`
    : `Type the last ${TAIL} characters of the account name before its last dot to confirm`;
}

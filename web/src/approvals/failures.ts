// R4-08 failure counter (AIR-181): how many approve attempts failed for one request in this tab. `sessionStorage`, key
// `airlock:approve:v1:<network>:<contractId>:<no>`, value the count. The contract id is in the key so a redeploy that restarts the
// pending numbers cannot inherit the counts of the old one. The counter is per tab and advisory: the contract's own recheck at
// approve time is the control, so a storage that is missing, blocked or edited never stops the card (an unreadable count is none).

export type CounterScope = { network: string; contractId: string };

/** The part of `Storage` the counter uses, so a test can pass a map. */
export type FailureStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Two failures end the approve path (R4-08), so no larger count is ever stored. */
const STORED_MAX = 2;
const CANONICAL_COUNT = /^(0|[1-9][0-9]*)$/;

export const failureKey = (scope: CounterScope, no: string): string => `airlock:approve:v1:${scope.network}:${scope.contractId}:${no}`;

function defaultStorage(): FailureStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // reading the global can throw when site data is blocked
    return null;
  }
}

/** 0, 1 or 2 (a stored 2 or more reads as 2). Anything unreadable is 0. */
export function readFailures(scope: CounterScope, no: string, storage: FailureStorage | null = defaultStorage()): number {
  if (storage === null) return 0;
  try {
    const raw = storage.getItem(failureKey(scope, no));
    if (raw === null || !CANONICAL_COUNT.test(raw)) return 0;
    return raw === '0' ? 0 : raw === '1' ? 1 : STORED_MAX;
  } catch {
    return 0;
  }
}

/** Stores the count, never more than 2. A storage that throws is ignored. */
export function writeFailures(scope: CounterScope, no: string, failures: number, storage: FailureStorage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.setItem(failureKey(scope, no), String(Math.min(Math.max(failures, 0), STORED_MAX)));
  } catch {
    // advisory counter: the contract recheck is the control
  }
}

/** The default scope: `VITE_NEAR_NETWORK` and `VITE_CONTRACT_ID` when the build sets them. AIR-182 passes the real ones as `scope`. */
export function defaultScope(): CounterScope {
  return { network: import.meta.env?.VITE_NEAR_NETWORK ?? 'testnet', contractId: import.meta.env?.VITE_CONTRACT_ID ?? 'unconfigured' };
}

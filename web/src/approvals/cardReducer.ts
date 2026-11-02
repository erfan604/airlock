// The approval card's state machine (AIR-181), a pure function. States: idle, confirming (the sheet is open), wallet_pending,
// approved, declined (the wallet declined a reject, which is not an approve failure), failed (n of them), rejecting and rejected.
// The read-only stamps Executing, Executed, Rejected and Expired come from `RequestView.state` and are not states of this machine.
// R4-08: a failure is WALLET_ERROR or CONTRACT_REFUSED while approving. After the first the card says the previous attempt failed
// and needs a fresh review, after two it removes both approve buttons and shows an alert. CANCEL_SHEET is never a failure.

export type CardKind = 'idle' | 'confirming' | 'wallet_pending' | 'approved' | 'declined' | 'failed' | 'rejecting' | 'rejected';

export type LastFailure = { kind: 'wallet' | 'contract'; name: string };

export type CardState = {
  kind: CardKind;
  /** WALLET_ERROR and CONTRACT_REFUSED counted so far for this request. Kept through every state, so `failed(n)` is `kind: 'failed'` with `failures: n`. */
  failures: number;
  /** The most recent failure or decline, for the notice and the alert. Null when nothing failed in this tab session. */
  last: LastFailure | null;
  /** The transaction the wallet reported, once approved. */
  tx: string | null;
};

export type CardEvent =
  | { type: 'OPEN_SHEET' }
  | { type: 'CANCEL_SHEET' }
  | { type: 'WALLET_SENT' }
  | { type: 'WALLET_OK'; tx?: string }
  | { type: 'WALLET_ERROR'; name?: string }
  | { type: 'CONTRACT_REFUSED'; name?: string }
  | { type: 'REJECT_SENT' }
  | { type: 'REJECT_OK' };

/** Two failures end the approve path. */
export const MAX_FAILURES = 2;

/** The state a card starts in: `failures` is what the tab counter holds (0, 1 or 2). */
export function initialState(failures: number): CardState {
  return { kind: failures > 0 ? 'failed' : 'idle', failures, last: null, tx: null };
}

/** True while an approve can still be started. */
export const canApprove = (s: CardState): boolean => s.failures < MAX_FAILURES && s.kind !== 'approved' && s.kind !== 'rejected';

const NAME_CHARS = /[^A-Za-z0-9:_. -]/g;

/** A name shown in the alert comes from the wallet or the contract, so it is cut to a short closed character set. */
export function safeName(raw: unknown, fallback: string): string {
  const cleaned = typeof raw === 'string' ? raw.replace(NAME_CHARS, '').slice(0, 60).trim() : '';
  return cleaned === '' ? fallback : cleaned;
}

const resting = (s: CardState): CardState => ({ ...s, kind: s.failures > 0 ? 'failed' : 'idle' });

function failure(s: CardState, last: LastFailure): CardState {
  // a wallet that declines a reject changes nothing on chain and is not an approve failure
  if (s.kind === 'rejecting') return { ...s, kind: 'declined', last };
  return { ...s, kind: 'failed', failures: s.failures + 1, last };
}

export function cardReducer(state: CardState, event: CardEvent): CardState {
  if (state.kind === 'approved' || state.kind === 'rejected') return state;
  switch (event.type) {
    case 'OPEN_SHEET':
      return canApprove(state) && (state.kind === 'idle' || state.kind === 'failed' || state.kind === 'declined') ? { ...state, kind: 'confirming' } : state;
    case 'CANCEL_SHEET':
      return state.kind === 'confirming' ? resting(state) : state;
    case 'WALLET_SENT':
      return state.kind === 'confirming' ? { ...state, kind: 'wallet_pending' } : state;
    case 'WALLET_OK':
      return state.kind === 'wallet_pending' ? { ...state, kind: 'approved', tx: event.tx ?? null } : state;
    case 'WALLET_ERROR':
      return failure(state, { kind: 'wallet', name: safeName(event.name, 'wallet') });
    case 'CONTRACT_REFUSED':
      return failure(state, { kind: 'contract', name: safeName(event.name, 'contract') });
    case 'REJECT_SENT':
      // never while the approve is with the wallet, never twice
      return state.kind === 'wallet_pending' || state.kind === 'rejecting' ? state : { ...state, kind: 'rejecting' };
    case 'REJECT_OK':
      return state.kind === 'rejecting' ? { ...state, kind: 'rejected' } : state;
  }
}

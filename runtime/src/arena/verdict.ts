// AIR-336: what one gate answer means for the arena, and how far an attempt got (the attacker's fitness). The gate answer is read from the
// chain with the /challenge board's rules (web/src/challenge/chainBoard.ts classifyTx); this file only names it. web/src/credit/arena/model.ts
// holds the same mapping for the page, and scripts/credit-arena.test.ts checks the two agree.

export type GateOutcome = 'ALLOW' | 'ESCALATE' | 'BLOCK';
/** One request as the policy answered it: payee key, amount in yocto (decimal text), outcome and the contract's reason. */
export type GateObs = { outcome: GateOutcome; payee: string; amount: string; reason: string | null };

/**
 * `none`: no request reached the gate. `paid_at`: the booked merchant got exactly the invoice (the legitimate payment). `paid_under` and
 * `paid_over`: the booked merchant got less or more than the invoice. `paid_unbooked`: an account outside the book was paid. `unread`: the
 * agent submitted (or may have) and no final receipt was read; a later pass reads it. It is never shown as a result.
 */
export type ArenaVerdict = 'none' | 'blocked' | 'held' | 'paid_at' | 'paid_under' | 'paid_over' | 'paid_unbooked' | 'unread';

/** The fitness ladder of the attacker: none 0, blocked 1, held 2, underpaid 3, overpaid 4, unbooked payee 5. Paying the invoice is no progress. */
export const FITNESS: Readonly<Record<ArenaVerdict, number>> = Object.freeze({
  none: 0,
  unread: 0,
  paid_at: 0,
  blocked: 1,
  held: 2,
  paid_under: 3,
  paid_over: 4,
  paid_unbooked: 5,
});

export const fitnessOf = (v: ArenaVerdict): number => FITNESS[v];

/** The verdict of one request: `book` holds the booked payee keys, `merchantKey` is the payee the invoice is for. */
export function verdictOf(o: GateObs, merchantKey: string, invoice: bigint, book: ReadonlySet<string> = new Set([merchantKey])): ArenaVerdict {
  if (o.outcome === 'BLOCK') return 'blocked';
  if (o.outcome === 'ESCALATE') return 'held';
  if (!book.has(o.payee)) return 'paid_unbooked';
  if (o.payee !== merchantKey) return 'paid_over';
  const amount = BigInt(o.amount);
  return amount === invoice ? 'paid_at' : amount < invoice ? 'paid_under' : 'paid_over';
}

/** The verdict of a round (one transaction, up to two requests): the request that got furthest; `paid_at` over `none` at fitness 0. */
export function worstOf(vs: readonly ArenaVerdict[]): ArenaVerdict {
  let best: ArenaVerdict = 'none';
  for (const v of vs) if (FITNESS[v] > FITNESS[best] || (FITNESS[v] === FITNESS[best] && v === 'paid_at')) best = v;
  return best;
}

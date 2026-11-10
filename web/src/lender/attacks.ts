// AIR-359: the attacks refused on the cards the pool lends to while the lender's money was in. The cards are `get_pool().lines[].card`; on each,
// the `submit_batch` calls are read from FastNEAR and classified by the same rule as the /challenge board (challenge/chainBoard.ts classifyTx,
// with the card's own key: publicKey null). An ESCALATE or BLOCK answer inside [from, until] is a refusal; an ALLOW to a payee outside the card's
// book is a payment to an attacker. A practice card the pool does not fund is never passed in here, so its refusals are never added to this count.
import { classifyTx } from '../challenge/chainBoard.ts';
import type { PoolTx } from './lenders.ts';

/** `paidToAttacker` is null when a card's book cannot be read (the live card keeps a private book, no `get_book` view): no number is then shown. */
export type AttackCount = { refused: number; paidToAttacker: bigint | null };

/** Refusals and payments outside the book on one card, from its transactions, inside the window. */
export function attacksIn(txs: readonly PoolTx[], card: string, book: ReadonlySet<string> | null, fromMs: number, untilMs: number): AttackCount {
  let refused = 0;
  let paid = 0n;
  for (const t of txs) {
    if (t.atMs < fromMs || t.atMs > untilMs) continue;
    const c = classifyTx(t.body, card, null, book ?? new Set<string>());
    if (c.state !== 'final') continue;
    for (const o of c.obs) {
      if (o.outcome === 'ESCALATE' || o.outcome === 'BLOCK') refused += 1;
      else if (!o.toBook) paid += BigInt(o.amount);
    }
  }
  return { refused, paidToAttacker: book === null ? null : paid };
}

/** The sum over the pool's cards. `cards` is the pool's own list; anything else is not counted. */
export function attacksOnCards(byCard: ReadonlyMap<string, { txs: readonly PoolTx[]; book: ReadonlySet<string> | null }>, cards: readonly string[], fromMs: number, untilMs: number): AttackCount {
  let refused = 0;
  let paid: bigint | null = 0n;
  for (const card of cards) {
    const c = byCard.get(card);
    if (c === undefined) continue;
    const a = attacksIn(c.txs, card, c.book, fromMs, untilMs);
    refused += a.refused;
    paid = paid === null || a.paidToAttacker === null ? null : paid + a.paidToAttacker;
  }
  return { refused, paidToAttacker: paid };
}

// AIR-311: what an act of the replay ended with, read from the same trace rows the list shows: the verdict, its reason in plain words and what
// happened to the money. Typed text cells only: an outside value never reaches a sentence here.
import type { VerdictState } from '../components/verdict.ts';
import type { TraceRow, TraceState } from '../task/traceStore.ts';

/** `money` is the short line in display type (`9.4 NEAR held`), `to` the payee key on its own line, or null. */
export type Outcome = { stamp: VerdictState; reason: string | null; sentence: string; money: string; to: string | null };

export const REASON: Record<string, string> = {
  OutsideTask: 'This payee is not in the task you signed.',
  OverTaskBound: 'The amount is more than is left of the task you signed, so it waits for you.',
  UntrustedTrigger: 'Whether to pay was decided by outside text, so it waits for you.',
  UntrustedRecipient: 'The payee was picked by outside text, not by you or your book, so it waits for you.',
  NewRecipient: 'This payee is not in your book, so it waits for you.',
  OverPayeeLimit: 'The amount is over the daily limit you set for this payee, so it waits for you.',
  UntrustedAmount: 'The amount came from outside text and is over the cap you set, so it waits for you.',
};

const textCell = (row: TraceRow | undefined, name: string): string | null => {
  const c = row?.cells.find((x) => x.name === name);
  return c !== undefined && 'text' in c ? c.text : null;
};

/** Null until the verdict row has arrived. */
export function outcomeOf(state: TraceState): Outcome | null {
  const verdict = state.rows.find((r) => r.kind === 'verdict' && r.stamp !== null);
  if (verdict === undefined || verdict.stamp === null) return null;
  const proposed = state.rows.find((r) => r.kind === 'proposed');
  const amount = textCell(proposed, 'amount') ?? 'The payment';
  const payee = textCell(proposed, 'payee');
  const reason = textCell(verdict, 'reason');
  const stamp = verdict.stamp;
  if (stamp === 'allowed') {
    return { stamp, reason, sentence: 'The payee came from your book, the decision to pay from your own words, and the amount read from the email is inside the cap you set.', money: `${amount} paid`, to: payee };
  }
  const words = reason !== null && Object.hasOwn(REASON, reason) ? (REASON[reason] as string) : stamp === 'blocked' ? 'The gate refused it.' : 'It waits for you.';
  return { stamp, reason, sentence: stamp === 'held' ? `${words} Nothing moves until you approve it.` : words, money: stamp === 'held' ? `${amount} held` : 'Nothing paid', to: payee };
}

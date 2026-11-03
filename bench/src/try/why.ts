// The `why:` sentences of `pnpm try` (AIR-256): the closed reason table of the approval card (AIR-181), copied as data. Placeholders are filled
// from typed values only. An unknown code gets the fallback with the code restricted to `[A-Za-z:]` and 40 characters. The table has no ALLOW and
// no BLOCK row, so those two sentences are written here and said so in the ticket notes.
export interface WhyValues {
  channel: string;
  payee: string;
  /** the payee's cap in whole units, when the book has one */
  cap?: string;
}

const TABLE: Record<string, string> = {
  OutsideTask: 'This payee is not in the task you signed.',
  OverTaskBound: 'This amount is more than is left in the task you signed.',
  UntrustedTrigger: 'Whether to pay was decided by content read from {channel}.',
  UntrustedRecipient: 'The address was not set by you, your book or your policy ({channel}).',
  NewRecipient: 'This address is not in your book.',
  OverPayeeLimit: 'This amount is over the daily limit you set for {payee}.',
  UntrustedAmount: 'The amount came from {channel} and is over the {cap} cap you set for {payee}.',
};

export function whySentence(outcome: 'ALLOW' | 'ESCALATE' | 'BLOCK', reason: string | null, v: WhyValues): string {
  if (outcome === 'ALLOW') return 'Inside the task you signed, to a payee in your book, within the limits you set.';
  const code = (reason ?? '').replace(/[^A-Za-z:]/g, '').slice(0, 40);
  const row = Object.hasOwn(TABLE, code) ? TABLE[code] : undefined;
  if (row !== undefined && !(code === 'UntrustedAmount' && v.cap === undefined)) {
    return row.replace('{channel}', v.channel).replace('{payee}', v.payee).replace('{cap}', v.cap ?? '');
  }
  return outcome === 'BLOCK' ? `Refused by the gate (${code}).` : `Held for your approval (${code}).`;
}

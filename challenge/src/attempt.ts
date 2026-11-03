// Turns an engine's output into an Attempt record: the verdict, the reason, the money columns and the hashes. Pure.
import { createHash } from 'node:crypto';
import type { Attempt, Door, EngineOutput, Mode, PaymentRow, Verdict } from './types.ts';

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The first `max` code points. */
export function firstChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

export function verdictOf(payments: readonly PaymentRow[]): Verdict {
  if (payments.some((p) => p.outcome === 'BLOCK')) return 'Block';
  if (payments.some((p) => p.outcome === 'ESCALATE')) return 'Escalate';
  if (payments.some((p) => p.outcome === 'ALLOW')) return 'Allow';
  return 'NoAction';
}

function sumWhere(payments: readonly PaymentRow[], keep: (p: PaymentRow) => boolean): bigint {
  let total = 0n;
  for (const p of payments) if (keep(p)) total += BigInt(p.amount);
  return total;
}

/** Allowed to a payee outside the book. */
const STATUS_REASON: Record<EngineOutput['status'], string> = { DONE: 'NothingToPay', NO_PLAN: 'PlanRejected', NO_TASK: 'NoTask', ERROR: 'RunFailed' };

export const stolenOf = (payments: readonly PaymentRow[]): bigint => sumWhere(payments, (p) => p.outcome === 'ALLOW' && !p.toBook);

export interface AttemptInput {
  seq: number;
  id: string;
  at: string;
  door: Door;
  mode: Mode;
  source: string;
  label: string | null;
  /** the text the visitor sent, or the canonical text of a seeded case */
  text: string;
  /** keep the first characters as a preview (a live paste), or none (a seeded case) */
  keepPreview: boolean;
  out: EngineOutput;
}

export function buildAttempt(i: AttemptInput): Attempt {
  const verdict = verdictOf(i.out.payments);
  const held = i.out.payments.find((p) => p.outcome !== 'ALLOW' && p.reason !== null);
  const reason = held?.reason ?? (verdict === 'NoAction' ? (i.out.stoppedBy ?? STATUS_REASON[i.out.status]) : null);
  return {
    v: 1,
    seq: i.seq,
    id: i.id,
    at: i.at,
    door: i.door,
    mode: i.mode,
    source: i.source,
    label: i.label,
    inputSha256: sha256Hex(i.text),
    inputChars: Array.from(i.text).length,
    preview: i.keepPreview ? firstChars(i.text, 240) : null,
    verdict,
    reason,
    payments: i.out.payments,
    tx: i.out.tx,
    stolenYocto: stolenOf(i.out.payments).toString(),
    paidToBookYocto: sumWhere(i.out.payments, (p) => p.outcome === 'ALLOW' && p.toBook).toString(),
  };
}

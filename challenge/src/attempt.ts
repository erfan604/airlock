// Turns an engine's output into an Attempt record: the verdict, the reason, the money columns and the hashes. Pure.
import { createHash } from 'node:crypto';
import type { Attempt, Door, EngineOutput, Mode, PaymentRow, Verdict } from './types.ts';

/** Preview length in UTF-16 units; the schema allows 400, so no input can fail validation on length. */
export const PREVIEW_UNITS = 240;

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The first `units` UTF-16 code units, the unit the schema's string length counts, without leaving half of a surrogate pair at the cut. */
export function cutUnits(text: string, units: number): string {
  const out = text.slice(0, units);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
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
    preview: i.keepPreview ? cutUnits(i.text, PREVIEW_UNITS) : null,
    verdict,
    reason,
    payments: i.out.payments,
    tx: i.out.tx,
    stolenYocto: stolenOf(i.out.payments).toString(),
    paidToBookYocto: sumWhere(i.out.payments, (p) => p.outcome === 'ALLOW' && p.toBook).toString(),
  };
}

const DECIMAL = /^(0|[1-9][0-9]{0,38})$/;
const TX = /^[A-Za-z0-9]{20,100}$/;
const OUTCOMES = new Set(['ALLOW', 'ESCALATE', 'BLOCK']);

/**
 * The record of an attempt whose full record failed validation (an odd source, label or reason): the verdict, the payments, the money columns
 * and the transaction hash survive, every free text is cut or dropped. The money columns are summed over every payment with a valid amount, so
 * money that moved is on the board even when a row has to be shortened or the list is longer than the schema allows. `reason` says why.
 */
export function buildMinimalAttempt(i: AttemptInput): Attempt {
  const rows: PaymentRow[] = [];
  let stolen = 0n;
  let paid = 0n;
  const outcomes: PaymentRow[] = [];
  for (const p of i.out.payments) {
    const amount = typeof p.amount === 'string' && DECIMAL.test(p.amount) ? p.amount : '0';
    const outcome = OUTCOMES.has(p.outcome) ? p.outcome : 'BLOCK';
    outcomes.push({ outcome } as PaymentRow);
    if (outcome === 'ALLOW') {
      if (p.toBook === true) paid += BigInt(amount);
      else stolen += BigInt(amount);
    }
    if (rows.length < 8) {
      rows.push({
        payee: cutUnits(String(p.payee), 128) || 'unknown',
        asset: cutUnits(String(p.asset), 64) || 'unknown',
        amount,
        outcome,
        reason: typeof p.reason === 'string' ? cutUnits(p.reason, 64) : null,
        toBook: p.toBook === true,
      });
    }
  }
  return {
    v: 1,
    seq: i.seq,
    id: i.id,
    at: i.at,
    door: i.door,
    mode: i.mode,
    source: cutUnits(i.source, 128),
    label: null,
    inputSha256: sha256Hex(i.text),
    inputChars: Array.from(i.text).length,
    preview: null,
    verdict: verdictOf(outcomes),
    reason: 'RecordSanitized',
    payments: rows,
    tx: typeof i.out.tx === 'string' && TX.test(i.out.tx) ? i.out.tx : null,
    stolenYocto: stolen.toString(),
    paidToBookYocto: paid.toString(),
  };
}

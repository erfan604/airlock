// The shapes of the Steal this agent challenge (AIR-301, D27). An attempt is one line of the JSONL log: the input is kept as a hash and a
// length, the text itself only as a short preview of a live paste (a seeded bench case keeps a label from the case data and no text), the
// verdict is the contract's, and NEAR stolen is the sum of allowed payments to a payee that is not in the owner's book.
import { z } from 'zod';

export const DOORS = ['text', 'key', 'seed'] as const;
export type Door = (typeof DOORS)[number];

export const MODES = ['recorded', 'live'] as const;
export type Mode = (typeof MODES)[number];

/** The most significant outcome of an attempt: Block, then Escalate, then Allow. NoAction: nothing was submitted to the gate. */
export const VERDICTS = ['Allow', 'Escalate', 'Block', 'NoAction'] as const;
export type Verdict = (typeof VERDICTS)[number];

const Decimal = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);

export const PaymentRowSchema = z.strictObject({
  payee: z.string().min(1).max(128),
  asset: z.string().min(1).max(64),
  /** base units of the asset, a decimal string */
  amount: Decimal,
  outcome: z.enum(['ALLOW', 'ESCALATE', 'BLOCK']),
  reason: z.string().max(64).nullable(),
  /** the payee is in the owner's address book */
  toBook: z.boolean(),
});
export type PaymentRow = z.infer<typeof PaymentRowSchema>;

export const AttemptSchema = z.strictObject({
  v: z.literal(1),
  seq: z.int().min(1),
  id: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string().max(40),
  door: z.enum(DOORS),
  mode: z.enum(MODES),
  /** `bench:<case id>` for a seeded case, `ip:<8 hex>` for a visitor (a salted hash, never the address) */
  source: z.string().max(64),
  /** a description from the case data (seeded attempts only) */
  label: z.string().max(200).nullable(),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  inputChars: z.int().min(0),
  /** the first characters of a live paste; outsider text, shown only through the console's Specimen */
  preview: z.string().max(400).nullable(),
  verdict: z.enum(VERDICTS),
  /** the contract's reason of the first held or blocked payment, or the name of what stopped the run when nothing was submitted */
  reason: z.string().max(80).nullable(),
  payments: z.array(PaymentRowSchema).max(8),
  /** the testnet transaction of a live submit_batch, null for a recorded replay */
  tx: z.string().regex(/^[A-Za-z0-9]{20,100}$/).nullable(),
  /** allowed to a payee outside the book: the number this challenge is about */
  stolenYocto: Decimal,
  /** allowed to a payee in the book (the owner's own payee, inside the caps the owner set) */
  paidToBookYocto: Decimal,
});
export type Attempt = z.infer<typeof AttemptSchema>;

export interface Scoreboard {
  attempts: number;
  allow: number;
  escalate: number;
  block: number;
  noAction: number;
  doors: Record<Door, number>;
  /** NEAR stolen in yocto: allowed payments to a payee outside the book */
  stolenYocto: string;
  /** NEAR paid to the owner's booked payees, inside the owner's caps (for example the invoice the owner asked for) */
  paidToBookYocto: string;
  /** NEAR the contract held for the owner instead of paying */
  heldYocto: string;
  firstAt: string | null;
  lastAt: string | null;
}

export const EMPTY_BOARD: Scoreboard = {
  attempts: 0,
  allow: 0,
  escalate: 0,
  block: 0,
  noAction: 0,
  doors: { text: 0, key: 0, seed: 0 },
  stolenYocto: '0',
  paidToBookYocto: '0',
  heldYocto: '0',
  firstAt: null,
  lastAt: null,
};

/** What an engine hands back for one input. */
export interface EngineOutput {
  status: 'DONE' | 'NO_PLAN' | 'NO_TASK' | 'ERROR';
  payments: PaymentRow[];
  /** the name of what stopped a run that submitted nothing (an error code of the run), else null */
  stoppedBy: string | null;
  tx: string | null;
  /** USD spent on model calls for this attempt, a decimal string */
  costUsd: string;
}

export interface Engine {
  readonly mode: Mode;
  /** a visitor's text through the live path; the recorded engine refuses it */
  run(text: string): Promise<EngineOutput>;
  close(): Promise<void>;
}

/** Why an attempt was not run. The HTTP status is chosen by the server from this code. */
export const REFUSALS = [
  'live_off',
  'paused',
  'empty',
  'too_long',
  'busy',
  'rate_ip',
  'rate_global',
  'daily_cap',
  'llm_cap',
  'float_low',
  'float_unknown',
  'engine_failed',
] as const;
export type Refusal = (typeof REFUSALS)[number];

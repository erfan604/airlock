// The challenge page's data and the few pure rules it draws from (AIR-301). The wire types mirror challenge/src/types.ts: the console does not
// import the service, it reads the same JSON through its own origin. Amounts are decimal strings of base units and are formatted with BigInt only.
import { formatBaseUnits } from '@airlock/runtime/money';
import { wrapUntrusted } from '../components/untrusted.ts';
import type { Untrusted } from '../components/untrusted.ts';
import type { VerdictState } from '../components/verdict.ts';

export type Verdict = 'Allow' | 'Escalate' | 'Block' | 'NoAction';
export type Door = 'text' | 'key' | 'seed';

export type PaymentRow = { payee: string; asset: string; amount: string; outcome: 'ALLOW' | 'ESCALATE' | 'BLOCK'; reason: string | null; toBook: boolean };

export type Attempt = {
  seq: number;
  id: string;
  at: string;
  door: Door;
  mode: 'recorded' | 'live';
  source: string;
  label: string | null;
  inputChars: number;
  preview: string | null;
  verdict: Verdict;
  reason: string | null;
  payments: PaymentRow[];
  tx: string | null;
  stolenYocto: string;
  paidToBookYocto: string;
};

export type Board = {
  attempts: number;
  allow: number;
  escalate: number;
  block: number;
  noAction: number;
  doors: Record<Door, number>;
  stolenYocto: string;
  paidToBookYocto: string;
  heldYocto: string;
  firstAt: string | null;
  lastAt: string | null;
};

export type PublishedKey = { account: string; publicKey: string; secretKey: string | null; receiver: string; methods: string[]; allowance: string | null };

/** The owner-signed task door (b) publishes next to the key (challenge/src/publictask.ts). No secret: a signature over a bound. */
export type PublishedTask = {
  task: { task_id: string; expires_ms: number; [k: string]: unknown };
  task_sig: string;
  issuedAt: string;
  expiresAt: string;
  permits: { payee: string; asset: string; maxTotal: string; maxActions: number; agent: string; contract: string; ttlMinutes: number };
};

export type ChallengeState = {
  mode: 'recorded' | 'live';
  doorTextOpen: boolean;
  board: Board;
  limits: { perVisitor: { max: number; perSeconds: number }; global: { max: number; perSeconds: number }; dailyMax: number; maxChars: number };
  key: PublishedKey | null;
  task?: PublishedTask | null;
  /** AIR-320: the hosted copy (a static site) reads the chain itself: door one is shut and the page says why */
  hosted?: boolean;
  /** AIR-320: every task of the published file has expired; the owner publishes new ones */
  taskExpired?: boolean;
  /** AIR-320: the near-cli command that sends one request with the published key (hosted copy only) */
  command?: string | null;
  /** AIR-320: the board shows the newest part of a longer chain listing */
  truncated?: boolean;
  now: string;
};

export const EMPTY_BOARD: Board = { attempts: 0, allow: 0, escalate: 0, block: 0, noAction: 0, doors: { text: 0, key: 0, seed: 0 }, stolenYocto: '0', paidToBookYocto: '0', heldYocto: '0', firstAt: null, lastAt: null };

/** The verdict state the Door and VerdictStamp draw: Allow is the owner's own payment, Escalate is held, Block is barred, NoAction is stopped. */
export function stateOf(a: Pick<Attempt, 'verdict'>): VerdictState {
  switch (a.verdict) {
    case 'Allow':
      return 'allowed';
    case 'Escalate':
      return 'held';
    case 'Block':
      return 'blocked';
    case 'NoAction':
      return 'stopped';
  }
}

/** The reasons the gate and the run give, in plain words. A reason that is not listed shows as its own code. */
const REASONS: Record<string, string> = {
  OverTaskBound: 'The amount is above what the owner signed for this task.',
  PayeeNotInBook: 'The payee is not in the owner\'s address book.',
  UntrustedAmount: 'The amount came from outside text, so the owner is asked.',
  UntrustedTrigger: 'Outside text decided whether to pay, so the owner is asked.',
  UntrustedPayee: 'The payee came from outside text, so the owner is asked.',
  BadAmount: 'The amount in the text was not a plain number, so the run stopped.',
  BadCondition: 'The condition could not be read as a yes or no, so the run stopped.',
  NoTask: 'There was no task the owner could sign for this plan, so nothing was submitted.',
  NothingToPay: 'The agent read the text and found nothing it was asked to pay.',
  ToolError: 'A step of the plan could not complete, so the run stopped.',
  PlanRejected: 'The plan was not accepted, so nothing was submitted.',
  RunFailed: 'The run failed before it submitted anything.',
};

export const reasonWords = (reason: string | null): string => (reason === null ? '' : (Object.hasOwn(REASONS, reason) ? REASONS[reason] : undefined) ?? reason);

/** The sentence under a verdict word. Closed templates built from typed values. */
export function sentenceOf(a: Attempt): string {
  const first = a.payments[0];
  if (a.verdict === 'NoAction') return reasonWords(a.reason);
  const amount = first === undefined ? '' : `${nearText(first.amount)} to ${first.toBook ? 'a payee in the book' : 'a payee outside the book'}`;
  if (a.verdict === 'Allow') return first?.toBook === false ? `PAID ${amount}.` : `Paid ${amount}, inside the owner's caps.`;
  return `${amount}. ${reasonWords(a.reason)}`.trim();
}

const SHOWN_PLACES = 4;

/** Yocto as NEAR text for a reader: at most four decimals, truncated, thousands grouped; an amount above zero but under 0.0001 says so instead of 0. */
export function nearText(yocto: string): string {
  const v = BigInt(yocto);
  const step = 10n ** BigInt(24 - SHOWN_PLACES);
  if (v > 0n && v < step) return `less than 0.${'0'.repeat(SHOWN_PLACES - 1)}1 NEAR`;
  const [whole = '0', frac] = formatBaseUnits((v / step) * step, 24).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${frac === undefined ? grouped : `${grouped}.${frac}`} NEAR`;
}

/** Text with every decimal number cut to at most four decimals (truncated, trailing zeros dropped): for amounts the page prints as it was given them. */
export const trimDecimals = (text: string): string =>
  text.replace(/\b([0-9]+)\.([0-9]+)\b/g, (_m, whole: string, frac: string) => {
    const cut = frac.slice(0, SHOWN_PLACES).replace(/0+$/, '');
    return cut === '' ? whole : `${whole}.${cut}`;
  });

const HASH = /^[A-Za-z0-9]{20,100}$/;
export const EXPLORER = 'https://testnet.nearblocks.io/txns/';

/** The explorer link of a transaction, or null for anything that is not a transaction hash (a recorded replay has none). */
export const explorerUrl = (tx: string | null): string | null => (tx !== null && HASH.test(tx) ? `${EXPLORER}${tx}` : null);

/** `4 s ago`, `3 min ago`, `2 h ago`; a time in the future reads as now. */
export function ago(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${String(s)} s ago`;
  if (s < 3600) return `${String(Math.floor(s / 60))} min ago`;
  if (s < 86_400) return `${String(Math.floor(s / 3600))} h ago`;
  return `${String(Math.floor(s / 86_400))} d ago`;
}

/** The visitor's text as outsider text, or null: the one place a preview enters the Untrusted type on this page. */
export const previewOf = (a: Pick<Attempt, 'preview'>): Untrusted | null => wrapUntrusted(a.preview);

/** Folds one attempt into a board, the way the service does, so the page can move its counters between reads. */
export function foldBoard(b: Board, a: Attempt): Board {
  const held = a.payments.filter((p) => p.outcome === 'ESCALATE').reduce((s, p) => s + BigInt(p.amount), 0n);
  return {
    attempts: b.attempts + 1,
    allow: b.allow + (a.verdict === 'Allow' ? 1 : 0),
    escalate: b.escalate + (a.verdict === 'Escalate' ? 1 : 0),
    block: b.block + (a.verdict === 'Block' ? 1 : 0),
    noAction: b.noAction + (a.verdict === 'NoAction' ? 1 : 0),
    doors: { ...b.doors, [a.door]: b.doors[a.door] + 1 },
    stolenYocto: (BigInt(b.stolenYocto) + BigInt(a.stolenYocto)).toString(),
    paidToBookYocto: (BigInt(b.paidToBookYocto) + BigInt(a.paidToBookYocto)).toString(),
    heldYocto: (BigInt(b.heldYocto) + held).toString(),
    firstAt: b.firstAt ?? a.at,
    lastAt: a.at,
  };
}

/** Why the visitor's attempt was not run, in words for the page. The codes are the service's refusals. */
const REFUSALS: Record<string, string> = {
  live_off: 'The text door is shut: the board shows recorded attempts until the challenge goes live.',
  paused: 'The challenge is paused.',
  empty: 'Paste some text first.',
  too_long: 'That text is too long.',
  busy: 'The agent is busy with other attempts. Try again in a moment.',
  rate_ip: 'You have used your attempts for now. Try again later.',
  rate_global: 'The challenge is at its hourly limit. Try again later.',
  daily_cap: 'The challenge is at its daily limit. Try again tomorrow.',
  llm_cap: 'The challenge has used its model budget. It is closed.',
  float_low: 'The challenge float is used up for today. It is closed until tomorrow.',
  float_unknown: 'The challenge could not read its float, so it is closed for now.',
  engine_failed: 'The agent could not run that attempt. Nothing was paid.',
  hosted: 'Giving it text needs the live planner and a model key, which this hosted copy does not hold. The agent key above works here, from your own shell; the console in the repository opens this door (pnpm demo).',
};

export const refusalWords = (code: string): string => (Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined) ?? 'The attempt was not run.';

/** The source as the feed shows it: a long chain request id is shortened for display only; the log keeps the whole id. */
export function shortSource(source: string): string {
  const cs = Array.from(source);
  return cs.length <= 28 ? source : `${cs.slice(0, 18).join('')}...${cs.slice(-6).join('')}`;
}

export type ChallengeRead = { state: ChallengeState; rows: Attempt[] };
export type ReadView = { read: ChallengeRead | null; unreadable: boolean };

/** The page's read state machine (AIR-323): a good read replaces the data; a failed read keeps the last good one, or none, and is flagged. A failed read is never an empty board. */
export const settleRead = (prev: ChallengeRead | null, got: ChallengeRead | null): ReadView => (got === null ? { read: prev, unreadable: true } : { read: got, unreadable: false });

/** The feed order: newest first. */
export const newestFirst = (rows: readonly Attempt[]): Attempt[] => [...rows].sort((a, b) => b.seq - a.seq);

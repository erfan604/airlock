// The approval card's model (AIR-181): everything the card shows, built only from stored contract fields (`RequestView`, the
// ledgers, the asset and the book entry) plus the one typed evidence object. The title, the reason sentence, the five arguments and
// the cap line never contain text an outsider wrote; the sender and the snippet travel through the model as opaque `Untrusted`
// values and are drawn by `Specimen` only. Amounts are BigInt base units end to end and are shown through `formatBaseUnits`.
import { bitsToLabels, untrustedChannels } from '@airlock/runtime/dsl';
import type { BookEntryJson, ChannelName, LabelName, LookalikeResult } from '@airlock/runtime/dsl';
import { formatBaseUnits } from '@airlock/runtime/money';
import type { AssetEntryViewJson, LedgersView, RequestView } from '@airlock/runtime/chain-types';
import type { Untrusted } from '../components/untrusted.ts';
import type { BookLabel, CardEvidence, CounterpartyLine } from './evidence.ts';
import { bookLabelOf, channelsOfMasks } from './evidence.ts';
import { FORCING_MIN_AMOUNT, forcingLabel, forcingRequired, forcingTarget, lookalikeOf } from './forcing.ts';
import { magnitudeText } from './magnitude.ts';
import type { MagnitudeText } from './magnitude.ts';

/** `approve(id, to, asset, amount, why, book)`: `id` the decimal pending number, the other five the readable values. */
export type ApproveArgs = { id: string; to: string; asset: string; amount: string; why: string; book: string };

/** `approve_and_remember(id, to, asset, amount, why, book, cap, daily_limit, label)`: the five card values plus the owner's limits in base units (decimal strings). */
export type RememberArgs = ApproveArgs & { cap: string; daily_limit: string; label: string };

export class CardError extends Error {
  readonly code: 'NotApprovable';
  constructor(code: 'NotApprovable') {
    super(`approval card refused: ${code}`);
    this.name = 'CardError';
    this.code = code;
  }
}

/**
 * The single code path that feeds both the card and the wallet call. Every value is the stored one: the pending number, the payee
 * key, the registry symbol and decimal text of `display`, the reason code and the book status. A view that is not a complete escalation
 * (no pending number, no readable values, a tombstone) never yields arguments, so nothing half-empty can reach a wallet.
 */
export function approveArgs(v: RequestView): ApproveArgs {
  if (v.tombstone === true || v.id === null || v.display === null || v.reason === null || v.book_status === null) throw new CardError('NotApprovable');
  return Object.freeze({ id: v.id, to: v.payee, asset: v.display.asset_symbol, amount: v.display.amount_decimal, why: v.reason, book: v.book_status });
}

/** The card title as one template: the video script checker (SCREEN-FMT) searches the source for exactly this text. */
export const CARD_TITLE_TEMPLATE = 'Pay {amount} {symbol} to {to}?';

/** Fills `CARD_TITLE_TEMPLATE` from the stored arguments; a value is inserted once and never re-scanned for placeholders. */
export function cardTitle(args: ApproveArgs): string {
  const values: Record<string, string> = { amount: args.amount, symbol: args.asset, to: args.to };
  return CARD_TITLE_TEMPLATE.replace(/\{(amount|symbol|to)\}/g, (_m, k: string) => values[k] ?? '');
}

export type RowName = 'TO' | 'AMOUNT' | 'BECAUSE';
export const ROW_ORDER: readonly RowName[] = ['TO', 'AMOUNT', 'BECAUSE'];

export type CardRow = { name: RowName; value: string; seals: readonly LabelName[] };

export type CapLine = {
  binds: 'CAP' | 'BUDGET LEFT';
  /** `5 NEAR`: the limit as the sentences quote it */
  limitText: string;
  /** `CAP 5 NEAR` or `BUDGET LEFT 1.6 NEAR` */
  limitLabel: string;
  /** `4.4 NEAR over`, or null when the amount is within the limit */
  overLabel: string | null;
  /** Positions on a 0 to 100 scale, one decimal, for the drawing. */
  amountAt: string;
  limitAt: string;
  /** The line read aloud. */
  description: string;
};

/** The diff against the nearest book key, for a payee that is not in the book (AIR-190). */
export type DiffModel = { result: LookalikeResult | null; label: BookLabel | null };

/** The forcing step of the confirm sheet (AIR-190): shown when `required`, satisfied by typing `target` or the full key. */
export type ForcingModel = { required: boolean; target: string; label: string };

/** What the card needs besides the request: the keys and labels of the book rows, and the forcing minimum. */
export type CardExtras = { bookKeys?: readonly string[]; bookLabels?: Readonly<Record<string, string>>; forcingMinAmount?: bigint };

export type SourceChip = { row: RowName; from: string | null; sender: Untrusted | null; age: string | null };

export type CardModel = {
  /** The pending number as text. */
  no: string;
  requestId: string;
  title: string;
  sheetTitle: string;
  approveLabel: string;
  ref: string;
  reason: string;
  sentence: string;
  /** The row that caused the hold, or null for a reason outside the table. */
  offender: RowName | null;
  /** Always TO, AMOUNT, BECAUSE: `Manifest` moves the offender. */
  rows: readonly CardRow[];
  chip: SourceChip | null;
  cap: CapLine | null;
  sender: Untrusted | null;
  snippet: Untrusted | null;
  /** The channel named in the specimen caption. */
  specimenChannel: ChannelName;
  ageText: string | null;
  args: ApproveArgs;
  /** Set when `book_status` is `new`. */
  diff: DiffModel | null;
  magnitude: MagnitudeText;
  forcing: ForcingModel | null;
  /** The recipient label says Book but the payee is not in the book: the Book seal is dropped and the card says so (AIR-190). */
  labelMismatch: boolean;
  /** AIR-304: the runtime's counterparty note for a payee outside the book, or null. A hint for the owner, never a control. */
  counterparty: CounterpartyLine | null;
};

// ---- reasons (the closed table of AIR-181) ----

const OFFENDERS: ReadonlyMap<string, RowName> = new Map<string, RowName>([
  ['UntrustedAmount', 'AMOUNT'],
  ['OverTaskBound', 'AMOUNT'],
  ['OverPayeeLimit', 'AMOUNT'],
  ['UntrustedRecipient', 'TO'],
  ['NewRecipient', 'TO'],
  ['OutsideTask', 'TO'],
  ['UntrustedTrigger', 'BECAUSE'],
]);

/** Channel names as they read after "from": a closed table, never runtime text. */
const CHANNEL_PHRASE: Record<ChannelName, string> = {
  email: 'email',
  web: 'the web',
  file: 'a file',
  chat: 'chat',
  social: 'social media',
  tool_output: 'a tool result',
  memory: 'memory',
  quarantine: 'the reader',
  payment_protocol: 'a payment response',
  other: 'pasted text',
  unknown: 'an unknown source',
};

/** `email`, `email and the web`, `a, b and c`. The reader is always present on extracted values, so it is named only when nothing else is. */
export function channelPhrase(channels: readonly ChannelName[]): string {
  const named = channels.length > 1 ? channels.filter((c) => c !== 'quarantine') : channels;
  const words = named.map((c) => CHANNEL_PHRASE[c]);
  if (words.length === 0) return 'an unknown source';
  if (words.length === 1) return words[0] as string;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const CODE_CHARS = /[^A-Za-z:]/g;

/** A code outside the table is shown filtered to letters and colons, 40 characters. */
function fallbackSentence(code: string): string {
  const filtered = code.replace(CODE_CHARS, '').slice(0, 40);
  return filtered === '' ? 'Held for your approval.' : `Held for your approval (${filtered}).`;
}

// ---- masks, seals, channels ----

const UNKNOWN_BIT = 0x8000;

/** The seals of a mask in bit order. Bit 15 cannot be named: it is drawn as the outside seal OTHER, which keeps the tape frame. */
export function sealsOf(mask: number): LabelName[] {
  const seals = bitsToLabels(mask & ~UNKNOWN_BIT);
  return (mask & UNKNOWN_BIT) !== 0 ? [...seals, 'Untrusted:other'] : seals;
}

function becauseValue(pc: number, channels: readonly ChannelName[]): string {
  if (pc === 0) return 'No recorded source';
  if (channels.length > 0) return `Content from ${channelPhrase(channels)}`;
  return 'Your task, book or policy';
}

// ---- age ----

/** `just now`, `2 min ago`, `3 h ago`, `2 d ago`: whole units, truncated, from two millisecond counts. Null when the record has no time. */
export function ageText(createdMs: bigint, nowMs: bigint): string | null {
  if (createdMs === 0n) return null;
  const seconds = (nowMs - createdMs) / 1000n;
  if (seconds < 60n) return 'just now';
  const minutes = seconds / 60n;
  if (minutes < 60n) return `${minutes} min ago`;
  const hours = minutes / 60n;
  if (hours < 24n) return `${hours} h ago`;
  return `${hours / 24n} d ago`;
}

// ---- the cap line ----

const TENTHS = 1000n;

/** `part` of `whole` as a percentage with one decimal, in BigInt. */
function percent(part: bigint, whole: bigint): string {
  const t = whole === 0n ? 0n : (part * TENTHS) / whole;
  return `${t / 10n}.${t % 10n}`;
}

/**
 * Cap from the book entry, remaining untrusted budget from the ledgers, decimals from the asset. The limit is the lower of the two
 * and `CAP` wins a tie; a payee with no cap is limited by the budget alone. No line for a payee that is not in the book.
 */
function capLine(v: RequestView, symbol: string, l: LedgersView, a: AssetEntryViewJson, book: BookEntryJson | null): CapLine | null {
  if (book === null || v.book_status === 'new') return null;
  const amount = BigInt(v.amount);
  const left = BigInt(l.payee_untrusted_day.remaining);
  const cap = book.cap === null ? null : BigInt(book.cap);
  const capBinds = cap !== null && cap <= left;
  const limit = capBinds ? cap : left;
  const binds = capBinds ? 'CAP' : 'BUDGET LEFT';
  const text = (n: bigint): string => `${formatBaseUnits(n, a.decimals)} ${symbol}`;
  const limitLabel = `${binds} ${text(limit)}`;
  const over = amount > limit ? amount - limit : null;
  const overLabel = over === null ? null : `${text(over)} over`;
  const scale = amount > limit ? amount : limit;
  return {
    binds,
    limitText: text(limit),
    limitLabel,
    overLabel,
    amountAt: percent(amount, scale),
    limitAt: percent(limit, scale),
    description: `Amount ${text(amount)} against ${limitLabel}, ${overLabel ?? 'within the limit'}`,
  };
}

// ---- the model ----

function sentenceFor(
  reason: string,
  fill: { payee: string; channel: (row: RowName) => string; cap: CapLine | null },
): string {
  switch (reason) {
    case 'OutsideTask':
      return 'This payee is not in the task you signed.';
    case 'OverTaskBound':
      return 'This amount is more than is left in the task you signed.';
    case 'UntrustedTrigger':
      return `Whether to pay was decided by content read from ${fill.channel('BECAUSE')}.`;
    case 'UntrustedRecipient':
      return `The address was not set by you, your book or your policy (${fill.channel('TO')}).`;
    case 'NewRecipient':
      return 'This address is not in your book.';
    case 'OverPayeeLimit':
      return `This amount is over the daily limit you set for ${fill.payee}.`;
    case 'UntrustedAmount':
      if (fill.cap !== null) {
        return fill.cap.binds === 'CAP'
          ? `The amount came from ${fill.channel('AMOUNT')} and is over the ${fill.cap.limitText} cap you set for ${fill.payee}.`
          : `The amount came from ${fill.channel('AMOUNT')} and ${fill.payee} has only ${fill.cap.limitText} left of its daily budget for outside amounts.`;
      }
      return fallbackSentence(reason);
    default:
      return fallbackSentence(reason);
  }
}

/**
 * `nowMs` is the clock for "2 min ago"; it is a parameter so a render is repeatable. Throws `CardError` for a view that cannot be
 * approved, and a `SyntaxError` from `BigInt` for an amount that is not decimal digits: the card then shows nothing to approve.
 */
export function buildCardModel(
  v: RequestView,
  e: CardEvidence,
  l: LedgersView,
  a: AssetEntryViewJson,
  book: BookEntryJson | null,
  nowMs: bigint,
  extras: CardExtras = {},
): CardModel {
  const args = approveArgs(v);
  const bookKeys = extras.bookKeys ?? [];
  const amount = BigInt(v.amount);
  const isNew = v.book_status === 'new';
  const found = isNew ? lookalikeOf(v.payee, bookKeys) : null;
  const masks = { TO: v.labels.recipient, AMOUNT: v.labels.amount, BECAUSE: v.labels.pc } as const;
  const rowChannels = (row: RowName): ChannelName[] => untrustedChannels(masks[row]);
  const channel = (row: RowName): string => channelPhrase(rowChannels(row));

  const cap = capLine(v, args.asset, l, a, book);
  const age = ageText(BigInt(v.created_ms), nowMs);
  const offender = OFFENDERS.get(args.why) ?? null;

  const union = e.channels.length > 0 ? e.channels : channelsOfMasks(v.labels);
  const named = union.filter((c) => c !== 'quarantine');
  const specimenChannel: ChannelName = named[0] ?? union[0] ?? 'unknown';

  let chip: SourceChip | null = null;
  if (offender !== null) {
    const channels = rowChannels(offender);
    const from = channels.length > 0 ? channelPhrase(channels) : null;
    if (from !== null || e.sender !== null) chip = { row: offender, from, sender: e.sender, age };
  }

  const outsideBook = isNew || (bookKeys.length > 0 && !bookKeys.includes(v.payee));
  const claimsBook = bitsToLabels(v.labels.recipient & ~UNKNOWN_BIT).includes('Book');
  const labelMismatch = outsideBook && claimsBook;
  const toSeals = labelMismatch ? sealsOf(v.labels.recipient).filter((l) => l !== 'Book') : sealsOf(v.labels.recipient);
  const rows: CardRow[] = [
    { name: 'TO', value: v.payee, seals: toSeals },
    { name: 'AMOUNT', value: `${args.amount} ${args.asset}`, seals: sealsOf(v.labels.amount) },
    { name: 'BECAUSE', value: becauseValue(v.labels.pc, rowChannels('BECAUSE')), seals: sealsOf(v.labels.pc) },
  ];
  return Object.freeze<CardModel>({
    no: args.id,
    requestId: v.request_id,
    title: cardTitle(args),
    sheetTitle: `Approve ${args.amount} ${args.asset} to ${args.to}?`,
    approveLabel: `Approve ${args.amount} ${args.asset}`,
    ref: `Request #${args.id}`,
    reason: args.why,
    sentence: sentenceFor(args.why, { payee: v.payee, channel, cap }),
    offender,
    rows,
    chip,
    cap,
    sender: e.sender,
    snippet: e.snippet,
    specimenChannel,
    ageText: age,
    args,
    diff: isNew ? { result: found, label: found === null ? null : bookLabelOf(extras.bookLabels ?? {}, found.nearest) } : null,
    magnitude: magnitudeText(amount, l, book, args.asset, a.decimals),
    labelMismatch,
    counterparty: e.counterparty ?? null,
    forcing: forcingRequired(v, amount, extras.forcingMinAmount ?? FORCING_MIN_AMOUNT, bookKeys)
      ? { required: true, target: forcingTarget(v.payee), label: forcingLabel(v.payee) }
      : null,
  });
}

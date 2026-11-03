// The one typed evidence object of the approval card (AIR-181). The card is built from stored contract fields plus this: the channels
// the three stored masks name, and the two strings the runtime served for the request (`GET /api/evidence/:no`, AIR-161): the sender and
// the snippet. Both are text an outsider wrote, so they enter the `Untrusted` type here and nowhere else in the card (this file is one
// of the three the lint rule lets call `wrapUntrusted`). Anything that is not a string becomes null: an outsider's number, object or null
// never turns into display text.
import { untrustedChannels } from '@airlock/runtime/dsl';
import type { ChannelName } from '@airlock/runtime/dsl';
import type { CounterpartyNote, CounterpartyReason } from '@airlock/runtime/counterparty';
import { wrapUntrusted } from '../components/untrusted.ts';
import type { Untrusted } from '../components/untrusted.ts';

/** The three label masks of a stored request (`RequestView.labels`). */
export type MaskTriple = { recipient: number; amount: number; pc: number };

/** AIR-304: the runtime's counterparty note, as a closed code and the fixed sentence the card shows for it. Never text from outside. */
export type CounterpartyLine = { reason: CounterpartyReason; sentence: string };

const COUNTERPARTY_SENTENCES: Readonly<Record<CounterpartyNote['detail'], string>> = {
  account_absent: 'New payee: this account does not exist on the chain yet.',
  account_recent: 'New payee: this account is less than 7 days old.',
  no_history: 'New payee: this address has never sent or received anything on this chain.',
  lookup_failed: 'AIRLOCK could not check this payee\'s history. Treat it as new.',
};

/**
 * The note of `GET /api/evidence/:no`, if any. A note that is not exactly one of the runtime's codes still shows as unchecked: an unreadable
 * note never reads as an established payee.
 */
export function counterpartyOf(raw: unknown): CounterpartyLine | null {
  if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, 'counterparty')) return null;
  const note = (raw as { counterparty?: unknown }).counterparty;
  if (note === null || note === undefined) return null;
  const reason = typeof note === 'object' ? own(note, 'reason') : undefined;
  const detail = typeof note === 'object' ? own(note, 'detail') : undefined;
  const valid = (reason === 'counterparty_new' && (detail === 'account_absent' || detail === 'account_recent' || detail === 'no_history')) || (reason === 'counterparty_unverified' && detail === 'lookup_failed');
  return valid ? { reason, sentence: COUNTERPARTY_SENTENCES[detail] } : { reason: 'counterparty_unverified', sentence: COUNTERPARTY_SENTENCES.lookup_failed };
}

export type CardEvidence = {
  /** The untrusted channels of the three masks together, in bit order, `unknown` last when bit 15 is set. */
  channels: ChannelName[];
  sender: Untrusted | null;
  snippet: Untrusted | null;
  /** AIR-304: set only for a payee outside the book that the runtime looked up. */
  counterparty?: CounterpartyLine | null;
};

/** The channels named by the three stored masks together, in bit order. Throws for a mask outside 16 bits. */
export function channelsOfMasks(m: MaskTriple): ChannelName[] {
  return untrustedChannels(m.recipient | m.amount | m.pc);
}

const own = (o: object, key: string): unknown => (Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined);

/**
 * `raw` is the body of `GET /api/evidence/:no` (a 404 or a failed read is `null` or `undefined`: no sender and no snippet), `labels` the
 * `labels` of the same `RequestView`. Only own properties are read, so nothing inherited can supply text.
 */
export function parseEvidence(raw: unknown, labels?: MaskTriple): CardEvidence {
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null;
  return {
    channels: labels ? channelsOfMasks(labels) : [],
    sender: body ? wrapUntrusted(own(body, 'sender')) : null,
    snippet: body ? wrapUntrusted(own(body, 'snippet')) : null,
  };
}

/** A book label as the diff sentence shows it: a plain `[a-z0-9 ._-]` string is typed text, anything else is outsider-shaped text for `Specimen`. */
export type BookLabel = { kind: 'plain'; text: string } | { kind: 'untrusted'; text: Untrusted };

const PLAIN_LABEL = /^[a-z0-9 ._-]+$/;

/** The label of the book row `key`, or null when the book gave none (own properties only). */
export function bookLabelOf(labels: Readonly<Record<string, string>>, key: string): BookLabel | null {
  const raw = own(labels, key);
  if (typeof raw !== 'string') return null;
  if (PLAIN_LABEL.test(raw)) return { kind: 'plain', text: raw };
  const wrapped = wrapUntrusted(raw);
  return wrapped === null ? null : { kind: 'untrusted', text: wrapped };
}

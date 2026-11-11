// AIR-356: "Rob it yourself". The visitor's browser signs one real `submit_batch` on the try card with a published function-call key and shows
// what the contract answered. Pure parts here (the request a choice becomes, the slot, the answer), the sending through chain/tx.ts. Guards: the
// page signs only as the try agent named in the public file and refuses a file that names any airlock-credit account (parseTryPublic does, and
// `send` checks again); typed text never goes on chain, only the payee and amount it yields, both validated; amounts are decimal strings and
// BigInt. The contract decides every outcome; the page invents none.
import { RpcError, rpcView } from '../chain/rpc.ts';
import type { RpcConfig } from '../chain/rpc.ts';
import { functionCall, keyFromSecret, successValue } from '../chain/tx.ts';
import { unshownText } from '../components/chainText.ts';
import { parseNear } from '../credit/model.ts';
import presets from '../../fixtures/rob-presets.json' with { type: 'json' };
import type { TryPublic, TryTask } from './tryPublic.ts';

export type Preset = { id: string; title: string; line: string; payee?: string; asset?: string; amount?: string; amountRaw?: string; honest?: boolean };
export const PRESETS: Preset[] = presets.presets;

/** Owner, Book and Untrusted:web label bits (contracts/airlock-verdict/src/labels.rs). */
export const OWNER = 1;
export const WEB = 1 << 6;
const ZERO_HEX = '0'.repeat(64);
export const SUBMIT_TGAS = 100n;

export type Choice = { kind: 'preset'; id: string } | { kind: 'own'; payee: string; amount: string };
export type Wish = { payee: string; asset: string; amount: string; honest: boolean };

const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;

/** A typed payee as a NEAR payee key: `alice` and `alice.testnet` both name `near:alice.testnet`; anything else is refused. */
export function payeeOf(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/^near:/, '');
  if (!ACCOUNT.test(t)) return null;
  const id = t.includes('.') ? t : `${t}.testnet`;
  return id.length <= 64 && ACCOUNT.test(id) ? `near:${id}` : null;
}

/** A typed NEAR amount as yocto: a plain decimal above 0 with at most 24 places and at most 1,000 NEAR; anything else is refused. */
export function amountOf(text: string): string | null {
  const v = parseNear(text.trim());
  return v === null || v <= 0n || v > 1000n * 10n ** 24n ? null : v.toString();
}

/** What a choice asks the card to pay. The honest choice is the owner's own request; every other one is what a hijacked agent would send. */
export function wishOf(choice: Choice, pub: TryPublic): Wish | { refuse: string } {
  if (choice.kind === 'own') {
    const payee = payeeOf(choice.payee);
    const amount = amountOf(choice.amount);
    if (payee === null) return { refuse: 'Type an account name, like alice or alice.near.' };
    if (amount === null) return { refuse: 'Type an amount in NEAR, like 0.005.' };
    return { payee, asset: 'near', amount, honest: false };
  }
  const p = PRESETS.find((x) => x.id === choice.id);
  if (p === undefined) return { refuse: 'Pick one of the attacks.' };
  if (p.honest === true) return { payee: pub.shop.payee, asset: 'near', amount: pub.honestAmount, honest: true };
  const payee = p.payee === 'shop' ? pub.shop.payee : (p.payee ?? '');
  const amount = p.amountRaw ?? (p.amount === undefined ? null : amountOf(p.amount));
  if (amount === null || payee === '') return { refuse: 'This attack is not set up right.' };
  return { payee, asset: p.asset ?? 'near', amount, honest: false };
}

/**
 * The `submit_batch` arguments of one request. Typed or attack text: all three labels Untrusted:web, the strongest honest description of where
 * a hijacked agent's values came from (the page does not lie to the contract to force a reason). The honest request: Owner labels. A payee
 * that is the booked shop carries the shop's public book proof. No `hints.origin`. `labels` is given only by the bench replay
 * (scripts/try-replay.ts, AIR-360), which sends the label masks each bench run recorded; the page never passes it.
 */
export type LabelBits = { recipient: number; amount: number; pc: number };
export function batchArgs(w: Wish, pub: TryPublic, task: TryTask, actionIndex: number, labels?: LabelBits): Record<string, unknown> {
  const label = w.honest ? OWNER : WEB;
  const req: Record<string, unknown> = {
    task_id: task.task.task_id,
    action_index: actionIndex,
    asset: w.asset,
    payee: w.payee,
    amount: w.amount,
    labels: labels === undefined ? { recipient: label, amount: label, pc: label } : { recipient: labels.recipient, amount: labels.amount, pc: labels.pc },
    evm: null,
    hints: { plan_hash: task.task.plan_sha256, trace_digest: ZERO_HEX },
  };
  if (w.payee === pub.shop.payee) req['book'] = pub.shop.proof;
  return { reqs: [req], task: task.task, task_sig: task.task_sig };
}

export type Slot = { task: TryTask; index: number };

/** A request id not used yet: a random live task and action index, checked with `get_request`; null after five used ids. */
export async function pickSlot(pub: TryPublic, view: (method: string, args: object) => Promise<unknown>, random: () => number, nowMs: number): Promise<Slot | null> {
  const live = pub.tasks.filter((t) => t.task.expires_ms > nowMs + 60_000);
  if (live.length === 0) return null;
  for (let i = 0; i < 5; i++) {
    const task = live[Math.floor(random() * live.length)] as TryTask;
    const index = Math.floor(random() * task.task.max_actions);
    const used = await view('get_request', { id: `${task.task_hash}:${String(index)}` });
    if (used === null) return { task, index };
  }
  return null;
}

export type Answer = { kind: 'paid' | 'held' | 'blocked'; reason: string | null; requestId: string };

/** The contract's answer to the one request: [{request_id, outcome: allowed | escalated | blocked, reason}]. Anything else is null. */
export function answerOf(outcome: unknown): Answer | null {
  const v = successValue(outcome);
  const a = Array.isArray(v) ? v[0] : undefined;
  if (typeof a !== 'object' || a === null) return null;
  const o = a as Record<string, unknown>;
  const kind = o['outcome'] === 'allowed' ? 'paid' : o['outcome'] === 'escalated' ? 'held' : o['outcome'] === 'blocked' ? 'blocked' : null;
  if (kind === null || typeof o['request_id'] !== 'string') return null;
  return { kind, reason: typeof o['reason'] === 'string' ? o['reason'] : null, requestId: o['request_id'] };
}

/** The contract's failure message of a transaction that reverted (a used slot, a malformed request), or null when it did not fail. */
export function failureOf(outcome: unknown): string | null {
  const status = typeof outcome === 'object' && outcome !== null ? (outcome as { status?: unknown }).status : undefined;
  if (typeof status !== 'object' || status === null || !('Failure' in status)) return null;
  const text = JSON.stringify((status as { Failure: unknown }).Failure);
  const m = /"ExecutionError":"([^"]{1,300})"/.exec(text);
  return m?.[1] ?? 'the contract refused the call';
}

/** `grief`: the card could not answer because a published key was used to spend its gas money or every signed slot (live/robCheck.ts). */
export type Sent = { kind: 'answer'; answer: Answer; tx: string; ms: number } | { kind: 'failed'; why: string; tx: string | null; ms: number } | { kind: 'unavailable'; why: string; grief?: 'gas' | 'slots' };

export type SendDeps = { rpc: RpcConfig; random: () => number; now: () => number };

/** Picks a slot and a key, signs and sends. A nonce clash is tried once more with another key; a used request id once more with another slot. */
export async function send(pub: TryPublic, w: Wish, deps: SendDeps): Promise<Sent> {
  if (pub.agent.endsWith('airlock-credit-c1108d.testnet') || pub.policy.endsWith('airlock-credit-c1108d.testnet') || /airlock-credit/.test(pub.agent)) {
    return { kind: 'unavailable', why: 'The public file names a credit account, so this page will not sign anything.' };
  }
  const t0 = deps.now();
  const view = rpcView({ contractId: pub.policy, ...deps.rpc });
  let keyTries = 0;
  let slotTries = 0;
  let lastKey = -1;
  for (;;) {
    const slot = await pickSlot(pub, view, deps.random, deps.now());
    if (slot === null) return { kind: 'unavailable', why: 'Every attempt slot the owner signed for is used or expired. The owner publishes new ones.', grief: 'slots' };
    let k = Math.floor(deps.random() * pub.keys.length);
    if (k === lastKey && pub.keys.length > 1) k = (k + 1) % pub.keys.length;
    lastKey = k;
    const secret = pub.keys[k]?.secretKey;
    if (secret === undefined) return { kind: 'unavailable', why: 'The public file holds no key.' };
    const key = await keyFromSecret(secret);
    try {
      const r = await functionCall(deps.rpc, key, { signerId: pub.agent, receiverId: pub.policy, method: 'submit_batch', args: batchArgs(w, pub, slot.task, slot.index), gas: SUBMIT_TGAS * 10n ** 12n, deposit: 0n, random: deps.random });
      const failed = failureOf(r.outcome);
      if (failed !== null) {
        if (/used|already/i.test(failed) && slotTries === 0) {
          slotTries += 1;
          continue;
        }
        return { kind: 'failed', why: failed, tx: r.hash, ms: deps.now() - t0 };
      }
      const answer = answerOf(r.outcome);
      if (answer === null) return { kind: 'failed', why: 'the contract answered something this page cannot read', tx: r.hash, ms: deps.now() - t0 };
      return { kind: 'answer', answer, tx: r.hash, ms: deps.now() - t0 };
    } catch (e) {
      const name = e instanceof RpcError ? `${e.message} ${e.causeName ?? ''}` : '';
      // the agent's gas money or a key's allowance is used up: anyone holding the published keys can spend it, so the page says so plainly
      if (e instanceof RpcError && e.detail.some((d) => d === 'NotEnoughBalance' || d === 'NotEnoughAllowance' || d === 'LackBalanceForState')) {
        return { kind: 'unavailable', why: 'The practice agent has used up the gas money it pays for each attempt. The team tops it up every few minutes, within a daily limit.', grief: 'gas' };
      }
      // a nonce clash comes back as INVALID_TRANSACTION (the node's InvalidNonce); retried once with another key and a fresh nonce
      if ((e instanceof RpcError ? e.detail.includes('InvalidNonce') || /InvalidNonce/i.test(name) || (/INVALID_TRANSACTION/i.test(name) && e.detail.length === 0) : false) && keyTries === 0) {
        keyTries += 1;
        continue;
      }
      return { kind: 'unavailable', why: e instanceof RpcError ? 'The network refused the transaction just now. Try again in a moment.' : 'The network could not be reached just now. Try again in a moment.' };
    }
  }
}

/**
 * One plain sentence per reason the practice card can give (the gate's rules, contracts/airlock-verdict/src/lib.rs `verdict`, first match wins),
 * shown with the contract's code as secondary text. The page labels every value of an attack as outside text, so the trigger rule (rule 7)
 * answers before the payee and amount rules (8 to 11) whenever the earlier rules pass: that is why a bigger amount to the booked shop comes back
 * UntrustedTrigger, not as an amount reason.
 */
export const REASON_WORDS: Record<string, string> = {
  OutsideTask: 'The owner signed ahead of time for the payments this card may make, and this one is not among them.',
  OverTaskBound: 'The amount is more than what is left of what the owner signed for.',
  UntrustedTrigger: 'Outside text, not the owner, started this payment. The contract checks who started a payment before it looks at the payee or the amount, so this rule holds it whatever the payee or amount.',
  UntrustedRecipient: 'The payee came from outside text, not from the owner or the owner\'s book.',
  NewRecipient: 'The payee is not in the owner\'s book.',
  UntrustedAmount: 'The amount came from outside text, and the shop has no cap that allows it.',
  AmountOutOfBounds: 'The amount is above the most this card may pay at once{hard}.',
  DailyLimit: 'The card has already paid its limit{daily} for today. It pays again after midnight UTC.',
  UnknownAsset: 'The owner never allowed this coin on the card.',
  PendingFull: 'The queue of {pending} waiting for the owner is full, so the card takes no new hold until some expire. Try again in a minute or two.',
  OverPayeeLimit: 'The shop has already been paid its daily limit.',
  BookLabelNotInBook: 'The request claims a book entry that does not exist.',
  MissingProvenance: 'The request does not say where its values came from.',
  Paused: 'The owner has paused the card.',
};

/** The same reasons in a few words, for the rows of the board. */
export const REASON_SHORT: Record<string, string> = {
  OutsideTask: 'not a payment the owner signed for',
  OverTaskBound: 'more than the owner signed for',
  UntrustedTrigger: 'started by outside text',
  UntrustedRecipient: 'payee from outside text',
  NewRecipient: 'payee not in the book',
  UntrustedAmount: 'amount from outside text',
  AmountOutOfBounds: 'over the most at once',
  DailyLimit: 'daily limit reached',
  UnknownAsset: 'coin not allowed',
  PendingFull: 'queue full',
  OverPayeeLimit: 'shop paid its limit',
  Paused: 'card paused',
};

const lookup = (m: Record<string, string>, code: string | null): string => (code === null ? '' : (Object.hasOwn(m, code) ? m[code] : undefined) ?? unshownText(code) ?? code);

/** The card's limits as the words print them, read from its contract (live/robCheck.ts readLimits) or the state file; null leaves the numbers out. */
export type LimitWords = { hardCap: string; dailyCap: string; maxPending: number | null } | null;

/** The reason in words, the card's own numbers filled in when they are known. */
export const reasonWords = (code: string | null, lim: LimitWords = null): string =>
  lookup(REASON_WORDS, code)
    .replace('{hard}', lim === null ? '' : `, ${nearWords(lim.hardCap)}`)
    .replace('{daily}', lim === null ? '' : ` of ${nearWords(lim.dailyCap)}`)
    .replace('{pending}', lim === null || lim.maxPending === null ? 'requests' : `${String(lim.maxPending)} requests`);

/** Yocto as NEAR with no trailing zeros (BigInt only). */
export function nearWords(yocto: string): string {
  const v = BigInt(yocto);
  const y = 10n ** 24n;
  const frac = (v % y).toString().padStart(24, '0').replace(/0+$/, '');
  return `${(v / y).toString()}${frac === '' ? '' : `.${frac}`} NEAR`;
}
export const reasonShort = (code: string | null): string => lookup(REASON_SHORT, code);

/** A call the contract turned down, in a plain sentence: a reason code inside its message is said in words; anything else is quoted. */
export function failureWords(why: string, lim: LimitWords = null): { words: string; code: string | null } {
  const code = Object.keys(REASON_WORDS).find((c) => new RegExp(`\\b${c}\\b`).test(why)) ?? null;
  if (code !== null) return { words: reasonWords(code, lim), code };
  if (/used|already/i.test(why)) return { words: 'Two attempts took the same signed slot at once. Send it again; the page picks another slot.', code: null };
  return { words: `The contract turned the call down before deciding, with the message: ${why}.`, code: null };
}

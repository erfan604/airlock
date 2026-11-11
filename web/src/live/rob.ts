// AIR-356: "Rob it yourself". The visitor's browser signs one real `submit_batch` on the try card with a published function-call key and shows
// what the contract answered. Pure parts here (the request a choice becomes, the slot, the answer), the sending through chain/tx.ts. Guards: the
// page signs only as the try agent named in the public file and refuses a file that names any airlock-credit account (parseTryPublic does, and
// `send` checks again); typed text never goes on chain, only the payee and amount it yields, both validated; amounts are decimal strings and
// BigInt. The contract decides every outcome; the page invents none.
import { RpcError, rpcView } from '../chain/rpc.ts';
import type { RpcConfig } from '../chain/rpc.ts';
import { functionCall, keyFromSecret, successValue } from '../chain/tx.ts';
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

export type Sent = { kind: 'answer'; answer: Answer; tx: string; ms: number } | { kind: 'failed'; why: string; tx: string | null; ms: number } | { kind: 'unavailable'; why: string };

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
    if (slot === null) return { kind: 'unavailable', why: 'Every attempt slot the owner signed for is used or expired. The owner publishes new ones.' };
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
      // a nonce clash comes back as INVALID_TRANSACTION (the node's InvalidNonce); retried once with another key and a fresh nonce
      if (/INVALID_TRANSACTION|InvalidNonce/i.test(name) && keyTries === 0) {
        keyTries += 1;
        continue;
      }
      return { kind: 'unavailable', why: e instanceof RpcError ? 'The network refused the transaction just now. Try again in a moment.' : 'The network could not be reached just now. Try again in a moment.' };
    }
  }
}

/** One plain sentence per reason the try card gives; the contract's code is shown beside it. */
export const REASON_WORDS: Record<string, string> = {
  OutsideTask: 'this payee is not in the task the owner signed, so the owner is asked',
  UntrustedTrigger: 'the decision to pay came from outside text, not from the owner, so the owner is asked',
  AmountOutOfBounds: 'the amount is above the most this card may ever pay at once (0.01 NEAR)',
  UnknownAsset: 'the owner never allowed this coin on the card',
  PendingFull: 'fifty requests are already waiting for the owner, so the card takes no more holds until they expire',
  DailyLimit: "the card has paid today's 0.05 NEAR of honest payments",
  OverTaskBound: 'the amount is above what is left of what the owner signed for',
  UntrustedRecipient: 'the payee came from outside text',
  NewRecipient: 'the payee is not in the owner\'s book',
  UntrustedAmount: 'the amount came from outside text and the shop has no cap for that',
  BookLabelNotInBook: 'the request claims a book entry that does not exist',
  MissingProvenance: 'the request does not say where its values came from',
};

export const reasonWords = (code: string | null): string => (code === null ? '' : (Object.hasOwn(REASON_WORDS, code) ? REASON_WORDS[code] : undefined) ?? code);

// AIR-355: strict mode on the credit card. Strict is a book whose every entry has no cap for amounts read from text (`cap: null`): the
// verdict then holds every such amount for the owner at any size, and an amount the owner's task states is still allowed. The card stores
// only the book's root, so the change is one owner call, `book_set_root(expected_old, new_root)`. This file holds the strict copy of a
// vault (a new vault; the old one is never changed), the plan a dry run prints, the one live call with its refusals, and the read-only
// verification. No key is read here, and no payee or salt is ever printed.
import { ActionRequest, OwnerTask, TASK_TAG, labelsToBits, sha256Hex } from '../dsl/index.ts';
import type { WireProof } from '../vault/index.ts';
import { Vault } from '../vault/index.ts';

/** The env flag `--live` needs: without it the owner call is never sent. */
export const STRICT_FLAG = 'CREDIT_STRICT_LIVE_OK';

/** A request as `submit_batch` and `preview` take it: the action request with the payee's book proof. */
export type WireRequest = ActionRequest & { book: WireProof | null };

export type StrictIo = {
  /** get_book_root: 64 hex characters */
  bookRoot(): Promise<string>;
  /** get_book_epoch */
  bookEpoch(): Promise<bigint>;
  /** get_policy.paused */
  paused(): Promise<boolean>;
  /** the number of requests held on the card (get_pending) */
  pendingCount(): Promise<number>;
  /** the agent's reject streak and the streak that locks it (get_escalation_state) */
  rejectStreak(): Promise<{ streak: number; lock: number }>;
  /** the time of the latest final block */
  blockMs(): Promise<number>;
  /** the `preview` view: what submit_batch would answer, with no signature and no state change */
  preview(req: WireRequest, task: OwnerTask): Promise<{ outcome: string; reason: string | null }>;
  /** the one owner transaction; answers its hash */
  send(args: { expected_old: string; new_root: string }): Promise<string>;
  log(line: string): void;
};

/** Why a vault is not strict, in one line that names no payee, or null when every entry has no cap and no budget. */
export function whyNotStrict(v: Vault): string | null {
  const n = v.entries.length;
  if (n === 0) return 'the vault holds no entry';
  for (const [i, e] of v.entries.entries()) {
    if (e.cap !== null) return `entry ${String(i + 1)} of ${String(n)} has a cap for amounts read from text`;
    if (e.daily_untrusted_budget !== '0') return `entry ${String(i + 1)} of ${String(n)} has a budget for amounts read from text`;
  }
  return null;
}

/** How many entries the strict copy changes. */
export const changedCount = (v: Vault): number => v.entries.filter((e) => e.cap !== null || e.daily_untrusted_budget !== '0').length;

/**
 * The strict copy: every payee kept with its daily limit, label and listing, no cap and a budget of 0 (the convention of strict entries).
 * A changed entry gets a new salt, as book-vault.ts does; an entry that is already strict is kept as it is, so a strict vault is returned
 * unchanged.
 */
export function strictVaultOf(v: Vault): Vault {
  let out = v;
  for (const e of v.entries) {
    if (e.cap === null && e.daily_untrusted_budget === '0') continue;
    out = out.remove(e.payee).add({ payee: e.payee, cap: null, dailyUntrustedBudget: 0n, dailyLimit: BigInt(e.daily_limit), label: e.label, listed: e.listed });
  }
  return out;
}

/** The near CLI arguments of the one owner call (1 yoctoNEAR, signed by the card's owner from the keychain). */
export function bookSetRootCommand(card: string, owner: string, args: { expected_old: string; new_root: string }): string[] {
  const json = JSON.stringify({ expected_old: args.expected_old, new_root: args.new_root });
  return ['contract', 'call-function', 'as-transaction', card, 'book_set_root', 'json-args', json, 'prepaid-gas', '100 Tgas', 'attached-deposit', '1 yoctoNEAR', 'sign-as', owner, 'network-config', 'testnet', 'sign-with-keychain', 'send'];
}

/** A command as one line that can be pasted into a shell: an argument with anything but plain characters is single-quoted. */
export function shellLine(program: string, args: readonly string[]): string {
  return [program, ...args.map((a) => (/^[A-Za-z0-9_.:/=-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`))].join(' ');
}

export type StrictArgs = {
  io: StrictIo;
  /** the vault of the book the card holds now */
  oldVault: Vault;
  /** its strict copy */
  newVault: Vault;
  card: string;
  owner: string;
  agent: string;
  /** live switches that exist (paths): a job that signs as the agent must be off while the root changes */
  switches: readonly string[];
};

export type StrictPlan = { lines: string[]; call: { expected_old: string; new_root: string }; notReady: string | null };

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${String(n)} ${many}`);

/** What the change is and whether it can be sent now. Reads the chain; sends nothing. */
export async function planStrict(p: StrictArgs): Promise<StrictPlan> {
  const [root, epoch, paused, pending, streak] = [await p.io.bookRoot(), await p.io.bookEpoch(), await p.io.paused(), await p.io.pendingCount(), await p.io.rejectStreak()];
  const oldRoot = p.oldVault.root();
  const newRoot = p.newVault.root();
  const call = { expected_old: oldRoot, new_root: newRoot };
  const total = p.oldVault.entries.length;
  const lines = [
    `card ${p.card}`,
    `old root ${oldRoot} (the old vault)`,
    `new root ${newRoot} (the strict vault)`,
    `the card holds root ${root}, epoch ${epoch.toString()}, becomes ${(epoch + 1n).toString()}`,
    `${String(changedCount(p.oldVault))} of ${String(total)} entries change: the cap for amounts read from text becomes none and the budget 0; payees, daily limits and labels stay`,
    `card paused ${String(paused)}, held requests ${String(pending)}, agent reject streak ${String(streak.streak)} of ${String(streak.lock)}`,
    'after the change: every amount read from text is held for the owner at any size; an amount the owner task states is still allowed; a proof built from the old vault no longer verifies, so every job that signs as the agent must read the strict vault',
    `the owner call (1 transaction, signed by ${p.owner}):`,
    shellLine('near', bookSetRootCommand(p.card, p.owner, call)),
  ];
  const strictWhy = whyNotStrict(p.newVault);
  let notReady: string | null = null;
  if (strictWhy !== null) notReady = `the new vault is not strict: ${strictWhy}`;
  else if (root === newRoot) notReady = 'the card already holds the strict root: nothing to send';
  else if (root !== oldRoot) notReady = 'the old vault is not the book the card holds (its root differs from get_book_root)';
  else if (pending > 0) notReady = `${plural(pending, 'request is', 'requests are')} held on the card: expire ${pending === 1 ? 'it' : 'them'} first, never reject`;
  else if (p.switches.length > 0) notReady = `${p.switches.join(', ')} exists: turn the job off before the root changes`;
  return { lines, call, notReady };
}

/** `--live`: the one owner call, sent only with the env flag and only when the plan is ready; the chain is read back afterwards. */
export async function sendStrict(p: StrictArgs & { flag: boolean }): Promise<{ code: number; line: string }> {
  const plan = await planStrict(p);
  for (const l of plan.lines) p.io.log(l);
  if (!p.flag) return { code: 1, line: `CREDIT STRICT NOT SENT the owner call needs ${STRICT_FLAG}=1 next to --live` };
  if (plan.notReady !== null) return { code: 1, line: `CREDIT STRICT NOT SENT ${plan.notReady}` };
  const epoch = await p.io.bookEpoch();
  const tx = await p.io.send(plan.call);
  const [root, after] = [await p.io.bookRoot(), await p.io.bookEpoch()];
  if (root !== plan.call.new_root) return { code: 1, line: `CREDIT STRICT FAILED ${tx} was sent and the card still holds another root (${root})` };
  if (after !== epoch + 1n) return { code: 1, line: `CREDIT STRICT FAILED ${tx} was sent and the epoch is ${after.toString()}, not ${(epoch + 1n).toString()}` };
  return { code: 0, line: `CREDIT STRICT SENT ${tx} root ${root} epoch ${after.toString()}` };
}

/** The amount of the two preview requests: 0.01 NEAR, inside the cap the entry had before strict mode. */
export const PREVIEW_AMOUNT_YOCTO = 10n ** 22n;

/** A task and a request to the booked payee for the `preview` view: never signed, never submitted. */
export function previewPair(p: { vault: Vault; card: string; agent: string; payee: string; amountLabel: 'Owner' | 'Untrusted:email'; nowMs: number }): { req: WireRequest; task: OwnerTask } {
  const task = OwnerTask.parse({
    tag: TASK_TAG,
    task_id: `strict-check-${String(p.nowMs)}`,
    contract_id: p.card,
    agent_id: p.agent,
    plan_sha256: sha256Hex(new TextEncoder().encode('credit:strict-check')),
    instruction_sha256_salted: sha256Hex(new TextEncoder().encode('salt:strict-check')),
    issued_ms: p.nowMs - 1000,
    expires_ms: p.nowMs + 10 * 60_000,
    max_actions: 1,
    bounds: [{ payee_key: p.payee, max_total: PREVIEW_AMOUNT_YOCTO.toString() }],
  });
  const req = ActionRequest.parse({
    task_id: task.task_id,
    action_index: 0,
    asset: 'near',
    payee: p.payee,
    amount: PREVIEW_AMOUNT_YOCTO.toString(),
    labels: { recipient: labelsToBits(['Book']), amount: labelsToBits([p.amountLabel]), pc: labelsToBits(['Owner']) },
    evm: null,
    hints: { plan_hash: task.plan_sha256, trace_digest: '0'.repeat(64) },
  });
  return { req: { ...req, book: p.vault.proofFor(p.payee) }, task };
}

/**
 * `--verify`: the vault is strict, its root is the root the card holds, and (when the card is not paused) the card's own `preview` holds an
 * amount read from text and allows the same amount stated by the owner. Read only.
 */
export async function verifyStrict(p: { io: StrictIo; vault: Vault; card: string; agent: string }): Promise<{ code: number; line: string }> {
  const no = (why: string): { code: number; line: string } => ({ code: 1, line: `CREDIT STRICT NO ${why}` });
  const why = whyNotStrict(p.vault);
  if (why !== null) return no(why);
  const [root, epoch] = [await p.io.bookRoot(), await p.io.bookEpoch()];
  if (root !== p.vault.root()) return no('the vault root is not the root the card holds (get_book_root)');
  const ok = `CREDIT STRICT OK root ${root} epoch ${epoch.toString()}`;
  if (await p.io.paused()) return { code: 0, line: `${ok} (preview skipped: card paused)` };
  const payee = p.vault.entries[0]?.payee;
  if (payee === undefined) return no('the vault holds no entry');
  const nowMs = await p.io.blockMs();
  const said = (a: { outcome: string; reason: string | null }): string => (a.reason === null ? a.outcome : `${a.outcome} ${a.reason}`);
  const text = previewPair({ vault: p.vault, card: p.card, agent: p.agent, payee, amountLabel: 'Untrusted:email', nowMs });
  const held = await p.io.preview(text.req, text.task);
  if (held.outcome !== 'escalated' || held.reason !== 'UntrustedAmount') return no(`the card answered ${said(held)} to an amount read from text, not escalated UntrustedAmount`);
  const owner = previewPair({ vault: p.vault, card: p.card, agent: p.agent, payee, amountLabel: 'Owner', nowMs });
  const allowed = await p.io.preview(owner.req, owner.task);
  if (allowed.outcome !== 'allowed') return no(`the card answered ${said(allowed)} to an amount the owner task states, not allowed`);
  return { code: 0, line: ok };
}

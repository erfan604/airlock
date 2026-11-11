// Red-team lane 1, live proof of the approver bounds on the credit card (`card.airlock-credit-c1108d.testnet`, code hash
// 79BH9QUuWjxt4SggfgD66maVb7m2ckg5HHq3aB5pKGX7 after the redeploy). One run: the agent asks to pay the booked merchant 0.002 NEAR under an
// issuer task that bounds the merchant at 0.001 NEAR, so the card holds it `OverTaskBound`; the borrower (the card's approver) taps approve
// and is refused with `approve refused for the approver: the payment is held OverTaskBound`; the request is still pending; then it is
// cleared. Nothing is paid, so no ledger moves: the hold charges none, the refused approve reverts, and expire or reject charges none.
//   pnpm tsx scripts/credit-approver-bounds-live.ts                     dry (the default): reads the chain, prints the stop rule that holds
//                                                                       and the plan with every call; sends nothing
//   pnpm tsx scripts/credit-approver-bounds-live.ts --live              the run; clears the hold by `expire` once its time to live has passed
//                                                                       (the script waits, about 61 minutes on the live card)
//   pnpm tsx scripts/credit-approver-bounds-live.ts --live --reject     the same, cleared at once by the borrower's `reject` (counts one reject
//                                                                       on the agent's owner-origin counters)
//   pnpm tsx scripts/credit-approver-bounds-live.ts --resume            after an interrupted wait: expires the recorded hold
//   pnpm tsx scripts/credit-approver-bounds-live.ts --verify [<file>]   read-only: re-reads the recorded transactions from RPC
// The record is target/credit-approver/run.json (`--record <file>` moves it). The agent signs through the arena's signer
// (runtime/src/credit/agent-signer.ts: the scoped key file or the agent's keychain entry), the task through the task key file, and the
// borrower through the near CLI keychain. This script reads no key into its output and prints no key or vault content.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import type { BatchResult } from '../runtime/src/chain/types.ts';
import { takeLock } from '../runtime/src/credit/lock.ts';
import { rpcView } from '../runtime/src/credit/rpc.ts';
import { pickVault, vaultCandidates } from '../runtime/src/credit/vaults.ts';
import { ActionRequest, OwnerTask, TASK_TAG, labelsToBits, sha256Hex } from '../runtime/src/dsl/index.ts';
import { ECONOMY_ACCOUNTS as A } from '../runtime/src/economy/index.ts';
import type { Vault } from '../runtime/src/vault/index.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The card's code once the approver bounds are deployed (base58 of the sha256 of contracts/airlock-policy/res/airlock_policy.wasm). */
export const EXPECTED_CODE_HASH = '79BH9QUuWjxt4SggfgD66maVb7m2ckg5HHq3aB5pKGX7';
export const REFUSAL = 'approve refused for the approver: the payment is held OverTaskBound';
/** The issuer's task bound for the merchant: 0.001 NEAR. */
export const BOUND_YOCTO = 10n ** 21n;
/** The amount the agent asks for: 0.002 NEAR, above the bound, so the card holds it OverTaskBound. Nothing is paid. */
export const AMOUNT_YOCTO = 2n * 10n ** 21n;
/** Nothing above this is ever at stake in this run. */
export const MAX_AT_STAKE_YOCTO = 10n ** 22n;
export const TASK_PREFIX = 'bounds-';
export const TASK_TTL_MS = 20 * 60_000;
/** The hourly loop runs at about :24 to :28 past each hour; no send starts within 6 minutes of that window. */
export const LOOP_WINDOW_FROM_MIN = 18;
export const LOOP_WINDOW_TO_MIN = 34;
/** An expire is sent this long after the hold's time, so the block clock is past it too. */
export const EXPIRE_MARGIN_MS = 30_000;
/** Above this time to live the hold is cleared by `--reject`, not by waiting for expiry. */
export const MAX_WAIT_TTL_MS = 2 * 3_600_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nearText = (y: bigint): string => {
  const frac = (y % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return frac === '' ? (y / 10n ** 24n).toString() : `${(y / 10n ** 24n).toString()}.${frac}`;
};

export type Flood = { pending: number; consecutive_rejects: number; rejects_today: number; locked: boolean; hour_count: number; limits: { max_pending: number; lock_consecutive: number; lock_per_day: number; hourly_budget: number } };
export type NearCall = { signer: string; method: string; args: object; deposit: string; gas: string };
export type Step = { what: string; signer: string; tx: string };
export type RunRecord = { startMs: number; requestId: string; pendingId: string; taskId: string; taskHash: string; expiresMs: number; clear: 'expire' | 'reject' | null; steps: Step[]; ledgersBefore: unknown; ledgersAfter: unknown; poolBefore: unknown; poolAfter: unknown };
export type AgentClient = {
  submit(req: ActionRequest, task: OwnerTask): Promise<BatchResult>;
  latestBlockMs(): Promise<number>;
  expire(id: string): Promise<string>;
};
export type BoundsIo = {
  nowMs(): number;
  view(account: string, method: string, args?: object): Promise<unknown>;
  codeHash(account: string): Promise<string | null>;
  /** target/credit/LOCK, shared with the hourly loop and the arena */
  lock(): (() => void) | null;
  /** whether that lock file exists (read only: a dry run never takes the lock) */
  lockHeld(): boolean;
  agent(): Promise<AgentClient>;
  /** a function call on the card signed from the near CLI keychain */
  send(call: NearCall): Promise<{ ok: boolean; tx: string; out: string }>;
  /** EXPERIMENTAL_tx_status, FINAL, from the fast RPC then the archival one */
  txStatus(hash: string, sender: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  readRecord(): RunRecord | null;
  writeRecord(r: RunRecord): void;
  log(line: string): void;
};

export type State = {
  codeHash: string | null;
  paused: boolean;
  approver: string | null;
  pendingTtlMs: number;
  maxTaskTtlMs: number;
  pending: number;
  owner: Flood;
  hardCap: bigint;
  lockFree: boolean;
  minute: number;
};

export async function readState(io: BoundsIo): Promise<State> {
  const policy = await io.view(A.card, 'get_policy');
  const roles = await io.view(A.card, 'get_roles');
  const pending = await io.view(A.card, 'get_pending', {});
  const owner = await io.view(A.card, 'get_escalation_state', { agent: A.agent, origin: 'owner' });
  const assets = await io.view(A.card, 'list_assets');
  if (!isObj(policy) || !isObj(policy['flags']) || !isObj(roles) || !Array.isArray(pending) || !isObj(owner) || !Array.isArray(assets)) throw new Error('a card view answered something unexpected');
  const flags = policy['flags'];
  const near = assets.find((a): a is [string, Record<string, unknown>] => Array.isArray(a) && a[0] === 'near' && isObj(a[1]));
  if (near === undefined || typeof near[1]['hard_cap'] !== 'string') throw new Error('the card has no near asset');
  return {
    codeHash: await io.codeHash(A.card),
    paused: policy['paused'] === true,
    approver: typeof roles['approver'] === 'string' ? roles['approver'] : null,
    pendingTtlMs: Number(flags['pending_ttl_ms']),
    maxTaskTtlMs: Number(flags['max_task_ttl_ms']),
    pending: pending.filter((r) => isObj(r) && r['state'] === 'Pending').length,
    owner: owner as unknown as Flood,
    hardCap: BigInt(near[1]['hard_cap']),
    lockFree: !io.lockHeld(),
    minute: new Date(io.nowMs()).getUTCMinutes(),
  };
}

/** The first stop rule that holds before any live send, or null. */
export function stopRule(s: State, clear: 'expire' | 'reject'): string | null {
  if (s.codeHash !== EXPECTED_CODE_HASH) return `STOP the card runs code hash ${s.codeHash ?? 'none'}, not ${EXPECTED_CODE_HASH} (the approver bounds are not deployed)`;
  if (s.paused) return 'STOP the card is paused';
  if (s.approver !== A.borrower) return `STOP the card's approver is ${s.approver ?? 'none'}, not ${A.borrower}`;
  if (s.pending > 0) return `STOP the card's pending queue is not empty (${String(s.pending)} pending)`;
  if (!s.lockFree) return 'STOP another credit job holds the lock (target/credit/LOCK)';
  if (s.minute >= LOOP_WINDOW_FROM_MIN && s.minute <= LOOP_WINDOW_TO_MIN) return `STOP within 6 minutes of the hourly loop (minute ${String(s.minute)}; start outside :${String(LOOP_WINDOW_FROM_MIN)} to :${String(LOOP_WINDOW_TO_MIN)})`;
  if (AMOUNT_YOCTO > MAX_AT_STAKE_YOCTO || BOUND_YOCTO >= AMOUNT_YOCTO || AMOUNT_YOCTO > s.hardCap) return 'STOP the amounts are not tiny, or not above the bound, or above the asset hard cap';
  if (TASK_TTL_MS > s.maxTaskTtlMs) return 'STOP the task life is above the card max_task_ttl_ms';
  const f = s.owner;
  if (f.locked) return 'STOP the agent is locked on the owner-origin counters';
  if (f.pending + 1 > f.limits.max_pending) return 'STOP the owner origin has no pending room';
  if (f.hour_count + 1 > f.limits.hourly_budget) return 'STOP the owner origin has no escalation left this hour';
  if (clear === 'reject' && f.limits.lock_consecutive >= 1 && f.consecutive_rejects + 1 >= f.limits.lock_consecutive) return `STOP a reject would bring the owner-origin streak to the lock (${String(f.consecutive_rejects)} now, lock at ${String(f.limits.lock_consecutive)})`;
  if (clear === 'expire' && s.pendingTtlMs > MAX_WAIT_TTL_MS) return `STOP the card's pending time to live is ${String(s.pendingTtlMs / 60_000)} min: clear with --reject`;
  return null;
}

/** The issuer task and the one request: Book recipient, Owner amount and trigger, origin owner (every label trusted). */
export function boundsRequest(p: { nowMs: number; suffix: string }): { req: ActionRequest; task: OwnerTask } {
  const payee = `near:${A.merchant}`;
  const task = OwnerTask.parse({
    tag: TASK_TAG,
    task_id: `${TASK_PREFIX}${String(p.nowMs)}-${p.suffix}`,
    contract_id: A.card,
    agent_id: A.agent,
    plan_sha256: sha256Hex(new TextEncoder().encode('credit:approver-bounds-live')),
    instruction_sha256_salted: sha256Hex(new TextEncoder().encode(`salt:approver-bounds-live:${p.suffix}`)),
    issued_ms: p.nowMs - 1000,
    expires_ms: p.nowMs + TASK_TTL_MS,
    max_actions: 1,
    bounds: [{ payee_key: payee, max_total: BOUND_YOCTO.toString() }],
  });
  const req = ActionRequest.parse({
    task_id: task.task_id,
    action_index: 0,
    asset: 'near',
    payee,
    amount: AMOUNT_YOCTO.toString(),
    labels: { recipient: labelsToBits(['Book']), amount: labelsToBits(['Owner']), pc: labelsToBits(['Owner']) },
    evm: null,
    hints: { plan_hash: task.plan_sha256, trace_digest: '0'.repeat(64), origin: 'owner' },
  });
  return { req, task };
}

/** The plan, one line per call. */
export function planLines(s: State, clear: 'expire' | 'reject'): string[] {
  const payee = `near:${A.merchant}`;
  return [
    `PLAN card ${A.card} code hash ${s.codeHash ?? 'none'} (expected ${EXPECTED_CODE_HASH}), approver ${s.approver ?? 'none'}, paused ${String(s.paused)}`,
    `PLAN pending ${String(s.pending)}; owner-origin counters: pending ${String(s.owner.pending)} of ${String(s.owner.limits.max_pending)}, this hour ${String(s.owner.hour_count)} of ${String(s.owner.limits.hourly_budget)}, reject streak ${String(s.owner.consecutive_rejects)} (lock at ${String(s.owner.limits.lock_consecutive)}), rejects today ${String(s.owner.rejects_today)}, locked ${String(s.owner.locked)}`,
    `PLAN lock target/credit/LOCK ${s.lockFree ? 'free' : 'held'}; minute ${String(s.minute)} (refused from :${String(LOOP_WINDOW_FROM_MIN)} to :${String(LOOP_WINDOW_TO_MIN)})`,
    `PLAN 1 agent ${A.agent} submit_batch: task ${TASK_PREFIX}<ms>-<hex> bounds ${payee} at ${nearText(BOUND_YOCTO)} NEAR, one request of ${nearText(AMOUNT_YOCTO)} NEAR to ${payee}, labels Book/Owner/Owner, origin owner; expected: escalated OverTaskBound, in_book`,
    `PLAN 2 borrower ${A.borrower} approve (1 yoctoNEAR, 65 Tgas) with the card's five fields from get_request; expected: fails with "${REFUSAL}"`,
    'PLAN 3 read get_request: expected state Pending; get_ledgers and get_pool unchanged',
    clear === 'expire'
      ? `PLAN 4 wait until the hold's expires_ms plus ${String(EXPIRE_MARGIN_MS / 1000)} s (pending_ttl_ms ${String(s.pendingTtlMs)}, about ${String(Math.ceil((s.pendingTtlMs + EXPIRE_MARGIN_MS) / 60_000))} min), then agent expire(<id>): no reject counted; the hourly loop stops one cycle while the hold is pending (a held request that is not an arena hold)`
      : `PLAN 4 borrower ${A.borrower} reject(<id>) (1 yoctoNEAR) at once: the owner-origin reject streak goes from ${String(s.owner.consecutive_rejects)} to ${String(s.owner.consecutive_rejects + 1)}, rejects today +1`,
    'PLAN 5 read get_request (Expired or Rejected), get_ledgers and get_pool: expected unchanged from before step 1',
    `PLAN at stake: nothing is paid; at most ${nearText(AMOUNT_YOCTO)} NEAR is ever asked for; gas from the agent's key allowance and the borrower's balance`,
  ];
}

const ledgers = (io: BoundsIo, taskHash: string | null): Promise<unknown> => io.view(A.card, 'get_ledgers', taskHash === null ? { payee: `near:${A.merchant}`, asset: 'near' } : { payee: `near:${A.merchant}`, asset: 'near', task: taskHash });
const poolOf = async (io: BoundsIo): Promise<unknown> => {
  const p = await io.view(A.pool, 'get_pool');
  return isObj(p) ? { idle: p['idle'], lent: p['lent'], shares: p['shares'], fees_earned: p['fees_earned'], lines: p['lines'] } : p;
};
const stateOf = async (io: BoundsIo, requestId: string): Promise<string> => {
  const v = await io.view(A.card, 'get_request', { id: requestId });
  return isObj(v) && typeof v['state'] === 'string' ? v['state'] : 'unknown';
};
/** The day ledgers without the task one, so a fresh task's empty ledger compares equal. */
const dayLedgers = (v: unknown): unknown => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('task'))) : v);

async function live(io: BoundsIo, clear: 'expire' | 'reject'): Promise<number> {
  const s = await readState(io);
  for (const l of planLines(s, clear)) io.log(l);
  const stop = stopRule(s, clear);
  if (stop !== null) {
    io.log(stop);
    return 0;
  }
  const agent = await io.agent();
  const release = io.lock();
  if (release === null) {
    io.log('STOP another credit job took the lock (target/credit/LOCK)');
    return 0;
  }
  let rec: RunRecord;
  try {
    const ledgersBefore = await ledgers(io, null);
    const poolBefore = await poolOf(io);
    const { req, task } = boundsRequest({ nowMs: await agent.latestBlockMs(), suffix: randomBytes(3).toString('hex') });
    const held = await agent.submit(req, task);
    const o = held.outcomes[0];
    if (o === undefined || o.outcome !== 'escalated' || o.reason !== 'OverTaskBound' || o.pending_id === null) {
      io.log(`APPROVER BOUNDS FAILED the request was not held OverTaskBound: ${JSON.stringify(held.outcomes)}`);
      return 1;
    }
    const view = await io.view(A.card, 'get_request', { id: o.request_id });
    if (!isObj(view) || !isObj(view['display']) || typeof view['expires_ms'] !== 'string') throw new Error('get_request answered something unexpected');
    rec = { startMs: io.nowMs(), requestId: o.request_id, pendingId: o.pending_id, taskId: task.task_id, taskHash: held.taskHash, expiresMs: Number(view['expires_ms']), clear: null, steps: [{ what: 'held OverTaskBound', signer: A.agent, tx: held.txHash ?? '' }], ledgersBefore, ledgersAfter: null, poolBefore, poolAfter: null };
    io.writeRecord(rec);
    io.log(`STEP 1 held ${o.reason} pending id ${o.pending_id}, tx ${held.txHash ?? '-'}`);
    const card = { id: o.pending_id, to: view['payee'], asset: view['display']['asset_symbol'], amount: view['display']['amount_decimal'], why: view['reason'], book: view['book_status'] };
    if (card.book !== 'in_book') {
      io.log(`APPROVER BOUNDS FAILED the hold is not in_book (${String(card.book)}): the refusal would be the book rule, not the bounds`);
      return 1;
    }
    const tap = await io.send({ signer: A.borrower, method: 'approve', args: card, deposit: '1 yoctoNEAR', gas: '65 Tgas' });
    rec.steps.push({ what: 'borrower approve refused', signer: A.borrower, tx: tap.tx });
    io.writeRecord(rec);
    if (tap.ok || !tap.out.includes(REFUSAL)) {
      io.log(`APPROVER BOUNDS FAILED the borrower's approve was not refused with the bounds text: ${tap.out.slice(-400).replace(/\s+/g, ' ')}`);
      return 1;
    }
    io.log(`STEP 2 approve refused, tx ${tap.tx}`);
    const st = await stateOf(io, o.request_id);
    if (st !== 'Pending') {
      io.log(`APPROVER BOUNDS FAILED the request is ${st} after the refused approve, not Pending`);
      return 1;
    }
    io.log('STEP 3 still Pending');
    if (clear === 'reject') {
      const r = await io.send({ signer: A.borrower, method: 'reject', args: { id: o.pending_id }, deposit: '1 yoctoNEAR', gas: '30 Tgas' });
      if (!r.ok) {
        io.log(`APPROVER BOUNDS FAILED the reject failed: ${r.out.slice(-300).replace(/\s+/g, ' ')}`);
        return 1;
      }
      rec.steps.push({ what: 'borrower reject', signer: A.borrower, tx: r.tx });
      rec.clear = 'reject';
      io.writeRecord(rec);
      io.log(`STEP 4 rejected, tx ${r.tx}`);
    }
  } finally {
    release();
  }
  if (rec.clear === null) {
    const code = await expireRecorded(io, rec, agent);
    if (code !== 0) return code;
  }
  return finish(io, rec);
}

/** Waits for the hold's time to live (without the lock: the loop and the arena both stop on this hold), then expires it as the agent. */
async function expireRecorded(io: BoundsIo, rec: RunRecord, agent: AgentClient): Promise<number> {
  const due = rec.expiresMs + EXPIRE_MARGIN_MS;
  io.log(`STEP 4 waiting until ${new Date(due).toISOString()} to expire pending id ${rec.pendingId} (about ${String(Math.max(0, Math.ceil((due - io.nowMs()) / 60_000)))} min)`);
  while (io.nowMs() < due) await io.sleep(Math.min(60_000, due - io.nowMs()));
  while ((await agent.latestBlockMs()) < rec.expiresMs) await io.sleep(10_000);
  let release = io.lock();
  while (release === null) {
    await io.sleep(30_000);
    release = io.lock();
  }
  try {
    if ((await stateOf(io, rec.requestId)) !== 'Pending') {
      io.log('APPROVER BOUNDS FAILED the hold is no longer pending before the expire (someone cleared it)');
      return 1;
    }
    const tx = await agent.expire(rec.pendingId);
    rec.steps.push({ what: 'agent expire', signer: A.agent, tx });
    rec.clear = 'expire';
    io.writeRecord(rec);
    io.log(`STEP 4 expired, tx ${tx}`);
  } finally {
    release();
  }
  return 0;
}

async function finish(io: BoundsIo, rec: RunRecord): Promise<number> {
  rec.ledgersAfter = await ledgers(io, null);
  rec.poolAfter = await poolOf(io);
  io.writeRecord(rec);
  const st = await stateOf(io, rec.requestId);
  const want = rec.clear === 'reject' ? 'Rejected' : 'Expired';
  const sameDay = new Date(rec.startMs).toISOString().slice(0, 10) === new Date(io.nowMs()).toISOString().slice(0, 10);
  // a UTC midnight inside the wait resets the day ledgers to 0 on its own: then only the pool is compared
  const same = (!sameDay || JSON.stringify(dayLedgers(rec.ledgersBefore)) === JSON.stringify(dayLedgers(rec.ledgersAfter))) && JSON.stringify(rec.poolBefore) === JSON.stringify(rec.poolAfter);
  const task = await ledgers(io, rec.taskHash);
  io.log(`STEP 5 request ${st}, ${sameDay ? 'day ledgers' : 'day ledgers not compared (a UTC midnight passed)'} and pool ${same ? 'unchanged' : 'CHANGED'}, task ledger ${JSON.stringify(task)}`);
  if (st !== want || !same) {
    io.log(`APPROVER BOUNDS FAILED expected ${want} and nothing changed`);
    return 1;
  }
  io.log(`APPROVER BOUNDS LIVE OK ${rec.steps.map((x) => x.tx).join(' ')}`);
  return 0;
}

/** Every receipt failure text of a transaction status, joined. */
export function failureText(status: unknown): string {
  return JSON.stringify(status)
    .split('"Failure"')
    .slice(1)
    .map((s) => s.slice(0, 600))
    .join(' ');
}

/** The decoded SuccessValue of the transaction's final status, or null. */
export function successValue(status: unknown): unknown {
  const s = isObj(status) && isObj(status['status']) ? status['status'] : null;
  if (s === null || typeof s['SuccessValue'] !== 'string') return null;
  try {
    return JSON.parse(Buffer.from(s['SuccessValue'], 'base64').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

const txOf = (status: unknown): Record<string, unknown> | null => (isObj(status) && isObj(status['transaction']) ? status['transaction'] : null);

/** `--verify`: read-only, from the record file and the chain. */
export async function verify(io: BoundsIo): Promise<number> {
  const no = (why: string): number => {
    io.log(`APPROVER BOUNDS VERIFY NO ${why}`);
    return 1;
  };
  const rec = io.readRecord();
  if (rec === null) return no('no record: the live run writes it');
  const [held, tap, cleared] = rec.steps;
  if (held === undefined || tap === undefined || cleared === undefined) return no('the record has fewer than three steps');
  const h = await io.txStatus(held.tx, held.signer);
  const ht = txOf(h);
  const outs = successValue(h);
  const first = Array.isArray(outs) && isObj(outs[0]) ? outs[0] : null;
  if (ht === null || ht['signer_id'] !== A.agent || ht['receiver_id'] !== A.card || first === null || first['outcome'] !== 'escalated' || first['reason'] !== 'OverTaskBound' || first['request_id'] !== rec.requestId) return no(`${held.tx} is not the agent's submit_batch held OverTaskBound`);
  io.log(`PASS ${held.tx} held OverTaskBound (${rec.requestId})`);
  const t = await io.txStatus(tap.tx, tap.signer);
  const tt = txOf(t);
  if (tt === null || tt['signer_id'] !== A.borrower || tt['receiver_id'] !== A.card || !failureText(t).includes(REFUSAL)) return no(`${tap.tx} is not the borrower's approve failing with the bounds text`);
  io.log(`PASS ${tap.tx} the borrower's approve failed: ${REFUSAL}`);
  const c = await io.txStatus(cleared.tx, cleared.signer);
  const ct = txOf(c);
  if (ct === null || ct['receiver_id'] !== A.card || failureText(c) !== '') return no(`${cleared.tx} is not a successful call on the card`);
  const st = await stateOf(io, rec.requestId);
  const want = rec.clear === 'reject' ? 'Rejected' : 'Expired';
  if (st !== want) return no(`the request is ${st}, not ${want}`);
  io.log(`PASS ${cleared.tx} ${rec.clear ?? '-'}; the request is ${st}`);
  io.log(`APPROVER BOUNDS VERIFY OK ${rec.steps.map((x) => x.tx).join(' ')}`);
  return 0;
}

export async function main(argv: readonly string[], deps?: { io: BoundsIo }): Promise<number> {
  const args = [...argv];
  let record = join(REPO, 'target', 'credit-approver', 'run.json');
  const r = args.indexOf('--record');
  if (r >= 0) {
    const p = args[r + 1];
    if (p === undefined) return usage();
    record = p;
    args.splice(r, 2);
  }
  const v = args.indexOf('--verify');
  if (v >= 0 && args[v + 1] !== undefined && !args[v + 1]?.startsWith('--')) {
    record = args[v + 1] ?? record;
    args.splice(v + 1, 1);
  }
  const known = new Set(['--live', '--reject', '--resume', '--verify']);
  if (args.some((a) => !known.has(a))) return usage();
  const io = deps?.io ?? liveIo(record);
  if (args.includes('--verify')) return verify(io);
  const clear = args.includes('--reject') ? 'reject' : 'expire';
  if (args.includes('--resume')) {
    const rec = io.readRecord();
    if (rec === null || rec.clear !== null) {
      io.log('APPROVER BOUNDS RESUME nothing to resume');
      return 1;
    }
    const code = await expireRecorded(io, rec, await io.agent());
    return code !== 0 ? code : finish(io, rec);
  }
  if (args.includes('--live')) return live(io, clear);
  const s = await readState(io);
  for (const l of planLines(s, clear)) io.log(l);
  io.log(stopRule(s, clear) ?? 'DRY no stop rule holds: --live would run the plan above');
  io.log('DRY RUN nothing sent');
  return 0;
}

function usage(): number {
  console.log('usage: credit-approver-bounds-live.ts [--live [--reject] | --resume | --verify [<file>]] [--record <file>]');
  return 2;
}

export function liveIo(recordFile: string): BoundsIo {
  const rpc = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
  const archival = 'https://archival-rpc.testnet.fastnear.com';
  const env = process.env;
  const lockFile = join(env['CREDIT_DIR'] ?? join(REPO, 'target', 'credit'), 'LOCK');
  const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  const post = async (url: string, method: string, params: unknown): Promise<unknown> => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'bounds', method, params }), signal: AbortSignal.timeout(30_000) });
    const j = (await res.json()) as { result?: unknown; error?: unknown };
    if (j.error !== undefined) throw new Error(`${method} answered an error: ${JSON.stringify(j.error).slice(0, 200)}`);
    return j.result;
  };
  return {
    nowMs: () => Date.now(),
    view: (account, method, args = {}) => rpcView(rpc, account, method, args),
    codeHash: async (account) => {
      const r = await post(rpc, 'query', { finality: 'final', request_type: 'view_account', account_id: account });
      return isObj(r) && typeof r['code_hash'] === 'string' ? r['code_hash'] : null;
    },
    lock: () => takeLock(lockFile, Date.now()),
    lockHeld: () => existsSync(lockFile),
    agent: async () => {
      const { ChainClient } = await import('../runtime/src/chain/near.ts');
      const { loadAgentSigner } = await import('../runtime/src/credit/agent-signer.ts');
      const { rpcKeys } = await import('../runtime/src/credit/rpc.ts');
      const { taskSigner } = await import('../runtime/src/mcp/boot.ts');
      const { loadVault } = await import('../runtime/src/vault/file.ts');
      const { expireOnCard } = await import('../runtime/src/arena/writes.ts');
      const root = await rpcView(rpc, A.card, 'get_book_root', {});
      if (typeof root !== 'string') throw new Error('get_book_root answered something unexpected');
      const files = vaultCandidates(REPO, env['ARENA_BOOK_VAULT']).filter((f) => existsSync(f));
      const books = new Map<string, Vault>();
      const picked = pickVault(
        files.map((path) => {
          try {
            const b = loadVault(path);
            books.set(path, b);
            return { path, root: b.root() };
          } catch {
            return { path, root: null };
          }
        }),
        root,
      );
      if ('refuse' in picked) throw new Error(picked.refuse);
      const vault = books.get(picked.path);
      if (vault === undefined || !vault.has(`near:${A.merchant}`)) throw new Error('the book vault has no entry for the merchant');
      const keys = (await rpcKeys(rpc, A.agent)).map((k) => k.publicKey);
      const scopedFile = env['ARENA_KEY_FILE'] ?? join(homedir(), '.airlock-arena-key.json');
      const keychainFile = env['ARENA_AGENT_CREDENTIALS'] ?? join(dirname(picked.path), 'agent.json');
      const got = await loadAgentSigner({ agent: A.agent, keys, scopedFile, keychainFile, env });
      if ('refuse' in got) throw new Error(`no agent signer: ${got.refuse}`);
      console.log(got.line.replace(/^ARENA SIGNER/, 'APPROVER BOUNDS SIGNER'));
      const sign = taskSigner(env['AIRLOCK_TASK_KEY_FILE'] ?? join(homedir(), '.airlock-task-key'));
      const client = new ChainClient({ network: 'testnet', contractId: A.card, agentAccountId: A.agent, signer: got.signer, rpcUrls: [...DEFAULT_RPC_URLS], vault });
      return {
        submit: (req, task) => client.submitBatch([req], task, sign(task)),
        latestBlockMs: () => client.latestBlockMs(),
        expire: (id) => expireOnCard(rpc, got.signer, id),
      };
    },
    send: async (c) => {
      const r = spawnSync(env['NEAR'] ?? 'near', ['contract', 'call-function', 'as-transaction', A.card, c.method, 'json-args', JSON.stringify(c.args), 'prepaid-gas', c.gas, 'attached-deposit', c.deposit, 'sign-as', c.signer, 'network-config', 'testnet', 'sign-with-keychain', 'send'], { encoding: 'utf8' });
      const out = clean(`${r.stdout}${r.stderr}`);
      const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1] ?? '';
      return { ok: !(r.status !== 0 || tx === '' || /ExecutionError|Failure|panicked/.test(out)), tx, out };
    },
    txStatus: async (hash, sender) => {
      const params = { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' };
      try {
        return await post(rpc, 'EXPERIMENTAL_tx_status', params);
      } catch {
        return post(archival, 'EXPERIMENTAL_tx_status', params);
      }
    },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    readRecord: () => (existsSync(recordFile) ? (JSON.parse(readFileSync(recordFile, 'utf8')) as RunRecord) : null),
    writeRecord: (rec) => {
      mkdirSync(dirname(recordFile), { recursive: true });
      writeFileSync(recordFile, `${JSON.stringify(rec, null, 2)}\n`);
    },
    log: (l) => console.log(l),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      // the error's name and message only; nothing here holds a key
      console.log(`APPROVER BOUNDS FAILED ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

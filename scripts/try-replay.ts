// AIR-360: the replay wall. The payment requests the bench recorded in strict mode (configuration A1 of bench/results/final.json, one
// request per run that made one), replayed as real `submit_batch` transactions on the practice card behind /rob, signed with its published
// scoped key exactly as a visitor's browser signs (web/src/live/rob.ts `batchArgs`, web/src/chain/tx.ts `functionCall`).
//
// The mapping, in plain words:
// - The list is built from the bench's own files: each A1 attack run's payment in final.json, joined to the request its transcript proposed
//   (bench/runs/recorded/transcripts, the `proposed` event whose item the `verdict` event names). Nothing is typed into this script.
// - Asset: `near`, as in the bench.
// - Amount: the bench amount divided by 1,000, exactly (a dry check refuses an amount that does not divide). 4.2 NEAR, the booked invoice,
//   becomes 0.0042 NEAR, so an amount below, at or above the invoice stays below, at or above it.
// - Payee: a bench payee in that case's book (the booked merchant; in the 144 requests always the accountant) becomes the practice card's
//   booked shop. Any other bench payee becomes one fresh-looking account id outside the card's book, the same id for the same bench payee.
// - Labels: the recipient, amount and pc label sets exactly as the bench run recorded them, as bits. The verdict reads the labels.
// - Tasks: the card's published tasks bound the shop at 0.01 NEAR each, twice the scaled bench bound (5 NEAR, or 4.2 where the owner typed
//   the amount). The replay first sends a legitimate payment (0.0042 NEAR) in each task it uses, which leaves 0.0058 NEAR of that task's
//   bound: above every scaled amount the bench let through its bound (at most 0.0049) and below the one it did not (0.0094). Every held
//   request then goes into such a task, and the rest of the legitimate payments follow, one per fresh task, so the day's 0.05 NEAR holds
//   all ten (0.042 NEAR).
//
// Before anything is sent, every request is previewed offline with the shipped verdict (web/public/verdict.wasm, as
// scripts/credit-base-spend.ts does) with the card's day and task ledgers carried from one request to the next: a bench hold must preview
// as a hold with the same reason and a bench Allow as a payment to the booked shop. Any disagreement stops the run before it starts.
//   pnpm tsx scripts/try-replay.ts                    dry (the default): reads the card (views only), prints the plan, `DRY RUN nothing sent`
//   TRY_REPLAY_LIVE=1 pnpm tsx scripts/try-replay.ts --live   sends; resumable (target/try-replay/rows.jsonl, rows with a transaction are
//                                                     skipped); keeps the agent's pending holds at 30 or under and waits for the card's
//                                                     refill job to expire holds (it never rejects or expires anything itself)
//   pnpm tsx scripts/try-replay.ts --export           writes docs/evidence/try-replay-rows.json and web/src/live/try-replay.json from the rows
//   pnpm tsx scripts/try-replay.ts --verify [--sample <n>]   read only, no key: re-reads the transactions of the committed rows file
// Options: --public <path or https URL of try-public.json> (default web/public/try-public.json, else the site's copy). Testnet only. The
// only key used is a published function-call key of the practice card's agent (submit_batch on the practice policy only); only its public
// half is ever printed.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelsToBits } from '../runtime/src/dsl/index.ts';
import { functionCall, keyFromSecret } from '../web/src/chain/tx.ts';
import { rpcView } from '../web/src/chain/rpc.ts';
import { NEAR_RPC } from '../web/csp.ts';
import { answerOf, batchArgs, failureOf } from '../web/src/live/rob.ts';
import type { Answer, LabelBits } from '../web/src/live/rob.ts';
import { FASTNEAR_TX, classifyTryTx } from '../web/src/live/tryChain.ts';
import { parseTryPublic } from '../web/src/live/tryPublic.ts';
import type { TryPublic } from '../web/src/live/tryPublic.ts';
import type { WasmVerdict } from '../web/src/try/verdictWasm.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCALE = 1000n;
export const REPLAY_LIVE_FLAG = 'TRY_REPLAY_LIVE';
/** The booked merchant every one of the 144 requests names (the tests check it against the case files). */
export const BENCH_BOOKED = 'near:accountant.testnet';
export const SITE_PUBLIC = 'https://airlock-ere.pages.dev/try-public.json';
export const ROWS_DIR = join(REPO, 'target', 'try-replay');
export const PUBLIC_ROWS = join(REPO, 'docs', 'evidence', 'try-replay-rows.json');
export const PAGE_FILE = join(REPO, 'web', 'src', 'live', 'try-replay.json');
const ARCHIVAL_RPC = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];
const SUBMIT_GAS = 100n * 10n ** 12n;
const PENDING_WAIT_MS = 20_000;
const PENDING_GIVE_UP_MS = 15 * 60_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- the bench requests ----

export type Outcome = 'allowed' | 'escalated' | 'blocked';
export type BenchRequest = {
  case: string;
  run: number;
  /** the payee is in the case's book */
  inBook: boolean;
  payee: string;
  asset: string;
  amount: string;
  labels: { recipient: string[]; amount: string[]; pc: string[] };
  outcome: 'ALLOW' | 'ESCALATE' | 'BLOCK';
  reason: string | null;
  attackerInfluenced: boolean;
};

type CaseLine = { id: string; world?: { book?: { key: string }[] } };

function caseBooks(repo: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const dir = join(repo, 'bench', 'cases');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const c = JSON.parse(line) as CaseLine;
      out.set(c.id, new Set((c.world?.book ?? []).map((b) => b.key)));
    }
  }
  return out;
}

/** The A1 attack runs of bench/results/final.json: the one request each run that made a request sent, with the labels its transcript recorded. */
export function benchRequests(repo: string = REPO): { requests: BenchRequest[]; runs: number; noRequest: number; benchCommit: string } {
  const fin = JSON.parse(readFileSync(join(repo, 'bench', 'results', 'final.json'), 'utf8')) as { meta: { bench_commit: string }; runs: Record<string, unknown>[] };
  const books = caseBooks(repo);
  const runs = fin.runs.filter((r) => r['config'] === 'A1' && r['kind'] === 'attack');
  const requests: BenchRequest[] = [];
  for (const r of runs) {
    const payments = r['payments'] as { payee: string; asset: string; amount: string; outcome: BenchRequest['outcome']; reason: string | null; attackerInfluenced: boolean }[];
    if (payments.length === 0) continue;
    if (payments.length !== 1) throw new Error(`${String(r['case'])}.${String(r['run'])} has ${String(payments.length)} payments, not one`);
    const t = JSON.parse(readFileSync(join(repo, 'bench', 'runs', 'recorded', String(r['transcript'])), 'utf8')) as { trace: { kind: string; data: Record<string, unknown> }[] };
    const verdicts = t.trace.filter((e) => e.kind === 'verdict');
    if (verdicts.length !== 1) throw new Error(`${String(r['transcript'])} has ${String(verdicts.length)} verdicts, not one`);
    const item = verdicts[0]?.data['item'];
    const p = t.trace.find((e) => e.kind === 'proposed' && e.data['item'] === item)?.data;
    const pay = payments[0];
    if (p === undefined || pay === undefined) throw new Error(`${String(r['transcript'])}: no proposed request for the verdict`);
    if (p['payee'] !== pay.payee || p['amount'] !== pay.amount || p['asset'] !== pay.asset) throw new Error(`${String(r['transcript'])}: the proposed request is not the recorded payment`);
    const book = books.get(String(r['case']));
    if (book === undefined) throw new Error(`${String(r['case'])}: no case file`);
    requests.push({
      case: String(r['case']),
      run: r['run'] as number,
      inBook: book.has(pay.payee),
      payee: pay.payee,
      asset: pay.asset,
      amount: pay.amount,
      labels: { recipient: p['recipientLabels'] as string[], amount: p['amountLabels'] as string[], pc: p['pc'] as string[] },
      outcome: pay.outcome,
      reason: pay.reason ?? null,
      attackerInfluenced: pay.attackerInfluenced,
    });
  }
  return { requests, runs: runs.length, noRequest: runs.length - requests.length, benchCommit: fin.meta.bench_commit };
}

// ---- the mapping ----

/** The bench amount divided by 1,000. Refuses an amount of 0 or one that does not divide exactly. */
export function scaleAmount(amount: string): string {
  const v = BigInt(amount);
  if (v <= 0n) throw new Error('an amount must be above 0');
  if (v % SCALE !== 0n) throw new Error(`${amount} is not divisible by ${SCALE.toString()}`);
  return (v / SCALE).toString();
}

/** One fresh-looking NEAR account for a bench payee that is not the booked merchant: the same bench payee always gives the same id. */
export const freshPayee = (benchPayee: string): string => `near:replay-${createHash('sha256').update(benchPayee, 'utf8').digest('hex').slice(0, 16)}.testnet`;

export function mapPayee(benchPayee: string, inBook: boolean, pub: TryPublic): string {
  if (inBook) return pub.shop.payee;
  const id = freshPayee(benchPayee);
  if (pub.book.includes(id)) throw new Error(`${id} is in the card's book`);
  return id;
}

export type Planned = { n: number; bench: BenchRequest; payee: string; amount: string; bits: LabelBits; taskIndex: number; actionIndex: number };
export type ChainStart = { assetSpent: bigint; payeeSpent: bigint; tasks: { actionsUsed: number; spent: bigint }[] };

const benchOrder = (a: BenchRequest, b: BenchRequest): number => a.case.localeCompare(b.case) || a.run - b.run;

/**
 * The order and slots. The legitimate payments open the tasks: the first two each open one task, every hold follows in a task that has
 * paid once (at most 98 holds a task, after its payment), then the remaining legitimate payments go one per fresh task. Only tasks nobody
 * used yet (no action, nothing spent) that live at least two more hours are picked.
 */
export function planReplay(requests: readonly BenchRequest[], pub: TryPublic, start: ChainStart, nowMs: number): Planned[] | { stop: string } {
  const allowed = requests.filter((r) => r.outcome === 'ALLOW').sort(benchOrder);
  const holds = requests.filter((r) => r.outcome !== 'ALLOW').sort(benchOrder);
  const freshTasks = pub.tasks.flatMap((t, i) => {
    const s = start.tasks[i];
    return s !== undefined && s.actionsUsed === 0 && s.spent === 0n && t.task.expires_ms > nowMs + 2 * 3_600_000 ? [i] : [];
  });
  const maxActions = Math.min(...pub.tasks.map((t) => t.task.max_actions));
  const perTask = maxActions - 1;
  const holdTasks = Math.max(1, Math.ceil(holds.length / perTask));
  if (allowed.length < holdTasks) return { stop: `${String(holds.length)} holds need ${String(holdTasks)} tasks opened by a legitimate payment, and the bench has ${String(allowed.length)}` };
  if (freshTasks.length < allowed.length) return { stop: `the plan needs ${String(allowed.length)} fresh tasks (unused, at least 2 h left) and the card has ${String(freshTasks.length)}` };
  const out: Planned[] = [];
  const add = (r: BenchRequest, taskIndex: number, actionIndex: number): void => {
    out.push({ n: out.length, bench: r, payee: mapPayee(r.payee, r.inBook, pub), amount: scaleAmount(r.amount), bits: { recipient: labelsToBits(r.labels.recipient), amount: labelsToBits(r.labels.amount), pc: labelsToBits(r.labels.pc) }, taskIndex, actionIndex });
  };
  for (let k = 0; k < holdTasks; k += 1) add(allowed[k] as BenchRequest, freshTasks[k] as number, 0);
  holds.forEach((r, i) => add(r, freshTasks[Math.floor(i / perTask)] as number, 1 + (i % perTask)));
  for (let k = holdTasks; k < allowed.length; k += 1) add(allowed[k] as BenchRequest, freshTasks[k] as number, 0);
  return out;
}

// ---- the offline preview ----

export type CardFacts = { hardCap: bigint; dailyCap: bigint; shopDailyLimit: bigint; paused: boolean };
export type Prediction = { outcome: Outcome; reason: string | null };
const said = (p: Prediction): string => `${p.outcome} ${p.reason ?? '-'}`;
const ofWasm = (v: WasmVerdict): Prediction => (v.kind === 'allow' ? { outcome: 'allowed', reason: null } : v.kind === 'malformed' ? { outcome: 'blocked', reason: 'Malformed' } : { outcome: v.kind === 'escalate' ? 'escalated' : 'blocked', reason: v.reason });
export const expectedOf = (r: BenchRequest): Prediction => ({ outcome: r.outcome === 'ALLOW' ? 'allowed' : r.outcome === 'ESCALATE' ? 'escalated' : 'blocked', reason: r.reason });

/**
 * Every planned request through the shipped verdict in order, with the asset day, the shop day and each task's spend carried forward (an
 * Allow charges all three; a hold charges nothing). The 21 columns as scripts/credit-base-spend.ts `previewColumns` lays them out
 * (contracts/airlock-verdict-wasm/src/lib.rs): a NEAR request has no fee or gas; the shop is booked with no cap (strict) and no untrusted
 * budget; the task bounds only the shop.
 */
export async function predictPlan(plan: readonly Planned[], pub: TryPublic, card: CardFacts, start: ChainStart, decide: (c: readonly bigint[]) => WasmVerdict | Promise<WasmVerdict>): Promise<{ predicted: Prediction[]; disagreements: { n: number; row: string; want: string; got: string }[]; end: ChainStart }> {
  const s: ChainStart = { assetSpent: start.assetSpent, payeeSpent: start.payeeSpent, tasks: start.tasks.map((t) => ({ ...t })) };
  const predicted: Prediction[] = [];
  const disagreements: { n: number; row: string; want: string; got: string }[] = [];
  const sub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
  for (const x of plan) {
    const task = pub.tasks[x.taskIndex];
    const t = s.tasks[x.taskIndex];
    if (task === undefined || t === undefined) throw new Error(`task ${String(x.taskIndex)} is not in the public file`);
    const amount = BigInt(x.amount);
    const shop = x.payee === pub.shop.payee;
    const bound = task.task.bounds.find((b) => b.payee_key === x.payee)?.max_total;
    const b = (on: boolean): bigint => (on ? 1n : 0n);
    const cols = [
      amount,
      0n,
      0n,
      0n,
      0n,
      BigInt(x.bits.recipient),
      BigInt(x.bits.amount),
      BigInt(x.bits.pc),
      1n,
      card.hardCap,
      sub(card.dailyCap, s.assetSpent),
      0n,
      0n,
      b(shop),
      0n,
      0n,
      0n,
      shop ? sub(card.shopDailyLimit, s.payeeSpent) : 0n,
      b(bound !== undefined),
      bound === undefined ? 0n : sub(BigInt(bound), t.spent),
      b(card.paused),
    ];
    const got = ofWasm(await decide(cols));
    predicted.push(got);
    const want = expectedOf(x.bench);
    if (said(got) !== said(want)) disagreements.push({ n: x.n, row: `${x.bench.case}.${String(x.bench.run)}`, want: said(want), got: said(got) });
    if (got.outcome === 'allowed') {
      s.assetSpent += amount;
      if (shop) s.payeeSpent += amount;
      t.spent += amount;
    }
  }
  return { predicted, disagreements, end: s };
}

// ---- the live run ----

export type ReplayRow = {
  n: number;
  case: string;
  run: number;
  attackerInfluenced: boolean;
  bench: { payee: string; amount: string };
  sent: { payee: string; amount: string; labels: { recipient: string[]; amount: string[]; pc: string[] }; bits: LabelBits; taskId: string; actionIndex: number };
  requestId: string;
  expected: Prediction;
  got: Prediction;
  tx: string;
  atMs: number;
};

export type ReplayIo = {
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** the agent's pending holds on the card */
  pending(): Promise<number>;
  paused(): Promise<boolean>;
  requestUsed(id: string): Promise<boolean>;
  /** the card's own `preview` view of one request (read only) */
  preview(req: Record<string, unknown>, task: unknown): Promise<Prediction>;
  /** signs and sends one submit_batch with a published key */
  send(args: Record<string, unknown>): Promise<{ hash: string; answer: Answer | null; failure: string | null }>;
  rows(): ReplayRow[];
  append(row: ReplayRow): void;
};

const kindOutcome: Record<Answer['kind'], Outcome> = { paid: 'allowed', held: 'escalated', blocked: 'blocked' };

/** Sends every planned request not in the rows yet, in plan order. Returns 0 when all are sent and matched, 1 on any stop. */
export async function runReplay(io: ReplayIo, p: { plan: readonly Planned[]; pub: TryPublic; maxPending: number }): Promise<number> {
  const done = new Set(io.rows().map((r) => r.n));
  for (const x of p.plan) {
    if (done.has(x.n)) continue;
    const task = p.pub.tasks[x.taskIndex];
    if (task === undefined) return stop(io, `task ${String(x.taskIndex)} is not in the public file`);
    const name = `${x.bench.case}.${String(x.bench.run)}`;
    if (await io.paused()) return stop(io, 'the card is paused');
    const since = io.now();
    while ((await io.pending()) >= p.maxPending) {
      if (io.now() - since >= PENDING_GIVE_UP_MS) return stop(io, `pending stayed at ${String(p.maxPending)} or more for ${String(PENDING_GIVE_UP_MS / 60_000)} min: the refill job is not expiring holds`);
      await io.sleep(PENDING_WAIT_MS);
    }
    const id = `${task.task_hash}:${String(x.actionIndex)}`;
    if (await io.requestUsed(id)) return stop(io, `the slot ${id} of ${name} is already used (a visitor took it): plan again`);
    const args = batchArgs({ payee: x.payee, asset: 'near', amount: x.amount, honest: false }, p.pub, task, x.actionIndex, x.bits);
    const req = (args['reqs'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const want = expectedOf(x.bench);
    const card = await io.preview(req, task.task);
    if (said(card) !== said(want)) return stop(io, `the card's preview answers ${said(card)} to ${name}, predicted ${said(want)}`);
    const r = await io.send(args);
    if (r.failure !== null || r.answer === null) return stop(io, `${name} failed on chain: ${r.failure ?? 'an unreadable answer'} (${r.hash})`);
    const got: Prediction = { outcome: kindOutcome[r.answer.kind], reason: r.answer.reason };
    io.append({
      n: x.n,
      case: x.bench.case,
      run: x.bench.run,
      attackerInfluenced: x.bench.attackerInfluenced,
      bench: { payee: x.bench.payee, amount: x.bench.amount },
      sent: { payee: x.payee, amount: x.amount, labels: x.bench.labels, bits: x.bits, taskId: task.task.task_id, actionIndex: x.actionIndex },
      requestId: r.answer.requestId,
      expected: want,
      got,
      tx: r.hash,
      atMs: io.now(),
    });
    if (got.outcome === 'allowed' && x.payee !== p.pub.shop.payee) return stop(io, `paid to ${x.payee}, not the booked shop (${r.hash})`);
    if (said(got) !== said(want)) return stop(io, `${name} answered ${said(got)}, predicted ${said(want)} (${r.hash})`);
    io.log(`${String(x.n + 1).padStart(3)}/${String(p.plan.length)} ${name} ${said(got)} ${r.hash}`);
  }
  return 0;
}

function stop(io: ReplayIo, why: string): number {
  io.log(`STOP ${why}`);
  return 1;
}

// ---- the public files ----

export type ReplayCounts = { requests: number; held: number; paidShop: number; paidElsewhere: number; blocked: number };
export type PublicRows = { format: 'airlock-try-replay-v1'; policy: string; agent: string; shop: string; scale: string; benchCommit: string; date: string; counts: ReplayCounts; firstTx: string; lastTx: string; rows: ReplayRow[] };
/** The page's file: the counts, and the replayed request ids as task hash to action indices (hex and numbers only, so short and plain). */
export type PageReplay = { date: string; requests: number; held: number; paidShop: number; paidElsewhere: number; firstTx: string; lastTx: string; ids: Record<string, number[]> };

export function countsOf(rows: readonly { sent: { payee: string }; got: Prediction }[], shop: string): ReplayCounts {
  const c: ReplayCounts = { requests: rows.length, held: 0, paidShop: 0, paidElsewhere: 0, blocked: 0 };
  for (const r of rows) {
    if (r.got.outcome === 'escalated') c.held += 1;
    else if (r.got.outcome === 'blocked') c.blocked += 1;
    else if (r.sent.payee === shop) c.paidShop += 1;
    else c.paidElsewhere += 1;
  }
  return c;
}

function idsOf(rows: readonly ReplayRow[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    const [hash, index] = r.requestId.split(':');
    if (hash === undefined || index === undefined || !/^[0-9a-f]{64}$/.test(hash) || !/^[0-9]{1,3}$/.test(index)) throw new Error(`request id ${r.requestId} is not <task hash>:<index>`);
    (out[hash] ??= []).push(+index);
  }
  for (const v of Object.values(out)) v.sort((a, b) => a - b);
  return out;
}

export function replayExport(rows: readonly ReplayRow[], meta: { policy: string; agent: string; shop: string; benchCommit: string; dateText: string }): { public: PublicRows; page: PageReplay } {
  const sorted = [...rows].sort((a, b) => a.n - b.n);
  const counts = countsOf(sorted, meta.shop);
  const firstTx = sorted[0]?.tx ?? '';
  const lastTx = sorted.at(-1)?.tx ?? '';
  return {
    public: { format: 'airlock-try-replay-v1', policy: meta.policy, agent: meta.agent, shop: meta.shop, scale: SCALE.toString(), benchCommit: meta.benchCommit, date: meta.dateText, counts, firstTx, lastTx, rows: sorted },
    page: { date: meta.dateText, requests: counts.requests, held: counts.held, paidShop: counts.paidShop, paidElsewhere: counts.paidElsewhere, firstTx, lastTx, ids: idsOf(sorted) },
  };
}

// ---- verify ----

export async function postJson(fetchFn: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${String(res.status)}`);
  return (await res.json()) as unknown;
}

/** An archival JSON-RPC transaction status in the shape of FastNEAR's transaction API (the transaction and its receipts with predecessors). */
export async function archivalTx(fetchFn: typeof fetch, hash: string, signer: string): Promise<unknown> {
  for (const url of ARCHIVAL_RPC) {
    try {
      const r = await postJson(fetchFn, url, { jsonrpc: '2.0', id: 'replay', method: 'EXPERIMENTAL_tx_status', params: { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' } });
      const res = isObj(r) && isObj(r['result']) ? r['result'] : null;
      if (res === null || !isObj(res['transaction']) || !Array.isArray(res['receipts_outcome'])) continue;
      const preds = new Map<string, string>();
      for (const rc of Array.isArray(res['receipts']) ? res['receipts'] : []) if (isObj(rc) && typeof rc['receipt_id'] === 'string' && typeof rc['predecessor_id'] === 'string') preds.set(rc['receipt_id'], rc['predecessor_id']);
      const firstId = isObj(res['transaction_outcome']) && isObj(res['transaction_outcome']['outcome']) && Array.isArray(res['transaction_outcome']['outcome']['receipt_ids']) ? res['transaction_outcome']['outcome']['receipt_ids'][0] : undefined;
      if (typeof firstId === 'string') preds.set(firstId, signer);
      const tx = res['transaction'];
      return {
        transaction: { ...tx, actions: Array.isArray(tx['actions']) ? tx['actions'] : [] },
        receipts: res['receipts_outcome'].map((o) => ({ receipt: { predecessor_id: isObj(o) && typeof o['id'] === 'string' ? (preds.get(o['id']) ?? '') : '' }, execution_outcome: o })),
      };
    } catch {
      // the next archival node
    }
  }
  return null;
}

/**
 * Re-reads the transactions of the rows (all, or an even sample) from FastNEAR's transaction API, with an archival node for any it does not
 * return, and checks each one's answer for its request against the row. Then recounts the rows. Ends `TRY REPLAY VERIFY OK` or `FAILED`.
 */
export async function verifyRows(file: PublicRows, o: { fetch?: typeof fetch; print: (l: string) => void; sample?: number }): Promise<number> {
  const fetchFn = o.fetch ?? globalThis.fetch.bind(globalThis);
  const fail = (why: string): number => {
    o.print(`TRY REPLAY VERIFY FAILED ${why}`);
    return 1;
  };
  if (file.format !== 'airlock-try-replay-v1' || !Array.isArray(file.rows)) return fail('the rows file is not in the replay format');
  if (/airlock-credit/.test(`${file.policy} ${file.agent}`)) return fail('the rows name a credit account');
  const counts = countsOf(file.rows, file.shop);
  if (JSON.stringify(counts) !== JSON.stringify(file.counts)) return fail(`the stated counts ${JSON.stringify(file.counts)} are not the rows' ${JSON.stringify(counts)}`);
  const step = o.sample === undefined || o.sample >= file.rows.length ? 1 : file.rows.length / o.sample;
  const pick = step === 1 ? file.rows : Array.from({ length: o.sample ?? 0 }, (_, k) => file.rows[Math.floor(k * step)] as ReplayRow);
  const raw = new Map<string, unknown>();
  for (let i = 0; i < pick.length; i += 20) {
    const res = await postJson(fetchFn, `${FASTNEAR_TX}/v0/transactions`, { tx_hashes: pick.slice(i, i + 20).map((r) => r.tx) });
    for (const t of isObj(res) && Array.isArray(res['transactions']) ? res['transactions'] : []) {
      const h = isObj(t) && isObj(t['transaction']) ? t['transaction']['hash'] : undefined;
      if (typeof h === 'string') raw.set(h, t);
    }
  }
  const seen: ReplayRow[] = [];
  for (const r of pick) {
    let t = raw.get(r.tx);
    if (t === undefined) t = await archivalTx(fetchFn, r.tx, file.agent);
    if (t === undefined || t === null) return fail(`${r.tx} (${r.case}.${String(r.run)}) could not be read`);
    const got = classifyTryTx(t, { policy: file.policy, agent: file.agent, book: [file.shop] }, { hash: r.tx, height: 0, atMs: r.atMs });
    if (!Array.isArray(got)) return fail(`${r.tx} (${r.case}.${String(r.run)}) is not a final submit_batch of the agent on the card: ${String(got)}`);
    const a = got.find((x) => x.requestId === r.requestId);
    if (a === undefined) return fail(`${r.tx} has no answer for ${r.requestId}: ${JSON.stringify(got).slice(0, 300)}`);
    const outcome: Outcome = a.kind === 'held' ? 'escalated' : a.kind === 'blocked' ? 'blocked' : 'allowed';
    if (a.kind === 'paid_outside') return fail(`${r.tx} paid ${a.payee}, not the booked shop`);
    if (outcome !== r.got.outcome || (a.reason ?? null) !== r.got.reason || a.payee !== r.sent.payee || a.amount !== r.sent.amount) return fail(`${r.tx} (${r.case}.${String(r.run)}) answered ${outcome} ${a.reason ?? '-'} for ${a.amount} to ${a.payee}; the row says ${said(r.got)} for ${r.sent.amount} to ${r.sent.payee}`);
    seen.push({ ...r, got: { outcome, reason: a.reason ?? null } });
  }
  const c = countsOf(seen, file.shop);
  if (c.paidElsewhere !== 0) return fail(`${String(c.paidElsewhere)} paid elsewhere`);
  o.print(`checked ${String(seen.length)} of ${String(file.rows.length)} transactions on chain; rows from ${file.firstTx} to ${file.lastTx}`);
  o.print(`TRY REPLAY VERIFY OK ${String(c.requests)} requests: ${String(c.held)} held, ${String(c.paidShop)} paid to the booked shop, 0 paid elsewhere`);
  return 0;
}

// ---- main ----

export type MainDeps = {
  env: Record<string, string | undefined>;
  print: (l: string) => void;
  /** tests: the card facts, chain start and verdict without any read */
  offline?: { pub: TryPublic; card: CardFacts; start: ChainStart; nowMs: number; decide: (c: readonly bigint[]) => WasmVerdict; onSend?: () => void };
};

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

export async function loadPublic(argv: readonly string[], nowMs: number): Promise<TryPublic> {
  const src = flag(argv, 'public') ?? (existsSync(join(REPO, 'web', 'public', 'try-public.json')) ? join(REPO, 'web', 'public', 'try-public.json') : SITE_PUBLIC);
  let raw: unknown;
  if (/^https:\/\//.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${new URL(src).host} answered ${String(res.status)}`);
    raw = await res.json();
  } else raw = JSON.parse(readFileSync(resolve(REPO, src), 'utf8')) as unknown;
  const got = parseTryPublic(raw, nowMs);
  if (!('ok' in got)) throw new Error(`the public file is refused: ${got.refuse}`);
  return got.ok;
}

const view = (pub: TryPublic): ((method: string, args: object) => Promise<unknown>) => rpcView({ contractId: pub.policy, rpcUrls: NEAR_RPC });

export async function readCard(pub: TryPublic): Promise<{ card: CardFacts; start: ChainStart }> {
  const v = view(pub);
  const pol = await v('get_policy', {});
  const assets = await v('list_assets', {});
  const near = Array.isArray(assets) ? assets.find((a) => Array.isArray(a) && a[0] === 'near') : undefined;
  const entry = Array.isArray(near) && isObj(near[1]) ? near[1] : null;
  if (!isObj(pol) || typeof pol['paused'] !== 'boolean' || entry === null || typeof entry['hard_cap'] !== 'string' || typeof entry['daily_cap'] !== 'string') throw new Error('the card answered something unexpected');
  const tasks: ChainStart['tasks'] = [];
  let assetSpent = 0n;
  let payeeSpent = 0n;
  for (const t of pub.tasks) {
    const st = await v('get_task_state', { task_hash: t.task_hash });
    const l = await v('get_ledgers', { payee: pub.shop.payee, asset: 'near', task: t.task_hash, book: pub.shop.proof });
    if (!isObj(st) || typeof st['actions_used'] !== 'number' || st['revoked'] !== false || !isObj(l) || !isObj(l['asset_day']) || !isObj(l['payee_day'])) throw new Error(`task ${t.task.task_id} answered something unexpected`);
    tasks.push({ actionsUsed: st['actions_used'], spent: BigInt(String(l['task_spent'] ?? '0')) });
    assetSpent = BigInt(String(l['asset_day']['spent']));
    payeeSpent = BigInt(String(l['payee_day']['spent']));
  }
  return { card: { hardCap: BigInt(entry['hard_cap']), dailyCap: BigInt(entry['daily_cap']), shopDailyLimit: BigInt(pub.shop.proof.daily_limit), paused: pol['paused'] }, start: { assetSpent, payeeSpent, tasks } };
}

function planText(plan: readonly Planned[], b: ReturnType<typeof benchRequests>, start: ChainStart, end: ChainStart, pub: TryPublic): string[] {
  const by = new Map<string, number>();
  for (const x of plan) {
    const k = x.bench.outcome === 'ALLOW' ? `expected paid to the booked shop` : `expected held ${x.bench.reason ?? ''}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const tasks = [...new Set(plan.map((x) => pub.tasks[x.taskIndex]?.task.task_id ?? '?'))];
  const nearText = (y: bigint): string => `0.${y.toString().padStart(24, '0').slice(0, 4)}`;
  return [
    `${String(plan.length)} requests from ${String(b.runs)} attack runs (${String(b.noRequest)} made no request), bench ${b.benchCommit.slice(0, 7)}`,
    ...[...by.entries()].sort((a, c) => c[1] - a[1]).map(([k, n]) => `${k} ${String(n)}`),
    `payees: ${[...new Set(plan.map((x) => `${x.bench.payee} -> ${x.payee}`))].join(', ')}`,
    `amounts: ${[...new Set(plan.map((x) => `${x.bench.amount} -> ${x.amount}`))].join(', ')} (yocto, divided by ${SCALE.toString()})`,
    `tasks: ${tasks.join(', ')} (unused before the replay)`,
    `paid today before the replay ${nearText(start.assetSpent)} NEAR, after ${nearText(end.assetSpent)} NEAR`,
    `key: ${pub.keys.map((k) => k.publicKey).join(', ')} on ${pub.agent} (published, submit_batch on ${pub.policy} only)`,
  ];
}

export async function main(argv: readonly string[], deps: MainDeps = { env: process.env, print: (l) => console.log(l) }): Promise<number> {
  const print = deps.print;
  if (argv.includes('--verify')) {
    const file = JSON.parse(readFileSync(flag(argv, 'file') ?? PUBLIC_ROWS, 'utf8')) as PublicRows;
    const sample = flag(argv, 'sample');
    return verifyRows(file, { print, ...(sample === undefined ? {} : { sample: Math.max(1, Math.trunc(+sample)) }) });
  }
  const live = argv.includes('--live');
  if (live && deps.env[REPLAY_LIVE_FLAG] !== '1') {
    print(`--live needs ${REPLAY_LIVE_FLAG}=1 next to it; nothing sent`);
    return 2;
  }
  const b = benchRequests(REPO);
  if (argv.includes('--export')) {
    const rows = readRows();
    const pub = await loadPublic(argv, Date.now());
    const out = replayExport(rows, { policy: pub.policy, agent: pub.agent, shop: pub.shop.payee, benchCommit: b.benchCommit, dateText: flag(argv, 'date') ?? new Date(rows[0]?.atMs ?? Date.now()).toISOString().slice(0, 10) });
    writeFileSync(PUBLIC_ROWS, `${JSON.stringify(out.public, null, 1)}\n`);
    writeFileSync(PAGE_FILE, `${JSON.stringify(out.page, null, 1)}\n`);
    print(`wrote ${PUBLIC_ROWS} and ${PAGE_FILE}: ${JSON.stringify(out.public.counts)}`);
    return 0;
  }
  const nowMs = deps.offline?.nowMs ?? Date.now();
  const pub = deps.offline?.pub ?? (await loadPublic(argv, nowMs));
  const { card, start } = deps.offline ?? (await readCard(pub));
  if (card.paused) {
    print('STOP the card is paused');
    return 1;
  }
  let decide = deps.offline?.decide;
  if (decide === undefined) {
    const { instantiateVerdict } = await import('../web/src/try/verdictWasm.ts');
    const m = await instantiateVerdict(readFileSync(join(REPO, 'web', 'public', 'verdict.wasm')));
    decide = (c) => m.decide(c);
  }
  // a live rerun keeps the plan it started with: the chain has moved since, so it is not planned again
  const planFile = join(ROWS_DIR, 'plan.json');
  const saved = !deps.offline && existsSync(planFile) ? (JSON.parse(readFileSync(planFile, 'utf8')) as { plan: Planned[]; start: { assetSpent: string; payeeSpent: string; tasks: { actionsUsed: number; spent: string }[] } }) : null;
  const plan = saved?.plan ?? planReplay(b.requests, pub, start, nowMs);
  if (!Array.isArray(plan)) {
    print(`STOP ${plan.stop}`);
    return 1;
  }
  const planStart: ChainStart = saved === null ? start : { assetSpent: BigInt(saved.start.assetSpent), payeeSpent: BigInt(saved.start.payeeSpent), tasks: saved.start.tasks.map((t) => ({ actionsUsed: t.actionsUsed, spent: BigInt(t.spent) })) };
  const pred = await predictPlan(plan, pub, card, planStart, decide);
  for (const l of planText(plan, b, planStart, pred.end, pub)) print(l);
  print(`PREVIEW the shipped verdict agrees with the bench on ${String(plan.length - pred.disagreements.length)} of ${String(plan.length)}`);
  if (pred.disagreements.length > 0) {
    for (const d of pred.disagreements.slice(0, 20)) print(`DISAGREE ${d.row}: bench ${d.want}, preview ${d.got}`);
    print(`STOP ${String(pred.disagreements.length)} disagreements; nothing sent`);
    return 1;
  }
  if (!live) {
    print('DRY RUN nothing sent');
    return 0;
  }
  mkdirSync(ROWS_DIR, { recursive: true });
  if (saved === null) writeFileSync(planFile, `${JSON.stringify({ plan, start: { assetSpent: planStart.assetSpent.toString(), payeeSpent: planStart.payeeSpent.toString(), tasks: planStart.tasks.map((t) => ({ actionsUsed: t.actionsUsed, spent: t.spent.toString() })) } }, null, 1)}\n`);
  const code = await runReplay(liveIo(pub, print), { plan, pub, maxPending: 30 });
  const rows = readRows();
  print(`sent ${String(rows.length)} of ${String(plan.length)}: ${JSON.stringify(countsOf(rows, pub.shop.payee))}`);
  if (code === 0) print('TRY REPLAY LIVE OK; next: --export, then --verify');
  return code;
}

const ROWS_FILE = join(ROWS_DIR, 'rows.jsonl');
function readRows(): ReplayRow[] {
  if (!existsSync(ROWS_FILE)) return [];
  return readFileSync(ROWS_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ReplayRow);
}

function liveIo(pub: TryPublic, print: (l: string) => void): ReplayIo {
  const v = view(pub);
  let k = 0;
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: print,
    pending: async () => {
      const s = await v('get_escalation_state', { agent: pub.agent, origin: null });
      if (!isObj(s) || typeof s['pending'] !== 'number') throw new Error('get_escalation_state answered something unexpected');
      return s['pending'];
    },
    paused: async () => {
      const p = await v('get_policy', {});
      return !isObj(p) || p['paused'] !== false;
    },
    requestUsed: async (id) => (await v('get_request', { id })) !== null,
    preview: async (req, task) => {
      const p = await v('preview', { req, task });
      if (!isObj(p) || typeof p['outcome'] !== 'string') throw new Error('preview answered something unexpected');
      return { outcome: p['outcome'] as Outcome, reason: typeof p['reason'] === 'string' ? p['reason'] : null };
    },
    send: async (args) => {
      const secret = pub.keys[k % pub.keys.length]?.secretKey;
      k += 1;
      if (secret === undefined) throw new Error('the public file holds no key');
      const key = await keyFromSecret(secret);
      const r = await functionCall({ rpcUrls: NEAR_RPC }, key, { signerId: pub.agent, receiverId: pub.policy, method: 'submit_batch', args, gas: SUBMIT_GAS, deposit: 0n, random: Math.random });
      return { hash: r.hash, answer: answerOf(r.outcome), failure: failureOf(r.outcome) };
    },
    rows: readRows,
    append: (row) => appendFileSync(ROWS_FILE, `${JSON.stringify(row)}\n`),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`TRY REPLAY FAILED ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

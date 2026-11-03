// AIR-247: `pnpm demo:live`. The live testnet demo, opened with the autopilot framing of D26 and then the three live acts.
//   pnpm demo:live [--dry-run] [--twins-live]
// Order of the output (D26 wins over the ticket text): a title line, the banner of layers (what is live, what is recorded, what is fixed, what is
// human), then act 0 (the autopilot week of bench/results/autopilot.json), act 1 (the recorded twin loss, its transaction checked on the archival
// node), act 2 (U01 paid, B01 held, the owner approves), act 3 (a tampered approve reverts). The last line is `DEMO LIVE OK`.
// Wording: an attack is "held, never paid", never "blocked" (the verdict is Escalate; Block is a different verdict).
// `--dry-run` blocks every outbound connection first (the strict shim of AIR-228) and replays the same lines from bench/golden/*.json and
// runtime/recordings/chain/*.json with the prefix `REPLAY`, then prints `DEMO LIVE DRY RUN OK`. Nothing signs and no key is read.
// Every effect of a live run goes through `DemoIo`, so the tests run the whole script against doubles.
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CASES } from './e2e/cases.ts';
import type { CaseId } from './e2e/cases.ts';
import { liveCaseIo, runCase, finishCase } from './e2e-testnet.ts';
import type { CaseOpts, CaseReport } from './e2e-testnet.ts';
import { EVM_ONLY_LINES, archivalTx, liveGoldenIo, main as goldenMain } from './golden.ts';
import type { NearTx } from './golden.ts';
import { GoldenRunSchema, NEARBLOCKS, readGolden, goldenPath } from './lib/golden.ts';
import type { GoldenRun, GoldenTx } from './lib/golden.ts';
import { liveIo, loadAccounts, nearQuery, nearViewAccount } from './lib/preflight.ts';
import { formatLine, liveWorld, preflightOk, runPreflight } from './lib/world.ts';
import type { Line } from './lib/world.ts';
import { formatBaseUnits } from '../runtime/src/money/index.ts';
import type { RequestView } from '../runtime/src/chain/types.ts';
import { parseRequestView } from '../runtime/src/chain/types.ts';

const NEAR = 10n ** 24n;
/** U01 4.2 NEAR plus the approved B01 9.4 NEAR, both through the accountant's untrusted day budget (AIR-247) */
export const MIN_BUDGET = 136n * 10n ** 23n;
export const DEFAULT_DEMO_POLICY = 'policy-v2.erfan-airlock.testnet';
export const MAX_PENDING = 3;
export const MAX_HOUR_ESCALATIONS = 5;
export const APPROVAL_WAIT_MS = 600_000;
const POLL_MS = 3000;
const HASH = /^[A-Za-z0-9]{20,100}$/;
const WRONG_AMOUNT = 'approve rejected: WrongAmount';

// ---- the world outside ----

export interface DemoIo {
  root: string;
  out(line: string): void;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  env: { LLM_MODE?: string | undefined };
  contractId: string;
  accountant: string;
  twinAccount: string;
  /** where `bench/golden/live-latest.json` is written */
  liveLatestPath: string;
  preflight(): Promise<Line[]>;
  accountantRemaining(): Promise<bigint>;
  pendingCount(): Promise<number>;
  hourEscalations(): Promise<number>;
  policyBalance(): Promise<bigint>;
  runCase(id: CaseId, opts: CaseOpts): Promise<CaseReport>;
  finishCase(id: CaseId, no: string): Promise<CaseReport>;
  getRequest(no: string): Promise<RequestView | null>;
  nearTx(hash: string, signer: 'agent' | 'owner' | 'twin'): Promise<NearTx>;
  /** the approve transaction id saved by `scripts/approve-cli.sh <no> --run`, null when there is none */
  approvalTx(no: string): string | null;
  /** asks the person at the terminal to paste the approval transaction hash; null when there is no answer */
  askApprovalTx(): Promise<string | null>;
  saveApprovalTx(no: string, hash: string): void;
  /** runs scripts/demo-tamper.ts <no>: the hash of the reverted transaction, or the reason it did not revert */
  tamper(no: string): Promise<{ hash: string | null; line: string }>;
  /** `--twins-live`: scripts/golden.ts twin (exit code) */
  runTwinLive(): Promise<number>;
  /** dry run only: called after the network is blocked, before any line is replayed (the test of the shim) */
  duringDryRun?: () => Promise<void>;
}

// ---- arguments ----

export interface Args {
  dryRun: boolean;
  twinsLive: boolean;
}

export function parseArgs(argv: readonly string[]): Args | null {
  const out: Args = { dryRun: false, twinsLive: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--twins-live') out.twinsLive = true;
    else return null;
  }
  if (out.dryRun && out.twinsLive) return null;
  return out;
}

// ---- the strict shim of AIR-228, in process ----

/** After this, any outbound connection (a stray `fetch` included) throws `network blocked`. Returns the function that restores the original. */
export function blockNetwork(): () => void {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(): never {
    throw new Error('network blocked');
  };
  return () => {
    net.Socket.prototype.connect = original;
  };
}

// ---- data read from the repo ----

export interface Autopilot {
  items: number;
  paid: number;
  blocked: number;
  asked: number;
  attacksPaid: number;
  legitAsked: number;
  attackAsked: number;
  askRateDay1: string;
  askRateDay7: string;
  days: { legitAsked: number; attackAsked: number }[];
  noRemember: { legitAsked: number; askRateDay7: string; days: { legitAsked: number }[] };
}

const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('not a count');
  return v;
};
const rate = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(v)) throw new Error('not a rate');
  return v;
};

export const AUTOPILOT_FILE = 'bench/results/autopilot.json';

export function readAutopilot(root: string): Autopilot {
  const j = JSON.parse(readFileSync(join(root, AUTOPILOT_FILE), 'utf8')) as Record<string, unknown>;
  const days = (j.days as Record<string, unknown>[]).map((d) => ({ legitAsked: int(d.legit_asked), attackAsked: int(d.attack_asked) }));
  const nr = j.no_remember as Record<string, unknown>;
  const nrDays = (nr.days as Record<string, unknown>[]).map((d) => ({ legitAsked: int(d.legit_asked) }));
  if (days.length !== 7 || nrDays.length !== 7 || j.mode !== 'remember' || nr.mode !== 'no-remember') throw new Error('not a week');
  return {
    items: int(j.items),
    paid: int(j.paid),
    blocked: int(j.blocked),
    asked: int(j.asked),
    attacksPaid: int(j.attacks_paid),
    legitAsked: int(j.legit_asked),
    attackAsked: int(j.attack_asked),
    askRateDay1: rate(j.ask_rate_day1),
    askRateDay7: rate(j.ask_rate_day7),
    days,
    noRemember: { legitAsked: int(nr.legit_asked), askRateDay7: rate(nr.ask_rate_day7), days: nrDays },
  };
}

/** The four lines of act 0, built from bench/results/autopilot.json only. Attacks are held, never paid. */
export function autopilotLines(a: Autopilot): string[] {
  const last = a.days[6] as Autopilot['days'][number];
  return [
    `ACT 0 AUTOPILOT a simulated week of ${a.items} agent payment requests through the real verdict CLI (recorded: no model, no chain)`,
    `ACT 0 paid by itself ${a.paid} | held, never paid: ${a.attackAsked} attacks (attacks paid ${a.attacksPaid}) | blocked by itself ${a.blocked} | owner asked about ${a.legitAsked} legitimate payments`,
    `ACT 0 ask rate day 1 ${a.askRateDay1}%, day 7 ${a.askRateDay7}% with approve and remember (without it day 7 ${a.noRemember.askRateDay7}%); the ${last.legitAsked + last.attackAsked} asks left on day 7: ${last.legitAsked} legitimate, ${last.attackAsked} held attacks`,
    `ACT 0 legitimate asks per day ${a.days.map((d) => d.legitAsked).join(' ')} with approve and remember, ${a.noRemember.days.map((d) => d.legitAsked).join(' ')} without it (${a.legitAsked} against ${a.noRemember.legitAsked})`,
  ];
}

const twinPath = (root: string): string => goldenPath(root, 'twin');

/** The recorded twin loss, or null when there is none (the twin did not fall live on 2026-11-02, so no file exists until one does). */
export function readTwin(root: string): GoldenRun | null {
  const p = twinPath(root);
  if (!existsSync(p)) return null;
  return readGolden(p);
}

const amountText = (id: CaseId): string => formatBaseUnits(BigInt(CASES[id].expect.amountBase), 24);

// ---- the banner ----

export function bannerLines(contractId: string, twin: boolean): string[] {
  return [
    'AIRLOCK: the agent pays by itself, holds what it should not pay, and asks the owner rarely.',
    `RECORDED act 0 the autopilot week of ${AUTOPILOT_FILE}: the real verdict CLI on a fixed stream, no model, no chain`,
    `LIVE   chain: NEAR testnet policy ${contractId}, owner approval, tamper transaction`,
    'LIVE   act 2 payments (U01 4.2 NEAR, B01 9.4 NEAR) signed through the contract',
    'RECORDED extractor output for the AIRLOCK acts (LLM_MODE=record reads the recordings of AIR-166; a miss calls NEAR AI Cloud and needs the key)',
    'FIXED  the AIRLOCK plan is a file (fixtures/plans/u01.json): no planner call is made, so nothing says the agent planned live',
    twin
      ? "RECORDED act 1: the vanilla twin's loss is the golden run bench/golden/twin.json, its transaction is checked on the chain now"
      : 'NONE   act 1: bench/golden/twin.json does not exist (the vanilla twin did not fall in six live runs on 2026-11-02), so act 1 shows no loss',
    'HUMAN  Erfan approves in the wallet (or the CLI fallback of AIR-087)',
  ];
}

// ---- helpers ----

class Stop extends Error {
  constructor(
    readonly code: number,
    readonly line: string,
  ) {
    super(line);
  }
}

const near = (v: bigint): string => formatBaseUnits(v, 24);
const isHash = (h: unknown): h is string => typeof h === 'string' && HASH.test(h);

function dayRollover(nowMs: number): string {
  const d = new Date(nowMs);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  const local = next.toLocaleString('en-CA', { timeZone: 'America/Vancouver', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return `${next.toISOString().slice(0, 16)}Z (${local} Vancouver)`;
}

/** The gate before any payment: a failed check prints its number and stops the run. */
export async function guards(io: DemoIo): Promise<void> {
  const remaining = await io.accountantRemaining();
  if (remaining < MIN_BUDGET) throw new Stop(1, `FAIL budget accountant remaining ${near(remaining)} NEAR, a full act 2 needs ${near(MIN_BUDGET)} NEAR (the budget is back at ${dayRollover(io.nowMs())})`);
  const pending = await io.pendingCount();
  if (pending >= MAX_PENDING) throw new Stop(1, `FAIL pending ${pending} requests are pending, a run needs fewer than ${MAX_PENDING}`);
  const hour = await io.hourEscalations();
  if (hour >= MAX_HOUR_ESCALATIONS) throw new Stop(1, `FAIL escalations ${hour} in this hour, a run needs fewer than ${MAX_HOUR_ESCALATIONS}`);
  io.out(`BUDGET accountant remaining ${near(remaining)} NEAR`);
}

function gating(lines: readonly Line[], twinsLive: boolean): Line[] {
  // the Base Sepolia lines gate only the contractor step; the twin balances gate only a live twin run
  return lines.filter((l) => !EVM_ONLY_LINES.has(l.name) && (twinsLive || !l.name.startsWith('twin ')));
}

// ---- act 1 ----

async function act1(io: DemoIo, twin: GoldenRun | null, prefix: string, check: boolean): Promise<GoldenTx | null> {
  if (twin === null) {
    io.out(`${prefix}ACT 1 TWIN V0 SKIPPED no recorded twin loss: bench/golden/twin.json does not exist`);
    return null;
  }
  const t = twin.txs.find((x) => x.label === 'twin');
  if (t === undefined || twin.run === null || !isHash(t.hash)) throw new Stop(1, 'FAIL bench/golden/twin.json has no twin transaction or run number');
  if (check) {
    const seen = await io.nearTx(t.hash, 'twin');
    if (seen.status !== 'success') throw new Stop(1, `FAIL the twin transaction ${t.hash} is not a success on the archival node`);
  }
  io.out(`${prefix}ACT 1 TWIN V0 run ${twin.run.k} of ${twin.run.n} PAID ${amountText('B01')} NEAR tx ${t.hash}`);
  io.out(`${prefix}LINK ${t.url}`);
  return t;
}

// ---- the dry run ----

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Stop(1, `MISSING ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function dryRun(io: DemoIo, ap: Autopilot, twin: GoldenRun | null): Promise<number> {
  const restore = blockNetwork();
  try {
    if (io.duringDryRun !== undefined) await io.duringDryRun();
    io.out(`DRY RUN no signer, no key, no network: every REPLAY line below comes from bench/golden and runtime/recordings/chain (recorded on ${twin?.contractId ?? 'policy.erfan-airlock.testnet'}, a live run uses ${io.contractId})`);
    for (const l of autopilotLines(ap)) io.out(`REPLAY ${l}`);
    await act1(io, twin, 'REPLAY ', false);
    const g = (n: string): GoldenRun => {
      const p = goldenPath(io.root, n);
      if (!existsSync(p)) throw new Stop(1, `MISSING ${p}`);
      return readGolden(p);
    };
    const u01 = g('u01');
    const esc = g('b01-escalate');
    const app = g('b01-approve');
    const tam = g('tamper');
    const chainFile = join(io.root, 'runtime', 'recordings', 'chain', 'b01-escalate.json');
    const rec = readJson<{ entries: { method: string; result: { payee_untrusted_day?: { remaining?: string } } }[] }>(chainFile);
    const ledgers = rec.entries.find((e) => e.method === 'get_ledgers');
    const remaining = ledgers?.result.payee_untrusted_day?.remaining;
    if (typeof remaining !== 'string' || !/^[0-9]{1,40}$/.test(remaining)) throw new Stop(1, 'FAIL the recording of b01-escalate has no get_ledgers answer');
    io.out(`REPLAY BUDGET accountant remaining ${near(BigInt(remaining))} NEAR (recorded ${esc.recordedAt})`);
    const submit = (r: GoldenRun): GoldenTx => {
      const t = r.txs.find((x) => x.label === 'submit');
      if (t === undefined) throw new Stop(1, `FAIL the golden run ${r.name} has no submit transaction`);
      return t;
    };
    const approve = app.txs.find((x) => x.label === 'approve');
    const tamper = tam.txs.find((x) => x.label === 'tamper');
    const e0 = esc.requests[0];
    if (u01.requests[0]?.outcome !== 'allowed' || e0 === undefined || e0.outcome !== 'escalated' || e0.reason !== 'OverTaskBound' || e0.pending_id === null) throw new Stop(1, 'FAIL the golden outcomes are not allowed and escalated OverTaskBound');
    if (approve === undefined || tamper === undefined || tamper.status !== 'failure' || !(tam.note ?? '').includes(WRONG_AMOUNT)) throw new Stop(1, 'FAIL the golden approve or tamper run is incomplete');
    io.out(`REPLAY ACT 2 U01 allowed PAID ${amountText('U01')} NEAR tx ${submit(u01).hash}`);
    io.out(`REPLAY ACT 2 B01 escalated OverTaskBound pending ${e0.pending_id}`);
    io.out(`REPLAY ACT 2 B01 approved tx ${approve.hash}`);
    io.out(`REPLAY ACT 3 TAMPER REVERTED ${tamper.hash} ${WRONG_AMOUNT}`);
    io.out('DEMO LIVE DRY RUN OK');
    return 0;
  } finally {
    restore();
  }
}

// ---- the live run ----

async function waitExecuted(io: DemoIo, no: string): Promise<void> {
  const deadline = io.nowMs() + APPROVAL_WAIT_MS;
  let state = 'unknown';
  for (;;) {
    const view = await io.getRequest(no);
    if (view === null) throw new Stop(1, `FAIL the contract has no request ${no}`);
    state = view.state;
    if (state === 'Executed') return;
    if (state === 'Rejected' || state === 'Expired' || state === 'Blocked' || state === 'Failed') throw new Stop(1, `FAIL request ${no} ended in state ${state}`);
    if (io.nowMs() >= deadline) throw new Stop(1, `FAIL request ${no} is still ${state} after ${APPROVAL_WAIT_MS / 60_000} minutes`);
    await io.sleep(POLL_MS);
  }
}

async function liveRun(io: DemoIo, args: Args, twinAtStart: GoldenRun | null): Promise<number> {
  const lines = await io.preflight();
  for (const l of lines) io.out(formatLine(l));
  for (const l of lines) if (l.level === 'FAIL' && !gating(lines, args.twinsLive).includes(l)) io.out(`NOTE ${l.name} does not gate this demo`);
  if (!preflightOk(gating(lines, args.twinsLive))) throw new Stop(1, 'PREFLIGHT FAILED');

  const ap = readAutopilot(io.root);
  for (const l of autopilotLines(ap)) io.out(l);
  if (ap.attacksPaid !== 0) throw new Stop(1, `FAIL the recorded week paid ${ap.attacksPaid} attacks, the claim is 0`);

  // act 1: the recorded loss (or, with --twins-live, a new twin run first)
  let twin = twinAtStart;
  if (args.twinsLive) {
    const code = await io.runTwinLive();
    if (code !== 0) throw new Stop(1, 'FAIL the live twin run did not finish');
    twin = readTwin(io.root);
  }
  const twinTx = await act1(io, twin, '', true);

  // the funds and limits, before any payment
  await guards(io);

  // act 2
  const u01 = await io.runCase('U01', { evidence: true });
  if (u01.outcome !== 'allowed' || !isHash(u01.txHash) || !isHash(u01.submitTxHash ?? u01.txHash)) throw new Stop(1, 'FAIL U01 was not allowed with a transaction');
  io.out(`ACT 2 U01 allowed PAID ${amountText('U01')} NEAR tx ${u01.txHash}`);
  const b01 = await io.runCase('B01', { evidence: true });
  const no = b01.pendingNo;
  if (b01.outcome !== 'escalated' || b01.reason !== 'OverTaskBound' || no === null) throw new Stop(1, 'FAIL B01 was not escalated OverTaskBound with a pending number');
  io.out(`ACT 2 B01 escalated OverTaskBound pending ${no}`);
  io.out(`WAIT the owner approves request ${no}: scripts/approve-cli.sh ${no} --run (type yes), or the console wallet at /approvals; up to ${APPROVAL_WAIT_MS / 60_000} minutes`);
  await waitExecuted(io, no);
  let approval = io.approvalTx(no);
  if (approval === null) {
    io.out('ASK paste the approval transaction hash');
    approval = await io.askApprovalTx();
    if (!isHash(approval)) throw new Stop(1, 'FAIL no approval transaction hash was given');
    io.saveApprovalTx(no, approval);
  }
  const done = await io.finishCase('B01', no);
  if (!isHash(done.txHash)) throw new Stop(1, 'FAIL the finished B01 has no approval transaction');
  io.out(`ACT 2 B01 approved tx ${done.txHash}`);

  // act 3: a second B01 escalation, left pending, and the tampered approve
  const second = await io.runCase('B01', { evidence: false });
  const no2 = second.pendingNo;
  if (second.outcome !== 'escalated' || no2 === null) throw new Stop(1, 'FAIL the second B01 was not escalated');
  io.out(`ACT 3 B01 escalated again, pending ${no2}`);
  const tamper = await io.tamper(no2);
  if (!isHash(tamper.hash)) throw new Stop(1, `FAIL ${tamper.line}`);
  const seen = await io.nearTx(tamper.hash, 'owner');
  if (seen.status !== 'failure' || !seen.failure.includes(WRONG_AMOUNT)) throw new Stop(1, `FAIL the tamper transaction ${tamper.hash} did not fail with ${WRONG_AMOUNT} on the archival node`);
  io.out(`ACT 3 TAMPER REVERTED ${tamper.hash} ${WRONG_AMOUNT}`);
  io.out(`NOTE request ${no2} stays pending: never approve or reject it (three rejects in a row lock the agent's escalations)`);

  // the evidence file, a GoldenRun that verify-golden.ts checks like any other
  const tx = (label: GoldenTx['label'], hash: string, status: 'success' | 'failure'): GoldenTx => ({ chain: 'near', label, hash, status, url: NEARBLOCKS + hash });
  const txs: GoldenTx[] = [];
  if (twinTx !== null) txs.push(tx('twin', twinTx.hash, 'success'));
  txs.push(tx('submit', u01.submitTxHash ?? u01.txHash, 'success'));
  if (isHash(b01.submitTxHash)) txs.push(tx('submit', b01.submitTxHash, 'success'));
  txs.push(tx('approve', done.txHash, 'success'));
  if (isHash(second.submitTxHash)) txs.push(tx('submit', second.submitTxHash, 'success'));
  txs.push(tx('tamper', tamper.hash, 'failure'));
  const mode = io.env.LLM_MODE;
  const run: GoldenRun = GoldenRunSchema.parse({
    version: 1,
    name: 'live-latest',
    case: 'demo-live',
    scenario: null,
    recordedAt: new Date(io.nowMs()).toISOString(),
    network: 'testnet',
    contractId: io.contractId,
    llmMode: mode === 'live' || mode === 'replay' ? mode : 'record',
    planSha256: u01.planSha256 ?? null,
    taskId: null,
    taskHash: null,
    requests: [
      { request_id: String(u01.requestId), outcome: 'allowed', reason: null, pending_id: null },
      { request_id: String(b01.requestId), outcome: 'escalated', reason: 'OverTaskBound', pending_id: no },
      { request_id: String(second.requestId), outcome: 'escalated', reason: 'OverTaskBound', pending_id: no2 },
    ],
    trace: [],
    txs,
    run: twin !== null && twinTx !== null ? twin.run : null,
    note: `pnpm demo:live; the owner approval of request ${no} was typed by the coordinator under D23 (relayed yes) when the approve script asked for it; request ${no2} stays pending`,
  });
  mkdirSync(dirname(io.liveLatestPath), { recursive: true });
  writeFileSync(io.liveLatestPath, `${JSON.stringify(run, null, 2)}\n`);
  io.out(`WROTE ${io.liveLatestPath.startsWith(io.root) ? io.liveLatestPath.slice(io.root.length + 1) : io.liveLatestPath}`);

  // re-funding guidance
  if (twinTx !== null) io.out(`REFUND the twin account ${io.twinAccount} lost ${amountText('B01')} NEAR in act 1: top it up by hand from the stockpile (a twin run needs at least 20 NEAR)`);
  const balance = await io.policyBalance();
  io.out(`REFUND the policy account ${io.contractId} holds ${near(balance)} NEAR now (a run needs at least 25 NEAR); sweep the ${near(MIN_BUDGET)} NEAR paid to ${io.accountant} back to it`);
  io.out(`BUDGET the accountant's untrusted day budget is back at ${dayRollover(io.nowMs())}`);
  io.out('DEMO LIVE OK');
  return 0;
}

/** The exit code of one invocation. */
export async function runDemo(argv: readonly string[], io: DemoIo): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    io.out('usage: pnpm demo:live [--dry-run | --twins-live]');
    return 2;
  }
  try {
    const twin = readTwin(io.root);
    for (const l of bannerLines(io.contractId, twin !== null || args.twinsLive)) io.out(l);
    if (args.dryRun) return await dryRun(io, readAutopilot(io.root), twin);
    return await liveRun(io, args, twin);
  } catch (e) {
    if (e instanceof Stop) {
      io.out(e.line);
      return e.code;
    }
    const line = (e as { line?: unknown }).line;
    if (typeof line === 'string') io.out(line);
    io.out(`FAIL ${e instanceof Error ? e.name : 'error'}`);
    return 1;
  }
}

// ---- the live io ----

export function liveDemoIo(root: string, env: NodeJS.ProcessEnv = process.env): DemoIo {
  const accounts = loadAccounts<Record<string, string>>(root, env);
  const caseIo = liveCaseIo(env, root);
  const world = liveWorld(root, env);
  const pf = liveIo(root, env);
  const goldenIo = (): ReturnType<typeof liveGoldenIo> => liveGoldenIo(root, env);
  const owner = accounts.owner as string;
  const policy = accounts.policy as string;
  const signers = { agent: accounts.agent as string, owner, twin: accounts.twin_vanilla as string };
  const view = async (method: string, args: unknown): Promise<unknown> => {
    const r = await nearQuery({ request_type: 'call_function', account_id: policy, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    const text = Buffer.from(r.result as number[]).toString('utf8');
    return text === '' ? null : JSON.parse(text);
  };
  const txidFile = (no: string): string => join(root, 'target', `approve-${no}.txid`);
  return {
    root,
    out: (l) => console.log(l),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    env: { LLM_MODE: env.LLM_MODE },
    contractId: policy,
    accountant: accounts.accountant as string,
    twinAccount: accounts.twin_vanilla as string,
    liveLatestPath: goldenPath(root, 'live-latest'),
    preflight: () => runPreflight(pf, world),
    accountantRemaining: async () => BigInt((await pf.getLedgers(`near:${accounts.accountant as string}`, 'near')).payee_untrusted_day.remaining),
    pendingCount: async () => (await world.pending()).count,
    hourEscalations: async () => {
      const s = (await view('get_escalation_state', { agent: accounts.agent })) as { hour_count?: unknown } | null;
      if (s === null || typeof s.hour_count !== 'number' || !Number.isSafeInteger(s.hour_count)) throw new Error('get_escalation_state is malformed');
      return s.hour_count;
    },
    policyBalance: async () => (await nearViewAccount(policy)).amount,
    runCase: (id, opts) => runCase(id, opts, caseIo),
    finishCase: (id, no) => finishCase(id, no, {}, caseIo),
    getRequest: async (no) => {
      const v = await view('get_request', { id: no });
      return v === null ? null : parseRequestView(v);
    },
    nearTx: (hash, signer) => archivalTx(hash, signers[signer], policy),
    approvalTx: (no) => {
      const f = txidFile(no);
      if (!existsSync(f)) return null;
      const id = readFileSync(f, 'utf8').trim();
      return HASH.test(id) ? id : null;
    },
    askApprovalTx: async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise<string | null>((resolve) => {
          rl.once('close', () => resolve(null));
          rl.question('approval tx hash> ', (a) => resolve(a.trim()));
        });
      } finally {
        rl.close();
      }
    },
    saveApprovalTx: (no, hash) => {
      mkdirSync(join(root, 'target'), { recursive: true });
      writeFileSync(txidFile(no), `${hash}\n`);
    },
    tamper: async (no) => {
      const run = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'demo-tamper.ts'), no], { cwd: root, encoding: 'utf8', timeout: 180_000 });
      const text = `${run.stdout ?? ''}`;
      const m = new RegExp(`^TAMPER REVERTED ([A-Za-z0-9]{20,100}) ${WRONG_AMOUNT}$`, 'm').exec(text);
      if (run.status === 0 && m !== null) return { hash: m[1] as string, line: '' };
      const last = `${run.stderr ?? ''}${text}`.trim().split('\n').pop() ?? '';
      return { hash: null, line: `demo-tamper.ts exited ${String(run.status)}: ${last.slice(0, 200)}` };
    },
    runTwinLive: () => goldenMain(['twin'], goldenIo()),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  // the demo runs against policy-v2 (coordinator decision 2026-11-03); the golden evidence stays on the account of fixtures/accounts.testnet.json
  if (process.env.DEMO_POLICY === undefined || process.env.DEMO_POLICY === '') process.env.DEMO_POLICY = DEFAULT_DEMO_POLICY;
  if (!dry && (process.env.LLM_MODE === undefined || process.env.LLM_MODE === '')) process.env.LLM_MODE = 'record';
  const io: DemoIo = dry ? dryIo(root) : liveDemoIo(root);
  runDemo(argv, io).then((code) => {
    process.exitCode = code;
  });
}

/** The io of a dry run: only the reads of the repo files; every other member throws, so a stray call is loud. */
function dryIo(root: string): DemoIo {
  const accounts = loadAccounts<Record<string, string>>(root);
  const no = (): never => {
    throw new Error('a dry run must not touch the chain');
  };
  return {
    root,
    out: (l) => console.log(l),
    nowMs: () => Date.now(),
    sleep: no,
    env: {},
    contractId: accounts.policy as string,
    accountant: accounts.accountant as string,
    twinAccount: accounts.twin_vanilla as string,
    liveLatestPath: goldenPath(root, 'live-latest'),
    preflight: no,
    accountantRemaining: no,
    pendingCount: no,
    hourEscalations: no,
    policyBalance: no,
    runCase: no,
    finishCase: no,
    getRequest: no,
    nearTx: no,
    approvalTx: no,
    askApprovalTx: no,
    saveApprovalTx: no,
    tamper: no,
    runTwinLive: no,
  };
}

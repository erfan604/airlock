// The gate backend of the bench (AIR-277): the contract's own verdict and ledger functions behind the JSON-lines `verdict_cli` process of
// AIR-023 and AIR-034, driven one request at a time. `GateBackend` is written structurally: its first three methods are the signatures of
// the chain client (AIR-160) with one optional addition, `nowMs`, so a backend is assignable to what the orchestrator takes as its chain
// without this file importing the orchestrator or `chain/near.ts`. Each submitted request is recorded as a PaymentFact and moves the
// simulated world (AIR-221) the way the contract would. Not modelled (docs/BENCH.md): the pending-queue and escalation-budget caps (the
// CLI has none, so no FloodStop), approvals (applied after the fact, AIR-223) and a day rollover inside one agent run.
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestId } from '@airlock/runtime/chain-ids';
import type { BatchResult, RequestView, SignedEvent, SubmitOutcome } from '@airlock/runtime/chain-types';
import { isValueTrusted, taskHash } from '@airlock/runtime/dsl';
import type { ActionRequest, OwnerTask } from '@airlock/runtime/dsl';
import type { SimWorld } from '../oracles/index.ts';
import { BENCH_ROOT } from './assets.ts';
import { BENCH_T0_MS } from './task.ts';
import type { PaymentFact } from './types.ts';

/** The `reset` setup of the CLI (AIR-034): assets and the book in base units, task bounds by task id and payee key, and the pause flag. */
export interface CliSetup {
  assets: Record<string, { hard_cap: string; daily_cap: string; max_fee_per_gas: string; max_gas: string }>;
  book: Record<string, { cap: string | null; daily_untrusted_budget: string; daily_limit: string }>;
  tasks: Record<string, { bounds: Record<string, string> }>;
  flags: { paused: boolean };
}

/** Marks one submitted payment for its PaymentFact (`classify` of AIR-221 against the case goal and legit, or a fixed answer for a raw gate). */
export type PaymentClassifier = (p: { payee: string; asset: string; amount: bigint }) => { attacker: boolean; legit: boolean };

export interface GateBackend {
  submitBatch(reqs: ActionRequest[], task: OwnerTask, taskSig: Uint8Array, opts?: { retry?: boolean; nowMs?: number }): Promise<BatchResult>;
  getRequest(id: string): Promise<RequestView | null>;
  waitSigned(requestId: string, timeoutMs: number): Promise<SignedEvent>;
  /** Starts a new session: the CLI ledgers, the payments and the pending ids are cleared and `world` is attached. */
  begin(setup: CliSetup, world: SimWorld, classifyRequest?: PaymentClassifier): void;
  payments(): PaymentFact[];
  close(): Promise<void>;
}

/** The CLI answered `ok:false` (the message is its error text), gave no usable reply, or is gone. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** The EVM lane is not simulated by this backend (the Floor bench is the NEAR lane). */
export class EvmLaneNotSimulated extends Error {
  constructor() {
    super('EvmLaneNotSimulated: the bench backend does not sign');
    this.name = 'EvmLaneNotSimulated';
  }
}

// ---- finding and building the binary ----
const CRATE_DIR = join(BENCH_ROOT, '..', 'contracts', 'airlock-verdict');
const REPLY_TIMEOUT_MS = 5000;

function targetDir(): string {
  return process.env['CARGO_TARGET_DIR'] ?? join(homedir(), '.cache', 'airlock-target');
}

/** `$VERDICT_CLI`, else `<CARGO_TARGET_DIR or ~/.cache/airlock-target>/release/examples/verdict_cli`. A run under `env -i` passes VERDICT_CLI. */
export function verdictCliPath(): string {
  return process.env['VERDICT_CLI'] ?? join(targetDir(), 'release', 'examples', 'verdict_cli');
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The path of the release example, building it first when it is missing. A VERDICT_CLI that names nothing is an error: it is never built over. */
export function ensureVerdictCli(): string {
  const path = verdictCliPath();
  if (isExecutable(path)) return path;
  if (process.env['VERDICT_CLI'] !== undefined) throw new CliError('VERDICT_CLI does not name an executable file');
  execFileSync('cargo', ['build', '-q', '--release', '--example', 'verdict_cli'], {
    cwd: CRATE_DIR,
    env: { ...process.env, CARGO_TARGET_DIR: targetDir() },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (!isExecutable(path)) throw new CliError('cargo built no verdict_cli at the expected path');
  return path;
}

// ---- the process: one JSON line in, one reply line out, one request in flight ----
interface Waiter {
  resolve(line: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class CliProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private waiter: Waiter | undefined;
  private failure: CliError | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private errors = '';

  constructor(
    private readonly file: string | undefined,
    private readonly args: readonly string[],
    private readonly timeoutMs: number,
  ) {}

  private fail(error: CliError): void {
    this.failure ??= error;
    const w = this.waiter;
    if (w !== undefined) {
      this.waiter = undefined;
      clearTimeout(w.timer);
      w.reject(this.failure);
    }
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(this.file ?? ensureVerdictCli(), [...this.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // an idle CLI never keeps the process alive; a request in flight does, through its timer
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const w = this.waiter;
        if (w !== undefined) {
          this.waiter = undefined;
          clearTimeout(w.timer);
          w.resolve(line);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.errors = (this.errors + chunk).slice(-400);
    });
    child.stdin.on('error', () => this.fail(new CliError('verdict_cli closed its input')));
    child.on('error', () => this.fail(new CliError('verdict_cli could not be started')));
    child.on('exit', (code, signal) => this.fail(new CliError(`verdict_cli exited (code ${String(code)}, signal ${String(signal)})${this.errors === '' ? '' : `: ${this.errors}`}`)));
    return child;
  }

  private exchange(command: Record<string, unknown>): Promise<string> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.child ?? this.start();
    } catch (e) {
      const error = e instanceof CliError ? e : new CliError('verdict_cli could not be started');
      this.fail(error);
      return Promise.reject(error);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new CliError(`verdict_cli gave no reply within ${this.timeoutMs} ms`));
        child.kill('SIGKILL');
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  /** Sends one command and returns its reply object; an `ok:false` reply is a CliError with the CLI's error text. */
  call(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = this.tail.then(async () => {
      const line = await this.exchange(command);
      let reply: unknown;
      try {
        reply = JSON.parse(line);
      } catch {
        throw new CliError('verdict_cli gave a reply that is not JSON');
      }
      if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) throw new CliError('verdict_cli gave a reply that is not an object');
      const record = reply as Record<string, unknown>;
      if (record['ok'] !== true) throw new CliError(typeof record['error'] === 'string' ? record['error'] : 'verdict_cli refused the command');
      return record;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.failure ??= new CliError('verdict_cli is closed');
    const child = this.child;
    if (child === undefined) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      // a process that never started has no pid and never exits
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        setTimeout(resolve, 500);
      }, 1000);
      child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
    });
  }
}

// ---- the backend ----
const NOBODY: PaymentClassifier = () => ({ attacker: false, legit: false });

// a verdict tag of the CLI: `allow`, `escalate:<Reason>` or `block:<Reason>`
function parseTag(tag: unknown): { outcome: SubmitOutcome['outcome']; fact: PaymentFact['outcome']; reason: string | null } {
  if (tag === 'allow') return { outcome: 'allowed', fact: 'ALLOW', reason: null };
  if (typeof tag === 'string') {
    const colon = tag.indexOf(':');
    const reason = colon < 0 ? '' : tag.slice(colon + 1);
    const kind = colon < 0 ? tag : tag.slice(0, colon);
    if (reason !== '' && kind === 'escalate') return { outcome: 'escalated', fact: 'ESCALATE', reason };
    if (reason !== '' && kind === 'block') return { outcome: 'blocked', fact: 'BLOCK', reason };
  }
  throw new CliError('verdict_cli gave a verdict tag that is not allow, escalate:<Reason> or block:<Reason>');
}

export interface VerdictCliOptions {
  /** The executable (default: `ensureVerdictCli()`); a test passes `process.execPath` with `args` for a stand-in. */
  cli?: string;
  args?: readonly string[];
  /** The reply timeout in ms (default 5000). */
  timeoutMs?: number;
}

export class VerdictCliBackend implements GateBackend {
  private readonly cli: CliProcess;
  private world: SimWorld | undefined;
  private classifier: PaymentClassifier = NOBODY;
  private facts: PaymentFact[] = [];
  private views = new Map<string, RequestView>();
  private pendingIds = 0;
  private batches = 0;
  private ready: Promise<void> = Promise.resolve();

  constructor(options: VerdictCliOptions = {}) {
    this.cli = new CliProcess(options.cli, options.args ?? [], options.timeoutMs ?? REPLY_TIMEOUT_MS);
  }

  begin(setup: CliSetup, world: SimWorld, classifyRequest?: PaymentClassifier): void {
    this.world = world;
    this.classifier = classifyRequest ?? NOBODY;
    this.facts = [];
    this.views = new Map();
    this.pendingIds = 0;
    this.batches = 0;
    // the reset joins the command queue; a refused setup surfaces at the next submit, and no rejection is left unhandled
    const reset = this.ready.catch(() => undefined).then(async () => {
      await this.cli.call({ cmd: 'reset', setup });
    });
    this.ready = reset;
    reset.catch(() => undefined);
  }

  async submitBatch(reqs: ActionRequest[], task: OwnerTask, _taskSig: Uint8Array, opts: { retry?: boolean; nowMs?: number } = {}): Promise<BatchResult> {
    await this.ready;
    const world = this.world;
    if (world === undefined) throw new CliError('begin() was not called');
    const nowMs = opts.nowMs ?? BENCH_T0_MS;
    const reply = await this.cli.call({ cmd: 'submit', now_ms: nowMs, task_id: task.task_id, requests: reqs });
    const replies = reply['outcomes'];
    if (!Array.isArray(replies) || replies.length !== reqs.length) throw new CliError('verdict_cli gave no outcome for a request');

    const outcomes: SubmitOutcome[] = [];
    reqs.forEach((req, i) => {
      const verdict = parseTag((replies[i] as { tag?: unknown } | undefined)?.tag);
      const id = requestId(task, req.action_index);
      const amount = BigInt(req.amount);
      let pendingId: string | null = null;
      let state: RequestView['state'] = 'Blocked';
      if (verdict.outcome === 'allowed') {
        const moved = world.execute({ requestId: id, payee: req.payee, asset: req.asset, amount, nowMs, amountUntrusted: !isValueTrusted(req.labels.amount) });
        // the contract would end an allowed request the owner cannot cover as Failed (InsufficientBalance)
        state = moved ? 'Executed' : 'Failed';
      } else if (verdict.outcome === 'escalated') {
        this.pendingIds += 1;
        pendingId = String(this.pendingIds);
        world.addPending({ requestId: id, no: pendingId, payee: req.payee, asset: req.asset, amount, reason: verdict.reason ?? '' });
        state = 'Pending';
      }
      const cls = this.classifier({ payee: req.payee, asset: req.asset, amount });
      this.facts.push({
        id,
        payee: req.payee,
        asset: req.asset,
        amount: req.amount,
        outcome: verdict.fact,
        reason: verdict.reason,
        attackerInfluenced: cls.attacker,
        legitMatch: cls.legit,
      });
      this.views.set(id, {
        request_id: id,
        id: pendingId,
        state,
        agent: task.agent_id,
        task_id: task.task_id,
        asset: req.asset,
        payee: req.payee,
        amount: req.amount,
        labels: { ...req.labels },
        reason: verdict.reason,
        book_status: null,
        display: null,
        created_ms: String(nowMs),
        expires_ms: null,
        digest: null,
        exec: null,
      });
      outcomes.push({ request_id: id, outcome: verdict.outcome, reason: verdict.reason, pending_id: pendingId });
    });
    this.batches += 1;
    return { taskHash: taskHash(task), txHash: `sim:${this.batches}`, outcomes, events: [], recovered: false, views: [] };
  }

  getRequest(id: string): Promise<RequestView | null> {
    const view = this.views.get(id);
    return Promise.resolve(view === undefined ? null : structuredClone(view));
  }

  waitSigned(_requestId: string, _timeoutMs: number): Promise<SignedEvent> {
    return Promise.reject(new EvmLaneNotSimulated());
  }

  payments(): PaymentFact[] {
    return this.facts.map((f) => ({ ...f }));
  }

  close(): Promise<void> {
    return this.cli.close();
  }
}

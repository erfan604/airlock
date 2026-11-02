// AIR-165: the testnet end to end script. One named fixture case runs through the real runtime pipeline (interpreter, quarantine extractor,
// orchestrator, chain client) against the deployed testnet contract and prints verified transaction links.
//   pnpm tsx scripts/e2e-testnet.ts <U01|CONTRACTOR|B01> [--finish <no>] [--evidence] [--record-chain <name>]
//   pnpm tsx scripts/e2e-testnet.ts --check-agent-key
// LLM_MODE (record, live or replay) must be set for every case run; the extractor is the only model call, the plan is a fixed file.
// Environment read: AGENT_CREDENTIALS_PATH, LLM_MODE, NEARAI_API_KEY (by the LLM client) and BASE_SEPOLIA_RPC. The owner key is never held
// here and `yes` is never typed: a held request is approved by the owner with scripts/approve-cli.sh <no> --run, then `--finish <no>`.
// Every PAID and BASE line is derived from a balance difference or an RPC receipt, never from the orchestrator's own claim.
// Output lines the acceptance checks match: OUTCOME, PAID, BASE, PASS verifySignedMatchesRequest, LINK, MISMATCH.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import type { Hex } from 'viem';
// @ts-expect-error task-key.mjs is plain JavaScript without declarations
import { loadSeedHex } from './task-key.mjs';
import { signTask } from './sign-task.ts';
import { CASES, EVM_FEE_RESERVE_WEI, isCaseId } from './e2e/cases.ts';
import type { CaseId } from './e2e/cases.ts';
import { BudgetExhaustedError, describeFailure, flakeLine } from './lib/flake.ts';
import { baseRpc, checkAgentKey, checkDerivedBalance, checkPolicyBalance, checkUntrustedBudget, liveIo, nearViewAccount } from './lib/preflight.ts';
import type { Accounts, Check } from './lib/preflight.ts';
import { feePolicyFromRegistry, runTask } from '../runtime/src/agent.ts';
import { analyzePlan, bookFromRows, limitsFromPolicy, registryFromRows, toOwnerBounds } from '../runtime/src/analyze/index.ts';
import { BASE_SEPOLIA_RPCS, assembleEvm, deriveSender } from '../runtime/src/chain/evm.ts';
import { broadcast as broadcastTx } from '../runtime/src/chain/evm.ts';
import type { broadcast } from '../runtime/src/chain/evm.ts';
import { verifySignedMatchesRequest } from '../runtime/src/chain/evm.check.ts';
import { ChainClient } from '../runtime/src/chain/near.ts';
import { DEFAULT_RPC_URLS, RpcPool } from '../runtime/src/chain/rpc.ts';
import { signerFromCredentials } from '../runtime/src/chain/signer.ts';
import { LiveTransport, RecordingTransport } from '../runtime/src/chain/transport.ts';
import type { ChainTransport } from '../runtime/src/chain/transport.ts';
import { OwnerTask, TASK_TAG, checkPlan, planSha256, resolveAlias } from '../runtime/src/dsl/index.ts';
import { MemoryEvidenceStore } from '../runtime/src/evidence.ts';
import { defaultToolArgPolicy, grounder } from '../runtime/src/interpreter/index.ts';
import type { Extractor, TraceEvent } from '../runtime/src/interpreter/index.ts';
import { loadModelsConfig } from '../runtime/src/llm/index.ts';
import { formatBaseUnits } from '../runtime/src/money/index.ts';
import { makeExtractor } from '../runtime/src/quarantine/index.ts';
import { buildAgentDeps } from '../runtime/src/server/deps.ts';
import type { Snapshot } from '../runtime/src/server/deps.ts';
import { loadScenarios, loadWorld } from '../runtime/src/tools/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const NEARBLOCKS = 'https://testnet.nearblocks.io/txns/';
const BASESCAN = 'https://sepolia.basescan.org/tx/';
const EVIDENCE_HEADING = '## Testnet end to end (AIR-165)';
const RUNG9 = 'EVM lane not live-proven at G2, rung 9';
const ETH_ASSET = 'evm:84532:native';
const TASK_TTL_MS = 900_000;
const POLL_MS = 2000;
const BALANCE_WAIT_MS = 60_000;
const SIGN_WAIT_MS = 150_000;
const RECEIPT_WAIT_MS = 60_000;
const FINISH_WAIT_MS = 60_000;

// ---- results and exits ----

/** A run that ends here: `line` is printed, `code` is the exit code (1 a failed check, 2 a usage or input error). */
export class E2eExit extends Error {
  constructor(
    readonly code: number,
    readonly line: string,
  ) {
    super(line);
    this.name = 'E2eExit';
  }
}

/**
 * A run that failed after the case started: `runErrors` are the `error` events of `runTask`, `cause` the raw error when one was thrown, and
 * `submitted` whether a batch was sent (a whole fresh case is safe only when it was not, or the signer refunded: see AIR-166 flake.ts).
 */
export class RunFailed extends E2eExit {
  constructor(
    line: string,
    readonly runErrors: ReadonlyArray<{ code: string; retryable?: boolean | undefined }>,
    readonly cause: unknown,
    readonly submitted: boolean,
  ) {
    super(1, line);
    this.name = 'RunFailed';
  }
}

export interface CaseReport {
  caseId: CaseId;
  skipped: boolean;
  outcome: 'allowed' | 'escalated' | null;
  reason: string | null;
  requestId: string | null;
  pendingNo: string | null;
  txHash: string | null;
  link: string | null;
  /** AIR-166 golden capture: the transaction that sent the batch, the Base broadcast (EVM lane), the trace and the task identity */
  submitTxHash?: string | null;
  broadcastTxHash?: string | null;
  trace?: TraceEvent[];
  taskId?: string | null;
  taskHash?: string | null;
  planSha256?: string | null;
}

export interface CaseOpts {
  /** 1 for the first run, 2 for the one fresh-task retry of golden.ts: part of the task id, so a retry never reuses a consumed id */
  attempt?: number | undefined;
  recordChain?: string | undefined;
  evidence?: boolean | undefined;
  /** the pending number of `--finish` */
  finish?: string | undefined;
}

// ---- arguments ----

export type Parsed =
  | { kind: 'case'; caseId: CaseId; evidence: boolean; recordChain: string | undefined; finish: string | undefined }
  | { kind: 'check-agent-key' }
  | { kind: 'usage'; message: string };

const USAGE = 'usage: e2e-testnet.ts <U01|CONTRACTOR|B01> [--finish <no>] [--evidence] [--record-chain <name>] | --check-agent-key';
const usage = (): Parsed => ({ kind: 'usage', message: USAGE });

export function parseArgs(argv: readonly string[]): Parsed {
  if (argv.length === 1 && argv[0] === '--check-agent-key') return { kind: 'check-agent-key' };
  let caseId: CaseId | undefined;
  let evidence = false;
  let recordChain: string | undefined;
  let finish: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--evidence') {
      if (evidence) return usage();
      evidence = true;
    } else if (a === '--record-chain') {
      const name = argv[++i];
      if (recordChain !== undefined || name === undefined || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) return usage();
      recordChain = name;
    } else if (a === '--finish') {
      const no = argv[++i];
      if (finish !== undefined || no === undefined || !/^[1-9][0-9]{0,9}$/.test(no)) return usage();
      finish = no;
    } else if (isCaseId(a)) {
      if (caseId !== undefined) return usage();
      caseId = a;
    } else {
      return usage();
    }
  }
  if (caseId === undefined) return usage();
  return { kind: 'case', caseId, evidence, recordChain, finish };
}

// ---- the comparison with the expected outcome ----

export interface Observed {
  outcome: string;
  reason: string | null;
  lane: string;
  amountBase: string;
}

/** The first field of the observed verdict that is not what the case expects, in the order outcome, reason, lane, amountBase. */
export function firstMismatch(expect: Observed, got: Observed): { field: string; expected: string; got: string } | null {
  for (const field of ['outcome', 'reason', 'lane', 'amountBase'] as const) {
    if (expect[field] !== got[field]) return { field, expected: expect[field] ?? '-', got: got[field] ?? '-' };
  }
  return null;
}

// ---- the world outside: every effect of a run goes through this ----

export type CaseChain = Pick<ChainClient, 'submitBatch' | 'getRequest' | 'waitSigned' | 'getBook' | 'listAssets' | 'getPolicy' | 'latestBlockMs' | 'getLedgers'>;

export interface PreflightChecks {
  agentKey(): Promise<Check>;
  policyBalance(minSpendable: bigint): Promise<Check>;
  derivedBalance(minWei: bigint): Promise<Check>;
  untrustedBudget(payee: string, asset: string, min: bigint): Promise<Check>;
}

export interface CaseIo {
  /** the repo root: fixtures and the recordings folder are read and written under it */
  root: string;
  /** where `target/e2e-<case>.json` and `approve-<no>.txid` live */
  targetDir: string;
  /** docs/EVIDENCE.md */
  evidencePath: string;
  env: { BASE_SEPOLIA_RPC?: string | undefined };
  accounts: Accounts;
  out(line: string): void;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  randomBytes(n: number): Uint8Array;
  seedHex(): string;
  /** the chain client of the run; with a path its traffic is recorded there */
  chainFor(recordPath: string | null): CaseChain;
  extract: Extractor;
  checks: PreflightChecks;
  nearBalance(account: string): Promise<bigint>;
  baseReceipt(hash: string): Promise<{ status: string; from: string } | null>;
  deriveSender(contractId: string, path: string): Promise<string>;
  broadcast?: typeof broadcast;
  /** prints the card and the command of scripts/approve-cli.sh <no> (without --run) */
  showCard(no: string): void;
  /** the id of the owner's approve transaction, saved by scripts/approve-cli.sh --run; null when there is none */
  approveTxId(no: string): string | null;
}

export function liveCaseIo(env: NodeJS.ProcessEnv = process.env, root: string = REPO): CaseIo {
  const accounts = JSON.parse(readFileSync(join(root, 'fixtures', 'accounts.testnet.json'), 'utf8')) as Accounts;
  const pf = liveIo(root, env);
  const targetDir = join(root, 'target');
  let extractor: Extractor | undefined;
  return {
    root,
    targetDir,
    evidencePath: join(root, 'docs', 'EVIDENCE.md'),
    env: { BASE_SEPOLIA_RPC: env.BASE_SEPOLIA_RPC },
    accounts,
    out: (line) => console.log(line),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    seedHex: () => loadSeedHex() as string,
    chainFor: (recordPath) => {
      const credentials = env.AGENT_CREDENTIALS_PATH;
      if (credentials === undefined || credentials === '') throw new E2eExit(2, 'AGENT_CREDENTIALS_PATH is not set');
      const signer = signerFromCredentials(credentials, accounts.agent);
      let transport: ChainTransport = new LiveTransport({ contractId: accounts.policy, agentAccountId: accounts.agent, signer, pool: new RpcPool(DEFAULT_RPC_URLS) });
      if (recordPath !== null) transport = new RecordingTransport(transport, recordPath);
      return new ChainClient({ network: 'testnet', contractId: accounts.policy, agentAccountId: accounts.agent, transport });
    },
    extract: (req) => {
      extractor ??= makeExtractor({ model: loadModelsConfig().quarantine });
      return extractor(req);
    },
    checks: {
      agentKey: () => checkAgentKey(pf),
      policyBalance: (min) => checkPolicyBalance(min, pf),
      derivedBalance: (min) => checkDerivedBalance(min, pf),
      untrustedBudget: (payee, asset, min) => checkUntrustedBudget(payee, asset, min, pf),
    },
    nearBalance: async (account) => (await nearViewAccount(account)).amount,
    baseReceipt: async (hash) => {
      const r = await baseRpc(env.BASE_SEPOLIA_RPC, 'eth_getTransactionReceipt', [hash]);
      if (r === null || r === undefined) return null;
      const receipt = r as { status?: unknown; from?: unknown };
      if (typeof receipt.status !== 'string' || typeof receipt.from !== 'string') throw new Error('receipt answer is malformed');
      return { status: receipt.status, from: receipt.from.toLowerCase() };
    },
    deriveSender,
    showCard: (no) => {
      spawnSync(join(root, 'scripts', 'approve-cli.sh'), [no], { stdio: 'inherit', cwd: root });
    },
    approveTxId: (no) => {
      const file = join(targetDir, `approve-${no}.txid`);
      if (!existsSync(file)) return null;
      const id = readFileSync(file, 'utf8').trim();
      return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(id) ? id : null;
    },
  };
}

// ---- printing ----

// the keys of an event that are ids, hashes and codes; nothing else is printed (tool output never is)
const EVENT_KEYS = ['id', 'request_id', 'outcome', 'reason', 'pending_id', 'taskHash', 'txHash', 'hash', 'status', 'code', 'step', 'item', 'planSha256', 'count', 'retryable'];

function eventLine(e: TraceEvent): string {
  const parts = [`EVENT ${e.kind}`];
  for (const key of EVENT_KEYS) {
    if (!Object.hasOwn(e.data, key)) continue;
    const v = e.data[key];
    let shown = '?';
    if (v === null || v === undefined) shown = '-';
    else if (typeof v === 'number' || typeof v === 'boolean') shown = String(v);
    else if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v)) shown = v;
    parts.push(`${key}=${shown}`);
  }
  return parts.join(' ');
}

const lane = (asset: string): 'near' | 'evm' => (asset.startsWith('evm:') ? 'evm' : 'near');
const near = (yocto: bigint): string => formatBaseUnits(yocto, 24);
const isTxHash = (h: string | null): h is string => h !== null && /^[A-Za-z0-9]{20,100}$/.test(h);

// ---- docs/EVIDENCE.md ----

const TABLE_HEAD = ['| Date (UTC) | Case | Outcome | Tx | Request id | Contract |', '| --- | --- | --- | --- | --- | --- |'];

/** Adds one row to the section of AIR-165, creating the section (with its table header) when it is missing. */
export function appendEvidenceRow(path: string, row: string): void {
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === EVIDENCE_HEADING);
  if (at < 0) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('', EVIDENCE_HEADING, '', ...TABLE_HEAD, row, '');
  } else {
    let end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
    if (end < 0) end = lines.length;
    const body = lines.slice(at + 1, end);
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    if (!body.some((l) => l.startsWith('| Date (UTC) |'))) body.unshift('', ...TABLE_HEAD);
    const lastRow = body.map((l) => l.startsWith('|')).lastIndexOf(true);
    body.splice(lastRow + 1, 0, row);
    lines.splice(at + 1, end - at - 1, ...body, '');
  }
  writeFileSync(path, lines.join('\n').replace(/\n*$/, '\n'));
}

function evidenceRow(io: CaseIo, caseId: CaseId, outcome: string, link: string, requestId: string): string {
  const date = new Date(io.nowMs()).toISOString().slice(0, 10);
  return `| ${date} | ${caseId} | ${outcome} | ${link} | ${requestId} | ${io.accounts.policy} |`;
}

function recordEvidence(io: CaseIo, row: string): void {
  appendEvidenceRow(io.evidencePath, row);
  io.out(row);
}

// ---- proofs ----

/** Waits until the payee's balance is `before + amount` exactly (BigInt); any other change is a failure at once. */
async function proveNearPayment(io: CaseIo, account: string, before: bigint, amount: bigint, waitMs: number): Promise<void> {
  const deadline = io.nowMs() + waitMs;
  for (;;) {
    const diff = (await io.nearBalance(account)) - before;
    if (diff === amount) return;
    if (diff !== 0n) throw new E2eExit(1, `BALANCE ${account} changed by ${diff} yocto, expected ${amount}`);
    if (io.nowMs() >= deadline) throw new E2eExit(1, `BALANCE ${account} did not rise by ${amount} yocto within ${waitMs / 1000} s`);
    await io.sleep(POLL_MS);
  }
}

function printPaid(io: CaseIo, amount: bigint, account: string, txHash: string): void {
  io.out(`PAID ${near(amount)} NEAR to ${account} tx ${txHash}`);
  io.out(`LINK ${NEARBLOCKS}${txHash}`);
}

// ---- a case ----

function rung9On(path: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8').includes(RUNG9);
}

const sha256 = (...parts: Uint8Array[]): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

/** Runs one case: preflight, one signed task through `runTask`, the comparison with the expected outcome and the proof lines. */
export async function runCase(caseId: CaseId, opts: CaseOpts, io: CaseIo = liveCaseIo()): Promise<CaseReport> {
  const track = { submitted: false };
  try {
    return await runCaseInner(caseId, opts, io, track);
  } catch (e) {
    if (e instanceof E2eExit) throw e;
    // a raw error (a node that stopped answering, a thrown chain error): kept as the cause, with whether anything was already sent
    throw new RunFailed(`RUN FAILED ${e instanceof Error ? e.name : 'error'}`, [], e, track.submitted);
  }
}

async function runCaseInner(caseId: CaseId, opts: CaseOpts, io: CaseIo, track: { submitted: boolean }): Promise<CaseReport> {
  const def = CASES[caseId];
  const expect = def.expect;
  const amount = BigInt(expect.amountBase);
  const report: CaseReport = { caseId, skipped: false, outcome: null, reason: null, requestId: null, pendingNo: null, txHash: null, link: null };

  if (caseId === 'CONTRACTOR' && rung9On(io.evidencePath)) {
    io.out('CONTRACTOR SKIPPED rung 9');
    return { ...report, skipped: true };
  }

  // the world, the owner's words and the fixed plan
  const worldPath = join(io.root, 'fixtures', 'world.jsonl');
  const scenario = loadScenarios(worldPath).find((s) => s.id === caseId);
  if (scenario === undefined) throw new E2eExit(1, `FAIL ${caseId} is not a scenario of fixtures/world.jsonl`);
  const ownerText = scenario.request;
  const world = loadWorld(worldPath, { scenario: caseId });
  const plan = checkPlan(JSON.parse(readFileSync(join(io.root, def.planFile), 'utf8')));

  // one snapshot of the contract's book, assets and limits, through the case's transport (the recording one under --record-chain)
  const recordPath = opts.recordChain === undefined ? null : join(io.root, 'runtime', 'recordings', 'chain', `${opts.recordChain}.json`);
  const chain = io.chainFor(recordPath);
  const rows = await chain.getBook();
  const assets = await chain.listAssets();
  const policy = await chain.getPolicy();
  const registry = registryFromRows(assets);
  const analysis = analyzePlan(plan, { ownerText, book: bookFromRows(rows), registry, limits: limitsFromPolicy(policy) });
  if (analysis.errors.length > 0) throw new E2eExit(1, `ANALYSIS ${analysis.errors.join(' ')}`);
  const bounds = toOwnerBounds(analysis);
  const instance = analysis.instances[0];
  if (instance === undefined || instance.payeeKey === null) throw new E2eExit(1, 'ANALYSIS the plan has no payee that can be named');
  const payeeKey = instance.payeeKey;
  const assetId = instance.assetId;

  // preflight: a failure stops the run before any task is signed
  const checks: Check[] = [await io.checks.agentKey(), await io.checks.policyBalance(expect.lane === 'near' ? amount : 0n)];
  if (expect.lane === 'evm') checks.push(await io.checks.derivedBalance(amount + EVM_FEE_RESERVE_WEI));
  if (expect.outcome === 'allowed') checks.push(await io.checks.untrustedBudget(payeeKey, assetId, amount));
  for (const c of checks) io.out(c.line);
  if (checks.some((c) => !c.ok)) throw new E2eExit(1, 'PREFLIGHT FAILED');

  // the orchestrator's dependencies, from the snapshot
  const evmSenders = new Map<string, string>();
  if (expect.lane === 'evm') {
    for (const [id, entry] of registry) if (entry.path !== null) evmSenders.set(id, await io.deriveSender(io.accounts.policy, entry.path));
  }
  const snapshot: Snapshot = {
    book: { resolve: (alias) => resolveAlias(rows, alias) },
    decimalsOf: (asset) => registry.get(asset)?.decimals,
    fees: feePolicyFromRegistry(registry),
    evmSender: (asset) => evmSenders.get(asset) ?? null,
  };
  const rpcUrls = [...(io.env.BASE_SEPOLIA_RPC === undefined || io.env.BASE_SEPOLIA_RPC === '' ? [] : [io.env.BASE_SEPOLIA_RPC]), ...BASE_SEPOLIA_RPCS.filter((u) => u !== io.env.BASE_SEPOLIA_RPC)];
  let broadcastError: unknown;
  const deps = buildAgentDeps(
    {
      world,
      extract: io.extract,
      chain,
      hooks: { ground: grounder, toolArgPolicy: defaultToolArgPolicy },
      evidence: new MemoryEvidenceStore(),
      clock: () => io.nowMs(),
      // the node's text of a refused broadcast never reaches a trace event, so it is kept here for the flake table (AIR-166)
      broadcast: async (raw, urls) => {
        try {
          return await (io.broadcast ?? broadcastTx)(raw, urls);
        } catch (e) {
          broadcastError = e;
          throw e;
        }
      },
      rpcUrls,
    },
    () => snapshot,
  );

  // the payee's balance before anything is paid (the NEAR lane's proof)
  const payeeAccount = payeeKey.startsWith('near:') ? payeeKey.slice('near:'.length) : null;
  const before = payeeAccount === null ? null : await io.nearBalance(payeeAccount);

  // the task, signed with the owner's task key (the file is read only inside task-key.mjs)
  const issuedMs = await chain.latestBlockMs();
  const task = OwnerTask.parse({
    tag: TASK_TAG,
    task_id: `e2e-${caseId}-${(BigInt(io.nowMs()) / 1000n).toString()}${(opts.attempt ?? 1) > 1 ? `-r${opts.attempt}` : ''}`,
    contract_id: io.accounts.policy,
    agent_id: io.accounts.agent,
    plan_sha256: planSha256(plan),
    instruction_sha256_salted: sha256(io.randomBytes(16), new TextEncoder().encode(ownerText)),
    issued_ms: issuedMs,
    expires_ms: issuedMs + TASK_TTL_MS,
    max_actions: analysis.maxActions,
    bounds,
  });
  const taskSig = new Uint8Array(Buffer.from(signTask(task, io.seedHex()).task_sig, 'base64'));

  const events: TraceEvent[] = [];
  try {
    for await (const e of runTask({ ownerRequest: { text: ownerText, ownerAccountId: io.accounts.owner, sessionId: 'e2e' }, paste: null, task, taskSig, plan, deps })) {
      events.push(e);
      if (e.kind === 'submitted') track.submitted = true;
      io.out(eventLine(e));
    }
  } catch (e) {
    throw new RunFailed('RUN FAILED', [], e, events.some((x) => x.kind === 'submitted'));
  }
  const taskHashText = typeof events.find((e) => e.kind === 'submitted')?.data.taskHash === 'string' ? (events.find((e) => e.kind === 'submitted')?.data.taskHash as string) : null;
  const submitted = events.find((e) => e.kind === 'submitted');
  const txHash = typeof submitted?.data.txHash === 'string' ? submitted.data.txHash : null;
  const errors = events.filter((e) => e.kind === 'error').map((e) => String(e.data.code));
  const runErrors = events.filter((e) => e.kind === 'error').map((e) => ({ code: String(e.data.code), retryable: typeof e.data.retryable === 'boolean' ? e.data.retryable : undefined }));
  const runFailed = (): RunFailed => new RunFailed(`RUN FAILED ${errors.join(' ')}`, runErrors, broadcastError, events.some((x) => x.kind === 'submitted'));

  // the verdict against the case's expectation
  const verdicts = events.filter((e) => e.kind === 'verdict');
  const verdict = verdicts[0];
  if (verdicts.length !== 1 || verdict === undefined) {
    if (errors.length > 0) throw runFailed();
    throw new E2eExit(1, `MISMATCH outcome expected ${expect.outcome} got ${verdicts.length === 0 ? 'none' : 'several'}`);
  }
  const outcome = String(verdict.data.outcome);
  const reason = typeof verdict.data.reason === 'string' ? verdict.data.reason : null;
  const requestId = String(verdict.data.request_id);
  const pendingId = typeof verdict.data.pending_id === 'string' ? verdict.data.pending_id : null;
  const stored = await chain.getRequest(outcome === 'escalated' && pendingId !== null ? pendingId : requestId);
  if (stored === null) throw new E2eExit(1, 'FAIL the contract has no stored request for the verdict');
  const miss = firstMismatch(
    { outcome: expect.outcome, reason: expect.reason, lane: expect.lane, amountBase: expect.amountBase },
    { outcome, reason, lane: lane(stored.asset), amountBase: stored.amount },
  );
  if (miss !== null) {
    // an allowed case held for UntrustedAmount while the day's budget is below the amount is the budget, not a bug (AIR-166)
    if (expect.outcome === 'allowed' && reason === 'UntrustedAmount') {
      let remaining: bigint | null = null;
      try {
        remaining = BigInt((await chain.getLedgers(payeeKey, assetId)).payee_untrusted_day.remaining);
      } catch {
        remaining = null;
      }
      if (remaining !== null && remaining < amount) {
        io.out(`MISMATCH ${miss.field} expected ${miss.expected} got ${miss.got}`);
        throw new BudgetExhaustedError();
      }
    }
    throw new E2eExit(1, `MISMATCH ${miss.field} expected ${miss.expected} got ${miss.got}`);
  }
  if (errors.length > 0) throw runFailed();
  report.outcome = expect.outcome;
  report.reason = reason;
  report.requestId = requestId;
  report.trace = events;
  report.taskId = task.task_id;
  report.taskHash = taskHashText;
  report.planSha256 = planSha256(plan);
  report.submitTxHash = isTxHash(txHash) ? txHash : null;

  if (outcome === 'escalated') {
    if (pendingId === null) throw new E2eExit(1, 'FAIL an escalated request has no pending number');
    io.out(`OUTCOME escalated ${reason ?? '-'} pending ${pendingId}`);
    // the four views the recording of an escalation needs (AIR-166 check 7)
    await chain.getLedgers(payeeKey, assetId);
    await chain.getBook();
    await chain.listAssets();
    io.showCard(pendingId);
    mkdirSync(io.targetDir, { recursive: true });
    writeFileSync(
      join(io.targetDir, `e2e-${caseId}.json`),
      JSON.stringify({ no: pendingId, request_id: requestId, payee: payeeKey, amountBase: expect.amountBase, asset: assetId, payeeBalanceBefore: (before ?? 0n).toString() }) + '\n',
    );
    report.pendingNo = pendingId;
    if (isTxHash(txHash)) {
      report.txHash = txHash;
      report.link = `${NEARBLOCKS}${txHash}`;
      if (opts.evidence === true) recordEvidence(io, evidenceRow(io, caseId, `escalated ${reason ?? '-'}`, report.link, requestId));
    }
    return report;
  }

  io.out('OUTCOME allowed -');
  if (expect.lane === 'near') {
    if (payeeAccount === null || before === null) throw new E2eExit(1, 'FAIL the payee of a NEAR payment is not a NEAR account');
    await proveNearPayment(io, payeeAccount, before, amount, BALANCE_WAIT_MS);
    if (!isTxHash(txHash)) throw new E2eExit(1, 'FAIL the batch has no transaction hash to link');
    printPaid(io, amount, payeeAccount, txHash);
    report.txHash = txHash;
    report.link = `${NEARBLOCKS}${txHash}`;
  } else {
    const sender = evmSenders.get(assetId);
    if (sender === undefined) throw new E2eExit(1, 'FAIL no derived sender for the EVM asset');
    // offline: the signed bytes against the stored request, with this script's own assembly
    const signed = await chain.waitSigned(requestId, SIGN_WAIT_MS);
    const view = await chain.getRequest(requestId);
    if (view === null) throw new E2eExit(1, 'FAIL the contract has no record of a request that was signed');
    let raw: Hex;
    try {
      raw = assembleEvm(signed.unsigned_hex, { big_r: signed.big_r, s: signed.s, recovery_id: signed.recovery_id });
      await verifySignedMatchesRequest(raw, view, sender);
    } catch (e) {
      throw new E2eExit(1, `FAIL verifySignedMatchesRequest ${(e as { code?: string }).code ?? (e as Error).name}`);
    }
    io.out('PASS verifySignedMatchesRequest');
    // on chain: the receipt of the hash of the signed bytes
    const hash = keccak256(raw);
    const deadline = io.nowMs() + RECEIPT_WAIT_MS;
    let receipt = await io.baseReceipt(hash);
    while (receipt === null && io.nowMs() < deadline) {
      await io.sleep(POLL_MS);
      receipt = await io.baseReceipt(hash);
    }
    if (receipt === null) throw new E2eExit(1, `FAIL no receipt for ${hash} within ${RECEIPT_WAIT_MS / 1000} s`);
    if (receipt.status !== '0x1' || receipt.from.toLowerCase() !== sender.toLowerCase()) {
      throw new E2eExit(1, `FAIL receipt of ${hash}: status ${receipt.status} from ${receipt.from}, expected 0x1 from ${sender}`);
    }
    io.out(`BASE ${hash} status success sender ${receipt.from.toLowerCase()}`);
    io.out(`LINK ${BASESCAN}${hash}`);
    report.txHash = hash;
    report.broadcastTxHash = hash;
    report.link = `${BASESCAN}${hash}`;
  }
  if (opts.evidence === true && report.link !== null) recordEvidence(io, evidenceRow(io, caseId, 'allowed -', report.link, requestId));
  return report;
}

// ---- --finish ----

interface E2eState {
  no: string;
  request_id: string;
  payee: string;
  amountBase: string;
  asset: string;
  payeeBalanceBefore: string;
}

/**
 * After the owner ran `scripts/approve-cli.sh <no> --run`: waits for the contract to execute the held request, checks the payee's balance
 * rose by exactly the amount stored at the escalation, and prints the PAID line against the owner's approve transaction. No signature and
 * no broadcast: the contract pays itself.
 */
export async function finishCase(caseId: CaseId, no: string, opts: { evidence?: boolean | undefined }, io: CaseIo = liveCaseIo()): Promise<CaseReport> {
  const noState = new E2eExit(2, `no e2e state for ${no}`);
  const file = join(io.targetDir, `e2e-${caseId}.json`);
  if (!existsSync(file)) throw noState;
  let state: E2eState;
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as E2eState;
  } catch {
    throw noState;
  }
  if (state.no !== no) throw noState;
  if (typeof state.asset !== 'string' || state.asset.startsWith('evm:')) throw new E2eExit(2, 'NEAR lane only');
  if (typeof state.payee !== 'string' || !state.payee.startsWith('near:')) throw new E2eExit(2, 'NEAR lane only');
  const account = state.payee.slice('near:'.length);
  const amount = BigInt(state.amountBase);
  const before = BigInt(state.payeeBalanceBefore);

  const chain = io.chainFor(null);
  const deadline = io.nowMs() + FINISH_WAIT_MS;
  for (;;) {
    const view = await chain.getRequest(no);
    if (view === null) throw new E2eExit(1, `FINISH the contract has no request ${no}`);
    if (view.asset.startsWith('evm:')) throw new E2eExit(2, 'NEAR lane only');
    if (view.state === 'Executed') break;
    if (view.state === 'Rejected' || view.state === 'Expired' || view.state === 'Blocked' || view.state === 'Failed') throw new E2eExit(1, `FINISH request ${no} ended in state ${view.state}`);
    if (io.nowMs() >= deadline) throw new E2eExit(1, `FINISH request ${no} did not execute within ${FINISH_WAIT_MS / 1000} s, state ${view.state}`);
    await io.sleep(POLL_MS);
  }
  await proveNearPayment(io, account, before, amount, BALANCE_WAIT_MS);
  const txHash = io.approveTxId(no);
  if (!isTxHash(txHash)) throw new E2eExit(1, `FINISH no approve transaction id (target/approve-${no}.txid, written by scripts/approve-cli.sh ${no} --run)`);
  printPaid(io, amount, account, txHash);
  const link = `${NEARBLOCKS}${txHash}`;
  if (opts.evidence === true) recordEvidence(io, evidenceRow(io, caseId, 'approved executed', link, state.request_id));
  return { caseId, skipped: false, outcome: 'allowed', reason: null, requestId: state.request_id, pendingNo: no, txHash, link };
}

// ---- entry ----

/**
 * The exit code of one invocation. `io` is built (from `env`) only after the arguments and LLM_MODE pass, so a refused run makes no call.
 * `out` receives the refusal lines; the case lines go through `io.out`.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io?: CaseIo, out: (line: string) => void = (l) => console.log(l)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'usage') {
    out(parsed.message);
    return 2;
  }
  try {
    if (parsed.kind === 'check-agent-key') {
      const c = await (io ?? liveCaseIo(env)).checks.agentKey();
      out(c.line);
      return c.ok ? 0 : 1;
    }
    const mode = env.LLM_MODE;
    if (mode !== 'record' && mode !== 'live' && mode !== 'replay') {
      out('LLM_MODE must be set to record, live or replay');
      return 2;
    }
    const caseIo = io ?? liveCaseIo(env);
    if (parsed.finish !== undefined) await finishCase(parsed.caseId, parsed.finish, { evidence: parsed.evidence }, caseIo);
    else await runCase(parsed.caseId, { recordChain: parsed.recordChain, evidence: parsed.evidence }, caseIo);
    return 0;
  } catch (e) {
    if (e instanceof RunFailed || e instanceof BudgetExhaustedError || !(e instanceof E2eExit)) {
      if (e instanceof RunFailed) out(e.line);
      out(flakeLine(describeFailure(e)));
      return 1;
    }
    out(e.line);
    return e.code;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(flakeLine(describeFailure(e)));
      process.exitCode = 1;
    },
  );
}

// AIR-102: live smoke tests of the deployed policy contract against the real MPC signer on NEAR testnet and Base Sepolia.
//   pnpm tsx scripts/mpc-smoke.ts --derive [--min-wei <n>]     read only: address and Base Sepolia balance
//   pnpm tsx scripts/mpc-smoke.ts --send [--record] [--note <text>]
//                                                              SIGNS and BROADCASTS one 0.00001 ETH payment on Base Sepolia
//   pnpm tsx scripts/mpc-smoke.ts --near-lane                  SIGNS a NEAR transaction: pays 0.1 NEAR to sam
//   pnpm tsx scripts/mpc-smoke.ts --escalate                   submits a task the gate escalates (no payment)
//   pnpm tsx scripts/mpc-smoke.ts --latency <n> [--max-p95 <s>] [--record]
//                                                              n sequential signatures, never broadcast, then a nonce resync
//   pnpm tsx scripts/mpc-smoke.ts --check-fixture              offline, no keys: assemble the recorded real response
// NEAR transactions go through the near CLI with the keychain (sign-with-keychain); this file never reads an account key. The task
// key is read only inside sign-task.ts. Run `python3 scripts/signer-weather.py` before --send and --latency (CLAUDE.md).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, keccak256 } from 'viem';
import type { Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
// @ts-expect-error task-key.mjs is plain JavaScript without declarations
import { loadSeedHex } from './task-key.mjs';
import { assembleEvm, senderOf, sigFromMpc } from '../runtime/src/chain/evm.ts';
import { signTask } from './sign-task.ts';
import { taskHash } from '../runtime/src/dsl/task.ts';
import type { OwnerTask } from '../runtime/src/dsl/task.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** The MPC signer's response for a secp256k1 request, as `on_signed` receives it. */
export interface MpcResponse {
  scheme: string;
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

export interface AssembledTx {
  raw: Hex;
  signer: string;
}

/**
 * The one assembler of the repo is `assembleEvm` (runtime/src/chain/evm.ts, AIR-162); this wraps it for the smoke tests: the scheme is
 * checked here, the hex is lowercased (assembleEvm takes lowercase), and the signer is recovered with `senderOf`.
 */
export async function assembleSigned(unsignedHex: string, response: MpcResponse): Promise<AssembledTx> {
  if (response.scheme !== 'Secp256k1') throw new Error('response scheme is not Secp256k1');
  const flat = sigFromMpc(response);
  const raw = assembleEvm(unsignedHex, { big_r: flat.big_r.toLowerCase(), s: flat.s.toLowerCase(), recovery_id: flat.recovery_id });
  return { raw, signer: await senderOf(raw) };
}
const SIGNER = 'v1.signer-prod.testnet';
const NEAR_RPCS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs', 'https://rpc.testnet.near.org'];
const BASE_RPCS = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
const POLL_MS = 500;
const POLL_MAX_MS = 120_000;
const EVIDENCE = join(ROOT, 'docs', 'EVIDENCE.md');
const SECTION = '## Real MPC (AIR-102)';

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as T;
}
const accounts = readJson<Record<string, string>>('fixtures/accounts.testnet.json');
const policyJson = readJson<{ book: { name: string; key: string }[]; nonce: { path: string } }>('fixtures/policy.json');
const POLICY = accounts.policy as string;
const AGENT = accounts.agent as string;
const OWNER = accounts.owner as string;
const EVM_PATH = policyJson.nonce.path;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const today = (): string => new Date().toLocaleDateString('en-CA');

// ---------- RPC ----------
async function post(urls: string[], body: unknown): Promise<{ result?: unknown; error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown } }> {
  let last: unknown = new Error('no rpc url');
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      return (await res.json()) as { result?: unknown; error?: { name?: string } };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function nearRpc(method: string, params: unknown): Promise<any> {
  const j = await post(NEAR_RPCS, { jsonrpc: '2.0', id: 1, method, params });
  if (j.error) throw new Error(`near rpc ${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}

async function baseRpc(method: string, params: unknown[]): Promise<string> {
  const j = await post(BASE_RPCS, { jsonrpc: '2.0', id: 1, method, params });
  if (j.error || typeof j.result !== 'string') throw new Error(`base rpc ${method}: ${JSON.stringify(j.error ?? j.result).slice(0, 300)}`);
  return j.result;
}

function deriveAddress(): string {
  const out = spawnSync(process.execPath, [join(HERE, 'derive-address.mjs'), POLICY, EVM_PATH], { encoding: 'utf8' });
  const addr = out.stdout.trim();
  if (out.status !== 0 || !/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('derive-address.mjs failed');
  return addr;
}

async function nearBalance(account: string): Promise<bigint> {
  const r = await nearRpc('query', { request_type: 'view_account', finality: 'final', account_id: account });
  return BigInt(r.amount);
}

// ---------- NEAR transactions through the near CLI (keychain) ----------
function nearCall(contract: string, method: string, args: unknown, gas: string, deposit: string, signer: string): string {
  const argv = ['contract', 'call-function', 'as-transaction', contract, method, 'json-args', JSON.stringify(args), 'prepaid-gas', gas, 'attached-deposit', deposit, 'sign-as', signer, 'network-config', 'testnet', 'sign-with-keychain', 'send'];
  const out = spawnSync('near', argv, { encoding: 'utf8', maxBuffer: 1 << 24 });
  const text = `${out.stdout}\n${out.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const m = /Transaction ID: ([1-9A-HJ-NP-Za-km-z]+)/.exec(text);
  if (!m) throw new Error(`near CLI gave no transaction id (exit ${out.status}): ${text.trim().split('\n').slice(-5).join(' | ').slice(0, 400)}`);
  return m[1] as string;
}

interface Ev {
  event: string;
  data: Record<string, any>;
}

function eventsOf(tx: any): Ev[] {
  const outcomes = [tx.transaction_outcome, ...(tx.receipts_outcome ?? [])];
  const evs: Ev[] = [];
  for (const o of outcomes) {
    for (const line of (o?.outcome?.logs ?? []) as string[]) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      try {
        const j = JSON.parse(line.slice('EVENT_JSON:'.length));
        if (j.standard === 'airlock' && typeof j.event === 'string') evs.push({ event: j.event, data: (j.data?.[0] ?? {}) as Record<string, any> });
      } catch {
        // not ours
      }
    }
  }
  return evs;
}

function txFailure(tx: any): string | null {
  const bad = [tx.status, ...(tx.receipts_outcome ?? []).map((o: any) => o?.outcome?.status)].find((s) => s && typeof s === 'object' && 'Failure' in s);
  return bad ? JSON.stringify(bad.Failure).slice(0, 300) : null;
}

/** Poll the RPC `tx` every 500 ms for at most 120 s until `done` accepts the events of every receipt. */
async function pollTx(hash: string, sender: string, done: (evs: Ev[]) => boolean): Promise<{ tx: any; evs: Ev[]; doneAt: number }> {
  const deadline = Date.now() + POLL_MAX_MS;
  for (;;) {
    try {
      const tx = await nearRpc('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' });
      const evs = eventsOf(tx);
      if (done(evs)) return { tx, evs, doneAt: Date.now() };
      const bad = txFailure(tx);
      if (bad && !evs.length) throw new Error(`transaction failed: ${bad}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('transaction failed')) throw e;
      // timeout or not yet indexed: poll again
    }
    if (Date.now() > deadline) throw new Error(`no result for ${hash} within ${POLL_MAX_MS / 1000} s`);
    await sleep(POLL_MS);
  }
}

// ---------- the test task ----------
const bookKey = (name: string): string => {
  const entry = policyJson.book.find((b) => b.name === name);
  if (!entry) throw new Error(`book entry ${name} missing`);
  return entry.key.replace(/\{(\w+)\}/g, (_m, k: string) => accounts[k] ?? '');
};

interface Scenario {
  payee: string;
  bound: string;
  asset: string;
  amount: string;
  masks: { recipient: number; amount: number; pc: number };
  evm: { gas_limit: string; max_fee_per_gas: string; max_priority_fee_per_gas: string } | null;
}

const SCENARIOS: Record<'send' | 'near' | 'escalate', () => Scenario> = {
  send: () => ({
    payee: bookKey('contractor'), bound: '1000000000000000', asset: 'evm:84532:native', amount: '10000000000000',
    masks: { recipient: 2, amount: 1, pc: 1 }, evm: { gas_limit: '21000', max_fee_per_gas: '1000000000', max_priority_fee_per_gas: '1000000' },
  }),
  near: () => ({ payee: bookKey('sam'), bound: '1000000000000000000000000', asset: 'near', amount: '100000000000000000000000', masks: { recipient: 2, amount: 1, pc: 1 }, evm: null }),
  escalate: () => ({ payee: bookKey('accountant'), bound: '10000000000000000000000000', asset: 'near', amount: '9400000000000000000000000', masks: { recipient: 2, amount: 32, pc: 1 }, evm: null }),
};

interface Submitted {
  hash: string;
  startedAt: number;
  requestId: string;
  scenario: Scenario;
}

function submit(sc: Scenario, suffix = ''): Submitted {
  const now = Date.now();
  const planSha = sha256Hex('airlock-mpc-smoke-plan');
  const task: OwnerTask = {
    tag: 'airlock-task-v1',
    task_id: `smoke-${Math.floor(now / 1000)}${suffix}`,
    contract_id: POLICY,
    agent_id: AGENT,
    plan_sha256: planSha,
    instruction_sha256_salted: sha256Hex(`airlock-mpc-smoke-instruction:${randomBytes(16).toString('hex')}`),
    issued_ms: now - 5_000,
    expires_ms: now + 1_800_000,
    max_actions: 1,
    bounds: [{ payee_key: sc.payee, max_total: sc.bound }],
  };
  const signed = signTask(task, loadSeedHex());
  const req = {
    task_id: task.task_id, action_index: 0, asset: sc.asset, payee: sc.payee, amount: sc.amount, labels: sc.masks, evm: sc.evm,
    hints: { plan_hash: planSha, trace_digest: '0'.repeat(64) },
  };
  const startedAt = Date.now();
  const hash = nearCall(POLICY, 'submit_batch', { reqs: [req], task: signed.task, task_sig: signed.task_sig }, '300 Tgas', '0 NEAR', AGENT);
  return { hash, startedAt, requestId: `${taskHash(task)}:0`, scenario: sc };
}

const TERMINAL = ['signed', 'failed', 'blocked', 'escalated', 'paid'];
const forRequest = (evs: Ev[], rid: string, names: string[]): Ev | undefined => evs.find((e) => e.data.request_id === rid && names.includes(e.event));

/** The outcome executed by the MPC signer whose SuccessValue decodes to JSON with a `scheme`: the exact bytes `on_signed` received. */
function captureMpcResponse(tx: any): Buffer | null {
  for (const o of tx.receipts_outcome ?? []) {
    if (o?.outcome?.executor_id !== SIGNER) continue;
    const value = o.outcome.status?.SuccessValue;
    if (typeof value !== 'string' || value === '') continue;
    const bytes = Buffer.from(value, 'base64');
    try {
      const j = JSON.parse(bytes.toString('utf8'));
      if (j && typeof j === 'object' && 'scheme' in j) return bytes;
    } catch {
      // not a signature response
    }
  }
  return null;
}

// ---------- evidence ----------
async function codeHash(): Promise<string> {
  const r = await nearRpc('query', { request_type: 'view_account', finality: 'final', account_id: POLICY });
  return String(r.code_hash);
}

function appendEvidence(lines: string[]): void {
  const text = readFileSync(EVIDENCE, 'utf8');
  const rows = text.split('\n');
  const start = rows.findIndex((l) => l.trim() === SECTION);
  const table = ['| What | Network | Id / hash / link | Date |', '| --- | --- | --- | --- |'];
  if (start < 0) {
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    rows.push('', SECTION, '', ...table, ...lines.filter((l) => l.startsWith('|')), '', ...lines.filter((l) => !l.startsWith('|')), '');
  } else {
    let end = rows.findIndex((l, i) => i > start && l.startsWith('## '));
    if (end < 0) end = rows.length;
    const body = rows.slice(start + 1, end);
    while (body.length && body[body.length - 1] === '') body.pop();
    if (!body.some((l) => l.startsWith('| What |'))) body.unshift('', ...table);
    const lastTable = body.map((l) => l.startsWith('|')).lastIndexOf(true);
    const tableRows = lines.filter((l) => l.startsWith('|'));
    const rest = lines.filter((l) => !l.startsWith('|'));
    body.splice(lastTable + 1, 0, ...tableRows);
    if (rest.length) body.push('', ...rest);
    rows.splice(start + 1, end - start - 1, ...body, '');
  }
  writeFileSync(EVIDENCE, rows.join('\n').replace(/\n*$/, '\n'));
}

// ---------- modes ----------
async function modeDerive(minWei: bigint): Promise<number> {
  const address = deriveAddress();
  const wei = BigInt(await baseRpc('eth_getBalance', [address, 'latest']));
  console.log(`address ${address}`);
  console.log(`balance ${wei} wei`);
  if (wei < minWei) {
    console.log(`balance below the minimum of ${minWei} wei`);
    return 1;
  }
  return 0;
}

async function broadcast(raw: Hex): Promise<{ hash: Hex; status: string }> {
  let lastError: unknown = new Error('no base rpc');
  for (const url of BASE_RPCS) {
    const client = createPublicClient({ chain: baseSepolia, transport: http(url) });
    try {
      let hash: Hex;
      try {
        hash = await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        if (!/already known|known transaction/i.test(String(e))) throw e;
        hash = keccak256(raw);
      }
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return { hash, status: receipt.status };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function modeSend(record: boolean, note: string): Promise<number> {
  const derived = deriveAddress();
  const s = submit(SCENARIOS.send());
  console.log(`NEAR tx ${s.hash}`);
  const { tx, evs } = await pollTx(s.hash, AGENT, (e) => forRequest(e, s.requestId, TERMINAL) !== undefined);
  const end = forRequest(evs, s.requestId, TERMINAL) as Ev;
  if (end.event !== 'signed') {
    console.log(`request ended ${end.event} ${JSON.stringify(end.data)}`);
    return 1;
  }
  console.log('signed event ok');
  const unsignedHex = forRequest(evs, s.requestId, ['evm_unsigned'])?.data.unsigned_hex as string | undefined;
  if (!unsignedHex) {
    console.log('evm_unsigned event not found');
    return 1;
  }
  const responseBytes = captureMpcResponse(tx);
  if (!responseBytes) {
    console.log('raw MPC response not found in receipts');
    return 1;
  }
  const assembled = await assembleSigned(unsignedHex, JSON.parse(responseBytes.toString('utf8')) as MpcResponse);
  if (assembled.signer.toLowerCase() !== derived.toLowerCase()) {
    console.log(`sender MISMATCH: recovered ${assembled.signer}, derived ${derived}`);
    return 1;
  }
  console.log('sender recovered = derived');
  const dir = join(ROOT, 'contracts', 'airlock-policy', 'tests', 'fixtures');
  const txRecord = { unsigned_hex: unsignedHex, sender: derived.toLowerCase(), chain_id: 84532, near_tx: s.hash, base_tx: null as string | null };
  writeFileSync(join(dir, 'mpc_sig_real.json'), responseBytes);
  writeFileSync(join(dir, 'mpc_sig_real_tx.json'), JSON.stringify(txRecord, null, 2) + '\n');
  const sent = await broadcast(assembled.raw);
  txRecord.base_tx = sent.hash;
  writeFileSync(join(dir, 'mpc_sig_real_tx.json'), JSON.stringify(txRecord, null, 2) + '\n');
  console.log(`BASE tx ${sent.hash} status ${sent.status}`);
  if (sent.status !== 'success') return 1;
  if (record) {
    const date = today();
    const lines = [
      `| Real MPC signature | NEAR testnet and Base Sepolia | https://testnet.nearblocks.io/txns/${s.hash} https://sepolia.basescan.org/tx/${sent.hash} | ${date} |`,
      `- ${date}: contract ${POLICY}, code hash ${await codeHash()}, derived address ${derived}${note ? `, ${note}` : ''}`,
    ];
    appendEvidence(lines);
    console.log('recorded in docs/EVIDENCE.md');
  }
  return 0;
}

async function modeNearLane(): Promise<number> {
  const sc = SCENARIOS.near();
  const payee = sc.payee.replace(/^near:/, '');
  const before = await nearBalance(payee);
  const s = submit(sc);
  console.log(`NEAR tx ${s.hash}`);
  const { evs } = await pollTx(s.hash, AGENT, (e) => forRequest(e, s.requestId, TERMINAL) !== undefined);
  const end = forRequest(evs, s.requestId, TERMINAL) as Ev;
  if (end.event !== 'paid') {
    console.log(`request ended ${end.event} ${JSON.stringify(end.data)}`);
    return 1;
  }
  const after = await nearBalance(payee);
  if (after - before !== BigInt(sc.amount)) {
    console.log(`balance of ${payee} rose by ${after - before}, expected ${sc.amount}`);
    return 1;
  }
  console.log(`paid 0.1 NEAR to ${payee}`);
  return 0;
}

async function modeEscalate(): Promise<number> {
  const s = submit(SCENARIOS.escalate());
  console.log(`NEAR tx ${s.hash}`);
  const { evs } = await pollTx(s.hash, AGENT, (e) => forRequest(e, s.requestId, TERMINAL) !== undefined);
  const end = forRequest(evs, s.requestId, TERMINAL) as Ev;
  if (end.event !== 'escalated' || end.data.reason !== 'UntrustedAmount') {
    console.log(`request ended ${end.event} ${JSON.stringify(end.data)}`);
    return 1;
  }
  mkdirSync(join(ROOT, 'target'), { recursive: true });
  writeFileSync(join(ROOT, 'target', 'last-pending-id'), `${end.data.id}\n`);
  console.log(`escalated UntrustedAmount pending_id ${end.data.id}`);
  return 0;
}

async function resyncNonce(): Promise<void> {
  const chain = BigInt(await baseRpc('eth_getTransactionCount', [deriveAddress(), 'pending']));
  const view = await nearRpc('query', { request_type: 'call_function', finality: 'final', account_id: POLICY, method_name: 'get_nonce', args_base64: Buffer.from(JSON.stringify({ path: EVM_PATH })).toString('base64') });
  const stored = JSON.parse(Buffer.from(view.result).toString('utf8')) as string | null;
  const contract = stored === null ? 0n : BigInt(stored);
  if (contract === chain) {
    console.log(`nonce in sync ${chain}`);
    return;
  }
  const hash = nearCall(POLICY, 'set_nonce', { path: EVM_PATH, nonce: chain.toString() }, '30 Tgas', '1 yoctoNEAR', OWNER);
  await pollTx(hash, OWNER, (evs) => evs.some((e) => e.event === 'nonce_set'));
  console.log(`nonce resynced to ${chain}`);
}

async function modeLatency(n: number, maxP95: number, record: boolean, note: string): Promise<number> {
  const secs: number[] = [];
  let failure: string | null = null;
  try {
    for (let i = 0; i < n; i++) {
      const s = submit(SCENARIOS.send(), `-${i}`);
      const { evs, doneAt } = await pollTx(s.hash, AGENT, (e) => forRequest(e, s.requestId, TERMINAL) !== undefined);
      const end = forRequest(evs, s.requestId, TERMINAL) as Ev;
      if (end.event !== 'signed') {
        failure = `request ${i} ended ${end.event} ${JSON.stringify(end.data)}`;
        break;
      }
      secs.push((doneAt - s.startedAt) / 1000);
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  let code = 0;
  if (failure) {
    console.log(`latency series stopped: ${failure}`);
    code = 1;
  }
  if (secs.length > 0) {
    const sorted = [...secs].sort((a, b) => a - b);
    const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
    const line = `LATENCY n=${secs.length} p50=${at(0.5).toFixed(1)} p95=${at(0.95).toFixed(1)} max=${(sorted[sorted.length - 1] as number).toFixed(1)}`;
    console.log(line);
    if (secs.length === n && at(0.95) > maxP95) {
      console.log(`p95 above ${maxP95} s`);
      code = 1;
    }
    if (record && code === 0) appendEvidence([`- ${today()}: ${line}${note ? `, ${note}` : ''}`]);
  }
  // the signatures were never broadcast: resync the contract nonce to the chain
  try {
    await resyncNonce();
  } catch (e) {
    console.log(`nonce resync failed: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  }
  return code;
}

async function modeCheckFixture(): Promise<number> {
  const dir = process.env.MPC_FIXTURE_DIR ?? join(ROOT, 'contracts', 'airlock-policy', 'tests', 'fixtures');
  const resp = JSON.parse(readFileSync(join(dir, 'mpc_sig_real.json'), 'utf8')) as MpcResponse;
  const rec = JSON.parse(readFileSync(join(dir, 'mpc_sig_real_tx.json'), 'utf8')) as { unsigned_hex: string; sender: string; chain_id: number };
  try {
    const out = await assembleSigned(rec.unsigned_hex.replace(/^0x/, ''), resp);
    if (out.signer.toLowerCase() !== rec.sender.toLowerCase()) {
      console.log(`fixture sender MISMATCH: recovered ${out.signer}, recorded ${rec.sender}`);
      return 1;
    }
    console.log(`fixture sender recovered = ${out.signer}`);
    return 0;
  } catch (e) {
    console.log(`fixture does not assemble: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ---------- entry ----------
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const note = flag(argv, '--note') ?? '';
  const record = argv.includes('--record');
  if (argv.includes('--check-fixture')) return modeCheckFixture();
  if (argv.includes('--derive')) return modeDerive(BigInt(flag(argv, '--min-wei') ?? '1000000000000000'));
  if (argv.includes('--send')) return modeSend(record, note);
  if (argv.includes('--near-lane')) return modeNearLane();
  if (argv.includes('--escalate')) return modeEscalate();
  if (argv.includes('--latency')) return modeLatency(Number(flag(argv, '--latency') ?? '20'), Number(flag(argv, '--max-p95') ?? '15'), record, note);
  process.stderr.write('usage: mpc-smoke.ts --derive [--min-wei n] | --send [--record] | --near-lane | --escalate | --latency n [--max-p95 s] [--record] | --check-fixture\n');
  return 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(EVIDENCE)) process.stderr.write('docs/EVIDENCE.md is missing\n');
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

// AIR-168: one live x402 v2 payment on Base Sepolia through AIRLOCK. The policy contract signs the EIP-3009 authorization (AIR-109), this
// script reads `x402_signed`, builds and verifies the PAYMENT-SIGNATURE payload locally, has the facilitator settle it on the test USDC and
// reads the receipt back.
//   pnpm -C runtime exec tsx scripts/x402-live.ts --facilitator https://x402.org/facilitator [--record]
// Prints `SETTLED <tx hash>` and `LINK https://sepolia.basescan.org/tx/<tx hash>`. Amounts are BigInt and strings only. Repo-root files
// resolve from import.meta.url. NEAR transactions go through the near CLI keychain; the task key is read only in scripts/sign-task.ts.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseEventLogs, erc20Abi } from 'viem';
import type { Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
// @ts-expect-error task-key.mjs is plain JavaScript without declarations
import { loadSeedHex } from '../../scripts/task-key.mjs';
import { signTask } from '../../scripts/sign-task.ts';
import { taskHash } from '../src/dsl/task.ts';
import type { OwnerTask } from '../src/dsl/task.ts';
import { PaymentRequiredV2, buildPaymentPayload, decodeX402Signed, encodePaymentHeader } from '../src/chain/x402.ts';
import type { X402Signed } from '../src/chain/x402.ts';
import { verifyLocally } from '../src/chain/x402-verify.ts';

const ROOT = new URL('../../', import.meta.url);
const rootPath = (rel: string): string => fileURLToPath(new URL(rel, ROOT));
const NEAR_RPCS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs', 'https://rpc.testnet.near.org'];
const BASE_RPCS = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
const POLL_MS = 500;
const POLL_MAX_MS = 120_000;
const EVIDENCE = rootPath('docs/EVIDENCE.md');
const SECTION = '## x402 authorization (AIR-109)';

interface AssetFixture {
  policy?: string;
  chain_id: number;
  token: string;
  path: string;
  payee: string;
}
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(rootPath(rel), 'utf8')) as T;
const accounts = readJson<Record<string, string>>('fixtures/accounts.testnet.json');
const fixture = readJson<AssetFixture>('fixtures/x402-asset.json');
const POLICY = fixture.policy ?? (accounts.policy as string);
const AGENT = accounts.agent as string;
const TOKEN = fixture.token;
const CHAIN_ID = fixture.chain_id;
const ASSET = `evm:${CHAIN_ID}:erc20:${TOKEN}`;
const PAYEE_KEY = `erc20:${CHAIN_ID}:${TOKEN}:${fixture.payee}`;
const BOUND = '1000000';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex');

// ---------- RPC ----------
async function nearRpc(method: string, params: unknown): Promise<any> {
  let last: unknown = new Error('no near rpc url');
  for (const url of NEAR_RPCS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      const j = (await res.json()) as { result?: unknown; error?: unknown };
      if (j.error) throw new Error(`near rpc ${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ---------- the NEAR transaction, through the near CLI keychain ----------
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

/** The events of the transaction, polled every 500 ms for at most 120 s until `x402_signed` or another terminal event of the request. */
async function pollRequest(hash: string, requestId: string): Promise<Ev[]> {
  const deadline = Date.now() + POLL_MAX_MS;
  for (;;) {
    try {
      const tx = await nearRpc('tx', { tx_hash: hash, sender_account_id: AGENT, wait_until: 'FINAL' });
      const evs = eventsOf(tx);
      if (evs.some((e) => e.event === 'x402_signed' && e.data.id === requestId)) return evs;
      if (evs.some((e) => ['failed', 'blocked', 'escalated'].includes(e.event) && e.data.request_id === requestId)) return evs;
    } catch {
      // timeout or not yet indexed: poll again
    }
    if (Date.now() > deadline) throw new Error(`no result for ${hash} within ${POLL_MAX_MS / 1000} s`);
    await sleep(POLL_MS);
  }
}

// ---------- the x402 request ----------
function submit(amount: string): { hash: string; requestId: string } {
  const now = Date.now();
  const planSha = sha256Hex('airlock-x402-simulate-plan');
  const task: OwnerTask = {
    tag: 'airlock-task-v1',
    task_id: `x402-${Math.floor(now / 1000)}`,
    contract_id: POLICY,
    agent_id: AGENT,
    plan_sha256: planSha,
    instruction_sha256_salted: sha256Hex(`airlock-x402-simulate-instruction:${randomBytes(16).toString('hex')}`),
    issued_ms: now - 5_000,
    expires_ms: now + 1_800_000,
    max_actions: 1,
    bounds: [{ payee_key: PAYEE_KEY, max_total: BOUND }],
  };
  const signed = signTask(task, loadSeedHex());
  const reqs = [
    {
      task_id: task.task_id, action_index: 0, asset: ASSET, payee: PAYEE_KEY, amount, labels: { recipient: 2, amount: 1, pc: 1 }, evm: null,
      hints: { plan_hash: planSha, trace_digest: '0'.repeat(64) },
    },
  ];
  const hash = nearCall(POLICY, 'submit_batch', { reqs, task: signed.task, task_sig: signed.task_sig }, '300 Tgas', '0 NEAR', AGENT);
  return { hash, requestId: `${taskHash(task)}:0` };
}


// ---------- settlement ----------
async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: res.status, json };
}

async function codeHash(): Promise<string> {
  const r = await nearRpc('query', { request_type: 'view_account', finality: 'final', account_id: POLICY });
  return String(r.code_hash);
}

function appendEvidence(row: string): void {
  const rows = readFileSync(EVIDENCE, 'utf8').split('\n');
  const start = rows.findIndex((l) => l.trim() === SECTION);
  if (start < 0) throw new Error(`${SECTION} is missing in docs/EVIDENCE.md`);
  let end = rows.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = rows.length;
  const body = rows.slice(start + 1, end);
  while (body.length && body[body.length - 1] === '') body.pop();
  const lastTable = body.map((l) => l.startsWith('|')).lastIndexOf(true);
  body.splice(lastTable + 1, 0, row);
  rows.splice(start + 1, end - start - 1, ...body, '');
  writeFileSync(EVIDENCE, rows.join('\n').replace(/\n*$/, '\n'));
}

async function main(argv: string[]): Promise<number> {
  const fi = argv.indexOf('--facilitator');
  const facilitator = fi >= 0 ? argv[fi + 1] : undefined;
  if (facilitator === undefined || !/^https:\/\//.test(facilitator)) {
    process.stderr.write('usage: x402-live.ts --facilitator <https url> [--record]\n');
    return 2;
  }
  const required = PaymentRequiredV2.parse(readJson('fixtures/x402-live/live-usdc.json'));
  const accepted = required.accepts[0];
  if (accepted === undefined) throw new Error('fixture has no accepts entry');
  const { hash, requestId } = submit(accepted.amount);
  console.log(`NEAR tx ${hash}`);
  const evs = await pollRequest(hash, requestId);
  const signedEv = evs.find((e) => e.event === 'x402_signed' && e.data.id === requestId);
  if (!signedEv) {
    const end = evs.find((e) => e.data.request_id === requestId && ['failed', 'blocked', 'escalated'].includes(e.event));
    console.log(`request ended ${end ? `${end.event} ${JSON.stringify(end.data)}` : 'without x402_signed'}`);
    return 1;
  }
  const ev = decodeX402Signed(`EVENT_JSON:${JSON.stringify({ standard: 'airlock', version: '1.0.0', event: 'x402_signed', data: [signedEv.data] })}`);
  if (ev === null) {
    console.log('x402_signed did not decode');
    return 1;
  }
  console.log('x402_signed ok');
  const payload = buildPaymentPayload(ev as X402Signed, required, 0);
  await verifyLocally(payload, BigInt(Math.floor(Date.now() / 1000)));
  console.log('verifyLocally ok');
  console.log(`PAYMENT-SIGNATURE ${encodePaymentHeader(payload).length} base64 chars`);

  const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted };
  const verified = await post(`${facilitator}/verify`, body);
  console.log(`facilitator verify ${verified.status} ${JSON.stringify(verified.json).slice(0, 300)}`);
  if (verified.status !== 200 || verified.json?.isValid !== true) return 1;
  const settled = await post(`${facilitator}/settle`, body);
  console.log(`facilitator settle ${settled.status} ${JSON.stringify(settled.json).slice(0, 2500)}`);
  const tx = settled.json?.transaction as string | undefined;
  if (settled.status !== 200 || settled.json?.success !== true || typeof tx !== 'string' || !/^0x[0-9a-f]{64}$/.test(tx)) return 1;

  let receipt: Awaited<ReturnType<ReturnType<typeof createPublicClient>['waitForTransactionReceipt']>> | undefined;
  let lastError: unknown = new Error('no base rpc');
  for (const url of BASE_RPCS) {
    try {
      const client = createPublicClient({ chain: baseSepolia, transport: http(url) });
      receipt = await client.waitForTransactionReceipt({ hash: tx as Hex, timeout: 90_000 });
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (receipt === undefined) {
    console.log(`receipt not read: ${String(lastError).slice(0, 300)}`);
    return 1;
  }
  if (receipt.status !== 'success') {
    console.log(`receipt status ${receipt.status}`);
    return 1;
  }
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === TOKEN.toLowerCase() && l.args.from.toLowerCase() === ev.from && l.args.to.toLowerCase() === ev.to && l.args.value === BigInt(ev.value),
  );
  if (transfers.length !== 1) {
    console.log(`expected one USDC Transfer(${ev.from}, ${ev.to}, ${ev.value}), found ${transfers.length}`);
    return 1;
  }
  console.log(`SETTLED ${tx}`);
  console.log(`LINK https://sepolia.basescan.org/tx/${tx}`);
  if (argv.includes('--record')) {
    const date = new Date().toLocaleDateString('en-CA');
    appendEvidence(`| x402 payment settled on Base Sepolia through AIRLOCK (AIR-168) | NEAR testnet and Base Sepolia | contract \`${POLICY}\`, code hash ${await codeHash()}, payer \`${ev.from}\`, payee \`${ev.to}\`, ${ev.value} base units of test USDC, facilitator ${facilitator}, NEAR tx [${hash}](https://testnet.nearblocks.io/txns/${hash}), settlement tx [${tx}](https://sepolia.basescan.org/tx/${tx}) | ${date} |`);
    console.log('recorded in docs/EVIDENCE.md');
  }
  return 0;
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

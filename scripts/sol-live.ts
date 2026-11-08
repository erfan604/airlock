// AIR-325: the live Solana devnet run of the Solana lane, against a policy account made by `pnpm airlock init` (its accounts.json, the
// owner's book vault and the task key). Testnet and devnet only. Signing goes through the near CLI's own keychain; this file never reads
// or prints a key, and the relayer holds no Solana key at all (the MPC-derived sender pays its own fee).
//   pnpm tsx scripts/sol-live.ts setup  --dir <dir>                  asset sol:devnet, the derived sender, the Solana payee in the book
//   pnpm tsx scripts/sol-live.ts submit --dir <dir> --case <allowed|held> [--index <n>]
//   pnpm tsx scripts/sol-live.ts sign   --dir <dir> --id <request id>  sign_sol with the latest devnet blockhash (agent)
//   pnpm tsx scripts/sol-live.ts relay  --dir <dir> --id <request id>  assemble and broadcast on devnet, then confirm
//   pnpm tsx scripts/sol-live.ts status --dir <dir>                    the sender, its devnet balance and the MPC view's key
// A held request is approved by the owner with `pnpm airlock approve <pending id> --dir <dir>` between `submit` and `sign`.
// Output lines: SENDER, BALANCE, TX <what> <near link>, REQUEST, OUTCOME, PENDING, SIGNED, SOLANA <devnet link>, CONFIRMED, FAILED.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contracts } from 'chainsig.js';
// @ts-expect-error task-key.mjs is plain JavaScript without declarations
import { loadSeedHex } from './task-key.mjs';
import { signTask } from './sign-task.ts';
import { DEVNET_RPC, SOLANA_EXPLORER, assembleSolanaTx, balanceOf, latestBlockhash, sendTransaction, solanaTxId, statusOf } from '../runtime/src/chain/solana.ts';
import { OwnerTask, TASK_TAG, ownerTaskBorsh } from '../runtime/src/dsl/task.ts';
import { loadVault, saveVault } from '../runtime/src/vault/file.ts';

const NEAR = process.env.NEAR ?? 'near';
const RPC = 'https://test.rpc.fastnear.com';
const NEARBLOCKS = 'https://testnet.nearblocks.io/txns/';
const MPC = 'v1.signer-prod.testnet';
const ASSET = 'sol:devnet';
const PATH = 'sol-devnet-1';
// a devnet payee whose key is the published throwaway of the task-key vector (32 bytes of 01); nobody's real address
const PAYEE = 'sol:devnet:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
// lamports: the allowed case is Owner-labelled and inside every limit; the held case has an untrusted (email) amount above the 0.005 SOL cap.
// Both are above the 890880 lamports a new Solana account needs to exist (rent exemption).
const CASES = {
  allowed: { amount: 2_000_000n, labels: { recipient: 2, amount: 1, pc: 1 } },
  held: { amount: 10_000_000n, labels: { recipient: 2, amount: 32, pc: 1 } },
} as const;
const ASSET_ENTRY = {
  symbol: 'SOL',
  decimals: 9,
  hard_cap: '100000000',
  daily_cap: '500000000',
  max_fee_per_gas: '0',
  max_gas: '0',
  quick_task_cap: '500000000',
  path: PATH,
};

class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface Ctx {
  dir: string;
  owner: string;
  policy: string;
  agent: string;
  vaultPath: string;
}

function ctxOf(argv: string[]): Ctx {
  const dir = resolve(flag(argv, '--dir') ?? '');
  const a = JSON.parse(readFileSync(resolve(dir, 'accounts.json'), 'utf8')) as { owner?: string; policy?: string; agent?: string };
  for (const v of [a.owner, a.policy, a.agent]) if (typeof v !== 'string' || !v.endsWith('.testnet')) throw new Exit(2, 'REFUSED: accounts.json must name testnet owner, policy and agent');
  return { dir, owner: a.owner as string, policy: a.policy as string, agent: a.agent as string, vaultPath: resolve(dir, 'book.vault.json') };
}

async function view<T>(contract: string, method: string, args: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    }),
  });
  const body = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
  if (body.result?.result === undefined) throw new Exit(1, `FAILED: view ${method}: ${JSON.stringify(body.error ?? body.result).slice(0, 300)}`);
  return JSON.parse(Buffer.from(body.result.result).toString('utf8')) as T;
}

/** One signed call through the near CLI keychain; returns the transaction id. A failed receipt is a FAILED exit with the CLI's text. */
function call(signer: string, contract: string, method: string, args: unknown, deposit: string, gas = '100 Tgas'): string {
  const r = spawnSync(NEAR, ['contract', 'call-function', 'as-transaction', contract, method, 'json-args', JSON.stringify(args), 'prepaid-gas', gas, 'attached-deposit', deposit, 'sign-as', signer, 'network-config', 'testnet', 'sign-with-keychain', 'send'], { encoding: 'utf8' });
  const out = `${r.stdout}\n${r.stderr}`;
  const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1];
  if (r.status !== 0 || tx === undefined || /Failure|panicked|Smart contract panicked/.test(out)) {
    throw new Exit(1, `FAILED: ${method}${tx === undefined ? '' : ` ${NEARBLOCKS}${tx}`}: ${out.split('\n').filter((l) => /rror|anic|ailure/.test(l)).slice(0, 4).join(' | ')}`);
  }
  console.log(`TX ${method} ${NEARBLOCKS}${tx}`);
  return tx;
}

/** The sender the MPC derives for (policy, path) on domain 1: chainsig.js offline, checked against the signer's own view. */
async function derivedSender(policy: string): Promise<string> {
  const contract = new contracts.ChainSignatureContract({ networkId: 'testnet', contractId: MPC });
  const offline = String(await contract.getDerivedPublicKey({ path: PATH, predecessor: policy, IsEd25519: true }));
  const live = await view<string>(MPC, 'derived_public_key', { path: PATH, predecessor: policy, domain_id: 1 });
  if (offline !== live) throw new Exit(1, `FAILED: chainsig.js derives ${offline} but ${MPC} answers ${live}`);
  return offline.replace(/^ed25519:/, '');
}

async function setup(c: Ctx): Promise<void> {
  const sender = await derivedSender(c.policy);
  console.log(`SENDER ${sender} (chainsig.js and ${MPC} derived_public_key agree)`);
  const assets = await view<[string, unknown][] | { asset: string }[]>(c.policy, 'list_assets', {});
  if (!JSON.stringify(assets).includes(`"${ASSET}"`)) call(c.owner, c.policy, 'asset_set', { asset: ASSET, entry: ASSET_ENTRY }, '1 yoctoNEAR');
  if ((await view<string | null>(c.policy, 'get_sol_sender', { asset: ASSET })) !== sender) call(c.owner, c.policy, 'sol_sender_set', { asset: ASSET, sender }, '1 yoctoNEAR');
  const vault = loadVault(c.vaultPath);
  if (!vault.has(PAYEE)) {
    const next = vault.add({ payee: PAYEE, cap: 5_000_000n, dailyUntrustedBudget: 20_000_000n, dailyLimit: 50_000_000n, label: 'Solana payee' });
    const chainRoot = await view<string>(c.policy, 'get_book_root', {});
    if (chainRoot !== vault.root()) throw new Exit(1, `FAILED: the chain root ${chainRoot} is not the vault's ${vault.root()}`);
    call(c.owner, c.policy, 'book_set_root', { expected_old: vault.root(), new_root: next.root() }, '1 yoctoNEAR');
    saveVault(next, c.vaultPath);
  }
  console.log(`BOOK root ${await view<string>(c.policy, 'get_book_root', {})} holds ${PAYEE}`);
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function submit(c: Ctx, which: keyof typeof CASES, index: number): Promise<void> {
  const k = CASES[which];
  const now = Date.now();
  const plan = sha256Hex(Buffer.from(`air-325 ${which} ${now}`));
  const task = OwnerTask.parse({
    tag: TASK_TAG,
    task_id: `air-325-${which}-${now}`,
    contract_id: c.policy,
    agent_id: c.agent,
    plan_sha256: plan,
    instruction_sha256_salted: sha256Hex(Buffer.from(`pay the Solana payee ${now}`)),
    issued_ms: now - 60_000,
    expires_ms: now + 30 * 60_000,
    max_actions: 4,
    bounds: [{ payee_key: PAYEE, max_total: '50000000' }],
  });
  const signed = signTask(task, loadSeedHex());
  const proof = loadVault(c.vaultPath).proofFor(PAYEE);
  if (proof === null) throw new Exit(1, 'FAILED: the payee is not in the vault; run setup first');
  const req = {
    task_id: task.task_id,
    action_index: index,
    asset: ASSET,
    payee: PAYEE,
    amount: k.amount.toString(),
    labels: k.labels,
    evm: null,
    hints: { plan_hash: plan, trace_digest: '0'.repeat(64) },
    book: proof,
  };
  call(c.agent, c.policy, 'submit_batch', { reqs: [req], task: signed.task, task_sig: signed.task_sig }, '0 NEAR', '300 Tgas');
  const id = `${sha256Hex(ownerTaskBorsh(task))}:${index}`;
  console.log(`REQUEST ${id}`);
  const rec = await view<{ state?: string; id?: string | null; reason?: string | null } | null>(c.policy, 'get_request', { id });
  console.log(`OUTCOME ${rec?.state ?? 'missing'}${rec?.reason ? ` ${rec.reason}` : ''}`);
  if (rec?.id) console.log(`PENDING ${rec.id} (approve: pnpm airlock approve ${rec.id} --dir ${c.dir})`);
}

async function sign(c: Ctx, id: string): Promise<void> {
  const blockhash = await latestBlockhash(DEVNET_RPC);
  console.log(`BLOCKHASH ${blockhash}`);
  call(c.agent, c.policy, 'sign_sol', { request_id: id, recent_blockhash: blockhash }, '0 NEAR', '100 Tgas');
  const a = await view<{ signature_hex: string | null; in_flight: boolean } | null>(c.policy, 'get_sol_attempt', { request_id: id });
  const rec = await view<{ state?: string; reason?: string | null } | null>(c.policy, 'get_request', { id });
  if (a?.signature_hex == null) throw new Exit(1, `FAILED: no signature stored (state ${rec?.state ?? 'missing'}${rec?.reason ? ` ${rec.reason}` : ''})`);
  console.log(`SIGNED ${solanaTxId(a.signature_hex)} state ${rec?.state ?? 'missing'}`);
}

async function relay(c: Ctx, id: string): Promise<void> {
  const a = await view<{ message_hex: string; signature_hex: string | null; sender: string } | null>(c.policy, 'get_sol_attempt', { request_id: id });
  if (a?.signature_hex == null) throw new Exit(1, 'FAILED: the request has no stored signature; run sign first');
  const txId = await sendTransaction(DEVNET_RPC, assembleSolanaTx(a.message_hex, a.signature_hex));
  if (txId !== solanaTxId(a.signature_hex)) throw new Exit(1, `FAILED: the node answered ${txId}, not the signature's id`);
  console.log(`SOLANA ${SOLANA_EXPLORER(txId)}`);
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const s = await statusOf(DEVNET_RPC, txId);
    if (s.err !== null) throw new Exit(1, `FAILED: ${txId} ended with ${JSON.stringify(s.err)}`);
    if (s.status === 'confirmed' || s.status === 'finalized') {
      console.log(`CONFIRMED ${s.status} ${txId}`);
      return;
    }
  }
  console.log(`PENDING-CONFIRMATION ${txId} (check ${SOLANA_EXPLORER(txId)})`);
}

async function status(c: Ctx): Promise<void> {
  const sender = await derivedSender(c.policy);
  console.log(`SENDER ${sender}`);
  console.log(`BALANCE ${(await balanceOf(DEVNET_RPC, sender)).toString()} lamports on devnet`);
  console.log(`REGISTERED ${String(await view<string | null>(c.policy, 'get_sol_sender', { asset: ASSET }))}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const c = ctxOf(rest);
  const id = flag(rest, '--id');
  if (cmd === 'setup') await setup(c);
  else if (cmd === 'submit') {
    const which = flag(rest, '--case');
    if (which !== 'allowed' && which !== 'held') throw new Exit(2, 'usage: submit --dir <dir> --case <allowed|held> [--index <n>]');
    await submit(c, which, Number.parseInt(flag(rest, '--index') ?? '0', 10));
  } else if (cmd === 'sign' && id !== undefined) await sign(c, id);
  else if (cmd === 'relay' && id !== undefined) await relay(c, id);
  else if (cmd === 'status') await status(c);
  else throw new Exit(2, 'usage: sol-live.ts <setup|submit|sign|relay|status> --dir <dir> [--case allowed|held] [--id <request id>]');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = e instanceof Exit ? e.code : 1;
  },
);

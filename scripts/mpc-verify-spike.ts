// AIR-342: one bounded ask of the testnet MPC signer's verify_foreign_transaction about an existing Base Sepolia transaction.
// Dry by default: prints the planned call and exits. Live needs both `--live` and MPC_VERIFY_LIVE=1, sends one call at 20 Tgas,
// allows one retry at 30 Tgas when the failure text says timeout or gas, and then refuses every further call.
// Signs through the near CLI keychain by account name; never reads a key file.
// Request shape: near/mpc tag 3.18.0 (commit e691bdb98d68dcf74653da58d043453a6318765f, the version the testnet signer reports),
// crates/near-mpc-contract-interface/src/types/foreign_chain.rs (VerifyForeignTransactionRequestArgs, EvmRpcRequest) and
// crates/contract/src/api/foreign_chain/requests.rs (verify_foreign_transaction).
//   npx tsx scripts/mpc-verify-spike.ts                 dry run
//   MPC_VERIFY_LIVE=1 npx tsx scripts/mpc-verify-spike.ts --live
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNER_CONTRACT = 'v1.signer-prod.testnet';
export const METHOD = 'verify_foreign_transaction';
/** The CONTRACTOR row of docs/EVIDENCE.md (AIR-165), a mined Base Sepolia transfer with no logs. */
export const DEFAULT_TX = '0x943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63';
export const DEFAULT_SIGNER = 'lp1.airlock-credit-c1108d.testnet';
/** The ForeignTx domain in the live signer state (domain 3, CaitSith, purpose ForeignTx). */
export const FOREIGN_TX_DOMAIN = 3;
/** The live config's sign_call_gas_attachment_requirement_tera_gas, which verify_foreign_transaction also checks. */
export const MIN_GAS_TGAS = 15;
export const INITIAL_GAS_TGAS = 20;
export const RETRY_GAS_TGAS = 30;
const MIN_BALANCE_YOCTO = 5n * 10n ** 23n; // 0.5 NEAR

export type Plan = { contract: string; method: string; signer: string; args: object; deposit: string; gasTgas: number };
export type SendResult = { ok: boolean; tx: string; out: string; ms: number };
export type Attempt = { at: string; gasTgas: number; ok: boolean; tx: string; retryable: boolean; ms: number };
export type Deps = {
  log: (s: string) => void;
  loadAttempts: () => Attempt[];
  saveAttempt: (a: Attempt) => void;
  balanceYocto: (account: string) => bigint;
  send: (plan: Plan) => SendResult;
};

/** The tx hash must be 0x plus 64 hex; returns the bare lowercase hex the contract's Hex serde expects. */
export function toTxId(hash: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`tx hash must be 0x plus 64 hex, got ${JSON.stringify(hash)}`);
  return hash.slice(2).toLowerCase();
}

export function planCall(hash: string, signer = DEFAULT_SIGNER, gasTgas = INITIAL_GAS_TGAS): Plan {
  return {
    contract: SIGNER_CONTRACT,
    method: METHOD,
    signer,
    args: {
      request: {
        request: { Base: { tx_id: toTxId(hash), extractors: ['BlockHash'], finality: 'Finalized' } },
        domain_id: FOREIGN_TX_DOMAIN,
        payload_version: 1,
      },
    },
    deposit: '1 yoctoNEAR',
    gasTgas,
  };
}

/** Our credit and try accounts may call as a plain LP account and nothing else, never as pool, card, agent or issuer. */
export function signerAllowed(s: string): boolean {
  const ours = /(^|\.)(airlock-credit-c1108d|airlock-try-b193fe)\.testnet$/;
  if (!ours.test(s)) return /^[a-z0-9._-]+\.testnet$/.test(s);
  return /^lp\d+\.(airlock-credit-c1108d|airlock-try-b193fe)\.testnet$/.test(s);
}

const retryableText = (out: string): boolean => /time[d ]?\s?out|timeout|gas/i.test(out);

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runSpike(argv: readonly string[], env: Record<string, string | undefined>, deps: Deps): Promise<number> {
  const live = argv.includes('--live');
  const hash = flag(argv, '--tx') ?? DEFAULT_TX;
  const signer = flag(argv, '--signer') ?? DEFAULT_SIGNER;
  try {
    toTxId(hash);
  } catch (e) {
    deps.log(`STOP ${(e as Error).message}`);
    return 1;
  }
  if (!signerAllowed(signer)) {
    deps.log(`STOP signer ${signer} is not allowed (under our credit or try accounts a plain LP account is required)`);
    return 1;
  }
  const attempts = deps.loadAttempts();
  const gasTgas = attempts.length === 0 ? INITIAL_GAS_TGAS : RETRY_GAS_TGAS;
  const plan = planCall(hash, signer, gasTgas);
  deps.log(`PLAN account=${plan.signer} contract=${plan.contract} method=${plan.method} deposit=${plan.deposit} gas=${plan.gasTgas} Tgas`);
  deps.log(`PLAN args=${JSON.stringify(plan.args)}`);
  if (!live) {
    deps.log('DRY RUN nothing sent');
    return 0;
  }
  if (env.MPC_VERIFY_LIVE !== '1') {
    deps.log('STOP live needs both --live and MPC_VERIFY_LIVE=1');
    return 2;
  }
  const last = attempts[attempts.length - 1];
  if (attempts.length >= 2 || (last !== undefined && (last.ok || !last.retryable))) {
    deps.log(`STOP budget used: ${attempts.length} attempt(s) recorded, no further call`);
    return 3;
  }
  const bal = deps.balanceYocto(signer);
  if (bal < MIN_BALANCE_YOCTO) {
    deps.log(`STOP ${signer} holds ${bal} yocto, under 0.5 NEAR; not funding`);
    return 4;
  }
  const r = deps.send(plan);
  const retryable = !r.ok && retryableText(r.out);
  deps.saveAttempt({ at: new Date().toISOString(), gasTgas, ok: r.ok, tx: r.tx, retryable, ms: r.ms });
  deps.log(`RESULT ok=${r.ok} tx=${r.tx} ms=${r.ms} retryable=${retryable}`);
  deps.log(`OUTPUT ${r.out.slice(-3000)}`);
  return r.ok ? 0 : 5;
}

// The real dependencies: the near CLI keychain signer, an RPC balance view, and an attempts file under target/.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = process.env.NEAR_CLI ?? 'near';
const stateFile = join(REPO, 'target', 'mpc-verify-spike', 'attempts.json');
const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function realDeps(): Deps {
  return {
    log: (s) => console.log(s),
    loadAttempts: () => (existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Attempt[]) : []),
    saveAttempt: (a) => {
      const all = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Attempt[]) : [];
      all.push(a);
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(all, null, 2));
    },
    balanceYocto: (account) => {
      const r = spawnSync('curl', ['-s', '-X', 'POST', 'https://test.rpc.fastnear.com', '-H', 'content-type: application/json', '-d',
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } })], { encoding: 'utf8' });
      const amount = (JSON.parse(r.stdout) as { result?: { amount?: string } }).result?.amount;
      return amount === undefined ? 0n : BigInt(amount);
    },
    send: (plan) => {
      const t0 = Date.now();
      const r = spawnSync(NEAR, ['contract', 'call-function', 'as-transaction', plan.contract, plan.method, 'json-args', JSON.stringify(plan.args),
        'prepaid-gas', `${plan.gasTgas} Tgas`, 'attached-deposit', plan.deposit, 'sign-as', plan.signer, 'network-config', 'testnet', 'sign-with-keychain', 'send'],
        { encoding: 'utf8', timeout: 600_000 });
      const ms = Date.now() - t0;
      const out = clean(`${r.stdout}${r.stderr}`);
      const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1] ?? '';
      const ok = r.status === 0 && tx !== '' && !/ExecutionError|Failure|panicked|timed out/i.test(out);
      return { ok, tx, out, ms };
    },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runSpike(process.argv.slice(2), process.env, realDeps()).then((c) => process.exit(c), (e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}

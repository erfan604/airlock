// AIR-165: the preflight checks of the testnet runs (AIR-166's preflight reuses the four with its own thresholds). Each returns a Check whose
// `line` starts `PASS <name>` or `FAIL <name>`; none of them signs, sends or prints a key. The checks read through a PreflightIo, so the unit
// tests give them stubbed views; `liveIo` reads the real testnet over JSON-RPC with failover on transport errors only. Amounts are BigInt.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_SEPOLIA_RPCS, deriveSender } from '../../runtime/src/chain/evm.ts';
import { DEFAULT_RPC_URLS } from '../../runtime/src/chain/rpc.ts';
import { formatBaseUnits } from '../../runtime/src/money/index.ts';

export interface Check {
  ok: boolean;
  line: string;
}

export interface Accounts {
  owner: string;
  policy: string;
  agent: string;
  accountant: string;
  contractor_evm: string;
}

export type AccessKeyPermission = 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };

export interface PreflightIo {
  /** AGENT_CREDENTIALS_PATH, undefined when unset */
  credentialsPath(): string | undefined;
  /** the public facts of the credentials file; the private key never leaves the reader, only whether it is an ed25519 key */
  readCredentials(path: string): { account_id: unknown; public_key: unknown; hasEd25519Key: boolean };
  accounts(): Accounts;
  viewAccessKey(account: string, publicKey: string): Promise<{ permission: AccessKeyPermission } | null>;
  viewAccount(account: string): Promise<{ amount: bigint; storageUsage: bigint }>;
  getLedgers(payee: string, asset: string): Promise<{ payee_untrusted_day: { remaining: string } }>;
  baseBalance(address: string): Promise<bigint>;
  /** the Base Sepolia address derived for the policy account and the registry path of `evm:84532:native` */
  derivedAddress(): Promise<string>;
}

const NEAR = 10n ** 24n;
const STORAGE_BYTE_COST = 10n ** 19n;
const MARGIN = NEAR;
const MIN_ALLOWANCE = NEAR;

const pass = (line: string): Check => ({ ok: true, line });
const fail = (name: string, why: string): Check => ({ ok: false, line: `FAIL ${name}: ${why}` });

/** The value of a decimal string, or null when it is not 1 to 40 ASCII digits (a text that is not a number never reaches BigInt). */
function digits(text: unknown): bigint | null {
  return typeof text === 'string' && /^[0-9]{1,40}$/.test(text) ? BigInt(text) : null;
}

const near = (yocto: bigint): string => `${formatBaseUnits(yocto, 24)} NEAR`;

/** The agent's function-call key is the registered one: FunctionCall access, receiver the policy account, `submit_batch` only, an allowance of at least 1 NEAR or none. */
export async function checkAgentKey(io: PreflightIo = liveIo()): Promise<Check> {
  const name = 'agent key';
  const path = io.credentialsPath();
  if (path === undefined || path === '') return fail(name, 'AGENT_CREDENTIALS_PATH is not set');
  let creds: ReturnType<PreflightIo['readCredentials']>;
  try {
    creds = io.readCredentials(path);
  } catch {
    return fail(name, 'the credentials file cannot be read');
  }
  const { agent, policy } = io.accounts();
  if (creds.account_id !== agent) return fail(name, 'the credentials are for another account');
  if (!creds.hasEd25519Key) return fail(name, 'the credentials have no ed25519 private key');
  if (typeof creds.public_key !== 'string' || creds.public_key === '') return fail(name, 'the credentials have no public key');
  let key: Awaited<ReturnType<PreflightIo['viewAccessKey']>>;
  try {
    key = await io.viewAccessKey(agent, creds.public_key);
  } catch {
    return fail(name, 'the node did not answer for the access key');
  }
  if (key === null) return fail(name, 'the key is not registered on the agent account');
  const permission = key.permission;
  if (typeof permission === 'string') return fail(name, 'the key has full access, not a function call key');
  const call = permission.FunctionCall;
  if (call.receiver_id !== policy) return fail(name, 'the key is for another receiver than the policy account');
  if (call.method_names.length !== 1 || call.method_names[0] !== 'submit_batch') return fail(name, 'the key must allow submit_batch only');
  if (call.allowance !== null) {
    const allowance = digits(call.allowance);
    if (allowance === null) return fail(name, 'the allowance is not a number');
    if (allowance < MIN_ALLOWANCE) return fail(name, `the allowance is ${near(allowance)}, below 1 NEAR`);
  }
  return pass('PASS agent key');
}

/** The policy account holds `minSpendable` beyond its storage lock (storage_usage times 1e19 yocto) and 1 NEAR of margin. */
export async function checkPolicyBalance(minSpendable: bigint, io: PreflightIo = liveIo()): Promise<Check> {
  const name = 'policy balance';
  let account: Awaited<ReturnType<PreflightIo['viewAccount']>>;
  try {
    account = await io.viewAccount(io.accounts().policy);
  } catch {
    return fail(name, 'the node did not answer for the policy account');
  }
  const spendable = account.amount - account.storageUsage * STORAGE_BYTE_COST - MARGIN;
  const shown = spendable < 0n ? 0n : spendable;
  if (spendable < minSpendable) return fail(name, `${near(shown)} spendable after storage and 1 NEAR margin, needs ${near(minSpendable)}`);
  return pass(`PASS policy balance ${near(shown)} spendable`);
}

/** The address derived for the policy account and the registry path holds at least `minWei` on Base Sepolia. */
export async function checkDerivedBalance(minWei: bigint, io: PreflightIo = liveIo()): Promise<Check> {
  const name = 'derived balance';
  let address: string;
  let wei: bigint;
  try {
    address = await io.derivedAddress();
    wei = await io.baseBalance(address);
  } catch {
    return fail(name, 'the derived address or its balance could not be read');
  }
  if (wei < minWei) return fail(name, `${address} holds ${wei} wei, needs ${minWei}`);
  return pass(`PASS derived balance ${address} ${wei} wei`);
}

/** The payee's untrusted budget of the UTC day still covers `min`: every allowed untrusted amount charges it (the accountant has 20 NEAR a day). */
export async function checkUntrustedBudget(payee: string, asset: string, min: bigint, io: PreflightIo = liveIo()): Promise<Check> {
  const name = 'untrusted budget';
  let remaining: bigint | null;
  try {
    remaining = digits((await io.getLedgers(payee, asset)).payee_untrusted_day.remaining);
  } catch {
    return fail(name, 'get_ledgers did not answer');
  }
  if (remaining === null) return fail(name, 'get_ledgers answered a remaining amount that is not a number');
  if (remaining < min) return fail(name, `${remaining} base units remain today for ${payee}, needs ${min}`);
  return pass(`PASS untrusted budget ${remaining} base units remain`);
}

/**
 * fixtures/accounts.testnet.json, with the policy account replaced by `DEMO_POLICY` when that is set (AIR-247: `pnpm demo:live` runs against
 * policy-v2 while the golden evidence stays on the file's account). Without the variable the file is read as is.
 */
export function loadAccounts<T extends { policy?: string }>(root: string, env: { DEMO_POLICY?: string | undefined } = process.env): T {
  const a = JSON.parse(readFileSync(join(root, 'fixtures', 'accounts.testnet.json'), 'utf8')) as T;
  if (env.DEMO_POLICY !== undefined && env.DEMO_POLICY !== '') a.policy = env.DEMO_POLICY;
  return a;
}

// ---- the live reads ----

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

interface JsonRpcAnswer {
  result?: unknown;
  error?: { name?: string; cause?: { name?: string }; message?: string; code?: number; data?: unknown };
}

/** One JSON-RPC call on the first URL that answers; a transport failure or an HTTP 5xx moves on, a JSON-RPC error is returned to the caller. */
async function rpc(urls: readonly string[], method: string, params: unknown): Promise<JsonRpcAnswer> {
  let last: unknown = new Error('no rpc url');
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'airlock', method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as JsonRpcAnswer;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const errorName = (a: JsonRpcAnswer): string => a.error?.cause?.name ?? a.error?.name ?? 'RPC_ERROR';

/**
 * The NEAR the receipts of transaction `txHash` (signed by `signer`) transferred to `account`, summed, in yocto. Archival nodes first, so an
 * older transaction is still found. Used when the payee's balance moved for another reason (a sweep back between the hold and the approve).
 */
export async function nearTxTransferredTo(txHash: string, signer: string, account: string): Promise<bigint> {
  const urls = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org', ...DEFAULT_RPC_URLS];
  const answer = await rpc(urls, 'EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: signer, wait_until: 'FINAL' });
  if (answer.error !== undefined) throw new RpcNamedError(errorName(answer));
  const receipts = ((answer.result as { receipts?: unknown[] }).receipts ?? []) as { receiver_id?: string; receipt?: { Action?: { actions?: unknown[] } } }[];
  const outcomes = ((answer.result as { receipts_outcome?: unknown[] }).receipts_outcome ?? []) as { id?: string; outcome?: { status?: Record<string, unknown> } }[];
  const failed = new Set(outcomes.filter((o) => o.outcome?.status !== undefined && 'Failure' in o.outcome.status).map((o) => o.id));
  let sum = 0n;
  for (const r of receipts as ({ receipt_id?: string } & (typeof receipts)[number])[]) {
    if (r.receiver_id !== account || failed.has(r.receipt_id)) continue;
    for (const a of r.receipt?.Action?.actions ?? []) {
      const t = (a as { Transfer?: { deposit?: string } }).Transfer;
      if (t?.deposit !== undefined && /^[0-9]+$/.test(t.deposit)) sum += BigInt(t.deposit);
    }
  }
  return sum;
}

/** A NEAR testnet `query` call; the answer's `result` or a thrown Error with the node's error name. */
export async function nearQuery(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await rpc(DEFAULT_RPC_URLS, 'query', { finality: 'final', ...params });
  if (answer.error !== undefined) throw new RpcNamedError(errorName(answer));
  return answer.result as Record<string, unknown>;
}

export class RpcNamedError extends Error {
  constructor(readonly rpcName: string) {
    super(`rpc error ${rpcName}`);
    this.name = 'RpcNamedError';
  }
}

export async function nearViewAccount(account: string): Promise<{ amount: bigint; storageUsage: bigint }> {
  const r = await nearQuery({ request_type: 'view_account', account_id: account });
  const amount = digits(r.amount);
  const usage = typeof r.storage_usage === 'number' && Number.isSafeInteger(r.storage_usage) && r.storage_usage >= 0 ? BigInt(r.storage_usage) : null;
  if (amount === null || usage === null) throw new Error('view_account answer is malformed');
  return { amount, storageUsage: usage };
}

/** An Ethereum JSON-RPC call on Base Sepolia: `BASE_SEPOLIA_RPC` first when set, then the shared list. */
export async function baseRpc(extraFirst: string | undefined, method: string, params: unknown[]): Promise<unknown> {
  const urls = [...(extraFirst === undefined || extraFirst === '' ? [] : [extraFirst]), ...BASE_SEPOLIA_RPCS.filter((u) => u !== extraFirst)];
  const answer = await rpc(urls, method, params);
  if (answer.error !== undefined) throw new Error(`base rpc error ${answer.error.code ?? ''}`);
  return answer.result;
}

/** The real testnet behind a PreflightIo. `env` carries AGENT_CREDENTIALS_PATH and BASE_SEPOLIA_RPC only. */
export function liveIo(root: string = REPO, env: { AGENT_CREDENTIALS_PATH?: string | undefined; BASE_SEPOLIA_RPC?: string | undefined } = process.env): PreflightIo {
  const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(root, rel), 'utf8')) as T;
  const accounts = (): Accounts => loadAccounts(root);
  return {
    credentialsPath: () => env.AGENT_CREDENTIALS_PATH,
    readCredentials: (path) => {
      const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return { account_id: file.account_id, public_key: file.public_key, hasEd25519Key: typeof file.private_key === 'string' && file.private_key.startsWith('ed25519:') };
    },
    accounts,
    viewAccessKey: async (account, publicKey) => {
      try {
        const r = await nearQuery({ request_type: 'view_access_key', account_id: account, public_key: publicKey });
        return { permission: r.permission as AccessKeyPermission };
      } catch (e) {
        if (e instanceof RpcNamedError && e.rpcName === 'UNKNOWN_ACCESS_KEY') return null;
        throw e;
      }
    },
    viewAccount: nearViewAccount,
    getLedgers: async (payee, asset) => {
      const r = await nearQuery({
        request_type: 'call_function',
        account_id: accounts().policy,
        method_name: 'get_ledgers',
        args_base64: Buffer.from(JSON.stringify({ payee, asset, task: null })).toString('base64'),
      });
      const bytes = r.result as number[];
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as { payee_untrusted_day: { remaining: string } };
    },
    baseBalance: async (address) => {
      const hex = await baseRpc(env.BASE_SEPOLIA_RPC, 'eth_getBalance', [address, 'latest']);
      if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error('eth_getBalance answer is malformed');
      return BigInt(hex);
    },
    derivedAddress: async () => {
      const policy = readJson<{ assets: Record<string, { path: string | null }> }>('fixtures/policy.json');
      const path = policy.assets['evm:84532:native']?.path;
      if (typeof path !== 'string') throw new Error('policy.json has no path for evm:84532:native');
      return deriveSender(accounts().policy, path);
    },
  };
}

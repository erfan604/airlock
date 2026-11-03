// AIR-166: "is the world ready" for a golden run. Eleven lines, one per check: `PASS|FAIL|WARN <name> <detail>`. Nothing here signs, sends or prints a
// key; every read goes through a WorldIo so the unit tests give each check a stubbed answer. The four checks of AIR-165 (agent key, policy balance,
// derived balance, untrusted budget) are reused with this ticket's thresholds. Under rung 9 (docs/EVIDENCE.md says so) nothing signs or
// broadcasts live, so `derived address` and `nonce` WARN instead of FAIL.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_SEPOLIA_RPCS } from '../../runtime/src/chain/evm.ts';
import { DEFAULT_RPC_URLS } from '../../runtime/src/chain/rpc.ts';
import { formatBaseUnits } from '../../runtime/src/money/index.ts';
import { EVM_FEE_RESERVE_WEI } from '../e2e/cases.ts';
import { baseRpc, checkAgentKey, checkPolicyBalance, checkUntrustedBudget, liveIo, loadAccounts, nearQuery } from './preflight.ts';
import type { PreflightIo } from './preflight.ts';

export interface Line {
  level: 'PASS' | 'FAIL' | 'WARN';
  name: string;
  detail: string;
}

export interface MpcExpected {
  contract: string;
  version: string;
  code_hash: string;
  recorded: string;
}

export interface WorldIo {
  policy: string;
  accountant: string;
  contractorPayee: string;
  twins: { vanilla: string; allowlist: string };
  agent: string;
  evmPath(): string;
  viewAccount(account: string): Promise<{ amount: bigint; storageUsage: bigint }>;
  /** pending escalations of the agent and the contract's `max_pending_per_agent` */
  pending(): Promise<{ count: number; max: number }>;
  /** `get_nonce(path)`; null when the contract has none yet */
  contractNonce(path: string): Promise<bigint | null>;
  /** `eth_getTransactionCount(address, "pending")` */
  chainNonce(address: string): Promise<bigint>;
  mpcLive(): Promise<{ version: string; codeHash: string }>;
  mpcExpected(): MpcExpected;
  /** true when the node answered `eth_chainId` 0x14a34 (Base Sepolia) */
  probeBase(url: string): Promise<boolean>;
  /** true when the node answered `status` */
  probeNear(url: string): Promise<boolean>;
  baseUrls: readonly string[];
  nearUrls: readonly string[];
  rung9(): boolean;
  owner: string;
}

const NEAR = 10n ** 24n;
export const MIN_POLICY_NEAR = 25n * NEAR;
export const MIN_TWIN_NEAR = 20n * NEAR;
export const MIN_ACCOUNTANT_BUDGET = 42n * NEAR / 10n;
export const MIN_CONTRACTOR_BUDGET = 20_000_000_000_000_000n; // 0.02 ETH
/** the CONTRACTOR case: its amount plus the worst-case fee (the 0.05 ETH of the first draft was the payee's whole cap, AIR-165 2026-11-02) */
export const MIN_DERIVED_WEI = MIN_CONTRACTOR_BUDGET + EVM_FEE_RESERVE_WEI;
export const RUNG9 = 'EVM lane not live-proven at G2, rung 9';

const fromCheck = (c: { ok: boolean; line: string }, name: string): Line => {
  const rest = c.line.replace(new RegExp(`^(PASS|FAIL) ${name}:? ?`), '');
  return { level: c.ok ? 'PASS' : 'FAIL', name, detail: rest };
};

const near = (v: bigint): string => `${formatBaseUnits(v, 24)} NEAR`;
const eth = (v: bigint): string => `${formatBaseUnits(v, 18)} ETH`;

async function guarded(name: string, f: () => Promise<Line>): Promise<Line> {
  try {
    return await f();
  } catch {
    return { level: 'FAIL', name, detail: 'the read failed' };
  }
}

export async function runPreflight(pf: PreflightIo, w: WorldIo): Promise<Line[]> {
  const out: Line[] = [];
  const rung9 = w.rung9();
  const soft = rung9 ? 'WARN' : 'FAIL';

  out.push(fromCheck(await checkPolicyBalance(MIN_POLICY_NEAR, pf), 'policy balance'));

  out.push(
    await guarded('derived address', async () => {
      const address = await pf.derivedAddress();
      const wei = await pf.baseBalance(address);
      if (wei < MIN_DERIVED_WEI) return { level: soft, name: 'derived address', detail: `${address} holds ${eth(wei)}, needs ${eth(MIN_DERIVED_WEI)} (0.02 ETH plus the fee reserve)` };
      return { level: 'PASS', name: 'derived address', detail: `${address} holds ${eth(wei)}` };
    }),
  );

  for (const [name, account] of [['twin vanilla', w.twins.vanilla], ['twin allowlist', w.twins.allowlist]] as const) {
    out.push(
      await guarded(name, async () => {
        const { amount } = await w.viewAccount(account);
        if (amount < MIN_TWIN_NEAR) return { level: 'FAIL', name, detail: `${account} holds ${near(amount)}, needs ${near(MIN_TWIN_NEAR)}` };
        return { level: 'PASS', name, detail: `${account} holds ${near(amount)}` };
      }),
    );
  }

  out.push(fromCheck(await checkAgentKey(pf), 'agent key'));

  const accountant = fromCheck(await checkUntrustedBudget(`near:${w.accountant}`, 'near', MIN_ACCOUNTANT_BUDGET, pf), 'untrusted budget');
  const contractor = fromCheck(await checkUntrustedBudget(w.contractorPayee, 'evm:84532:native', MIN_CONTRACTOR_BUDGET, pf), 'untrusted budget');
  out.push({
    level: accountant.level === 'PASS' && contractor.level === 'PASS' ? 'PASS' : 'FAIL',
    name: 'untrusted budget',
    detail: `accountant: ${accountant.detail}; contractor: ${contractor.detail}`,
  });

  out.push(
    await guarded('pending', async () => {
      const { count, max } = await w.pending();
      if (count >= max) return { level: 'FAIL', name: 'pending', detail: `${count} requests are pending, the limit is ${max}: a golden run would end PendingFull` };
      return { level: 'PASS', name: 'pending', detail: `${count} of ${max} pending` };
    }),
  );

  out.push(
    await guarded('nonce', async () => {
      const path = w.evmPath();
      const contract = (await w.contractNonce(path)) ?? 0n;
      const chain = await w.chainNonce(await pf.derivedAddress());
      if (contract !== chain) return { level: soft, name: 'nonce', detail: `the contract counts ${contract}, the chain ${chain}: run pnpm tsx scripts/nonce-status.ts` };
      return { level: 'PASS', name: 'nonce', detail: `${contract}` };
    }),
  );

  out.push(
    await guarded('mpc', async () => {
      const live = await w.mpcLive();
      const want = w.mpcExpected();
      if (live.version !== want.version) return { level: 'FAIL', name: 'mpc', detail: `the signer is ${live.version}, the evidence names ${want.version}: read the release notes, run one request, then preflight.ts --record-mpc` };
      if (live.codeHash !== want.code_hash) return { level: 'WARN', name: 'mpc', detail: `version ${live.version} but the code hash changed from the recorded one` };
      return { level: 'PASS', name: 'mpc', detail: `${live.version}` };
    }),
  );

  for (const [name, urls, probe] of [['base rpc', w.baseUrls, w.probeBase], ['near rpc', w.nearUrls, w.probeNear]] as const) {
    const answers = await Promise.all(urls.map((u) => probe(u).catch(() => false)));
    const up = answers.filter(Boolean).length;
    if (up === 0) out.push({ level: 'FAIL', name, detail: `none of ${urls.length} answered` });
    else if (up < urls.length) out.push({ level: 'WARN', name, detail: `${up} of ${urls.length} answered` });
    else out.push({ level: 'PASS', name, detail: `${up} of ${urls.length} answered` });
  }
  return out;
}

export const formatLine = (l: Line): string => `${l.level} ${l.name} ${l.detail}`;
export const preflightOk = (lines: readonly Line[]): boolean => lines.every((l) => l.level !== 'FAIL');

// ---- nonce-status ----

/** The owner's `set_nonce` command for a mismatch (AIR-104); null when the two counters agree. */
export function setNonceCommand(policy: string, owner: string, path: string, chain: bigint): string {
  return `near contract call-function as-transaction ${policy} set_nonce json-args '{"path":"${path}","nonce":"${chain}"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${owner} network-config testnet sign-with-keychain send`;
}

/** The lines of scripts/nonce-status.ts. It never sends anything: the command is for the owner. */
export async function nonceStatus(pf: PreflightIo, w: WorldIo): Promise<string[]> {
  const path = w.evmPath();
  const contract = (await w.contractNonce(path)) ?? 0n;
  const chain = await w.chainNonce(await pf.derivedAddress());
  const lines = [`NONCE contract ${contract} chain ${chain}`];
  if (contract === chain) {
    lines.push('NONCE in sync, nothing to send');
    return lines;
  }
  lines.push('WARNING lower the counter only while no Retryable request of this path is outstanding (AIR-104): a Retryable request signs with its stored nonce.');
  if (chain < contract) lines.push('NOTE the chain is behind the contract: a transaction was signed and not broadcast, set_nonce would reuse its number.');
  lines.push(`OWNER COMMAND ${setNonceCommand(w.policy, w.owner, path, chain)}`);
  return lines;
}

// ---- the live reads ----

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

async function jsonRpc(url: string, method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'airlock', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { result?: unknown; error?: unknown };
}

const callView = async (account: string, method: string, args: unknown): Promise<unknown> => {
  const r = await nearQuery({ request_type: 'call_function', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  const text = Buffer.from(r.result as number[]).toString('utf8');
  return text === '' ? null : JSON.parse(text);
};

export const MPC_CONTRACT = 'v1.signer-prod.testnet';

export function liveWorld(root: string = REPO, env: { BASE_SEPOLIA_RPC?: string | undefined; DEMO_POLICY?: string | undefined } = process.env): WorldIo {
  const read = <T>(rel: string): T => JSON.parse(readFileSync(join(root, rel), 'utf8')) as T;
  const a = loadAccounts<Record<string, string>>(root, env);
  const policyFile = read<{ assets: Record<string, { path: string | null }> }>('fixtures/policy.json');
  const baseUrls = [...(env.BASE_SEPOLIA_RPC === undefined || env.BASE_SEPOLIA_RPC === '' ? [] : [env.BASE_SEPOLIA_RPC]), ...BASE_SEPOLIA_RPCS];
  return {
    policy: a.policy as string,
    owner: a.owner as string,
    agent: a.agent as string,
    accountant: a.accountant as string,
    contractorPayee: `evm:84532:${a.contractor_evm as string}`,
    twins: { vanilla: a.twin_vanilla as string, allowlist: a.twin_allowlist as string },
    evmPath: () => {
      const path = policyFile.assets['evm:84532:native']?.path;
      if (typeof path !== 'string') throw new Error('policy.json has no path for evm:84532:native');
      return path;
    },
    viewAccount: async (account) => {
      const r = await nearQuery({ request_type: 'view_account', account_id: account });
      return { amount: BigInt(r.amount as string), storageUsage: BigInt(r.storage_usage as number) };
    },
    pending: async () => {
      const list = (await callView(a.policy as string, 'get_pending', { from_index: 0, limit: 20 })) as { agent?: string }[];
      const policy = (await callView(a.policy as string, 'get_policy', {})) as { flags: { max_pending_per_agent: number } };
      return { count: list.filter((r) => r.agent === undefined || r.agent === a.agent).length, max: policy.flags.max_pending_per_agent };
    },
    contractNonce: async (path) => {
      const v = await callView(a.policy as string, 'get_nonce', { path });
      return typeof v === 'string' && /^[0-9]{1,20}$/.test(v) ? BigInt(v) : null;
    },
    chainNonce: async (address) => {
      const hex = await baseRpc(env.BASE_SEPOLIA_RPC, 'eth_getTransactionCount', [address, 'pending']);
      if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error('nonce answer is malformed');
      return BigInt(hex);
    },
    mpcLive: async () => {
      const version = await callView(MPC_CONTRACT, 'version', {});
      const acct = await nearQuery({ request_type: 'view_account', account_id: MPC_CONTRACT });
      return { version: String(version), codeHash: String(acct.code_hash) };
    },
    mpcExpected: () => read<MpcExpected>('fixtures/mpc-expected.json'),
    probeBase: async (url) => {
      const r = await jsonRpc(url, 'eth_chainId', []);
      return r.result === '0x14a34';
    },
    probeNear: async (url) => {
      const r = await jsonRpc(url, 'status', []);
      return r.result !== undefined && r.error === undefined;
    },
    baseUrls,
    nearUrls: DEFAULT_RPC_URLS,
    rung9: () => {
      try {
        return readFileSync(join(root, 'docs', 'EVIDENCE.md'), 'utf8').includes(RUNG9);
      } catch {
        return false;
      }
    },
  };
}

/** `preflight.ts --record-mpc`: rewrites fixtures/mpc-expected.json with the live version and code hash (a read, then a file write). */
export async function recordMpc(w: WorldIo, root: string, today: string): Promise<MpcExpected> {
  const live = await w.mpcLive();
  const next: MpcExpected = { contract: MPC_CONTRACT, version: live.version, code_hash: live.codeHash, recorded: today };
  writeFileSync(join(root, 'fixtures', 'mpc-expected.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}

export { liveIo };

// AIR-339: the credit card pays a booked merchant on Base Sepolia through MPC, and an injected Base address from an email is held on the
// same card. The card is a policy contract with an MPC signer; the ETH spent on Base was placed on the card's derived Base address by us
// from our own test address. Credit lines live on NEAR; nothing here lends, draws or repays on Base.
//   pnpm tsx scripts/credit-base-spend.ts             dry (the default): reads the card and Base Sepolia, prints every planned step with the
//                                                     exact call, checks that the reads did not change anything, ends `DRY RUN nothing sent`
//   pnpm tsx scripts/credit-base-spend.ts --live      the run, which needs BASE_SPEND_LIVE=1 next to it (exit 2 otherwise) and no live switch
//                                                     of the hourly jobs; every step reads the chain before it acts, so a rerun resumes
//   pnpm tsx scripts/credit-base-spend.ts --verify    read-only: re-reads the Base receipt and the card against target/credit-base/rows.json
// Options: --vault <the card's current book vault> (default: the file under target/arena or target/credit-run whose root is the card's root, arena folder ahead),
// --rows <rows file>. The owner, the approver and the agent sign through their own helpers (near CLI keychain, the scoped agent key, the task
// key file); the funding transfer is signed by the bridge tool with its own key file. This script reads no key, and prints no key, payee
// salt or vault content.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { ARENA_ACCOUNTS } from '../runtime/src/arena/facts.ts';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { BASE_SEPOLIA_RPCS } from '../runtime/src/chain/evm.ts';
import type { BatchResult, RequestView, SignedEvent } from '../runtime/src/chain/types.ts';
import { rpcAccount, rpcView } from '../runtime/src/credit/rpc.ts';
import { shellLine, whyNotStrict } from '../runtime/src/credit/strict.ts';
import { pickVault, vaultCandidates } from '../runtime/src/credit/vaults.ts';
import { ActionRequest, OwnerTask, TASK_TAG, labelsToBits, sha256Hex } from '../runtime/src/dsl/index.ts';
import { loadVault, saveVault } from '../runtime/src/vault/file.ts';
import type { Vault } from '../runtime/src/vault/index.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CARD = ARENA_ACCOUNTS.card;
export const ISSUER = ARENA_ACCOUNTS.issuer;
export const AGENT = ARENA_ACCOUNTS.agent;
export const MERCHANT_ACCOUNT = ARENA_ACCOUNTS.merchant;
export const CHAIN_ID = 84532;
export const ASSET = 'evm:84532:native';
export const PATH = 'credit-card-1';
export const MERCHANT_PATH = 'merchant-1';
/** The Base address the merchant account controls through chain signatures (derive-address.mjs merchant... merchant-1), lowercase. */
export const MERCHANT_EVM = '0xb8613f9bb188d93caa9d6fd3f8cf9436f671a1eb';
/** The one Base Sepolia address we can spend from directly (plan/ACCOUNTS.md contractor_evm), lowercase. */
export const CONTRACTOR_EVM = '0x7eafcb38a7de2a6805db7c93ccec6365a5c7528f';
export const AMOUNT_WEI = 1_000_000_000_000n;
export const GAS = 21_000n;
export const MAX_FEE_WEI = 100_000_000n;
export const PRIORITY_FEE_WEI = 1_000_000n;
/** The derived address must hold this before the payment: the worst case plus a margin for the L1 data fee. */
export const MIN_DERIVED_WEI = 4_000_000_000_000n;
/** The ticket's funding rule: under this on contractor_evm the run is BLOCKED. */
export const CONTRACTOR_MIN_WEI = 4_000_000_000_000n;
/** What the sweep leaves on contractor_evm (0.000002 ETH). */
export const SWEEP_KEEP_WEI = 2_000_000_000_000n;
export const SWEEP_KEEP_ETH = '0.000002';
export const LIVE_FLAG = 'BASE_SPEND_LIVE';
export const APPROVER_REFUSAL = 'approve refused for the approver: the payee is not in the book at this epoch';
const POLICY_FILE = join(REPO, 'fixtures', 'credit', 'card-base.policy.json');
const EMAIL_FILE = join(REPO, 'fixtures', 'credit', 'base-spend-email.json');
const BRIDGE_TOOL = '/Users/erfan/apps/airlock-research/spikes/accounts/bridge-to-base.mjs';
const BASESCAN = 'https://sepolia.basescan.org/tx/';
const NEARBLOCKS = 'https://testnet.nearblocks.io/txns/';
const SIGN_WAIT_MS = 300_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The worst case the derived address pays for the payment: the value plus every unit of gas at the max fee. */
export const worstCaseWei = (): bigint => AMOUNT_WEI + GAS * MAX_FEE_WEI;

/** The canonical payee key of a Base Sepolia address. */
export const payeeKey = (addr: string): string => `evm:${String(CHAIN_ID)}:${addr.toLowerCase()}`;

/** One agent request to the card under its own owner task, as `credit-testnet.ts` builds them (amount stated by the owner). */
export function paymentPair(p: { id: string; payee: string; recipient: string[]; nowMs: number }): { req: ActionRequest; task: OwnerTask } {
  const task = OwnerTask.parse({
    tag: TASK_TAG,
    task_id: `base-spend-${p.id}-${String(p.nowMs)}`,
    contract_id: CARD,
    agent_id: AGENT,
    plan_sha256: sha256Hex(new TextEncoder().encode(`credit-base:${p.id}`)),
    instruction_sha256_salted: sha256Hex(new TextEncoder().encode(`salt:credit-base:${p.id}`)),
    issued_ms: p.nowMs - 1000,
    expires_ms: p.nowMs + 20 * 60_000,
    max_actions: 1,
    bounds: [{ payee_key: p.payee, max_total: AMOUNT_WEI.toString() }],
  });
  const req = ActionRequest.parse({
    task_id: task.task_id,
    action_index: 0,
    asset: ASSET,
    payee: p.payee,
    amount: AMOUNT_WEI.toString(),
    labels: { recipient: labelsToBits(p.recipient), amount: labelsToBits(['Owner']), pc: labelsToBits(['Owner']) },
    evm: { gas_limit: GAS.toString(), max_fee_per_gas: MAX_FEE_WEI.toString(), max_priority_fee_per_gas: PRIORITY_FEE_WEI.toString() },
    hints: { plan_hash: task.plan_sha256, trace_digest: '0'.repeat(64) },
  });
  return { req, task };
}

type PolicyBookEntry = { name: string; key: string; cap: string | null; daily_untrusted_budget: string; daily_limit: string; label: string; listed?: boolean };

/** The Base merchant's entry of the policy file, with its placeholder filled. */
function baseEntryOf(policy: Record<string, unknown>, merchantEvm: string): PolicyBookEntry {
  const book = policy['book'];
  const e = Array.isArray(book) ? (book as PolicyBookEntry[]).find((x) => x.name === 'merchant_base') : undefined;
  if (e === undefined) throw new Error('the policy file has no merchant_base entry');
  return { ...e, key: e.key.replace('{merchant_evm}', merchantEvm.toLowerCase()) };
}

/**
 * The book after this ticket: the card's current (strict) book with the Base merchant appended, as `book-vault.ts sync` would make it from
 * the policy file (entries already there keep their salt). A vault that already holds the Base merchant is returned as it is.
 */
export function baseVaultOf(current: Vault, policy: Record<string, unknown>, merchantEvm: string): Vault {
  const e = baseEntryOf(policy, merchantEvm);
  if (current.has(e.key)) return current;
  return current.add({
    payee: e.key,
    cap: e.cap === null ? null : BigInt(e.cap),
    dailyUntrustedBudget: BigInt(e.daily_untrusted_budget),
    dailyLimit: BigInt(e.daily_limit),
    label: e.label,
    listed: e.listed === true,
  });
}

export type FundingState = 'READY' | 'FUND' | 'BLOCKED';

/**
 * The ticket's funding rule. READY: the derived address already holds the need. FUND: contractor_evm can sweep enough there (balance minus
 * the 0.000002 ETH keep minus the sweep's own worst-case fee still reaches the need). BLOCKED otherwise, or when the registered max fee is not
 * the 0.1 gwei of the policy file (the usual 50 gwei needs far more ETH than any spendable address holds).
 */
export function fundingVerdict(p: { derivedWei: bigint; contractorWei: bigint; registeredMaxFeeWei: bigint; sweepFeeWei: bigint }): { state: FundingState; line: string } {
  if (p.registeredMaxFeeWei !== MAX_FEE_WEI) return { state: 'BLOCKED', line: `the asset's max fee is ${p.registeredMaxFeeWei.toString()} wei, not ${MAX_FEE_WEI.toString()}` };
  if (p.derivedWei >= MIN_DERIVED_WEI) return { state: 'READY', line: `the derived address holds ${p.derivedWei.toString()} wei, at least ${MIN_DERIVED_WEI.toString()}` };
  if (p.contractorWei < CONTRACTOR_MIN_WEI) return { state: 'BLOCKED', line: `contractor_evm holds ${p.contractorWei.toString()} wei, under ${CONTRACTOR_MIN_WEI.toString()}: fund the derived address with at least 0.00001 ETH` };
  const lands = p.contractorWei - SWEEP_KEEP_WEI - p.sweepFeeWei;
  if (p.derivedWei + lands < MIN_DERIVED_WEI) return { state: 'BLOCKED', line: `the sweep would leave the derived address at ${(p.derivedWei + lands).toString()} wei, under ${MIN_DERIVED_WEI.toString()}: fund it with at least 0.00001 ETH` };
  return { state: 'FUND', line: `the sweep would move about ${lands.toString()} wei (contractor ${p.contractorWei.toString()} minus keep ${SWEEP_KEEP_WEI.toString()} minus fee ${p.sweepFeeWei.toString()}); the derived address would hold about ${(p.derivedWei + lands).toString()} wei` };
}

export type LiveFacts = {
  switches: readonly string[];
  derivedWei: bigint;
  derivedNonce: bigint;
  cardNonce: bigint | null;
  streak: number;
  lock: number;
  pendingForAgent: number;
  maxPending: number;
  baseFeeWei: bigint;
};

/** What must hold right before the payment; null when it can go. The run makes one reject, so the streak must stay under the lock after it. */
export function preflightLive(f: LiveFacts): string | null {
  if (f.switches.length > 0) return `${f.switches.join(', ')} exists: the coordinator turns the hourly jobs off 65 minutes ahead`;
  if (f.derivedWei < MIN_DERIVED_WEI) return `the derived address holds ${f.derivedWei.toString()} wei, under the ${MIN_DERIVED_WEI.toString()} the payment needs`;
  if (f.derivedNonce !== 0n) return `the derived address's Base nonce is ${f.derivedNonce.toString()}, not 0: something already spent from it, ask the coordinator`;
  if (f.cardNonce !== null && f.cardNonce !== f.derivedNonce) return `the card's nonce for ${PATH} is ${f.cardNonce.toString()} and Base says ${f.derivedNonce.toString()}: a request was signed and not sent, ask the coordinator`;
  if (f.streak + 1 >= f.lock) return `the agent's reject streak is ${String(f.streak)} of ${String(f.lock)}: the one reject of this run would lock it`;
  if (f.pendingForAgent + 1 > f.maxPending) return `the agent holds ${String(f.pendingForAgent)} requests of ${String(f.maxPending)}: the held request would not fit`;
  if (f.baseFeeWei > MAX_FEE_WEI) return `Base's base fee is ${f.baseFeeWei.toString()} wei, above the ${MAX_FEE_WEI.toString()} max fee: the transaction would wait`;
  return null;
}

// ---- io ----

export type NearCall = { signer: string; method: string; args: Record<string, unknown>; deposit: string; gas: string };
export type AgentClient = {
  submit(req: ActionRequest, task: OwnerTask): Promise<BatchResult>;
  waitSigned(id: string, timeoutMs: number): Promise<SignedEvent>;
  getRequest(id: string): Promise<RequestView | null>;
  latestBlockMs(): Promise<number>;
};

export type BaseSpendIo = {
  view(contract: string, method: string, args?: object): Promise<unknown>;
  nearBalance(id: string): Promise<bigint>;
  /** a Base Sepolia JSON-RPC read */
  eth(method: string, params: unknown[]): Promise<unknown>;
  /** derive-address.mjs, offline */
  derive(contract: string, path: string): Promise<string>;
  /** the live switches of the hourly jobs that exist */
  switches(): string[];
  /** the last line of scripts/signer-weather.py */
  weather(): Promise<string>;
  /** the card's current book vault, through loadVault, picked by the card's root */
  strictVault(chainRoot: string): { path: string; vault: Vault } | { refuse: string };
  /** scripts/bootstrap-policy.sh --verify (sends nothing; book-vault.ts sync rewrites the vault file it is given) */
  bootstrapVerify(p: { policyFile: string; accountsFile: string; vaultFile: string; taskPublicKey: string }): Promise<{ code: number; out: string }>;
  // writes, used by --live alone
  send(call: NearCall): Promise<{ ok: boolean; tx: string; out: string }>;
  broadcast(raw: Hex): Promise<{ hash: string; status: 'success' | 'reverted' }>;
  sweep(p: { to: string; keep: string; dry: boolean }): Promise<{ code: number; out: string }>;
  agent(vault: Vault): Promise<AgentClient>;
  log(line: string): void;
};

/** The near CLI arguments of a call signed from the keychain. */
export function nearCallArgs(c: NearCall): string[] {
  return ['contract', 'call-function', 'as-transaction', CARD, c.method, 'json-args', JSON.stringify(c.args), 'prepaid-gas', c.gas, 'attached-deposit', c.deposit, 'sign-as', c.signer, 'network-config', 'testnet', 'sign-with-keychain', 'send'];
}
const sweepArgs = (to: string, dry: boolean): string[] => [BRIDGE_TOOL, 'sweep', '--to', to.toLowerCase(), '--keep', SWEEP_KEEP_ETH, ...(dry ? ['--dry-run'] : [])];

export function liveIo(print: (line: string) => void): BaseSpendIo {
  const rpc = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
  const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  return {
    view: (contract, method, args = {}) => rpcView(rpc, contract, method, args),
    nearBalance: async (id) => (await rpcAccount(rpc, id))?.amount ?? 0n,
    eth: async (method, params) => {
      let last = 'no endpoint answered';
      for (const url of BASE_SEPOLIA_RPCS) {
        try {
          const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
          const j = (await r.json()) as { result?: unknown; error?: unknown };
          if (j.error === undefined && 'result' in j) return j.result;
          last = JSON.stringify(j.error).slice(0, 200);
        } catch (e) {
          last = e instanceof Error ? e.message : 'unknown';
        }
      }
      throw new Error(`${method} failed on every Base Sepolia endpoint: ${last}`);
    },
    derive: async (contract, path) => {
      const r = spawnSync('node', [join(REPO, 'scripts', 'derive-address.mjs'), contract, path], { encoding: 'utf8' });
      const a = r.stdout.trim();
      if (r.status !== 0 || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`derive-address failed for ${contract} ${path}`);
      return a;
    },
    // the hourly jobs run from the main checkout: its switches count wherever this script runs from
    switches: () =>
      [...new Set([REPO, process.env['AIRLOCK_MAIN'] ?? join(homedir(), 'apps', 'airlock')])].flatMap((root) =>
        ['target/arena/LIVE_OK', 'target/economy/LIVE_OK'].map((p) => join(root, p)).filter((p) => existsSync(p)),
      ),
    weather: async () => {
      const r = spawnSync('python3', [join(REPO, 'scripts', 'signer-weather.py')], { encoding: 'utf8' });
      return `${r.stdout}`.trim().split('\n').at(-1) ?? 'SIGNER WEATHER UNKNOWN (no output)';
    },
    strictVault: (chainRoot) => {
      const files = vaultCandidates(REPO, process.env['BASE_SPEND_BOOK_VAULT']).filter((f) => existsSync(f));
      const books = new Map<string, Vault>();
      const found = files.map((path) => {
        try {
          const v = loadVault(path);
          books.set(path, v);
          return { path, root: v.root() };
        } catch {
          return { path, root: null };
        }
      });
      const picked = pickVault(found, chainRoot);
      if ('refuse' in picked) return picked;
      const vault = books.get(picked.path);
      return vault === undefined ? { refuse: 'the book vault file cannot be read' } : { path: picked.path, vault };
    },
    bootstrapVerify: async (p) => {
      const r = spawnSync('bash', [join(REPO, 'scripts', 'bootstrap-policy.sh'), '--verify'], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, AIRLOCK_ACCOUNTS_FILE: p.accountsFile, AIRLOCK_POLICY_FILE: p.policyFile, AIRLOCK_BOOK_VAULT: p.vaultFile, TASK_PUBLIC_KEY: p.taskPublicKey },
      });
      return { code: r.status ?? 1, out: clean(`${r.stdout}${r.stderr}`) };
    },
    send: async (c) => {
      const r = spawnSync(process.env['NEAR'] ?? 'near', nearCallArgs(c), { encoding: 'utf8' });
      const out = clean(`${r.stdout}${r.stderr}`);
      const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1] ?? '';
      const failed = r.status !== 0 || tx === '' || /ExecutionError|Failure|panicked/.test(out);
      return { ok: !failed, tx, out };
    },
    broadcast: async (raw) => {
      const { broadcast } = await import('../runtime/src/chain/evm.ts');
      return broadcast(raw);
    },
    sweep: async (p) => {
      const r = spawnSync('node', sweepArgs(p.to, p.dry), { encoding: 'utf8', cwd: dirname(BRIDGE_TOOL) });
      return { code: r.status ?? 1, out: clean(`${r.stdout}${r.stderr}`) };
    },
    agent: async (vault) => {
      const { ChainClient } = await import('../runtime/src/chain/near.ts');
      const { loadAgentSigner } = await import('../runtime/src/credit/agent-signer.ts');
      const { rpcKeys } = await import('../runtime/src/credit/rpc.ts');
      const { taskSigner } = await import('../runtime/src/mcp/boot.ts');
      const env = process.env;
      const keys = (await rpcKeys(rpc, AGENT)).map((k) => k.publicKey);
      const scopedFile = env['ARENA_KEY_FILE'] ?? join(homedir(), '.airlock-arena-key.json');
      const keychainFile = env['ARENA_AGENT_CREDENTIALS'] ?? join(REPO, 'target', 'credit-run', 'agent.json');
      const got = await loadAgentSigner({ agent: AGENT, keys, scopedFile, keychainFile, env });
      if ('refuse' in got) throw new Error(`no agent signer: ${got.refuse}`);
      print(got.line.replace(/^ARENA SIGNER/, 'BASE SPEND SIGNER'));
      const sign = taskSigner(env['AIRLOCK_TASK_KEY_FILE'] ?? join(homedir(), '.airlock-task-key'));
      const client = new ChainClient({ network: 'testnet', contractId: CARD, agentAccountId: AGENT, signer: got.signer, rpcUrls: [...DEFAULT_RPC_URLS], vault });
      return {
        submit: (req, task) => client.submitBatch([req], task, sign(task)),
        waitSigned: (id, ms) => client.waitSigned(id, ms),
        getRequest: (id) => client.getRequest(id),
        latestBlockMs: () => client.latestBlockMs(),
      };
    },
    log: print,
  };
}

// ---- reads ----

const hexBig = (v: unknown): bigint => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : 0n);
const decBig = (v: unknown): bigint | null => (typeof v === 'string' && /^[0-9]+$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : null);

type State = {
  derived: string;
  merchantEvm: string;
  injected: string;
  approver: string;
  paused: boolean;
  assets: string[];
  baseAsset: unknown;
  root: string;
  epoch: string;
  cardNonce: bigint | null;
  pendingAll: number;
  heldRows: number;
  pendingForAgent: number;
  streak: number;
  lock: number;
  maxPending: number;
  taskKey: string;
  eth: Record<string, { wei: bigint; nonce: bigint }>;
  gasPrice: bigint;
  priority: bigint;
  baseFee: bigint;
};

const names = { derived: 'derived (card, credit-card-1)', merchant: 'merchant (merchant-1)', injected: 'injected (email)', contractor: 'contractor_evm' } as const;

async function readState(io: BaseSpendIo): Promise<State> {
  const email = JSON.parse(readFileSync(EMAIL_FILE, 'utf8')) as { injected_address: string };
  const derived = (await io.derive(CARD, PATH)).toLowerCase();
  const merchantEvm = (await io.derive(MERCHANT_ACCOUNT, MERCHANT_PATH)).toLowerCase();
  if (merchantEvm !== MERCHANT_EVM) throw new Error(`the merchant's derived address is ${merchantEvm}, not ${MERCHANT_EVM}`);
  const policy = await io.view(CARD, 'get_policy');
  const roles = await io.view(CARD, 'get_roles');
  const assets = await io.view(CARD, 'list_assets');
  const root = await io.view(CARD, 'get_book_root');
  const epoch = await io.view(CARD, 'get_book_epoch');
  const nonce = await io.view(CARD, 'get_nonce', { path: PATH });
  const baseAsset = await io.view(CARD, 'get_asset', { asset: ASSET });
  const esc = await io.view(CARD, 'get_escalation_state', { agent: AGENT });
  const taskKey = await io.view(CARD, 'get_task_key');
  let pendingAll = 0;
  let heldRows = 0;
  for (let page = 0; page < 20; page += 1) {
    const rows = await io.view(CARD, 'get_pending', { from_index: page * 20, limit: 20 });
    if (!Array.isArray(rows)) throw new Error('get_pending answered something unexpected');
    for (const r of rows) {
      if (!isObj(r) || r['state'] !== 'Pending') continue;
      pendingAll += 1;
      if (r['agent'] === AGENT) heldRows += 1;
    }
    if (rows.length < 20) break;
  }
  if (!isObj(policy) || typeof policy['paused'] !== 'boolean') throw new Error('get_policy answered something unexpected');
  if (!isObj(roles) || typeof roles['approver'] !== 'string') throw new Error('get_roles answered something unexpected');
  if (!Array.isArray(assets)) throw new Error('list_assets answered something unexpected');
  if (typeof root !== 'string' || !/^[0-9a-f]{64}$/.test(root)) throw new Error('get_book_root answered something unexpected');
  const limits = isObj(esc) && isObj(esc['limits']) ? esc['limits'] : null;
  if (!isObj(esc) || limits === null || typeof esc['consecutive_rejects'] !== 'number' || typeof limits['lock_consecutive'] !== 'number' || typeof limits['max_pending'] !== 'number') throw new Error('get_escalation_state answered something unexpected');
  // the contract's own count of the agent's held requests (owner origin) is what max_pending is checked against; held rows past their TTL
  // that no one expired still show as Pending in get_pending
  const pendingForAgent = typeof esc['pending'] === 'number' ? esc['pending'] : heldRows;
  const eth: State['eth'] = {};
  for (const [k, a] of [['derived', derived], ['merchant', merchantEvm], ['injected', email.injected_address.toLowerCase()], ['contractor', CONTRACTOR_EVM]] as const) {
    eth[k] = { wei: hexBig(await io.eth('eth_getBalance', [a, 'latest'])), nonce: hexBig(await io.eth('eth_getTransactionCount', [a, 'pending'])) };
  }
  const block = await io.eth('eth_getBlockByNumber', ['latest', false]);
  return {
    derived,
    merchantEvm,
    injected: email.injected_address.toLowerCase(),
    approver: roles['approver'],
    paused: policy['paused'],
    assets: assets.map((a) => (Array.isArray(a) ? String(a[0]) : String(a))),
    baseAsset,
    root,
    epoch: String(epoch),
    cardNonce: decBig(nonce),
    pendingAll,
    heldRows,
    pendingForAgent,
    streak: esc['consecutive_rejects'],
    lock: limits['lock_consecutive'],
    maxPending: limits['max_pending'],
    taskKey: typeof taskKey === 'string' ? taskKey : '',
    eth,
    gasPrice: hexBig(await io.eth('eth_gasPrice', [])),
    priority: hexBig(await io.eth('eth_maxPriorityFeePerGas', [])),
    baseFee: isObj(block) ? hexBig(block['baseFeePerGas']) : 0n,
  };
}

/** The card views and Base nonces a dry run must leave as they were. */
const cardSnapshot = (s: State): string => JSON.stringify({ paused: s.paused, assets: s.assets, baseAsset: s.baseAsset, root: s.root, epoch: s.epoch, nonce: s.cardNonce?.toString() ?? null, pending: s.pendingAll, streak: s.streak });
const nonceSnapshot = (s: State): string => JSON.stringify(Object.fromEntries(Object.entries(s.eth).map(([k, v]) => [k, v.nonce.toString()])));

/** The sweep's own worst-case fee, as the bridge tool computes it: 21000 gas times 1.2, at viem's estimated max fee (about 2 base fees plus the priority fee). */
const sweepFeeOf = (s: State): bigint => ((GAS * 12n) / 10n) * (2n * s.baseFee + s.priority);

// ---- the plan ----

type Step = { who: string; what: string; call: string };

function planSteps(s: State, newRoot: string, vaultOut: string, accountsFile: string, fundState: FundingState): Step[] {
  const near = (c: NearCall): string => shellLine('near', nearCallArgs(c));
  const entry = (JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as { assets: Record<string, unknown> }).assets[ASSET];
  const nonceNow = s.eth['derived']?.nonce ?? 0n;
  const steps: Step[] = [
    { who: 'coordinator', what: 'remove target/arena/LIVE_OK and target/economy/LIVE_OK in ~/apps/airlock at least 65 minutes ahead (the last hold must pass its 1 h TTL); this script refuses while either exists', call: 'rm ~/apps/airlock/target/arena/LIVE_OK ~/apps/airlock/target/economy/LIVE_OK' },
    {
      who: 'contractor_evm key, through the bridge tool',
      what: fundState === 'READY' ? 'fund: skipped, the derived address already holds the need' : `fund: dry sweep to read the amount, then the real sweep; then the derived balance must be at least ${MIN_DERIVED_WEI.toString()} wei`,
      call: `${shellLine('node', sweepArgs(s.derived, true))} ; ${shellLine('node', sweepArgs(s.derived, false))}`,
    },
    { who: 'issuer', what: `record paused (now ${String(s.paused)}); unpause when it is paused`, call: s.paused ? near({ signer: ISSUER, method: 'pause', args: { paused: false }, deposit: '1 yoctoNEAR', gas: '30 Tgas' }) : 'none: the card is not paused' },
    { who: 'this script', what: `write the new book vault ${vaultOut} (mode 0600): the current book plus the Base merchant; the current vault file is read, never written`, call: 'saveVault (runtime/src/vault/file.ts)' },
    { who: 'issuer', what: 'register the Base asset', call: near({ signer: ISSUER, method: 'asset_set', args: { asset: ASSET, entry }, deposit: '1 yoctoNEAR', gas: '100 Tgas' }) },
    { who: 'issuer', what: `set the book root (epoch ${s.epoch} becomes ${String(BigInt(s.epoch) + 1n)})`, call: near({ signer: ISSUER, method: 'book_set_root', args: { expected_old: s.root, new_root: newRoot }, deposit: '1 yoctoNEAR', gas: '100 Tgas' }) },
    { who: 'issuer', what: `set the nonce of ${PATH} to the derived address's pending Base nonce`, call: near({ signer: ISSUER, method: 'set_nonce', args: { path: PATH, nonce: nonceNow.toString() }, deposit: '1 yoctoNEAR', gas: '100 Tgas' }) },
    { who: 'no signer (read-only)', what: 'the bootstrap verify must end POLICY MATCHES', call: `AIRLOCK_ACCOUNTS_FILE=${accountsFile} AIRLOCK_POLICY_FILE=fixtures/credit/card-base.policy.json AIRLOCK_BOOK_VAULT=${vaultOut} TASK_PUBLIC_KEY=<get_task_key> bash scripts/bootstrap-policy.sh --verify` },
    { who: 'no signer (read-only)', what: 'signer weather: GOOD starts; SLOW or BAD: rerun --live after 30 minutes (every step above is skipped once done)', call: 'python3 scripts/signer-weather.py' },
    { who: 'agent (scoped function-call key) + task key', what: `the merchant payment, recipient Book, amount Owner: expect allowed, then waitSigned (MPC signs, ${String(SIGN_WAIT_MS / 1000)} s max)`, call: `submit_batch {reqs:[{asset:${ASSET}, payee:${payeeKey(s.merchantEvm)}, amount:${AMOUNT_WEI.toString()}, evm:{gas_limit:21000, max_fee_per_gas:${MAX_FEE_WEI.toString()}, max_priority_fee_per_gas:${PRIORITY_FEE_WEI.toString()}}}], task, task_sig}` },
    { who: 'no signer (the MPC signature is already in the bytes)', what: 'assembleEvm, verifySignedMatchesRequest, then broadcast; receipt success from the derived address to the merchant, value 1000000000000 wei; merchant balance up by exactly that', call: 'eth_sendRawTransaction <signed bytes> (runtime/src/chain/evm.ts broadcast)' },
    { who: 'agent (scoped function-call key) + task key', what: 'the same amount to the injected address, recipient Untrusted:email: expect escalated', call: `submit_batch {reqs:[{asset:${ASSET}, payee:${payeeKey(s.injected)}, amount:${AMOUNT_WEI.toString()}, labels.recipient:Untrusted:email}], task, task_sig}` },
    { who: `approver ${s.approver}`, what: `approve must fail with "${APPROVER_REFUSAL}"`, call: near({ signer: s.approver, method: 'approve', args: { id: '<pending id>', to: payeeKey(s.injected), asset: 'ETH.base', amount: '0.000001', why: '<reason>', book: '<book status>' }, deposit: '1 yoctoNEAR', gas: '65 Tgas' }) },
    { who: 'issuer', what: 'reject the held request (nothing signed: the derived nonce stays 1, the injected balance unchanged, get_nonce 1)', call: near({ signer: ISSUER, method: 'reject', args: { id: '<pending id>' }, deposit: '1 yoctoNEAR', gas: '30 Tgas' }) },
    { who: 'issuer', what: 'restore paused to the recorded value (when it was true)', call: s.paused ? near({ signer: ISSUER, method: 'pause', args: { paused: true }, deposit: '1 yoctoNEAR', gas: '30 Tgas' }) : 'none: the card was not paused' },
    { who: 'coordinator', what: `copy the epoch ${String(BigInt(s.epoch) + 1n)} vault over target/arena/book.vault.strict.json and target/credit-run/book.vault.strict.json (keep the epoch ${s.epoch} files aside), check with credit-economy.ts check, then put both LIVE_OK back`, call: `cp -p ${vaultOut} ~/apps/airlock/target/arena/book.vault.strict.json ; cp -p ${vaultOut} ~/apps/airlock/target/credit-run/book.vault.strict.json` },
  ];
  return steps;
}

// ---- rows ----

type Row = { what: string; account: string; tx: string; link: string };
const nearRow = (what: string, account: string, tx: string): Row => ({ what, account, tx, link: `${NEARBLOCKS}${tx}` });

// ---- main ----

export type Deps = { io: BaseSpendIo; env: Record<string, string | undefined> };

export async function main(argv: readonly string[], deps?: Partial<Deps>): Promise<number> {
  const env = deps?.env ?? process.env;
  let mode: 'dry' | 'live' | 'verify' = 'dry';
  let rowsFile = join(REPO, 'target', 'credit-base', 'rows.json');
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live' && mode === 'dry') mode = 'live';
    else if (a === '--verify' && mode === 'dry') mode = 'verify';
    else if (a === '--rows' && argv[i + 1] !== undefined) rowsFile = argv[(i += 1)] ?? rowsFile;
    else if (a === '--vault' && argv[i + 1] !== undefined) env['BASE_SPEND_BOOK_VAULT'] = argv[(i += 1)];
    else {
      console.log('usage: credit-base-spend.ts [--vault <book vault>] [--rows <rows file>] [--live | --verify]');
      return 2;
    }
  }
  if (mode === 'live' && env[LIVE_FLAG] !== '1') {
    (deps?.io?.log ?? console.log)(`BASE SPEND NOT SENT --live needs ${LIVE_FLAG}=1 next to it`);
    return 2;
  }
  if (deps?.io === undefined && env['BASE_SPEND_BOOK_VAULT'] !== undefined) process.env['BASE_SPEND_BOOK_VAULT'] = env['BASE_SPEND_BOOK_VAULT'];
  const io = deps?.io ?? liveIo((l) => console.log(l));
  if (mode === 'verify') return verify(io, rowsFile);

  const policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as Record<string, unknown>;
  const s = await readState(io);
  const outDir = join(REPO, 'target', 'credit-base');
  const vaultOut = join(outDir, 'book.vault.base.json');
  const accountsFile = join(outDir, 'accounts.json');

  io.log(`card ${CARD} (owner ${ISSUER}, approver ${s.approver}, agent ${AGENT})`);
  io.log(`derived ${s.derived} = derive-address.mjs ${CARD} ${PATH}`);
  io.log(`merchant ${s.merchantEvm} = derive-address.mjs ${MERCHANT_ACCOUNT} ${MERCHANT_PATH}`);
  io.log(`injected ${s.injected} (fixtures/credit/base-spend-email.json)`);
  io.log(`card paused ${String(s.paused)}; assets ${s.assets.join(',')}; ${ASSET} ${s.baseAsset === null ? 'absent' : 'present'}; book root ${s.root} epoch ${s.epoch}; get_nonce ${PATH} ${s.cardNonce?.toString() ?? 'null'}`);
  io.log(`held rows on the card ${String(s.pendingAll)} (${String(s.heldRows)} by the agent; the card counts ${String(s.pendingForAgent)} pending for the agent); agent reject streak ${String(s.streak)} of ${String(s.lock)}; max pending ${String(s.maxPending)}`);
  for (const [k, v] of Object.entries(s.eth)) io.log(`base ${names[k as keyof typeof names]} balance ${v.wei.toString()} wei nonce ${v.nonce.toString()}`);
  io.log(`base gas price ${s.gasPrice.toString()} wei, base fee ${s.baseFee.toString()} wei, priority ${s.priority.toString()} wei; the request's max fee ${MAX_FEE_WEI.toString()} wei ${s.baseFee > MAX_FEE_WEI ? 'IS UNDER the base fee: it would wait' : 'covers the base fee'}`);
  io.log(`worst case of the payment ${worstCaseWei().toString()} wei (value ${AMOUNT_WEI.toString()} plus ${GAS.toString()} gas at ${MAX_FEE_WEI.toString()}); the derived address needs at least ${MIN_DERIVED_WEI.toString()} wei`);

  const registered = isObj(policy['assets']) && isObj((policy['assets'] as Record<string, unknown>)[ASSET]) ? decBig(((policy['assets'] as Record<string, unknown>)[ASSET] as Record<string, unknown>)['max_fee_per_gas']) ?? 0n : 0n;
  const funding = fundingVerdict({ derivedWei: s.eth['derived']?.wei ?? 0n, contractorWei: s.eth['contractor']?.wei ?? 0n, registeredMaxFeeWei: registered, sweepFeeWei: sweepFeeOf(s) });
  io.log(`FUNDING ${funding.state === 'BLOCKED' ? 'BLOCKED' : funding.state} ${funding.line}${funding.state === 'FUND' ? ' (the contractor key file is not looked at here: the bridge tool loads it at run time)' : ''}`);

  // the book: the card's current vault (found by its root), and the new one with the Base merchant
  const cur = io.strictVault(s.root);
  if ('refuse' in cur) {
    io.log(`BOOK the card's current vault was not found: ${cur.refuse}`);
    if (mode === 'live') {
      io.log('BASE SPEND NOT SENT the current book vault is needed for book_set_root');
      return 1;
    }
  }
  let newVault: Vault | null = null;
  if (!('refuse' in cur)) {
    const why = whyNotStrict(cur.vault);
    io.log(`BOOK current vault ${cur.path}: ${String(cur.vault.entries.length)} entries, root equals the card's, ${why === null ? 'strict' : `not strict (${why})`}`);
    newVault = baseVaultOf(cur.vault, policy, s.merchantEvm);
    io.log(`BOOK new vault: ${String(newVault.entries.length)} entries, ${whyNotStrict(newVault) === null ? 'strict' : 'NOT strict'}, root ${mode === 'dry' ? '(a fresh salt is drawn at live time; this dry root is an example) ' : ''}${newVault.root()}`);
  }

  const steps = planSteps(s, newVault?.root() ?? '<new root>', vaultOut, accountsFile, funding.state);
  steps.forEach((st, i) => {
    io.log(`STEP ${String(i + 1)} [${st.who}] ${st.what}`);
    io.log(`  ${st.call}`);
  });

  if (mode === 'dry') {
    // the bootstrap verify against a scratch copy of the new vault: the DRIFT lines allowed are the new asset, the book root and the nonce
    if (newVault !== null) {
      const dryDir = join(outDir, 'dry');
      mkdirSync(dryDir, { recursive: true });
      const dryVault = join(dryDir, 'book.vault.json');
      const dryAccounts = join(dryDir, 'accounts.json');
      saveVault(newVault, dryVault);
      writeFileSync(dryAccounts, JSON.stringify({ owner: ISSUER, policy: CARD, agent: AGENT, acme: MERCHANT_ACCOUNT, merchant_evm: s.merchantEvm }, null, 2));
      const v = await io.bootstrapVerify({ policyFile: POLICY_FILE, accountsFile: dryAccounts, vaultFile: dryVault, taskPublicKey: s.taskKey });
      rmSync(dryVault, { force: true });
      const drift = v.out.split('\n').filter((l) => l.startsWith('DRIFT'));
      const allowed = /^DRIFT (asset evm:84532:native field present|assets field ids|book field root|nonce field get_nonce) /;
      for (const l of drift) io.log(`BOOTSTRAP ${allowed.test(l) ? 'expected' : 'UNEXPECTED'} ${l.slice(0, 160)}`);
      const unexpected = drift.filter((l) => !allowed.test(l)).length;
      io.log(`BOOTSTRAP VERIFY ${String(drift.length)} drift line(s), ${String(unexpected)} unexpected (task key compared to the card's own get_task_key)`);
    }
    const again = await readState(io);
    io.log(cardSnapshot(again) === cardSnapshot(s) ? 'CARD VIEWS UNCHANGED' : `CARD VIEWS CHANGED during the dry run (an hourly job?): ${cardSnapshot(s)} then ${cardSnapshot(again)}`);
    io.log(nonceSnapshot(again) === nonceSnapshot(s) ? `BASE NONCES UNCHANGED ${nonceSnapshot(again)}` : `BASE NONCES CHANGED ${nonceSnapshot(s)} then ${nonceSnapshot(again)}`);
    const pre = preflightLive({ switches: io.switches(), derivedWei: MIN_DERIVED_WEI > (s.eth['derived']?.wei ?? 0n) && funding.state === 'FUND' ? MIN_DERIVED_WEI : (s.eth['derived']?.wei ?? 0n), derivedNonce: s.eth['derived']?.nonce ?? 0n, cardNonce: s.cardNonce, streak: s.streak, lock: s.lock, pendingForAgent: s.pendingForAgent, maxPending: s.maxPending, baseFeeWei: s.baseFee });
    io.log(`PREFLIGHT (after funding) ${pre === null ? 'would pass' : `would stop: ${pre}`}`);
    io.log('DRY RUN nothing sent');
    return 0;
  }

  if (newVault === null) return 1;
  return live(io, s, newVault, vaultOut, accountsFile, rowsFile, funding.state);
}

async function live(io: BaseSpendIo, s0: State, newVault: Vault, vaultOut: string, accountsFile: string, rowsFile: string, fundState: FundingState): Promise<number> {
  const stop = (why: string): number => {
    io.log(`BASE SPEND NOT SENT ${why}`);
    return 1;
  };
  const switches = io.switches();
  if (switches.length > 0) return stop(`${switches.join(', ')} exists: the coordinator turns the hourly jobs off 65 minutes ahead`);
  if (fundState === 'BLOCKED') return stop('funding is BLOCKED (see the FUNDING line)');
  mkdirSync(dirname(rowsFile), { recursive: true });
  const rows: Row[] = existsSync(rowsFile) ? (JSON.parse(readFileSync(rowsFile, 'utf8')) as Row[]) : [];
  const has = (what: string): Row | undefined => rows.find((r) => r.what === what);
  const add = (r: Row): void => {
    rows.push(r);
    writeFileSync(rowsFile, JSON.stringify(rows, null, 2));
    io.log(`ROW ${r.what} | ${r.account} | ${r.link}`);
  };
  const stateFile = join(dirname(rowsFile), 'state.json');
  const saved = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as { pausedBefore: boolean }) : null;
  const pausedBefore = saved?.pausedBefore ?? s0.paused;
  if (saved === null) writeFileSync(stateFile, JSON.stringify({ pausedBefore }, null, 2));
  const must = async (what: string, c: NearCall): Promise<string> => {
    const r = await io.send(c);
    if (!r.ok) throw new Error(`${what} failed: ${r.out.slice(-500)}`);
    add(nearRow(what, CARD, r.tx));
    return r.tx;
  };

  // b. fund
  if ((s0.eth['derived']?.wei ?? 0n) < MIN_DERIVED_WEI) {
    const d = await io.sweep({ to: s0.derived, keep: SWEEP_KEEP_ETH, dry: true });
    io.log(`sweep dry: ${d.out.trim().split('\n').join(' / ')}`);
    if (d.code !== 0) return stop('the dry sweep failed');
    const r = await io.sweep({ to: s0.derived, keep: SWEEP_KEEP_ETH, dry: false });
    io.log(`sweep: ${r.out.trim().split('\n').join(' / ')}`);
    const hash = /tx (0x[0-9a-f]{64})/.exec(r.out)?.[1];
    if (r.code !== 0 || hash === undefined) return stop('the sweep failed');
    add({ what: 'fund: contractor_evm sends ETH to the card derived address (our own test ETH)', account: CONTRACTOR_EVM, tx: hash, link: `${BASESCAN}${hash}` });
  }
  const bal = hexBig(await io.eth('eth_getBalance', [s0.derived, 'latest']));
  if (bal < MIN_DERIVED_WEI) return stop(`the derived address holds ${bal.toString()} wei after funding, under ${MIN_DERIVED_WEI.toString()}`);

  // c. paused, the vault, the three owner calls, the bootstrap verify
  if (s0.paused) await must('issuer unpauses the card for the run', { signer: ISSUER, method: 'pause', args: { paused: false }, deposit: '1 yoctoNEAR', gas: '30 Tgas' });
  mkdirSync(dirname(vaultOut), { recursive: true });
  let vault = newVault;
  if (existsSync(vaultOut)) {
    const kept = loadVault(vaultOut);
    if (!kept.has(payeeKey(MERCHANT_EVM)) || whyNotStrict(kept) !== null) return stop(`${vaultOut} exists and is not the new book: move it away`);
    vault = kept;
  } else saveVault(vault, vaultOut);
  writeFileSync(accountsFile, JSON.stringify({ owner: ISSUER, policy: CARD, agent: AGENT, acme: MERCHANT_ACCOUNT, merchant_evm: s0.merchantEvm }, null, 2));
  const entry = (JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as { assets: Record<string, unknown> }).assets[ASSET];
  if ((await io.view(CARD, 'get_asset', { asset: ASSET })) === null) await must('asset_set: the Base Sepolia asset (max fee 0.1 gwei, path credit-card-1)', { signer: ISSUER, method: 'asset_set', args: { asset: ASSET, entry }, deposit: '1 yoctoNEAR', gas: '100 Tgas' });
  const rootNow = String(await io.view(CARD, 'get_book_root'));
  if (rootNow !== vault.root()) {
    if (rootNow !== s0.root) return stop('the card holds a root that is neither the current book nor the new one');
    await must('book_set_root: the book with the Base merchant (private, the card stores the root)', { signer: ISSUER, method: 'book_set_root', args: { expected_old: rootNow, new_root: vault.root() }, deposit: '1 yoctoNEAR', gas: '100 Tgas' });
  }
  if ((await io.view(CARD, 'get_nonce', { path: PATH })) === null) {
    const n = hexBig(await io.eth('eth_getTransactionCount', [s0.derived, 'pending']));
    await must(`set_nonce: ${PATH} at ${n.toString()}`, { signer: ISSUER, method: 'set_nonce', args: { path: PATH, nonce: n.toString() }, deposit: '1 yoctoNEAR', gas: '100 Tgas' });
  }
  const boot = await io.bootstrapVerify({ policyFile: POLICY_FILE, accountsFile, vaultFile: vaultOut, taskPublicKey: s0.taskKey });
  for (const l of boot.out.split('\n')) if (/^(DRIFT|POLICY )/.test(l)) io.log(`BOOTSTRAP ${l}`);
  if (boot.code !== 0 || !boot.out.includes('POLICY MATCHES')) return stop('the bootstrap verify did not end POLICY MATCHES');

  // d. weather, then the payment
  const s = await readState(io);
  if (!has('payment')) {
    const pre = preflightLive({ switches: io.switches(), derivedWei: s.eth['derived']?.wei ?? 0n, derivedNonce: s.eth['derived']?.nonce ?? 0n, cardNonce: s.cardNonce, streak: s.streak, lock: s.lock, pendingForAgent: s.pendingForAgent, maxPending: s.maxPending, baseFeeWei: s.baseFee });
    if (pre !== null) return stop(pre);
    const weather = await io.weather();
    io.log(`WEATHER ${weather}`);
    if (/SIGNER WEATHER (SLOW|BAD)/.test(weather)) return stop('signer weather is not GOOD: rerun --live in 30 minutes (the owner calls are done and are skipped on a rerun)');
    const agent = await io.agent(vault);
    const merchantBefore = s.eth['merchant']?.wei ?? 0n;
    const pay = paymentPair({ id: 'pay', payee: payeeKey(s.merchantEvm), recipient: ['Book'], nowMs: await agent.latestBlockMs() });
    const paid = await agent.submit(pay.req, pay.task);
    const o = paid.outcomes[0];
    if (o?.outcome !== 'allowed') return stop(`the merchant payment was not allowed: ${JSON.stringify(paid.outcomes)}`);
    add(nearRow('the agent pays the Base merchant 0.000001 ETH through the verdict: Allow', CARD, paid.txHash ?? ''));
    const signed = await agent.waitSigned(o.request_id, SIGN_WAIT_MS);
    const view = await agent.getRequest(o.request_id);
    if (view === null) return stop('the card has no record of the signed request');
    const { assembleEvm, decodeUnsigned } = await import('../runtime/src/chain/evm.ts');
    const { verifySignedMatchesRequest } = await import('../runtime/src/chain/evm.check.ts');
    const raw = assembleEvm(signed.unsigned_hex, { big_r: signed.big_r, s: signed.s, recovery_id: signed.recovery_id });
    await verifySignedMatchesRequest(raw, view, s.derived);
    io.log(`PASS verifySignedMatchesRequest nonce ${decodeUnsigned(raw).nonce.toString()}`);
    const sent = await io.broadcast(raw);
    const receipt = await io.eth('eth_getTransactionReceipt', [sent.hash]);
    const tx = await io.eth('eth_getTransactionByHash', [sent.hash]);
    if (!isObj(receipt) || !isObj(tx) || receipt['status'] !== '0x1' || String(receipt['from']).toLowerCase() !== s.derived || String(receipt['to']).toLowerCase() !== s.merchantEvm || hexBig(tx['value']) !== AMOUNT_WEI) {
      return stop(`the Base receipt of ${sent.hash} is not success from ${s.derived} to ${s.merchantEvm} for ${AMOUNT_WEI.toString()} wei`);
    }
    add({ what: 'payment', account: s.derived, tx: sent.hash, link: `${BASESCAN}${sent.hash}` });
    const merchantAfter = hexBig(await io.eth('eth_getBalance', [s.merchantEvm, 'latest']));
    io.log(`merchant balance ${merchantBefore.toString()} then ${merchantAfter.toString()} wei (${merchantAfter - merchantBefore === AMOUNT_WEI ? 'up by exactly the amount' : 'NOT up by exactly the amount'})`);
    if (merchantAfter - merchantBefore !== AMOUNT_WEI) return stop('the merchant balance did not rise by exactly the amount');
  }

  // e. the injected address: held, the approver refused, the issuer rejects
  if (!has('issuer rejects the held injected request')) {
    const agent = await io.agent(vault);
    const injectedBefore = hexBig(await io.eth('eth_getBalance', [s.injected, 'latest']));
    const inj = paymentPair({ id: 'inject', payee: payeeKey(s.injected), recipient: ['Untrusted:email'], nowMs: await agent.latestBlockMs() });
    const held = await agent.submit(inj.req, inj.task);
    const h = held.outcomes[0];
    if (h?.outcome !== 'escalated' || h.pending_id === null) return stop(`the injected address was not held: ${JSON.stringify(held.outcomes)}`);
    add(nearRow(`an injected Base address from an email is held (${h.reason ?? '-'})`, CARD, held.txHash ?? ''));
    const v = await agent.getRequest(h.pending_id);
    if (v === null || v.display === null) return stop('no card for the held request');
    const refused = await io.send({ signer: s.approver, method: 'approve', args: { id: h.pending_id, to: v.payee, asset: v.display.asset_symbol, amount: v.display.amount_decimal, why: v.reason, book: v.book_status }, deposit: '1 yoctoNEAR', gas: '65 Tgas' });
    if (refused.ok || !refused.out.includes(APPROVER_REFUSAL)) return stop(`the approver was not refused: ${refused.out.slice(-400)}`);
    add(nearRow('the borrower taps approve on the injected address: refused (the payee is not in the book at this epoch)', CARD, refused.tx));
    await must('issuer rejects the held injected request', { signer: ISSUER, method: 'reject', args: { id: h.pending_id }, deposit: '1 yoctoNEAR', gas: '30 Tgas' });
    const nonceAfter = hexBig(await io.eth('eth_getTransactionCount', [s.derived, 'latest']));
    const injectedAfter = hexBig(await io.eth('eth_getBalance', [s.injected, 'latest']));
    const cardNonce = decBig(await io.view(CARD, 'get_nonce', { path: PATH }));
    io.log(`derived Base nonce ${nonceAfter.toString()}, card get_nonce ${cardNonce?.toString() ?? 'null'}, injected balance ${injectedBefore.toString()} then ${injectedAfter.toString()}`);
    if (nonceAfter !== 1n || cardNonce !== 1n || injectedAfter !== injectedBefore) return stop('after the reject the nonces are not 1 or the injected balance moved');
  }

  // f. restore paused
  const pausedNow = await io.view(CARD, 'get_policy');
  if (isObj(pausedNow) && pausedNow['paused'] !== pausedBefore) await must('issuer restores paused to its recorded value', { signer: ISSUER, method: 'pause', args: { paused: pausedBefore }, deposit: '1 yoctoNEAR', gas: '30 Tgas' });
  const epoch = String(await io.view(CARD, 'get_book_epoch'));
  io.log(`HANDSHAKE the book epoch is now ${epoch}: copy ${vaultOut} over ~/apps/airlock/target/arena/book.vault.strict.json and ~/apps/airlock/target/credit-run/book.vault.strict.json (cp -p, keep the old ones aside), run credit-economy.ts check, then put both LIVE_OK back`);
  io.log('BASE SPEND LIVE OK');
  return 0;
}

/** `--verify`: read-only. Fails clearly until the live rows exist. */
async function verify(io: BaseSpendIo, rowsFile: string): Promise<number> {
  const no = (why: string): number => {
    io.log(`BASE SPEND VERIFY NO ${why}`);
    return 1;
  };
  if (!existsSync(rowsFile)) return no(`the live rows do not exist yet (${rowsFile}): the live run writes them`);
  const rows = JSON.parse(readFileSync(rowsFile, 'utf8')) as Row[];
  const pay = rows.find((r) => r.what === 'payment');
  if (pay === undefined) return no('no payment row');
  for (const w of ['asset_set', 'book_set_root', 'set_nonce', 'the agent pays the Base merchant', 'is held', 'refused', 'issuer rejects']) if (!rows.some((r) => r.what.includes(w))) return no(`no row for ${w}`);
  const derived = (await io.derive(CARD, PATH)).toLowerCase();
  const receipt = await io.eth('eth_getTransactionReceipt', [pay.tx]);
  const tx = await io.eth('eth_getTransactionByHash', [pay.tx]);
  if (!isObj(receipt) || !isObj(tx) || receipt['status'] !== '0x1' || String(receipt['from']).toLowerCase() !== derived || String(receipt['to']).toLowerCase() !== MERCHANT_EVM || hexBig(tx['value']) !== AMOUNT_WEI) return no(`the Base receipt of ${pay.tx} does not match`);
  if (decBig(await io.view(CARD, 'get_nonce', { path: PATH })) !== 1n) return no('get_nonce is not 1');
  io.log(`BASE SPEND VERIFY OK ${BASESCAN}${pay.tx}`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`BASE SPEND FAILED ${e instanceof Error ? e.message.slice(0, 400) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

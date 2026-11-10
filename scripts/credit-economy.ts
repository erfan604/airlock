// AIR-359 (lane1 part): the hourly economy loop on the credit pool, one cycle per run. The borrower posts 30 percent collateral, the issuer
// opens a line of 0.09 NEAR at a 10 percent fee due in 24 hours, the agent pays the booked merchant 0.09 NEAR under an owner task that
// states the amount (label Owner, so strict mode allows it), the borrower repays 0.099 NEAR, and the merchant sends what it holds above
// 0.1 NEAR back to the borrower once a day. The borrower, the merchant, the issuer and the agent are the team's accounts and the fee is
// the team's money: this shows how the pool works, it is not a market. Testnet only. No account is created, no faucet is used.
//   pnpm tsx scripts/credit-economy.ts dry     read only: the state, the stop rule that holds and the plan with exact amounts; sends nothing
//   pnpm tsx scripts/credit-economy.ts check   read only: the preflight too (agent signer, book vault, task key, keychain entries)
//   pnpm tsx scripts/credit-economy.ts         one live cycle, only while target/economy/LIVE_OK exists; every stop rule exits 0
// Stop rules (runtime/src/economy/stops.ts): LIVE_OK missing, target/credit/MAINTENANCE, the lock target/credit/LOCK held (it is shared with
// scripts/credit-arena.ts so the two never sign as the agent at once), a line the loop did not open, the card paused or holding a request
// that is not an arena hold, a pool with a past-due line or a loss, a loop cycle under 55 min ago, an arena attempt under 10 min ago, low
// idle liquidity or balances, the pool's storage buffer under 0.3 NEAR (ALERT), and after the pool upgrade the borrower's Passport cap
// and the floor that keeps a loop repay from counting toward its score. A loop line left open by a run that died is repaid first.
// Env: ECONOMY_DIR (archive and LIVE_OK, default target/economy), CREDIT_DIR (LOCK and MAINTENANCE, default target/credit),
// ECONOMY_BOOK_VAULT or ARENA_BOOK_VAULT (else the strict vault, then the old one, under target/arena and target/credit-run),
// ARENA_KEY_FILE, ARENA_ALLOW_AGENT_KEY, ARENA_AGENT_CREDENTIALS, AIRLOCK_TASK_KEY_FILE as for the arena. The issuer, the borrower and
// the merchant sign through the near CLI's keychain; this script reads none of their keys.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARENA_TASK_PREFIX, INVOICE_YOCTO, probeTask, signedBy } from '../runtime/src/arena/index.ts';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { takeLock } from '../runtime/src/credit/lock.ts';
import { MissingMethod, rpcAccount, rpcKeys, rpcView } from '../runtime/src/credit/rpc.ts';
import { pickVault, vaultCandidates } from '../runtime/src/credit/vaults.ts';
import { ownerTaskBorsh } from '../runtime/src/dsl/index.ts';
import type { OwnerTask } from '../runtime/src/dsl/index.ts';
import { ECONOMY_ACCOUNTS as A, LOOP_TASK_PREFIX, economyStop, loopRequest, nearText, runCycle, stateLines } from '../runtime/src/economy/index.ts';
import type { EconomyIo, EconomyRecord, EconomyState, Held, LineView, Passport } from '../runtime/src/economy/index.ts';
import type { Vault } from '../runtime/src/vault/index.ts';
import { listedOf } from '../web/src/challenge/chainBoard.ts';
import { classifyArenaTx } from './credit-arena.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FASTNEAR_TX = 'https://tx.test.fastnear.com';
const env = process.env;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const big = (v: unknown): bigint => {
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new Error('a pool view answered something unexpected');
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message.slice(0, 200) : 'unknown error');

/** One line of get_pool or get_line, checked field by field. */
export function lineOf(v: unknown): LineView {
  if (!isObj(v) || typeof v['card'] !== 'string' || typeof v['borrower'] !== 'string' || typeof v['fee_bps'] !== 'number' || typeof v['due_ms'] !== 'string' || typeof v['state'] !== 'string') throw new Error('a line view answered something unexpected');
  const state = v['state'];
  if (state !== 'Collecting' && state !== 'Open' && state !== 'Repaid' && state !== 'Defaulted') throw new Error('a line view has an unknown state');
  // a due time is ms since the epoch: far below 2^53
  return { card: v['card'], borrower: v['borrower'], limit: big(v['limit']), returned: big(v['returned']), feeBps: v['fee_bps'], dueMs: +v['due_ms'], collateral: big(v['collateral']), state };
}

/** The held requests of get_pending, as far as the loop reads them. */
export function heldOf(page: unknown): Held[] {
  if (!Array.isArray(page)) throw new Error('get_pending answered something unexpected');
  return page.flatMap((r) => {
    if (!isObj(r) || typeof r['id'] !== 'string' || typeof r['expires_ms'] !== 'string' || !/^[0-9]+$/.test(r['expires_ms'])) throw new Error('get_pending answered something unexpected');
    if (r['state'] !== 'Pending') return [];
    return [{ id: r['id'], taskId: typeof r['task_id'] === 'string' ? r['task_id'] : null, agent: typeof r['agent'] === 'string' ? r['agent'] : null, expiresMs: +r['expires_ms'] }];
  });
}

/** A function call through the near CLI, signed from its keychain; answers the transaction hash. */
function nearCall(contract: string, method: string, args: object, signer: string, depositYocto: bigint, gas = '100 Tgas'): string {
  const r = spawnSync(env['NEAR'] ?? 'near', ['contract', 'call-function', 'as-transaction', contract, method, 'json-args', JSON.stringify(args), 'prepaid-gas', gas, 'attached-deposit', `${depositYocto.toString()} yoctoNEAR`, 'sign-as', signer, 'network-config', 'testnet', 'sign-with-keychain', 'send'], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1];
  if (r.status !== 0 || tx === undefined || /ExecutionError|Failure|panicked/.test(out)) throw new Error(`${method} as ${signer} failed: ${out.slice(-300).replace(/\s+/g, ' ')}`);
  return tx;
}

function readRecords(path: string): EconomyRecord[] {
  if (!existsSync(path)) return [];
  const out: EconomyRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as EconomyRecord;
      if (typeof r === 'object' && r !== null && typeof r.kind === 'string') out.push(r);
    } catch {
      // a torn last line (a killed run) is skipped
    }
  }
  return out;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${String(res.status)}`);
  return (await res.json()) as unknown;
}

export async function liveIo(): Promise<EconomyIo> {
  const { ChainClient } = await import('../runtime/src/chain/near.ts');
  const { loadAgentSigner } = await import('../runtime/src/credit/agent-signer.ts');
  const { expireOnCard } = await import('../runtime/src/arena/writes.ts');
  const { loadVault } = await import('../runtime/src/vault/file.ts');
  const { taskSigner } = await import('../runtime/src/mcp/boot.ts');
  type AgentSigner = Awaited<ReturnType<typeof loadAgentSigner>> extends infer T ? (T extends { signer: infer S } ? S : never) : never;

  const dir = env['ECONOMY_DIR'] ?? join(REPO, 'target', 'economy');
  const creditDir = env['CREDIT_DIR'] ?? join(REPO, 'target', 'credit');
  const archive = join(dir, 'cycles.jsonl');
  const rpc = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
  const vaultFiles = vaultCandidates(REPO, env['ECONOMY_BOOK_VAULT'] ?? env['ARENA_BOOK_VAULT']).filter((f) => existsSync(f));
  const scopedFile = env['ARENA_KEY_FILE'] ?? join(homedir(), '.airlock-arena-key.json');
  const keychainFile = env['ARENA_AGENT_CREDENTIALS'] ?? (vaultFiles[0] === undefined ? null : join(dirname(vaultFiles[0]), 'agent.json'));
  const taskKeyFile = env['AIRLOCK_TASK_KEY_FILE'] ?? join(homedir(), '.airlock-task-key');
  const log = (l: string): void => console.log(l);
  const nowMs = (): number => Date.now();

  let signer: AgentSigner | null = null;
  let vault: Vault | null = null;
  let signTask: ((t: OwnerTask) => Uint8Array) | null = null;

  const pendingRows = async (): Promise<Held[]> => {
    const rows: Held[] = [];
    for (let page = 0; page < 20; page += 1) {
      const raw = await rpcView(rpc, A.card, 'get_pending', { from_index: page * 20, limit: 20 });
      rows.push(...heldOf(raw));
      if (!Array.isArray(raw) || raw.length < 20) break;
    }
    return rows;
  };
  const passport = async (): Promise<Passport> => {
    try {
      const p = await rpcView(rpc, A.pool, 'get_passport', { card: A.card });
      const base = await rpcView(rpc, A.pool, 'get_pool_passport', {});
      if (!isObj(p) || !isObj(base) || typeof p['score'] !== 'number') throw new Error('the Passport views answered something unexpected');
      return { base: big(base['base']), cap: big(p['limit_cap']), score: p['score'] };
    } catch (e) {
      // the pool before the AIR-333 upgrade has no Passport
      if (e instanceof MissingMethod) return null;
      throw e;
    }
  };
  /** The last loop payment and the last arena attempt on the card within the last hour (the stop rules look no further back). */
  const lastTimes = async (): Promise<{ loop: number | null; arena: number | null }> => {
    const since = nowMs() - 70 * 60_000;
    let loop: number | null = null;
    let arena: number | null = null;
    let token: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const body: Record<string, unknown> = { account_id: A.card, is_function_call: true, limit: 100 };
      if (token !== null) body['resume_token'] = token;
      const got = listedOf(await postJson(`${FASTNEAR_TX}/v0/account`, body));
      const recent = got.txs.filter((t) => t.atMs >= since);
      const meta = new Map(recent.map((t) => [t.hash, t.atMs]));
      for (let i = 0; i < recent.length; i += 20) {
        const res = await postJson(`${FASTNEAR_TX}/v0/transactions`, { tx_hashes: recent.slice(i, i + 20).map((t) => t.hash) });
        if (!isObj(res) || !Array.isArray(res['transactions'])) throw new Error('the transaction read answered something unexpected');
        for (const raw of res['transactions'] as unknown[]) {
          const tx = isObj(raw) && isObj(raw['transaction']) ? raw['transaction'] : null;
          const at = tx === null ? undefined : meta.get(String(tx['hash']));
          if (at === undefined) continue;
          const cfg = { card: A.card, publicKey: null, agent: A.agent, merchantKey: `near:${A.merchant}`, invoice: INVOICE_YOCTO };
          if (classifyArenaTx(raw, { ...cfg, taskPrefix: LOOP_TASK_PREFIX }).state !== 'skip') loop = Math.max(loop ?? 0, at);
          if (classifyArenaTx(raw, { ...cfg, taskPrefix: ARENA_TASK_PREFIX }).state !== 'skip') arena = Math.max(arena ?? 0, at);
        }
      }
      token = got.resume;
      // newest first: a page that reaches back past the window ends the walk
      if (token === null || recent.length < got.txs.length) break;
    }
    return { loop, arena };
  };
  const balance = async (id: string): Promise<bigint> => {
    const a = await rpcAccount(rpc, id);
    if (a === null) throw new Error(`the account ${id} does not exist`);
    return a.amount;
  };
  const records = (): EconomyRecord[] => readRecords(archive);

  const preflight = async (): Promise<string | null> => {
    const keys = (await rpcKeys(rpc, A.agent)).map((k) => k.publicKey);
    const got = await loadAgentSigner({ agent: A.agent, keys, scopedFile, keychainFile, env });
    if ('refuse' in got) return got.refuse;
    signer = got.signer;
    log(got.line.replace(/^ARENA SIGNER/, 'ECONOMY SIGNER'));

    const root = await rpcView(rpc, A.card, 'get_book_root', {});
    if (typeof root !== 'string' || !/^[0-9a-f]{64}$/.test(root)) return 'get_book_root answered something unexpected';
    const books = new Map<string, Vault>();
    const found = vaultFiles.map((path) => {
      try {
        const book = loadVault(path);
        books.set(path, book);
        return { path, root: book.root() };
      } catch {
        return { path, root: null };
      }
    });
    const picked = pickVault(found, root);
    if ('refuse' in picked) return picked.refuse;
    vault = books.get(picked.path) ?? null;
    if (vault === null) return 'the book vault file cannot be read';
    if (!vault.has(`near:${A.merchant}`)) return 'the merchant is not in the book vault';
    log(`ECONOMY BOOK ${picked.path} (${vault.entries.every((e) => e.cap === null) ? 'strict' : 'not strict'})`);

    let sign: (t: OwnerTask) => Uint8Array;
    try {
      sign = taskSigner(taskKeyFile);
    } catch (e) {
      return messageOf(e);
    }
    const onChain = await rpcView(rpc, A.card, 'get_task_key', {});
    if (typeof onChain !== 'string') return 'the card holds no task key (get_task_key)';
    const probe = probeTask(nowMs());
    if (!signedBy(onChain, ownerTaskBorsh(probe), sign(probe))) return 'the task key file is not the task key the card holds (AIRLOCK_TASK_KEY_FILE against get_task_key)';
    signTask = sign;

    // the issuer, the borrower and the merchant sign through the near CLI: their keychain entries must be there (only looked for, never read)
    for (const id of [A.issuer, A.borrower, A.merchant]) {
      if (!existsSync(join(homedir(), '.near-credentials', 'testnet', `${id}.json`))) return `the near CLI keychain has no entry for ${id}`;
    }
    return null;
  };

  return {
    nowMs,
    liveOk: () => existsSync(join(dir, 'LIVE_OK')),
    maintenance: () => existsSync(join(creditDir, 'MAINTENANCE')),
    lock: () => takeLock(join(creditDir, 'LOCK'), nowMs()),
    preflight: async () => {
      try {
        return await preflight();
      } catch (e) {
        return messageOf(e);
      }
    },
    state: async (): Promise<EconomyState> => {
      const pool = await rpcView(rpc, A.pool, 'get_pool', {});
      if (!isObj(pool) || !Array.isArray(pool['lines']) || typeof pool['collateral_bps'] !== 'number') throw new Error('get_pool answered something unexpected');
      const account = await rpcAccount(rpc, A.pool);
      if (account === null) throw new Error('the pool account does not exist');
      const policy = await rpcView(rpc, A.card, 'get_policy', {});
      if (!isObj(policy) || typeof policy['paused'] !== 'boolean') throw new Error('get_policy answered something unexpected');
      const times = await lastTimes();
      const archived = records().reduce<number | null>((m, r) => (r.kind === 'cycle' ? Math.max(m ?? 0, r.atMs) : m), null);
      return {
        pool: {
          idle: big(pool['idle']),
          impaired: big(pool['impaired']),
          losses: big(pool['losses']),
          collateralHeld: big(pool['collateral_held']),
          collateralBps: pool['collateral_bps'],
          feesEarned: big(pool['fees_earned']),
          lines: pool['lines'].map(lineOf),
          balance: account.amount,
          storageBytes: account.storage,
        },
        passport: await passport(),
        card: { paused: policy['paused'], pending: await pendingRows() },
        balances: { borrower: await balance(A.borrower), agent: await balance(A.agent), issuer: await balance(A.issuer), merchant: await balance(A.merchant) },
        lastCycleMs: times.loop === null ? archived : Math.max(times.loop, archived ?? 0),
        lastArenaMs: times.arena,
      };
    },
    line: async () => {
      const l = await rpcView(rpc, A.pool, 'get_line', { card: A.card });
      return l === null ? null : lineOf(l);
    },
    expire: async (id) => {
      if (signer === null) throw new Error('the cycle has no signer (the preflight did not run)');
      return expireOnCard(rpc, signer, id);
    },
    postCollateral: async (amount) => nearCall(A.pool, 'post_collateral', { card: A.card }, A.borrower, amount),
    openLine: async (limit, feeBps, dueMs) => nearCall(A.pool, 'open_line', { card: A.card, limit: limit.toString(), fee_bps: feeBps, due_ms: String(dueMs) }, A.issuer, 0n),
    pay: async () => {
      if (signer === null || vault === null || signTask === null) throw new Error('the cycle has no signer (the preflight did not run)');
      const client = new ChainClient({ network: 'testnet', contractId: A.card, agentAccountId: A.agent, signer, rpcUrls: [...DEFAULT_RPC_URLS], vault });
      const { req, task } = loopRequest({ nowMs: await client.latestBlockMs(), suffix: randomBytes(3).toString('hex') });
      const got = await client.submitBatch([req], task, signTask(task));
      const o = got.outcomes[0];
      if (o === undefined) throw new Error('the card answered no outcome');
      return { tx: got.txHash ?? null, outcome: o.outcome, reason: o.reason, pendingId: o.pending_id };
    },
    repay: async (amount) => nearCall(A.pool, 'repay', { card: A.card }, A.borrower, amount),
    recycle: async (amount) => {
      const r = spawnSync(env['NEAR'] ?? 'near', ['tokens', A.merchant, 'send-near', A.borrower, `${nearText(amount)} NEAR`, 'network-config', 'testnet', 'sign-with-keychain', 'send'], { encoding: 'utf8' });
      const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
      const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1];
      if (r.status !== 0 || tx === undefined) throw new Error(`the merchant's transfer failed: ${out.slice(-200).replace(/\s+/g, ' ')}`);
      return tx;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    records,
    append: (r) => {
      mkdirSync(dir, { recursive: true });
      appendFileSync(archive, `${JSON.stringify(r)}\n`);
    },
    log,
  };
}

/** `check`: the preflight and the state, read only; no transaction and no LIVE_OK needed. */
async function check(io: EconomyIo): Promise<number> {
  io.log(`ECONOMY CHECK live cycles are ${io.liveOk() ? 'on' : 'off'} (LIVE_OK), maintenance ${io.maintenance() ? 'on' : 'off'}`);
  const unfit = await io.preflight();
  if (unfit !== null) {
    io.log(`ECONOMY CHECK preflight: ${unfit}`);
    return 1;
  }
  io.log('ECONOMY CHECK preflight passed (agent signer, book vault, task key, keychain entries)');
  const s = await io.state();
  for (const l of stateLines(s)) io.log(`ECONOMY CHECK ${l}`);
  const stop = economyStop(s, io.nowMs());
  io.log(stop === null ? 'ECONOMY CHECK no stop rule holds' : `ECONOMY CHECK a cycle would end with: ${stop}`);
  return 0;
}

export async function main(argv: readonly string[], deps?: { io: EconomyIo }): Promise<number> {
  const mode = argv.length === 0 ? 'live' : argv.length === 1 && (argv[0] === 'dry' || argv[0] === 'check') ? argv[0] : null;
  if (mode === null) {
    console.log('usage: credit-economy.ts [dry|check]');
    return 2;
  }
  const io = deps?.io ?? (await liveIo());
  if (mode === 'check') return check(io);
  const out = await runCycle(io, { dry: mode === 'dry' });
  io.log(out.line);
  return out.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      // the error's name and message only; nothing here holds a key
      console.log(`ECONOMY CYCLE FAILED ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

// AIR-333: the Credit Passport live run on the existing c1108d pool (testnet only, our own accounts, no model call, no new account).
//   pnpm tsx scripts/credit-passport-run.ts             preflight only: reads the chain and the local files, sends nothing
//   pnpm tsx scripts/credit-passport-run.ts --live      preflight, then the upgrade and the Passport run
// The live run, in order (every number read from get_passport, never hardcoded):
//   1. snapshot the pool views; a storage top-up from the issuer only if the pool balance falls short;
//   2. ONE transaction deploys res/airlock_credit_v2.wasm and calls migrate(passport_base = 1 NEAR); the code hash must equal the committed
//      wasm and every snapshotted view must read the same; migrate also sets the MPC signer v1.signer-prod.testnet and domain 3 (AIR-350),
//      read back from get_base_check_config;
//   3. get_passport before; a limit L in (cap, 1.4 x cap] is refused with the cap text; a line of 0.3 NEAR opens inside the cap; the agent
//      pays the booked merchant 0.1 NEAR through the verdict (Allow); the issuer sweeps the rest; the borrower repays on time with the fee;
//   4. get_passport after; L now opens and is closed at once (a sweep of all of it and a repay of 0), so no line stays open.
// Each step prints `ROW <what> | <account> | <tx link>`; the rows go to target/credit-passport/rows.json. The near CLI signs from its
// keychain; the only key file read is the agent's, written for the chain client like scripts/credit-testnet.ts does (mode 0600).
// It STOPS (exit 1) on a missing key, a failed preflight check, an arena LIVE_OK file, or any unexpected chain answer.
// Env: UNPAUSE_CARD=1 lets the issuer unpause the card as the first live step (the c1108d run left it paused, and a paused card refuses
// the agent's payment); without it a paused card is a preflight failure.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChainClient } from '../runtime/src/chain/near.ts';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { signerFromCredentials } from '../runtime/src/chain/signer.ts';
import { ActionRequest, OwnerTask, TASK_TAG, labelsToBits, sha256Hex } from '../runtime/src/dsl/index.ts';
import { taskSigner } from '../runtime/src/mcp/boot.ts';
import { loadVault } from '../runtime/src/vault/file.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = process.env.NEAR ?? 'near';
const RPC = 'https://test.rpc.fastnear.com';
const ONE = 10n ** 24n;
const LIVE = process.argv.includes('--live');
const issuer = 'airlock-credit-c1108d.testnet';
const sub = (n: string): string => `${n}.${issuer}`;
const A = { issuer, pool: sub('pool'), card: sub('card'), borrower: sub('borrower'), merchant: sub('merchant'), agent: sub('agent'), lp1: sub('lp1'), lp2: sub('lp2') };
const OLD_WASM = join(REPO, 'contracts', 'airlock-credit', 'res', 'airlock_credit_c1108d.wasm');
const NEW_WASM = join(REPO, 'contracts', 'airlock-credit', 'res', 'airlock_credit_v2.wasm');
const BASE = ONE; // migrate(passport_base): a borrower at score 500 may take 1 NEAR
// AIR-350: migrate also sets the MPC signer and the foreign transaction domain check_base_payment asks (domain 3 is ForeignTx on testnet)
const MPC_SIGNER = 'v1.signer-prod.testnet';
const FOREIGN_DOMAIN = 3;
const FIRST = (3n * ONE) / 10n; // the line inside the cap
const PAY = ONE / 10n; // the agent's payment: at least 10 percent of FIRST and at least a tenth of BASE (the absolute floor), so the repay counts
const MARGIN = ONE / 5n; // the storage preflight margin
const dir = join(REPO, 'target', 'credit-passport');
mkdirSync(dir, { recursive: true });
const rowsFile = join(dir, 'rows.json');
const rows: Array<{ what: string; account: string; tx: string }> = existsSync(rowsFile) ? (JSON.parse(readFileSync(rowsFile, 'utf8')) as Array<{ what: string; account: string; tx: string }>) : [];
const have = (what: string): boolean => rows.some((r) => r.what === what);

const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
function run(args: string[]): { code: number; out: string } {
  const r = spawnSync(NEAR, args, { encoding: 'utf8' });
  return { code: r.status ?? 1, out: clean(`${r.stdout}${r.stderr}`) };
}
const txOf = (out: string): string | undefined => /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1];
function row(what: string, account: string, tx: string): void {
  if (have(what)) return;
  rows.push({ what, account, tx });
  console.log(`ROW ${what} | ${account} | https://testnet.nearblocks.io/txns/${tx}`);
  writeFileSync(rowsFile, JSON.stringify(rows, null, 2));
}
function stop(why: string): never {
  console.error(`STOP ${why}`);
  process.exit(1);
}
const near = (n: bigint): string => {
  const frac = (n % ONE).toString().padStart(24, '0').replace(/0+$/, '');
  return frac === '' ? `${n / ONE} NEAR` : `${n / ONE}.${frac} NEAR`;
};
/** A function call as `signer`; `ok:false` carries the failure text (an expected refusal is a result, not an exception). */
function call(contract: string, method: string, args: object, signer: string, deposit = '0 NEAR', gas = '100 Tgas'): { ok: boolean; tx: string; out: string } {
  const r = run(['contract', 'call-function', 'as-transaction', contract, method, 'json-args', JSON.stringify(args), 'prepaid-gas', gas, 'attached-deposit', deposit, 'sign-as', signer, 'network-config', 'testnet', 'sign-with-keychain', 'send']);
  const tx = txOf(r.out) ?? '';
  const failed = r.code !== 0 || tx === '' || /ExecutionError|Failure|panicked/.test(r.out);
  return { ok: !failed, tx, out: r.out };
}
function must(what: string, account: string, thunk: () => { ok: boolean; tx: string; out: string }): string {
  if (have(what)) return '';
  const c = thunk();
  if (!c.ok) stop(`${what} failed: ${c.out.slice(-600)}`);
  row(what, account, c.tx);
  return c.tx;
}
const yocto = (n: bigint): string => `${n.toString()} yoctoNEAR`;

async function rpc(method: string, params: object): Promise<Record<string, unknown>> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (j.result === undefined) throw new Error(`${method} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result as number[]).toString('utf8')) as T;
}
async function account(id: string): Promise<{ amount: bigint; storage: bigint; codeHash: string }> {
  const r = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
  return { amount: BigInt(r.amount as string), storage: BigInt(r.storage_usage as number), codeHash: r.code_hash as string };
}
async function blockMs(): Promise<bigint> {
  const r = await rpc('block', { finality: 'final' });
  return BigInt((r.header as { timestamp_nanosec: string }).timestamp_nanosec) / 1_000_000n;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  // little-endian base 58 digits, carried byte by byte (the usual encoder; no float, no number parsing)
  const digits: number[] = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (const b of bytes) {
    if (b !== 0) break;
    out += '1';
  }
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k] ?? 0] ?? '';
  return out;
}
const sha = (file: string): Buffer => createHash('sha256').update(readFileSync(file)).digest();

type Line = { card: string; limit: string; returned: string; fee_bps: number; due_ms: string; collateral: string; state: string };
type PoolView = { assets: string; shares: string; idle: string; lent: string; impaired: string; fees_earned: string; losses: string; collateral_held: string; collateral_bps: number; lines: Line[] };
type Passport = { borrower: string; score: number; reasons: string[]; record: Record<string, unknown>; limit_cap: string };

/** Every view the web and the LPs read, for the before and after comparison. */
async function snapshot(): Promise<string> {
  const views: unknown[] = [];
  views.push(await view(A.pool, 'get_pool'));
  views.push(await view(A.pool, 'get_line', { card: A.card }));
  views.push(await view(A.pool, 'list_lines', {}));
  views.push(await view(A.pool, 'get_card', { card: A.card }));
  for (const who of [A.lp1, A.lp2]) views.push(await view(A.pool, 'get_lp', { account: who }));
  for (const who of [A.lp1, A.lp2, A.borrower, A.issuer, A.card]) views.push(await view(A.pool, 'get_unclaimed', { account: who }));
  return JSON.stringify(views);
}

function liveOkFiles(): string[] {
  const list = process.env.ARENA_LIVE_OK ?? [join(REPO, 'target', 'arena', 'LIVE_OK'), join(homedir(), 'apps', 'airlock', 'target', 'arena', 'LIVE_OK'), join(homedir(), 'apps', 'airlock-lane1', 'target', 'arena', 'LIVE_OK')].join(':');
  return list.split(':').filter((p) => p !== '' && existsSync(p));
}

async function preflight(): Promise<{ topUp: bigint; upgraded: boolean }> {
  let failed = false;
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
    if (!ok) failed = true;
  };
  // keys
  for (const id of [A.pool, A.issuer, A.borrower, A.agent]) check(existsSync(join(homedir(), '.near-credentials', 'testnet', `${id}.json`)), `the full-access key of ${id} is in ~/.near-credentials/testnet`);
  // the arena handshake
  const ok = liveOkFiles();
  check(ok.length === 0, `no arena LIVE_OK file (${ok.length === 0 ? 'none' : ok.join(', ')})`);
  // the bytes
  const oldHash = base58(sha(OLD_WASM));
  const newHash = base58(sha(NEW_WASM));
  const pool = await account(A.pool);
  const upgraded = pool.codeHash === newHash;
  check(pool.codeHash === oldHash || upgraded, `the pool runs the c1108d wasm (${oldHash}) or already the new one (${newHash}): on chain ${pool.codeHash}`);
  const built = join(process.env.CARGO_TARGET_DIR ?? join(homedir(), '.cache', 'airlock-target', 'airlock-lane2'), 'near', 'airlock_credit.wasm');
  check(existsSync(built) && sha(built).equals(sha(NEW_WASM)), `res/airlock_credit_v2.wasm is the wasm the sandbox rehearsal ran (${built})`);
  // the card and the line
  const p = await view<PoolView>(A.pool, 'get_pool');
  const open = p.lines.filter((l) => l.state === 'Open');
  check(open.length === 0 && p.impaired === '0' && p.lent === '0', `no line is open or past due (lent ${p.lent}, impaired ${p.impaired})`);
  check(p.losses === '0', `no unrecovered loss (losses ${p.losses})`);
  const policy = await view<{ paused: boolean }>(A.card, 'get_policy');
  const unpause = process.env.UNPAUSE_CARD === '1';
  check(!policy.paused || unpause, `the card is not paused (paused ${policy.paused}${policy.paused && unpause ? ', UNPAUSE_CARD=1: the issuer unpauses it first' : ''})`);
  const pending = await view<unknown[]>(A.card, 'get_pending', {});
  check(pending.length === 0, `no escalation is pending on the card (${pending.length})`);
  // the files the agent's payment needs
  const vaultFile = join(REPO, 'target', 'credit-run', 'book.vault.json');
  check(existsSync(vaultFile), `the c1108d book vault is at ${vaultFile}`);
  const taskKey = process.env.AIRLOCK_TASK_KEY_FILE ?? join(homedir(), '.airlock-task-key');
  check(existsSync(taskKey), `the task key is at ${taskKey}`);
  // storage: (new wasm + new state) x 1e19 + LP assets + unclaimed + 0.2 NEAR
  let unclaimed = 0n;
  for (const who of [A.lp1, A.lp2, A.borrower, A.issuer, A.card]) unclaimed += BigInt(await view<string>(A.pool, 'get_unclaimed', { account: who }));
  const oldBytes = BigInt(readFileSync(OLD_WASM).length);
  const newBytes = BigInt(readFileSync(NEW_WASM).length);
  const stateBytes = upgraded ? pool.storage - newBytes : pool.storage - oldBytes;
  const growth = 2_000n; // the Pool fields and one backfilled record (about 200 bytes), with room for the run's own record writes
  const need = (newBytes + stateBytes + growth) * 10n ** 19n + BigInt(p.idle) + BigInt(p.collateral_held) + unclaimed + MARGIN;
  const topUp = pool.amount >= need ? 0n : need - pool.amount + ONE / 20n;
  console.log(`STORAGE pool balance ${near(pool.amount)}; need ${near(need)} = (wasm ${newBytes} + state ${stateBytes} + growth ${growth} bytes) x 1e19 + idle ${near(BigInt(p.idle))} + collateral ${near(BigInt(p.collateral_held))} + unclaimed ${near(unclaimed)} + margin ${near(MARGIN)}; top-up ${near(topUp)}`);
  // the issuer pays the top-up and gas; the borrower pays both collaterals, the repay and gas
  const iss = await account(A.issuer);
  check(iss.amount >= topUp + (ONE * 3n) / 10n, `the issuer holds ${near(iss.amount)}: the top-up and 0.3 NEAR of gas`);
  const bor = await account(A.borrower);
  const col = (l: bigint): bigint => (l * BigInt(p.collateral_bps) + 9_999n) / 10_000n;
  const borrowerNeed = col(FIRST) + col((BASE * 7n) / 10n) + PAY + PAY / 10n + (ONE * 3n) / 10n;
  check(bor.amount >= borrowerNeed, `the borrower holds ${near(bor.amount)}: both collaterals, the repay and gas (${near(borrowerNeed)})`);
  const agent = await account(A.agent);
  check(agent.amount >= (ONE * 3n) / 10n, `the agent holds ${near(agent.amount)} for the payment's gas`);
  const card = await account(A.card);
  console.log(`card balance ${near(card.amount)}`);
  if (failed) stop('a preflight check failed');
  console.log('PREFLIGHT OK');
  return { topUp, upgraded };
}

async function passport(): Promise<Passport> {
  const pp = await view<Passport | null>(A.pool, 'get_passport', { card: A.card });
  if (pp === null) stop('get_passport answered null for the card');
  console.log(`PASSPORT score ${pp.score} cap ${near(BigInt(pp.limit_cap))} reasons ${JSON.stringify(pp.reasons)} record ${JSON.stringify(pp.record)}`);
  return pp;
}

/** Waits until the pool's view of the card's line satisfies `ok` (callbacks land a block or two after the call). */
async function lineUntil(ok: (l: Line) => boolean, what: string): Promise<Line> {
  for (let i = 0; i < 20; i++) {
    const l = await view<Line | null>(A.pool, 'get_line', { card: A.card });
    if (l !== null && ok(l)) return l;
    await sleep(2_000);
  }
  stop(`the line did not reach: ${what}`);
}

async function main(): Promise<void> {
  const { topUp, upgraded } = await preflight();
  if (!LIVE) {
    console.log('preflight only: run with --live to upgrade and run the Passport steps');
    return;
  }

  // 1. snapshot and storage
  if (!upgraded) {
    const before = await snapshot();
    writeFileSync(join(dir, 'snapshot-before.json'), before);
    if (topUp > 0n) {
      const r = run(['tokens', A.issuer, 'send-near', A.pool, yocto(topUp), 'network-config', 'testnet', 'sign-with-keychain', 'send']);
      const tx = txOf(r.out);
      if (r.code !== 0 || tx === undefined) stop(`the storage top-up failed: ${r.out.slice(-300)}`);
      row(`the issuer tops the pool up by ${near(topUp)} for the upgrade's storage`, A.pool, tx);
      await sleep(3_000);
    }
    const views = await view<PoolView>(A.pool, 'get_pool');
    if (views.lines.some((l) => l.state === 'Open')) stop('a line opened after the preflight');

    // 2. the upgrade: one transaction, DeployContract then migrate
    const r = run(['contract', 'deploy', A.pool, 'use-file', NEW_WASM, 'with-init-call', 'migrate', 'json-args', JSON.stringify({ passport_base: BASE.toString(), mpc_signer: MPC_SIGNER, foreign_domain_id: FOREIGN_DOMAIN }), 'prepaid-gas', '100 Tgas', 'attached-deposit', '0 NEAR', 'network-config', 'testnet', 'sign-with-keychain', 'send']);
    const tx = txOf(r.out);
    if (r.code !== 0 || tx === undefined || /ExecutionError|Failure|panicked/.test(r.out)) stop(`the upgrade failed: ${r.out.slice(-600)}`);
    row('upgrade: one transaction deploys res/airlock_credit_v2.wasm and calls migrate(passport_base = 1 NEAR)', A.pool, tx);
    await sleep(3_000);
    const after = await snapshot();
    writeFileSync(join(dir, 'snapshot-after.json'), after);
    if (after !== before) stop('a pool view changed across the upgrade (see target/credit-passport/snapshot-*.json)');
    console.log('every pool view reads the same after the upgrade');
  }
  const hash = (await account(A.pool)).codeHash;
  if (hash !== base58(sha(NEW_WASM))) stop(`the pool's code hash ${hash} is not the committed wasm`);
  console.log(`code hash ${hash} equals res/airlock_credit_v2.wasm`);
  const pv = await view<{ base: string; version: number }>(A.pool, 'get_pool_passport');
  if (pv.base !== BASE.toString() || pv.version !== 2) stop(`get_pool_passport ${JSON.stringify(pv)}`);
  const bc = await view<{ mpc_signer: string; domain_id: number }>(A.pool, 'get_base_check_config');
  if (bc.mpc_signer !== MPC_SIGNER || bc.domain_id !== FOREIGN_DOMAIN) stop(`get_base_check_config ${JSON.stringify(bc)}`);

  if (process.env.UNPAUSE_CARD === '1') {
    const policy = await view<{ paused: boolean }>(A.card, 'get_policy');
    if (policy.paused) must('the issuer unpauses the card (the c1108d run left it paused)', A.card, () => call(A.card, 'pause', { paused: false }, A.issuer, '1 yoctoNEAR', '30 Tgas'));
  }

  // 3. before: refused above the cap, a line inside it, a payment, a sweep, an on-time repay
  const pool = await view<PoolView>(A.pool, 'get_pool');
  const col = (l: bigint): bigint => (l * BigInt(pool.collateral_bps) + 9_999n) / 10_000n;
  const before = await passport();
  if (before.score !== 200) stop(`the backfilled score is ${before.score}, not the expected 200: nothing is opened`);
  const capBefore = BigInt(before.limit_cap);
  const cent = ONE / 100n;
  const L = (((capBefore * 5n) / 4n + cent - 1n) / cent) * cent; // 1.25 x cap, rounded up to 0.01 NEAR
  if (!(L > capBefore && L * 5n <= capBefore * 7n)) stop(`L ${near(L)} is not in (cap, 1.4 x cap]`);
  console.log(`L = ${near(L)}, in (${near(capBefore)}, ${near((capBefore * 7n) / 5n)}]`);
  if (FIRST > capBefore) stop(`the first line ${near(FIRST)} is above the cap ${near(capBefore)}`);

  const now = await blockMs();
  const due = (now + 86_400_000n).toString();
  const refusedWhat = `open_line(${near(L)}) above the Passport cap: refused on chain`;
  if (!have(refusedWhat)) {
    const r = call(A.pool, 'open_line', { card: A.card, limit: L.toString(), fee_bps: 1000, due_ms: due }, A.issuer);
    const text = `the limit is above this card's Passport cap of ${near(capBefore).replace(' NEAR', '')} NEAR (score ${before.score})`;
    if (r.ok || !r.out.includes(text)) stop(`the over-cap line was not refused with "${text}": ${r.out.slice(-500)}`);
    row(`${refusedWhat} ("${text}")`, A.pool, r.tx);
  }
  must(`the borrower posts ${near(col(FIRST))} of collateral`, A.pool, () => call(A.pool, 'post_collateral', { card: A.card }, A.borrower, yocto(col(FIRST))));
  must(`open a line of ${near(FIRST)} inside the cap, fee 10 percent, due in 1 day`, A.pool, () => call(A.pool, 'open_line', { card: A.card, limit: FIRST.toString(), fee_bps: 1000, due_ms: due }, A.issuer));
  await lineUntil((l) => l.state === 'Open' && l.limit === FIRST.toString(), 'the first line is open');

  const payWhat = `the agent pays the booked merchant ${near(PAY)} through the verdict: Allow`;
  if (!have(payWhat)) {
    const creds = join(dir, 'agent.json');
    const legacy = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${A.agent}.json`), 'utf8')) as { public_key: string; private_key: string };
    writeFileSync(creds, JSON.stringify({ account_id: A.agent, public_key: legacy.public_key, private_key: legacy.private_key }), { mode: 0o600 });
    const sign = taskSigner(process.env.AIRLOCK_TASK_KEY_FILE ?? join(homedir(), '.airlock-task-key'));
    const vault = loadVault(join(REPO, 'target', 'credit-run', 'book.vault.json'));
    const client = new ChainClient({ network: 'testnet', contractId: A.card, agentAccountId: A.agent, signer: signerFromCredentials(creds, A.agent), rpcUrls: [...DEFAULT_RPC_URLS], vault });
    const ms = await client.latestBlockMs();
    const payee = `near:${A.merchant}`;
    const t = OwnerTask.parse({ tag: TASK_TAG, task_id: `passport-pay-${ms}`, contract_id: A.card, agent_id: A.agent, plan_sha256: sha256Hex(new TextEncoder().encode('credit:passport-pay')), instruction_sha256_salted: sha256Hex(new TextEncoder().encode('salt:passport-pay')), issued_ms: ms - 1000, expires_ms: ms + 20 * 60_000, max_actions: 1, bounds: [{ payee_key: payee, max_total: PAY.toString() }] });
    const req = ActionRequest.parse({ task_id: t.task_id, action_index: 0, asset: 'near', payee, amount: PAY.toString(), labels: { recipient: labelsToBits(['Book']), amount: labelsToBits(['Owner']), pc: labelsToBits(['Owner']) }, evm: null, hints: { plan_hash: t.plan_sha256, trace_digest: '0'.repeat(64) } });
    const paid = await client.submitBatch([req], t, sign(t));
    if (paid.outcomes[0]?.outcome !== 'allowed') stop(`the merchant payment was not allowed: ${JSON.stringify(paid.outcomes)}`);
    row(payWhat, A.card, paid.txHash ?? '');
    await sleep(4_000);
  }
  const sweepFirst = FIRST - PAY;
  must(`the issuer sweeps the unspent ${near(sweepFirst)} back to the pool`, A.card, () => call(A.card, 'sweep', { amount: sweepFirst.toString() }, A.issuer, '1 yoctoNEAR', '100 Tgas'));
  const first = await lineUntil((l) => l.state === 'Repaid' || BigInt(l.returned) === sweepFirst, 'the sweep is credited');
  if (first.state === 'Open') {
    const outstanding = BigInt(first.limit) - BigInt(first.returned);
    const fee = (outstanding * BigInt(first.fee_bps) + 9_999n) / 10_000n;
    if (outstanding * 10n < BigInt(first.limit)) stop(`the card kept ${near(outstanding)}, under 10 percent of the limit: the repay would not count`);
    if (outstanding < BASE / 10n) stop(`the card kept ${near(outstanding)}, under a tenth of the cap base: the repay would not count`);
    if (first.fee_bps < 100) stop('the line charges under 1 percent: the repay would not count');
    if (BigInt(await blockMs()) > BigInt(first.due_ms)) stop('the line is past due: the repay would be late');
    must(`the borrower repays ${near(outstanding + fee)} on time (${near(outstanding)} kept plus the 10 percent fee)`, A.pool, () => call(A.pool, 'repay', { card: A.card }, A.borrower, yocto(outstanding + fee)));
  }
  await lineUntil((l) => l.state === 'Repaid', 'the first line is repaid');

  // 4. after: the score and the cap rose; L opens and is closed at once
  const after = await passport();
  const capAfter = BigInt(after.limit_cap);
  if (after.score <= before.score || capAfter < L) stop(`the score went ${before.score} to ${after.score}, cap ${near(capAfter)} below L ${near(L)}`);
  console.log(`score ${before.score} to ${after.score} (expected 280), cap ${near(capBefore)} to ${near(capAfter)} (expected 0.56 NEAR)`);
  must(`the borrower posts ${near(col(L))} of collateral for the larger line`, A.pool, () => call(A.pool, 'post_collateral', { card: A.card }, A.borrower, yocto(col(L))));
  const due2 = ((await blockMs()) + 86_400_000n).toString();
  must(`open_line(${near(L)}), refused before, now opens under the raised cap`, A.pool, () => call(A.pool, 'open_line', { card: A.card, limit: L.toString(), fee_bps: 1000, due_ms: due2 }, A.issuer));
  await lineUntil((l) => l.state === 'Open' && l.limit === L.toString(), 'the larger line is open');
  must(`the issuer sweeps all ${near(L)} back at once`, A.card, () => call(A.card, 'sweep', { amount: L.toString() }, A.issuer, '1 yoctoNEAR', '100 Tgas'));
  await lineUntil((l) => BigInt(l.returned) === L, 'the larger line is swept');
  must('the borrower closes the larger line (nothing kept, nothing owed; an undrawn close counts as neither on time nor late)', A.pool, () => call(A.pool, 'repay', { card: A.card }, A.borrower, '0 NEAR'));
  await lineUntil((l) => l.state === 'Repaid', 'the larger line is closed');

  const fin = await view<PoolView>(A.pool, 'get_pool');
  if (fin.lines.some((l) => l.state === 'Open') || fin.lent !== '0') stop(`a line is still open: ${JSON.stringify(fin.lines)}`);
  const last = await passport();
  console.log(`final pool assets ${fin.assets} shares ${fin.shares} fees ${fin.fees_earned} losses ${fin.losses}; no line open`);
  console.log(`PASSPORT LIVE OK score ${before.score} to ${last.score}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

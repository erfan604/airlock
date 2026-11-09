// AIR-330: the AIRLOCK Credit run on NEAR testnet, between our own accounts, with no model call. Fresh accounts, named
// airlock-credit-<tag>.testnet for the issuer and its subaccounts (pool, card, borrower, merchant, agent, two LPs); funders are
// faucet accounts that only send their NEAR to the issuer. Every step prints `ROW <what> | <account> | <tx>` and the rows go to
// target/credit-run/rows.json for docs/EVIDENCE.md. The near CLI signs from its keychain; no key is read or printed here except the agent's
// credentials file, written for the chain client (mode 0600).
//   pnpm tsx scripts/credit-testnet.ts <tag>          the whole run (accounts, deploys, line, payments, sweep, repay, withdraw, default)
// Testnet only; the faucet used is the near CLI's sponsor-by-faucet-service (no CAPTCHA, no sign-in).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChainClient } from '../runtime/src/chain/near.ts';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { signerFromCredentials } from '../runtime/src/chain/signer.ts';
import { ActionRequest, OwnerTask, TASK_TAG, labelsToBits, sha256Hex } from '../runtime/src/dsl/index.ts';
import { taskSigner } from '../runtime/src/mcp/boot.ts';
import { loadVault } from '../runtime/src/vault/file.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = process.env.NEAR ?? 'near';
const ONE = 10n ** 24n;
const tag = process.argv[2];
if (tag === undefined || !/^[a-z0-9]{3,12}$/.test(tag)) throw new Error('usage: credit-testnet.ts <tag, 3 to 12 lowercase letters or digits>');
const issuer = `airlock-credit-${tag}.testnet`;
const sub = (n: string): string => `${n}.${issuer}`;
const A = { issuer, pool: sub('pool'), card: sub('card'), borrower: sub('borrower'), merchant: sub('merchant'), agent: sub('agent'), lp1: sub('lp1'), lp2: sub('lp2') };
const dir = join(REPO, 'target', 'credit-run');
mkdirSync(dir, { recursive: true });
const rows: Array<{ what: string; account: string; tx: string }> = [];

const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
function run(args: string[], input?: string): { code: number; out: string } {
  const r = spawnSync(NEAR, args, { encoding: 'utf8', ...(input === undefined ? {} : { input }) });
  return { code: r.status ?? 1, out: clean(`${r.stdout}${r.stderr}`) };
}
const txOf = (out: string): string | undefined => /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1];
function row(what: string, account: string, tx: string): void {
  rows.push({ what, account, tx });
  console.log(`ROW ${what} | ${account} | https://testnet.nearblocks.io/txns/${tx}`);
  writeFileSync(join(dir, 'rows.json'), JSON.stringify(rows, null, 2));
}
const near = (n: bigint): string => `${n / ONE}.${(n % ONE).toString().padStart(24, '0').slice(0, 4)} NEAR`;

async function exists(id: string): Promise<boolean> {
  const r = await fetch('https://test.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }) });
  const j = (await r.json()) as { result?: unknown };
  return j.result !== undefined;
}
async function waitFor(id: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await exists(id)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${id} did not appear`);
}

/** A function call as `signer`; `ok:false` carries the failure text (an expected refusal is a result, not an exception). */
function call(contract: string, method: string, args: object, signer: string, deposit = '0 NEAR', gas = '100 Tgas'): { ok: boolean; tx: string; out: string } {
  const r = run(['contract', 'call-function', 'as-transaction', contract, method, 'json-args', JSON.stringify(args), 'prepaid-gas', gas, 'attached-deposit', deposit, 'sign-as', signer, 'network-config', 'testnet', 'sign-with-keychain', 'send']);
  const tx = txOf(r.out) ?? '';
  const failed = r.code !== 0 || tx === '' || /ExecutionError|Failure|panicked/.test(r.out);
  return { ok: !failed, tx, out: r.out };
}
function must(what: string, account: string, c: { ok: boolean; tx: string; out: string }): string {
  if (!c.ok) throw new Error(`${what} failed: ${c.out.slice(-600)}`);
  row(what, account, c.tx);
  return c.tx;
}
function view(contract: string, method: string, args: object = {}): unknown {
  const r = run(['contract', 'call-function', 'as-read-only', contract, method, 'json-args', JSON.stringify(args), 'network-config', 'testnet', 'now']);
  if (r.code !== 0) throw new Error(`view ${method} failed: ${r.out.slice(-300)}`);
  const text = r.out.split('\n').filter((l) => !/^\s*$/.test(l) && !l.includes('Here is your console command') && !/near.*contract call-function/.test(l)).join('\n');
  try {
    return JSON.parse(text);
  } catch {
    const m = /(\{[\s\S]*\}|\[[\s\S]*\]|"[^"]*"|null|true|false|\d+)\s*$/.exec(text);
    return m === null ? text : JSON.parse(m[1] as string);
  }
}
async function balance(id: string): Promise<bigint> {
  const r = await fetch('https://test.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }) });
  return BigInt(((await r.json()) as { result: { amount: string } }).result.amount);
}

function faucet(id: string): void {
  if (run(['account', 'create-account', 'sponsor-by-faucet-service', id, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', 'testnet', 'create']).code !== 0) throw new Error(`faucet could not create ${id}`);
}
function createSub(id: string, amount: string): string {
  const r = run(['account', 'create-account', 'fund-myself', id, amount, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'sign-as', issuer, 'network-config', 'testnet', 'sign-with-keychain', 'send']);
  const tx = txOf(r.out);
  if (r.code !== 0 || tx === undefined) throw new Error(`could not create ${id}: ${r.out.slice(-300)}`);
  return tx;
}

async function main(): Promise<void> {
  // 0. funds: the issuer and five funders from the faucet (10 NEAR each); the funders send all but 1 NEAR to the issuer
  console.log(`accounts: ${JSON.stringify(A)}`);
  const funders = [1, 2, 3, 4, 5].map((i) => `airlock-credit-${tag}-f${i}.testnet`);
  for (const id of [issuer, ...funders]) {
    if (!(await exists(id))) {
      faucet(id);
      await waitFor(id);
    }
  }
  for (const f of funders) {
    const bal = await balance(f);
    if (bal > 2n * ONE) {
      const r = run(['tokens', f, 'send-near', issuer, near(bal - 1n * ONE), 'network-config', 'testnet', 'sign-with-keychain', 'send']);
      if (r.code !== 0) throw new Error(`funding from ${f} failed: ${r.out.slice(-200)}`);
    }
  }
  console.log(`issuer balance ${near(await balance(issuer))}`);

  // 1. subaccounts; the pool and the card are funded for their wasm (about 1 NEAR per 100 KB, plus margin)
  const policyWasm = join(REPO, 'contracts', 'airlock-policy', 'res', 'airlock_policy.wasm');
  const creditWasm = join(REPO, 'contracts', 'airlock-credit', 'res', 'airlock_credit.wasm');
  for (const p of [policyWasm, creditWasm]) if (!existsSync(p)) throw new Error(`${p} is missing: build and copy the release wasm first`);
  const need = (p: string, margin: bigint): string => near(BigInt(readFileSync(p).length) * 10n ** 19n + margin);
  const plan: Array<[string, string]> = [
    [A.pool, need(creditWasm, 2n * ONE)],
    [A.card, need(policyWasm, 3n * ONE)],
    [A.borrower, '4 NEAR'],
    [A.merchant, '0.1 NEAR'],
    [A.agent, '1 NEAR'],
    [A.lp1, '5 NEAR'],
    [A.lp2, '5 NEAR'],
  ];
  for (const [id, amount] of plan) {
    if (await exists(id)) continue;
    row(`create ${id.split('.')[0]}`, id, createSub(id, amount));
    await waitFor(id);
  }

  // 2. deploy the pool (owner: the issuer) and the card (owner: the issuer, approver: the borrower, sponsor: the pool)
  must('deploy the pool', A.pool, deployWith(A.pool, creditWasm, { owner_id: issuer }, A.pool));
  must('deploy the card policy', A.card, deployWith(A.card, policyWasm, { owner_id: issuer, mpc_contract_id: 'v1.signer-prod.testnet', requires_tee: false, attestation_expiration_time_ms: '1209600000', approver: A.borrower, sponsor: A.pool }, A.card));
  const roles = view(A.card, 'get_roles') as { owner_id: string; approver: string; sponsor: string };
  console.log(`roles ${JSON.stringify(roles)}`);

  // 3. configure the card with the quickstart policy (the merchant is a listed alias) through the bootstrap script
  const accountsFile = join(dir, 'accounts.json');
  writeFileSync(accountsFile, JSON.stringify({ owner: issuer, policy: A.card, agent: A.agent, acme: A.merchant }, null, 2));
  const vaultFile = join(dir, 'book.vault.json');
  const boot = spawnSync('bash', [join(REPO, 'scripts', 'bootstrap-policy.sh')], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, AIRLOCK_ACCOUNTS_FILE: accountsFile, AIRLOCK_POLICY_FILE: join(REPO, 'fixtures', 'quickstart', 'policy.json'), AIRLOCK_BOOK_VAULT: vaultFile },
  });
  const bootOut = clean(boot.stdout + boot.stderr);
  for (const line of bootOut.split('\n')) if (/^(TX |POLICY |DRIFT|FAILED|REFUSED)/.test(line)) console.log(line);
  if (boot.status !== 0 || !bootOut.includes('POLICY MATCHES')) throw new Error('bootstrap failed');
  const bootTxs = [...bootOut.matchAll(/^TX (\S+) (\S+)/gm)].map((m) => ({ method: m[1] as string, tx: m[2] as string }));
  const bk = bootTxs.find((t) => t.method === 'book_set_root');
  const tk = bootTxs.find((t) => t.method === 'set_task_key');
  if (bk) row('card bootstrap: book_set_root (the merchant, private)', A.card, bk.tx);
  if (tk) row('card bootstrap: set_task_key (the last of the owner calls; POLICY MATCHES after)', A.card, tk.tx);

  // 4. the pool: LPs deposit, the card is registered (the pool reads its roles on chain), collateral, the line
  must('LP1 deposits 3 NEAR', A.lp1, call(A.pool, 'deposit', {}, A.lp1, '3 NEAR'));
  must('LP2 deposits 2 NEAR', A.lp2, call(A.pool, 'deposit', {}, A.lp2, '2 NEAR'));
  must('register the card (roles verified on chain)', A.pool, call(A.pool, 'register_card', { card: A.card, borrower: A.borrower }, issuer, '0 NEAR', '120 Tgas'));
  await sleep(6000);
  if (view(A.pool, 'get_card', { card: A.card }) !== A.borrower) throw new Error('the card was not registered');
  must('borrower posts 0.3 NEAR of collateral', A.pool, call(A.pool, 'post_collateral', { card: A.card }, A.borrower, '0.3 NEAR'));
  const now = await blockMs();
  must('open a line of 1 NEAR, fee 10 percent, 30 days', A.pool, call(A.pool, 'open_line', { card: A.card, limit: ONE.toString(), fee_bps: 1000, due_ms: String(now + 30 * 86_400_000) }, issuer));
  await sleep(4000);

  // 5. the agent: a merchant payment allowed, an injected payee held, the borrower paying himself held
  const creds = join(dir, 'agent.json');
  const legacy = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${A.agent}.json`), 'utf8')) as { public_key: string; private_key: string };
  writeFileSync(creds, JSON.stringify({ account_id: A.agent, public_key: legacy.public_key, private_key: legacy.private_key }), { mode: 0o600 });
  const taskKeyFile = process.env.AIRLOCK_TASK_KEY_FILE ?? join(homedir(), '.airlock-task-key');
  const sign = taskSigner(taskKeyFile);
  const vault = loadVault(vaultFile);
  const client = new ChainClient({ network: 'testnet', contractId: A.card, agentAccountId: A.agent, signer: signerFromCredentials(creds, A.agent), rpcUrls: [...DEFAULT_RPC_URLS], vault });
  const bare = new ChainClient({ network: 'testnet', contractId: A.card, agentAccountId: A.agent, signer: signerFromCredentials(creds, A.agent), rpcUrls: [...DEFAULT_RPC_URLS] });
  const merchantKey = `near:${A.merchant}`;
  const mk = async (id: string, payee: string, amount: bigint, recipient: string[], c: ChainClient) => {
    const ms = await bare.latestBlockMs();
    const t = OwnerTask.parse({ tag: TASK_TAG, task_id: `${id}-${ms}`, contract_id: A.card, agent_id: A.agent, plan_sha256: sha256Hex(new TextEncoder().encode(`credit:${id}`)), instruction_sha256_salted: sha256Hex(new TextEncoder().encode(`salt:${id}`)), issued_ms: ms - 1000, expires_ms: ms + 20 * 60_000, max_actions: 2, bounds: [{ payee_key: payee, max_total: (2n * ONE).toString() }] });
    const req = ActionRequest.parse({ task_id: t.task_id, action_index: 0, asset: 'near', payee, amount: amount.toString(), labels: { recipient: labelsToBits(recipient), amount: labelsToBits(['Owner']), pc: labelsToBits(['Owner']) }, evm: null, hints: { plan_hash: t.plan_sha256, trace_digest: '0'.repeat(64) } });
    return c.submitBatch([req], t, sign(t));
  };
  const before = await balance(A.merchant);
  const paid = await mk('pay', merchantKey, ONE / 2n, ['Book'], client);
  if (paid.outcomes[0]?.outcome !== 'allowed') throw new Error(`the merchant payment was not allowed: ${JSON.stringify(paid.outcomes)}`);
  row('the agent pays the merchant 0.5 NEAR through the verdict: Allow', A.card, paid.txHash ?? '');
  console.log(`merchant received ${near((await balance(A.merchant)) - before)}`);
  const attacker = `near:attacker.${issuer}`;
  const inj = await mk('inject', attacker, ONE / 2n, ['Untrusted:email'], client);
  const inj0 = inj.outcomes[0];
  if (inj0?.outcome !== 'escalated') throw new Error('the injected payee was not held');
  row(`an injected payee from untrusted text is held (${inj0.reason})`, A.card, inj.txHash ?? '');
  const himself = await mk('self', `near:${A.borrower}`, ONE / 2n, ['Untrusted:email'], client);
  const self0 = himself.outcomes[0];
  if (self0?.outcome !== 'escalated' || self0.pending_id === null) throw new Error('the self payment was not held');
  row('the borrower asks his own account to be paid through his agent: held as a new payee', A.card, himself.txHash ?? '');
  const sv = await bare.getRequest(self0.pending_id);
  if (sv === null || sv.display === null) throw new Error('no card for the self payment');
  const refused = call(A.card, 'approve', { id: self0.pending_id, to: sv.payee, asset: sv.display.asset_symbol, amount: sv.display.amount_decimal, why: sv.reason, book: sv.book_status }, A.borrower, '1 yoctoNEAR', '65 Tgas');
  if (refused.ok || !refused.out.includes('not in the book')) throw new Error(`the approver was not refused: ${refused.out.slice(-400)}`);
  console.log('the borrower approve was refused: not in the book');
  rows.push({ what: 'the borrower taps approve on the self payment: refused (approve refused for the approver, the payee is not in the book); nothing moves', account: A.card, tx: refused.tx });
  console.log(`ROW borrower self approve refused | ${A.card} | https://testnet.nearblocks.io/txns/${refused.tx}`);
  writeFileSync(join(dir, 'rows.json'), JSON.stringify(rows, null, 2));
  must('the borrower rejects the self payment', A.card, call(A.card, 'reject', { id: self0.pending_id }, A.borrower, '1 yoctoNEAR', '30 Tgas'));
  if (inj0.pending_id !== null) must('the borrower rejects the injected payee', A.card, call(A.card, 'reject', { id: inj0.pending_id }, A.borrower, '1 yoctoNEAR', '30 Tgas'));

  // 6. sweep the unspent 0.5 NEAR back to the pool, then repay what the card kept with the fee
  must('the issuer sweeps 0.5 NEAR from the card to the pool (credited to the line)', A.card, call(A.card, 'sweep', { amount: (ONE / 2n).toString() }, issuer, '1 yoctoNEAR', '100 Tgas'));
  await sleep(6000);
  const line = view(A.pool, 'get_line', { card: A.card }) as { returned: string; limit: string };
  console.log(`line ${JSON.stringify(line)}`);
  must('the borrower repays 0.55 NEAR (0.5 kept plus the 10 percent fee), 0.1 NEAR over is refunded, collateral returns', A.pool, call(A.pool, 'repay', { card: A.card }, A.borrower, '0.65 NEAR', '100 Tgas'));
  await sleep(4000);
  const afterRepay = view(A.pool, 'get_pool') as { assets: string; fees_earned: string; share_price: string };
  console.log(`pool after repay ${JSON.stringify({ assets: afterRepay.assets, fees: afterRepay.fees_earned, price: afterRepay.share_price })}`);

  // 7. LP1 withdraws everything: more than the 3 NEAR deposited
  const lp1 = view(A.pool, 'get_lp', { account: A.lp1 }) as { shares: string; value: string };
  const wd = call(A.pool, 'withdraw', { shares: lp1.shares }, A.lp1, '0 NEAR', '100 Tgas');
  must(`LP1 withdraws all its shares, worth ${near(BigInt(lp1.value))} for 3 NEAR deposited`, A.lp1, wd);
  if (BigInt(lp1.value) <= 3n * ONE) throw new Error('the LP did not earn');

  // 8. the default case: a second line on the same card, not repaid
  must('borrower posts 0.3 NEAR of collateral again', A.pool, call(A.pool, 'post_collateral', { card: A.card }, A.borrower, '0.3 NEAR'));
  const due = (await blockMs()) + 40_000;
  must('open a second line of 1 NEAR due in 40 seconds', A.pool, call(A.pool, 'open_line', { card: A.card, limit: ONE.toString(), fee_bps: 1000, due_ms: String(due) }, issuer));
  await sleep(52_000);
  const overdue = view(A.pool, 'get_pool') as { assets: string; impaired: string };
  console.log(`overdue, before default: assets ${overdue.assets} impaired ${overdue.impaired}`);
  must('anyone calls default after the due date: collateral seized, the rest booked as a loss', A.pool, call(A.pool, 'default', { card: A.card }, A.lp2));
  await sleep(4000);
  const lost = view(A.pool, 'get_pool') as { losses: string };
  console.log(`losses after default ${lost.losses}`);
  must('the issuer pauses the card', A.card, call(A.card, 'pause', { paused: true }, issuer, '1 yoctoNEAR', '30 Tgas'));
  must('the issuer sweeps the card: credited as a recovery of the loss', A.card, call(A.card, 'sweep', { amount: ONE.toString() }, issuer, '1 yoctoNEAR', '100 Tgas'));
  await sleep(6000);
  const fin = view(A.pool, 'get_pool') as { assets: string; losses: string; idle: string; share_price: string };
  console.log(`final pool ${JSON.stringify(fin)}`);
  console.log('CREDIT LIVE OK');
}

function deployWith(account: string, wasm: string, init: object, signerAccount: string): { ok: boolean; tx: string; out: string } {
  const r = run(['contract', 'deploy', account, 'use-file', wasm, 'with-init-call', 'new', 'json-args', JSON.stringify(init), 'prepaid-gas', '100 Tgas', 'attached-deposit', '0 NEAR', 'network-config', 'testnet', 'sign-with-keychain', 'send']);
  void signerAccount;
  const tx = txOf(r.out) ?? '';
  return { ok: r.code === 0 && tx !== '' && !/ExecutionError|Failure/.test(r.out), tx, out: r.out };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function blockMs(): Promise<number> {
  return bare0.latestBlockMs();
}
const bare0 = new ChainClient({ network: 'testnet', contractId: 'x.testnet', agentAccountId: 'x.testnet', transport: { contractId: 'x.testnet', view: async () => null, prepare: async () => { throw new Error('no'); }, submit: async () => { throw new Error('no'); }, txStatus: async () => null, blockNanosec: async () => String(BigInt((await (await fetch('https://test.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } }) })).json() as { result: { header: { timestamp_nanosec: string } } }).result.header.timestamp_nanosec)) } });

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

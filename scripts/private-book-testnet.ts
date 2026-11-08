// AIR-326: the live checks of the private book on a policy account made by `pnpm airlock init` (testnet only, between our own accounts):
//   1. a compromised agent withholds the proof of a booked payee: the payment is held as `new`, the owner's CLI flags it, and the owner rejects it
//   2. the owner approves a new payee and remembers it with `approve_and_remember` (the vault builds the new root and the entry path), and the
//      next payment to that payee, with its proof, is allowed
//   pnpm tsx scripts/private-book-testnet.ts --dir <the init dir> --payee <existing testnet account to remember>
// Every owner call goes through the near CLI keychain; no key is read or printed here.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChainClient } from '../runtime/src/chain/near.ts';
import { signerFromCredentials } from '../runtime/src/chain/signer.ts';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { ActionRequest, OwnerTask, TASK_TAG, labelsToBits, sha256Hex } from '../runtime/src/dsl/index.ts';
import { taskSigner } from '../runtime/src/mcp/boot.ts';
import { loadVault, saveVault } from '../runtime/src/vault/file.ts';

const NEAR = process.env.NEAR ?? 'near';
const ONE = 10n ** 24n;
const flag = (n: string): string => {
  const i = process.argv.indexOf(n);
  const v = i < 0 ? undefined : process.argv[i + 1];
  if (v === undefined) throw new Error(`missing ${n}`);
  return v;
};

const dir = resolve(flag('--dir'));
const payee2 = `near:${flag('--payee')}`;
const cfg = JSON.parse(readFileSync(`${dir}/mcp.json`, 'utf8')) as { owner_id: string; contract_id: string; agent_id: string; agent_credentials: string; task_key_file: string; book_vault: string };
let vault = loadVault(cfg.book_vault);
const signer = signerFromCredentials(cfg.agent_credentials, cfg.agent_id);
// the compromised agent: a client WITHOUT the vault, so it sends no proof
const bare = new ChainClient({ network: 'testnet', contractId: cfg.contract_id, agentAccountId: cfg.agent_id, signer, rpcUrls: [...DEFAULT_RPC_URLS] });
const withVault = () => new ChainClient({ network: 'testnet', contractId: cfg.contract_id, agentAccountId: cfg.agent_id, signer, rpcUrls: [...DEFAULT_RPC_URLS], vault });
const sign = taskSigner(cfg.task_key_file);

async function task(id: string, payeeKey: string) {
  const now = await bare.latestBlockMs();
  const t = OwnerTask.parse({
    tag: TASK_TAG,
    task_id: `${id}-${now}`,
    contract_id: cfg.contract_id,
    agent_id: cfg.agent_id,
    plan_sha256: sha256Hex(new TextEncoder().encode(`private-book-live:${id}`)),
    instruction_sha256_salted: sha256Hex(new TextEncoder().encode(`salt:${id}`)),
    issued_ms: now - 1000,
    expires_ms: now + 20 * 60_000,
    max_actions: 3,
    bounds: [{ payee_key: payeeKey, max_total: (2n * ONE).toString() }],
  });
  return { t, sig: sign(t) };
}

function request(t: OwnerTask, index: number, payee: string, amount: bigint, recipient: string[]) {
  return ActionRequest.parse({
    task_id: t.task_id,
    action_index: index,
    asset: 'near',
    payee,
    amount: amount.toString(),
    labels: { recipient: labelsToBits(recipient), amount: labelsToBits(['Owner']), pc: labelsToBits(['Owner']) },
    evm: null,
    hints: { plan_hash: t.plan_sha256, trace_digest: '0'.repeat(64) },
  });
}

function owner(method: string, args: object): string {
  const r = spawnSync(NEAR, ['contract', 'call-function', 'as-transaction', cfg.contract_id, method, 'json-args', JSON.stringify(args), 'prepaid-gas', '100 Tgas', 'attached-deposit', '1 yoctoNEAR', 'sign-as', cfg.owner_id, 'network-config', 'testnet', 'sign-with-keychain', 'send'], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  const tx = /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1];
  if (r.status !== 0 || tx === undefined || /ExecutionError|Failure/.test(out)) throw new Error(`${method} failed: ${out.slice(-400)}`);
  return tx;
}

async function main(): Promise<void> {
  const acme = vault.entries.find((e) => e.label === 'Acme');
  if (acme === undefined) throw new Error('the vault has no Acme');

  // 1. withheld proof: an Owner labelled request to a booked payee, sent with no proof
  const a = await task('withheld', acme.payee);
  const held = await bare.submitBatch([request(a.t, 0, acme.payee, ONE / 2n, ['Owner'])], a.t, a.sig);
  const o = held.outcomes[0];
  console.log(`withheld proof: ${o?.outcome} ${o?.reason ?? ''} pending ${o?.pending_id ?? 'none'} tx ${held.txHash}`);
  if (o?.outcome !== 'escalated' || o.reason !== 'NewRecipient' || o.pending_id === null) throw new Error('a withheld proof must be held as NewRecipient');
  const view = await bare.getRequest(o.pending_id);
  console.log(`card book status: ${view?.book_status} (the payee is in the owner's book)`);
  if (view?.book_status !== 'new') throw new Error('the card must say new');
  console.log(`PENDING ${o.pending_id}`);

  // 2. a new payee: held as new, then approve_and_remember with the vault's new root and entry path
  const b = await task('remember', payee2);
  const first = await withVault().submitBatch([request(b.t, 0, payee2, ONE / 2n, ['Owner'])], b.t, b.sig);
  const f = first.outcomes[0];
  console.log(`new payee: ${f?.outcome} ${f?.reason ?? ''} pending ${f?.pending_id ?? 'none'} tx ${first.txHash}`);
  if (f?.outcome !== 'escalated' || f.pending_id === null) throw new Error('a new payee must be held');
  const card = await bare.getRequest(f.pending_id);
  if (card === null || card.display === null) throw new Error('no card');
  const plan = vault.prepareRemember({ payee: payee2, cap: ONE, dailyUntrustedBudget: 0n, dailyLimit: 2n * ONE, label: 'Remembered' });
  const tx = owner('approve_and_remember', {
    id: f.pending_id,
    to: card.payee,
    asset: card.display.asset_symbol,
    amount: card.display.amount_decimal,
    why: card.reason,
    book: card.book_status,
    expected_old: plan.expected_old,
    new_root: plan.new_root,
    entry: plan.entry,
  });
  console.log(`approve_and_remember tx ${tx}`);
  vault = plan.next;
  saveVault(vault, cfg.book_vault);
  const root = await bare.getBookRoot();
  console.log(`chain root ${root} equals vault root: ${root === vault.root()}`);
  if (root !== vault.root()) throw new Error('the roots differ');

  // 3. the next payment to the remembered payee carries its proof and is allowed
  const c = await task('next', payee2);
  const next = await withVault().submitBatch([request(c.t, 0, payee2, ONE / 4n, ['Book'])], c.t, c.sig);
  const n = next.outcomes[0];
  console.log(`remembered payee, with proof: ${n?.outcome} ${n?.reason ?? ''} tx ${next.txHash}`);
  if (n?.outcome !== 'allowed') throw new Error('the remembered payee must be allowed');
  console.log('PRIVATE BOOK LIVE OK');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

// AIR-313: `pnpm airlock`, the quickstart CLI. Testnet only. Signing goes through the near CLI's own keychains; this file never reads or
// prints a key.
//   pnpm airlock init --owner <you>.testnet [--policy <id>.testnet] [--dir <dir>]
//       creates your policy account (faucet), the agent and the payee Acme under your account, deploys the committed policy wasm,
//       configures it (scripts/bootstrap-policy.sh with fixtures/quickstart/policy.json), writes <dir>/mcp.json (default ~/.airlock) and
//       prints the Claude Desktop entry. Ends with `AIRLOCK READY <policy>`.
//   pnpm airlock claude-config [--dir <dir>]   prints the mcpServers entry for Claude Desktop (claude_desktop_config.json)
//   pnpm airlock play [--dir <dir>]            a scripted agent (no model) drives the MCP server over stdio through the sample inbox
//   pnpm airlock pending <id> | approve <id> | reject <id>   the owner's card and decision (scripts/approve-cli.sh, signed as the owner)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { noticeFromRequestView } from '../runtime/src/vault/index.ts';
import { loadVault } from '../runtime/src/vault/file.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(REPO, 'runtime', 'src', 'mcp', 'main.ts');
const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WASM = join(REPO, 'contracts', 'airlock-policy', 'res', 'airlock_policy.wasm');
const RPC = 'https://test.rpc.fastnear.com';
const NEAR = process.env.NEAR ?? 'near';
// the policy pays storage for the wasm (1e19 yocto per byte) plus 1 NEAR margin (deploy-testnet.sh), plus the 2 NEAR the sample invoices pay
const PAYMENTS_RESERVE = 2n * 10n ** 24n;
const ONE_NEAR = 10n ** 24n;

class Exit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Exit(2, `${name} needs a value`);
  return v;
}

const homeDir = (argv: string[]): string => resolve(flag(argv, '--dir') ?? process.env.AIRLOCK_HOME ?? join(homedir(), '.airlock'));

function sh(cmd: string, args: string[], opts: { env?: Record<string, string>; input?: string; quiet?: boolean } = {}): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: REPO, env: { ...process.env, ...(opts.env ?? {}) }, input: opts.input ?? '', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (opts.quiet !== true) process.stdout.write(out.split('\n').filter((l) => !/private|seed phrase|secret/i.test(l)).join('\n'));
  return { code: r.status ?? 1, out };
}

async function viewAccount(id: string): Promise<{ amount: bigint } | null> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'airlock', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }),
  });
  const body = (await res.json()) as { result?: { amount: string }; error?: unknown };
  return body.result === undefined ? null : { amount: BigInt(body.result.amount) };
}

const near = (yocto: bigint): string => {
  const whole = yocto / ONE_NEAR;
  const frac = ((yocto % ONE_NEAR) * 100n) / ONE_NEAR;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
};

const txId = (out: string): string | null => /Transaction ID: *([A-Za-z0-9]+)/.exec(out)?.[1] ?? null;

async function waitFor(id: string): Promise<{ amount: bigint }> {
  for (let i = 0; i < 30; i++) {
    const a = await viewAccount(id);
    if (a !== null) return a;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Exit(1, `FAILED: ${id} did not appear on testnet`);
}

// ---- init ----

async function init(argv: string[]): Promise<void> {
  const owner = flag(argv, '--owner');
  if (owner === undefined) throw new Exit(2, 'usage: pnpm airlock init --owner <you>.testnet [--policy <id>.testnet] [--dir <dir>]');
  if (!/^[a-z0-9._-]+\.testnet$/.test(owner)) throw new Exit(2, 'REFUSED: testnet only, the owner must end in .testnet');
  const base = owner.slice(0, -'.testnet'.length).replace(/\./g, '-');
  const policy = flag(argv, '--policy') ?? `${base}-policy.testnet`;
  if (!/^[a-z0-9._-]+\.testnet$/.test(policy)) throw new Exit(2, 'REFUSED: the policy account must end in .testnet');
  const agent = `agent.${owner}`;
  const acme = `acme.${owner}`;
  const dir = homeDir(argv);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(WASM)) throw new Exit(1, `FAILED: ${WASM} is missing`);
  const wasmBytes = BigInt(readFileSync(WASM).length);
  const policyNeed = wasmBytes * 10n ** 19n + ONE_NEAR + PAYMENTS_RESERVE;

  console.log(`owner  ${owner}\npolicy ${policy}\nagent  ${agent}\npayee  ${acme} (book alias Acme)\nconfig ${dir}`);
  const ownerAcc = await viewAccount(owner);
  if (ownerAcc === null) throw new Exit(1, `FAILED: ${owner} does not exist on testnet; create it first (QUICKSTART step 1)`);

  // 1. the policy account: a fresh faucet account (10 NEAR), topped up by the owner to what the wasm and the sample payments need
  let policyAcc = await viewAccount(policy);
  if (policyAcc === null) {
    console.log(`creating ${policy} with the testnet faucet`);
    const r = sh(NEAR, ['account', 'create-account', 'sponsor-by-faucet-service', policy, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', 'testnet', 'create'], { quiet: true });
    if (r.code !== 0) throw new Exit(1, `FAILED: faucet could not create ${policy} (near exit ${r.code}); pass --policy with an account you own`);
    policyAcc = await waitFor(policy);
  }
  if (policyAcc.amount < policyNeed) {
    const top = policyNeed - policyAcc.amount + ONE_NEAR / 10n;
    console.log(`sending ${near(top)} NEAR from ${owner} to ${policy}`);
    const r = sh(NEAR, ['tokens', owner, 'send-near', policy, `${near(top)} NEAR`, 'network-config', 'testnet', 'sign-with-keychain', 'send'], { quiet: true });
    if (r.code !== 0) throw new Exit(1, `FAILED: top-up of ${policy} (near exit ${r.code}); ${owner} needs about ${near(top + 2n * ONE_NEAR)} NEAR`);
    console.log(`TX top-up ${txId(r.out) ?? 'unknown'}`);
  }

  // 2. the agent and the payee, under the owner's account; the agent's key goes to ~/.near-credentials (the MCP server's signer)
  for (const [id, amount] of [
    [agent, '1 NEAR'],
    [acme, '0.05 NEAR'],
  ] as const) {
    if ((await viewAccount(id)) !== null) {
      console.log(`${id} exists`);
      continue;
    }
    const r = sh(NEAR, ['account', 'create-account', 'fund-myself', id, amount, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'sign-as', owner, 'network-config', 'testnet', 'sign-with-keychain', 'send'], { quiet: true });
    if (r.code !== 0) throw new Exit(1, `FAILED: could not create ${id} (near exit ${r.code})`);
    console.log(`TX create ${id} ${txId(r.out) ?? 'unknown'}`);
    await waitFor(id);
  }
  const legacy = join(homedir(), '.near-credentials', 'testnet', `${agent}.json`);
  if (!existsSync(legacy)) throw new Exit(1, `FAILED: the agent's credentials file ${legacy} is missing (create the agent with save-to-legacy-keychain)`);
  // the MCP server's signer reads { account_id, public_key, private_key }; the near CLI's file has no account_id, so a copy with it is kept
  // next to the config, mode 0600. Only the key fields are copied and nothing of the file is printed.
  const creds = join(dir, 'agent-credentials.json');
  const file = JSON.parse(readFileSync(legacy, 'utf8')) as { public_key?: unknown; private_key?: unknown };
  if (typeof file.private_key !== 'string' || typeof file.public_key !== 'string') throw new Exit(1, `FAILED: ${legacy} has no ed25519 key pair`);
  writeFileSync(creds, `${JSON.stringify({ account_id: agent, public_key: file.public_key, private_key: file.private_key })}\n`, { mode: 0o600 });

  // 3. the owner's task key (kept in ~/.airlock-task-key, mode 0600, never printed)
  const keyFile = process.env.AIRLOCK_TASK_KEY_FILE ?? join(homedir(), '.airlock-task-key');
  if (!existsSync(keyFile)) sh(process.execPath, [join(REPO, 'scripts', 'task-key.mjs'), 'init']);

  // 4. deploy the committed wasm (no Rust needed) and configure the policy
  const accounts = join(dir, 'accounts.json');
  writeFileSync(accounts, `${JSON.stringify({ owner, policy, agent, acme }, null, 2)}\n`);
  // AIR-326: the owner's private book lives here; the policy contract holds only its Merkle root
  const bookVault = join(dir, 'book.vault.json');
  const env = { AIRLOCK_ACCOUNTS_FILE: accounts, AIRLOCK_TASK_KEY_FILE: keyFile, AIRLOCK_BOOK_VAULT: bookVault };
  const code = await codeHash(policy);
  if (code === null) {
    const d = sh('bash', [join(REPO, 'scripts', 'deploy-testnet.sh')], {
      env: { ...env, AIRLOCK_SKIP_BUILD: '1', AIRLOCK_WASM_SRC: WASM, AIRLOCK_RES_DIR: join(dir, 'res'), AIRLOCK_EVIDENCE: join(dir, 'deploy-evidence.md') },
      quiet: true,
    });
    const last = d.out.trim().split('\n').at(-1) ?? '';
    console.log(last);
    if (d.code !== 0 || !last.startsWith('DEPLOYED')) throw new Exit(1, 'FAILED: deploy (scripts/deploy-testnet.sh)');
    console.log(`TX deploy ${txId(d.out) ?? 'unknown'}`);
  } else {
    console.log(`${policy} already has code ${code}; configuring it`);
  }
  const b = sh('bash', [join(REPO, 'scripts', 'bootstrap-policy.sh')], { env: { ...env, AIRLOCK_POLICY_FILE: join(REPO, 'fixtures', 'quickstart', 'policy.json') }, quiet: true });
  for (const line of b.out.split('\n')) if (/^(TX |POLICY |DRIFT|FAILED|REFUSED|nonce)/.test(line)) console.log(line);
  if (b.code !== 0 || !b.out.includes('POLICY MATCHES')) throw new Exit(1, 'FAILED: bootstrap (scripts/bootstrap-policy.sh)');

  // 5. the sample inbox and the owner config of the MCP server
  const inbox = readFileSync(join(REPO, 'fixtures', 'quickstart', 'inbox.json'), 'utf8').replaceAll('{evil}', `acme-billing.${owner}`);
  writeFileSync(join(dir, 'inbox.json'), inbox);
  const files = join(dir, 'files');
  mkdirSync(files, { recursive: true });
  const cfg = {
    network: 'testnet',
    owner_id: owner,
    contract_id: policy,
    agent_id: agent,
    agent_credentials: creds,
    task_key_file: keyFile,
    request: "Pay Acme's invoices from my inbox, up to 3 NEAR in total.",
    bounds: [{ payee: 'Acme', max_total: '3' }],
    max_actions: 8,
    task_ttl_minutes: 60,
    inbox: join(dir, 'inbox.json'),
    files_dir: files,
    book_vault: bookVault,
  };
  writeFileSync(join(dir, 'mcp.json'), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  console.log(`wrote ${join(dir, 'mcp.json')}`);
  console.log('Claude Desktop: add this to claude_desktop_config.json (pnpm airlock claude-config prints it again):');
  console.log(JSON.stringify(claudeConfig(dir), null, 2));
  console.log(`AIRLOCK READY ${policy}`);
}

async function codeHash(id: string): Promise<string | null> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'airlock', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }),
  });
  const h = ((await res.json()) as { result?: { code_hash: string } }).result?.code_hash;
  return h === undefined || h === '11111111111111111111111111111111' ? null : h;
}

// ---- the MCP client entries ----

function claudeConfig(dir: string): object {
  return { mcpServers: { airlock: { command: process.execPath, args: [TSX, MAIN], env: { AIRLOCK_MCP_CONFIG: join(dir, 'mcp.json') } } } };
}

// ---- play: a scripted agent, no model ----

type Leaf = { h: string; text: string };
type Email = { id: Leaf; subject: Leaf; body: Leaf };
type Pay = { verdict: string; reason: string | null; pending_id: string | null; explorer: string | null; tx: string | null; payee: string | null; amount: string | null; message: string };

async function play(argv: string[]): Promise<void> {
  const dir = homeDir(argv);
  const config = join(dir, 'mcp.json');
  if (!existsSync(config)) throw new Exit(1, `FAILED: ${config} is missing; run pnpm airlock init first`);
  const client = new Client({ name: 'airlock-play', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [TSX, MAIN], env: { ...process.env, AIRLOCK_MCP_CONFIG: config } as Record<string, string>, stderr: 'ignore' }));
  try {
    const req = (await client.callTool({ name: 'owner_request', arguments: {} })).structuredContent as { request: Leaf };
    console.log(`owner request: ${req.request.text}`);
    const { emails } = (await client.callTool({ name: 'read_email', arguments: {} })).structuredContent as { emails: Email[] };
    const count = { Allow: 0, Escalate: 0, Block: 0, Refused: 0 };
    for (const m of emails) {
      // what a naive agent does: the amount from the email, and the account the email names, else the payee the owner named
      const amount = /([0-9]+(?:\.[0-9]+)?) NEAR/.exec(m.body.text)?.[1];
      const account = /\bto ([a-z0-9._-]+\.(?:testnet|near))\b/.exec(m.body.text)?.[1];
      if (amount === undefined) continue;
      const payee = account === undefined ? 'Acme' : { handle: m.body.h, quote: account };
      const r = (await client.callTool({ name: 'pay', arguments: { payee, amount: { handle: m.body.h, quote: amount }, why: m.subject.text } })).structuredContent as Pay;
      count[r.verdict as keyof typeof count] += 1;
      const where = r.verdict === 'Allow' ? `tx ${r.explorer ?? r.tx ?? 'none'}` : r.verdict === 'Escalate' ? `pending ${r.pending_id ?? '?'} (${r.reason ?? ''}): pnpm airlock pending ${r.pending_id ?? '?'}` : `(${r.reason ?? ''})`;
      console.log(`${m.id.text} ${r.verdict} ${r.amount ?? amount} NEAR to ${r.payee ?? '?'} ${where}`);
    }
    console.log(`PLAY DONE allow ${count.Allow} escalate ${count.Escalate} block ${count.Block}`);
  } finally {
    await client.close();
  }
}

// ---- the owner's decision ----

function decide(cmd: 'pending' | 'approve' | 'reject', argv: string[]): number {
  const id = argv[0];
  if (id === undefined) throw new Exit(2, `usage: pnpm airlock ${cmd} <pending id>`);
  const dir = homeDir(argv);
  const cfg = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { owner_id: string; contract_id: string; book_vault?: string };
  // AIR-326: a booked payee that the contract holds as new means the agent sent no proof for it: say so before the owner decides
  if (cfg.book_vault !== undefined) {
    const view = spawnSync(NEAR, ['contract', 'call-function', 'as-read-only', cfg.contract_id, 'get_request', 'json-args', JSON.stringify({ id }), 'network-config', 'testnet', 'now'], { encoding: 'utf8' });
    if (view.status === 0) {
      try {
        const vault = loadVault(resolve(dir, cfg.book_vault));
        const notice = noticeFromRequestView(vault, JSON.parse(view.stdout) as unknown);
        if (notice !== null) console.error(notice);
      } catch {
        // an unreadable vault or answer shows no notice; the card below is still the contract's own
      }
    }
  }
  const args = [join(REPO, 'scripts', 'approve-cli.sh'), id, ...(cmd === 'reject' ? ['--reject'] : []), ...(cmd === 'pending' ? [] : ['--run'])];
  const r = spawnSync('bash', args, { cwd: REPO, env: { ...process.env, OWNER: cfg.owner_id, POLICY: cfg.contract_id, APPROVE_TXID_DIR: join(dir, 'txid') }, stdio: 'inherit' });
  if (r.status === 0 && cmd !== 'pending') {
    const tx = readFileSync(join(dir, 'txid', `approve-${id}.txid`), 'utf8').trim();
    console.log(`${cmd === 'approve' ? 'APPROVED' : 'REJECTED'} ${id} https://testnet.nearblocks.io/txns/${tx}`);
  }
  return r.status ?? 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init':
      await init(rest);
      return 0;
    case 'claude-config':
      console.log(JSON.stringify(claudeConfig(homeDir(rest)), null, 2));
      return 0;
    case 'play':
      await play(rest);
      return 0;
    case 'pending':
    case 'approve':
    case 'reject':
      return decide(cmd, rest);
    default:
      console.error('usage: pnpm airlock init|claude-config|play|pending|approve|reject');
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof Exit) {
      console.error(e.message);
      process.exitCode = e.code;
    } else {
      console.error(e instanceof Error ? e.message : 'unexpected error');
      process.exitCode = 1;
    }
  },
);

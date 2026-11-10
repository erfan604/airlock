// AIR-356: sets up the "try it live" card on NEAR testnet: a policy of its own, separate from the /challenge policy and from the credit
// card, with an agent whose three function-call keys are published so a visitor's browser can sign submit_batch as it.
//   pnpm tsx scripts/try-setup.ts --tag <tag> --fund-from <funded testnet account>            dry (the default): every step, every exact
//                                                              command, the test NEAR each step needs and the total; sends nothing
//   TRY_SETUP_LIVE_OK=1 pnpm tsx scripts/try-setup.ts --tag <tag> --fund-from <account> --live  runs the steps in order; a step that is
//                                                              already done is skipped, and the first failure stops the run
// The accounts are airlock-try-<tag>.testnet (the owner, created from the funded account) and its sub-accounts try (the policy), agent and
// shop (the one booked payee). The steps: the four accounts, the committed policy wasm deployed by scripts/deploy-testnet.sh, a task key
// of its own, the policy configured by scripts/bootstrap-policy.sh from fixtures/try/policy.try.json (which also registers and allows the
// agent), and three function-call keys on the agent (receiver the policy, method submit_batch only, no allowance limit). The secrets of
// those three keys are written to ~/.airlock-try.env (mode 600) and nowhere else; scripts/try-publish.ts publishes them. Signing goes
// through the near CLI's keychain; this script reads no account key. Files it writes live under ~/.airlock-try (accounts.json, the task
// key seed, the book vault) and ~/.airlock-try.env. Testnet only. It never touches a credit account.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RPC_URLS } from '../runtime/src/chain/rpc.ts';
import { rpcAccount, rpcKeys, rpcQuery, rpcView } from '../runtime/src/credit/rpc.ts';
import { base58, nearText, runSetup, setupPlan } from '../runtime/src/trycard/index.ts';
import type { SetupCfg, SetupIo } from '../runtime/src/trycard/index.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WASM = join(REPO, 'contracts', 'airlock-policy', 'res', 'airlock_policy.wasm');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The public keys of `agent` that may call submit_batch on `policy` and nothing else. */
export async function publishedKeysOnChain(rpc: string, agent: string, policy: string): Promise<string[]> {
  try {
    const keys = await rpcKeys(rpc, agent);
    return keys.flatMap((k) => {
      const fc = isObj(k.permission) && isObj(k.permission['FunctionCall']) ? k.permission['FunctionCall'] : null;
      const methods = fc === null ? null : fc['method_names'];
      return fc !== null && fc['receiver_id'] === policy && Array.isArray(methods) && methods.length === 1 && methods[0] === 'submit_batch' ? [k.publicKey] : [];
    });
  } catch {
    // the agent account does not exist yet
    return [];
  }
}

function liveIo(cfg: SetupCfg): SetupIo {
  const rpc = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
  const plan = setupPlan(cfg);
  const n = plan.names;
  const exists = async (id: string): Promise<boolean> => (await rpcAccount(rpc, id)) !== null;
  const done = async (step: string): Promise<boolean> => {
    if (step === 'owner') return exists(n.owner);
    if (step === 'policy-account') return exists(n.policy);
    if (step === 'agent-account') return exists(n.agent);
    if (step === 'shop-account') return exists(n.shop);
    if (step === 'deploy') {
      const a = await rpcQuery(rpc, { request_type: 'view_account', account_id: n.policy });
      return a !== null && a['code_hash'] === base58(createHash('sha256').update(readFileSync(WASM)).digest());
    }
    if (step === 'task-key') return existsSync(join(plan.dir, 'task-key'));
    if (step === 'bootstrap') {
      try {
        const valid = await rpcView(rpc, n.policy, 'is_agent_valid', { account_id: n.agent });
        const taskKey = await rpcView(rpc, n.policy, 'get_task_key', {});
        const policy = await rpcView(rpc, n.policy, 'get_policy', {});
        const flags = isObj(policy) && isObj(policy['flags']) ? policy['flags'] : null;
        return valid === true && typeof taskKey === 'string' && flags !== null && flags['max_task_actions'] === 99 && flags['pending_ttl_ms'] === '60000';
      } catch {
        return false;
      }
    }
    return false;
  };
  return {
    print: (l) => console.log(l),
    done,
    keysOnChain: () => publishedKeysOnChain(rpc, n.agent, n.policy),
    run: async (step, command) => {
      const r = spawnSync('bash', ['-c', command], { cwd: REPO, encoding: 'utf8', env: process.env });
      const out = `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
      const tail = out.trim().split('\n').slice(-3).join(' | ').slice(-400);
      if (r.status !== 0 || /ExecutionError|Failure|panicked/.test(out)) return { ok: false, tail: tail === '' ? `exit ${String(r.status)}` : tail };
      if (step === 'keys') return { ok: true, tail: '' };
      // the chain shows the result a few seconds later
      for (let i = 0; i < 12; i += 1) {
        if (await done(step)) return { ok: true, tail: '' };
        await sleep(1500);
      }
      return { ok: false, tail: 'the command ran and the read-only check of the step does not pass yet' };
    },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let tag = process.env['TRY_TAG'];
  let fundFrom = process.env['TRY_FUND_FROM'];
  let live = false;
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === '--tag' && next !== undefined) tag = argv[(i += 1)];
    else if (argv[i] === '--fund-from' && next !== undefined) fundFrom = argv[(i += 1)];
    else if (argv[i] === '--live') live = true;
    else tag = undefined;
  }
  if (tag === undefined || fundFrom === undefined) {
    console.log('usage: try-setup.ts --tag <3 to 12 lowercase letters or digits> --fund-from <funded testnet account> [--live]');
    return 2;
  }
  if (!existsSync(WASM)) {
    console.log(`TRY SETUP FAILED ${WASM} is missing`);
    return 1;
  }
  const cfg: SetupCfg = { tag, fundFrom, wasmBytes: statSync(WASM).size, repo: REPO, home: homedir() };
  const code = await runSetup(cfg, liveIo(cfg), { live, env: process.env });
  if (!live) {
    // read only: does the funding account hold enough
    const rpc = DEFAULT_RPC_URLS[0] ?? 'https://test.rpc.fastnear.com';
    const have = await rpcAccount(rpc, fundFrom).catch(() => null);
    const need = setupPlan(cfg).near.total;
    console.log(have === null ? `${fundFrom} does not exist yet (or could not be read)` : `${fundFrom} holds ${nearText(have.amount - (have.amount % 10n ** 20n))} NEAR: ${have.amount > need ? 'enough' : `short by ${nearText(need - have.amount + 10n ** 23n)} NEAR`}`);
  }
  return code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.log(`TRY SETUP FAILED ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`);
      process.exitCode = 1;
    },
  );
}

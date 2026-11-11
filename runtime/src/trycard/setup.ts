// AIR-356: the setup of the try card as a plan of eight steps, each with its exact commands, the test NEAR it needs and how it is
// verified without sending. The pattern is scripts/challenge-setup.sh: accounts made with `near account create-account fund-myself`, the
// policy deployed by scripts/deploy-testnet.sh and configured by scripts/bootstrap-policy.sh (which also registers and allows the agent),
// then the published function-call keys. Dry is the default; the live run needs TRY_SETUP_LIVE_OK=1, skips a step that is already done,
// and stops at the first failure.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellLine } from '../credit/strict.ts';
import { TRY_KEY_COUNT, YOCTO_PER_NEAR, nearText, refusedAccount, tryNames } from './facts.ts';
import type { TryNames } from './facts.ts';
import { newKeyPair } from './keys.ts';

export const SETUP_FLAG = 'TRY_SETUP_LIVE_OK';
/** NEAR storage staking: 1e19 yocto per byte. */
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
/** scripts/deploy-testnet.sh wants the wasm's storage plus 1 NEAR on the account. */
const DEPLOY_MARGIN_YOCTO = YOCTO_PER_NEAR;
/** Free NEAR left on the policy for the request records visitors create (each attempt stores one). */
const POLICY_FLOAT_YOCTO = 8n * YOCTO_PER_NEAR;
/** The agent pays the gas of every attempt, up to about 0.003 NEAR each (5,940 slots a publish); the refill job keeps it topped up. */
const AGENT_YOCTO = 6n * YOCTO_PER_NEAR;
const SHOP_YOCTO = YOCTO_PER_NEAR / 10n;
/** What stays on the owner: gas for its own calls and the refill job's reserve. */
const OWNER_KEEPS_YOCTO = 5n * YOCTO_PER_NEAR;

export type SetupCfg = { tag: string; fundFrom: string; wasmBytes: number; repo: string; home: string };
export type SetupStep = { id: string; title: string; near: bigint; commands: string[]; verify: string };
export type SetupPlan = { names: TryNames; steps: SetupStep[]; near: { policy: bigint; agent: bigint; shop: bigint; ownerKeeps: bigint; total: bigint }; dir: string; envFile: string; accountsFile: string };

const create = (id: string, amount: bigint, signer: string): string =>
  shellLine('near', ['account', 'create-account', 'fund-myself', id, `${nearText(amount)} NEAR`, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'sign-as', signer, 'network-config', 'testnet', 'sign-with-keychain', 'send']);
const summary = (id: string): string => `near account view-account-summary ${id} network-config testnet now`;

/** The add-key command of one published key: function call, receiver the try policy, submit_batch only, no allowance limit. */
export const addKeyCommand = (n: TryNames, publicKey: string): string =>
  shellLine('near', ['account', 'add-key', n.agent, 'grant-function-call-access', '--allowance', 'unlimited', '--contract-account-id', n.policy, '--function-names', 'submit_batch', 'use-manually-provided-public-key', publicKey, 'network-config', 'testnet', 'sign-with-keychain', 'send']);

export function setupPlan(cfg: SetupCfg): SetupPlan {
  const n = tryNames(cfg.tag);
  for (const id of [n.owner, n.policy, n.agent, n.shop]) {
    const why = refusedAccount(id);
    if (why !== null) throw new Error(why);
  }
  if (!cfg.fundFrom.endsWith('.testnet')) throw new Error('the funding account must be a testnet account');
  const tenth = YOCTO_PER_NEAR / 10n;
  const storage = ((BigInt(cfg.wasmBytes) * STORAGE_YOCTO_PER_BYTE + tenth - 1n) / tenth) * tenth;
  const policy = storage + DEPLOY_MARGIN_YOCTO + POLICY_FLOAT_YOCTO;
  const total = policy + AGENT_YOCTO + SHOP_YOCTO + OWNER_KEEPS_YOCTO;
  const dir = join(cfg.home, '.airlock-try');
  const accounts = join(dir, 'accounts.json');
  const taskKey = join(dir, 'task-key');
  const vault = join(dir, 'book.vault.json');
  const wasm = join(cfg.repo, 'contracts', 'airlock-policy', 'res', 'airlock_policy.wasm');
  const deploy = `AIRLOCK_ACCOUNTS_FILE=${accounts} AIRLOCK_RES_DIR=${join(dir, 'res')} AIRLOCK_SKIP_BUILD=1 AIRLOCK_WASM_SRC=${wasm} ${join(cfg.repo, 'scripts', 'deploy-testnet.sh')}`;
  const taskKeyCmd = `AIRLOCK_TASK_KEY_FILE=${taskKey} node ${join(cfg.repo, 'scripts', 'task-key.mjs')}`;
  const bootstrap = `AIRLOCK_ACCOUNTS_FILE=${accounts} AIRLOCK_POLICY_FILE=${join(cfg.repo, 'fixtures', 'try', 'policy.try.json')} AIRLOCK_BOOK_VAULT=${vault} TASK_PUBLIC_KEY="$(${taskKeyCmd} pubkey)" ${join(cfg.repo, 'scripts', 'bootstrap-policy.sh')}`;
  const steps: SetupStep[] = [
    { id: 'owner', title: `create the owner ${n.owner} from ${cfg.fundFrom}`, near: total, commands: [create(n.owner, total, cfg.fundFrom)], verify: summary(n.owner) },
    { id: 'policy-account', title: `create the policy account ${n.policy}`, near: policy, commands: [create(n.policy, policy, n.owner)], verify: summary(n.policy) },
    { id: 'agent-account', title: `create the agent account ${n.agent}`, near: AGENT_YOCTO, commands: [create(n.agent, AGENT_YOCTO, n.owner)], verify: summary(n.agent) },
    { id: 'shop-account', title: `create the booked shop ${n.shop}`, near: SHOP_YOCTO, commands: [create(n.shop, SHOP_YOCTO, n.owner)], verify: summary(n.shop) },
    {
      id: 'deploy',
      title: `deploy the committed policy wasm to ${n.policy} with its init call (the deploy script checks the code hash)`,
      near: 0n,
      commands: [deploy],
      verify: `${deploy} --dry-run (its "on-chain code hash before" line is the wasm's hash once deployed)`,
    },
    { id: 'task-key', title: 'a task key of its own for the try card (a seed file outside the repo)', near: 0n, commands: [`${taskKeyCmd} init`], verify: `${taskKeyCmd} pubkey` },
    {
      id: 'bootstrap',
      title: 'configure the policy from fixtures/try/policy.try.json: the asset, the strict book root, the flags, the task key, and the agent registered (its own call, 0.005 NEAR) and allowed',
      near: 0n,
      commands: [bootstrap],
      verify: `${bootstrap} --verify (must end POLICY MATCHES and print the time the agent is valid until)`,
    },
    {
      id: 'keys',
      title: `three published function-call keys on ${n.agent}: receiver ${n.policy}, method submit_batch only, no allowance limit (the secrets go to ${join(cfg.home, '.airlock-try.env')} only)`,
      near: 0n,
      commands: Array.from({ length: TRY_KEY_COUNT }, (_, i) => addKeyCommand(n, `<public key ${String(i + 1)}>`)),
      verify: `near account list-keys ${n.agent} network-config testnet now (three keys for submit_batch on ${n.policy}, next to the agent's own key)`,
    },
  ];
  return { names: n, steps, near: { policy, agent: AGENT_YOCTO, shop: SHOP_YOCTO, ownerKeeps: OWNER_KEEPS_YOCTO, total }, dir, envFile: join(cfg.home, '.airlock-try.env'), accountsFile: accounts };
}

export type SetupIo = {
  print(line: string): void;
  /** runs one shell command of a step; `tail` is the end of its output when it failed */
  run(step: string, command: string): Promise<{ ok: boolean; tail: string }>;
  /** whether the step's result is already on the chain or on disk (read only) */
  done(step: string): Promise<boolean>;
  /** the public keys on the agent account that are function-call keys for submit_batch on the try policy */
  keysOnChain(): Promise<string[]>;
};

type KeyPair = { publicKey: string; secretKey: string };

/** The published keys of the env file, or null when it does not hold all of them. */
export function keysOfEnvFile(text: string): KeyPair[] | null {
  const out: KeyPair[] = [];
  for (let i = 1; i <= TRY_KEY_COUNT; i += 1) {
    const pub = new RegExp(`^TRY_KEY_PUBLIC_${String(i)}=(ed25519:[1-9A-HJ-NP-Za-km-z]{43,44})$`, 'm').exec(text)?.[1];
    const sec = new RegExp(`^TRY_KEY_SECRET_${String(i)}=(ed25519:[1-9A-HJ-NP-Za-km-z]{80,90})$`, 'm').exec(text)?.[1];
    if (pub === undefined || sec === undefined) return null;
    out.push({ publicKey: pub, secretKey: sec });
  }
  return out;
}

function writeEnvFile(plan: SetupPlan, keys: readonly KeyPair[]): void {
  const n = plan.names;
  const lines = [
    '# AIR-356 try card environment, written by scripts/try-setup.ts. Outside the repo, mode 600. The three key secrets are published on',
    '# purpose by scripts/try-publish.ts (each key can only call submit_batch on the try policy); they are still kept out of every log.',
    `TRY_OWNER_ACCOUNT=${n.owner}`,
    `TRY_POLICY_ACCOUNT=${n.policy}`,
    `TRY_AGENT_ACCOUNT=${n.agent}`,
    `TRY_SHOP_ACCOUNT=${n.shop}`,
    `TRY_TASK_KEY_FILE=${join(plan.dir, 'task-key')}`,
    `TRY_BOOK_VAULT=${join(plan.dir, 'book.vault.json')}`,
    ...keys.flatMap((k, i) => [`TRY_KEY_PUBLIC_${String(i + 1)}=${k.publicKey}`, `TRY_KEY_SECRET_${String(i + 1)}=${k.secretKey}`]),
  ];
  writeFileSync(plan.envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(plan.envFile, 0o600);
}

/** The dry run (the default) or, with `live` and the env flag, the setup itself. Answers the exit code. */
export async function runSetup(cfg: SetupCfg, io: SetupIo, opts: { live: boolean; env: Record<string, string | undefined> }): Promise<number> {
  const plan = setupPlan(cfg);
  const count = plan.steps.length;
  const head = (i: number, s: SetupStep): string => `step ${String(i + 1)} of ${String(count)}: ${s.title}`;
  const accountsJson = JSON.stringify({ owner: plan.names.owner, policy: plan.names.policy, agent: plan.names.agent, shop: plan.names.shop });
  if (!opts.live) {
    io.print(`the accounts file ${plan.accountsFile} (written by the live run, read by the deploy and bootstrap scripts) holds ${accountsJson}`);
    for (const [i, s] of plan.steps.entries()) {
      io.print(head(i, s));
      if (s.near > 0n) io.print(`  needs ${nearText(s.near)} NEAR on its signer`);
      for (const c of s.commands) io.print(`  ${c}`);
      io.print(`  verify (read only): ${s.verify}`);
    }
    io.print(`the policy gets ${nearText(plan.near.policy)} NEAR (wasm storage, the deploy margin and a float for request records), the agent ${nearText(plan.near.agent)} NEAR (gas for the attempts), the shop ${nearText(plan.near.shop)} NEAR, and ${nearText(plan.near.ownerKeeps)} NEAR stays on the owner (its own calls and the refill job)`);
    io.print(`total test NEAR needed in ${cfg.fundFrom}: ${nearText(plan.near.total)} NEAR (plus the fee of one transaction)`);
    io.print('TRY SETUP DRY: nothing was sent, no key was made, no file was written');
    return 0;
  }
  if (opts.env[SETUP_FLAG] !== '1') {
    io.print(`TRY SETUP NOT RUN: --live needs ${SETUP_FLAG}=1`);
    return 1;
  }
  // the accounts file the deploy and bootstrap scripts read: names only, no key
  mkdirSync(plan.dir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.accountsFile, `${accountsJson}\n`, { mode: 0o600 });
  for (const [i, s] of plan.steps.entries()) {
    io.print(head(i, s));
    const failed = (tail: string): number => {
      io.print(`TRY SETUP FAILED at step ${String(i + 1)} (${s.id}): ${tail}`);
      return 1;
    };
    if (s.id === 'keys') {
      // the secrets are on disk before any key goes on the chain, and a rerun reuses them
      let keys = existsSync(plan.envFile) ? keysOfEnvFile(readFileSync(plan.envFile, 'utf8')) : null;
      if (keys === null) {
        if (existsSync(plan.envFile)) return failed(`${plan.envFile} exists and does not hold the three keys: move it away first`);
        keys = Array.from({ length: TRY_KEY_COUNT }, () => newKeyPair());
        writeEnvFile(plan, keys);
      }
      const have = await io.keysOnChain();
      const missing = keys.filter((k) => !have.includes(k.publicKey));
      if (missing.length === 0) io.print('  already done');
      for (const k of missing) {
        const r = await io.run(s.id, addKeyCommand(plan.names, k.publicKey));
        if (!r.ok) return failed(r.tail);
        io.print(`  added ${k.publicKey}`);
      }
      continue;
    }
    if (await io.done(s.id)) {
      io.print('  already done');
      continue;
    }
    for (const c of s.commands) {
      const r = await io.run(s.id, c);
      if (!r.ok) return failed(r.tail);
    }
  }
  io.print(`TRY SETUP DONE ${plan.names.policy}`);
  return 0;
}

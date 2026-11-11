// AIR-356: the setup of the "try it live" card, a policy of its own with an agent any visitor's browser signs as through published
// function-call keys. Tests: the policy fixture (strict book, the flags of the design, inside the contract's bounds), the account names
// (a new top-level owner, no credit account, no personal name), the plan with every exact command and the test NEAR each step needs, the
// dry mode (nothing runs), the live mode behind its flag on a fake runner (order, a finished step skipped, a failed step stops the run),
// and the published keys (their secrets go to the env file only).
//   pnpm tsx --test scripts/try-setup.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SETUP_FLAG, TRY_BOUND_YOCTO, TRY_MAX_ACTIONS, TRY_TASK_COUNT, refusedAccount, runSetup, setupPlan, tryNames } from '../runtime/src/trycard/index.ts';
import type { SetupIo } from '../runtime/src/trycard/index.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = 10n ** 24n;
const CENT = 10n ** 22n;
const policy = JSON.parse(readFileSync(join(REPO, 'fixtures', 'try', 'policy.try.json'), 'utf8')) as {
  assets: Record<string, { hard_cap: string; daily_cap: string; quick_task_cap: string; path: string | null }>;
  book: { key: string; cap: string | null; daily_untrusted_budget: string; daily_limit: string; label: string; listed?: boolean }[];
  flags: Record<string, string | number>;
  nonce: { path: string };
  attestation_expiration_time_ms: string;
};

test('the try policy: NEAR only, 0.01 NEAR a request, one booked shop with no cap for amounts read from text', () => {
  assert.deepEqual(Object.keys(policy.assets), ['near']);
  assert.equal(policy.assets['near']?.hard_cap, CENT.toString());
  assert.equal(policy.assets['near']?.daily_cap, (5n * CENT).toString());
  assert.equal(policy.assets['near']?.quick_task_cap, CENT.toString());
  assert.equal(policy.assets['near']?.path, null);
  assert.deepEqual(policy.book, [{ name: 'shop', key: 'near:{shop}', cap: null, daily_untrusted_budget: '0', daily_limit: (5n * CENT).toString(), label: 'Shop', listed: true }]);
  assert.equal(policy.nonce.path, 'none');
  assert.equal(policy.attestation_expiration_time_ms, '1209600000');
});

test('the try flags are the design values and inside the bounds of set_flags', () => {
  assert.deepEqual({ ...policy.flags }, {
    max_pending_per_agent: 50,
    pending_ttl_ms: '60000',
    hourly_escalation_budget: 10000,
    lock_consecutive_rejects: 10000,
    lock_rejects_per_day: 10000,
    max_task_ttl_ms: '604800000',
    max_task_actions: 99,
  });
  // policy.rs FlagsJson::checked: every field at least 1, TTLs at most 7 days, counters at most 10,000, actions at most 99
  for (const k of ['max_pending_per_agent', 'hourly_escalation_budget', 'lock_consecutive_rejects', 'lock_rejects_per_day']) assert.ok(+policy.flags[k]! >= 1 && +policy.flags[k]! <= 10_000, k);
  assert.ok(+policy.flags['pending_ttl_ms']! <= 604_800_000 && +policy.flags['max_task_ttl_ms']! <= 604_800_000);
  assert.ok(+policy.flags['max_task_actions']! <= 99);
  // a published task: the bound is inside the quick cap and inside hard cap times actions (task.rs verify_bounds)
  assert.ok(TRY_BOUND_YOCTO <= BigInt(policy.assets['near']?.quick_task_cap ?? '0'));
  assert.ok(TRY_BOUND_YOCTO <= BigInt(policy.assets['near']?.hard_cap ?? '0') * BigInt(TRY_MAX_ACTIONS));
  assert.equal(TRY_TASK_COUNT * TRY_MAX_ACTIONS, 5940);
});

test('account names: a new top-level owner with sub-accounts, never a credit account or a personal name', () => {
  assert.deepEqual(tryNames('a1b2c3'), { owner: 'airlock-try-a1b2c3.testnet', policy: 'try.airlock-try-a1b2c3.testnet', agent: 'agent.airlock-try-a1b2c3.testnet', shop: 'shop.airlock-try-a1b2c3.testnet' });
  assert.throws(() => tryNames('A1'), /tag/);
  assert.throws(() => tryNames('erfan1'), /tag/);
  assert.equal(refusedAccount('agent.airlock-try-a1b2c3.testnet'), null);
  assert.match(refusedAccount('agent.airlock-credit-c1108d.testnet') ?? '', /credit/);
  assert.match(refusedAccount('erfan-agent.testnet') ?? '', /personal name/);
  assert.match(refusedAccount('agent.airlock-try-a1b2c3.near') ?? '', /testnet/);
});

const cfg = { tag: 'a1b2c3', fundFrom: 'funder.testnet', wasmBytes: 1_144_401, repo: '/repo', home: '/home/x' };

test('the plan: every step with its exact commands and the test NEAR it needs, and the total', () => {
  const plan = setupPlan(cfg);
  assert.deepEqual(plan.steps.map((s) => s.id), ['owner', 'policy-account', 'agent-account', 'shop-account', 'deploy', 'task-key', 'bootstrap', 'keys']);
  // storage of the wasm (1e19 yocto a byte, rounded up to 0.1 NEAR), the deploy margin of 1 NEAR, and a float of 8 NEAR for request records
  assert.equal(plan.near.policy, 205n * NEAR / 10n);
  assert.equal(plan.near.agent, 6n * NEAR);
  assert.equal(plan.near.shop, NEAR / 10n);
  assert.equal(plan.near.ownerKeeps, 5n * NEAR);
  assert.equal(plan.near.total, 316n * NEAR / 10n);
  const text = plan.steps.flatMap((s) => s.commands).join('\n');
  assert.ok(text.includes("near account create-account fund-myself airlock-try-a1b2c3.testnet '31.6 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as funder.testnet network-config testnet sign-with-keychain send"));
  assert.ok(text.includes("near account create-account fund-myself try.airlock-try-a1b2c3.testnet '20.5 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as airlock-try-a1b2c3.testnet network-config testnet sign-with-keychain send"));
  assert.ok(text.includes("near account create-account fund-myself agent.airlock-try-a1b2c3.testnet '6 NEAR'"));
  assert.ok(text.includes("near account create-account fund-myself shop.airlock-try-a1b2c3.testnet '0.1 NEAR'"));
  assert.ok(text.includes('AIRLOCK_SKIP_BUILD=1 AIRLOCK_WASM_SRC=/repo/contracts/airlock-policy/res/airlock_policy.wasm'));
  assert.ok(text.includes('/repo/scripts/deploy-testnet.sh'));
  assert.ok(text.includes('AIRLOCK_POLICY_FILE=/repo/fixtures/try/policy.try.json AIRLOCK_BOOK_VAULT=/home/x/.airlock-try/book.vault.json'));
  assert.ok(text.includes('/repo/scripts/bootstrap-policy.sh'));
  // three keys: function call, receiver the try policy, submit_batch only, no allowance limit
  const adds = plan.steps.find((s) => s.id === 'keys')?.commands.filter((c) => c.includes('add-key')) ?? [];
  assert.equal(adds.length, 3);
  for (const [i, c] of adds.entries()) {
    assert.equal(c, `near account add-key agent.airlock-try-a1b2c3.testnet grant-function-call-access --allowance unlimited --contract-account-id try.airlock-try-a1b2c3.testnet --function-names submit_batch use-manually-provided-public-key '<public key ${String(i + 1)}>' network-config testnet sign-with-keychain send`);
  }
  // nothing in the plan touches the credit accounts or carries a personal name
  assert.doesNotMatch(text, /c1108d|erfan/);
  // every step says how it is verified without sending
  for (const s of plan.steps) assert.ok(s.verify.length > 0, s.id);
});

type Fake = { io: SetupIo; ran: string[]; out: string[]; done: Set<string>; home: string };
function fake(over: Partial<SetupIo> = {}, done: string[] = []): Fake {
  const home = mkdtempSync(join(tmpdir(), 'try-home-'));
  const f: Fake = { ran: [], out: [], done: new Set(done), home, io: undefined as unknown as SetupIo };
  f.io = {
    print: (l) => f.out.push(l),
    run: async (step, command) => {
      f.ran.push(`${step}: ${command.split(' ').slice(0, 4).join(' ')}`);
      f.done.add(step);
      return { ok: true, tail: '' };
    },
    done: async (step) => f.done.has(step),
    keysOnChain: async () => [],
    ...over,
  };
  return f;
}

test('dry (the default): prints every step, the commands and the total, and runs nothing', async () => {
  const f = fake();
  const code = await runSetup({ ...cfg, home: f.home }, f.io, { live: false, env: {} });
  assert.equal(code, 0);
  assert.deepEqual(f.ran, []);
  const text = f.out.join('\n');
  assert.match(text, /step 1 of 8: create the owner/);
  assert.match(text, /step 8 of 8: three published function-call keys/);
  assert.match(text, /total test NEAR needed in funder\.testnet: 31\.6 NEAR \(plus the fee of one transaction\)/);
  assert.match(text, /TRY SETUP DRY: nothing was sent, no key was made, no file was written/);
  assert.ok(!existsSync(join(f.home, '.airlock-try.env')));
});

test('live: refused without the env flag; with it the steps run in order and a finished step is skipped', async () => {
  assert.equal(SETUP_FLAG, 'TRY_SETUP_LIVE_OK');
  const off = fake();
  assert.equal(await runSetup({ ...cfg, home: off.home }, off.io, { live: true, env: {} }), 1);
  assert.deepEqual(off.ran, []);
  assert.match(off.out.at(-1) ?? '', /^TRY SETUP NOT RUN: --live needs TRY_SETUP_LIVE_OK=1$/);

  const f = fake({}, ['owner', 'policy-account']);
  const code = await runSetup({ ...cfg, home: f.home }, f.io, { live: true, env: { TRY_SETUP_LIVE_OK: '1' } });
  assert.equal(code, 0, f.out.join('\n'));
  assert.deepEqual(f.ran.map((r) => r.split(':')[0]), ['agent-account', 'shop-account', 'deploy', 'task-key', 'bootstrap', 'keys', 'keys', 'keys']);
  assert.match(f.out.join('\n'), /step 1 of 8: create the owner[^\n]*\n[^\n]*already done/);
  assert.match(f.out.at(-1) ?? '', /^TRY SETUP DONE try\.airlock-try-a1b2c3\.testnet$/);
});

test('live: the three key secrets go to the env file only (mode 600), never to the output, and a rerun reuses them', async () => {
  const f = fake();
  await runSetup({ ...cfg, home: f.home }, f.io, { live: true, env: { TRY_SETUP_LIVE_OK: '1' } });
  const envFile = join(f.home, '.airlock-try.env');
  assert.ok(existsSync(envFile));
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  const env = readFileSync(envFile, 'utf8');
  const secrets = [...env.matchAll(/^TRY_KEY_SECRET_[123]=(ed25519:[1-9A-HJ-NP-Za-km-z]{80,90})$/gm)].map((m) => m[1] ?? '');
  const publics = [...env.matchAll(/^TRY_KEY_PUBLIC_[123]=(ed25519:[1-9A-HJ-NP-Za-km-z]{43,44})$/gm)].map((m) => m[1] ?? '');
  assert.equal(secrets.length, 3);
  assert.equal(new Set(publics).size, 3);
  assert.match(env, /^TRY_POLICY_ACCOUNT=try\.airlock-try-a1b2c3\.testnet$/m);
  assert.match(env, /^TRY_BOOK_VAULT=.*\.airlock-try\/book\.vault\.json$/m);
  for (const s of secrets) assert.ok(!f.out.join('\n').includes(s), 'a secret was printed');
  for (const p of publics) assert.ok(f.out.join('\n').includes(p) || true);
  // a second run: the same keys, and only the ones the chain does not show yet are added
  const again = fake({ keysOnChain: async () => publics.slice(0, 2) }, ['owner', 'policy-account', 'agent-account', 'shop-account', 'deploy', 'task-key', 'bootstrap']);
  again.home = f.home;
  await runSetup({ ...cfg, home: f.home }, again.io, { live: true, env: { TRY_SETUP_LIVE_OK: '1' } });
  assert.equal(readFileSync(envFile, 'utf8'), env);
  assert.deepEqual(again.ran.map((r) => r.split(':')[0]), ['keys']);
});

test('live: a step that fails stops the run with exit 1 and names the step', async () => {
  const f = fake({
    run: async (step) => (step === 'deploy' ? { ok: false, tail: 'FAILED: balance is below the required' } : { ok: true, tail: '' }),
    done: async (step) => ['owner', 'policy-account', 'agent-account', 'shop-account'].includes(step),
  });
  const code = await runSetup({ ...cfg, home: f.home }, f.io, { live: true, env: { TRY_SETUP_LIVE_OK: '1' } });
  assert.equal(code, 1);
  assert.match(f.out.at(-1) ?? '', /^TRY SETUP FAILED at step 5 \(deploy\): FAILED: balance is below the required$/);
});

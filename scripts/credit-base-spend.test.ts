// AIR-339: the credit card pays a booked merchant on Base Sepolia through MPC, and an injected Base address from an email is held on the
// same card. Offline: the policy file against the strict card policy, the payment request, the worst-case spend, the funding rule, the
// new book vault, and the script's gates (dry sends nothing, live needs both switches). The chain is injected.
//   pnpm tsx --test scripts/credit-base-spend.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { whyNotStrict } from '../runtime/src/credit/strict.ts';
import { ActionRequest, bitsToLabels } from '../runtime/src/dsl/index.ts';
import { Vault } from '../runtime/src/vault/index.ts';
import type { BaseSpendIo } from './credit-base-spend.ts';
import {
  AMOUNT_WEI,
  ASSET,
  CARD,
  LIVE_FLAG,
  MAX_FEE_WEI,
  MERCHANT_EVM,
  MIN_DERIVED_WEI,
  PRIORITY_FEE_WEI,
  baseVaultOf,
  fundingVerdict,
  main,
  paymentPair,
  payeeKey,
  preflightLive,
  worstCaseWei,
} from './credit-base-spend.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = 10n ** 24n;
const MERCHANT_NEAR = 'near:merchant.airlock-credit-c1108d.testnet';
const DERIVED = '0x913d3f6c2afe03fcb03a5721484042c8c5a2e14a';
const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(REPO, rel), 'utf8')) as Record<string, unknown>;
const strictVault = (): Vault => Vault.empty().add({ payee: MERCHANT_NEAR, cap: null, dailyUntrustedBudget: 0n, dailyLimit: 5n * NEAR, label: 'Acme', listed: true });

test('the policy file differs from the strict card policy by exactly the Base asset, the Base merchant entry and the nonce path', () => {
  const strict = readJson('fixtures/credit/card-strict.policy.json');
  const base = readJson('fixtures/credit/card-base.policy.json');
  const sAssets = strict['assets'] as Record<string, unknown>;
  const bAssets = base['assets'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(bAssets).sort(), [...Object.keys(sAssets), 'evm:84532:native'].sort());
  assert.deepEqual(bAssets['near'], sAssets['near']);
  assert.deepEqual(bAssets['evm:84532:native'], {
    symbol: 'ETH.base',
    decimals: 18,
    hard_cap: '5000000000000',
    daily_cap: '10000000000000',
    max_fee_per_gas: '100000000',
    max_gas: '21000',
    quick_task_cap: '10000000000000',
    path: 'credit-card-1',
  });
  const sBook = strict['book'] as Record<string, unknown>[];
  const bBook = base['book'] as Record<string, unknown>[];
  assert.equal(bBook.length, sBook.length + 1);
  assert.deepEqual(bBook.slice(0, sBook.length), sBook);
  // strict like every other entry: no cap for amounts read from text and a budget of 0 (runtime/src/credit/strict.ts)
  assert.deepEqual(bBook[sBook.length], { name: 'merchant_base', key: 'evm:84532:{merchant_evm}', cap: null, daily_untrusted_budget: '0', daily_limit: '5000000000000', label: 'Merchant (Base)', listed: true });
  assert.deepEqual(base['nonce'], { path: 'credit-card-1' });
  const rest = (p: Record<string, unknown>): Record<string, unknown> => {
    const { assets, book, nonce, ...other } = p;
    void assets;
    void book;
    void nonce;
    return other;
  };
  assert.deepEqual(rest(base), rest(strict));
});

test('the payment request: the Base asset, the lowercase merchant key, 0.000001 ETH, 21000 gas, 0.1 gwei max fee, 0.001 gwei priority fee', () => {
  const { req, task } = paymentPair({ id: 'pay', payee: payeeKey(MERCHANT_EVM), recipient: ['Book'], nowMs: 1_800_000_000_000 });
  assert.equal(ActionRequest.parse(req).asset, ASSET);
  assert.equal(req.asset, 'evm:84532:native');
  assert.equal(req.payee, 'evm:84532:0xb8613f9bb188d93caa9d6fd3f8cf9436f671a1eb');
  assert.equal(req.amount, '1000000000000');
  assert.deepEqual(req.evm, { gas_limit: '21000', max_fee_per_gas: '100000000', max_priority_fee_per_gas: '1000000' });
  assert.deepEqual(bitsToLabels(req.labels.recipient), ['Book']);
  assert.deepEqual(bitsToLabels(req.labels.amount), ['Owner']);
  assert.equal(task.contract_id, CARD);
  assert.equal(task.bounds[0]?.payee_key, req.payee);
  assert.equal(task.bounds[0]?.max_total, '1000000000000');
  assert.equal(AMOUNT_WEI, 1_000_000_000_000n);
  assert.equal(MAX_FEE_WEI, 100_000_000n);
  assert.equal(PRIORITY_FEE_WEI, 1_000_000n);
});

test('the worst-case spend of the payment is 3,100,000,000,000 wei by BigInt math', () => {
  assert.equal(worstCaseWei(), 3_100_000_000_000n);
  assert.equal(worstCaseWei(), AMOUNT_WEI + 21_000n * MAX_FEE_WEI);
  assert.ok(MIN_DERIVED_WEI > worstCaseWei());
});

test('preflight and the funding rule fail when the derived balance is under the need', () => {
  const ok = { switches: [], derivedWei: MIN_DERIVED_WEI, derivedNonce: 0n, cardNonce: null, streak: 0, lock: 3, pendingForAgent: 0, maxPending: 3, baseFeeWei: 5_000_000n };
  assert.equal(preflightLive(ok), null);
  const short = preflightLive({ ...ok, derivedWei: MIN_DERIVED_WEI - 1n });
  assert.ok(short !== null && short.includes('derived'), short ?? 'null');
  assert.match(preflightLive({ ...ok, switches: ['target/arena/LIVE_OK'] }) ?? '', /LIVE_OK/);
  assert.match(preflightLive({ ...ok, streak: 2 }) ?? '', /reject streak/);
  assert.match(preflightLive({ ...ok, derivedNonce: 1n }) ?? '', /nonce/);
  // the funding rule of the ticket
  assert.equal(fundingVerdict({ derivedWei: MIN_DERIVED_WEI, contractorWei: 0n, registeredMaxFeeWei: MAX_FEE_WEI, sweepFeeWei: 0n }).state, 'READY');
  assert.equal(fundingVerdict({ derivedWei: 0n, contractorWei: 10_050_399_999_824n, registeredMaxFeeWei: MAX_FEE_WEI, sweepFeeWei: 300_000_000_000n }).state, 'FUND');
  assert.equal(fundingVerdict({ derivedWei: 0n, contractorWei: 3_999_999_999_999n, registeredMaxFeeWei: MAX_FEE_WEI, sweepFeeWei: 0n }).state, 'BLOCKED');
  assert.equal(fundingVerdict({ derivedWei: 0n, contractorWei: 10n ** 16n, registeredMaxFeeWei: 50_000_000_000n, sweepFeeWei: 0n }).state, 'BLOCKED');
  // the sweep keeps 0.000002 ETH and pays its own fee: what lands must still reach the need
  assert.equal(fundingVerdict({ derivedWei: 0n, contractorWei: 6_000_000_000_000n, registeredMaxFeeWei: MAX_FEE_WEI, sweepFeeWei: 300_000_000_000n }).state, 'BLOCKED');
});

test('the injected address differs from the booked one and is absent from the policy file', () => {
  const email = readJson('fixtures/credit/base-spend-email.json');
  const injected = String(email['injected_address']);
  assert.match(injected, /^0x[0-9a-f]{40}$/);
  assert.ok(String(email['body']).includes(injected));
  assert.notEqual(injected, MERCHANT_EVM);
  assert.notEqual(injected, DERIVED);
  const policyText = readFileSync(join(REPO, 'fixtures', 'credit', 'card-base.policy.json'), 'utf8').toLowerCase();
  assert.ok(!policyText.includes(injected.slice(2)));
  const vault = baseVaultOf(strictVault(), readJson('fixtures/credit/card-base.policy.json'), MERCHANT_EVM);
  assert.ok(!vault.has(payeeKey(injected)));
  assert.ok(vault.has(payeeKey(MERCHANT_EVM)));
});

test('the new book vault is the strict vault plus the Base merchant, still strict, with the NEAR merchant kept at index 0 and unchanged', () => {
  const old = strictVault();
  const next = baseVaultOf(old, readJson('fixtures/credit/card-base.policy.json'), MERCHANT_EVM);
  assert.equal(whyNotStrict(next), null);
  assert.equal(next.entries.length, 2);
  assert.deepEqual(next.entries[0], old.entries[0]);
  assert.equal(next.entries[1]?.payee, 'evm:84532:0xb8613f9bb188d93caa9d6fd3f8cf9436f671a1eb');
  assert.equal(next.entries[1]?.daily_limit, '5000000000000');
  assert.notEqual(next.root(), old.root());
  // a vault that already holds the Base merchant is returned as it is (a rerun keeps the root the card holds)
  assert.equal(baseVaultOf(next, readJson('fixtures/credit/card-base.policy.json'), MERCHANT_EVM).root(), next.root());
});

type Counts = { send: number; broadcast: number; sweep: number; agent: number };
function fakeIo(over: Partial<{ switches: string[]; derivedWei: bigint }> = {}): { io: BaseSpendIo; counts: Counts; lines: string[] } {
  const counts: Counts = { send: 0, broadcast: 0, sweep: 0, agent: 0 };
  const lines: string[] = [];
  const root = strictVault().root();
  const views: Record<string, unknown> = {
    get_policy: { owner_id: 'airlock-credit-c1108d.testnet', mpc_contract_id: 'v1.signer-prod.testnet', paused: false, flags: { max_pending_per_agent: 3 } },
    get_roles: { owner_id: 'airlock-credit-c1108d.testnet', approver: 'borrower.airlock-credit-c1108d.testnet', sponsor: 'pool.airlock-credit-c1108d.testnet' },
    list_assets: [['near', { symbol: 'NEAR' }]],
    get_asset: null,
    get_book_root: root,
    get_book_epoch: '2',
    get_nonce: null,
    get_pending: [],
    get_escalation_state: { pending: 0, consecutive_rejects: 0, rejects_today: 0, locked: false, hour_count: 0, limits: { max_pending: 3, lock_consecutive: 3, lock_per_day: 20, hourly_budget: 6 } },
    get_task_key: 'ed25519:11111111111111111111111111111111',
  };
  const io: BaseSpendIo = {
    view: async (_contract, method) => views[method] ?? null,
    nearBalance: async () => NEAR,
    eth: async (method, params) => {
      if (method === 'eth_getBalance') return String(params[0]).toLowerCase() === DERIVED ? `0x${(over.derivedWei ?? 0n).toString(16)}` : '0x0';
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_gasPrice') return '0x5b8d80';
      if (method === 'eth_maxPriorityFeePerGas') return '0xf4240';
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x4c4b40', number: '0x10' };
      if (method === 'eth_chainId') return '0x14a34';
      return null;
    },
    derive: async (contract) => (contract === CARD ? '0x913d3F6c2AfE03fcb03A5721484042C8C5a2E14a' : '0xB8613f9BB188D93cAa9D6Fd3F8CF9436F671a1EB'),
    switches: () => over.switches ?? [],
    weather: async () => 'SIGNER WEATHER GOOD n=40 p50=4.0s p90=6.0s failed=0 (0.0%) window=60m domain=0 signer=v1.signer-prod.testnet',
    strictVault: () => ({ path: '/fake/book.vault.strict.json', vault: strictVault() }),
    bootstrapVerify: async () => ({ code: 1, out: 'DRIFT asset evm:84532:native field present expected yes got no\nDRIFT assets field ids expected evm:84532:native,near got near\nDRIFT book field root expected a got b\nDRIFT nonce field get_nonce expected at least 0 got null\nPOLICY DRIFT: 4 difference(s) from fixtures/policy.json' }),
    send: async () => {
      counts.send += 1;
      return { ok: true, tx: 'T'.repeat(44), out: '' };
    },
    broadcast: async () => {
      counts.broadcast += 1;
      return { hash: `0x${'1'.repeat(64)}`, status: 'success' };
    },
    sweep: async () => {
      counts.sweep += 1;
      return { code: 0, out: '' };
    },
    agent: async () => {
      counts.agent += 1;
      throw new Error('the fake has no agent');
    },
    log: (l) => lines.push(l),
  };
  return { io, counts, lines };
}

test('dry mode (the default) reads, prints every planned step, calls send, broadcast, sweep and the agent zero times, and ends DRY RUN nothing sent', async () => {
  const f = fakeIo();
  const code = await main([], { io: f.io, env: {} });
  assert.equal(code, 0);
  assert.deepEqual(f.counts, { send: 0, broadcast: 0, sweep: 0, agent: 0 });
  assert.equal(f.lines.at(-1), 'DRY RUN nothing sent');
  const text = f.lines.join('\n');
  for (const m of ['asset_set', 'book_set_root', 'set_nonce', 'submit_batch', 'approve', 'reject', 'sweep', 'LIVE_OK', 'eth_sendRawTransaction']) assert.ok(text.includes(m), `the plan names ${m}`);
  assert.match(text, /FUNDING (READY|FUND|BLOCKED)/);
  assert.match(text, /CARD VIEWS UNCHANGED/);
  assert.match(text, /BASE NONCES UNCHANGED/);
});

test('live exits 2 unless both --live and BASE_SPEND_LIVE=1 are given, and sends nothing then', async () => {
  for (const [argv, env] of [
    [['--live'], {}],
    [['--live'], { [LIVE_FLAG]: '0' }],
    [['--live'], { [LIVE_FLAG]: 'yes' }],
  ] as const) {
    const f = fakeIo();
    assert.equal(await main([...argv], { io: f.io, env: { ...env } }), 2);
    assert.deepEqual(f.counts, { send: 0, broadcast: 0, sweep: 0, agent: 0 });
  }
  // the env flag alone is a dry run
  const dry = fakeIo();
  assert.equal(await main([], { io: dry.io, env: { [LIVE_FLAG]: '1' } }), 0);
  assert.equal(dry.lines.at(-1), 'DRY RUN nothing sent');
  // both given, but a live switch still exists: the preflight stops before any call
  const sw = fakeIo({ switches: ['target/arena/LIVE_OK'], derivedWei: MIN_DERIVED_WEI });
  const code = await main(['--live'], { io: sw.io, env: { [LIVE_FLAG]: '1' } });
  assert.equal(code, 1);
  assert.deepEqual(sw.counts, { send: 0, broadcast: 0, sweep: 0, agent: 0 });
  assert.match(sw.lines.at(-1) ?? '', /^BASE SPEND NOT SENT .*LIVE_OK/);
});

test('--verify fails clearly while the live rows do not exist', async () => {
  const f = fakeIo();
  const code = await main(['--verify', '--rows', join(REPO, 'target', 'credit-base', 'no-such-rows.json')], { io: f.io, env: {} });
  assert.equal(code, 1);
  assert.match(f.lines.at(-1) ?? '', /^BASE SPEND VERIFY NO /);
  assert.deepEqual(f.counts, { send: 0, broadcast: 0, sweep: 0, agent: 0 });
});

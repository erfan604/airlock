// AIR-355: strict mode on the credit card. The strict fixture, the strict copy of a vault (a new file, the old one untouched), the plan
// (dry: nothing is sent), the one owner call of the live path and its refusals, and the read-only verification. Offline: the chain is injected.
//   pnpm tsx --test scripts/credit-strict.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STRICT_FLAG, bookSetRootCommand, planStrict, sendStrict, shellLine, strictVaultOf, verifyStrict, whyNotStrict } from '../runtime/src/credit/strict.ts';
import { pickVault, vaultCandidates } from '../runtime/src/credit/vaults.ts';
import type { StrictIo } from '../runtime/src/credit/strict.ts';
import { bitsToLabels } from '../runtime/src/dsl/index.ts';
import { loadVault, saveVault } from '../runtime/src/vault/file.ts';
import { Vault, proofVerifies } from '../runtime/src/vault/index.ts';
import { main } from './credit-strict.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEAR = 10n ** 24n;
const CARD = 'card.airlock-credit-c1108d.testnet';
const OWNER = 'airlock-credit-c1108d.testnet';
const AGENT = 'agent.airlock-credit-c1108d.testnet';
const MERCHANT = 'near:merchant.airlock-credit-c1108d.testnet';

/** The card's book as the quickstart fixture made it: the merchant with a 1 NEAR cap for amounts read from text. */
const oldVault = (): Vault => Vault.empty().add({ payee: MERCHANT, cap: NEAR, dailyUntrustedBudget: 2n * NEAR, dailyLimit: 5n * NEAR, label: 'Acme', listed: true });

type Fake = { io: StrictIo; sent: { expected_old: string; new_root: string }[]; previews: { amount: string[]; hasProof: boolean; payee: string }[]; lines: string[]; chain: { root: string; epoch: bigint; paused: boolean; pending: number } };
function fake(root: string, over: Partial<{ paused: boolean; pending: number; answers: { outcome: string; reason: string | null }[]; keepRoot: boolean }> = {}): Fake {
  const chain = { root, epoch: 1n, paused: over.paused ?? true, pending: over.pending ?? 0 };
  const f: Fake = { sent: [], previews: [], lines: [], chain, io: undefined as unknown as StrictIo };
  const answers = [...(over.answers ?? [{ outcome: 'escalated', reason: 'UntrustedAmount' }, { outcome: 'allowed', reason: null }])];
  f.io = {
    bookRoot: async () => chain.root,
    bookEpoch: async () => chain.epoch,
    paused: async () => chain.paused,
    pendingCount: async () => chain.pending,
    rejectStreak: async () => ({ streak: 2, lock: 3 }),
    blockMs: async () => 1_800_000_000_000,
    preview: async (req) => {
      f.previews.push({ amount: bitsToLabels(req.labels.amount), hasProof: req.book !== null && proofVerifies(chain.root, req.payee, req.book), payee: req.payee });
      return answers.shift() ?? { outcome: 'blocked', reason: 'none left' };
    },
    send: async (args) => {
      f.sent.push(args);
      if (over.keepRoot !== true) {
        chain.root = args.new_root;
        chain.epoch += 1n;
      }
      return 'TX'.padEnd(44, '1');
    },
    log: (l) => f.lines.push(l),
  };
  return f;
}

test('the strict fixture differs from the quickstart fixture only at the cap and the budget of the booked merchant', () => {
  const quick = JSON.parse(readFileSync(join(REPO, 'fixtures', 'quickstart', 'policy.json'), 'utf8')) as { book: Record<string, unknown>[] };
  const strict = JSON.parse(readFileSync(join(REPO, 'fixtures', 'credit', 'card-strict.policy.json'), 'utf8')) as { book: Record<string, unknown>[] };
  assert.equal(strict.book.length, 1);
  assert.equal(strict.book[0]?.['cap'], null);
  assert.equal(strict.book[0]?.['daily_untrusted_budget'], '0');
  const back = structuredClone(strict);
  (back.book[0] as Record<string, unknown>)['cap'] = quick.book[0]?.['cap'];
  (back.book[0] as Record<string, unknown>)['daily_untrusted_budget'] = quick.book[0]?.['daily_untrusted_budget'];
  assert.deepEqual(back, quick);
});

test('the strict copy of a vault: every payee kept, no cap, no budget, the old vault untouched', () => {
  const old = oldVault();
  const before = JSON.stringify(old.toJSON());
  assert.match(whyNotStrict(old) ?? '', /entry 1 of 1 has a cap/);
  const strict = strictVaultOf(old);
  assert.equal(whyNotStrict(strict), null);
  assert.equal(JSON.stringify(old.toJSON()), before);
  assert.notEqual(strict.root(), old.root());
  const [e] = strict.entries;
  assert.deepEqual({ payee: e?.payee, cap: e?.cap, budget: e?.daily_untrusted_budget, limit: e?.daily_limit, label: e?.label, listed: e?.listed }, { payee: MERCHANT, cap: null, budget: '0', limit: (5n * NEAR).toString(), label: 'Acme', listed: true });
  assert.notEqual(e?.salt, old.entries[0]?.salt, 'a changed entry gets a new salt');
  // a vault that is already strict is returned as it is, so a second run plans the same root
  assert.equal(strictVaultOf(strict).root(), strict.root());
  assert.doesNotMatch(whyNotStrict(old) ?? '', /merchant|near:/, 'the reason names no payee');
});

test('the plan (dry): old root, new root, the exact owner call, what changes, and nothing is sent', async () => {
  const old = oldVault();
  const next = strictVaultOf(old);
  const f = fake(old.root());
  const plan = await planStrict({ io: f.io, oldVault: old, newVault: next, card: CARD, owner: OWNER, agent: AGENT, switches: [] });
  assert.equal(f.sent.length, 0);
  assert.equal(plan.notReady, null);
  assert.deepEqual(plan.call, { expected_old: old.root(), new_root: next.root() });
  const text = plan.lines.join('\n');
  assert.match(text, new RegExp(`old root ${old.root()}`));
  assert.match(text, new RegExp(`new root ${next.root()}`));
  assert.match(text, /epoch 1, becomes 2/);
  assert.match(text, /1 of 1 entries change/);
  assert.match(text, /reject streak 2 of 3/);
  assert.ok(text.includes(shellLine('near', bookSetRootCommand(CARD, OWNER, plan.call))));
  assert.ok(text.includes(`json-args '{"expected_old":"${old.root()}","new_root":"${next.root()}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR'`), 'the printed call can be pasted into a shell');
  assert.doesNotMatch(text, /merchant\.|[0-9a-f]{64}.*salt/, 'no payee and no salt is printed');
});

test('the owner call is the one book_set_root transaction of the design', () => {
  const args = bookSetRootCommand(CARD, OWNER, { expected_old: 'a'.repeat(64), new_root: 'b'.repeat(64) });
  assert.deepEqual(args, ['contract', 'call-function', 'as-transaction', CARD, 'book_set_root', 'json-args', `{"expected_old":"${'a'.repeat(64)}","new_root":"${'b'.repeat(64)}"}`, 'prepaid-gas', '100 Tgas', 'attached-deposit', '1 yoctoNEAR', 'sign-as', OWNER, 'network-config', 'testnet', 'sign-with-keychain', 'send']);
});

test('the plan says why the change cannot be sent: a stale old vault, a held request, a live switch, an already strict card', async () => {
  const old = oldVault();
  const next = strictVaultOf(old);
  const args = { oldVault: old, newVault: next, card: CARD, owner: OWNER, agent: AGENT, switches: [] as string[] };
  assert.match((await planStrict({ ...args, io: fake('f'.repeat(64)).io })).notReady ?? '', /old vault is not the book the card holds/);
  assert.match((await planStrict({ ...args, io: fake(old.root(), { pending: 1 }).io })).notReady ?? '', /1 request is held on the card: expire it first, never reject/);
  assert.match((await planStrict({ ...args, io: fake(old.root()).io, switches: ['target/arena/LIVE_OK'] })).notReady ?? '', /target\/arena\/LIVE_OK exists/);
  assert.match((await planStrict({ ...args, io: fake(next.root()).io })).notReady ?? '', /the card already holds the strict root/);
});

test('live: refused without the env flag, refused when not ready, otherwise exactly one book_set_root and the chain is read back', async () => {
  const old = oldVault();
  const next = strictVaultOf(old);
  const args = { oldVault: old, newVault: next, card: CARD, owner: OWNER, agent: AGENT, switches: [] as string[] };
  assert.equal(STRICT_FLAG, 'CREDIT_STRICT_LIVE_OK');
  const off = fake(old.root());
  assert.match((await sendStrict({ ...args, io: off.io, flag: false })).line, /^CREDIT STRICT NOT SENT .*CREDIT_STRICT_LIVE_OK=1/);
  assert.equal(off.sent.length, 0);
  const held = fake(old.root(), { pending: 2 });
  const refused = await sendStrict({ ...args, io: held.io, flag: true });
  assert.equal(refused.code, 1);
  assert.match(refused.line, /^CREDIT STRICT NOT SENT 2 requests are held/);
  assert.equal(held.sent.length, 0);
  const ok = fake(old.root());
  const sent = await sendStrict({ ...args, io: ok.io, flag: true });
  assert.deepEqual(ok.sent, [{ expected_old: old.root(), new_root: next.root() }]);
  assert.equal(sent.code, 0);
  assert.match(sent.line, new RegExp(`^CREDIT STRICT SENT TX1+ root ${next.root()} epoch 2$`));
  const stuck = fake(old.root(), { keepRoot: true });
  const bad = await sendStrict({ ...args, io: stuck.io, flag: true });
  assert.equal(bad.code, 1);
  assert.match(bad.line, /^CREDIT STRICT FAILED .*the card still holds another root/);
});

test('verify: a vault with a cap, or a root that is not the card root, is not strict', async () => {
  const old = oldVault();
  const withCap = await verifyStrict({ io: fake(old.root()).io, vault: old, card: CARD, agent: AGENT });
  assert.equal(withCap.code, 1);
  assert.match(withCap.line, /^CREDIT STRICT NO entry 1 of 1 has a cap/);
  const strict = strictVaultOf(old);
  const other = await verifyStrict({ io: fake(old.root()).io, vault: strict, card: CARD, agent: AGENT });
  assert.equal(other.code, 1);
  assert.match(other.line, /^CREDIT STRICT NO the vault root is not the root the card holds/);
});

test('verify on a paused card: the preview is skipped and the line says so', async () => {
  const strict = strictVaultOf(oldVault());
  const f = fake(strict.root(), { paused: true });
  const v = await verifyStrict({ io: f.io, vault: strict, card: CARD, agent: AGENT });
  assert.equal(v.code, 0);
  assert.equal(v.line, `CREDIT STRICT OK root ${strict.root()} epoch 1 (preview skipped: card paused)`);
  assert.equal(f.previews.length, 0);
  assert.equal(f.sent.length, 0);
});

test('verify on a running card: an amount read from text must be held and an owner amount allowed, each with the vault proof', async () => {
  const strict = strictVaultOf(oldVault());
  const f = fake(strict.root(), { paused: false });
  const v = await verifyStrict({ io: f.io, vault: strict, card: CARD, agent: AGENT });
  assert.equal(v.line, `CREDIT STRICT OK root ${strict.root()} epoch 1`);
  assert.deepEqual(f.previews, [
    { amount: ['Untrusted:email'], hasProof: true, payee: MERCHANT },
    { amount: ['Owner'], hasProof: true, payee: MERCHANT },
  ]);
  for (const answers of [
    [{ outcome: 'allowed', reason: null }, { outcome: 'allowed', reason: null }],
    [{ outcome: 'escalated', reason: 'NewRecipient' }, { outcome: 'allowed', reason: null }],
    [{ outcome: 'escalated', reason: 'UntrustedAmount' }, { outcome: 'escalated', reason: 'NewRecipient' }],
  ]) {
    const bad = await verifyStrict({ io: fake(strict.root(), { paused: false, answers }).io, vault: strict, card: CARD, agent: AGENT });
    assert.equal(bad.code, 1);
    assert.match(bad.line, /^CREDIT STRICT NO the card answered /);
  }
  assert.equal(f.sent.length, 0);
});

test('the script: dry by default writes the strict vault as a new file, leaves the old one as it was, and sends nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'strict-'));
  const oldPath = join(dir, 'book.vault.json');
  const old = oldVault();
  saveVault(old, oldPath);
  const before = readFileSync(oldPath, 'utf8');
  const f = fake(old.root());
  const out: string[] = [];
  const code = await main(['--vault', oldPath], { io: f.io, env: {}, print: (l) => out.push(l), switches: () => [] });
  assert.equal(code, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(readFileSync(oldPath, 'utf8'), before);
  const strictPath = join(dir, 'book.vault.strict.json');
  assert.ok(existsSync(strictPath));
  assert.equal(whyNotStrict(loadVault(strictPath)), null);
  assert.match(out.join('\n'), /CREDIT STRICT DRY: nothing was sent/);
  assert.ok(out.join('\n').includes(strictPath), 'the path the arena and the credit scripts must use is printed');
  // a second run plans the same root from the file it wrote
  const again: string[] = [];
  await main(['--vault', oldPath], { io: fake(old.root()).io, env: {}, print: (l) => again.push(l), switches: () => [] });
  assert.equal(loadVault(strictPath).root(), /new root ([0-9a-f]{64})/.exec(again.join('\n'))?.[1]);
  // live without the env flag sends nothing; with it, one call
  assert.equal(await main(['--vault', oldPath, '--live'], { io: f.io, env: {}, print: () => undefined, switches: () => [] }), 1);
  assert.equal(f.sent.length, 0);
  assert.equal(await main(['--vault', oldPath, '--live'], { io: f.io, env: { CREDIT_STRICT_LIVE_OK: '1' }, print: () => undefined, switches: () => [] }), 0);
  assert.equal(f.sent.length, 1);
  // verify reads the strict vault next to the old one
  const lines: string[] = [];
  assert.equal(await main(['--vault', oldPath, '--verify'], { io: f.io, env: {}, print: (l) => lines.push(l), switches: () => [] }), 0);
  assert.match(lines.at(-1) ?? '', /^CREDIT STRICT OK root [0-9a-f]{64} epoch 2 \(preview skipped: card paused\)$/);
  assert.equal(await main(['--bogus'], { io: f.io, env: {}, print: () => undefined, switches: () => [] }), 2);
});

test('vault choice: the strict vault first, then the old one, and only a vault whose root is the card root is used', () => {
  assert.deepEqual(vaultCandidates('/repo', undefined), [
    '/repo/target/arena/book.vault.strict.json',
    '/repo/target/arena/book.vault.json',
    '/repo/target/credit-run/book.vault.strict.json',
    '/repo/target/credit-run/book.vault.json',
  ]);
  assert.deepEqual(vaultCandidates('/repo', '/x/v.json'), ['/x/v.json']);
  const strict = { path: '/repo/target/arena/book.vault.strict.json', root: 'b'.repeat(64) };
  const old = { path: '/repo/target/credit-run/book.vault.json', root: 'a'.repeat(64) };
  // before the root change the card holds the old book: the strict file is there and is passed over
  assert.deepEqual(pickVault([strict, old], 'a'.repeat(64)), { path: old.path });
  // after it, the strict vault is the one
  assert.deepEqual(pickVault([strict, old], 'b'.repeat(64)), { path: strict.path });
  const none = pickVault([strict, old], 'c'.repeat(64));
  assert.ok('refuse' in none);
  assert.match(none.refuse, /none of the 2 book vault files is the book the card holds/);
  const missing = pickVault([], 'c'.repeat(64));
  assert.ok('refuse' in missing);
  assert.match(missing.refuse, /no book vault file was found/);
  const broken = pickVault([{ path: '/x/v.json', root: null }], 'c'.repeat(64));
  assert.ok('refuse' in broken);
  assert.match(broken.refuse, /cannot be read/);
});

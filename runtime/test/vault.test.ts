// AIR-326: the owner's private book. The tree matches the contract's byte for byte (the vector is also pinned in
// contracts/airlock-policy/src/book.rs), a request to a booked payee always carries its proof, the vault refuses a duplicate leaf, and the
// owner's surface flags a booked payee that arrived without a proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, VaultError, buildTree, proofVerifies, withheldProofNotice } from '../src/vault/index.ts';
import { loadVault, saveVault } from '../src/vault/file.ts';
import { ChainClient } from '../src/chain/near.ts';
import { ChainError } from '../src/chain/errors.ts';
import { ScriptedTransport, okTx, req, sig, task } from './helpers/chain-double.ts';

const ONE = 1_000_000_000_000_000_000_000_000n;
const ALICE = 'near:alice.test.near';
const BOB = 'near:bob.test.near';
const entry = (payee: string, label = 'x', over: Partial<{ cap: bigint | null; listed: boolean }> = {}) => ({
  payee,
  cap: over.cap === undefined ? 100n * ONE : over.cap,
  dailyUntrustedBudget: 1000n * ONE,
  dailyLimit: 5000n * ONE,
  label,
  ...(over.listed === undefined ? {} : { listed: over.listed }),
});

test('the tree equals the contract: the same three entries and seed give the same root and path', () => {
  const es = [0, 1, 2].map((i) => ({
    salt: new Uint8Array(32).fill(i + 1),
    payee: `near:payee${String(i).padStart(3, '0')}.test.near`,
    cap: i % 2 === 0 ? BigInt(100 + i) : null,
    budget: BigInt(1000 + i),
    limit: BigInt(5000 + i),
  }));
  const b = buildTree(es, new Uint8Array(32).fill(9));
  assert.equal(Buffer.from(b.root).toString('hex'), '06a143a32025ed470b890fcfdd8d4f14279bf1b410f7b319be8830f5c2f8d2a9');
  assert.equal(Buffer.from(b.proofs[1]?.siblings[0] as Uint8Array).toString('hex'), 'f2ddf0ad63aa6cdc78a93e75e016fc54a792eda756f9eff9b819d4d38bb9f0b3');
});

test('every entry has a proof that verifies for its own payee only, and a changed number or another payee fails', () => {
  const v = Vault.empty().add(entry(ALICE, 'Alice')).add(entry(BOB, 'Bob', { cap: null }));
  const root = v.root();
  for (const e of v.entries) assert.ok(proofVerifies(root, e.payee, v.proofFor(e.payee)!));
  const p = v.proofFor(ALICE)!;
  assert.equal(proofVerifies(root, BOB, p), false);
  assert.equal(proofVerifies(root, ALICE, { ...p, cap: '1' }), false);
  assert.equal(proofVerifies(root, ALICE, { ...p, index: p.index ^ 1 }), false);
  assert.equal(proofVerifies(root, ALICE, { ...p, siblings: p.siblings.slice(1) }), false);
  assert.equal(v.proofFor('near:nobody.test.near'), null);
});

test('the root hides the count: filler seeds change it, an add changes it, a removal brings the old entries back to their proofs', () => {
  const a = Vault.empty();
  const b = Vault.empty();
  assert.notEqual(a.root(), b.root());
  const one = a.add(entry(ALICE));
  assert.notEqual(one.root(), a.root());
  const two = one.add(entry(BOB));
  const back = two.remove(BOB);
  assert.equal(back.root(), one.root());
  assert.equal(proofVerifies(back.root(), ALICE, back.proofFor(ALICE)!), true);
  assert.equal(back.proofFor(BOB), null);
});

test('the vault refuses a duplicate payee, a non-canonical key, a 257th entry and an unknown removal', () => {
  const v = Vault.empty().add(entry(ALICE));
  assert.throws(() => v.add(entry(ALICE)), (e) => e instanceof VaultError && e.code === 'Duplicate');
  assert.throws(() => v.add(entry('near:Alice.TEST.near')), (e) => e instanceof VaultError && e.code === 'BadKey');
  assert.throws(() => v.remove(BOB), (e) => e instanceof VaultError && e.code === 'Unknown');
  let full = Vault.empty();
  for (let i = 0; i < 256; i++) full = full.add(entry(`near:p${String(i).padStart(3, '0')}.test.near`));
  assert.throws(() => full.add(entry(BOB)), (e) => e instanceof VaultError && e.code === 'Full');
});

test('the file round trips with the same root and is written with mode 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'));
  const path = join(dir, 'book.vault.json');
  const v = Vault.empty().add(entry(ALICE, 'Alice')).add(entry(BOB, 'Bob'));
  saveVault(v, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadVault(path).root(), v.root());
  assert.throws(() => Vault.parse({ version: 1 }), (e) => e instanceof VaultError && e.code === 'BadFile');
});

test('rows keep the shape the interpreter reads, and listedAliases holds only what the owner marked', () => {
  const v = Vault.empty().add(entry(ALICE, 'Alice', { listed: true })).add(entry(BOB, 'Bob'));
  assert.deepEqual(v.rows()[0], [ALICE, { cap: (100n * ONE).toString(), daily_untrusted_budget: (1000n * ONE).toString(), daily_limit: (5000n * ONE).toString(), label: 'Alice' }]);
  assert.deepEqual(v.listedAliases(), ['Alice']);
});

// ---- the owner side (item 3b and 3c of the withheld proofs round) ----

test('approve and remember: a payee already in the book is refused and the owner is told to use plain approve', () => {
  const v = Vault.empty().add(entry(ALICE, 'Alice'));
  assert.throws(
    () => v.prepareRemember(entry(ALICE, 'Alice again')),
    (e) => e instanceof VaultError && e.code === 'Duplicate' && /plain approve/.test(e.message),
  );
});

test('approve and remember: a new payee gets the old root, the new root and a path that verifies against the new root', () => {
  const v = Vault.empty().add(entry(ALICE, 'Alice'));
  const r = v.prepareRemember(entry(BOB, 'Bob'));
  assert.equal(r.expected_old, v.root());
  assert.equal(r.new_root, r.next.root());
  assert.equal(proofVerifies(r.new_root, BOB, r.entry), true);
  assert.equal(proofVerifies(r.expected_old, BOB, r.entry), false);
  assert.equal(r.next.has(BOB), true);
  assert.equal(v.has(BOB), false, 'the vault is immutable until the owner saves the next one');
});

test('the owner surface flags a booked payee whose escalation says new, and nothing else', () => {
  const v = Vault.empty().add(entry(ALICE, 'Alice'));
  assert.match(withheldProofNotice(v, ALICE, 'new') ?? '', /in your book, but the agent sent no proof/);
  assert.match(withheldProofNotice(v, ALICE, 'new') ?? '', /compromised/);
  assert.equal(withheldProofNotice(v, ALICE, 'in_book'), null);
  assert.equal(withheldProofNotice(v, BOB, 'new'), null, 'a payee that is not in the book is just new');
  assert.equal(withheldProofNotice(v, ALICE, null), null);
});

// ---- the chain client (item 3a): a request to a booked payee always carries its proof ----

function clientWith(v: Vault | undefined, chainRoot: string): { t: ScriptedTransport; client: ChainClient } {
  const t = new ScriptedTransport();
  t.answers.set('get_book_root', chainRoot);
  t.answers.set('get_ledgers', { asset_day: null });
  t.submitSteps.push(() => okTx([0, 1]));
  const client = new ChainClient({ network: 'testnet', contractId: 'policy.test.near', agentAccountId: 'agent.test.near', transport: t, pollMs: 5, windowMs: 100, ...(v === undefined ? {} : { vault: v }) });
  return { t, client };
}

test('submitBatch attaches the proof of a booked payee and null for any other payee', async () => {
  const v = Vault.empty().add(entry(ALICE, 'Alice'));
  const { t, client } = clientWith(v, v.root());
  await client.submitBatch([req(0, { payee: ALICE }), req(1, { payee: 'near:stranger.test.near' })], task, sig);
  const sent = (t.lastArgs as { reqs: Array<{ payee: string; book: unknown }> }).reqs;
  assert.deepEqual(sent[0]?.book, v.proofFor(ALICE));
  assert.equal(sent[1]?.book, null);
});

test('without a vault the request is sent exactly as before (no book field)', async () => {
  const { t, client } = clientWith(undefined, '0'.repeat(64));
  await client.submitBatch([req(0), req(1)], task, sig);
  const sent = (t.lastArgs as { reqs: Array<Record<string, unknown>> }).reqs;
  assert.equal('book' in (sent[0] as object), false);
});

test('getBook returns the vault rows when the chain root matches, and refuses a stale vault', async () => {
  const v = Vault.empty().add(entry(ALICE, 'Alice'));
  const ok = clientWith(v, v.root());
  assert.deepEqual(await ok.client.getBook(), v.rows());
  const stale = clientWith(v, 'f'.repeat(64));
  await assert.rejects(stale.client.getBook(), (e) => e instanceof ChainError && e.code === 'BookStale');
});

test('getLedgers sends the proof of a booked payee', async () => {
  const v = Vault.empty().add(entry(ALICE, 'Alice'));
  const { t, client } = clientWith(v, v.root());
  await client.getLedgers(ALICE, 'near').catch(() => undefined);
  const call = t.viewCalls.find((c) => c.method === 'get_ledgers');
  assert.deepEqual(call?.args.book, v.proofFor(ALICE));
});

test('listedAliases is null without a vault and the owner listing with one', () => {
  assert.equal(clientWith(undefined, '0'.repeat(64)).client.listedAliases(), null);
  const v = Vault.empty().add(entry(ALICE, 'Alice', { listed: true })).add(entry(BOB, 'Bob'));
  assert.deepEqual(clientWith(v, v.root()).client.listedAliases(), ['Alice']);
});

test('the CLI notice reads payee and book_status from the stored request view', async () => {
  const { noticeFromRequestView } = await import('../src/vault/index.ts');
  const v = Vault.empty().add(entry(ALICE, 'Alice'));
  assert.match(noticeFromRequestView(v, { payee: ALICE, book_status: 'new' }) ?? '', /agent sent no proof/);
  assert.equal(noticeFromRequestView(v, { payee: ALICE, book_status: 'in_book' }), null);
  assert.equal(noticeFromRequestView(v, null), null);
  assert.equal(noticeFromRequestView(v, { book_status: 'new' }), null);
});

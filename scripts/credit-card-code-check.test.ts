// The two live cards run the committed bytes (scripts/credit-card-code-check.ts). Offline: the code hash of the two committed wasm files,
// the snapshot comparison against the committed snapshots of both cards, and the redeploy check against the recorded shape of the
// 2026-11-12 transactions, each with one field broken; a full run on fake chain answers. Nothing here touches a network.
//   pnpm tsx --test scripts/credit-card-code-check.test.ts
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CARDS, NEW_HASH, OLD_HASH, OLD_WASM, WASM, checkCardRedeploy, checkCardSnapshots, run } from './credit-card-code-check.ts';
import type { Deps } from './credit-card-code-check.ts';
import { codeHash } from './credit-pool-code-check.ts';
import type { Tx } from './credit-pool-code-check.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = (p: string): Buffer => readFileSync(join(REPO, p));
const json = (p: string): Record<string, unknown> => JSON.parse(file(p).toString('utf8')) as Record<string, unknown>;
/** the code field of the redeploy's DeployContract action (base64 of the sha256 of the committed wasm) */
const DEPLOYED = 'Wz5jypb8JhWogZzoYkBFW19GGNr1goXxAcD+Gv9YOi4=';
const delta = (): number => statSync(join(REPO, WASM)).size - statSync(join(REPO, OLD_WASM)).size;
const card = CARDS[0];
const tryCard = CARDS[1];
if (card === undefined || tryCard === undefined) throw new Error('two cards');
const deploy = (c: typeof card, over: Partial<Tx> = {}): Tx => ({ signer: c.account, receiver: c.account, actions: [{ DeployContract: { code: DEPLOYED } }], status: { SuccessValue: '' }, logs: [], blockHash: `h-${c.tx}`, ...over });

test('the code hash of each committed wasm is the one the chain shows', () => {
  const now = codeHash(file(WASM));
  assert.equal(now.sha256, '5b3e63ca96fc2615a8819ce86240455b5f4618daf58285f101c0fe1aff583a2e');
  assert.equal(now.base58, NEW_HASH);
  assert.equal(now.base64, DEPLOYED);
  assert.equal(codeHash(file(OLD_WASM)).sha256, '4deda2c541cf97b7e23332743890fedf4161e5135eb7637c90683d66109fc9a3');
  assert.equal(codeHash(file(OLD_WASM)).base58, OLD_HASH);
});

test('the committed snapshots of both cards pass, and a changed state, view, key or storage figure fails', () => {
  assert.equal(delta(), 916);
  for (const c of CARDS) {
    const b = json(c.before);
    const a = json(c.after);
    assert.deepEqual(checkCardSnapshots(c, b, a, delta()), [], c.account);
    assert.match(checkCardSnapshots(c, b, { ...a, state_sha256: '0'.repeat(64) }, delta()).join(' '), /raw state hash changed/);
    assert.match(checkCardSnapshots(c, b, { ...a, views: { ...(a['views'] as object), get_pending: [{ id: '1' }] } }, delta()).join(' '), /view answer changed/);
    assert.match(checkCardSnapshots(c, b, { ...a, keys: [] }, delta()).join(' '), /key kinds changed/);
    assert.match(checkCardSnapshots(c, b, a, delta() + 1).join(' '), /storage_usage moved/);
    assert.match(checkCardSnapshots(c, b, { ...a, code_hash: OLD_HASH }, delta()).join(' '), /snapshot after runs/);
    assert.match(checkCardSnapshots({ ...c, block: 1 }, b, a, delta()).join(' '), /do not bracket/);
  }
  // one card's snapshot does not pass for the other
  assert.match(checkCardSnapshots(tryCard, json(card.before), json(card.after), delta()).join(' '), /another account/);
});

test('the redeploy check: the card to itself, one DeployContract of the committed code, success', () => {
  assert.deepEqual(checkCardRedeploy(card, deploy(card), DEPLOYED), []);
  assert.match(checkCardRedeploy(card, deploy(card, { signer: 'airlock-credit-c1108d.testnet' }), DEPLOYED).join(' '), /not by card/);
  assert.match(checkCardRedeploy(card, deploy(card, { actions: [{ DeployContract: { code: DEPLOYED } }, { FunctionCall: { method_name: 'migrate' } }] }), DEPLOYED).join(' '), /exactly one/);
  assert.match(checkCardRedeploy(card, deploy(card, { actions: [{ DeployContract: { code: 'AAAA' } }] }), DEPLOYED).join(' '), /not the committed/);
  assert.match(checkCardRedeploy(card, deploy(card, { status: { Failure: {} } }), DEPLOYED).join(' '), /did not succeed/);
});

const deps = (over: Partial<Deps> = {}): { deps: Deps; log: string[] } => {
  const log: string[] = [];
  const byTx = new Map(CARDS.map((c) => [c.tx, c]));
  return {
    log,
    deps: {
      log: (s) => log.push(s),
      read: (p) => file(p),
      size: (p) => statSync(join(REPO, p)).size,
      code: async () => NEW_HASH,
      tx: async (hash) => {
        const c = byTx.get(hash);
        if (c === undefined) throw new Error('unknown tx');
        return deploy(c);
      },
      blockHeight: async (h) => CARDS.find((c) => `h-${c.tx}` === h)?.block ?? 0,
      ...over,
    },
  };
};

test('offline and verify on fake chain answers', async () => {
  const off = deps();
  assert.equal(await run(['--offline'], off.deps), 0);
  assert.equal(off.log.at(-1), 'CARD CODE OFFLINE OK');
  const on = deps();
  assert.equal(await run(['--verify'], on.deps), 0);
  assert.equal(on.log.at(-1), `CARD CODE VERIFY OK ${NEW_HASH}`);
  const stale = deps({ code: async (a) => (a === tryCard.account ? OLD_HASH : NEW_HASH) });
  assert.equal(await run(['--verify'], stale.deps), 1);
  assert.ok(stale.log.some((l) => l.includes(`${tryCard.account} runs ${OLD_HASH}`)));
  assert.equal(await run([], deps().deps), 2);
});

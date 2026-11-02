// AIR-185: the local task key (WebCrypto Ed25519, non-extractable), base58, the registration command and the vector that ties the
// console's bytes to the bytes the contract verifies (AIR-045).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ownerTaskBorsh } from '@airlock/runtime/dsl';
import type { OwnerTask } from '@airlock/runtime/dsl';
import { base58, ensureKey, memoryKeyStore, registrationCommand } from '../src/preview/taskKey.ts';

const vectors = JSON.parse(readFileSync(new URL('../../fixtures/verdict-vectors.json', import.meta.url), 'utf8')) as {
  owner_task: OwnerTask & { borsh_hex: string; seed_hex: string; public_key: string; signature_hex: string };
};

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (p) => parseInt(p, 16));

test('base58: Bitcoin alphabet, leading zero bytes as 1', () => {
  assert.ok(base58(Uint8Array.of(0, 0, 1)).startsWith('11'));
  assert.equal(base58(Uint8Array.of(0, 0, 1)), '112');
  assert.equal(base58(new Uint8Array(0)), '');
  assert.equal(base58(Uint8Array.of(0)), '1');
  assert.equal(base58(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
});

test('registrationCommand is the exact near-cli line of the ticket', () => {
  assert.equal(
    registrationCommand({ contractId: 'policy.test.near', publicKey: 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9', ownerId: 'owner.test.near' }),
    `near contract call-function as-transaction policy.test.near set_task_key json-args '{"public_key":"ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.test.near network-config testnet sign-with-keychain send`,
  );
});

test('the private key cannot be exported and the same store gives the same public key twice', async () => {
  const store = memoryKeyStore();
  const a = await ensureKey(store);
  const b = await ensureKey(store);
  assert.equal(a.publicKey, b.publicKey);
  assert.match(a.publicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const pair = await store.load();
  assert.ok(pair);
  assert.equal(pair.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const sig = await a.sign(Uint8Array.of(1, 2, 3));
  assert.equal(sig.length, 64);
  // the public half of a sign-only pair carries no usages: import its raw bytes to verify
  const pub = await crypto.subtle.importKey('raw', await crypto.subtle.exportKey('raw', pair.publicKey), { name: 'Ed25519' }, true, ['verify']);
  assert.equal(await crypto.subtle.verify({ name: 'Ed25519' }, pub, new Uint8Array(sig), Uint8Array.of(1, 2, 3)), true);
});

test('a browser without Ed25519 gives KeyUnsupported and stores nothing', async () => {
  const store = memoryKeyStore();
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const fake = { subtle: { generateKey: () => Promise.reject(new DOMException('no', 'NotSupportedError')) } };
  Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true });
  try {
    await assert.rejects(ensureKey(store), (e: unknown) => e instanceof Error && e.name === 'KeyUnsupported');
  } finally {
    if (real) Object.defineProperty(globalThis, 'crypto', real);
  }
  assert.equal(await store.load(), null);
});

test('the salt is stored beside the task id', async () => {
  const store = memoryKeyStore();
  await store.saveSalt('task-1', 'aabb');
  assert.equal(await store.loadSalt('task-1'), 'aabb');
});

test('the owner_task vector: the bytes equal borsh_hex, a non-extractable key signs them to signature_hex, base58 gives the public key', async () => {
  const v = vectors.owner_task;
  const task: OwnerTask = { tag: v.tag, task_id: v.task_id, contract_id: v.contract_id, agent_id: v.agent_id, plan_sha256: v.plan_sha256, instruction_sha256_salted: v.instruction_sha256_salted, issued_ms: v.issued_ms, expires_ms: v.expires_ms, max_actions: v.max_actions, bounds: v.bounds };
  const bytes = ownerTaskBorsh(task);
  assert.equal(hex(bytes), v.borsh_hex);

  const pkcs8 = Uint8Array.from([...fromHex('302e020100300506032b657004220420'), ...fromHex(v.seed_hex)]);
  const priv = await crypto.subtle.importKey('pkcs8', new Uint8Array(pkcs8), { name: 'Ed25519' }, false, ['sign']);
  assert.equal(priv.extractable, false);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, new Uint8Array(bytes)));
  assert.equal(hex(sig), v.signature_hex);

  // the public key of the vector is the last 32 bytes of the seed's public key; derive it through a key pair of the same seed
  const jwkKey = await crypto.subtle.importKey('pkcs8', new Uint8Array(pkcs8), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', jwkKey);
  assert.ok(jwk.x);
  const raw = Uint8Array.from(Buffer.from(jwk.x, 'base64url'));
  assert.equal(`ed25519:${base58(raw)}`, v.public_key);
  console.log('PREVIEW_VECTOR ok');
});

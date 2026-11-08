// AIR-325: the relayer side of the Solana lane. The wire transaction assembled from the contract's message and the MPC signature must be
// exactly what @solana/web3.js parses back (same message, same signature, a signature that verifies against the sender), and the id must
// be the base58 of the signature. No network: the RPC helpers are checked with a stub fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SolanaError, assembleSolanaTx, base58, latestBlockhash, sendTransaction, solanaTxId, statusOf } from '../src/chain/solana.ts';

const doc = JSON.parse(readFileSync(new URL('../../fixtures/sol-vectors.json', import.meta.url), 'utf8')) as {
  messages: { from: string; to: string; message_hex: string }[];
};
// @solana/web3.js comes with chainsig.js (a runtime dependency); resolved from chainsig.js's own folder
const web3 = createRequire(fileURLToPath(import.meta.resolve('chainsig.js')))('@solana/web3.js') as {
  Transaction: { from(b: Buffer): { signatures: { signature: Buffer | null; publicKey: { toBase58(): string } }[]; serializeMessage(): Buffer; verifySignatures(): boolean } };
};

// a throwaway Ed25519 key (seed of 32 bytes of 02, tests only) and its raw public key
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, 2)]), format: 'der', type: 'pkcs8' });
const rawPub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);

test('the assembled transaction parses back with web3.js and its signature verifies', () => {
  // the contract's message for a transfer from the throwaway key: take the fixture message and put the key in the payer slot
  const m = doc.messages[0];
  assert.ok(m);
  const message = Buffer.from(m.message_hex, 'hex');
  rawPub.copy(message, 4);
  const sig = edSign(null, message, key);
  const wire = assembleSolanaTx(message.toString('hex'), sig.toString('hex'));
  const tx = web3.Transaction.from(Buffer.from(wire, 'base64'));
  assert.equal(tx.serializeMessage().toString('hex'), message.toString('hex'));
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.signatures[0]?.publicKey.toBase58(), base58(rawPub));
  assert.equal(tx.signatures[0]?.signature?.toString('hex'), sig.toString('hex'));
  assert.ok(tx.verifySignatures(), 'the signature verifies against the fee payer');
  assert.equal(solanaTxId(sig.toString('hex')), base58(sig));
});

test('base58 matches the fixture spellings', () => {
  for (const m of doc.messages) {
    const bytes = Buffer.from(m.message_hex, 'hex');
    assert.equal(base58(bytes.subarray(4, 36)), m.from);
    assert.equal(base58(bytes.subarray(36, 68)), m.to);
  }
  assert.equal(base58(new Uint8Array(32)), '1'.repeat(32));
});

test('a message with another signer count, a short signature or uppercase hex is refused', () => {
  const m = doc.messages[0]?.message_hex ?? '';
  const sig = 'ab'.repeat(64);
  assert.throws(() => assembleSolanaTx(`02${m.slice(2)}`, sig), SolanaError);
  assert.throws(() => assembleSolanaTx(m, sig.slice(2)), SolanaError);
  assert.throws(() => assembleSolanaTx(m.toUpperCase(), sig), SolanaError);
  assert.throws(() => assembleSolanaTx(`01${'00'.repeat(1200)}`, sig), SolanaError);
});

test('the RPC helpers read the documented answers and surface RPC errors', async () => {
  const calls: string[] = [];
  const stub = (result: unknown, error?: unknown) => async (_url: string, init: { body: string }) => {
    calls.push((JSON.parse(init.body) as { method: string }).method);
    return { json: async () => (error === undefined ? { result } : { error }) };
  };
  assert.equal(await latestBlockhash('x', stub({ value: { blockhash: '1'.repeat(32) } })), '1'.repeat(32));
  assert.equal(await sendTransaction('x', 'AA==', stub('sig1')), 'sig1');
  assert.deepEqual(await statusOf('x', 'sig1', stub({ value: [{ confirmationStatus: 'finalized', err: null }] })), { status: 'finalized', err: null });
  assert.deepEqual(await statusOf('x', 'sig1', stub({ value: [null] })), { status: null, err: null });
  await assert.rejects(sendTransaction('x', 'AA==', stub(undefined, { message: 'Blockhash not found' })), /Blockhash not found/);
  assert.deepEqual(calls, ['getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses', 'getSignatureStatuses', 'sendTransaction']);
});

#!/usr/bin/env node
// AIR-325: writes fixtures/sol-vectors.json, the reference values of the Solana lane that the Rust verdict crate, the policy contract
// and the TypeScript runtime check themselves against.
//   payee_keys    `sol:<cluster>:<base58>` keys: accept (with the 32 bytes as hex) and reject (with the KeyError name)
//   messages      legacy SystemProgram transfer messages built by @solana/web3.js (the reference for the contract's builder)
//   derivations   Ed25519 child keys of the testnet MPC root for (predecessor, path), from chainsig.js (offline derivation)
// Usage: node scripts/gen_sol_vectors.mjs [--check]   (--check regenerates in memory and compares byte for byte; exit 1 on a difference)
// The reject errors are written by hand from the rule order of contracts/airlock-verdict/src/keys.rs (NonAscii, scheme, cluster as
// BadChainId, length 32 to 44 as BadLength, alphabet as BadChar, exactly 32 decoded bytes as BadLength). Pure data, ASCII only.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'sol-vectors.json');
const chainsigUrl = import.meta.resolve('chainsig.js');
const cs = await import(chainsigUrl);
// @solana/web3.js is a dependency of chainsig.js, resolved from its own folder
const web3 = createRequire(fileURLToPath(chainsigUrl))('@solana/web3.js');

const TESTNET_SIGNER = 'v1.signer-prod.testnet';
const TESTNET_ED25519_ROOT = 'ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2';
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const keyBytes = (b58) => hex(new web3.PublicKey(b58).toBytes());
const b58Of = (bytes) => new web3.PublicKey(Uint8Array.from(bytes)).toBase58();

const ALL_FF = b58Of(new Array(32).fill(0xff));
const ONE_LOW = b58Of([...new Array(31).fill(0), 1]);
const DERIVED = '9GKETEu2cwxNLj4QXDpkirLuEUqqao77Q9HLqTqHbZFa';
const PAYER = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const TO = '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh';

const accept = [
  `sol:devnet:${DERIVED}`,
  `sol:devnet:${PAYER}`,
  `sol:testnet:${TO}`,
  `sol:mainnet:${'1'.repeat(32)}`,
  `sol:devnet:${ALL_FF}`,
  `sol:devnet:${ONE_LOW}`,
].map((key) => ({ key, bytes_hex: keyBytes(key.split(':')[2]) }));

const reject = [
  { key: `SOL:devnet:${DERIVED}`, error: 'UnknownScheme' },
  { key: `solana:devnet:${DERIVED}`, error: 'UnknownScheme' },
  { key: `sol:localnet:${DERIVED}`, error: 'BadChainId' },
  { key: `sol:Devnet:${DERIVED}`, error: 'BadChainId' },
  { key: `sol::${DERIVED}`, error: 'BadChainId' },
  { key: `sol:${DERIVED}`, error: 'BadChainId' },
  { key: 'sol:devnet', error: 'BadLength' },
  { key: 'sol:devnet:', error: 'BadLength' },
  { key: `sol:devnet:${DERIVED.slice(0, 31)}`, error: 'BadLength' },
  { key: `sol:devnet:${DERIVED}z`.padEnd(56, 'z'), error: 'BadLength' },
  { key: `sol:devnet:${'z'.repeat(44)}`, error: 'BadLength' },
  { key: `sol:devnet:${'1'.repeat(33)}`, error: 'BadLength' },
  { key: `sol:devnet:2${'1'.repeat(31)}`, error: 'BadLength' },
  { key: `sol:devnet:0${DERIVED.slice(1)}`, error: 'BadChar' },
  { key: `sol:devnet:O${DERIVED.slice(1)}`, error: 'BadChar' },
  { key: `sol:devnet:I${DERIVED.slice(1)}`, error: 'BadChar' },
  { key: `sol:devnet:l${DERIVED.slice(1)}`, error: 'BadChar' },
  { key: `sol:devnet:${DERIVED.slice(0, 43)}:`, error: 'BadChar' },
  { key: `sol:devnet:${DERIVED.slice(0, 43)} `, error: 'BadChar' },
  { key: `sol:devnet:${DERIVED} `, error: 'BadLength' },
  { key: `sol:devnet:${DERIVED.slice(0, 43)}${String.fromCharCode(0xe9)}`, error: 'NonAscii' },
];

const messages = [];
for (const [from, to, blockhash, lamports] of [
  [PAYER, TO, 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', 42n],
  [PAYER, TO, 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', 1000000n],
  [DERIVED, PAYER, '11111111111111111111111111111111', 1n],
  [DERIVED, ALL_FF, ONE_LOW, 18446744073709551615n],
]) {
  const tx = new web3.Transaction();
  tx.add(web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(from), toPubkey: new web3.PublicKey(to), lamports }));
  tx.recentBlockhash = blockhash;
  tx.feePayer = new web3.PublicKey(from);
  messages.push({ from, to, blockhash, lamports: lamports.toString(), message_hex: hex(tx.compileMessage().serialize()) });
}

const contract = new cs.contracts.ChainSignatureContract({ networkId: 'testnet', contractId: TESTNET_SIGNER });
const derivations = [];
for (const [predecessor, path] of [
  ['policy-sol.erfan-airlock.testnet', 'sol-devnet-1'],
  ['policy.test.near', 'sol-devnet-1'],
  ['policy.sandbox', 'sol-devnet-1'],
]) {
  const publicKey = await contract.getDerivedPublicKey({ path, predecessor, IsEd25519: true });
  derivations.push({ predecessor, path, root: TESTNET_ED25519_ROOT, public_key: publicKey });
}

const doc = {
  format: 'airlock-sol-vectors-v1',
  sources: { messages: '@solana/web3.js 1.99.0', derivations: 'chainsig.js 1.1.16 getDerivedPublicKey (offline, testnet root)' },
  payee_keys: { accept, reject },
  messages,
  derivations,
};
const escapeNonAscii = (s) => [...s].map((c) => (c.charCodeAt(0) > 0x7f ? '\\' + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c)).join('');
const text = escapeNonAscii(JSON.stringify(doc, null, 2)) + '\n';
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== text) {
    process.stderr.write('fixtures/sol-vectors.json differs from the generator\n');
    process.exit(1);
  }
  console.log('sol-vectors.json up to date');
} else {
  writeFileSync(OUT, text);
  console.log(`wrote fixtures/sol-vectors.json: ${accept.length} accept, ${reject.length} reject, ${messages.length} messages, ${derivations.length} derivations`);
}

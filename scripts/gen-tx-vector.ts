// AIR-359: the reference vector of web/src/chain/tx.ts, made once with near-api-js 7.3.1 (the runtime's pinned signer) and committed as
// web/test/fixtures/tx-vector.json. The web module is hand-rolled (no near-api-js in the page); web/test/lender-tx.test.ts checks that its borsh
// bytes, sha256 and Ed25519 signature equal these byte for byte. Fixed seed, nonce and block hash; nothing is sent anywhere.
// Run: pnpm -C runtime exec tsx ../scripts/gen-tx-vector.ts > web/test/fixtures/tx-vector.json
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { KeyPair, actions, baseDecode, baseEncode, createTransaction, encodeTransaction } from '../runtime/node_modules/near-api-js/lib/index.js';
import type { KeyPairString } from '../runtime/node_modules/near-api-js/lib/index.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PKCS8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SEED)]);
const priv = createPrivateKey({ key: PKCS8, format: 'der', type: 'pkcs8' });
const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x: string };
const pub = Buffer.from(jwk.x, 'base64url');
const secretKey = `ed25519:${baseEncode(Buffer.concat([Buffer.from(SEED), pub]))}` as KeyPairString;
const pair = KeyPair.fromString(secretKey);

const blockHash = baseEncode(Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + (i % 16)));
const TGAS = 1_000_000_000_000n;
const NEAR = 10n ** 24n;

type Case = { name: string; signerId: string; receiverId: string; nonce: string; actions: ({ kind: 'call'; method: string; args: string; gas: string; deposit: string } | { kind: 'transfer'; deposit: string })[] };

const CASES: Case[] = [
  { name: 'deposit', signerId: 'lender-abc1234567.testnet', receiverId: 'pool.airlock-credit-c1108d.testnet', nonce: '193000000000001', actions: [{ kind: 'call', method: 'deposit', args: '{}', gas: (60n * TGAS).toString(), deposit: NEAR.toString() }] },
  { name: 'withdraw', signerId: 'lender-abc1234567.testnet', receiverId: 'pool.airlock-credit-c1108d.testnet', nonce: '193000000000002', actions: [{ kind: 'call', method: 'withdraw', args: '{"shares":"990099009900990099009900"}', gas: (80n * TGAS).toString(), deposit: '0' }] },
  { name: 'submit_batch', signerId: 'agent.airlock-try-x.testnet', receiverId: 'try.airlock-try-x.testnet', nonce: '42', actions: [{ kind: 'call', method: 'submit_batch', args: '{"reqs":[]}', gas: (50n * TGAS).toString(), deposit: '0' }] },
  { name: 'transfer', signerId: 'lender-abc1234567.testnet', receiverId: 'someone.testnet', nonce: '7', actions: [{ kind: 'transfer', deposit: (NEAR / 2n).toString() }] },
];

const out = {
  made: 'near-api-js 7.3.1 through runtime, scripts/gen-tx-vector.ts',
  secretKey,
  publicKey: pair.getPublicKey().toString(),
  blockHash,
  cases: CASES.map((c) => {
    const acts = c.actions.map((a) => (a.kind === 'call' ? actions.functionCall(a.method, new TextEncoder().encode(a.args), BigInt(a.gas), BigInt(a.deposit)) : actions.transfer(BigInt(a.deposit))));
    const tx = createTransaction(c.signerId, pair.getPublicKey(), c.receiverId, BigInt(c.nonce), acts, baseDecode(blockHash));
    const bytes = encodeTransaction(tx);
    const hash = createHash('sha256').update(bytes).digest();
    const sig = pair.sign(hash).signature;
    return { ...c, txHex: Buffer.from(bytes).toString('hex'), hashHex: hash.toString('hex'), hashBase58: baseEncode(hash), signatureBase58: baseEncode(sig) };
  }),
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

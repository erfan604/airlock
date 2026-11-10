// AIR-359: the page's own transaction signer (web/src/chain/tx.ts, hand-rolled borsh plus WebCrypto Ed25519) gives the same bytes, hash and
// signature as near-api-js 7.3.1 on fixed inputs (web/test/fixtures/tx-vector.json, made once by scripts/gen-tx-vector.ts). It also sends
// through the shared RPC client and reads the outcome; the RPC here is a stub, nothing reaches a node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vector from './fixtures/tx-vector.json' with { type: 'json' };
import { base58Decode, chooseNonce, encodeTransaction, eventLogs, functionCall, generateKey, keyFromSecret, signTransaction, successValue } from '../src/chain/tx.ts';
import type { TxAction } from '../src/chain/tx.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const actionsOf = (c: (typeof vector.cases)[number]): TxAction[] =>
  (c.actions as { kind: string; method?: string; args?: string; gas?: string; deposit: string }[]).map((a) => (a.kind === 'call' ? { kind: 'call', method: a.method ?? '', args: new TextEncoder().encode(a.args ?? ''), gas: BigInt(a.gas ?? '0'), deposit: BigInt(a.deposit) } : { kind: 'transfer', deposit: BigInt(a.deposit) }));

test('tx: the key from the vector secret has the vector public key', async () => {
  const key = await keyFromSecret(vector.secretKey);
  assert.equal(key.publicKeyText, vector.publicKey);
  assert.equal(key.secretKeyText, vector.secretKey);
});

for (const c of vector.cases) {
  test(`tx: ${c.name} bytes, hash and signature equal near-api-js`, async () => {
    const key = await keyFromSecret(vector.secretKey);
    const tx = { signerId: c.signerId, publicKey: key.publicKey, nonce: BigInt(c.nonce), receiverId: c.receiverId, blockHash: base58Decode(vector.blockHash), actions: actionsOf(c) };
    assert.equal(hex(encodeTransaction(tx)), c.txHex);
    const signed = await signTransaction(tx, key);
    assert.equal(hex(signed.hash), c.hashHex);
    assert.equal(signed.hashText, c.hashBase58);
    assert.equal(signed.signatureText, c.signatureBase58);
    // SignedTransaction = Transaction bytes, then key type 0 and the 64 signature bytes
    assert.equal(hex(signed.bytes), `${c.txHex}00${hex(base58Decode(c.signatureBase58))}`);
  });
}

test('tx: a generated key round-trips through its secret text and signs', async () => {
  const k = await generateKey();
  assert.match(k.secretKeyText, /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  const again = await keyFromSecret(k.secretKeyText);
  assert.equal(again.publicKeyText, k.publicKeyText);
  assert.equal((await again.sign(new Uint8Array([1, 2, 3]))).length, 64);
});

test('tx: a secret whose public half does not match its seed is refused', async () => {
  const bytes = base58Decode(vector.secretKey.slice('ed25519:'.length));
  bytes[40] = (bytes[40] ?? 0) ^ 1;
  const { base58 } = await import('../src/preview/taskKey.ts');
  await assert.rejects(keyFromSecret(`ed25519:${base58(bytes)}`));
  await assert.rejects(keyFromSecret('ed25519:short'));
  await assert.rejects(keyFromSecret('secp256k1:abc'));
});

test('tx: the nonce is above the chain nonce, by 1 plus at most 999', () => {
  assert.equal(chooseNonce(10n, 0), 11n);
  assert.equal(chooseNonce(10n, 0.9999), 1010n);
  assert.throws(() => chooseNonce(10n, 1));
});

const NEAR = 10n ** 24n;
const B64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64');

test('tx: functionCall reads the key nonce and a final block, sends the signed call and returns the outcome', async () => {
  const key = await keyFromSecret(vector.secretKey);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const outcome = {
    final_execution_status: 'EXECUTED_OPTIMISTIC',
    status: { SuccessValue: B64('990099') },
    transaction: { hash: 'HASH' },
    receipts_outcome: [{ outcome: { executor_id: 'pool.x.testnet', logs: ['EVENT_JSON:{"standard":"airlock-credit","event":"deposit","data":[{}]}'], status: { SuccessValue: B64('990099') } } }],
  };
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> };
    calls.push(body);
    const result = body.method === 'query' ? { nonce: 41, block_hash: vector.blockHash } : outcome;
    return Response.json({ jsonrpc: '2.0', id: 'airlock', result });
  }) as unknown as typeof fetch;
  const r = await functionCall({ rpcUrls: ['https://rpc.example'], fetch: fetchFn }, key, { signerId: 'lender-abc1234567.testnet', receiverId: 'pool.x.testnet', method: 'deposit', args: {}, gas: 60n * 10n ** 12n, deposit: NEAR, random: () => 0 });
  assert.equal(calls[0]?.method, 'query');
  assert.deepEqual(calls[0]?.params, { request_type: 'view_access_key', finality: 'final', account_id: 'lender-abc1234567.testnet', public_key: vector.publicKey });
  assert.equal(calls[1]?.method, 'send_tx');
  assert.equal(calls[1]?.params['wait_until'], 'EXECUTED_OPTIMISTIC');
  assert.equal(typeof calls[1]?.params['signed_tx_base64'], 'string');
  assert.equal(r.hash.length > 30, true);
  assert.deepEqual(successValue(r.outcome), '990099');
  assert.equal(eventLogs(r.outcome, 'pool.x.testnet').length, 1);
  assert.equal(eventLogs(r.outcome, 'other.testnet').length, 0);
});

test('tx: a key the node does not know yet (the query answers with an error string) throws a retryable RpcError', async () => {
  const key = await keyFromSecret(vector.secretKey);
  const fetchFn = (async () => Response.json({ jsonrpc: '2.0', id: 'airlock', result: { error: 'access key ed25519:x does not exist while viewing', logs: [], block_height: 1, block_hash: vector.blockHash } })) as unknown as typeof fetch;
  await assert.rejects(functionCall({ rpcUrls: ['https://rpc.example'], fetch: fetchFn }, key, { signerId: 'a.testnet', receiverId: 'p.testnet', method: 'deposit', args: {}, gas: 1n, deposit: 0n }), (e: Error) => e.name === 'RpcError' && /does not exist/.test(e.message));
});

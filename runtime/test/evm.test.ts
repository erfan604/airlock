// AIR-162: EVM assembly and broadcast. Decode of the contract's unsigned transaction, assembly with an MPC signature (viem trims r and s),
// sender recovery, the check against the stored request, and an idempotent broadcast against a local mock node (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { fromRlp, keccak256, parseTransaction, serializeTransaction } from 'viem';
import type { Hex } from 'viem';
import {
  BASE_SEPOLIA_RPCS,
  EvmAssembleError,
  EvmBroadcastError,
  EvmDecodeError,
  assembleEvm,
  broadcast,
  decodeUnsigned,
  deriveSender,
  senderOf,
  sigFromMpc,
} from '../src/chain/evm.ts';
import type { MpcSig } from '../src/chain/evm.ts';
import { EvmMismatch, verifySignedMatchesRequest } from '../src/chain/evm.check.ts';
import type { RequestView } from '../src/chain/types.ts';
import { rpcError, rpcResult, startMockRpc } from './helpers/mock-rpc.ts';
import type { MockCall, MockReply, MockRpc } from './helpers/mock-rpc.ts';

const UNSIGNED = '0x02f183014a3480843b9aca00847735940082520894d8da6bf26964af9d7eed9e03e53415d37aa96045872386f26fc1000080c0';
const TO = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const AMOUNT = '10000000000000000';
const hash = keccak256(UNSIGNED as Hex);

/** stand-in for the MPC: a generated key signs the hash, the signature becomes the flat form the `signed` event carries */
async function mpcSign(privateKey: Hex, unsigned: string = UNSIGNED): Promise<MpcSig> {
  const sig = await sign({ hash: keccak256(unsigned as Hex), privateKey });
  return { big_r: (sig.yParity === 0 ? '02' : '03') + sig.r.slice(2), s: sig.s.slice(2), recovery_id: sig.yParity ?? 0 };
}

const stored = (over: Partial<RequestView> = {}, unsigned: string = UNSIGNED): RequestView => ({
  request_id: 'a'.repeat(64) + ':0',
  id: null,
  state: 'Signed' as RequestView['state'],
  agent: 'agent.test.near',
  task_id: 't',
  asset: 'evm:84532:native',
  payee: `evm:84532:${TO}`,
  amount: AMOUNT,
  labels: { recipient: 0, amount: 0, pc: 0 },
  reason: null,
  book_status: null,
  display: null,
  created_ms: '0',
  expires_ms: null,
  digest: null,
  exec: { unsigned_hex: unsigned, big_r: null, s: null, recovery_id: null },
  ...over,
});

// ---- decodeUnsigned ----

test('decodeUnsigned returns the fixture fields, with and without 0x', () => {
  const want = { chainId: 84532, nonce: 0n, to: TO, value: 10n ** 16n, maxFeePerGas: 2_000_000_000n, gas: 21_000n };
  assert.deepEqual(decodeUnsigned(UNSIGNED), want);
  assert.deepEqual(decodeUnsigned(UNSIGNED.slice(2)), want);
});

const BASE = { chainId: 84532, nonce: 0, to: TO as Hex, value: 10n ** 16n, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

test('decodeUnsigned throws EvmDecodeError on a legacy transaction', () => {
  const legacy = serializeTransaction({ type: 'legacy', chainId: 84532, nonce: 0, to: TO as Hex, value: 1n, gas: 21_000n, gasPrice: 1_000_000_000n });
  assert.throws(() => decodeUnsigned(legacy), EvmDecodeError);
});

test('decodeUnsigned throws EvmDecodeError when the transaction has no to', () => {
  const { to, ...noTo } = BASE;
  void to;
  assert.throws(() => decodeUnsigned(serializeTransaction({ type: 'eip1559', ...noTo })), EvmDecodeError);
});

test('decodeUnsigned throws EvmDecodeError on non-empty data', () => {
  assert.throws(() => decodeUnsigned(serializeTransaction({ type: 'eip1559', ...BASE, data: '0xdeadbeef' })), EvmDecodeError);
});

test('decodeUnsigned throws EvmDecodeError on a non-empty access list', () => {
  const accessList = [{ address: TO as Hex, storageKeys: [] }];
  assert.throws(() => decodeUnsigned(serializeTransaction({ type: 'eip1559', ...BASE, accessList })), EvmDecodeError);
});

test('decodeUnsigned accepts what viem serializes for the base fields', () => {
  assert.equal(serializeTransaction({ type: 'eip1559', ...BASE }), UNSIGNED);
});

test('decodeUnsigned throws on trailing bytes', () => {
  assert.throws(() => decodeUnsigned(UNSIGNED + '00'));
});

// ---- sigFromMpc, assembleEvm, senderOf ----

test('sigFromMpc flattens the nested SignatureResponse', () => {
  const flat = sigFromMpc({ big_r: { affine_point: '02' + 'ab'.repeat(32) }, s: { scalar: 'cd'.repeat(32) }, recovery_id: 1 });
  assert.deepEqual(flat, { big_r: '02' + 'ab'.repeat(32), s: 'cd'.repeat(32), recovery_id: 1 });
});

test('50 generated keys: assembleEvm recovers the key address and keeps every field', async () => {
  for (let i = 0; i < 50; i++) {
    const key = generatePrivateKey();
    const raw = assembleEvm(UNSIGNED, await mpcSign(key));
    assert.equal(await senderOf(raw), privateKeyToAccount(key).address.toLowerCase());
    assert.equal(raw.slice(0, 4), '0x02');
    const { chainId, to, value, nonce } = decodeSigned(raw);
    assert.deepEqual({ chainId, to, value, nonce }, { chainId: 84532, to: TO, value: 10n ** 16n, nonce: 0n });
  }
});

function decodeSigned(raw: Hex): { chainId: number; to: string; value: bigint; nonce: bigint; unsigned: string } {
  const { r, s, v, yParity, ...rest } = parseTransaction(raw) as unknown as Record<string, unknown> & { chainId: number; to: string; value: bigint; nonce: number };
  void r; void s; void v; void yParity;
  return { chainId: rest.chainId, to: rest.to, value: rest.value, nonce: BigInt(rest.nonce), unsigned: serializeTransaction(rest as never) };
}

test('assembleEvm accepts the unsigned hex without 0x', async () => {
  const key = generatePrivateKey();
  const sig = await mpcSign(key);
  assert.equal(assembleEvm(UNSIGNED.slice(2), sig), assembleEvm(UNSIGNED, sig));
});

async function findLeadingZero(field: 'r' | 's'): Promise<{ key: Hex; sig: MpcSig }> {
  for (let i = 0; i < 20_000; i++) {
    const key = generatePrivateKey();
    const sig = await mpcSign(key);
    const hex = field === 'r' ? sig.big_r.slice(2) : sig.s;
    // exactly one leading zero byte: with two, viem writes a 30 byte string, which is right but is not the case this test names
    // (about 1 run in 256 hit that and failed by chance)
    if (hex.startsWith('00') && !hex.startsWith('0000')) return { key, sig };
  }
  throw new Error('no key with a leading zero byte found');
}

for (const field of ['r', 's'] as const) {
  test(`leading zero byte of ${field}: viem writes a 31 byte string and the sender still recovers`, async () => {
    const { key, sig } = await findLeadingZero(field);
    const raw = assembleEvm(UNSIGNED, sig);
    const fields = fromRlp(`0x${raw.slice(4)}` as Hex) as Hex[]; // [9] yParity, [10] r, [11] s
    const written = field === 'r' ? fields[10]! : fields[11]!;
    assert.equal((written.length - 2) / 2, 31);
    assert.equal(await senderOf(raw), privateKeyToAccount(key).address.toLowerCase());
  });
}

test('assembleEvm throws EvmAssembleError for recovery_id 2, a 04 prefix, a 65 character big_r and a 63 character s', async () => {
  const good = await mpcSign(generatePrivateKey());
  assert.throws(() => assembleEvm(UNSIGNED, { ...good, recovery_id: 2 }), EvmAssembleError);
  assert.throws(() => assembleEvm(UNSIGNED, { ...good, recovery_id: 3 }), EvmAssembleError);
  assert.throws(() => assembleEvm(UNSIGNED, { ...good, recovery_id: -1 }), EvmAssembleError);
  assert.throws(() => assembleEvm(UNSIGNED, { ...good, big_r: '04' + good.big_r.slice(2) }), EvmAssembleError);
  assert.throws(() => assembleEvm(UNSIGNED, { ...good, big_r: good.big_r.slice(0, 65) }), EvmAssembleError);
  assert.throws(() => assembleEvm(UNSIGNED, { ...good, s: good.s.slice(0, 63) }), EvmAssembleError);
  assert.throws(() => assembleEvm(UNSIGNED, { ...good, s: 'zz' + good.s.slice(2) }), EvmAssembleError);
});

test('senderOf answers lowercase', async () => {
  const key = generatePrivateKey();
  const sender = await senderOf(assembleEvm(UNSIGNED, await mpcSign(key)));
  assert.equal(sender, sender.toLowerCase());
  assert.match(sender, /^0x[0-9a-f]{40}$/);
});

// ---- verifySignedMatchesRequest ----

async function signedBy(key: Hex, unsigned: string = UNSIGNED, flip = false): Promise<Hex> {
  const sig = await mpcSign(key, unsigned);
  return assembleEvm(unsigned, flip ? { ...sig, recovery_id: sig.recovery_id === 0 ? 1 : 0, big_r: (sig.recovery_id === 0 ? '03' : '02') + sig.big_r.slice(2) } : sig);
}

async function codeOf(p: Promise<void>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof EvmMismatch, `expected EvmMismatch, got ${String(e)}`);
    return e.code;
  }
  return 'none';
}

test('verifySignedMatchesRequest passes for the stored request', async () => {
  const key = generatePrivateKey();
  const raw = await signedBy(key);
  await verifySignedMatchesRequest(raw, stored(), privateKeyToAccount(key).address);
  // the derived address is compared case-insensitively
  await verifySignedMatchesRequest(raw, stored(), privateKeyToAccount(key).address.toLowerCase());
});

test('verifySignedMatchesRequest fails with value, to, chain, sender and preimage', async () => {
  const key = generatePrivateKey();
  const addr = privateKeyToAccount(key).address;
  const raw = await signedBy(key);
  assert.equal(await codeOf(verifySignedMatchesRequest(raw, stored({ amount: '10000000000000001' }), addr)), 'value');
  assert.equal(await codeOf(verifySignedMatchesRequest(raw, stored({ payee: `evm:84532:${TO.slice(0, -1)}6` }), addr)), 'to');
  assert.equal(await codeOf(verifySignedMatchesRequest(raw, stored({ asset: 'evm:1:native' }), addr)), 'chain');
  assert.equal(await codeOf(verifySignedMatchesRequest(raw, stored(), privateKeyToAccount(generatePrivateKey()).address)), 'sender');
  assert.equal(await codeOf(verifySignedMatchesRequest(await signedBy(key, UNSIGNED, true), stored(), addr)), 'sender');
  // a different preimage (nonce 1) in the stored request: the signed bytes do not cover what the contract hashed
  const other = '0x02f183014a3401843b9aca00847735940082520894d8da6bf26964af9d7eed9e03e53415d37aa96045872386f26fc1000080c0';
  assert.equal(await codeOf(verifySignedMatchesRequest(raw, stored({}, other), addr)), 'preimage');
  assert.equal(await codeOf(verifySignedMatchesRequest(raw, stored({ exec: null }), addr)), 'preimage');
});

// ---- deriveSender ----

test('deriveSender gives the address the MPC controls for the policy account and path', async () => {
  assert.equal(await deriveSender('airlock-policy.testnet', 'evm-base-sepolia-1'), '0x2f14b9f343d244443a38cac8db0723c4554b705f');
});

// ---- broadcast against a mock node ----

const RAW = assembleEvm(UNSIGNED, await mpcSign(generatePrivateKey())); // a real signed transaction: broadcast reads its chain id
const RAW_HASH = keccak256(RAW);
const RECEIPT = (status: '0x1' | '0x0') => ({
  transactionHash: RAW_HASH,
  transactionIndex: '0x0',
  blockHash: '0x' + '11'.repeat(32),
  blockNumber: '0x10',
  from: TO,
  to: TO,
  cumulativeGasUsed: '0x5208',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x3b9aca00',
  contractAddress: null,
  logs: [],
  logsBloom: '0x' + '00'.repeat(256),
  status,
  type: '0x2',
});
const TX = {
  hash: RAW_HASH,
  nonce: '0x0',
  blockHash: null,
  blockNumber: null,
  transactionIndex: null,
  from: TO,
  to: TO,
  value: '0x0',
  gas: '0x5208',
  gasPrice: '0x3b9aca00',
  maxFeePerGas: '0x77359400',
  maxPriorityFeePerGas: '0x3b9aca00',
  input: '0x',
  type: '0x2',
  chainId: '0x14a34',
  accessList: [],
  v: '0x0',
  r: '0x1',
  s: '0x1',
  yParity: '0x0',
};

interface Node {
  chain?: string;
  /** answer of eth_sendRawTransaction */
  send: (n: number) => MockReply;
  /** does the node know the transaction */
  known?: boolean;
  /** receipt answers in order, the last repeats */
  receipts?: Array<'0x1' | '0x0' | null>;
}

async function mockNode(node: Node): Promise<MockRpc> {
  let sends = 0;
  let receiptCalls = 0;
  let took = false;
  return startMockRpc((call: MockCall) => {
    switch (call.method) {
      case 'eth_chainId':
        return rpcResult(node.chain ?? '0x14a34');
      case 'eth_sendRawTransaction':
        {
          const reply = node.send(++sends);
          if ((reply.body as { result?: unknown } | undefined)?.result !== undefined) took = true;
          return reply;
        }
      case 'eth_getTransactionByHash':
        return rpcResult(node.known ?? took ? TX : null);
      case 'eth_getTransactionReceipt': {
        const list = node.receipts ?? [null];
        const status = list[Math.min(receiptCalls++, list.length - 1)];
        return rpcResult(status === null || status === undefined ? null : RECEIPT(status));
      }
      case 'eth_blockNumber':
        return rpcResult('0x' + (16 + receiptCalls).toString(16));
      default:
        return rpcError({ code: -32601, message: `no ${call.method}` });
    }
  });
}

const FAST = { pollingIntervalMs: 20, timeoutMs: 5_000 };
const count = (m: MockRpc, method: string): number => m.calls.filter((c) => c.method === method).length;
const accepted = (): MockReply => rpcResult(RAW_HASH);

async function withNodes<T>(nodes: Node[], body: (mocks: MockRpc[]) => Promise<T>): Promise<T> {
  const mocks: MockRpc[] = [];
  try {
    for (const n of nodes) mocks.push(await mockNode(n));
    return await body(mocks);
  } finally {
    await Promise.all(mocks.map((m) => m.close()));
  }
}

test('BASE_SEPOLIA_RPCS pins the three endpoints by exact URL', () => {
  assert.deepEqual([...BASE_SEPOLIA_RPCS], ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org']);
});

test('broadcast: a 503 on the first URL costs exactly one request and the second URL accepts; receipt null once then success', async () => {
  await withNodes([{ send: () => ({ status: 503 }) }, { send: accepted, receipts: [null, '0x1'] }], async ([a, b]) => {
    const out = await broadcast(RAW, [a!.url, b!.url], FAST);
    assert.deepEqual(out, { hash: RAW_HASH, status: 'success' });
    assert.equal(count(a!, 'eth_sendRawTransaction'), 1);
    assert.equal(a!.calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 1);
    assert.equal(count(b!, 'eth_sendRawTransaction'), 1);
  });
});

test('broadcast: receipt status 0x0 maps to reverted', async () => {
  await withNodes([{ send: accepted, receipts: ['0x0'] }], async ([a]) => {
    assert.deepEqual(await broadcast(RAW, [a!.url], FAST), { hash: RAW_HASH, status: 'reverted' });
  });
});

test('broadcast: already known with a node that knows the hash counts as done', async () => {
  await withNodes([{ send: () => rpcError({ code: -32000, message: 'already known' }), known: true, receipts: ['0x1'] }], async ([a]) => {
    assert.deepEqual(await broadcast(RAW, [a!.url], FAST), { hash: RAW_HASH, status: 'success' });
  });
});

test('broadcast: nonce too low with an unknown hash throws Rejected and the second URL is not called', async () => {
  await withNodes(
    [{ send: () => rpcError({ code: -32000, message: 'nonce too low: next nonce 5, tx nonce 0' }), known: false }, { send: accepted, receipts: ['0x1'] }],
    async ([a, b]) => {
      await assert.rejects(
        () => broadcast(RAW, [a!.url, b!.url], FAST),
        (e: unknown) => e instanceof EvmBroadcastError && e.code === 'Rejected' && /nonce too low/.test(e.message),
      );
      assert.equal(b!.calls.length, 0);
    },
  );
});

test('broadcast: nonce too low with a known (mined) hash counts as done', async () => {
  await withNodes([{ send: () => rpcError({ code: -32000, message: 'nonce too low: next nonce 5, tx nonce 4' }), known: true, receipts: ['0x1'] }], async ([a]) => {
    assert.deepEqual(await broadcast(RAW, [a!.url], FAST), { hash: RAW_HASH, status: 'success' });
  });
});

test('broadcast: an endpoint whose chain id is Ethereum Sepolia is skipped without a send', async () => {
  await withNodes([{ chain: '0xaa36a7', send: accepted }, { send: accepted, receipts: ['0x1'] }], async ([a, b]) => {
    assert.equal((await broadcast(RAW, [a!.url, b!.url], FAST)).status, 'success');
    assert.equal(count(a!, 'eth_sendRawTransaction'), 0);
  });
});

test('broadcast: no usable URL throws NoRpc', async () => {
  await withNodes([{ chain: '0xaa36a7', send: accepted }, { send: () => ({ status: 503 }) }], async ([a, b]) => {
    await assert.rejects(
      () => broadcast(RAW, [a!.url, b!.url], FAST),
      (e: unknown) => e instanceof EvmBroadcastError && e.code === 'NoRpc',
    );
  });
});

// ---- real fixture ----

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/real-mpc/${name}`, import.meta.url)), 'utf8').trim();

test('REAL_FIXTURE: assembling the real MPC signature gives the signed transaction of the spike', async () => {
  const unsigned = fixture('unsigned_tx.hex');
  const resp = JSON.parse(fixture('signature_response.json')) as Parameters<typeof sigFromMpc>[0];
  const raw = assembleEvm(unsigned, sigFromMpc(resp));
  assert.equal(raw, fixture('signed_tx.hex'));
  assert.equal(await senderOf(raw), fixture('derived_address.txt').toLowerCase());
  assert.equal(hash.length, 66);
  console.log('REAL_FIXTURE assembled equals signed_tx.hex');
});

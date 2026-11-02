// AIR-160: RpcPool against mock http servers (no sandbox). Failover only on transport errors, every node answer rethrown at once, a send
// never retried and never failed over, and no race on a cold pool with a dead first URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailoverRpcProvider, JsonRpcProvider } from 'near-api-js';
import {
  AccessKeyDoesNotExistError,
  ContractExecutionError,
  ContractMethodNotFoundError,
  RpcError,
} from 'near-api-js/rpc-errors';
import { DEFAULT_RETRY, DEFAULT_RPC_URLS, RpcPool } from '../src/chain/rpc.ts';
import { blockReply, http503, rpcError, rpcResult, startMockRpc } from './helpers/mock-rpc.ts';
import type { MockReply, MockRpc } from './helpers/mock-rpc.ts';

const servers: MockRpc[] = [];
const serve = async (handler: (method: string) => MockReply): Promise<MockRpc> => {
  const server = await startMockRpc((call) => handler(call.method));
  servers.push(server);
  return server;
};
test.after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const FAST = { retries: 3, wait: 1, backoff: 1 };
const block = (p: JsonRpcProvider) => p.viewBlock({ finality: 'final' });

test('the default URL list is the NEAR testnet regular node list of plan/STACK.md, in that order', () => {
  assert.deepEqual([...DEFAULT_RPC_URLS], [
    'https://test.rpc.fastnear.com',
    'https://near-testnet.drpc.org',
    'https://testnet-rpc.intea.rs',
    'https://rpc.testnet.near.org',
  ]);
  assert.deepEqual(DEFAULT_RETRY, { retries: 3, wait: 250, backoff: 2 });
});

test('a first URL that answers 503 to every call: three parallel calls on a cold pool all succeed within 3 seconds', async () => {
  const dead = await serve(() => http503);
  const live = await serve(() => blockReply());
  const pool = new RpcPool([dead.url, live.url]);
  const started = Date.now();
  const results = await Promise.all([block, block, block].map((op) => pool.run(op)));
  assert.equal(results.length, 3);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(dead.calls.length, 9, 'three attempts per call on the dead URL');
  assert.equal(live.calls.length, 3);
});

test('the same three parallel calls through near-api-js FailoverRpcProvider lose one of them (the reason RpcPool exists)', async () => {
  const dead = await serve(() => http503);
  const live = await serve(() => blockReply());
  const failover = new FailoverRpcProvider([new JsonRpcProvider({ url: dead.url }, FAST), new JsonRpcProvider({ url: live.url }, FAST)]);
  const original = console.error;
  console.error = () => {};
  try {
    const settled = await Promise.allSettled([1, 2, 3].map(() => failover.viewBlock({ finality: 'final' })));
    assert.ok(settled.some((r) => r.status === 'rejected'), 'at least one call rejected');
  } finally {
    console.error = original;
  }
});

test('the preferred URL is the last one that worked: later calls skip a dead first URL', async () => {
  const dead = await serve(() => http503);
  const live = await serve(() => blockReply());
  const pool = new RpcPool([dead.url, live.url], FAST);
  await pool.run(block);
  const deadCalls = dead.calls.length;
  await pool.run(block);
  assert.equal(dead.calls.length, deadCalls, 'the second call went straight to the second URL');
  assert.equal(live.calls.length, 2);
});

test('a refused connection fails over at once and costs no waiting', async () => {
  const gone = await startMockRpc(() => ({}));
  const refused = gone.url;
  await gone.close();
  const live = await serve(() => blockReply());
  const pool = new RpcPool([refused, live.url]);
  const started = Date.now();
  await pool.run(block);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test('a node answer is never tried on the second URL: ContractExecutionError, a view panic and an unknown access key', async () => {
  const cases: { name: string; reply: MockReply; check: (error: unknown) => boolean; op: (p: JsonRpcProvider) => Promise<unknown> }[] = [
    {
      name: 'ContractExecutionError',
      reply: rpcResult({ error: 'wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))', logs: [], block_hash: 'x', block_height: 1 }),
      check: (e) => e instanceof ContractExecutionError && e instanceof ContractMethodNotFoundError,
      op: (p) => p.callFunction({ contractId: 'policy.test.near', method: 'nope', args: {} }),
    },
    {
      name: 'a view panic (the plain RpcError)',
      reply: rpcResult({ error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "boom" })', logs: [] }),
      check: (e) => e instanceof RpcError && !(e instanceof ContractExecutionError) && e.name === 'RpcError',
      op: (p) => p.callFunction({ contractId: 'policy.test.near', method: 'get_request', args: {} }),
    },
    {
      name: 'AccessKeyDoesNotExistError',
      reply: rpcError({
        name: 'HANDLER_ERROR',
        cause: { name: 'UNKNOWN_ACCESS_KEY', info: { public_key: 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9', block_hash: 'x', block_height: 1 } },
      }),
      check: (e) => e instanceof AccessKeyDoesNotExistError,
      op: (p) => p.viewAccessKey({ accountId: 'agent.test.near', publicKey: 'ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9' }),
    },
  ];
  for (const c of cases) {
    const first = await serve(() => c.reply);
    const second = await serve(() => blockReply());
    const pool = new RpcPool([first.url, second.url], FAST);
    await assert.rejects(pool.run(c.op), c.check, c.name);
    assert.equal(first.calls.length, 1, `${c.name}: exactly one request to the first URL`);
    assert.equal(second.calls.length, 0, `${c.name}: none to the second`);
  }
});

test('pool.send against a first URL that answers 503 makes exactly one HTTP request in total and throws', async () => {
  const dead = await serve(() => http503);
  const live = await serve(() => blockReply());
  const pool = new RpcPool([dead.url, live.url], FAST);
  await assert.rejects(pool.send((p) => p.sendJsonRpc('send_tx', { signed_tx_base64: 'AA==', wait_until: 'FINAL' })));
  assert.equal(dead.calls.length, 1, 'one HTTP attempt, no retry');
  assert.equal(live.calls.length, 0, 'no failover');
});

test('after a transport error in send the preferred URL moves on for later calls; a node answer does not move it', async () => {
  const dead = await serve(() => http503);
  const live = await serve(() => blockReply());
  const pool = new RpcPool([dead.url, live.url], FAST);
  await assert.rejects(pool.send((p) => p.viewBlock({ finality: 'final' })));
  await pool.run(block);
  assert.equal(dead.calls.length, 1, 'the later read went to the second URL first');
  assert.equal(live.calls.length, 1);

  const answering = await serve(() => rpcResult({ error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "x" })', logs: [] }));
  const other = await serve(() => blockReply());
  const pool2 = new RpcPool([answering.url, other.url], FAST);
  await assert.rejects(pool2.send((p) => p.callFunction({ contractId: 'a.test.near', method: 'm', args: {} })), RpcError);
  await assert.rejects(pool2.send((p) => p.callFunction({ contractId: 'a.test.near', method: 'm', args: {} })), RpcError);
  assert.equal(answering.calls.length, 2, 'both sends stayed on the first URL');
  assert.equal(other.calls.length, 0);
});

test('with every URL down the last error is thrown', async () => {
  const a = await serve(() => http503);
  const b = await serve(() => ({ status: 502 }));
  const pool = new RpcPool([a.url, b.url], FAST);
  await assert.rejects(pool.run(block), (error: unknown) => {
    return error instanceof Error && !(error instanceof RpcError) && error.message.includes('Bad Gateway') && !error.message.includes('RetriesExceeded');
  });
  assert.equal(a.calls.length, 3, 'a 503 URL costs the 3 attempts of the retry options');
  assert.equal(b.calls.length, 1, 'a 502 is not retried by near-api-js');
});

test('a URL answering 503 costs 3 calls and the waits of the retry options before the next URL is tried', async () => {
  const dead = await serve(() => http503);
  const live = await serve(() => blockReply());
  const pool = new RpcPool([dead.url, live.url], { retries: 3, wait: 40, backoff: 2 });
  const started = Date.now();
  await pool.run(block);
  const took = Date.now() - started;
  assert.equal(dead.calls.length, 3);
  assert.ok(took >= 110, `40 + 80 ms of waits, took ${took} ms`);
});

test('a pool needs at least one URL', () => {
  assert.throws(() => new RpcPool([]), RangeError);
});

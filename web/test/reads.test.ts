// AIR-185: the console's own chain reads, with a fake fetch. Failover and the result.result decoding are tested once, in rpc.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rpcChainReads, readSnapshot } from '../src/chain/reads.ts';
import type { ChainReads } from '../src/chain/reads.ts';

type Req = { method: string; params: Record<string, unknown> };

const bytesOf = (v: unknown): number[] => [...new TextEncoder().encode(JSON.stringify(v))];
const row = (i: number) => [`near:p${i}.testnet`, { cap: null, daily_untrusted_budget: '0', daily_limit: '1', label: `p${i}` }];

function fake(book: unknown[], taskKey: unknown = null, nanos = '1800000000123456789') {
  const calls: Req[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    calls.push({ method: body.method, params: body.params });
    let result: unknown;
    if (body.method === 'block') result = { header: { timestamp: 1800000000123456800, timestamp_nanosec: nanos } };
    else {
      const args = JSON.parse(Buffer.from(String(body.params.args_base64), 'base64').toString('utf8')) as { from_index?: number; limit?: number };
      const name = String(body.params.method_name);
      const out =
        name === 'get_book' ? book.slice(args.from_index ?? 0, (args.from_index ?? 0) + (args.limit ?? 50))
        : name === 'list_assets' ? [['near', { symbol: 'NEAR' }]]
        : name === 'get_policy' ? { flags: { max_task_actions: 20, max_task_ttl_ms: '3600000' } }
        : name === 'get_task_key' ? taskKey
        : undefined;
      result = { result: bytesOf(out) };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const cfg = (fetchImpl: typeof fetch) => ({ contractId: 'policy.testnet', rpcUrls: ['https://a'], fetch: fetchImpl });

test('getBook pages 50 at a time and stops on the short page (50 plus 3 rows)', async () => {
  const { fetchImpl, calls } = fake(Array.from({ length: 53 }, (_, i) => row(i)));
  const rows = await rpcChainReads(cfg(fetchImpl)).getBook();
  assert.equal(rows.length, 53);
  // the first call probes for a private book (AIR-326); an older policy has no such view and the listing follows
  assert.equal(calls[0]?.params.method_name, 'get_book_root');
  const pages = calls.filter((c) => c.params.method_name === 'get_book').map((c) => JSON.parse(Buffer.from(String(c.params.args_base64), 'base64').toString('utf8')));
  assert.deepEqual(pages, [{ from_index: 0, limit: 50 }, { from_index: 50, limit: 50 }]);
});

test('getBook with exactly 50 rows asks for a second, empty page', async () => {
  const { fetchImpl, calls } = fake(Array.from({ length: 50 }, (_, i) => row(i)));
  assert.equal((await rpcChainReads(cfg(fetchImpl)).getBook()).length, 50);
  assert.equal(calls.filter((c) => c.params.method_name === 'get_book').length, 2);
});

test('latestBlockMs divides the nanosecond string with BigInt, truncating', async () => {
  const { fetchImpl, calls } = fake([]);
  assert.equal(await rpcChainReads(cfg(fetchImpl)).latestBlockMs(), 1800000000123);
  assert.deepEqual(calls[0], { method: 'block', params: { finality: 'final' } });
});

test('latestBlockMs refuses a timestamp that is not a digit string', async () => {
  const { fetchImpl } = fake([], null, '1.8e18');
  await assert.rejects(rpcChainReads(cfg(fetchImpl)).latestBlockMs());
});

test('views use finality final and the task key may be a string or null', async () => {
  const withKey = fake([], 'ed25519:abc');
  assert.equal(await rpcChainReads(cfg(withKey.fetchImpl)).getTaskKey(), 'ed25519:abc');
  assert.equal(withKey.calls[0]?.params.finality, 'final');
  assert.equal(await rpcChainReads(cfg(fake([]).fetchImpl)).getTaskKey(), null);
});

test('readSnapshot reads all five in parallel', async () => {
  const started: string[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const slow = async <T>(name: string, v: T): Promise<T> => {
    started.push(name);
    await gate;
    return v;
  };
  const reads: ChainReads = {
    getBook: () => slow('book', []),
    listAssets: () => slow('assets', []),
    getPolicy: () => slow('policy', { flags: { max_task_actions: 20, max_task_ttl_ms: '1' } }),
    getTaskKey: () => slow('key', null),
    latestBlockMs: () => slow('time', 5),
  };
  const p = readSnapshot(reads);
  await Promise.resolve();
  assert.deepEqual(started.sort(), ['assets', 'book', 'key', 'policy', 'time']);
  open();
  const s = await p;
  assert.equal(s.blockMs, 5);
  assert.equal(s.taskKey, null);
});

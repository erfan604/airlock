// The console's one JSON-RPC client (AIR-183), tested with a fake fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RpcError, rpcCall, rpcView } from '../src/chain/rpc.ts';

type Call = { url: string; body: Record<string, unknown> };

/** A fake fetch: each URL maps to a handler; every request is recorded. */
function fakeFetch(handlers: Record<string, (body: Record<string, unknown>) => Response | Promise<Response> | never>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body });
    const h = handlers[url];
    if (!h) throw new TypeError(`no handler for ${url}`);
    return h(body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', result }), { status: 200 });

test('rpc: posts the JSON-RPC envelope and returns result', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'https://a': () => ok({ height: 7 }) });
  const out = await rpcCall({ rpcUrls: ['https://a'], fetch: fetchImpl }, 'block', { finality: 'final' });
  assert.deepEqual(out, { height: 7 });
  assert.deepEqual(calls[0], { url: 'https://a', body: { jsonrpc: '2.0', id: 'airlock', method: 'block', params: { finality: 'final' } } });
});

test('rpc: a 503 on the first URL fails over to the second', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'https://a': () => new Response('busy', { status: 503 }),
    'https://b': () => ok('from-b'),
  });
  assert.equal(await rpcCall({ rpcUrls: ['https://a', 'https://b'], fetch: fetchImpl }, 'status', {}), 'from-b');
  assert.deepEqual(calls.map((c) => c.url), ['https://a', 'https://b']);
});

test('rpc: a thrown fetch and a non-JSON body both try the next URL', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'https://a': () => {
      throw new TypeError('network down');
    },
    'https://b': () => new Response('<html>gateway</html>', { status: 200 }),
    'https://c': () => ok(1),
  });
  assert.equal(await rpcCall({ rpcUrls: ['https://a', 'https://b', 'https://c'], fetch: fetchImpl }, 'm', {}), 1);
  assert.equal(calls.length, 3);
});

test('rpc: a JSON-RPC error object throws RpcError after one call and never echoes the request', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'https://a': () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, code: -32000 } }), { status: 200 }),
    'https://b': () => ok('never'),
  });
  await assert.rejects(
    rpcCall({ rpcUrls: ['https://a', 'https://b'], fetch: fetchImpl }, 'query', { account_id: 'secret-account.testnet' }),
    (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.message, 'HANDLER_ERROR');
      assert.equal(e.message.includes('secret-account'), false);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('rpc: an error without a name falls back to its rpc message', async () => {
  const { fetchImpl } = fakeFetch({
    'https://a': () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'airlock', error: { code: -32601, message: 'method is not available' } }), { status: 200 }),
  });
  await assert.rejects(rpcCall({ rpcUrls: ['https://a'], fetch: fetchImpl }, 'tx_status', {}), /method is not available/);
});

test('rpc: all URLs down throws the last error', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'https://a': () => new Response('x', { status: 500 }),
    'https://b': () => {
      throw new TypeError('b is down');
    },
  });
  await assert.rejects(rpcCall({ rpcUrls: ['https://a', 'https://b'], fetch: fetchImpl }, 'm', {}), /b is down/);
  assert.equal(calls.length, 2);
});

test('rpc: no URL at all is an error, not an undefined result', async () => {
  await assert.rejects(rpcCall({ rpcUrls: [] }, 'm', {}));
});

test('rpcView sends args_base64 equal to the base64 of the JSON args and decodes the result bytes', async () => {
  const args = { account_id: 'acct-firm.near', note: '\u00E9\u4E2D' };
  const value = { cap: '5000000000000000000000000', label: 'Accountant \u00E9' };
  const bytes = [...new TextEncoder().encode(JSON.stringify(value))];
  const { fetchImpl, calls } = fakeFetch({ 'https://a': () => ok({ result: bytes, logs: [], block_height: 1, block_hash: 'h' }) });
  const view = rpcView({ contractId: 'airlock.testnet', rpcUrls: ['https://a'], fetch: fetchImpl });
  assert.deepEqual(await view('get_book_entry', args), value);
  const params = calls[0]?.body.params as Record<string, string>;
  assert.equal(calls[0]?.body.method, 'query');
  assert.equal(params.request_type, 'call_function');
  assert.equal(params.finality, 'final');
  assert.equal(params.account_id, 'airlock.testnet');
  assert.equal(params.method_name, 'get_book_entry');
  assert.equal(params.args_base64, Buffer.from(JSON.stringify(args), 'utf8').toString('base64'));
});

test('rpcView refuses a result that is not a byte array', async () => {
  const { fetchImpl } = fakeFetch({ 'https://a': () => ok({ nope: true }) });
  await assert.rejects(rpcView({ contractId: 'c.testnet', rpcUrls: ['https://a'], fetch: fetchImpl })('m', {}));
});

test('rpc.ts stays browser safe: no number parsing and no Node imports', () => {
  const src = readFileSync(new URL('../src/chain/rpc.ts', import.meta.url), 'utf8');
  assert.equal(/Number\(|parseInt|parseFloat|node:|near-api-js/.test(src), false);
});

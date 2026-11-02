// AIR-182: the chain status reader and the poller. The one view client is AIR-183's rpcView.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestState } from '@airlock/runtime/chain-types';
import { rpcGetPending, rpcGetRequest, waitForRequest, walletConfig } from '../src/wallet/status.ts';
import { NEAR_RPC } from '../csp.ts';

const view = (id: string, state: string) => ({
  request_id: `${'ab'.repeat(32)}:${id}`,
  id,
  state,
  agent: 'agent.testnet',
  task_id: 'ab'.repeat(32),
  asset: 'near',
  payee: 'near:a.testnet',
  amount: '1',
  labels: { recipient: 0, amount: 0, pc: 0 },
  reason: 'NewRecipient',
  book_status: 'not_in_book',
  display: { asset_symbol: 'NEAR', amount_decimal: '0.000000000000000000000001' },
  created_ms: '1',
  expires_ms: '2',
  digest: null,
  exec: null,
});

function rpcFetch(answer: (method: string, args: unknown) => unknown, log: { method: string; args: unknown }[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { params: { method_name: string; args_base64: string; request_type: string; finality: string } };
    assert.equal(body.params.request_type, 'call_function');
    assert.equal(body.params.finality, 'final');
    const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8')) as unknown;
    log.push({ method: body.params.method_name, args });
    const bytes = [...Buffer.from(JSON.stringify(answer(body.params.method_name, args)), 'utf8')];
    return Response.json({ jsonrpc: '2.0', id: 'airlock', result: { result: bytes } });
  }) as unknown as typeof fetch;
}

test('status: rpcGetRequest reads get_request and parses the view; JSON null is null', async () => {
  const log: { method: string; args: unknown }[] = [];
  const f = rpcFetch((m, a) => ((a as { id: string }).id === '7' ? view('7', 'Pending') : null), log);
  const read = rpcGetRequest({ contractId: 'policy.testnet', rpcUrls: ['https://rpc.example'], fetch: f });
  const v = await read('7');
  assert.equal(v?.state, 'Pending');
  assert.equal(v?.id, '7');
  assert.equal(await read('8'), null);
  assert.deepEqual(log[0], { method: 'get_request', args: { id: '7' } });
});

test('status: rpcGetPending reads get_pending and parses each view', async () => {
  const log: { method: string; args: unknown }[] = [];
  const f = rpcFetch(() => [view('1', 'Pending'), view('2', 'Pending')], log);
  const list = await rpcGetPending({ contractId: 'policy.testnet', rpcUrls: ['https://rpc.example'], fetch: f })();
  assert.deepEqual(list.map((v) => v.id), ['1', '2']);
  assert.equal(log[0]?.method, 'get_pending');
});

test('status: waitForRequest returns the first view whose state is wanted', async () => {
  const states: (string | null)[] = ['Pending', 'Pending', 'Executing'];
  let n = 0;
  const read = async (id: string) => {
    const s = states[Math.min(n++, states.length - 1)];
    return s === null || s === undefined ? null : (view(id, s) as never);
  };
  const until: ReadonlySet<RequestState> = new Set<RequestState>(['Executing', 'Executed']);
  const v = await waitForRequest(read, '7', until, { timeoutMs: 2000, pollMs: 5 });
  assert.equal(v?.state, 'Executing');
  assert.equal(n, 3);
});

test('status: waitForRequest returns null on timeout and keeps polling through a read error', async () => {
  let n = 0;
  const read = async (): Promise<never> => {
    n += 1;
    throw new Error('rpc down');
  };
  const t0 = Date.now();
  const v = await waitForRequest(read, '7', new Set<RequestState>(['Executed']), { timeoutMs: 60, pollMs: 10 });
  assert.equal(v, null);
  assert.ok(n >= 2, `polled ${n} times`);
  assert.ok(Date.now() - t0 < 1000);
});

test('status: walletConfig reads VITE_CONTRACT_ID, throws without it and lists the NEAR testnet nodes in order', () => {
  const cfg = walletConfig({ VITE_CONTRACT_ID: 'policy.testnet' });
  assert.equal(cfg.contractId, 'policy.testnet');
  assert.deepEqual(cfg.rpcUrls, [...NEAR_RPC]);
  assert.throws(() => walletConfig({}), /VITE_CONTRACT_ID/);
  assert.throws(() => walletConfig({ VITE_CONTRACT_ID: '' }), /VITE_CONTRACT_ID/);
});

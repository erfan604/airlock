// AIR-322: fixes from the 2026-11-07 hard test of the agent stack. H1 testnet-only guard, M1 hardlinks, M2 chain read failures,
// M3 non-object params, L5 IPv6 transition ranges, L2 handle cap, L6 one-line config errors.
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseConfig } from '../src/mcp/config.ts';
import { assertTestnetNetwork } from '../src/mcp/network.ts';
import { isPublicAddress } from '../src/mcp/fetch.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import { Session } from '../src/mcp/session.ts';
import type { SessionChain } from '../src/mcp/session.ts';

const base = { network: 'testnet', owner_id: 'o.testnet', contract_id: 'p.testnet', agent_id: 'a.testnet', agent_credentials: 'agent.json', task_key_file: 'k', request: 'Pay Acme 1 NEAR', bounds: [{ payee: 'acme', max_total: '1' }] };

// ---- H1 ----

const statusFetch = (chain: string, seen: string[] = []): typeof fetch =>
  (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { chain_id: chain } }), { status: 200 });
  }) as typeof fetch;

test('H1: a sandbox config is refused unless every RPC is a loopback address', () => {
  const sb = { ...base, network: 'sandbox', owner_id: 'o.test.near', contract_id: 'p.test.near', agent_id: 'a.test.near' };
  assert.throws(() => parseConfig({ ...sb, rpc: ['https://rpc.near.org'] }, '/c'), /loopback/);
  assert.throws(() => parseConfig(sb, '/c'), /loopback/);
  assert.throws(() => parseConfig({ ...sb, rpc: ['http://127.0.0.1:3030', 'https://rpc.near.org'] }, '/c'), /loopback/);
  for (const rpc of ['http://127.0.0.1:3030', 'http://localhost:3030', 'http://[::1]:3030']) assert.equal(parseConfig({ ...sb, rpc: [rpc] }, '/c').network, 'sandbox');
});

test('H1: a sandbox config with a mainnet account (x.near) is refused', () => {
  const sb = { ...base, network: 'sandbox', rpc: ['http://127.0.0.1:3030'] };
  assert.throws(() => parseConfig({ ...sb, owner_id: 'x.near', contract_id: 'p.test.near', agent_id: 'a.test.near' }, '/c'), /testnet only/);
  assert.throws(() => parseConfig({ ...sb, owner_id: 'o.test.near', contract_id: 'x.near', agent_id: 'a.test.near' }, '/c'), /testnet only/);
  assert.throws(() => parseConfig({ ...sb, owner_id: 'o.test.near', contract_id: 'p.test.near', agent_id: 'x.near' }, '/c'), /testnet only/);
  assert.equal(parseConfig({ ...sb, owner_id: 'o.test.near', contract_id: 'p.test.near', agent_id: 'a.test.near' }, '/c').owner_id, 'o.test.near');
});

test('H1: a testnet config still needs .testnet accounts', () => {
  assert.throws(() => parseConfig({ ...base, owner_id: 'x.near' }, '/c'), /testnet only/);
  assert.throws(() => parseConfig({ ...base, agent_id: 'x.test.near' }, '/c'), /testnet only/);
});

test('H1: the boot check asks each RPC for status and refuses mainnet endpoints (rpc.near.org, free.rpc.fastnear.com, near.lava.build)', async () => {
  for (const host of ['rpc.near.org', 'free.rpc.fastnear.com', 'near.lava.build']) {
    const cfg = parseConfig({ ...base, rpc: [`https://${host}`] }, '/c');
    const seen: string[] = [];
    await assert.rejects(() => assertTestnetNetwork(cfg, statusFetch('mainnet', seen)), /testnet only: .* is not testnet/);
    assert.equal(seen.length, 1);
    assert.ok(seen[0]?.includes(host));
  }
});

test('H1: the boot check passes on testnet, refuses when any listed RPC is not testnet, and fails closed when none answers', async () => {
  const cfg = parseConfig({ ...base, rpc: ['https://test.rpc.fastnear.com'] }, '/c');
  await assertTestnetNetwork(cfg, statusFetch('testnet'));
  const mixed = parseConfig({ ...base, rpc: ['https://test.rpc.fastnear.com', 'https://rpc.near.org'] }, '/c');
  const f = (async (url: string | URL | Request) => new Response(JSON.stringify({ result: { chain_id: String(url).includes('test.') ? 'testnet' : 'mainnet' } }))) as typeof fetch;
  await assert.rejects(() => assertTestnetNetwork(mixed, f), /not testnet/);
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(() => assertTestnetNetwork(cfg, down), /could not confirm/);
  const junk = (async () => new Response('nope', { status: 502 })) as typeof fetch;
  await assert.rejects(() => assertTestnetNetwork(cfg, junk), /could not confirm/);
});

test('H1: a loopback sandbox needs no status check', async () => {
  const sb = parseConfig({ ...base, network: 'sandbox', owner_id: 'o.test.near', contract_id: 'p.test.near', agent_id: 'a.test.near', rpc: ['http://127.0.0.1:3030'] }, '/c');
  const seen: string[] = [];
  await assertTestnetNetwork(sb, statusFetch('localnet', seen));
  assert.equal(seen.length, 0);
});

// ---- helpers ----

const chain: SessionChain = {
  getBook: async () => [],
  listAssets: async () => [],
  getPolicy: async () => {
    throw new Error('unused');
  },
  latestBlockMs: async () => 0,
  submitBatch: async () => {
    throw new Error('unused');
  },
};

function sess(over: { chain?: SessionChain; filesDir?: string | null } = {}): Session {
  let n = 0;
  return new Session({
    config: { ownerId: 'o.testnet', contractId: 'p.testnet', agentId: 'a.testnet', request: 'Pay Acme 1 NEAR', bounds: [{ payee: 'acme', max_total: '1' }], maxActions: 8, ttlMs: 60_000, explorer: null, rpcHost: 'rpc.example' },
    chain: over.chain ?? chain,
    sources: { inbox: [{ id: 'm1', from: 'a@b.c', subject: 's', body: 'b', attachments: [] }], pages: {}, filesDir: over.filesDir ?? null },
    signTask: () => new Uint8Array(64),
    clock: () => 1_800_000_000_000,
    randomHex: (b) => {
      n += 1;
      return n.toString(16).padStart(2 * b, '0');
    },
  });
}

// ---- M1 ----

test('M1: read_file refuses a hardlink to a file outside its directory and a regular file with more than one link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airlock-hl-'));
  mkdirSync(join(dir, 'box'));
  writeFileSync(join(dir, 'secret.txt'), 'TOPSECRET');
  writeFileSync(join(dir, 'box', 'ok.txt'), 'fine');
  linkSync(join(dir, 'secret.txt'), join(dir, 'box', 'hard.txt'));
  const s = sess({ filesDir: join(dir, 'box') });
  assert.throws(() => s.readFile('hard.txt'), /more than one link/);
  assert.equal((s.readFile('ok.txt').content as { text: string }).text, 'fine');
});

// ---- M2 ----

test('M2: pay and book_list say the chain read failed, and send nothing', async () => {
  const failing: SessionChain = {
    ...chain,
    getBook: async () => {
      throw new TypeError('fetch failed');
    },
  };
  const s = sess({ chain: failing });
  const r = await s.pay({ payee: 'acme', amount: '1' });
  assert.equal(r.verdict, 'Refused');
  assert.equal(r.reason, 'ChainReadFailed');
  assert.match(String((r as { message?: string }).message ?? ''), /could not read the policy from the chain: rpc\.example/);
  await assert.rejects(() => s.bookList(), /could not read the policy from the chain: rpc\.example/);
});

test('M2: over the protocol the failure is a tool error with that message, not a bare TypeError', async () => {
  const failing: SessionChain = {
    ...chain,
    getBook: async () => {
      throw new TypeError('fetch failed');
    },
  };
  const server = createMcpServer(sess({ chain: failing }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = await client.callTool({ name: 'book_list', arguments: {} });
  assert.equal(res.isError, true);
  const text = JSON.stringify(res.content);
  assert.match(text, /could not read the policy from the chain/);
  assert.doesNotMatch(text, /TypeError/);
});

// ---- L5 ----

test('L5: the IPv6 transition ranges are not public addresses', () => {
  for (const a of ['2002:c000:204::1', '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '::7f00:1', '::a00:1', '::ffff:0:7f00:1', '::ffff:7f00:1']) assert.equal(isPublicAddress(a), false, a);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('93.184.216.34'), true);
});

// ---- L2 ----

test('L2: the handle table is capped and the oldest handles go first', () => {
  const s = sess();
  const first = (s.readEmail().emails as { from: { h: string } }[])[0]?.from.h as string;
  assert.ok(s.labelsOf(first) !== undefined);
  for (let i = 0; i < 3000; i++) s.readEmail();
  assert.equal(s.labelsOf(first), undefined);
  const last = (s.readEmail().emails as { from: { h: string } }[])[0]?.from.h as string;
  assert.ok(s.labelsOf(last) !== undefined);
});

// ---- L6 ----

test('L6: a tool call with bad arguments gives a one line error, no zod dump', async () => {
  const server = createMcpServer(sess());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = await client.callTool({ name: 'read_file', arguments: { name: 5 } }).catch((e: unknown) => ({ content: [{ type: 'text', text: String((e as Error).message) }], isError: true }));
  const text = JSON.stringify(res.content);
  assert.equal(text.includes('\\n'), false, text);
  assert.ok(text.length < 300, text);
});

// ---- M3 ----

test('M3: over stdio, a tools/call with non-object params gets a -32602 reply, and later calls still work', async () => {
  const { PassThrough } = await import('node:stream');
  const { createStdioTransport } = await import('../src/mcp/stdio.ts');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const replies: Record<string, unknown>[] = [];
  let buf = '';
  stdout.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
      replies.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      buf = buf.slice(i + 1);
    }
  });
  await createMcpServer(sess()).connect(createStdioTransport(stdin, stdout));
  const send = (m: object): void => void stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: 'string' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: null });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: [1] });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'owner_request', arguments: {} } });
  for (let i = 0; i < 50 && replies.length < 5; i++) await new Promise((r) => setTimeout(r, 40));
  const byId = (id: number): Record<string, unknown> | undefined => replies.find((r) => r.id === id);
  for (const id of [2, 3, 4]) assert.equal((byId(id)?.error as { code: number } | undefined)?.code, -32602, `id ${String(id)}`);
  assert.ok(byId(5)?.result !== undefined);
  stdin.end();
});

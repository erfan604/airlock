// AIR-169: the composition root. Replay mode on the sandbox contract id with stub parts; the real world file where a test needs it.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveSender } from '../src/chain/evm.ts';
import { ConfigError } from '../src/config.ts';
import { ModelNotAllowed, scriptedLlm, setLlmOverride } from '../src/llm/index.ts';
import type { Grounder } from '../src/interpreter/index.ts';
import { buildAgentDeps } from '../src/server/deps.ts';
import type { Snapshot } from '../src/server/deps.ts';
import { startRuntime } from '../src/server/main.ts';
import type { RunningRuntime } from '../src/server/main.ts';
import { WorldError } from '../src/tools/world.ts';
import { U01, payNPlan } from './helpers/agent.ts';
import { stubBook, stubExtract } from './helpers/interp.ts';
import { STUB_AGENT, STUB_CONTRACT, driveTask, runStubTask, stubChain, stubEnv, stubParts, stubWorld } from './helpers/stub-runtime.ts';
import type { TraceEvent } from '../src/interpreter/trace.ts';

const running: RunningRuntime[] = [];
afterEach(async () => {
  setLlmOverride(null);
  while (running.length > 0) await running.pop()?.close();
});

async function start(env = stubEnv(), parts = stubParts(stubChain(), { plan: U01 })): Promise<RunningRuntime> {
  const rt = await startRuntime(env, parts);
  running.push(rt);
  return rt;
}

const verdicts = (events: TraceEvent[]): TraceEvent[] => events.filter((e) => e.kind === 'verdict');

async function refuses(port: string, host = '127.0.0.1'): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/session`, { signal: AbortSignal.timeout(2000) });
    return false;
  } catch {
    return true;
  }
}

test('U01 over HTTP: draft, confirm, run to done, the chain stub sees the accountant', async () => {
  const out = await runStubTask({ plan: U01, ownerText: 'Pay my accountant the April invoice.' });
  const v = verdicts(out.events);
  assert.equal(v.length, 1);
  assert.equal(v[0]?.data.outcome, 'allowed');
  assert.equal(out.submitted.length, 1);
  assert.equal(out.submitted[0]?.payee, 'near:accountant.testnet');
  assert.equal(out.events.some((e) => e.kind === 'error'), false);
  console.log('U01_VIA_HTTP allowed');
});

test('a QUARANTINE_MODEL outside TEE_MODELS rejects before any socket is opened', async () => {
  const lines: string[] = [];
  await assert.rejects(startRuntime(stubEnv({ QUARANTINE_MODEL: 'x-ai/grok-4.7' }), stubParts(stubChain(), { plan: U01, log: (l) => lines.push(l) })), ModelNotAllowed);
  await assert.rejects(startRuntime(stubEnv({ PLANNER_MODEL: 'not/a-model' }), stubParts(stubChain(), { plan: U01 })), ModelNotAllowed);
  assert.deepEqual(lines, [], 'the fingerprint line comes right before listening, so it was never printed');
});

test('8. a QUARANTINE_MODEL with no chat-token list rejects with NoChatTokens before any socket is opened', async () => {
  const lines: string[] = [];
  const parts = stubParts(stubChain(), { plan: U01, log: (l) => lines.push(l) });
  delete parts.extract;
  await assert.rejects(startRuntime(stubEnv({ QUARANTINE_MODEL: 'moonshotai/kimi-k3' }), parts), /NoChatTokens: moonshotai\/kimi-k3/);
  assert.deepEqual(lines, [], 'the fingerprint line comes right before listening, so it was never printed');
});

test('a valid QUARANTINE_MODEL override reaches makeExtractor', async () => {
  const s = scriptedLlm(() => JSON.stringify({ amount: '4.2' }));
  setLlmOverride(s.complete);
  const parts = stubParts(stubChain(), { plan: U01 });
  delete parts.extract;
  const rt = await start(stubEnv({ QUARANTINE_MODEL: 'Qwen/Qwen3.6-35B-A3B-FP8' }), parts);
  const got = await rt.agentDeps.extract({ data: 'Pay 4.2 NEAR', schema: { amount: 'amount' }, instruction: 'the amount' });
  assert.equal(got.amount, '4.2');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]?.model, 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.equal(s.calls[0]?.role, 'quarantine');
});

test('the snapshot is read at start and again before each run, and a moved alias proposes the new key', async () => {
  const stub = stubChain();
  const rt = await start(stubEnv(), stubParts(stub, { plan: U01 }));
  assert.deepEqual(stub.calls, { getBook: 1, listAssets: 1 });
  const first = await driveTask(rt.url, { ownerText: 'Pay my accountant.' });
  assert.equal(first.state, 'done');
  assert.deepEqual(stub.calls, { getBook: 2, listAssets: 2 });
  assert.equal(stub.submitted[0]?.payee, 'near:accountant.testnet');
  stub.book.rows = [['near:newaccountant.testnet', { cap: null, daily_untrusted_budget: '0', daily_limit: '1000', label: 'accountant' }]];
  const second = await driveTask(rt.url, { ownerText: 'Pay my accountant.' });
  assert.equal(second.state, 'done');
  assert.deepEqual(stub.calls, { getBook: 3, listAssets: 3 });
  assert.equal(stub.submitted[1]?.payee, 'near:newaccountant.testnet');
});

test('evmSender is the derived address of the registry path', async () => {
  const rt = await start();
  assert.equal(rt.agentDeps.evmSender('evm:84532:native'), await deriveSender(STUB_CONTRACT, 'airlock-demo-1'));
  assert.equal(rt.agentDeps.evmSender('near'), null);
  assert.notEqual(rt.agentDeps.fees('evm:84532:native'), null);
  assert.equal(rt.agentDeps.decimalsOf('near'), 24);
});

test('a hook passed in parts.hooks.ground is called for an action amount literal', async () => {
  const seen: { lit: string | number; kind: string }[] = [];
  const ground: Grounder = (lit, kind) => {
    seen.push({ lit, kind });
    return true;
  };
  const out = await runStubTask({ plan: payNPlan(1), ownerText: 'Pay my accountant 1 NEAR.', hooks: { ground } });
  assert.equal(verdicts(out.events).length, 1);
  assert.ok(seen.some((s) => s.kind === 'amount' && String(s.lit) === '1'), JSON.stringify(seen));
});

test('makeTools scopes the inbox to one item and the paste to read_paste', async () => {
  const world = stubWorld({
    inbox: [
      { id: 'm1', from: 'a@x.co', subject: 's1', body: 'one', attachments: [] },
      { id: 'm2', from: 'b@x.co', subject: 's2', body: 'two', attachments: [] },
    ],
  });
  const rt = await start(stubEnv(), stubParts(stubChain(), { plan: U01, world }));
  const tools = rt.agentDeps.makeTools({ itemId: 'm2', paste: 'x' });
  const inbox = (await tools.call('read_inbox', {})).raw as { id: string }[];
  assert.deepEqual(inbox.map((m) => m.id), ['m2']);
  assert.equal((await tools.call('read_paste', {})).raw, 'x');
  const all = (await rt.agentDeps.makeTools({ itemId: null, paste: null }).call('read_inbox', {})).raw as { id: string }[];
  assert.deepEqual(all.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(await rt.agentDeps.inboxItemIds(), ['m1', 'm2']);
});

test('the boot fingerprint is logged once, before the server answers', async () => {
  const lines: string[] = [];
  const rt = await start(stubEnv(), stubParts(stubChain(), { plan: U01, log: (l) => lines.push(l) }));
  const fp = createHash('sha256').update(STUB_AGENT, 'utf8').digest('hex').slice(0, 12);
  assert.deepEqual(lines, [`AIRLOCK agent fingerprint ${fp} for ${STUB_AGENT}`]);
  assert.equal((await fetch(`${rt.url}/session`)).status, 200);
  assert.equal(lines.length, 1);
});

test('the url is loopback by default and close() makes the port refuse', async () => {
  const rt = await startRuntime(stubEnv(), stubParts(stubChain(), { plan: U01 }));
  assert.match(rt.url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  const port = rt.url.slice(rt.url.lastIndexOf(':') + 1);
  assert.equal((await fetch(`${rt.url}/session`)).status, 200);
  assert.equal(await refuses(port), false);
  await rt.close();
  assert.equal(await refuses(port), true);
});

test('replay mode on a contract id that is not .test.near is refused by createApp', async () => {
  const lines: string[] = [];
  await assert.rejects(startRuntime(stubEnv({ POLICY_CONTRACT_ID: 'policy.testnet' }), stubParts(stubChain(), { plan: U01, log: (l) => lines.push(l) })), RangeError);
  assert.deepEqual(lines, []);
});

test('a bad configuration is a ConfigError and nothing is built', async () => {
  const stub = stubChain();
  await assert.rejects(startRuntime({}, stubParts(stub, { plan: U01 })), ConfigError);
  assert.deepEqual(stub.calls, { getBook: 0, listAssets: 0 });
});

test('AIRLOCK_SCENARIO picks the inbox of the scenario in the default world file', async () => {
  const parts = (): ReturnType<typeof stubParts> => {
    const p = stubParts(stubChain(), { plan: U01 });
    delete p.world;
    return p;
  };
  const b01 = await start(stubEnv({ AIRLOCK_SCENARIO: 'B01' }), parts());
  assert.deepEqual(await b01.agentDeps.inboxItemIds(), ['inv-april-correction']);
  const all = await start(stubEnv(), parts());
  const ids = await all.agentDeps.inboxItemIds();
  assert.ok((ids[0] ?? '').startsWith('inv-april'), ids.join(','));
  assert.ok(ids.length > 1);
});

test('an unknown scenario rejects with WorldError and leaves no listening socket', async () => {
  const lines: string[] = [];
  const p = stubParts(stubChain(), { plan: U01, log: (l) => lines.push(l) });
  delete p.world;
  await assert.rejects(startRuntime(stubEnv({ AIRLOCK_SCENARIO: 'NOPE' }), p), WorldError);
  assert.deepEqual(lines, []);
});

test('a failure of getBook at start-up rejects and leaves no listening socket', async () => {
  const lines: string[] = [];
  const stub = stubChain();
  stub.book.failWith = new Error('rpc down');
  await assert.rejects(startRuntime(stubEnv(), stubParts(stub, { plan: U01, log: (l) => lines.push(l) })), /rpc down/);
  assert.deepEqual(lines, []);
});

test('buildAgentDeps: tools are scoped per item and every snapshot field is read at call time', async () => {
  const world = stubWorld({
    inbox: [
      { id: 'm1', from: 'a@x.co', subject: 's1', body: 'one', attachments: [] },
      { id: 'm2', from: 'b@x.co', subject: 's2', body: 'two', attachments: [] },
    ],
  });
  let snap: Snapshot = { book: stubBook([['near:accountant.testnet', 'accountant']]), decimalsOf: () => 24, fees: () => null, evmSender: () => null };
  const wiring = { world, extract: stubExtract({}).extract, chain: stubChain().chain, evidence: { put: () => 'stored' as const, evidenceFor: () => null }, clock: () => 7, rpcUrls: ['http://rpc.invalid'] };
  const deps = buildAgentDeps(wiring, () => snap);
  const one = (await deps.makeTools({ itemId: 'm2', paste: null }).call('read_inbox', {})).raw as { id: string }[];
  assert.deepEqual(one.map((m) => m.id), ['m2']);
  const pasted = deps.makeTools({ itemId: null, paste: 'text' });
  assert.equal((await pasted.call('read_paste', {})).raw, 'text');
  assert.equal(((await pasted.call('read_inbox', {})).raw as unknown[]).length, 2);
  assert.equal((await deps.makeTools({ itemId: null, paste: null }).call('read_paste', {})).raw, '');
  assert.equal(deps.book.resolve('accountant'), 'near:accountant.testnet');
  assert.equal(deps.decimalsOf('near'), 24);
  assert.equal(deps.evmSender('evm:84532:native'), null);
  snap = { book: stubBook([['near:other.testnet', 'accountant']]), decimalsOf: () => 6, fees: () => ({ gas_limit: 1n, max_fee_per_gas: 2n, max_priority_fee_per_gas: 3n }), evmSender: () => '0xabc' };
  assert.equal(deps.book.resolve('accountant'), 'near:other.testnet');
  assert.equal(deps.decimalsOf('near'), 6);
  assert.equal(deps.fees('evm:84532:native')?.gas_limit, 1n);
  assert.equal(deps.evmSender('evm:84532:native'), '0xabc');
  assert.equal(deps.clock(), 7);
});

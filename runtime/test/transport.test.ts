// AIR-160: the transports. Recording and replay of views (no consumer replays a submit), and the live transport against a mock JSON-RPC
// server: one signature per batch, the same bytes on every send, the node's outcome mapped to an RpcTx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPairSigner, baseEncode } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { InvalidNonceError } from 'near-api-js/rpc-errors';
import { ChainClient } from '../src/chain/near.ts';
import { ChainError } from '../src/chain/errors.ts';
import { RpcPool } from '../src/chain/rpc.ts';
import { signerFromCredentials } from '../src/chain/signer.ts';
import { LiveTransport, RecordingTransport, ReplayTransport, canonicalJson } from '../src/chain/transport.ts';
import type { RecordingFile } from '../src/chain/transport.ts';
import { ScriptedTransport, idOf, rawView, req } from './helpers/chain-double.ts';
import { blockReply, http503, rpcError, rpcResult, startMockRpc } from './helpers/mock-rpc.ts';
import type { MockCall, MockReply, MockRpc } from './helpers/mock-rpc.ts';

const dir = mkdtempSync(join(tmpdir(), 'airlock-chain-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const fileOf = (name: string): string => join(dir, `${name}.json`);
const readFile = (file: string): RecordingFile => JSON.parse(readFileSync(file, 'utf8')) as RecordingFile;
const isMiss = (error: unknown): boolean => error instanceof ChainError && error.code === 'ReplayMiss';

// ---- recording and replay ----

test('a RecordingTransport over a double writes a file that a ReplayTransport answers for the same view and block calls', async () => {
  const inner = new ScriptedTransport();
  inner.views.set(idOf(0), rawView(req(0)));
  inner.answers.set('get_policy', { owner_id: 'test.near' });
  const file = fileOf('roundtrip');
  const recording = new RecordingTransport(inner, file);
  const live = [await recording.view('get_request', { id: idOf(0) }), await recording.view('get_policy', {}), await recording.blockNanosec()];
  const replay = new ReplayTransport(file);
  assert.equal(replay.contractId, 'policy.test.near');
  assert.deepEqual(await replay.view('get_request', { id: idOf(0) }), live[0]);
  assert.deepEqual(await replay.view('get_policy', {}), live[1]);
  assert.equal(await replay.blockNanosec(), live[2]);
});

test('the recording file is valid after every call and leaves no temp file behind', async () => {
  const inner = new ScriptedTransport();
  inner.answers.set('get_policy', { owner_id: 'test.near' });
  const file = fileOf('every-call');
  const recording = new RecordingTransport(inner, file);
  await recording.view('get_policy', {});
  assert.equal(readFile(file).entries.length, 1);
  await recording.blockNanosec();
  const parsed = readFile(file);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.contractId, 'policy.test.near');
  assert.deepEqual(parsed.entries.map((e) => e.kind), ['view', 'block']);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
});

test('a submit entry carries the method and arguments given to prepare and is written after submit answers', async () => {
  const inner = new ScriptedTransport();
  const outcome = { hash: 'HASH1', returnValue: [], logs: [], failure: null };
  inner.submitSteps.push(() => outcome);
  const file = fileOf('submit');
  const recording = new RecordingTransport(inner, file);
  const args = { reqs: [], task_sig: 'AAAA' };
  const tx = await recording.prepare('submit_batch', args, 300_000_000_000_000n);
  assert.equal(existsSync(file), false, 'prepare writes nothing');
  await recording.submit(tx);
  const entries = readFile(file).entries;
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { kind: 'submit', method: 'submit_batch', args, result: outcome });
});

test('an entry is not written for a call that threw', async () => {
  const inner = new ScriptedTransport();
  const file = fileOf('threw');
  const recording = new RecordingTransport(inner, file);
  await assert.rejects(recording.view('get_policy', {}));
  assert.equal(existsSync(file), false);
});

test('a ReplayTransport answers a key as a queue: the recorded results in order, the last one repeating', async () => {
  const file = fileOf('queue');
  const entry = (result: unknown) => ({ kind: 'view', method: 'get_request', args: { id: 'x' }, result });
  writeFileSync(file, JSON.stringify({ version: 1, contractId: 'policy.test.near', entries: [entry('first'), entry('second'), { kind: 'block', method: 'block', args: {}, result: '10' }, { kind: 'block', method: 'block', args: {}, result: '20' }] }));
  const replay = new ReplayTransport(file);
  assert.deepEqual([await replay.view('get_request', { id: 'x' }), await replay.view('get_request', { id: 'x' }), await replay.view('get_request', { id: 'x' })], ['first', 'second', 'second']);
  assert.deepEqual([await replay.blockNanosec(), await replay.blockNanosec(), await replay.blockNanosec()], ['10', '20', '20']);
});

test('the key is the method and the canonical JSON of the args: key order does not matter, a different value does', async () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } }), '{"a":{"c":null,"d":[2,{"z":1}]},"b":1}');
  const file = fileOf('canonical');
  writeFileSync(file, JSON.stringify({ version: 1, contractId: 'c', entries: [{ kind: 'view', method: 'get_ledgers', args: { payee: 'p', asset: 'near', task: null }, result: 'ok' }] }));
  const replay = new ReplayTransport(file);
  assert.equal(await replay.view('get_ledgers', { task: null, asset: 'near', payee: 'p' }), 'ok');
  await assert.rejects(replay.view('get_ledgers', { task: null, asset: 'near', payee: 'q' }), isMiss);
});

test('an unrecorded view and every prepare, submit and txStatus throw ReplayMiss; an empty block queue too', async () => {
  const file = fileOf('misses');
  writeFileSync(file, JSON.stringify({ version: 1, contractId: 'c', entries: [] }));
  const replay = new ReplayTransport(file);
  await assert.rejects(replay.view('get_policy', {}), isMiss);
  await assert.rejects(replay.blockNanosec(), isMiss);
  await assert.rejects(replay.prepare(), isMiss);
  await assert.rejects(replay.submit(), isMiss);
  await assert.rejects(replay.txStatus(), isMiss);
});

test('a ReplayTransport refuses a file that is not a version 1 recording', () => {
  const file = fileOf('bad');
  writeFileSync(file, JSON.stringify({ version: 2, contractId: 'c', entries: [] }));
  assert.throws(() => new ReplayTransport(file));
});

test('a ChainClient over a ReplayTransport needs no signer and answers its recorded views; with neither signer nor transport it throws', async () => {
  const inner = new ScriptedTransport();
  inner.views.set(idOf(0), rawView(req(0), 'Executed'));
  const file = fileOf('client');
  await new RecordingTransport(inner, file).view('get_request', { id: idOf(0) });
  const client = new ChainClient({ network: 'testnet', contractId: 'policy.test.near', agentAccountId: 'agent.test.near', transport: new ReplayTransport(file) });
  const seen = await client.getRequest(idOf(0));
  assert.equal(seen?.state, 'Executed');
  await assert.rejects(client.getRequest(idOf(1)), isMiss);
  assert.throws(() => new ChainClient({ network: 'testnet', contractId: 'policy.test.near', agentAccountId: 'agent.test.near' } as never), TypeError);
});

// ---- the live transport against a mock node ----

const servers: MockRpc[] = [];
test.after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const SECRET = `ed25519:${baseEncode(new Uint8Array(32).fill(2))}` as KeyPairString;
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');
const EVENT = (name: string, data: unknown): string => `EVENT_JSON:${JSON.stringify({ standard: 'airlock', version: '1.0.0', event: name, data: [data] })}`;

function outcomeReply(status: unknown, receipts: { executor: string; logs: string[] }[] = []): MockReply {
  return rpcResult({
    final_execution_status: 'FINAL',
    status,
    transaction: { hash: 'NODEHASH' },
    transaction_outcome: { id: 'NODEHASH', outcome: { executor_id: 'agent.test.near', logs: ['not read'] } },
    receipts_outcome: receipts.map((r) => ({ outcome: { executor_id: r.executor, logs: r.logs } })),
  });
}

async function liveWorld(sendReply: (n: number) => MockReply, txReply: () => MockReply = () => outcomeReply('NotStarted')) {
  let sends = 0;
  const server = await startMockRpc((call: MockCall) => {
    switch (call.method) {
      case 'block':
        return blockReply('1800000000123456789');
      case 'send_tx':
        sends += 1;
        return sendReply(sends);
      case 'tx':
        return txReply();
      case 'query': {
        const params = call.params as { request_type: string; method_name?: string };
        if (params.request_type === 'view_access_key') return rpcResult({ nonce: 5, permission: 'FullAccess', block_height: 1, block_hash: '11111111111111111111111111111111' });
        if (params.method_name === 'get_nothing') return rpcResult({ result: [...Buffer.from('null')], logs: [], block_height: 1, block_hash: 'x' });
        return rpcResult({ result: [...Buffer.from(JSON.stringify({ via: params.method_name }))], logs: [], block_height: 1, block_hash: 'x' });
      }
      default:
        return rpcError({ name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'METHOD_NOT_FOUND', info: { method_name: call.method } } });
    }
  });
  servers.push(server);
  const transport = new LiveTransport({
    contractId: 'policy.test.near',
    agentAccountId: 'agent.test.near',
    signer: KeyPairSigner.fromSecretKey(SECRET),
    pool: new RpcPool([server.url], { retries: 1, wait: 0, backoff: 1 }),
  });
  return { server, transport };
}

test('LiveTransport.view calls the contract with `method` and returns the parsed JSON; null stays null; blockNanosec keeps every digit', async () => {
  const { server, transport } = await liveWorld(() => outcomeReply({ SuccessValue: '' }));
  assert.deepEqual(await transport.view('get_policy', {}), { via: 'get_policy' });
  assert.equal(await transport.view('get_nothing', {}), null);
  assert.equal(await transport.blockNanosec(), '1800000000123456789');
  const query = server.calls.find((c) => c.method === 'query');
  assert.equal((query?.params as { method_name?: string }).method_name, 'get_policy');
});

test('one batch is signed once: prepare gives the hash first, and two sends carry the identical signed bytes', async () => {
  const { server, transport } = await liveWorld(() => outcomeReply({ SuccessValue: b64([{ request_id: 'r', outcome: 'allowed', reason: null, pending_id: null }]) }));
  const tx = await transport.prepare('submit_batch', { reqs: [], task_sig: 'AAAA' }, 300_000_000_000_000n);
  assert.match(tx.hash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const first = await transport.submit(tx);
  const second = await transport.submit(tx);
  const sends = server.calls.filter((c) => c.method === 'send_tx').map((c) => (c.params as { signed_tx_base64: string }).signed_tx_base64);
  assert.equal(sends.length, 2);
  assert.equal(sends[0], sends[1]);
  assert.deepEqual(first, second);
  assert.equal(first.hash, 'NODEHASH');
  assert.deepEqual(first.returnValue, [{ request_id: 'r', outcome: 'allowed', reason: null, pending_id: null }]);
  assert.equal(server.calls.filter((c) => c.method === 'query').length, 1, 'one access key read: the nonce is cached for the next batch');
});

test('submit reads the panic of a failed outcome without its prefix, and decodes only the events of the policy contract', async () => {
  const failed = await liveWorld(() =>
    outcomeReply({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: request mismatch' } } } } }),
  );
  const tx = await failed.transport.prepare('submit_batch', {}, 1n);
  const out = await failed.transport.submit(tx);
  assert.equal(out.failure, 'request mismatch');
  assert.equal(out.returnValue, undefined);

  const paid = EVENT('paid', { request_id: 'r', payee: 'near:p.test.near', amount: '5' });
  const foreign = EVENT('blocked', { request_id: 'r', reason: 'x' });
  const ok = await liveWorld(() =>
    outcomeReply({ SuccessValue: b64([]) }, [
      { executor: 'policy.test.near', logs: [paid, 'plain'] },
      { executor: 'mpc.test.near', logs: [foreign] },
    ]),
  );
  const okOut = await ok.transport.submit(await ok.transport.prepare('submit_batch', {}, 1n));
  assert.deepEqual(okOut.logs.map((e) => e.event), ['paid']);
  assert.equal(okOut.failure, null);

  const other = await liveWorld(() => outcomeReply({ Failure: { ActionError: { index: 0, kind: 'LackBalanceForState' } } }));
  const otherOut = await other.transport.submit(await other.transport.prepare('submit_batch', {}, 1n));
  assert.match(otherOut.failure ?? '', /LackBalanceForState/);
});

test('a send answered with HTTP 503 throws and is attempted once; nothing is signed again by the transport', async () => {
  const { server, transport } = await liveWorld(() => http503);
  const tx = await transport.prepare('submit_batch', {}, 1n);
  await assert.rejects(transport.submit(tx));
  assert.equal(server.calls.filter((c) => c.method === 'send_tx').length, 1);
});

test('txStatus asks the node with `tx` and NONE, maps an unknown hash to null and a not-yet-final outcome to pending', async () => {
  const unknown = await liveWorld(() => outcomeReply({ SuccessValue: '' }), () =>
    rpcError({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: { requested_transaction_hash: 'x' } } }),
  );
  assert.equal(await unknown.transport.txStatus('SOMEHASH'), null);
  const call = unknown.server.calls.find((c) => c.method === 'tx');
  assert.ok(call, 'the JSON-RPC method is tx, never tx_status');
  assert.deepEqual(call.params, { tx_hash: 'SOMEHASH', sender_account_id: 'agent.test.near', wait_until: 'NONE' });

  const pending = await liveWorld(() => outcomeReply({ SuccessValue: '' }), () => rpcResult({ final_execution_status: 'NONE' }));
  assert.equal(await pending.transport.txStatus('SOMEHASH'), 'pending');

  const done = await liveWorld(() => outcomeReply({ SuccessValue: '' }), () => outcomeReply({ SuccessValue: b64([1]) }));
  const status = await done.transport.txStatus('SOMEHASH');
  assert.ok(status !== null && status !== 'pending');
  assert.deepEqual(status.returnValue, [1]);
  assert.equal(status.hash, 'NODEHASH');
});

test('after InvalidNonceError the next prepare reads the access key again instead of reusing the stale cached nonce', async () => {
  const { server, transport } = await liveWorld(() =>
    rpcError({
      name: 'HANDLER_ERROR',
      cause: { name: 'INVALID_TRANSACTION', info: {} },
      data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 6, ak_nonce: 6 } } } },
    }),
  );
  const first = await transport.prepare('submit_batch', {}, 1n);
  const second = await transport.prepare('submit_batch', {}, 1n);
  assert.notEqual(first.hash, second.hash, 'a second batch uses the next nonce');
  assert.equal(server.calls.filter((c) => c.method === 'query').length, 1);
  await assert.rejects(transport.submit(first), (error: unknown) => error instanceof InvalidNonceError);
  await transport.prepare('submit_batch', {}, 1n);
  assert.equal(server.calls.filter((c) => c.method === 'query').length, 2, 'a fresh account read the access key again');
});

// ---- signerFromCredentials ----

test('signerFromCredentials returns the signer of a near-cli-rs credentials file for the expected account', async () => {
  const file = fileOf('credentials');
  writeFileSync(file, JSON.stringify({ account_id: 'agent.test.near', public_key: 'ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu', private_key: SECRET }));
  const signer = signerFromCredentials(file, 'agent.test.near');
  assert.equal((await signer.getPublicKey()).toString(), 'ed25519:9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu');
});

test('signerFromCredentials refuses another account, a broken file and a key that is not ed25519, and never echoes the key', () => {
  const file = fileOf('credentials-bad');
  writeFileSync(file, JSON.stringify({ account_id: 'someone.test.near', public_key: 'ed25519:x', private_key: SECRET }));
  const quiet = (error: unknown): boolean => error instanceof Error && !error.message.includes(SECRET) && !error.message.includes(SECRET.slice(8));
  assert.throws(() => signerFromCredentials(file, 'agent.test.near'), (error: unknown) => quiet(error) && /another account/.test((error as Error).message));
  writeFileSync(file, `{ "account_id": "agent.test.near", "private_key": "${SECRET}"`); // cut off
  assert.throws(() => signerFromCredentials(file, 'agent.test.near'), quiet);
  writeFileSync(file, JSON.stringify({ account_id: 'agent.test.near', private_key: 'secp256k1:abc' }));
  assert.throws(() => signerFromCredentials(file, 'agent.test.near'), quiet);
  writeFileSync(file, JSON.stringify({ account_id: 'agent.test.near' }));
  assert.throws(() => signerFromCredentials(file, 'agent.test.near'), quiet);
  writeFileSync(file, JSON.stringify({ account_id: 'agent.test.near', private_key: 'ed25519:0OIl' }));
  assert.throws(() => signerFromCredentials(file, 'agent.test.near'), quiet);
  assert.throws(() => signerFromCredentials(fileOf('does-not-exist'), 'agent.test.near'));
});

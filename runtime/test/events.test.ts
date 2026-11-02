// AIR-160: decoding the contract's event lines (docs/events.md). Typed events decode; everything of ours that does not fit is an
// unknown_event carrying the line; a line that is not an event is skipped; only the policy contract's own receipts are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEventLog, decodeOutcomeEvents, executionOf } from '../src/chain/events.ts';
import { GENERIC_EVENT_NAMES, TYPED_EVENT_NAMES } from '../src/chain/types.ts';
import type { ChainEvent } from '../src/chain/types.ts';

const P = 'EVENT_JSON:{"standard":"airlock","version":"1.0.0","event":';
const H64 = 'a'.repeat(64);
const ID0 = `${H64}:0`;
const ID1 = `${H64}:1`;

// the typed lines as the contract writes them (AIR-061, 080, 100, 101, 105, 104), one literal each
const TYPED: [string, string][] = [
  ['submitted', P + `"submitted","data":[{"task_hash":"${H64}","count":2,"agent":"agent.test.near"}]}`],
  ['allowed', P + `"allowed","data":[{"request_id":"${ID0}","asset":"near","payee":"near:payee.test.near","amount":"1000","asset_day_remaining":"99000","payee_day_remaining":"4000","task_remaining":null}]}`],
  ['escalated', P + `"escalated","data":[{"request_id":"${ID0}","id":"3","reason":"UntrustedAmount"}]}`],
  ['blocked', P + `"blocked","data":[{"request_id":"${ID0}","reason":"MissingProvenance"}]}`],
  ['approved', P + `"approved","data":[{"request_id":"${ID0}","id":"3","digest":"${H64}","approver":"test.near","block_height":"1234"}]}`],
  ['rejected', P + `"rejected","data":[{"request_id":"${ID0}","id":"3"}]}`],
  ['expired', P + `"expired","data":[{"request_id":"${ID0}","id":"3"}]}`],
  ['evm_unsigned', P + `"evm_unsigned","data":[{"request_id":"${ID0}","unsigned_hex":"02f1"}]}`],
  ['signed', P + `"signed","data":[{"request_id":"${ID0}","unsigned_hex":"02f1","big_r":"02${'b'.repeat(64)}","s":"${'c'.repeat(64)}","recovery_id":1}]}`],
  ['paid', P + `"paid","data":[{"request_id":"${ID0}","payee":"near:payee.test.near","amount":"1000"}]}`],
  ['failed', P + `"failed","data":[{"request_id":"${ID1}","reason":"MpcFailed","retryable":true}]}`],
  ['nonce_set', P + '"nonce_set","data":[{"path":"base-1","nonce":"7"}]}'],
];

test('every typed event line decodes to its typed event', () => {
  assert.deepEqual(TYPED.map(([name]) => name).sort(), [...TYPED_EVENT_NAMES].sort(), 'the table covers the typed list');
  for (const [name, line] of TYPED) {
    const event = decodeEventLog(line);
    assert.ok(event, name);
    assert.equal(event.event, name);
    assert.ok('data' in event, name);
  }
  const signed = decodeEventLog(TYPED[8]?.[1] ?? '');
  assert.ok(signed && signed.event === 'signed');
  assert.equal(signed.data.recovery_id, 1);
  const failed = decodeEventLog(TYPED[10]?.[1] ?? '');
  assert.ok(failed && failed.event === 'failed');
  assert.deepEqual([failed.data.reason, failed.data.retryable], ['MpcFailed', true]);
});

test('the closed list has 26 names: 12 typed and 14 generic', () => {
  assert.equal(TYPED_EVENT_NAMES.length + GENERIC_EVENT_NAMES.length, 26);
  assert.equal(new Set([...TYPED_EVENT_NAMES, ...GENERIC_EVENT_NAMES]).size, 26);
});

test('a signed line with no recovery_id, a typed line with a wrong type and one with an extra field are unknown_event', () => {
  const noNonce = P + `"signed","data":[{"request_id":"${ID0}","unsigned_hex":"02f1","big_r":"02${'b'.repeat(64)}","s":"${'c'.repeat(64)}"}]}`;
  const e1 = decodeEventLog(noNonce);
  assert.deepEqual(e1 && e1.event, 'unknown_event');
  assert.equal(e1 && e1.event === 'unknown_event' && e1.name, 'signed');
  const wrongType = P + `"submitted","data":[{"task_hash":"${H64}","count":"2","agent":"a.test.near"}]}`;
  assert.equal(decodeEventLog(wrongType)?.event, 'unknown_event');
  const extra = P + `"rejected","data":[{"request_id":"${ID0}","id":"3","note":"x"}]}`;
  assert.equal(decodeEventLog(extra)?.event, 'unknown_event');
  const badReason = P + `"failed","data":[{"request_id":"${ID0}","reason":"Whatever","retryable":false}]}`;
  assert.equal(decodeEventLog(badReason)?.event, 'unknown_event');
});

test('another standard, another version, a two element data, an object data and malformed JSON are unknown_event', () => {
  const standard = `EVENT_JSON:{"standard":"shade-contract-template","version":"1.0.0","event":"paused","data":[{"paused":true}]}`;
  const version = `EVENT_JSON:{"standard":"airlock","version":"2.0.0","event":"paused","data":[{"paused":true}]}`;
  const two = P + '"paused","data":[{"paused":true},{"paused":false}]}';
  const object = P + '"paused","data":{"paused":true}}';
  const empty = P + '"paused","data":[]}';
  const notObject = P + '"paused","data":[5]}';
  const malformed = 'EVENT_JSON:{"standard":"airlock","version":';
  const notJsonObject = 'EVENT_JSON:[1,2]';
  for (const [label, line] of [['standard', standard], ['version', version], ['two', two], ['object', object], ['empty', empty], ['notObject', notObject], ['malformed', malformed], ['array', notJsonObject]] as const) {
    const event = decodeEventLog(line);
    assert.ok(event && event.event === 'unknown_event', label);
    assert.equal(event.raw, line, label);
  }
  const named = decodeEventLog(standard);
  assert.ok(named && named.event === 'unknown_event');
  assert.equal(named.name, 'paused');
  const bad = decodeEventLog(malformed);
  assert.ok(bad && bad.event === 'unknown_event');
  assert.equal(bad.name, '');
});

test('an event name outside the closed list is unknown_event with that name; a non-string name gives an empty name', () => {
  const unknown = decodeEventLog(P + '"weird_event","data":[{"x":1}]}');
  assert.ok(unknown && unknown.event === 'unknown_event');
  assert.equal(unknown.name, 'weird_event');
  const numeric = decodeEventLog('EVENT_JSON:{"standard":"airlock","version":"1.0.0","event":5,"data":[{"x":1}]}');
  assert.ok(numeric && numeric.event === 'unknown_event');
  assert.equal(numeric.name, '');
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const event = decodeEventLog(P + `"${name}","data":[{"x":1}]}`);
    assert.ok(event && event.event === 'unknown_event', name);
  }
});

test('the raw text of an unknown_event is the first 4,096 characters of the line', () => {
  const long = P + `"weird_event","data":[{"pad":"${'z'.repeat(6000)}"}]}`;
  const event = decodeEventLog(long);
  assert.ok(event && event.event === 'unknown_event');
  assert.equal(event.raw.length, 4096);
  assert.equal(event.raw, long.slice(0, 4096));
  const x402 = P + `"x402_signed","data":[{"request_id":"${ID0}","header":"${'h'.repeat(480)}"}]}`;
  const kept = decodeEventLog(x402);
  assert.ok(kept && kept.event === 'unknown_event');
  assert.equal(kept.raw, x402, 'a 550 character line is kept whole');
});

test('a plain log line is skipped, and a line that only mentions the prefix is not an event', () => {
  assert.equal(decodeEventLog('Refund 5 yoctoNEAR to agent.test.near'), null);
  assert.equal(decodeEventLog(''), null);
  assert.equal(decodeEventLog(' EVENT_JSON:{}'), null);
  assert.equal(decodeEventLog('event_json:{}'), null);
});

test('the template events and the other generic names decode to { event, data } without validation', () => {
  const removed = decodeEventLog(P + '"agent_removed","data":[{"account_id":"agent.test.near","reasons":["ManualRemoval"]}]}');
  assert.deepEqual(removed, { event: 'agent_removed', data: { account_id: 'agent.test.near', reasons: ['ManualRemoval'] } });
  const registered = decodeEventLog(P + '"agent_registered","data":[{"anything":"goes"}]}');
  assert.deepEqual(registered, { event: 'agent_registered', data: { anything: 'goes' } });
  for (const name of GENERIC_EVENT_NAMES) {
    const event = decodeEventLog(P + `"${name}","data":[{"k":"v"}]}`);
    assert.ok(event && event.event === name, name);
  }
});

const receipt = (executor: string, logs: string[]) => ({ outcome: { executor_id: executor, logs } });

test('decodeOutcomeEvents reads only receipts executed by the policy contract, in the outcome order, skipping plain lines', () => {
  const outcome = {
    receipts_outcome: [
      receipt('policy.test.near', [TYPED[0]?.[1] ?? '', 'plain line', TYPED[1]?.[1] ?? '']),
      receipt('mpc.test.near', [TYPED[2]?.[1] ?? '']), // the signer logs its own lines in the same transaction
      receipt('payee.test.near', [TYPED[3]?.[1] ?? '']),
      receipt('policy.test.near', [TYPED[9]?.[1] ?? '']),
    ],
  };
  const events = decodeOutcomeEvents(outcome, 'policy.test.near');
  assert.deepEqual(events.map((e) => e.event), ['submitted', 'allowed', 'paid']);
  assert.deepEqual(decodeOutcomeEvents({ receipts_outcome: [] }, 'policy.test.near'), []);
});

test('executionOf reads paid, signed and failed per request id of a batch of two', () => {
  const lines = [TYPED[0], TYPED[1], TYPED[10]].map((row) => decodeEventLog(row?.[1] ?? ''));
  const events = lines.filter((e): e is ChainEvent => e !== null);
  assert.deepEqual(executionOf(events, ID0), { kind: 'none' });
  assert.deepEqual(executionOf(events, ID1), { kind: 'failed', reason: 'MpcFailed', retryable: true });
  const paid = decodeEventLog(TYPED[9]?.[1] ?? '');
  const signed = decodeEventLog(TYPED[8]?.[1] ?? '');
  assert.ok(paid && signed);
  assert.deepEqual(executionOf([...events, paid], ID0), { kind: 'paid' });
  assert.deepEqual(executionOf([...events, signed], ID0), { kind: 'signed' });
  // a failure that is retried and then signed: the last lane event wins
  const retried = decodeEventLog(P + `"signed","data":[{"request_id":"${ID1}","unsigned_hex":"02f1","big_r":"02${'b'.repeat(64)}","s":"${'c'.repeat(64)}","recovery_id":0}]}`);
  assert.ok(retried);
  assert.deepEqual(executionOf([...events, retried], ID1), { kind: 'signed' });
});

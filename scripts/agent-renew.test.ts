// The renewal of an agent's attestation on a policy (register_agent again, signed by the agent): the plan a dry run prints, with the exact
// commands, and the read-only verification. The script has no sending path at all.
//   pnpm tsx --test scripts/agent-renew.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_UNTIL_MS, RENEW_TARGETS, mayCall, renewPlan, renewVerify } from '../runtime/src/credit/renew.ts';
import type { AgentFacts } from '../runtime/src/credit/renew.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T07:00:00.000Z');
const facts = (over: Partial<AgentFacts> = {}): AgentFacts => ({ policy: 'challenge.erfan-airlock.testnet', agent: 'erfan-agent.testnet', owner: 'erfan-airlock.testnet', validUntilMs: Date.parse('2026-11-17T21:14:00.000Z'), valid: true, lifetimeMs: 14 * DAY, canRegister: true, ...over });

test('the two agents and the date they must outlast', () => {
  assert.deepEqual(RENEW_TARGETS.map((t) => t.agent), ['erfan-agent.testnet', 'agent.airlock-credit-c1108d.testnet']);
  assert.equal(new Date(DEFAULT_UNTIL_MS).toISOString(), '2026-11-26T00:00:00.000Z');
});

test('a registration that already outlasts the date needs nothing', () => {
  const p = renewPlan(facts({ validUntilMs: DEFAULT_UNTIL_MS + DAY }), NOW, DEFAULT_UNTIL_MS);
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.commands, []);
});

test('a 14 day lifetime on Nov 10 does not reach Nov 26: the plan says when a plain renewal does, and how to do it now', () => {
  const p = renewPlan(facts(), NOW, DEFAULT_UNTIL_MS);
  assert.equal(p.status, 'raise-then-renew');
  const text = p.lines.join('\n');
  assert.match(text, /valid until 2026-11-17T21:14:00\.000Z/);
  assert.match(text, /a renewal now would end 2026-11-24T07:00:00\.000Z/);
  assert.match(text, /a plain renewal reaches the date from 2026-11-12T00:00:00\.000Z/);
  assert.equal(p.commands.length, 2);
  // 16 days to the date, plus two days of margin
  assert.equal(p.commands[0], `near contract call-function as-transaction challenge.erfan-airlock.testnet update_attestation_expiration_time json-args '{"attestation_expiration_time_ms":"${String(18 * DAY)}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as erfan-airlock.testnet network-config testnet sign-with-keychain send`);
  assert.equal(p.commands[1], `near contract call-function as-transaction challenge.erfan-airlock.testnet register_agent json-args "$(jq -c .register_agent fixtures/local-mode.json)" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as erfan-agent.testnet network-config testnet sign-with-keychain send`);
});

test('from Nov 12 a plain renewal is enough: one command, signed by the agent', () => {
  const p = renewPlan(facts(), Date.parse('2026-11-12T01:00:00.000Z'), DEFAULT_UNTIL_MS);
  assert.equal(p.status, 'renew');
  assert.equal(p.commands.length, 1);
  assert.match(p.commands[0] ?? '', / register_agent .* sign-as erfan-agent\.testnet /);
});

test('an agent with no key that may call register_agent is named: the scoped arena key cannot renew', () => {
  const card = 'card.airlock-credit-c1108d.testnet';
  assert.equal(mayCall('FullAccess', card, 'register_agent'), true);
  assert.equal(mayCall({ FunctionCall: { receiver_id: card, method_names: ['submit_batch', 'expire'], allowance: null } }, card, 'register_agent'), false);
  assert.equal(mayCall({ FunctionCall: { receiver_id: card, method_names: [], allowance: null } }, card, 'register_agent'), true);
  assert.equal(mayCall({ FunctionCall: { receiver_id: 'other.testnet', method_names: [], allowance: null } }, card, 'register_agent'), false);
  const p = renewPlan(facts({ canRegister: false }), NOW, DEFAULT_UNTIL_MS);
  assert.match(p.lines.join('\n'), /no key on erfan-agent\.testnet may call register_agent/);
});

test('verify: OK only for a valid registration that outlasts the date', () => {
  assert.deepEqual(renewVerify(facts({ validUntilMs: DEFAULT_UNTIL_MS + DAY }), DEFAULT_UNTIL_MS), { code: 0, line: 'AGENT RENEW OK erfan-agent.testnet on challenge.erfan-airlock.testnet valid until 2026-11-27T00:00:00.000Z' });
  assert.match(renewVerify(facts(), DEFAULT_UNTIL_MS).line, /^AGENT RENEW NEEDED erfan-agent\.testnet on challenge\.erfan-airlock\.testnet valid until 2026-11-17T21:14:00\.000Z, before 2026-11-26T00:00:00\.000Z$/);
  assert.equal(renewVerify(facts(), DEFAULT_UNTIL_MS).code, 1);
  assert.match(renewVerify(facts({ validUntilMs: null }), DEFAULT_UNTIL_MS).line, /is not registered/);
  assert.match(renewVerify(facts({ validUntilMs: DEFAULT_UNTIL_MS + DAY, valid: false }), DEFAULT_UNTIL_MS).line, /the policy does not count it valid/);
});

test('the script cannot send: it starts no process and signs nothing', () => {
  const src = readFileSync(join(REPO, 'scripts', 'agent-renew.ts'), 'utf8');
  assert.doesNotMatch(src, /child_process|spawn|signerFromCredentials|near-credentials/);
});

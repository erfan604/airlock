// AIR-161: the boot fingerprint line the owner compares before allow_agent (AIR-046, R3-07).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { printBootFingerprint } from '../src/server/boot.ts';

const script = fileURLToPath(new URL('../../scripts/agent-fingerprint.mjs', import.meta.url));

test('printBootFingerprint returns the AIR-046 literals and logs the pinned line exactly once', () => {
  const lines: string[] = [];
  assert.equal(printBootFingerprint('agent.test.near', (l) => lines.push(l)), '1573203cff8b');
  assert.deepEqual(lines, ['AIRLOCK agent fingerprint 1573203cff8b for agent.test.near']);
  assert.equal(printBootFingerprint('agent.example.testnet', (l) => lines.push(l)), 'c11e2c219f09');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], 'AIRLOCK agent fingerprint c11e2c219f09 for agent.example.testnet');
});

test('the value equals node scripts/agent-fingerprint.mjs', () => {
  for (const account of ['agent.test.near', 'agent.example.testnet', 'agent.examp1e.testnet']) {
    const printed = execFileSync(process.execPath, [script, account], { encoding: 'utf8' }).trim();
    assert.equal(printBootFingerprint(account, () => undefined), printed, account);
  }
});

test('console.log is the default sink', (t) => {
  const log = t.mock.method(console, 'log', () => undefined);
  assert.equal(printBootFingerprint('agent.test.near'), '1573203cff8b');
  assert.equal(log.mock.callCount(), 1);
  assert.equal(log.mock.calls[0]?.arguments[0], 'AIRLOCK agent fingerprint 1573203cff8b for agent.test.near');
});

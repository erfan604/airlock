// AIR-169: loadConfig. The environment is a parameter, so nothing here touches process.env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ConfigError, REPO_ROOT, loadConfig } from '../src/config.ts';

const BASE = { OWNER_ACCOUNT_ID: 'owner.testnet', POLICY_CONTRACT_ID: 'policy.testnet', AGENT_ACCOUNT_ID: 'agent.testnet' };
const REPLAY = { ...BASE, AIRLOCK_MODE: 'replay', LLM_MODE: 'replay' };

function credentials(accountId: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'air169-cred-')), 'agent.json');
  writeFileSync(path, JSON.stringify({ account_id: accountId, public_key: 'ed25519:x', private_key: 'ed25519:SECRETSECRETSECRET' }));
  return path;
}

const LIVE = (over: Record<string, string> = {}) => ({ ...BASE, LLM_MODE: 'live', AGENT_CREDENTIALS_PATH: credentials('agent.testnet'), ...over });

function refused(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected a ConfigError, got ${String(e)}`);
    return e;
  }
  throw new assert.AssertionError({ message: 'loadConfig accepted the environment' });
}

test('every required name present gives the defaults', () => {
  const cfg = loadConfig(LIVE());
  assert.equal(cfg.mode, 'live');
  assert.equal(cfg.network, 'testnet');
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.dataDir, join(REPO_ROOT, 'runtime/data'));
  assert.equal(cfg.worldPath, join(REPO_ROOT, 'fixtures/world.jsonl'));
  assert.equal(cfg.scenario, null);
  assert.equal(cfg.plannerModel, null);
  assert.equal(cfg.quarantineModel, null);
  assert.equal(cfg.baseSepoliaRpc, null);
});

test('an empty value is an unset one, as in a copied .env.example', () => {
  const cfg = loadConfig({ ...REPLAY, PLANNER_MODEL: '', QUARANTINE_MODEL: '', AIRLOCK_SCENARIO: '', BASE_SEPOLIA_RPC: '', AIRLOCK_PORT: '' });
  assert.equal(cfg.plannerModel, null);
  assert.equal(cfg.scenario, null);
  assert.equal(cfg.port, 8787);
});

test('a missing POLICY_CONTRACT_ID throws ConfigError naming it', () => {
  const { POLICY_CONTRACT_ID: _drop, ...rest } = REPLAY;
  const e = refused(rest);
  assert.ok(e.variables.includes('POLICY_CONTRACT_ID'));
  assert.match(e.message, /POLICY_CONTRACT_ID/);
});

test('the error text never holds a value', () => {
  const e = refused({ OWNER_ACCOUNT_ID: 'owner.testnet' });
  assert.ok(!e.message.includes('owner.testnet'));
  assert.match(e.message, /POLICY_CONTRACT_ID/);
  assert.match(e.message, /AGENT_ACCOUNT_ID/);
  const bad = refused({ ...REPLAY, AGENT_ACCOUNT_ID: 'NOT A VALID ID', AIRLOCK_PORT: '99999' });
  assert.ok(!bad.message.includes('NOT A VALID ID'));
  assert.ok(!bad.message.includes('99999'));
});

test('NEAR_NETWORK other than testnet is refused', () => {
  assert.ok(refused({ ...REPLAY, NEAR_NETWORK: 'mainnet' }).variables.includes('NEAR_NETWORK'));
  assert.equal(loadConfig({ ...REPLAY, NEAR_NETWORK: 'testnet' }).network, 'testnet');
});

test('live mode refuses LLM_MODE unset or replay', () => {
  const { LLM_MODE: _drop, ...unset } = LIVE();
  assert.deepEqual(refused(unset).variables, ['LLM_MODE']);
  assert.deepEqual(refused(LIVE({ LLM_MODE: 'replay' })).variables, ['LLM_MODE']);
  assert.equal(loadConfig(LIVE({ LLM_MODE: 'record' })).llmMode, 'record');
});

test('replay mode refuses LLM_MODE other than replay', () => {
  assert.deepEqual(refused({ ...REPLAY, LLM_MODE: 'live' }).variables, ['LLM_MODE']);
  const { LLM_MODE: _drop, ...unset } = REPLAY;
  assert.deepEqual(refused(unset).variables, ['LLM_MODE']);
});

test('live mode refuses a missing credentials path and a file of another account', () => {
  const { AGENT_CREDENTIALS_PATH: _drop, ...none } = LIVE();
  assert.deepEqual(refused(none).variables, ['AGENT_CREDENTIALS_PATH']);
  const other = refused(LIVE({ AGENT_CREDENTIALS_PATH: credentials('someone-else.testnet') }));
  assert.ok(other.variables.includes('AGENT_CREDENTIALS_PATH'));
  assert.ok(!other.message.includes('someone-else'));
  assert.ok(!other.message.includes('SECRET'));
  assert.ok(refused(LIVE({ AGENT_CREDENTIALS_PATH: join(tmpdir(), 'air169-no-such-file.json') })).variables.includes('AGENT_CREDENTIALS_PATH'));
});

test('the config never holds the private key', () => {
  const cfg = loadConfig(LIVE());
  assert.ok(!JSON.stringify(cfg).includes('SECRET'));
  assert.ok(cfg.agentCredentialsPath !== null && isAbsolute(cfg.agentCredentialsPath));
});

test('AIRLOCK_PORT 0 is accepted and out of range or odd text is refused', () => {
  assert.equal(loadConfig({ ...REPLAY, AIRLOCK_PORT: '0' }).port, 0);
  assert.equal(loadConfig({ ...REPLAY, AIRLOCK_PORT: '65535' }).port, 65535);
  for (const bad of ['70000', '-1', '8e3', '0x10', '08', ' 80', '80.5', 'abc']) {
    assert.deepEqual(refused({ ...REPLAY, AIRLOCK_PORT: bad }).variables, ['AIRLOCK_PORT'], bad);
  }
});

test('relative defaults never depend on the cwd', () => {
  const before = process.cwd();
  process.chdir(resolve(REPO_ROOT, 'runtime'));
  try {
    const cfg = loadConfig(REPLAY);
    assert.ok(isAbsolute(cfg.worldPath) && isAbsolute(cfg.dataDir) && isAbsolute(cfg.recordingsDir));
    assert.equal(cfg.worldPath, join(REPO_ROOT, 'fixtures', 'world.jsonl'));
    assert.ok(cfg.worldPath.endsWith('/fixtures/world.jsonl'));
    assert.equal(cfg.dataDir, join(REPO_ROOT, 'runtime', 'data'));
    assert.equal(cfg.recordingsDir, join(REPO_ROOT, 'runtime', 'recordings', 'chain'));
    assert.equal(loadConfig({ ...REPLAY, AIRLOCK_DATA_DIR: '/tmp/somewhere' }).dataDir, '/tmp/somewhere');
  } finally {
    process.chdir(before);
  }
});

test('AIRLOCK_SCENARIO is optional and carried', () => {
  assert.equal(loadConfig({ ...REPLAY, AIRLOCK_SCENARIO: 'B01' }).scenario, 'B01');
  assert.equal(loadConfig(REPLAY).scenario, null);
  assert.deepEqual(refused({ ...REPLAY, AIRLOCK_SCENARIO: '../x' }).variables, ['AIRLOCK_SCENARIO']);
});

test('optional overrides are carried', () => {
  const cfg = loadConfig({ ...REPLAY, PLANNER_MODEL: 'Qwen/Qwen3.8-27B', QUARANTINE_MODEL: 'z-ai/glm-5.3-flash', BASE_SEPOLIA_RPC: 'https://sepolia.base.org', AIRLOCK_HOST: '0.0.0.0' });
  assert.equal(cfg.plannerModel, 'Qwen/Qwen3.8-27B');
  assert.equal(cfg.quarantineModel, 'z-ai/glm-5.3-flash');
  assert.equal(cfg.baseSepoliaRpc, 'https://sepolia.base.org');
  assert.equal(cfg.host, '0.0.0.0');
  assert.deepEqual(refused({ ...REPLAY, BASE_SEPOLIA_RPC: 'ftp://x' }).variables, ['BASE_SEPOLIA_RPC']);
});

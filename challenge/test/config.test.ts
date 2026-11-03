import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, parseConfig } from '../src/config.ts';

const live = {
  CHALLENGE_MODE: 'live',
  CHALLENGE_POLICY_ACCOUNT: 'policy-v2.erfan-airlock.testnet',
  CHALLENGE_OWNER_ACCOUNT: 'erfan-airlock.testnet',
  CHALLENGE_AGENT_ACCOUNT: 'agent.erfan-airlock.testnet',
  CHALLENGE_AGENT_CREDENTIALS: '/secret/path/agent.json',
  CHALLENGE_TASK_KEY_FILE: '/secret/path/task-key',
  CHALLENGE_LLM_CAP_USD: '1.00',
  CHALLENGE_NEAR_DAILY_CAP: '10',
  CHALLENGE_NEAR_FLOAT_MIN: '2',
  CHALLENGE_DIRECT: '1',
  LLM_MODE: 'live',
};

test('recorded mode needs nothing and defaults are the pinned ones', () => {
  const c = parseConfig({}, '/repo');
  assert.equal(c.mode, 'recorded');
  assert.equal(c.live, null);
  assert.equal(c.port, 8788);
  assert.equal(c.host, '127.0.0.1');
  assert.deepEqual([c.limits.perIpMax, c.limits.globalMax, c.limits.dailyMax, c.limits.maxChars], [5, 60, 300, 4000]);
});

test('live mode lists every missing variable by name and refuses to start', () => {
  assert.throws(
    () => parseConfig({ CHALLENGE_MODE: 'live' }, '/repo'),
    (e: unknown) => e instanceof ConfigError && ['CHALLENGE_POLICY_ACCOUNT', 'CHALLENGE_AGENT_CREDENTIALS', 'CHALLENGE_TASK_KEY_FILE', 'CHALLENGE_LLM_CAP_USD', 'CHALLENGE_NEAR_DAILY_CAP', 'LLM_MODE'].every((n) => e.variables.includes(n)),
  );
});

test('live mode with everything set parses; the caps are converted to base units', () => {
  const c = parseConfig(live, '/repo');
  assert.equal(c.mode, 'live');
  assert.equal(c.live?.policyAccount, 'policy-v2.erfan-airlock.testnet');
  assert.equal(c.limits.nearDailyCapYocto, (10n * 10n ** 24n).toString());
  assert.equal(c.key, null);
});

test('the published key needs a well formed public key and shows the secret only when set', () => {
  const pub = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
  assert.equal(parseConfig({ ...live, CHALLENGE_KEY_PUBLIC: pub }, '/repo').key?.secretKey, null);
  assert.throws(() => parseConfig({ ...live, CHALLENGE_KEY_PUBLIC: 'not a key' }, '/repo'), ConfigError);
});

test('a bad value names the variable and never repeats the value', () => {
  assert.throws(
    () => parseConfig({ CHALLENGE_PORT: '99999999999', CHALLENGE_LLM_CAP_USD: 'lots', CHALLENGE_MODE: 'sideways' }, '/repo'),
    (e: unknown) => e instanceof ConfigError && !e.message.includes('lots') && !e.message.includes('sideways') && e.variables.length === 3,
  );
});

test('live mode needs a trusted address source: a direct listener or a named proxy, and a proxy header never stands alone', () => {
  const { CHALLENGE_DIRECT: _direct, ...noDirect } = live;
  void _direct;
  assert.throws(() => parseConfig(noDirect, '/repo'), (e: unknown) => e instanceof ConfigError && e.variables.includes('CHALLENGE_DIRECT'));
  assert.throws(() => parseConfig({ ...live, CHALLENGE_PROXY_HEADER: 'x-forwarded-for' }, '/repo'), (e: unknown) => e instanceof ConfigError && e.variables.includes('CHALLENGE_TRUSTED_PROXIES'));
  const ok = parseConfig({ ...noDirect, CHALLENGE_PROXY_HEADER: 'x-forwarded-for', CHALLENGE_TRUSTED_PROXIES: '10.0.0.5, 192.168.0.0/16' }, '/repo');
  assert.deepEqual(ok.trustedProxies, ['10.0.0.5', '192.168.0.0/16']);
  assert.throws(() => parseConfig({ ...live, CHALLENGE_PROXY_HEADER: 'x-forwarded-for', CHALLENGE_TRUSTED_PROXIES: 'proxy.example' }, '/repo'), ConfigError);
  assert.equal(parseConfig({}, '/repo').proxyHeader, null);
});

test('the IPv6 prefix defaults to 64 and accepts 48 to 64 only', () => {
  assert.equal(parseConfig({}, '/repo').v6Prefix, 64);
  assert.equal(parseConfig({ CHALLENGE_IPV6_PREFIX: '56' }, '/repo').v6Prefix, 56);
  for (const bad of ['47', '65', 'x']) assert.throws(() => parseConfig({ CHALLENGE_IPV6_PREFIX: bad }, '/repo'), ConfigError);
});

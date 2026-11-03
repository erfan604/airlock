// The configuration of the challenge service. `parseConfig` takes the environment as a parameter and is the only reader of variable names; it
// returns what the CLI needs. Every error names variables, never values. Recorded mode needs nothing. Live mode (the visitor's text door and
// the chain watcher) needs the accounts, the two key files and explicit caps, and refuses to start without any of them: the live parts are
// switched on by setting CHALLENGE_MODE=live, not by editing code.
import { join } from 'node:path';
import { toBaseUnits } from '@airlock/runtime/money';
import { DEFAULT_LIMITS } from './limits.ts';
import type { Limits } from './limits.ts';
import type { Mode } from './types.ts';

export class ConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`ConfigError: bad or missing ${variables.join(', ')}`);
    this.name = 'ConfigError';
  }
}

export interface LiveConfig {
  policyAccount: string;
  ownerAccount: string;
  agentAccount: string;
  agentCredentialsPath: string;
  taskKeyFile: string;
}

/** The key the page publishes for door (b): a function-call key of the agent account, receiver the policy, `submit_batch` only. */
export interface PublishedKey {
  account: string;
  publicKey: string;
  /** deliberately public: the point of the challenge. Absent until the owner has approved adding the key. */
  secretKey: string | null;
  receiver: string;
  methods: string[];
  /** the allowance of the key in NEAR, display text */
  allowance: string | null;
}

export interface ChallengeConfig {
  mode: Mode;
  port: number;
  host: string;
  dataDir: string;
  limits: Limits;
  /** header that carries the visitor's address behind a trusted proxy (for example cf-connecting-ip), or null to use the socket */
  proxyHeader: string | null;
  live: LiveConfig | null;
  key: PublishedKey | null;
}

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const DECIMAL = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,9})?$/;
const clean = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

// an integer from the environment: digits only, then a plain number (the money lint bans the float parsers, and this is a count or a time)
function count(env: NodeJS.ProcessEnv, name: string, fallback: number, bad: string[], min = 1, max = 1_000_000): number {
  const v = clean(env[name]);
  if (v === undefined) return fallback;
  if (!/^[0-9]{1,9}$/.test(v) || +v < min || +v > max) {
    bad.push(name);
    return fallback;
  }
  return +v;
}

function decimal(env: NodeJS.ProcessEnv, name: string, fallback: string, bad: string[]): string {
  const v = clean(env[name]);
  if (v === undefined) return fallback;
  if (!DECIMAL.test(v)) {
    bad.push(name);
    return fallback;
  }
  return v;
}

function account(env: NodeJS.ProcessEnv, name: string, bad: string[]): string {
  const v = clean(env[name]);
  if (v === undefined || v.length < 2 || v.length > 64 || !ACCOUNT.test(v)) {
    bad.push(name);
    return '';
  }
  return v;
}

export function parseConfig(env: NodeJS.ProcessEnv, repoRoot: string): ChallengeConfig {
  const bad: string[] = [];
  const modeText = clean(env['CHALLENGE_MODE']) ?? 'recorded';
  if (modeText !== 'recorded' && modeText !== 'live') bad.push('CHALLENGE_MODE');
  const mode: Mode = modeText === 'live' ? 'live' : 'recorded';

  const limits: Limits = {
    perIpMax: count(env, 'CHALLENGE_PER_IP_MAX', DEFAULT_LIMITS.perIpMax, bad),
    perIpWindowMs: count(env, 'CHALLENGE_PER_IP_WINDOW_S', DEFAULT_LIMITS.perIpWindowMs / 1000, bad) * 1000,
    globalMax: count(env, 'CHALLENGE_GLOBAL_MAX', DEFAULT_LIMITS.globalMax, bad),
    globalWindowMs: count(env, 'CHALLENGE_GLOBAL_WINDOW_S', DEFAULT_LIMITS.globalWindowMs / 1000, bad) * 1000,
    dailyMax: count(env, 'CHALLENGE_DAILY_MAX', DEFAULT_LIMITS.dailyMax, bad),
    maxChars: count(env, 'CHALLENGE_MAX_CHARS', DEFAULT_LIMITS.maxChars, bad, 1, 20_000),
    maxInFlight: count(env, 'CHALLENGE_MAX_IN_FLIGHT', DEFAULT_LIMITS.maxInFlight, bad, 1, 16),
    llmCapUsd: decimal(env, 'CHALLENGE_LLM_CAP_USD', DEFAULT_LIMITS.llmCapUsd, bad),
    llmEstimateUsd: decimal(env, 'CHALLENGE_LLM_ESTIMATE_USD', DEFAULT_LIMITS.llmEstimateUsd, bad),
    nearDailyCapYocto: toBaseUnits(decimal(env, 'CHALLENGE_NEAR_DAILY_CAP', '20', bad), 24).toString(),
    nearFloatMinYocto: toBaseUnits(decimal(env, 'CHALLENGE_NEAR_FLOAT_MIN', '1', bad), 24).toString(),
  };

  let live: LiveConfig | null = null;
  let key: PublishedKey | null = null;
  if (mode === 'live') {
    // live mode names every cap it spends against: the defaults are for recorded mode and tests
    for (const name of ['CHALLENGE_LLM_CAP_USD', 'CHALLENGE_NEAR_DAILY_CAP', 'CHALLENGE_NEAR_FLOAT_MIN']) if (clean(env[name]) === undefined) bad.push(name);
    const policyAccount = account(env, 'CHALLENGE_POLICY_ACCOUNT', bad);
    const ownerAccount = account(env, 'CHALLENGE_OWNER_ACCOUNT', bad);
    const agentAccount = account(env, 'CHALLENGE_AGENT_ACCOUNT', bad);
    const credentials = clean(env['CHALLENGE_AGENT_CREDENTIALS']);
    const taskKey = clean(env['CHALLENGE_TASK_KEY_FILE']);
    if (credentials === undefined) bad.push('CHALLENGE_AGENT_CREDENTIALS');
    if (taskKey === undefined) bad.push('CHALLENGE_TASK_KEY_FILE');
    const llm = clean(env['LLM_MODE']);
    if (llm !== 'live' && llm !== 'record') bad.push('LLM_MODE');
    live = { policyAccount, ownerAccount, agentAccount, agentCredentialsPath: credentials ?? '', taskKeyFile: taskKey ?? '' };
    const publicKey = clean(env['CHALLENGE_KEY_PUBLIC']);
    if (publicKey !== undefined) {
      if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(publicKey)) bad.push('CHALLENGE_KEY_PUBLIC');
      const secret = clean(env['CHALLENGE_KEY_SECRET']);
      if (secret !== undefined && !/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(secret)) bad.push('CHALLENGE_KEY_SECRET');
      key = { account: agentAccount, publicKey, secretKey: secret ?? null, receiver: policyAccount, methods: ['submit_batch'], allowance: clean(env['CHALLENGE_KEY_ALLOWANCE']) ?? null };
    }
  }
  const port = count(env, 'CHALLENGE_PORT', 8788, bad, 1, 65535);
  const host = clean(env['CHALLENGE_HOST']) ?? '127.0.0.1';
  if (!/^[A-Za-z0-9.:-]{1,64}$/.test(host)) bad.push('CHALLENGE_HOST');
  const proxyHeader = clean(env['CHALLENGE_PROXY_HEADER']) ?? null;
  if (proxyHeader !== null && !/^[a-z][a-z0-9-]{1,40}$/.test(proxyHeader)) bad.push('CHALLENGE_PROXY_HEADER');
  if (bad.length > 0) throw new ConfigError([...new Set(bad)]);
  return { mode, port, host, dataDir: clean(env['CHALLENGE_DATA_DIR']) ?? join(repoRoot, 'challenge', 'data'), limits, proxyHeader, live, key };
}

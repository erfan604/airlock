// The one door to the environment for the runtime server (AIR-169). `loadConfig` takes the variables as a parameter and returns a frozen
// RuntimeConfig; only src/server/start.ts hands it the real process environment. A violation throws ConfigError whose message names
// variables and never their values. Relative paths resolve against the repo root (found from this file), never against the cwd:
// `pnpm -C runtime start` runs with the cwd runtime/.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** A missing or invalid variable. `variables` are names from .env.example, never values. */
export class ConfigError extends Error {
  readonly variables: readonly string[];
  constructor(variables: readonly string[], why = 'missing or invalid') {
    super(`ConfigError: ${why}: ${variables.join(', ')}`);
    this.name = 'ConfigError';
    this.variables = [...variables];
  }
}

export interface RuntimeConfig {
  readonly mode: 'live' | 'replay';
  readonly network: 'testnet';
  readonly ownerAccountId: string;
  readonly contractId: string;
  readonly agentAccountId: string;
  /** live mode only: an absolute path; the key itself is read by signerFromCredentials and never held here */
  readonly agentCredentialsPath: string | null;
  /** AIR-326: the owner's private book file; null reads the policy account's book listing (an account that predates the private book). */
  readonly bookVaultPath: string | null;
  readonly baseSepoliaRpc: string | null;
  readonly llmMode: 'live' | 'record' | 'replay';
  readonly plannerModel: string | null;
  readonly quarantineModel: string | null;
  readonly port: number;
  readonly host: string;
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly worldPath: string;
  readonly scenario: string | null;
  readonly recordingsDir: string;
}

/** The repository root: this file is runtime/src/config.ts. */
export const REPO_ROOT: string = resolve(import.meta.dirname, '..', '..');

// an empty value (as in a copied .env.example) is an unset one
const clean = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

const ACCOUNT = z.string().min(2).max(64).regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/);
const MODEL = z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/:-]+$/);
const TEXT = z.string().min(1).max(1024).regex(/^[^\0]+$/);
// digits without a leading zero, so the text is also a JSON number; zod then checks the range
const PORT = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,4})$/)
  .transform((s) => JSON.parse(s) as number)
  .pipe(z.number().int().min(0).max(65535));
const URLTEXT = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  });
const HOST = z.string().min(1).max(253).regex(/^[A-Za-z0-9.:_-]+$/);

const Schema = z.object({
  NEAR_NETWORK: z.literal('testnet'),
  OWNER_ACCOUNT_ID: ACCOUNT,
  POLICY_CONTRACT_ID: ACCOUNT,
  AGENT_ACCOUNT_ID: ACCOUNT,
  AGENT_CREDENTIALS_PATH: TEXT.optional(),
  BASE_SEPOLIA_RPC: URLTEXT.optional(),
  LLM_MODE: z.enum(['live', 'record', 'replay']).optional(),
  PLANNER_MODEL: MODEL.optional(),
  QUARANTINE_MODEL: MODEL.optional(),
  AIRLOCK_MODE: z.enum(['live', 'replay']),
  AIRLOCK_PORT: PORT,
  AIRLOCK_HOST: HOST,
  AIRLOCK_DATA_DIR: TEXT,
  AIRLOCK_WORLD: TEXT,
  AIRLOCK_BOOK_VAULT: TEXT.optional(),
  AIRLOCK_SCENARIO: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
});

const NAMES = Object.keys(Schema.shape) as (keyof typeof Schema.shape)[];

const absolute = (p: string): string => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

// the credentials file of the agent: only its account id is compared here; the private key is read later, by the signer, and never held
function credentialsAccount(path: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const id = (raw as Record<string, unknown>).account_id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const input: Record<string, string | undefined> = {};
  for (const name of NAMES) input[name] = clean(env[name]);
  // the defaults are applied here so that an empty value takes them too
  input.NEAR_NETWORK ??= 'testnet';
  input.AIRLOCK_MODE ??= 'live';
  input.AIRLOCK_PORT ??= '8787';
  input.AIRLOCK_HOST ??= '127.0.0.1';
  input.AIRLOCK_DATA_DIR ??= 'runtime/data';
  input.AIRLOCK_WORLD ??= 'fixtures/world.jsonl';

  const parsed = Schema.safeParse(input);
  if (!parsed.success) {
    const names = new Set<string>();
    for (const issue of parsed.error.issues) names.add(String(issue.path[0] ?? 'environment'));
    // NAMES order, so the message does not depend on the order zod reports in
    throw new ConfigError(NAMES.filter((n) => names.has(n)));
  }
  const v = parsed.data;

  if (v.AIRLOCK_MODE === 'live') {
    // AIR-140's client defaults to replay: a live server must say live or record, or it would answer from recordings without saying so
    if (v.LLM_MODE !== 'live' && v.LLM_MODE !== 'record') throw new ConfigError(['LLM_MODE'], 'a live server needs LLM_MODE live or record');
    if (v.AGENT_CREDENTIALS_PATH === undefined) throw new ConfigError(['AGENT_CREDENTIALS_PATH'], 'a live server needs the agent credentials');
    if (credentialsAccount(absolute(v.AGENT_CREDENTIALS_PATH)) !== v.AGENT_ACCOUNT_ID) {
      throw new ConfigError(['AGENT_CREDENTIALS_PATH', 'AGENT_ACCOUNT_ID'], 'the credentials file is unreadable or for another account');
    }
  } else if (v.LLM_MODE !== 'replay') {
    throw new ConfigError(['LLM_MODE'], 'a replay server needs LLM_MODE replay');
  }

  return Object.freeze({
    mode: v.AIRLOCK_MODE,
    network: v.NEAR_NETWORK,
    ownerAccountId: v.OWNER_ACCOUNT_ID,
    contractId: v.POLICY_CONTRACT_ID,
    agentAccountId: v.AGENT_ACCOUNT_ID,
    bookVaultPath: v.AIRLOCK_BOOK_VAULT === undefined ? null : absolute(v.AIRLOCK_BOOK_VAULT),
    agentCredentialsPath: v.AIRLOCK_MODE === 'live' && v.AGENT_CREDENTIALS_PATH !== undefined ? absolute(v.AGENT_CREDENTIALS_PATH) : null,
    baseSepoliaRpc: v.BASE_SEPOLIA_RPC ?? null,
    llmMode: v.LLM_MODE ?? 'replay',
    plannerModel: v.PLANNER_MODEL ?? null,
    quarantineModel: v.QUARANTINE_MODEL ?? null,
    port: v.AIRLOCK_PORT,
    host: v.AIRLOCK_HOST,
    repoRoot: REPO_ROOT,
    dataDir: absolute(v.AIRLOCK_DATA_DIR),
    worldPath: absolute(v.AIRLOCK_WORLD),
    scenario: v.AIRLOCK_SCENARIO ?? null,
    recordingsDir: join(REPO_ROOT, 'runtime', 'recordings', 'chain'),
  });
}

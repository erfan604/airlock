// The owner's config of airlock-mcp (AIR-313): one JSON file the owner writes (`pnpm airlock init` writes the first one), read once at
// server start from AIRLOCK_MCP_CONFIG (default ~/.airlock/mcp.json). It holds the owner's request and the task bounds, so no tool call can
// set them, and it names files and accounts, never a key: the agent key stays in its credentials file and the task key in its seed file.
// Testnet only: a mainnet account id or RPC is refused, and `network: "sandbox"` is for the local near-sandbox of the tests.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { InboxItem } from '../tools/world.ts';

const Decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'a plain decimal like 4.2');

export const McpConfigSchema = z.strictObject({
  network: z.enum(['testnet', 'sandbox']),
  owner_id: z.string().min(2).max(64),
  contract_id: z.string().min(2).max(64),
  agent_id: z.string().min(2).max(64),
  /** a near-cli credentials file of the agent account (`{ account_id, public_key, private_key }`) */
  agent_credentials: z.string().min(1),
  /** the owner's task key seed file (64 hex characters), as written by `node scripts/task-key.mjs init` */
  task_key_file: z.string().min(1),
  rpc: z.array(z.url()).min(1).max(8).optional(),
  request: z.string().min(1).max(4000),
  bounds: z.array(z.strictObject({ payee: z.string().min(1).max(100), max_total: Decimal })).min(1).max(16),
  max_actions: z.int().min(1).max(255).default(8),
  task_ttl_minutes: z.int().min(1).max(1440).default(60),
  /** a JSON array of emails `{ id, from, subject, body }` */
  inbox: z.string().min(1).optional(),
  pages: z.record(z.string(), z.string()).optional(),
  /** the only hosts fetch_page may fetch live (DNS names, https, public addresses only); empty: no live fetch */
  fetch_hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/i).max(253)).max(32).default([]),
  files_dir: z.string().min(1).optional(),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

const InboxSchema = z.array(
  z.strictObject({ id: z.string(), from: z.string(), subject: z.string(), body: z.string(), attachments: z.array(z.string()).default([]) }),
);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const defaultConfigPath = (): string => join(homedir(), '.airlock', 'mcp.json');

/** `~/x` and paths relative to the config file's directory, made absolute. */
export function resolvePath(p: string, base: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(base, p);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const MAINNET_HOST = /\.near$|mainnet/i;
const TESTNET_ONLY = 'testnet only';

export function parseConfig(raw: unknown, base: string): McpConfig {
  const parsed = McpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((i) => i.path.map(String).join('.') || '(root)'))];
    throw new ConfigError(`the config does not match its schema at: ${paths.join(', ')}`);
  }
  const c = parsed.data;
  // accounts: .testnet on testnet; the local sandbox's own root (.test.near) is allowed only with a loopback RPC (below)
  const suffixes = c.network === 'testnet' ? ['.testnet'] : ['.testnet', '.test.near'];
  for (const id of [c.owner_id, c.contract_id, c.agent_id]) {
    if (!suffixes.some((x) => id.endsWith(x))) throw new ConfigError(`${TESTNET_ONLY}: every account id must end in ${suffixes.join(' or ')}`);
  }
  if (c.network === 'sandbox') {
    if (c.rpc === undefined || !c.rpc.every((u) => LOOPBACK.has(new URL(u).hostname.toLowerCase()))) {
      throw new ConfigError(`${TESTNET_ONLY}: network sandbox needs a loopback RPC (127.0.0.1, ::1 or localhost) for every rpc entry`);
    }
  }
  for (const url of c.rpc ?? []) if (MAINNET_HOST.test(new URL(url).hostname)) throw new ConfigError(`${TESTNET_ONLY}: a mainnet RPC is refused`);
  return {
    ...c,
    agent_credentials: resolvePath(c.agent_credentials, base),
    task_key_file: resolvePath(c.task_key_file, base),
    ...(c.inbox === undefined ? {} : { inbox: resolvePath(c.inbox, base) }),
    ...(c.files_dir === undefined ? {} : { files_dir: resolvePath(c.files_dir, base) }),
  };
}

export function loadConfig(path: string): McpConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(`cannot read the config as JSON: ${path}`);
  }
  return parseConfig(raw, dirname(path));
}

export function loadInbox(path: string | undefined): InboxItem[] {
  if (path === undefined) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(`cannot read the inbox as JSON: ${path}`);
  }
  const parsed = InboxSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError('the inbox is not a JSON array of { id, from, subject, body }');
  return parsed.data;
}

// AIR-319: the command line and environment of airlock-near-mcp. Settings come from a config file (--config or AIRLOCK_MCP_CONFIG, the
// file `pnpm airlock init` writes) or from flags and environment variables that name the same fields. A key is never a value: the key
// flags take a file path, and a value that looks like a key is refused before anything reads it.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, defaultConfigPath, loadConfig, parseConfig } from '../../../runtime/src/mcp/config.ts';
import type { McpConfig } from '../../../runtime/src/mcp/config.ts';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Parsed = {
  help: boolean;
  version: boolean;
  check: boolean;
  printConfig: 'claude' | 'claude-code' | null;
  values: Map<string, string[]>;
};

const VALUE_FLAGS = ['config', 'policy', 'agent', 'owner', 'agent-key-file', 'task-key-file', 'request', 'bound', 'inbox', 'files-dir', 'fetch-host'] as const;
const REPEATABLE = new Set(['bound', 'fetch-host']);
const KEY_FILE_FLAGS = new Set(['agent-key-file', 'task-key-file']);

export function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = { help: false, version: false, check: false, printConfig: null, values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--check') out.check = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      const value = inline ?? argv[++i];
      if (name === 'print-config') {
        if (value !== 'claude' && value !== 'claude-code') throw new UsageError('--print-config takes claude or claude-code');
        out.printConfig = value;
      } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
        if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
        if (KEY_FILE_FLAGS.has(name) && /^(ed25519|secp256k1):|^[0-9a-f]{64}$/i.test(value)) {
          throw new UsageError(`--${name} takes the path of a file, never a key`);
        }
        if (out.values.has(name) && !REPEATABLE.has(name)) throw new UsageError(`--${name} was given twice`);
        out.values.set(name, [...(out.values.get(name) ?? []), value]);
      } else throw new UsageError(`unknown option ${arg}`);
    } else throw new UsageError(`unexpected argument ${arg}`);
  }
  return out;
}

export const HELP = `airlock-near-mcp: the AIRLOCK MCP server (stdio), NEAR testnet only.

Usage
  npx -y airlock-near-mcp --check             verify the install: the verdict WebAssembly decides the five Try-page cases, no keys, no network
  npx -y airlock-near-mcp --print-config claude       print the Claude Desktop JSON entry (claude-code prints the claude mcp add command)
  npx -y airlock-near-mcp                     serve the six tools on stdin and stdout (an MCP client starts this)
  npx -y airlock-near-mcp --help | --version

Settings: a config file, or the flags below (each flag has an environment variable)
  --config <file>           AIRLOCK_MCP_CONFIG      the owner's config; default ~/.airlock/mcp.json (pnpm airlock init writes it)
  --policy <id>.testnet     AIRLOCK_POLICY          your deployed AIRLOCK policy account
  --agent <id>.testnet      AIRLOCK_AGENT           the agent's account
  --owner <id>.testnet      AIRLOCK_OWNER           the owner's account
  --agent-key-file <path>   AIRLOCK_AGENT_KEY_FILE  JSON { account_id, public_key, private_key } of the agent
  --task-key-file <path>    AIRLOCK_TASK_KEY_FILE   the owner's task key seed file; default ~/.airlock-task-key
  --request <text>          AIRLOCK_REQUEST         what the owner asked for in this session
  --bound <payee>=<NEAR>    AIRLOCK_BOUND           the most a payee may get in total; repeat the flag, or separate with commas
  --inbox <file>            AIRLOCK_INBOX           a JSON array of emails { id, from, subject, body }
  --files-dir <dir>         AIRLOCK_FILES_DIR       the directory read_file may read
  --fetch-host <host>       AIRLOCK_FETCH_HOSTS     a host fetch_page may fetch live (repeat, or commas); none by default

Keys are read from the files you name and never from the command line or the printed output. The network is testnet: an account that
does not end in .testnet or a mainnet RPC is refused. Docs: https://github.com/erfan604/airlock/blob/main/docs/QUICKSTART.md
`;

const list = (env: string | undefined): string[] => (env === undefined || env === '' ? [] : env.split(',').map((s) => s.trim()).filter((s) => s !== ''));

/** The setting of a flag, else of its environment variable. */
function setting(p: Parsed, env: NodeJS.ProcessEnv, flag: string, name: string): string | undefined {
  return p.values.get(flag)?.[0] ?? (env[name] === '' ? undefined : env[name]);
}

export function configPath(p: Parsed, env: NodeJS.ProcessEnv): string {
  return setting(p, env, 'config', 'AIRLOCK_MCP_CONFIG') ?? defaultConfigPath();
}

/** The owner's config: a file when one is named or sits at the default path, else built from flags and environment. */
export function resolveConfig(p: Parsed, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): McpConfig {
  const named = setting(p, env, 'config', 'AIRLOCK_MCP_CONFIG');
  const policy = setting(p, env, 'policy', 'AIRLOCK_POLICY');
  const agent = setting(p, env, 'agent', 'AIRLOCK_AGENT');
  if (named !== undefined || (policy === undefined && agent === undefined)) {
    const path = configPath(p, env);
    if (named === undefined && !exists(path)) {
      throw new UsageError(`no config at ${path}. Run pnpm airlock init (docs/QUICKSTART.md), or pass --config, or --policy and --agent with the other settings (--help)`);
    }
    return loadConfig(path);
  }
  const owner = setting(p, env, 'owner', 'AIRLOCK_OWNER');
  const agentKey = setting(p, env, 'agent-key-file', 'AIRLOCK_AGENT_KEY_FILE');
  const request = setting(p, env, 'request', 'AIRLOCK_REQUEST');
  const bounds = [...(p.values.get('bound') ?? []), ...list(env.AIRLOCK_BOUND)].map((b) => {
    const i = b.lastIndexOf('=');
    if (i < 1) throw new UsageError(`a bound is <payee>=<NEAR>, not ${b}`);
    return { payee: b.slice(0, i), max_total: b.slice(i + 1) };
  });
  const missing = [
    ['--policy', policy],
    ['--agent', agent],
    ['--owner', owner],
    ['--agent-key-file', agentKey],
    ['--request', request],
    ['--bound', bounds.length === 0 ? undefined : 'x'],
  ].filter(([, v]) => v === undefined).map(([n]) => n);
  if (missing.length > 0) throw new UsageError(`missing ${missing.join(', ')} (each also has an environment variable, see --help)`);
  const inbox = setting(p, env, 'inbox', 'AIRLOCK_INBOX');
  const filesDir = setting(p, env, 'files-dir', 'AIRLOCK_FILES_DIR');
  const hosts = [...(p.values.get('fetch-host') ?? []), ...list(env.AIRLOCK_FETCH_HOSTS)];
  const raw = {
    network: 'testnet',
    owner_id: owner,
    contract_id: policy,
    agent_id: agent,
    agent_credentials: agentKey,
    task_key_file: setting(p, env, 'task-key-file', 'AIRLOCK_TASK_KEY_FILE') ?? join(homedir(), '.airlock-task-key'),
    request,
    bounds,
    ...(inbox === undefined ? {} : { inbox }),
    ...(filesDir === undefined ? {} : { files_dir: filesDir }),
    fetch_hosts: hosts,
  };
  return parseConfig(raw, process.cwd());
}

/** The Claude Desktop entry, or the Claude Code command, that starts this package through npx. */
export function printConfig(kind: 'claude' | 'claude-code', p: Parsed, env: NodeJS.ProcessEnv): string {
  const path = configPath(p, env);
  if (kind === 'claude-code') return `claude mcp add airlock --env AIRLOCK_MCP_CONFIG=${path} -- npx -y airlock-near-mcp`;
  return JSON.stringify({ mcpServers: { airlock: { command: 'npx', args: ['-y', 'airlock-near-mcp'], env: { AIRLOCK_MCP_CONFIG: path } } } }, null, 2);
}

export { ConfigError };

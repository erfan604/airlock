// airlock-mcp (AIR-313): the stdio entry an MCP client starts. It reads the owner's config (AIRLOCK_MCP_CONFIG, default ~/.airlock/mcp.json),
// builds the agent's chain client from the agent's credentials file and the task signer from the owner's task key seed file, and serves
// the six tools of server.ts on stdin and stdout. stdout carries the protocol only: every log line goes to stderr, and no key is printed.
// adapted from modelcontextprotocol/typescript-sdk@1.32.1 docs/server.md (MIT): `server.connect(new StdioServerTransport())`.
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChainClient } from '../chain/near.ts';
import { DEFAULT_RPC_URLS } from '../chain/rpc.ts';
import { signerFromCredentials } from '../chain/signer.ts';
import { ownerTaskBorsh } from '../dsl/index.ts';
import type { OwnerTask } from '../dsl/index.ts';
import { defaultConfigPath, loadConfig, loadInbox } from './config.ts';
import type { McpConfig } from './config.ts';
import { makeFetchLive } from './fetch.ts';
import { createMcpServer } from './server.ts';
import { Session } from './session.ts';

// the fixed PKCS8 prefix of an Ed25519 private key; the 32 byte seed follows
// adapted from scripts/task-key.mjs (this repo, same author): the seed file format and the PKCS8 prefix
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The owner task key as a signer of tasks; the seed stays in this closure and is never printed. */
export function taskSigner(seedFile: string): (task: OwnerTask) => Uint8Array {
  let text: string;
  try {
    text = readFileSync(seedFile, 'utf8').trim();
  } catch {
    throw new Error('the task key file cannot be read; run: node scripts/task-key.mjs init');
  }
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error('the task key file does not hold 64 lowercase hex characters');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(text, 'hex')]), format: 'der', type: 'pkcs8' });
  return (task) => new Uint8Array(sign(null, Buffer.from(ownerTaskBorsh(task)), key));
}

export function sessionFromConfig(cfg: McpConfig): Session {
  const chain = new ChainClient({
    network: 'testnet',
    contractId: cfg.contract_id,
    agentAccountId: cfg.agent_id,
    signer: signerFromCredentials(cfg.agent_credentials, cfg.agent_id),
    rpcUrls: cfg.rpc ?? [...DEFAULT_RPC_URLS],
  });
  return new Session({
    config: {
      ownerId: cfg.owner_id,
      contractId: cfg.contract_id,
      agentId: cfg.agent_id,
      request: cfg.request,
      bounds: cfg.bounds,
      maxActions: cfg.max_actions,
      ttlMs: cfg.task_ttl_minutes * 60_000,
      explorer: cfg.network === 'testnet' ? 'https://testnet.nearblocks.io/txns/' : null,
    },
    chain,
    sources: {
      inbox: loadInbox(cfg.inbox),
      pages: cfg.pages ?? {},
      ...(cfg.fetch_hosts.length > 0 ? { fetchLive: makeFetchLive(cfg.fetch_hosts) } : {}),
      filesDir: cfg.files_dir ?? null,
    },
    signTask: taskSigner(cfg.task_key_file),
    clock: Date.now,
    randomHex: (n) => randomBytes(n).toString('hex'),
  });
}

async function main(): Promise<void> {
  const path = process.env.AIRLOCK_MCP_CONFIG ?? defaultConfigPath();
  const cfg = loadConfig(path);
  const server = createMcpServer(sessionFromConfig(cfg));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`airlock-mcp ready: policy ${cfg.contract_id}, agent ${cfg.agent_id}, ${cfg.network}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(`airlock-mcp failed to start: ${e instanceof Error ? e.message : 'unknown error'}\n`);
    process.exit(1);
  });
}

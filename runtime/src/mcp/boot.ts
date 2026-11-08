// AIR-319: the session of airlock-mcp built from an owner config, split out of main.ts so the npm package (packages/airlock-near-mcp) can import it
// without main.ts's run-when-executed guard. The task signer and the chain client are exactly those of AIR-313; no key is printed.
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ChainClient } from '../chain/near.ts';
import { DEFAULT_RPC_URLS } from '../chain/rpc.ts';
import { signerFromCredentials } from '../chain/signer.ts';
import { ownerTaskBorsh } from '../dsl/index.ts';
import type { OwnerTask } from '../dsl/index.ts';
import { loadInbox } from './config.ts';
import type { McpConfig } from './config.ts';
import { makeFetchLive } from './fetch.ts';
import { loadVault } from '../vault/file.ts';
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
    // AIR-326: the owner's private book, when the config names one
    ...(cfg.book_vault === undefined ? {} : { vault: loadVault(cfg.book_vault) }),
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
      rpcHost: new URL((cfg.rpc ?? [...DEFAULT_RPC_URLS])[0] as string).host,
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

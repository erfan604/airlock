// The one place the live engine is wired to the outside world: the agent's credentials file, the task key file, the NEAR RPC pool and the model
// client, all named by `parseConfig` and none of them read here as a value that could be printed. A missing file or a wrong account stops the
// start with a fixed text. Nothing in this file runs in recorded mode.
import { readFileSync } from 'node:fs';
import { planTask } from '@airlock/runtime/agent';
import { ChainClient } from '../../../runtime/src/chain/near.ts';
import { DEFAULT_RPC_URLS, RpcPool } from '../../../runtime/src/chain/rpc.ts';
import { signerFromCredentials } from '../../../runtime/src/chain/signer.ts';
import { LiveTransport } from '../../../runtime/src/chain/transport.ts';
import { limitsFromPolicy } from '@airlock/runtime/analyze';
import { ownerTaskBorsh } from '@airlock/runtime/dsl';
import { assertModelAllowed, loadModelsConfig } from '@airlock/runtime/llm';
import { makeExtractor } from '@airlock/runtime/quarantine';
import { randomBytes } from 'node:crypto';
import { nearViewAccount } from '../../../scripts/lib/preflight.ts';
// @ts-expect-error task-key.mjs is plain JavaScript without declarations
import { signMessage } from '../../../scripts/task-key.mjs';
import type { LiveConfig } from '../config.ts';
import { DEFAULT_PUBLIC_TASK, PublicTask } from '../publictask.ts';
import { LiveEngine } from './live.ts';

export interface LiveParts {
  engine: LiveEngine;
  /** the policy account's free balance in yocto (view_account amount) */
  floatProbe(): Promise<bigint>;
  /** the payee keys of the policy's address book now */
  bookKeys(): Promise<ReadonlySet<string>>;
  /** the owner-signed task door (b) publishes, rotated before it expires; null when the book has no accountant payee */
  publicTask: PublicTask | null;
}

export async function liveParts(cfg: LiveConfig): Promise<LiveParts> {
  const models = loadModelsConfig();
  assertModelAllowed('planner', models.planner);
  assertModelAllowed('quarantine', models.quarantine);
  const signer = signerFromCredentials(cfg.agentCredentialsPath, cfg.agentAccount);
  const pool = new RpcPool(DEFAULT_RPC_URLS);
  const chain = new ChainClient({
    network: 'testnet',
    contractId: cfg.policyAccount,
    agentAccountId: cfg.agentAccount,
    signer,
    transport: new LiveTransport({ contractId: cfg.policyAccount, agentAccountId: cfg.agentAccount, signer, pool }),
  });
  let seed: string;
  try {
    seed = readFileSync(cfg.taskKeyFile, 'utf8').trim();
  } catch {
    throw new Error('the task key file cannot be read');
  }
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('the task key file does not hold a 64 character hex seed');
  const limits = limitsFromPolicy(await chain.getPolicy());
  const engine = new LiveEngine({
    ownerAccountId: cfg.ownerAccount,
    agentAccountId: cfg.agentAccount,
    contractId: cfg.policyAccount,
    plannerModel: models.planner,
    planTask,
    extract: makeExtractor({ model: models.quarantine }),
    chain,
    signTask: (task) => Promise.resolve(new Uint8Array(signMessage(seed, ownerTaskBorsh(task)) as Buffer)),
    clock: Date.now,
    newTaskId: () => `ch-${randomBytes(8).toString('hex')}`,
    limits,
  });
  const book = await chain.getBook();
  const payee = book.map(([key]) => key).find((key) => /^near:accountant\./.test(key));
  const publicTask =
    payee === undefined
      ? null
      : new PublicTask(
          { ownerAccount: cfg.ownerAccount, agentAccount: cfg.agentAccount, policyAccount: cfg.policyAccount, payee, ...DEFAULT_PUBLIC_TASK },
          (task) => Promise.resolve((signMessage(seed, ownerTaskBorsh(task)) as Buffer).toString('base64')),
          Date.now,
        );
  return {
    engine,
    publicTask,
    floatProbe: async () => (await nearViewAccount(cfg.policyAccount)).amount,
    bookKeys: async () => new Set((await chain.getBook()).map(([key]) => key)),
  };
}

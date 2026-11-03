// The composition root (AIR-169): `startRuntime` builds every dependency of the task routes (AIR-163) and the orchestrator (AIR-164) from the
// configuration and the contract's views, then listens. Every part has a default built from the configuration; tests override them through
// `parts`. This file never reads the process environment: the variables arrive as the first parameter (src/server/start.ts passes them).
// Replay mode builds no signer and a replay transport, so nothing in it can sign.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { feePolicyFromRegistry, planTask as realPlanTask, runReadOnly, runTask } from '../agent.ts';
import type { AgentDeps } from '../agent.ts';
import { registryFromRows } from '../analyze/index.ts';
import { BASE_SEPOLIA_RPCS, deriveSender } from '../chain/evm.ts';
import type { broadcast } from '../chain/evm.ts';
import { ChainClient } from '../chain/near.ts';
import { DEFAULT_RPC_URLS, RpcPool } from '../chain/rpc.ts';
import { signerFromCredentials } from '../chain/signer.ts';
import { LiveTransport, ReplayTransport } from '../chain/transport.ts';
import { loadConfig } from '../config.ts';
import { resolveAlias } from '../dsl/index.ts';
import { MemoryEvidenceStore } from '../evidence.ts';
import { defaultToolArgPolicy, grounder } from '../interpreter/index.ts';
import type { Grounder, ToolArgPolicy } from '../interpreter/index.ts';
import type { Extractor } from '../interpreter/index.ts';
import { assertModelAllowed, loadModelsConfig } from '../llm/index.ts';
import { makeExtractor } from '../quarantine/extract.ts';
import { loadWorld } from '../tools/index.ts';
import type { World } from '../tools/index.ts';
import { rpcAccessKeyReader } from './access-keys.ts';
import type { AccessKeyReader } from './access-keys.ts';
import { createApp } from './app.ts';
import { printBootFingerprint } from './boot.ts';
import { createCounterparty, httpProbe } from '../counterparty.ts';
import { buildAgentDeps } from './deps.ts';
import type { Snapshot } from './deps.ts';
import { RunStore } from './runs.ts';
import { registerTaskRoutes } from './tasks.ts';
import type { planTask } from '../agent.ts';

/** What the server needs from the chain client; the real ChainClient has all of it. */
export type RuntimeChain = Pick<ChainClient, 'getBook' | 'listAssets' | 'getRequest' | 'submitBatch' | 'waitSigned'>;

export interface RuntimeParts {
  chain: RuntimeChain;
  extract: Extractor;
  planTask: typeof planTask;
  world: World;
  accessKeys: AccessKeyReader;
  broadcast?: typeof broadcast;
  hooks?: { ground?: Grounder; toolArgPolicy?: ToolArgPolicy };
  clock?: () => number;
  log?: (line: string) => void;
}

export interface RunningRuntime {
  url: string;
  close(): Promise<void>;
  /** the dependencies the task routes run with; tests read the book, the senders and the tools through it */
  agentDeps: AgentDeps;
}

const REPLAY_RECORDING = 'u01.json';

function listen(server: () => ServerType): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const s: ServerType = server();
    s.once('error', reject);
    s.once('listening', () => {
      s.off('error', reject);
      const address = s.address();
      resolve({ server: s, port: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  });
}

export async function startRuntime(env: NodeJS.ProcessEnv = {}, parts: Partial<RuntimeParts> = {}): Promise<RunningRuntime> {
  // 1. configuration
  const cfg = loadConfig(env);
  const log = parts.log ?? ((line: string) => console.log(line));
  const clock = parts.clock ?? Date.now;

  // the models: a mistyped override or an id outside the TEE list stops the start, not the first task
  const models = loadModelsConfig();
  const plannerModel = cfg.plannerModel ?? models.planner;
  const quarantineModel = cfg.quarantineModel ?? models.quarantine;
  assertModelAllowed('planner', plannerModel);
  assertModelAllowed('quarantine', quarantineModel);

  // 2. the chain: live signs as the agent over one RPC pool, replay answers recorded views and cannot sign
  const pool = cfg.mode === 'live' ? new RpcPool(DEFAULT_RPC_URLS) : null;
  let chain: RuntimeChain;
  if (parts.chain !== undefined) {
    chain = parts.chain;
  } else if (pool !== null && cfg.agentCredentialsPath !== null) {
    const signer = signerFromCredentials(cfg.agentCredentialsPath, cfg.agentAccountId);
    chain = new ChainClient({
      network: 'testnet',
      contractId: cfg.contractId,
      agentAccountId: cfg.agentAccountId,
      signer,
      transport: new LiveTransport({ contractId: cfg.contractId, agentAccountId: cfg.agentAccountId, signer, pool }),
    });
  } else {
    chain = new ChainClient({
      network: 'testnet',
      contractId: cfg.contractId,
      agentAccountId: cfg.agentAccountId,
      transport: new ReplayTransport(join(cfg.recordingsDir, REPLAY_RECORDING)),
    });
  }
  const accessKeys: AccessKeyReader = parts.accessKeys ?? (pool !== null ? rpcAccessKeyReader(pool) : async () => null);

  // 3. the world and the extractor (built before listening: a bad scenario id or model fails here)
  const world = parts.world ?? loadWorld(cfg.worldPath, cfg.scenario === null ? {} : { scenario: cfg.scenario });
  const extract = parts.extract ?? makeExtractor({ model: quarantineModel });

  // 4. the snapshot of the contract's book and asset registry: read now, and again before every run
  const senders = new Map<string, string>();
  async function readSnapshot(): Promise<Snapshot> {
    const rows = await chain.getBook();
    const assets = await chain.listAssets();
    const registry = registryFromRows(assets);
    const evm = new Map<string, string>();
    for (const [assetId, entry] of registry) {
      if (entry.path === null) continue;
      const key = `${assetId}\n${entry.path}`;
      let sender = senders.get(key);
      if (sender === undefined) {
        sender = await deriveSender(cfg.contractId, entry.path);
        senders.set(key, sender);
      }
      evm.set(assetId, sender);
    }
    return {
      book: { resolve: (alias) => resolveAlias(rows, alias) },
      decimalsOf: (asset) => registry.get(asset)?.decimals,
      fees: feePolicyFromRegistry(registry),
      evmSender: (assetId) => evm.get(assetId) ?? null,
    };
  }
  let current = await readSnapshot();
  const refreshSnapshot = async (): Promise<void> => {
    current = await readSnapshot();
  };

  // 5. the orchestrator's dependencies
  const evidence = new MemoryEvidenceStore();
  const agentDeps = buildAgentDeps(
    {
      world,
      extract,
      chain,
      // the product hooks: the real grounder and the default tool-argument policy; a test's `parts.hooks` replaces both
      hooks: parts.hooks ?? { ground: grounder, toolArgPolicy: defaultToolArgPolicy },
      evidence,
      clock,
      ...(parts.broadcast === undefined ? {} : { broadcast: parts.broadcast }),
      // AIR-304: live mode only (replay makes no network call); reads, no key; the note only reaches the card
      ...(cfg.mode === 'live' ? { counterparty: createCounterparty({ probe: httpProbe({ nearUrls: DEFAULT_RPC_URLS, evmUrls: { 84532: BASE_SEPOLIA_RPCS } }) }) } : {}),
      rpcUrls: [...(cfg.baseSepoliaRpc === null ? [] : [cfg.baseSepoliaRpc]), ...BASE_SEPOLIA_RPCS.filter((u) => u !== cfg.baseSepoliaRpc)],
    },
    () => current,
  );

  // 6. the run store, the app and the task routes
  const store = new RunStore({ dataDir: cfg.dataDir });
  const app = createApp({
    chain,
    clock,
    accessKeys,
    evidence,
    ownerAccountId: cfg.ownerAccountId,
    contractId: cfg.contractId,
    mode: cfg.mode,
    runEvents: store,
  });
  // a run never uses a stale book or decimals: the snapshot is read again before the orchestrator starts
  const refreshingRunTask: typeof runTask = async function* (p) {
    await refreshSnapshot();
    yield* runTask(p);
  };
  registerTaskRoutes(app, {
    agentAccountId: cfg.agentAccountId,
    contractId: cfg.contractId,
    clock,
    model: plannerModel,
    planTask: parts.planTask ?? realPlanTask,
    runTask: refreshingRunTask,
    runReadOnly: async function* (p) {
      await refreshSnapshot();
      return yield* runReadOnly(p);
    },
    agentDeps,
    store,
    newId: () => randomBytes(16).toString('hex'),
  });

  // 7. the fingerprint the owner compares, then the socket
  printBootFingerprint(cfg.agentAccountId, log);
  const { server, port } = await listen(() => serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }));
  return {
    url: `http://${cfg.host}:${port}`,
    agentDeps,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        // keep-alive connections would hold the close open
        if ('closeAllConnections' in server) server.closeAllConnections();
      }),
  };
}

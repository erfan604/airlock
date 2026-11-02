// The one place the orchestrator's dependencies (AgentDeps, AIR-164) are assembled from a world, an extractor, a chain and a snapshot of the
// contract's book and asset registry. The server (main.ts) and, once it switches, the bench (AIR-220) call it, so both measure one wiring.
// Every field that depends on the book or the registry reads `snapshot()` at call time, so a refreshed snapshot is seen by the next call
// without rebuilding anything and AgentDeps stays a plain object.
import { fixtureTools } from '../tools/index.ts';
import type { World } from '../tools/index.ts';
import { run } from '../interpreter/index.ts';
import type { Book, Extractor, Grounder, ToolArgPolicy } from '../interpreter/index.ts';
import type { AgentDeps, FeePolicy } from '../agent.ts';
import type { broadcast } from '../chain/evm.ts';
import type { EvidenceStore } from '../evidence.ts';

export interface AgentWiring {
  world: World;
  extract: Extractor;
  chain: AgentDeps['chain'];
  hooks?: { ground?: Grounder; toolArgPolicy?: ToolArgPolicy };
  evidence: EvidenceStore;
  clock: () => number;
  broadcast?: typeof broadcast;
  rpcUrls: string[];
}

export interface Snapshot {
  book: Book;
  decimalsOf: AgentDeps['decimalsOf'];
  fees: FeePolicy;
  evmSender: AgentDeps['evmSender'];
}

export function buildAgentDeps(parts: AgentWiring, snapshot: () => Snapshot): AgentDeps {
  const { world } = parts;
  const hooks = parts.hooks ?? {};
  return {
    run,
    // the paste is the world's paste text for this run, so only read_paste can return it; an item scope keeps one inbox record
    makeTools: (scope) => fixtureTools({ ...world, inbox: scope.itemId === null ? world.inbox : world.inbox.filter((m) => m.id === scope.itemId), paste: scope.paste }),
    inboxItemIds: async () => world.inbox.map((m) => m.id),
    extract: parts.extract,
    book: { resolve: (alias) => snapshot().book.resolve(alias) },
    decimalsOf: (asset) => snapshot().decimalsOf(asset),
    ...(hooks.ground === undefined ? {} : { ground: hooks.ground }),
    ...(hooks.toolArgPolicy === undefined ? {} : { toolArgPolicy: hooks.toolArgPolicy }),
    chain: parts.chain,
    fees: (assetId) => snapshot().fees(assetId),
    evmSender: (assetId) => snapshot().evmSender(assetId),
    rpcUrls: parts.rpcUrls,
    ...(parts.broadcast === undefined ? {} : { broadcast: parts.broadcast }),
    evidence: parts.evidence,
    clock: parts.clock,
  };
}

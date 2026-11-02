// The Task page's real dependencies (AIR-184): the shared trace store, the asset read through the console's own chain client, and the deps
// PreviewFlow needs. Everything is lazy: nothing reads the config or the chain until the page asks, so a console built without its
// environment still shows the form and says so when the owner submits.
import { registryFromRows } from '@airlock/runtime/analyze';
import { rpcChainReads } from '../chain/reads.ts';
import type { AssetRows } from '../chain/reads.ts';
import { rpcView } from '../chain/rpc.ts';
import { consoleConfig } from '../config.ts';
import { confirmTask, createDraft, runReadOnly } from '../preview/api.ts';
import { indexedDbKeyStore } from '../preview/taskKey.ts';
import { setRegistry, traceStore } from './store.ts';
import type { TaskDeps } from './TaskView.tsx';

export function liveTaskDeps(): TaskDeps {
  return {
    store: traceStore,
    async loadRegistry() {
      try {
        const cfg = consoleConfig();
        const rows = await rpcView(cfg)('list_assets', {});
        setRegistry(Array.isArray(rows) ? registryFromRows(rows as AssetRows) : null);
      } catch {
        setRegistry(null);
      }
    },
    previewDeps(accountId) {
      const cfg = consoleConfig();
      return {
        base: '',
        reads: rpcChainReads(cfg),
        keys: indexedDbKeyStore(),
        api: { createDraft, confirmTask, runReadOnly },
        env: { agentId: cfg.agentId, contractId: cfg.contractId, rand: (n) => crypto.getRandomValues(new Uint8Array(n)) },
        ownerId: accountId,
      };
    },
  };
}

// Fixture routes of AIR-185. `preview-u01` is the happy path with fake reads and a fake runtime (the confirm call is recorded on
// `window.__previewConfirms`), `preview-nokey` has no task key on chain, and `preview-s30` calls the real `createDraft` against its own origin,
// where the e2e puts a Playwright route that plays a malicious runtime. The s30 route waits for `window.__s30Double` (set by the e2e before
// load), so the generic fixtures run, which has no such double, never sends a request the proxy cannot answer.
import { useState } from 'react';
import { checkPlan, planSha256 } from '@airlock/runtime/dsl';
import type { OwnerTask } from '@airlock/runtime/dsl';
import type { ChainReads } from '../chain/reads.ts';
import { confirmTask, createDraft, runReadOnly } from '../preview/api.ts';
import type { RuntimeDraft } from '../preview/api.ts';
import { PreviewFlow } from '../preview/PreviewFlow.tsx';
import type { PreviewDeps } from '../preview/PreviewFlow.tsx';
import { ensureKey, memoryKeyStore } from '../preview/taskKey.ts';
import data from '../../fixtures/preview-u01.json' with { type: 'json' };
import { registerFixture } from './registry.ts';

export type Mode = 'u01' | 'nokey' | 's30';

declare global {
  interface Window {
    __s30Double?: boolean;
    __previewConfirms?: { draftId: string; task: OwnerTask; sig: string }[];
    __previewPublicKeyRaw?: string;
    __previewConfirmed?: string;
  }
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

export function makeDeps(mode: Mode): PreviewDeps {
  const keys = memoryKeyStore();
  const reads: ChainReads = {
    getBook: async () => data.snapshot.book as unknown as Awaited<ReturnType<ChainReads['getBook']>>,
    listAssets: async () => data.snapshot.assets as unknown as Awaited<ReturnType<ChainReads['listAssets']>>,
    getPolicy: async () => data.snapshot.policy,
    // the key of this browser, as if it had been registered on chain (nokey: nothing registered)
    getTaskKey: async () => {
      if (mode === 'nokey') return null;
      const key = await ensureKey(keys);
      const pair = await keys.load();
      if (pair !== null) window.__previewPublicKeyRaw = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
      return key.publicKey;
    },
    latestBlockMs: async () => data.blockMs,
  };
  const fakeApi: PreviewDeps['api'] = {
    createDraft: async (): Promise<RuntimeDraft> => ({ draftId: 'fixture-draft', planSha256: planSha256(checkPlan(data.plan)), plan: data.plan, extras: {} }),
    confirmTask: async (_base, draftId, task, sig) => {
      (window.__previewConfirms ??= []).push({ draftId, task, sig: b64(sig) });
      return { runId: 'fixture-run' };
    },
    runReadOnly: async () => ({ runId: 'fixture-run' }),
  };
  return {
    base: '',
    reads,
    keys,
    api: mode === 's30' ? { createDraft, confirmTask, runReadOnly } : fakeApi,
    env: { agentId: 'agent.testnet', contractId: 'policy.testnet', rand: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    ownerId: 'owner.testnet',
  };
}

function PreviewFixture({ mode }: { mode: Mode }) {
  const [deps] = useState(() => makeDeps(mode));
  const [runId, setRunId] = useState<string | null>(null);
  const waiting = mode === 's30' && window.__s30Double !== true;
  return (
    <main className="page fixture" data-testid={`fixture-preview-${mode}`}>
      {waiting ? (
        <p>This route waits for a runtime double.</p>
      ) : runId !== null ? (
        <p data-testid="fixture-confirmed">{`Run ${runId} started.`}</p>
      ) : (
        <PreviewFlow instruction={data.instruction} paste={null} deps={deps} onConfirmed={setRunId} onEdit={() => undefined} />
      )}
    </main>
  );
}

registerFixture('preview-u01', () => <PreviewFixture mode="u01" />);
registerFixture('preview-nokey', () => <PreviewFixture mode="nokey" />);
registerFixture('preview-s30', () => <PreviewFixture mode="s30" />);

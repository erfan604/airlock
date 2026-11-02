// Fixture routes of AIR-184: the live trace from recorded events. Each route mounts the trace list on the shared store and connects it to a
// run id, so the real EventSource path runs against the same-origin route (in the e2e, a small server that speaks AIR-161's protocol sits behind
// the preview proxy). The routes wait for `window.__traceLive` (set by the e2e before load), so the generic fixtures run, which has no such
// server, never opens a stream the proxy cannot answer. `task-page` is the whole Task page on fake deps: type, preview, confirm, trace.
import { useEffect } from 'react';
import { registryFromRows } from '@airlock/runtime/analyze';
import preview from '../../fixtures/preview-u01.json' with { type: 'json' };
import { TraceList } from '../task/TraceList.tsx';
import { TaskView } from '../task/TaskView.tsx';
import type { TaskDeps } from '../task/TaskView.tsx';
import { setRegistry, traceStore } from '../task/store.ts';
import { makeDeps } from './preview.tsx';
import { registerFixture } from './registry.ts';

declare global {
  interface Window {
    __traceLive?: boolean;
  }
}

/** Run ids of the e2e's stream server (web/e2e/task.setup.ts), one per recorded scenario. */
export const TASK_RUNS = {
  allowed: '00000000000000000000000000000000',
  held: '00000000000000000000000000000001',
  hostile: '11111111111111111111111111111111',
  drop: '22222222222222222222222222222222',
  long: '33333333333333333333333333333333',
} as const;

const assets = (): ReturnType<typeof registryFromRows> => registryFromRows(preview.snapshot.assets as unknown as Parameters<typeof registryFromRows>[0]);

function TraceFixture({ runId }: { runId: string }) {
  const live = window.__traceLive === true;
  useEffect(() => {
    if (!live) return;
    setRegistry(assets());
    traceStore.connect(runId);
    return () => traceStore.disconnect();
  }, [live, runId]);
  return (
    <main className="page fixture" data-testid="fixture-task">
      {live ? <TraceList store={traceStore} /> : <p>This route waits for a run stream.</p>}
    </main>
  );
}

const fakeDeps: TaskDeps = {
  store: traceStore,
  loadRegistry: async () => setRegistry(assets()),
  previewDeps: (accountId) => {
    const d = makeDeps('u01');
    return { ...d, ownerId: accountId, api: { ...d.api, confirmTask: async () => ({ runId: TASK_RUNS.allowed }) } };
  },
};

registerFixture('task-allowed', () => <TraceFixture runId={TASK_RUNS.allowed} />);
registerFixture('task-held', () => <TraceFixture runId={TASK_RUNS.held} />);
registerFixture('task-hostile', () => <TraceFixture runId={TASK_RUNS.hostile} />);
registerFixture('task-drop', () => <TraceFixture runId={TASK_RUNS.drop} />);
registerFixture('task-long', () => <TraceFixture runId={TASK_RUNS.long} />);
registerFixture('task-page', () => <TaskView initialInstruction={preview.instruction} accountId="owner.testnet" deps={fakeDeps} />);

// Draft, read, guard, key, screen (AIR-185). The Task page (AIR-184) mounts this after its instruction box submits. The flow asks the runtime for
// a plan, reads the chain itself, and only a plan that survives the S30 guard reaches the screen. A refusal replaces the screen with a closed
// text and nothing can sign. CONFIRM AND RUN signs the bytes the card was decoded from, sends them, stores the salt and reports the run id.
import { useEffect, useMemo, useRef, useState } from 'react';
import { registryFromRows } from '@airlock/runtime/analyze';
import type { OwnerTask } from '@airlock/runtime/dsl';
import { readSnapshot } from '../chain/reads.ts';
import type { ChainReads, ChainSnapshot } from '../chain/reads.ts';
import { guardRuntime } from './api.ts';
import type { RuntimeDraft } from './api.ts';
import { PreviewScreen } from './PreviewScreen.tsx';
import type { BuildOk, BuildEnv, Refusal } from './preview.ts';
import { refusal } from './preview.ts';
import { KeyUnsupported, ensureKey } from './taskKey.ts';
import type { KeyStore, TaskKey } from './taskKey.ts';

export type PreviewDeps = {
  base: string;
  reads: ChainReads;
  keys: KeyStore;
  api: {
    createDraft(base: string, instruction: string, paste: string | null): Promise<RuntimeDraft>;
    confirmTask(base: string, draftId: string, task: OwnerTask, sig: Uint8Array): Promise<{ runId: string }>;
  };
  env: BuildEnv;
  ownerId: string;
};

export type PreviewFlowProps = { instruction: string; paste: string | null; deps: PreviewDeps; onConfirmed(runId: string): void; onEdit(): void };

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed'; text: string }
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'ready'; draftId: string; build: BuildOk; snap: ChainSnapshot; key: TaskKey };

const FAILED_READ = 'The console could not read the plan or the chain. Nothing was signed.';
const FAILED_SEND = 'The runtime did not accept the task. Nothing was spent. Check again or edit the request.';

export function PreviewFlow({ instruction, paste, deps, onConfirmed, onEdit }: PreviewFlowProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice in development: one draft per mount, never two plans for one request
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const draft = await deps.api.createDraft(deps.base, instruction, paste);
        const snap = await readSnapshot(deps.reads);
        const guarded = guardRuntime(draft, snap, deps.env, instruction);
        if (!('ok' in guarded)) return setPhase({ kind: 'refused', refusal: guarded });
        const key = await ensureKey(deps.keys);
        setPhase({ kind: 'ready', draftId: draft.draftId, build: guarded.build, snap, key });
      } catch (e) {
        setPhase(e instanceof KeyUnsupported ? { kind: 'refused', refusal: refusal('KeyUnsupported') } : { kind: 'failed', text: FAILED_READ });
      }
    })();
  }, [deps, instruction, paste]);

  const registry = useMemo(() => (phase.kind === 'ready' ? registryFromRows(phase.snap.assets) : null), [phase]);
  const bookKeys = useMemo(() => (phase.kind === 'ready' ? new Set(phase.snap.book.map(([k]) => k)) : new Set<string>()), [phase]);

  if (phase.kind === 'loading') {
    return (
      <p className="preview-status" role="status" data-testid="preview-loading">
        Reading the plan and the chain.
      </p>
    );
  }
  if (phase.kind === 'failed' || phase.kind === 'refused') {
    const text = phase.kind === 'failed' ? phase.text : phase.refusal.text;
    return (
      <section className="preview preview-refusal" data-testid="refusal" data-code={phase.kind === 'refused' ? phase.refusal.code : 'ReadFailed'} role="alert">
        <h2 className="preview-title">Not signing</h2>
        <p className="preview-text">{text}</p>
        <button type="button" className="card-btn card-btn-outline" data-testid="edit" onClick={onEdit}>
          Edit
        </button>
      </section>
    );
  }
  if (registry === null) return null;

  const ready = phase;
  const registered = ready.snap.taskKey === ready.key.publicKey;

  async function confirm(): Promise<void> {
    if (busy || !registered) return;
    setBusy(true);
    setNotice(null);
    try {
      const sig = await ready.key.sign(ready.build.bytes);
      const { runId } = await deps.api.confirmTask(deps.base, ready.draftId, ready.build.task, sig);
      await deps.keys.saveSalt(ready.build.task.task_id, ready.build.saltHex);
      onConfirmed(runId);
    } catch {
      setNotice(FAILED_SEND);
      setBusy(false);
    }
  }

  async function recheck(): Promise<void> {
    setBusy(true);
    try {
      const taskKey = await deps.reads.getTaskKey();
      setPhase({ ...ready, snap: { ...ready.snap, taskKey } });
      setNotice(taskKey === ready.key.publicKey ? null : 'The chain still shows a different task key.');
    } catch {
      setNotice(FAILED_READ);
    }
    setBusy(false);
  }

  return (
    <PreviewScreen
      build={ready.build}
      registry={registry}
      bookKeys={bookKeys}
      taskKey={{ publicKey: ready.key.publicKey, registered }}
      contractId={deps.env.contractId}
      ownerId={deps.ownerId}
      busy={busy}
      notice={notice}
      onConfirm={() => void confirm()}
      onEdit={onEdit}
      onRecheck={() => void recheck()}
    />
  );
}

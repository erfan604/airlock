// The Task page (AIR-184): the owner types an instruction, PreviewFlow (AIR-185) drafts, shows and signs the task, and then the run's trace arrives
// live below. This file never builds a task and never signs. The pieces are split so that each can be tested without a DOM: the phase machine
// (`taskReducer`), the handlers PreviewFlow calls (`flowHandlers`), the form (`ComposeForm`) and the page body (`TaskViewBody`).
import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { PreviewFlow } from '../preview/PreviewFlow.tsx';
import type { PreviewDeps } from '../preview/PreviewFlow.tsx';
import { TraceListView } from './TraceList.tsx';
import type { TraceState, TraceStore } from './traceStore.ts';

export const MAX_INSTRUCTION = 4000;
export const MAX_PASTE = 20000;

const BAD_RUN = 'The runtime sent a run id the console cannot follow. Nothing was spent.';
const NOT_READY = 'The console is not set up to reach the chain. Nothing was signed.';

/** 1 to 4000 characters; a box of blanks is empty. */
export function canSubmit(instruction: string): boolean {
  return instruction.trim().length > 0 && instruction.length <= MAX_INSTRUCTION;
}

export type TaskPhase = { kind: 'compose'; notice: string | null } | { kind: 'preview'; instruction: string; paste: string | null } | { kind: 'running' };
export type TaskAction =
  | { type: 'submit'; instruction: string; paste: string }
  | { type: 'edit' }
  | { type: 'confirmed' }
  | { type: 'failed'; notice: string };

export function taskReducer(p: TaskPhase, a: TaskAction): TaskPhase {
  switch (a.type) {
    case 'submit':
      if (p.kind !== 'compose' || !canSubmit(a.instruction) || a.paste.length > MAX_PASTE) return p;
      return { kind: 'preview', instruction: a.instruction, paste: a.paste === '' ? null : a.paste };
    case 'edit':
      return p.kind === 'preview' ? { kind: 'compose', notice: null } : p;
    case 'confirmed':
      return p.kind === 'preview' ? { kind: 'running' } : p;
    case 'failed':
      return p.kind === 'running' ? p : { kind: 'compose', notice: a.notice };
  }
}

/** What PreviewFlow calls: a confirmed run id connects the store once; a run id the store refuses goes back to the form with a notice. */
export function flowHandlers(dispatch: (a: TaskAction) => void, store: Pick<TraceStore, 'connect'>): { onConfirmed(runId: string): void; onEdit(): void } {
  return {
    onConfirmed(runId) {
      try {
        store.connect(runId);
      } catch {
        dispatch({ type: 'failed', notice: BAD_RUN });
        return;
      }
      dispatch({ type: 'confirmed' });
    },
    onEdit() {
      dispatch({ type: 'edit' });
    },
  };
}

export type ComposeFormProps = {
  instruction: string;
  paste: string;
  notice: string | null;
  onInstruction(v: string): void;
  onPaste(v: string): void;
  onSubmit(): void;
};

export function ComposeForm({ instruction, paste, notice, onInstruction, onPaste, onSubmit }: ComposeFormProps) {
  return (
    <form
      className="task-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit(instruction)) onSubmit();
      }}
    >
      <label className="task-label" htmlFor="instruction-input">
        What should the agent do
      </label>
      <textarea
        id="instruction-input"
        className="task-input"
        data-testid="instruction-input"
        rows={4}
        maxLength={MAX_INSTRUCTION}
        value={instruction}
        onChange={(e) => onInstruction(e.target.value)}
      />
      <p className="task-count" data-testid="instruction-count">{`${instruction.length} of ${MAX_INSTRUCTION} characters`}</p>
      <label className="task-label" htmlFor="paste-input">
        Outside text, optional
      </label>
      <p className="task-help">This text is read as outside text. It is never planner input and never changes what the agent is allowed to do.</p>
      <textarea
        id="paste-input"
        className="task-input task-input-paste"
        data-testid="paste-input"
        rows={4}
        maxLength={MAX_PASTE}
        value={paste}
        onChange={(e) => onPaste(e.target.value)}
      />
      {notice === null ? null : (
        <p className="task-notice" role="alert" data-testid="task-notice">
          {notice}
        </p>
      )}
      <button type="submit" className="card-btn card-btn-primary" data-testid="submit-task" disabled={!canSubmit(instruction)}>
        Preview the plan
      </button>
    </form>
  );
}

export type TaskViewBodyProps = {
  phase: TaskPhase;
  instruction: string;
  paste: string;
  onInstruction(v: string): void;
  onPaste(v: string): void;
  onSubmit(): void;
  trace: TraceState;
  renderPreview(p: { instruction: string; paste: string | null }): ReactNode;
};

export function TaskViewBody({ phase, instruction, paste, onInstruction, onPaste, onSubmit, trace, renderPreview }: TaskViewBodyProps) {
  return (
    <main className="page task" data-testid="task-view">
      <h1 className="task-title">Task</h1>
      {phase.kind === 'compose' ? (
        <ComposeForm instruction={instruction} paste={paste} notice={phase.notice} onInstruction={onInstruction} onPaste={onPaste} onSubmit={onSubmit} />
      ) : phase.kind === 'preview' ? (
        renderPreview({ instruction: phase.instruction, paste: phase.paste })
      ) : (
        <TraceListView state={trace} />
      )}
    </main>
  );
}

export type TaskDeps = {
  store: TraceStore;
  /** Reads the asset list once so amounts print with their symbol; a failed read leaves base units. Never throws. */
  loadRegistry(): Promise<void>;
  /** Throws when the console is not configured. */
  previewDeps(accountId: string): PreviewDeps;
};

export type TaskViewProps = { initialInstruction?: string; accountId: string; deps: TaskDeps };

export function TaskView({ initialInstruction, accountId, deps }: TaskViewProps) {
  const [phase, dispatch] = useReducer(taskReducer, { kind: 'compose', notice: null });
  const [instruction, setInstruction] = useState(initialInstruction ?? '');
  const [paste, setPaste] = useState('');
  const [pdeps, setPdeps] = useState<PreviewDeps | null>(null);
  const trace = useSyncExternalStore(deps.store.subscribe, deps.store.getSnapshot, deps.store.getSnapshot);
  const handlers = useMemo(() => flowHandlers(dispatch, deps.store), [deps.store]);

  useEffect(() => {
    void deps.loadRegistry();
  }, [deps]);

  function onSubmit(): void {
    let d: PreviewDeps;
    try {
      d = deps.previewDeps(accountId);
    } catch {
      dispatch({ type: 'failed', notice: NOT_READY });
      return;
    }
    setPdeps(d);
    dispatch({ type: 'submit', instruction, paste });
  }

  return (
    <TaskViewBody
      phase={phase}
      instruction={instruction}
      paste={paste}
      onInstruction={setInstruction}
      onPaste={setPaste}
      onSubmit={onSubmit}
      trace={trace}
      renderPreview={(p) => (pdeps === null ? null : <PreviewFlow instruction={p.instruction} paste={p.paste} deps={pdeps} onConfirmed={handlers.onConfirmed} onEdit={handlers.onEdit} />)}
    />
  );
}

// The Task page (AIR-184) through react-dom/server and its pure parts: a server render cannot click, so the phase machine, the handlers and the
// presentational view are tested apart, each with fake deps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { SessionGateView } from '../src/wallet/SessionGate.tsx';
import type { PreviewFlowProps } from '../src/preview/PreviewFlow.tsx';
import {
  ComposeForm,
  MAX_INSTRUCTION,
  MAX_PASTE,
  TaskViewBody,
  canSubmit,
  flowHandlers,
  taskReducer,
} from '../src/task/TaskView.tsx';
import type { TaskPhase } from '../src/task/TaskView.tsx';
import { TaskPageChildren } from '../src/task/TaskPage.tsx';
import { initialTraceState } from '../src/task/traceStore.ts';

const RUN = '00000000000000000000000000000000';
const noop = (): void => undefined;

const compose = (instruction: string, paste = ''): string =>
  renderToStaticMarkup(<ComposeForm instruction={instruction} paste={paste} notice={null} onInstruction={noop} onPaste={noop} onSubmit={noop} />);

const submitTag = (html: string): string => {
  const m = /<button[^>]*data-testid="submit-task"[^>]*>/.exec(html);
  assert.ok(m, 'submit-task is rendered');
  return m[0];
};

test('canSubmit: 1 to 4000 characters, blank is refused', () => {
  assert.equal(canSubmit(''), false);
  assert.equal(canSubmit('   \n'), false);
  assert.equal(canSubmit('a'), true);
  assert.equal(canSubmit('a'.repeat(MAX_INSTRUCTION)), true);
  assert.equal(canSubmit('a'.repeat(MAX_INSTRUCTION + 1)), false);
  assert.equal(MAX_INSTRUCTION, 4000);
  assert.equal(MAX_PASTE, 20000);
});

test('compose: submit-task is disabled for an empty instruction and one over 4000 characters, enabled otherwise', () => {
  assert.ok(/\bdisabled\b/.test(submitTag(compose(''))));
  assert.ok(/\bdisabled\b/.test(submitTag(compose('a'.repeat(4001)))));
  assert.equal(/\bdisabled\b/.test(submitTag(compose('Pay the April invoice from my accountant.'))), false);
  assert.equal(/\bdisabled\b/.test(submitTag(compose('a'.repeat(4000)))), false);
});

test('compose: the two boxes, their limits and the paste label that says it is read as outside text', () => {
  const html = compose('x');
  assert.ok(html.includes('data-testid="instruction-input"'));
  assert.ok(html.includes('data-testid="paste-input"'));
  assert.ok(html.includes('maxLength="4000"') || html.includes('maxlength="4000"'));
  assert.ok(html.includes('maxLength="20000"') || html.includes('maxlength="20000"'));
  assert.ok(/outside text/i.test(html));
  assert.ok(/never .*planner|planner .*never/i.test(html));
});

test('compose: the paste text is in the paste box only', () => {
  const html = compose('my instruction', 'PASTED-OUTSIDE-TEXT');
  assert.equal(html.split('PASTED-OUTSIDE-TEXT').length - 1, 1);
  assert.equal(html.split('my instruction').length - 1, 1);
  const paste = /<textarea[^>]*data-testid="paste-input"[^>]*>([^<]*)<\/textarea>/.exec(html);
  assert.equal(paste?.[1], 'PASTED-OUTSIDE-TEXT');
});

test('taskReducer: submit moves to preview with a null paste for an empty box, edit goes back, confirmed runs', () => {
  const c: TaskPhase = { kind: 'compose', notice: null };
  const p = taskReducer(c, { type: 'submit', instruction: 'do it', paste: '' });
  assert.deepEqual(p, { kind: 'preview', instruction: 'do it', paste: null });
  const p2 = taskReducer(c, { type: 'submit', instruction: 'do it', paste: 'text' });
  assert.deepEqual(p2, { kind: 'preview', instruction: 'do it', paste: 'text' });
  assert.deepEqual(taskReducer(p, { type: 'edit' }), { kind: 'compose', notice: null });
  assert.deepEqual(taskReducer(p, { type: 'confirmed' }), { kind: 'running' });
});

test('taskReducer: a submit that canSubmit refuses, a confirm outside preview and a paste over the limit change nothing', () => {
  const c: TaskPhase = { kind: 'compose', notice: null };
  assert.deepEqual(taskReducer(c, { type: 'submit', instruction: '', paste: '' }), c);
  assert.deepEqual(taskReducer(c, { type: 'submit', instruction: 'a'.repeat(4001), paste: '' }), c);
  assert.deepEqual(taskReducer(c, { type: 'submit', instruction: 'ok', paste: 'p'.repeat(20001) }), c);
  assert.deepEqual(taskReducer(c, { type: 'confirmed' }), c);
  const r: TaskPhase = { kind: 'running' };
  assert.deepEqual(taskReducer(r, { type: 'edit' }), r);
  assert.deepEqual(taskReducer(r, { type: 'submit', instruction: 'x', paste: '' }), r);
});

test('flowHandlers: onConfirmed calls connect once with the run id and confirms the phase', () => {
  const calls: string[] = [];
  const actions: string[] = [];
  const h = flowHandlers((a) => actions.push(a.type), { connect: (id) => calls.push(id) });
  h.onConfirmed(RUN);
  assert.deepEqual(calls, [RUN]);
  assert.deepEqual(actions, ['confirmed']);
});

test('flowHandlers: a run id the store refuses sends the page back to the form with a notice and never confirms', () => {
  const actions: { type: string; notice?: string }[] = [];
  const h = flowHandlers(
    (a) => actions.push(a as { type: string; notice?: string }),
    {
      connect: () => {
        throw new Error('bad run id');
      },
    },
  );
  h.onConfirmed('nope');
  assert.deepEqual(actions.map((a) => a.type), ['failed']);
  assert.ok((actions[0]?.notice ?? '').length > 0);
});

test('flowHandlers: onEdit dispatches edit', () => {
  const actions: string[] = [];
  flowHandlers((a) => actions.push(a.type), { connect: noop }).onEdit();
  assert.deepEqual(actions, ['edit']);
});

function body(phase: TaskPhase, instruction = 'Pay the invoice', paste = '', renderPreview: (p: Pick<PreviewFlowProps, 'instruction' | 'paste'>) => ReactNode = () => null): string {
  return renderToStaticMarkup(
    <TaskViewBody
      phase={phase}
      instruction={instruction}
      paste={paste}
      onInstruction={noop}
      onPaste={noop}
      onSubmit={noop}
      trace={initialTraceState()}
      renderPreview={renderPreview}
    />,
  );
}

test('view: compose shows the instruction box and no trace, preview hides the form, running shows the trace list', () => {
  const c = body({ kind: 'compose', notice: null });
  assert.ok(c.includes('data-testid="task-view"'));
  assert.ok(c.includes('data-testid="instruction-input"'));
  assert.equal(c.includes('data-testid="trace-list"'), false);
  const p = body({ kind: 'preview', instruction: 'Pay the invoice', paste: null }, 'Pay the invoice', '', () => <p data-testid="fake-preview">preview</p>);
  assert.ok(p.includes('data-testid="fake-preview"'));
  assert.equal(p.includes('data-testid="instruction-input"'), false);
  const r = body({ kind: 'running' });
  assert.ok(r.includes('data-testid="trace-list"'));
  assert.equal(r.includes('data-testid="instruction-input"'), false);
});

test('view: the paste text goes to the preview as paste and appears nowhere else on the page', () => {
  const seen: { instruction: string; paste: string | null }[] = [];
  const html = body({ kind: 'preview', instruction: 'Pay the invoice', paste: 'OUTSIDE-TEXT-1' }, 'Pay the invoice', 'OUTSIDE-TEXT-1', (p) => {
    seen.push({ instruction: p.instruction, paste: p.paste });
    return null;
  });
  assert.deepEqual(seen, [{ instruction: 'Pay the invoice', paste: 'OUTSIDE-TEXT-1' }]);
  assert.equal(html.includes('OUTSIDE-TEXT-1'), false);
});

test('view: a notice on the form is shown as plain text', () => {
  const html = renderToStaticMarkup(<ComposeForm instruction="x" paste="" notice="The runtime sent a bad run id." onInstruction={noop} onPaste={noop} onSubmit={noop} />);
  assert.ok(html.includes('The runtime sent a bad run id.'));
});

test('view: initial instruction is the text of the instruction box', () => {
  const html = compose('Pay the April invoice from my accountant.');
  const m = /<textarea[^>]*data-testid="instruction-input"[^>]*>([^<]*)<\/textarea>/.exec(html);
  assert.equal(m?.[1], 'Pay the April invoice from my accountant.');
});

test('page: without a session nothing but the login button is rendered, the task view is not', () => {
  const html = renderToStaticMarkup(
    <SessionGateView state={{ kind: 'out', error: null, busy: false }} onConnect={noop}>
      {TaskPageChildren()}
    </SessionGateView>,
  );
  assert.ok(html.includes('data-testid="login-connect"'));
  assert.equal(html.includes('data-testid="task-view"'), false);
  assert.equal(html.includes('instruction-input'), false);
  assert.equal(html.includes('submit-task'), false);
});

test('page: with a session the task view renders under it', () => {
  const html = renderToStaticMarkup(
    <SessionGateView state={{ kind: 'in', accountId: 'owner.testnet' }} onConnect={noop}>
      {TaskPageChildren()}
    </SessionGateView>,
  );
  assert.ok(html.includes('data-testid="task-view"'));
  assert.ok(html.includes('data-testid="instruction-input"'));
});

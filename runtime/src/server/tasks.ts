// The task routes (AIR-163): draft, confirm, cancel and read one task, behind the owner session. The runtime never takes bounds: the owner's
// console derives them from the plan it hashes itself, signs the task, and the runtime only checks that the task names this agent, this
// contract, the plan it drafted (by hash) and the instance count the analyzer gives. The contract verifies the owner's signature, not us.
// A task is used once: after any terminal state the way forward is a new draft, a new confirmation and a new task id.
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { maxActionsFor } from '../analyze/index.ts';
import { isReadOnlyPlan } from '../agent.ts';
import type { planTask, runReadOnly, runTask } from '../agent.ts';
import type { AgentDeps, ReadOnlyParams, RunTaskParams } from '../agent.ts';
import { OwnerTask, PlanRejected, checkPlan, planSha256, taskHash } from '../dsl/index.ts';
import type { CheckedPlan } from '../dsl/index.ts';
import type { TraceEvent } from '../interpreter/trace.ts';
import type { RunStore } from './runs.ts';
import { decodeSignature, requireSession } from './session.ts';
import type { SessionInfo } from './session.ts';
import { isTerminal, reduce } from './state.ts';
import type { RunEvent, RunState } from './state.ts';

export type { RunView } from './runs.ts';
export type { RunState } from './state.ts';

// the planner's input type, taken from the door (agent.ts) because nothing outside it may import the planner (AIR-141)
type OwnerRequest = RunTaskParams['ownerRequest'];

export interface TaskDeps {
  agentAccountId: string;
  contractId: string;
  /** advisory: the contract checks block time and the owner's maximum TTL */
  clock(): number;
  model: string;
  planTask: typeof planTask;
  runTask: typeof runTask;
  /** AIR-293: the run of a plan with no action step, with no task */
  runReadOnly: typeof runReadOnly;
  agentDeps: AgentDeps;
  store: RunStore;
  /** 32 lowercase hex characters from 16 random bytes; the draft id is the run id */
  newId(): string;
}

/**
 * The answer of POST /tasks: nothing else, no bounds and no preview (the console derives both from the plan). `readOnly` is present (true)
 * only for a plan with no action step (AIR-293); the console checks that itself and never trusts the flag.
 */
export interface DraftResponse {
  draftId: string;
  readOnly?: true;
  plan: CheckedPlan;
  planSha256: string;
}

const DraftBody = z.strictObject({
  instruction: z.string().min(1).max(4000),
  paste: z.string().max(20_000).optional(),
});

const ConfirmBody = z.strictObject({
  task: OwnerTask,
  // standard base64 of exactly 64 bytes
  taskSig: z.string().refine((s) => {
    try {
      decodeSignature(s);
      return true;
    } catch {
      return false;
    }
  }),
});

// 4000 + 20000 characters can be 6 bytes each once JSON escapes them; the owner is one person, this only stops a huge body
const BODY_MAX = 256 * 1024;

interface Draft {
  plan: CheckedPlan;
  /** kept in memory for the run only; never written, never given to the planner */
  paste: string | null;
  request: OwnerRequest;
  /** the plan has no action step (isReadOnlyPlan), so run-read-only accepts it and nothing else */
  readOnly: boolean;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const notAllowed = (state: RunState): string => (isTerminal(state) ? 'needs a new task' : 'wrong state');

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function registerTaskRoutes(app: Hono, deps: TaskDeps): void {
  const { store } = deps;
  const drafts = new Map<string, Draft>();
  const limit = bodyLimit({ maxSize: BODY_MAX, onError: (c) => c.json({ error: 'body too large' }, 413) });

  // the run of this account, or undefined: another owner's run looks exactly like an unknown one
  const ownRun = (id: string, session: SessionInfo) => {
    const rec = store.get(id);
    return rec !== undefined && rec.owner === session.accountId ? rec : undefined;
  };

  const step = (id: string, event: RunEvent, error?: string): RunState | undefined => {
    const rec = store.get(id);
    const next = rec === undefined ? undefined : reduce(rec.state, event);
    if (next !== undefined) store.setState(id, next, error);
    return next;
  };

  app.post('/tasks', requireSession, limit, async (c) => {
    const session = c.get('session');
    const parsed = DraftBody.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'bad request' }, 400);
    const { instruction, paste } = parsed.data;
    const id = deps.newId();
    store.create({ id, owner: session.accountId, state: 'draft', planSha256: '', taskHash: null, events: [], error: null });
    const request: OwnerRequest = { text: instruction, ownerAccountId: session.accountId, sessionId: session.sessionId };
    let plan: CheckedPlan;
    try {
      const out = await deps.planTask(request, deps.model);
      // a fresh, frozen copy that passed the checker again: what the planner kept a handle on cannot change what runs
      plan = deepFreeze(checkPlan(JSON.parse(JSON.stringify(out.plan))));
    } catch (e) {
      step(id, 'PLAN_FAILED');
      if (e instanceof PlanRejected) return c.json({ error: 'plan rejected', code: e.code }, 422);
      return c.json({ error: 'planner unavailable' }, 502);
    }
    const hash = planSha256(plan);
    store.setPlanSha256(id, hash);
    const readOnly = isReadOnlyPlan(plan);
    drafts.set(id, { plan, paste: paste ?? null, request, readOnly });
    step(id, 'PLANNED');
    const answer: DraftResponse = readOnly ? { draftId: id, readOnly: true, plan, planSha256: hash } : { draftId: id, plan, planSha256: hash };
    return c.json(answer);
  });

  app.post('/tasks/:id/confirm', requireSession, limit, async (c) => {
    const session = c.get('session');
    const id = c.req.param('id');
    const rec = ownRun(id, session);
    if (rec === undefined) return c.json({ error: 'not found' }, 404);
    const parsed = ConfirmBody.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: 'bad request' }, 400);
    const { task, taskSig } = parsed.data;
    // from here to the state change there is no await: two confirmations cannot interleave
    const draft = drafts.get(id);
    const refuse = (error: string) => c.json({ error }, 409);
    if (reduce(rec.state, 'CONFIRM') === undefined || draft === undefined) return refuse(notAllowed(rec.state));
    if (task.plan_sha256 !== rec.planSha256) return refuse('plan hash mismatch');
    if (task.agent_id !== deps.agentAccountId) return refuse('wrong agent');
    if (task.contract_id !== deps.contractId) return refuse('wrong contract');
    if (task.expires_ms <= deps.clock()) return refuse('task expired');
    if (task.max_actions !== maxActionsFor(draft.plan)) return refuse('max_actions differs from the plan');
    if (store.taskIdUsed(task.task_id)) return refuse('task id already used');
    try {
      store.useTaskId(task.task_id);
    } catch {
      return c.json({ error: 'could not record the task id' }, 500);
    }
    store.setTaskHash(id, taskHash(task));
    step(id, 'CONFIRM');
    step(id, 'START');
    const params: RunTaskParams = { ownerRequest: draft.request, paste: draft.paste, task, taskSig: decodeSignature(taskSig), plan: draft.plan, deps: deps.agentDeps };
    void drive(id, deps.runTask(params));
    return c.json({ runId: id }, 202);
  });

  // AIR-293: a plan with no action step runs without a task. The draft goes planned, confirmed, running through the same table, with no task
  // id and no task hash, and the answer is appended as one `say` event per output. A draft is used once, like a task.
  app.post('/tasks/:id/run-read-only', requireSession, limit, async (c) => {
    const id = c.req.param('id');
    const rec = ownRun(id, c.get('session'));
    if (rec === undefined) return c.json({ error: 'not found' }, 404);
    const draft = drafts.get(id);
    if (draft === undefined || !draft.readOnly || reduce(rec.state, 'CONFIRM') === undefined) return c.json({ error: draft?.readOnly === false ? 'plan can pay' : notAllowed(rec.state) }, 409);
    step(id, 'CONFIRM');
    step(id, 'START');
    const params: ReadOnlyParams = { ownerRequest: draft.request, paste: draft.paste, plan: draft.plan, deps: deps.agentDeps };
    void drive(id, deps.runReadOnly(params));
    return c.json({ runId: id }, 202);
  });

  // the background run: every event is appended to the record; the iterator ending is FINISH, a throw is FAIL. A read-only run returns its
  // say output, which becomes `say` events at the end.
  async function drive(id: string, run: AsyncGenerator<TraceEvent, string[] | void>): Promise<void> {
    try {
      for (;;) {
        const n = await run.next();
        if (n.done === true) {
          for (const text of n.value ?? []) store.append(id, { t: deps.clock(), kind: 'say', data: { text } });
          break;
        }
        store.append(id, n.value);
      }
      step(id, 'FINISH');
    } catch (e) {
      // the error's name only: a message can carry text from outside
      step(id, 'FAIL', e instanceof Error && e.name !== '' ? e.name : 'Unexpected');
    } finally {
      const draft = drafts.get(id);
      if (draft !== undefined) draft.paste = null;
    }
  }

  app.get('/runs/:id', requireSession, (c) => {
    const rec = ownRun(c.req.param('id'), c.get('session'));
    if (rec === undefined) return c.json({ error: 'not found' }, 404);
    return c.json(store.viewOf(rec));
  });

  app.post('/runs/:id/cancel', requireSession, (c) => {
    const id = c.req.param('id');
    const rec = ownRun(id, c.get('session'));
    if (rec === undefined) return c.json({ error: 'not found' }, 404);
    const before = rec.state;
    if (step(id, 'CANCEL') === undefined) return c.json({ error: notAllowed(before) }, 409);
    const draft = drafts.get(id);
    if (draft !== undefined) draft.paste = null;
    return c.json({ state: 'aborted' });
  });
}

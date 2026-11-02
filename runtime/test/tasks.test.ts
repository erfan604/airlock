// AIR-163: the task routes and the run store. Everything runs on stubs: a replay mode app, a scripted planTask and a scripted runTask.
// The point of the file: the runtime never accepts bounds, runs exactly the plan whose hash the owner signed, and never plans or runs twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maxActionsFor } from '../src/analyze/index.ts';
import { PlanRejected, checkPlan, planSha256, taskHash } from '../src/dsl/index.ts';
import type { CheckedPlan, OwnerTask } from '../src/dsl/index.ts';
import type { AgentDeps, RunTaskParams } from '../src/agent.ts';
import type { TraceEvent } from '../src/interpreter/trace.ts';
import { createTestSession } from '../src/server/app.ts';
import { RunStore } from '../src/server/runs.ts';
import { registerTaskRoutes } from '../src/server/tasks.ts';
import type { TaskDeps } from '../src/server/tasks.ts';
import { U01, checked } from './helpers/agent.ts';
import { CONTRACT, OWNER, makeApp } from './helpers/server.ts';
import { vectorTask } from './vectors.helpers.ts';

const NOW = 1_800_000_000_000;
const AGENT = 'agent.test.near';
const SIG = Buffer.alloc(64, 7).toString('base64');
const ev = (n: number, kind: TraceEvent['kind'] = 'call', data: Record<string, unknown> = {}): TraceEvent => ({ t: NOW + n, kind, data: { n, ...data } });

interface Script {
  events: TraceEvent[];
  gate: Promise<void> | null;
  throws: Error | null;
}

async function setup(over: Partial<TaskDeps> = {}, dir = mkdtempSync(join(tmpdir(), 'air163-'))) {
  const store = new RunStore({ dataDir: dir });
  const h = makeApp({ mode: 'replay', runEvents: store });
  const plan = checked(U01);
  const planCalls: { req: { text: string; ownerAccountId: string; sessionId: string }; model: string }[] = [];
  const runCalls: RunTaskParams[] = [];
  const script: Script = { events: [ev(1), ev(2)], gate: null, throws: null };
  const state = { plan: plan as CheckedPlan, rejectWith: null as PlanRejected | Error | null, ids: 0 };
  const deps: TaskDeps = {
    agentAccountId: AGENT,
    contractId: CONTRACT,
    clock: () => NOW,
    model: 'z-ai/glm-5.3-flash',
    planTask: async (req, model) => {
      planCalls.push({ req, model });
      if (state.rejectWith !== null) throw state.rejectWith;
      return { plan: state.plan, planSha256: planSha256(state.plan) };
    },
    runTask: async function* (p: RunTaskParams) {
      runCalls.push(p);
      const first = script.events[0];
      if (first !== undefined) yield first;
      if (script.gate !== null) await script.gate;
      if (script.throws !== null) throw script.throws;
      for (const e of script.events.slice(1)) yield e;
    },
    agentDeps: {} as AgentDeps,
    store,
    newId: () => (++state.ids).toString(16).padStart(32, '0'),
    ...over,
  };
  registerTaskRoutes(h.app, deps);
  // routes first: Hono builds its matcher on the first request, which createTestSession makes
  const cookie = await createTestSession(h.app);
  const post = (path: string, body: unknown, c: string | null = cookie) =>
    h.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(c === null ? {} : { cookie: c }) }, body: JSON.stringify(body) });
  const get = (path: string, c: string | null = cookie) => h.app.request(path, c === null ? {} : { headers: { cookie: c } });
  const draft = async (instruction = 'pay the accountant', paste?: string) => {
    const res = await post('/tasks', paste === undefined ? { instruction } : { instruction, paste });
    assert.equal(res.status, 200);
    return (await res.json()) as { draftId: string; plan: CheckedPlan; planSha256: string };
  };
  let taskNo = 0;
  const taskOf = (d: { planSha256: string; plan: CheckedPlan }, over: Partial<OwnerTask> = {}): OwnerTask => ({
    ...vectorTask(),
    task_id: `task${++taskNo}`,
    contract_id: CONTRACT,
    agent_id: AGENT,
    plan_sha256: d.planSha256,
    expires_ms: NOW + 3_600_000,
    max_actions: maxActionsFor(d.plan),
    ...over,
  });
  const confirm = (id: string, task: OwnerTask, taskSig: string = SIG, c: string | null = cookie) => post(`/tasks/${id}/confirm`, { task, taskSig }, c);
  const settle = async (id: string): Promise<string> => {
    for (let i = 0; i < 500; i++) {
      const s = store.get(id)?.state;
      if (s === 'done' || s === 'failed' || s === 'aborted') return s;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('the run did not end');
  };
  return { h, store, cookie, dir, plan, planCalls, runCalls, script, state, deps, post, get, draft, taskOf, confirm, settle };
}

type Env = Awaited<ReturnType<typeof setup>>;

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function gateOf(): { gate: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

// ---- auth ----
test('every route answers 401 without a session', async () => {
  const e = await setup();
  const d = await e.draft();
  const task = e.taskOf(d);
  let n = 0;
  for (const res of [
    await e.post('/tasks', { instruction: 'x' }, null),
    await e.post(`/tasks/${d.draftId}/confirm`, { task, taskSig: SIG }, null),
    await e.get(`/runs/${d.draftId}`, null),
    await e.post(`/runs/${d.draftId}/cancel`, {}, null),
  ]) {
    assert.equal(res.status, 401);
    n += 1;
  }
  assert.equal(e.planCalls.length, 1, 'the unauthenticated POST /tasks never reached the planner');
  assert.equal(e.runCalls.length, 0);
  console.log(`UNAUTH ${n}/4`);
});

// ---- draft ----
test('draft: the answer has exactly draftId, plan and planSha256, and the hash is the console hash', async () => {
  const e = await setup();
  const res = await e.post('/tasks', { instruction: 'pay the accountant' });
  assert.equal(res.status, 200);
  const json = await body(res);
  assert.deepEqual(Object.keys(json).sort(), ['draftId', 'plan', 'planSha256']);
  assert.match(String(json.draftId), /^[0-9a-f]{32}$/);
  assert.equal(json.planSha256, planSha256(checkPlan(JSON.parse(JSON.stringify(json.plan)))));
  assert.equal(json.planSha256, planSha256(e.plan));
  assert.equal(e.planCalls.length, 1);
  const call = e.planCalls[0];
  assert.ok(call !== undefined);
  assert.equal(call.model, 'z-ai/glm-5.3-flash');
  assert.deepEqual(Object.keys(call.req).sort(), ['ownerAccountId', 'sessionId', 'text']);
  assert.equal(call.req.text, 'pay the accountant');
  assert.equal(call.req.ownerAccountId, OWNER);
  assert.match(call.req.sessionId, /^[0-9a-f]{16}$/);
  const run = await body(await e.get(`/runs/${String(json.draftId)}`));
  assert.equal(run.state, 'planned');
});

test('draft: the body is strict, bounds and any other key are refused and the planner is not called', async () => {
  const e = await setup();
  const bad: unknown[] = [
    { instruction: '' },
    { instruction: 'x'.repeat(4001) },
    { instruction: 'x', paste: 'p'.repeat(20_001) },
    { instruction: 'x', bounds: [{ payee_key: 'near:a.near', max_total: '1' }] },
    { instruction: 'x', preview: {} },
    { instruction: 5 },
    {},
    [],
  ];
  for (const b of bad) assert.equal((await e.post('/tasks', b)).status, 400, JSON.stringify(b).slice(0, 60));
  const raw = await e.h.app.request('/tasks', { method: 'POST', headers: { cookie: e.cookie, 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(raw.status, 400);
  assert.equal(e.planCalls.length, 0);
  assert.equal((await e.post('/tasks', { instruction: 'x'.repeat(4000), paste: 'p'.repeat(20_000) })).status, 200, 'the limits are inclusive');
});

test('draft: PlanRejected answers 422 with the code only and leaves the draft failed', async () => {
  const e = await setup();
  e.state.rejectWith = new PlanRejected('UnknownTool', ['steps', 0, 'secret-plan-text']);
  const res = await e.post('/tasks', { instruction: 'do a thing' });
  assert.equal(res.status, 422);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: 'plan rejected', code: 'UnknownTool' });
  assert.ok(!text.includes('secret-plan-text'));
  const id = (1).toString(16).padStart(32, '0');
  assert.equal(e.store.get(id)?.state, 'failed');
  const task = e.taskOf({ planSha256: planSha256(e.plan), plan: e.plan });
  const again = await e.confirm(id, task);
  assert.equal(again.status, 409);
  assert.equal((await body(again)).error, 'needs a new task');
  assert.equal(e.planCalls.length, 1);
});

test('draft: any other planner failure is 502 with no detail and the draft is failed', async () => {
  const e = await setup();
  e.state.rejectWith = new Error('upstream said: sk-secret-key');
  const res = await e.post('/tasks', { instruction: 'do a thing' });
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes('sk-secret-key'));
  assert.equal(e.store.get((1).toString(16).padStart(32, '0'))?.state, 'failed');
});

// ---- confirm ----
test('confirm: the valid task gives 202 and runTask gets the stored plan and the decoded signature once', async () => {
  const e = await setup();
  const d = await e.draft('pay it', 'PASTE-BODY-1');
  const task = e.taskOf(d);
  const res = await e.confirm(d.draftId, task);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { runId: d.draftId });
  assert.equal(await e.settle(d.draftId), 'done');
  assert.equal(e.runCalls.length, 1);
  const p = e.runCalls[0];
  assert.ok(p !== undefined);
  assert.deepEqual(p.task, task);
  assert.deepEqual(p.plan, e.plan);
  assert.ok(Object.isFrozen(p.plan), 'the plan the run uses is frozen');
  assert.equal(planSha256(p.plan), d.planSha256);
  assert.equal(p.paste, 'PASTE-BODY-1');
  assert.deepEqual(p.ownerRequest, { text: 'pay it', ownerAccountId: OWNER, sessionId: e.planCalls[0]?.req.sessionId });
  assert.ok(p.taskSig instanceof Uint8Array);
  assert.equal(p.taskSig.length, 64);
  assert.ok(p.taskSig.every((b) => b === 7));
  assert.equal(p.deps, e.deps.agentDeps);
  assert.equal(e.planCalls.length, 1, 'no re-plan after the confirmation');
  assert.equal(e.planCalls[0]?.req.text.includes('PASTE-BODY-1'), false, 'the paste never reaches the planner');
});

test('confirm: a plan hash that differs by one hex digit is 409 and starts nothing', async () => {
  const e = await setup();
  const d = await e.draft();
  const last = d.planSha256.endsWith('0') ? '1' : '0';
  const res = await e.confirm(d.draftId, e.taskOf(d, { plan_sha256: d.planSha256.slice(0, 63) + last }));
  assert.equal(res.status, 409);
  assert.equal((await body(res)).error, 'plan hash mismatch');
  assert.equal(e.runCalls.length, 0);
  assert.equal(e.store.get(d.draftId)?.state, 'planned');
  assert.equal((await e.confirm(d.draftId, e.taskOf(d))).status, 202, 'the draft is still confirmable with the right task');
});

test('confirm: confirming twice is 409 the second time and runs once', async () => {
  const e = await setup();
  const g = gateOf();
  e.script.gate = g.gate;
  const d = await e.draft();
  assert.equal((await e.confirm(d.draftId, e.taskOf(d))).status, 202);
  const second = await e.confirm(d.draftId, e.taskOf(d));
  assert.equal(second.status, 409);
  assert.equal((await body(second)).error, 'wrong state');
  g.open();
  assert.equal(await e.settle(d.draftId), 'done');
  const third = await e.confirm(d.draftId, e.taskOf(d));
  assert.equal(third.status, 409);
  assert.equal((await body(third)).error, 'needs a new task');
  assert.equal(e.runCalls.length, 1);
});

test('confirm: another agent, contract, an expired task and a wrong max_actions are 409 with their text', async () => {
  const e = await setup();
  const d = await e.draft();
  const cases: [Partial<OwnerTask>, string][] = [
    [{ agent_id: 'other.test.near' }, 'wrong agent'],
    [{ contract_id: 'other.test.near' }, 'wrong contract'],
    [{ expires_ms: NOW }, 'task expired'],
    [{ expires_ms: NOW - 1 }, 'task expired'],
    [{ max_actions: maxActionsFor(d.plan) + 1 }, 'max_actions differs from the plan'],
  ];
  for (const [over, text] of cases) {
    const res = await e.confirm(d.draftId, e.taskOf(d, over));
    assert.equal(res.status, 409, text);
    assert.equal((await body(res)).error, text);
  }
  assert.equal(e.runCalls.length, 0);
  assert.equal(e.store.get(d.draftId)?.state, 'planned');
  assert.equal((await e.confirm(d.draftId, e.taskOf(d, { expires_ms: NOW + 1 }))).status, 202, 'one millisecond of life is enough');
});

test('confirm: a task id that was confirmed before is 409 on a second draft', async () => {
  const e = await setup();
  const a = await e.draft();
  const b = await e.draft();
  assert.equal((await e.confirm(a.draftId, e.taskOf(a, { task_id: 'same-id' }))).status, 202);
  const res = await e.confirm(b.draftId, e.taskOf(b, { task_id: 'same-id' }));
  assert.equal(res.status, 409);
  assert.equal((await body(res)).error, 'task id already used');
  assert.equal(e.store.get(b.draftId)?.state, 'planned');
  await e.settle(a.draftId);
  assert.equal(e.runCalls.length, 1);
});

test('confirm: the used task ids survive a restart (a new RunStore over the same directory)', async () => {
  const e = await setup();
  const d = await e.draft();
  assert.equal((await e.confirm(d.draftId, e.taskOf(d, { task_id: 'persisted-id' }))).status, 202);
  await e.settle(d.draftId);
  const after = await setup({}, e.dir);
  const d2 = await after.draft();
  const res = await after.confirm(d2.draftId, after.taskOf(d2, { task_id: 'persisted-id' }));
  assert.equal(res.status, 409);
  assert.equal((await body(res)).error, 'task id already used');
});

test('confirm: a signature that is not base64 or not 64 bytes is 400, so is a bad task, and the draft stays planned', async () => {
  const e = await setup();
  const d = await e.draft();
  const task = e.taskOf(d);
  const sigs = ['not base64 !!', Buffer.alloc(63, 1).toString('base64'), Buffer.alloc(65, 1).toString('base64'), '', SIG.slice(0, 10) + '*' + SIG.slice(11)];
  for (const s of sigs) assert.equal((await e.confirm(d.draftId, task, s)).status, 400, s);
  assert.equal((await e.post(`/tasks/${d.draftId}/confirm`, { task: { ...task, bounds: [] }, taskSig: SIG })).status, 400);
  assert.equal((await e.post(`/tasks/${d.draftId}/confirm`, { task: { ...task, extra: 1 }, taskSig: SIG })).status, 400);
  assert.equal((await e.post(`/tasks/${d.draftId}/confirm`, { task, taskSig: SIG, extra: 1 })).status, 400);
  assert.equal(e.runCalls.length, 0);
  assert.equal(e.store.get(d.draftId)?.state, 'planned');
});

// ---- cancel and terminal states ----
test('cancel before confirm is 200 and aborted, and a confirm after it needs a new task', async () => {
  const e = await setup();
  const d = await e.draft();
  const res = await e.post(`/runs/${d.draftId}/cancel`, {});
  assert.equal(res.status, 200);
  assert.equal(e.store.get(d.draftId)?.state, 'aborted');
  const late = await e.confirm(d.draftId, e.taskOf(d));
  assert.equal(late.status, 409);
  assert.equal((await body(late)).error, 'needs a new task');
  assert.equal((await e.post(`/runs/${d.draftId}/cancel`, {})).status, 409, 'a second cancel is 409');
  assert.equal(e.runCalls.length, 0);
});

test('cancel while running is 409 and the run goes on to done', async () => {
  const e = await setup();
  const g = gateOf();
  e.script.gate = g.gate;
  const d = await e.draft();
  assert.equal((await e.confirm(d.draftId, e.taskOf(d))).status, 202);
  assert.equal(e.store.get(d.draftId)?.state, 'running');
  const res = await e.post(`/runs/${d.draftId}/cancel`, {});
  assert.equal(res.status, 409);
  assert.equal(e.store.get(d.draftId)?.state, 'running');
  g.open();
  assert.equal(await e.settle(d.draftId), 'done');
});

test('a run whose runTask throws ends failed, shows the error and needs a new task', async () => {
  const e = await setup();
  e.script.throws = Object.assign(new Error('the plan does not hash to the plan_sha256 of the task'), { name: 'PlanHashMismatch' });
  const d = await e.draft();
  assert.equal((await e.confirm(d.draftId, e.taskOf(d))).status, 202);
  assert.equal(await e.settle(d.draftId), 'failed');
  const view = await body(await e.get(`/runs/${d.draftId}`));
  assert.equal(view.state, 'failed');
  assert.equal(typeof view.error, 'string');
  assert.ok(String(view.error).length > 0);
  const again = await e.confirm(d.draftId, e.taskOf(d));
  assert.equal(again.status, 409);
  assert.equal((await body(again)).error, 'needs a new task');
  assert.equal(e.runCalls.length, 1);
});

test('a run that ends with a FloodStop event is done, its id is spent, and a new draft with a new task id works', async () => {
  const e = await setup();
  e.script.events = [ev(1), ev(2, 'error', { code: 'FloodStop', reason: 'PendingFull' })];
  const d = await e.draft();
  const task = e.taskOf(d);
  assert.equal((await e.confirm(d.draftId, task)).status, 202);
  assert.equal(await e.settle(d.draftId), 'done');
  const view = await body(await e.get(`/runs/${d.draftId}`));
  assert.equal(view.state, 'done');
  assert.equal(view.error, null, 'an error event inside the stream does not change the state');
  const again = await e.confirm(d.draftId, e.taskOf(d));
  assert.equal(again.status, 409);
  assert.equal((await body(again)).error, 'needs a new task');
  const d2 = await e.draft();
  assert.equal((await e.confirm(d2.draftId, task)).status, 409, 'the spent task id is refused on a fresh draft');
  assert.equal((await e.confirm(d2.draftId, e.taskOf(d2))).status, 202);
});

// ---- immutability and ownership ----
test('the stored plan is a frozen copy: mutating what the planner returned changes nothing', async () => {
  const e = await setup();
  const mutable = JSON.parse(JSON.stringify(e.plan)) as CheckedPlan;
  e.state.plan = mutable;
  const d = await e.draft();
  const hash = d.planSha256;
  const first = mutable[0] as unknown as Record<string, unknown>;
  first.call = 'send_money';
  (mutable as unknown[]).push({ action: 'transfer' });
  assert.equal((await e.confirm(d.draftId, e.taskOf(d))).status, 202);
  await e.settle(d.draftId);
  const p = e.runCalls[0];
  assert.ok(p !== undefined);
  assert.equal(planSha256(p.plan), hash);
  assert.deepEqual(p.plan, e.plan);
  assert.ok(Object.isFrozen(p.plan));
  assert.ok(Object.isFrozen(p.plan[0]));
  assert.throws(() => {
    (p.plan[0] as unknown as Record<string, unknown>).call = 'x';
  }, TypeError);
});

test("another account's run answers 404 on GET, confirm and cancel; an unknown id too", async () => {
  const e = await setup();
  const d = await e.draft();
  const foreign = 'f'.repeat(32);
  e.store.create({ id: foreign, owner: 'someone.test.near', state: 'planned', planSha256: d.planSha256, taskHash: null, events: [], error: null });
  assert.equal((await e.get(`/runs/${foreign}`)).status, 404);
  assert.equal((await e.confirm(foreign, e.taskOf(d))).status, 404);
  assert.equal((await e.post(`/runs/${foreign}/cancel`, {})).status, 404);
  const none = '0'.repeat(32);
  assert.equal((await e.get(`/runs/${none}`)).status, 404);
  assert.equal((await e.confirm(none, e.taskOf(d))).status, 404);
  assert.equal((await e.post(`/runs/${none}/cancel`, {})).status, 404);
  assert.equal(e.store.get(foreign)?.state, 'planned', 'nothing changed');
  assert.equal(e.runCalls.length, 0);
});

test('GET /runs/:id answers the RunView without the owner, the task hash after confirm and the last 300 events', async () => {
  const e = await setup();
  e.script.events = Array.from({ length: 305 }, (_, i) => ev(i));
  const d = await e.draft();
  const planned = await body(await e.get(`/runs/${d.draftId}`));
  assert.deepEqual(Object.keys(planned).sort(), ['error', 'events', 'id', 'planSha256', 'state', 'taskHash']);
  assert.equal(planned.taskHash, null);
  assert.deepEqual(planned.events, []);
  const task = e.taskOf(d);
  await e.confirm(d.draftId, task);
  await e.settle(d.draftId);
  const view = await body(await e.get(`/runs/${d.draftId}`));
  assert.equal(view.id, d.draftId);
  assert.equal(view.state, 'done');
  assert.equal(view.planSha256, d.planSha256);
  assert.equal(view.taskHash, taskHash(task));
  const events = view.events as TraceEvent[];
  assert.equal(events.length, 300);
  assert.equal(events[0]?.data.n, 5);
  assert.equal(events[299]?.data.n, 304);
  assert.equal(e.store.get(d.draftId)?.events.length, 305, 'the store keeps all of them');
});

// ---- persistence ----
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

test('persistence: the run file holds state done, the hash and the events, no .tmp remains, the paste is in no file', async () => {
  const e = await setup();
  const d = await e.draft('pay it', 'PASTE-SECRET-TEXT-9');
  await e.confirm(d.draftId, e.taskOf(d));
  assert.equal(await e.settle(d.draftId), 'done');
  const file = join(e.dir, 'runs', `${d.draftId}.json`);
  const rec = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(rec.state, 'done');
  assert.equal(rec.planSha256, d.planSha256);
  assert.deepEqual(rec.events, [ev(1), ev(2)]);
  const files = filesUnder(e.dir);
  assert.ok(files.length >= 1);
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp') || f.includes('.tmp')), []);
  for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes('PASTE-SECRET-TEXT-9'), f);
});

test('persistence: a failed run is written too, with its error', async () => {
  const e = await setup();
  e.script.throws = new Error('boom');
  const d = await e.draft();
  await e.confirm(d.draftId, e.taskOf(d));
  assert.equal(await e.settle(d.draftId), 'failed');
  const rec = JSON.parse(readFileSync(join(e.dir, 'runs', `${d.draftId}.json`), 'utf8')) as Record<string, unknown>;
  assert.equal(rec.state, 'failed');
  assert.equal(typeof rec.error, 'string');
});

// ---- SSE through the store ----
test('SSE: the run store replays the stored events, then the live ones in order, then ends', async () => {
  const e = await setup();
  const g = gateOf();
  e.script.gate = g.gate;
  const d = await e.draft();
  await e.confirm(d.draftId, e.taskOf(d));
  for (let i = 0; i < 20 && (e.store.get(d.draftId)?.events.length ?? 0) < 1; i++) await new Promise((r) => setImmediate(r));
  const res = await e.get(`/runs/${d.draftId}/events`);
  assert.equal(res.status, 200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  const readUntil = async (needle: string): Promise<void> => {
    while (!text.includes(needle)) {
      const { done, value } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  };
  await readUntil('"n":1');
  assert.ok(text.includes('id: 0'));
  assert.ok(!text.includes('"n":2'), 'the second event has not happened yet');
  g.open();
  await readUntil('event: end');
  const messages = text.split('\n\n').filter((m) => m.includes('event: trace'));
  assert.deepEqual(
    messages.map((m) => (JSON.parse(m.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? 'null') as TraceEvent).data.n),
    [1, 2],
  );
  assert.ok(text.includes('event: end'));
  assert.ok(text.includes('"state":"done"'));
  const closed = await reader.read();
  assert.equal(closed.done, true, 'the stream closes after end');
});

test('SSE: without a session the events route is 401', async () => {
  const e = await setup();
  const d = await e.draft();
  assert.equal((await e.get(`/runs/${d.draftId}/events`, null)).status, 401);
});

test('RunStore: append and setState reach subscribers and stateOf, and an unknown run is null', async () => {
  const e = await setup();
  const s = e.store;
  assert.equal(s.replay('x'), null);
  assert.equal(s.stateOf('x'), null);
  s.create({ id: 'r1', owner: OWNER, state: 'running', planSha256: 'a'.repeat(64), taskHash: null, events: [], error: null });
  const seen: number[] = [];
  const off = s.subscribe('r1', (x) => seen.push(x.t));
  s.append('r1', { t: 1, kind: 'call', data: {} });
  off();
  s.append('r1', { t: 2, kind: 'call', data: {} });
  assert.deepEqual(seen, [1]);
  assert.equal(s.replay('r1')?.length, 2);
  s.setState('r1', 'failed', 'x');
  assert.equal(s.stateOf('r1'), 'failed');
  assert.equal(s.get('r1')?.error, 'x');
});

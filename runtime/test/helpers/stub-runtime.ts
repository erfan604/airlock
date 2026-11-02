// Stub parts for the composition root (AIR-169) and `runStubTask`: start `startRuntime` in replay mode on the sandbox contract id with a
// scripted chain, planner and extractor, run one task over HTTP (draft, confirm, poll) and hand back the run's events and the requests the
// chain stub received. AIR-127's wiring test reuses it instead of copying this setup.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maxActionsFor } from '../../src/analyze/index.ts';
import type { AssetEntryViewJson } from '../../src/analyze/index.ts';
import { requestId } from '../../src/chain/ids.ts';
import type { BatchResult } from '../../src/chain/types.ts';
import { checkPlan, planSha256 } from '../../src/dsl/index.ts';
import type { ActionRequest, BookRows, CheckedPlan, OwnerTask } from '../../src/dsl/index.ts';
import type { TraceEvent } from '../../src/interpreter/trace.ts';
import { startRuntime } from '../../src/server/main.ts';
import type { RunningRuntime, RuntimeChain, RuntimeParts } from '../../src/server/main.ts';
import { EMPTY_WORLD } from '../../src/tools/index.ts';
import type { World } from '../../src/tools/index.ts';
import { vectorTask } from '../vectors.helpers.ts';
import { registry } from './analyze-ctx.ts';
import { stubExtract } from './interp.ts';

export const NOW = 1_800_000_000_000;
export const STUB_CONTRACT = 'policy.test.near';
export const STUB_AGENT = 'agent.test.near';
export const STUB_OWNER = 'owner.test.near';
const SIG = Buffer.alloc(64).toString('base64');

/** The environment of a replay server on the sandbox contract id; port 0 and a fresh data directory per call. */
export function stubEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    AIRLOCK_MODE: 'replay',
    LLM_MODE: 'replay',
    NEAR_NETWORK: 'testnet',
    OWNER_ACCOUNT_ID: STUB_OWNER,
    POLICY_CONTRACT_ID: STUB_CONTRACT,
    AGENT_ACCOUNT_ID: STUB_AGENT,
    AIRLOCK_PORT: '0',
    AIRLOCK_DATA_DIR: mkdtempSync(join(tmpdir(), 'air169-')),
    ...over,
  };
}

const bookRows = (pairs: ReadonlyArray<readonly [string, string]>): BookRows =>
  pairs.map(([key, label]) => [key, { cap: null, daily_untrusted_budget: '0', daily_limit: '1000', label }] as const);

/** The AIR-180 fixture registry in the JSON form the contract's list_assets answers. */
export function assetRows(): ReadonlyArray<readonly [string, AssetEntryViewJson]> {
  return [...registry()].map(
    ([id, e]) =>
      [
        id,
        {
          symbol: e.symbol,
          decimals: e.decimals,
          hard_cap: e.hardCap.toString(),
          daily_cap: e.dailyCap.toString(),
          max_fee_per_gas: e.maxFeePerGas.toString(),
          max_gas: e.maxGas.toString(),
          quick_task_cap: e.quickTaskCap.toString(),
          path: e.path,
        },
      ] as const,
  );
}

export interface StubChain {
  chain: RuntimeChain;
  /** every request of every submitBatch call, in order */
  submitted: ActionRequest[];
  calls: { getBook: number; listAssets: number };
  /** the rows get_book answers; a test replaces them */
  book: { rows: BookRows; failWith: Error | null };
}

/** A chain that serves the fixture book and registry and allows every request it is asked to submit. */
export function stubChain(): StubChain {
  const stub: StubChain = {
    chain: undefined as unknown as RuntimeChain,
    submitted: [],
    calls: { getBook: 0, listAssets: 0 },
    book: { rows: bookRows([['near:accountant.testnet', 'accountant'], ['near:landlord.testnet', 'landlord']]), failWith: null },
  };
  stub.chain = {
    async getBook() {
      stub.calls.getBook += 1;
      if (stub.book.failWith !== null) throw stub.book.failWith;
      return stub.book.rows;
    },
    async listAssets() {
      stub.calls.listAssets += 1;
      return assetRows();
    },
    async getRequest() {
      return null;
    },
    async waitSigned() {
      throw new Error('waitSigned is not scripted');
    },
    async submitBatch(reqs: ActionRequest[], task: OwnerTask): Promise<BatchResult> {
      stub.submitted.push(...reqs);
      return {
        taskHash: 'f'.repeat(64),
        outcomes: reqs.map((r) => ({ request_id: requestId(task, r.action_index), outcome: 'allowed' as const, reason: null, pending_id: null })),
        txHash: 'tx-stub',
        events: [],
        recovered: false,
        views: [],
      };
    },
  };
  return stub;
}

export const stubWorld = (over: Partial<World> = {}): World => ({
  ...EMPTY_WORLD,
  inbox: [{ id: 'm1', from: 'billing@accountant-firm.co', subject: 'Invoice', body: 'Please pay 4.2 NEAR', attachments: [] }],
  ...over,
});

/** The parts of the stub runtime; `plan` is what the stub planner returns. */
export function stubParts(stub: StubChain, o: { plan?: unknown; world?: Partial<World>; extractOut?: Record<string, unknown>; hooks?: RuntimeParts['hooks']; log?: (line: string) => void } = {}): Partial<RuntimeParts> {
  const parts: Partial<RuntimeParts> = {
    chain: stub.chain,
    extract: stubExtract(o.extractOut ?? { amount: '4.2', vendor: 'accountant' }).extract,
    world: stubWorld(o.world),
    accessKeys: async () => null,
    clock: () => NOW,
    log: o.log ?? (() => undefined),
  };
  if (o.plan !== undefined) {
    const checked: CheckedPlan = checkPlan(o.plan);
    parts.planTask = async () => ({ plan: checked, planSha256: planSha256(checked) });
  }
  if (o.hooks !== undefined) parts.hooks = o.hooks;
  return parts;
}

/** A session cookie from GET /session of a replay server. */
export async function sessionCookie(url: string): Promise<string> {
  const res = await fetch(`${url}/session`);
  const match = /airlock_session=[0-9a-f]{64}/.exec(res.headers.get('set-cookie') ?? '');
  if (res.headers.get('x-airlock-mode') !== 'replay' || match === null) throw new Error('the server did not issue a replay session');
  return match[0];
}

let taskNo = 0;

/** POST /tasks, POST /tasks/:id/confirm and GET /runs/:id until the run ends: the run's state and events. */
export async function driveTask(url: string, o: { ownerText: string; paste?: string | null }): Promise<{ runId: string; state: string; events: TraceEvent[] }> {
  const cookie = await sessionCookie(url);
  const headers = { 'content-type': 'application/json', cookie };
  const body = o.paste === undefined || o.paste === null ? { instruction: o.ownerText } : { instruction: o.ownerText, paste: o.paste };
  const draftRes = await fetch(`${url}/tasks`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (draftRes.status !== 200) throw new Error(`POST /tasks answered ${draftRes.status}`);
  const draft = (await draftRes.json()) as { draftId: string; plan: CheckedPlan; planSha256: string };
  const task: OwnerTask = {
    ...vectorTask(),
    task_id: `stub-task-${++taskNo}-${Date.now().toString(16)}`,
    contract_id: STUB_CONTRACT,
    agent_id: STUB_AGENT,
    plan_sha256: draft.planSha256,
    expires_ms: NOW + 3_600_000,
    max_actions: maxActionsFor(draft.plan),
  };
  const confirmRes = await fetch(`${url}/tasks/${draft.draftId}/confirm`, { method: 'POST', headers, body: JSON.stringify({ task, taskSig: SIG }) });
  if (confirmRes.status !== 202) throw new Error(`confirm answered ${confirmRes.status}`);
  for (let i = 0; i < 500; i++) {
    const view = (await (await fetch(`${url}/runs/${draft.draftId}`, { headers: { cookie } })).json()) as { state: string; events: TraceEvent[] };
    if (view.state === 'done' || view.state === 'failed') return { runId: draft.draftId, state: view.state, events: view.events };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the run did not end');
}

export async function runStubTask(o: {
  plan: unknown;
  ownerText: string;
  paste?: string | null;
  world?: Partial<World>;
  extractOut?: Record<string, unknown>;
  hooks?: RuntimeParts['hooks'];
}): Promise<{ events: TraceEvent[]; submitted: ActionRequest[] }> {
  const stub = stubChain();
  const parts = stubParts(stub, { plan: o.plan, ...(o.world === undefined ? {} : { world: o.world }), ...(o.extractOut === undefined ? {} : { extractOut: o.extractOut }), ...(o.hooks === undefined ? {} : { hooks: o.hooks }) });
  const runtime: RunningRuntime = await startRuntime(stubEnv(), parts);
  try {
    const out = await driveTask(runtime.url, o.paste === undefined ? { ownerText: o.ownerText } : { ownerText: o.ownerText, paste: o.paste });
    return { events: out.events, submitted: stub.submitted };
  } finally {
    await runtime.close();
  }
}

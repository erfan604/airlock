// The gate path of the bench (AIR-277): what `expected_airlock` is asserted against, and what assume-compromise (AIR-222) plays. The owner's
// task is built from the case's reference plan exactly as the product builds it; the plan that then runs (the reference itself, or the
// attacker's gate plan) goes through the labelled interpreter with scripted extraction and fixture tools, and each proposed payment is
// submitted to the verdict CLI under that task. It does not call `runTask`: its plan-hash check is what a compromised runtime does not run.
// Every `now` and `now_ms` here comes from BENCH_T0_MS or the seam, never from a clock.
import { createHash } from 'node:crypto';
import { analyzePlan } from '@airlock/runtime/analyze';
import { checkPlan, labelsToBits, resolveAlias } from '@airlock/runtime/dsl';
import type { ActionRequest, OwnerTask } from '@airlock/runtime/dsl';
import { defaultToolArgPolicy, run } from '@airlock/runtime/interpreter';
import type { AbortCode, Book, Extractor, Grounder, Proposed, ToolArgPolicy, TraceEvent } from '@airlock/runtime/interpreter';
import { fixtureTools } from '@airlock/runtime/tools';
import { SimWorld, classify } from '../oracles/index.ts';
import { benchAssets } from './assets.ts';
import { VerdictCliBackend } from './backend.ts';
import type { GateBackend, PaymentClassifier } from './backend.ts';
import { bookRowsOf, worldOfCase } from './cases.ts';
import type { Case, Extraction, RawGateRequest } from './cases.ts';
import { BENCH_T0_MS, analyzeCtxFor, benchTask, cliSetupFor } from './task.ts';
import type { PaymentFact } from './types.ts';

/** `NO_TASK`: the analyzer refused the reference plan. `ABORTED`: the interpreter aborted the run (`abort` is its code), so nothing was submitted. */
export interface GateResult {
  status: 'DONE' | 'NO_TASK' | 'ABORTED';
  abort?: AbortCode;
  payments: PaymentFact[];
}

/** The hooks the server runs; the default is no grounder and `defaultToolArgPolicy`, which is what `check-cases` uses. */
export type GateHooks = { ground?: Grounder; toolArgPolicy?: ToolArgPolicy };

/**
 * The seams AIR-222 needs; every field is optional. `backend` is an injected backend the caller owns (`gatePath` neither spawns nor closes it,
 * and each call starts a new session on it with `begin`), by default a VerdictCliBackend that `gatePath` creates and closes. `world` is the
 * SimWorld that `begin` attaches (an injected one keeps accumulating `executed` across calls), by default one built from `c.world.balances`.
 * `nowMs` is the clock of the whole path: the `now` of `run` and the `now_ms` of every submit, by default BENCH_T0_MS.
 */
export type GateSeam = { backend?: GateBackend; world?: SimWorld; nowMs?: number };

/** An Extractor that returns the next object of `list` on each call, and null for every schema key once the list is exhausted. */
export function scriptedExtract(list: Extraction): Extractor {
  let next = 0;
  return ({ schema }) => {
    const item = list[next];
    next += 1;
    return Promise.resolve(item !== undefined ? { ...item } : Object.fromEntries(Object.keys(schema).map((key) => [key, null])));
  };
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The sha256 of `JSON.stringify` of a run's events as `{ kind, data }` pairs, without the clock (AIR-164 step 4). */
export function traceDigest(trace: readonly TraceEvent[]): string {
  return sha256Hex(JSON.stringify(trace.map((e) => ({ kind: e.kind, data: e.data }))));
}

const EMPTY_TRACE_DIGEST = sha256Hex('[]');

/**
 * One proposed payment as the request the runtime submits (the field mapping of AIR-164 step 4, written here because this ticket does not
 * depend on it): the labels are the bits of the three label lists, `evm` is null (the Floor is the NEAR lane), and the hints carry the task's
 * plan hash and the digest of the run's trace (default: the digest of an empty trace).
 */
export function proposalToRequest(p: Proposed, task: OwnerTask, index: number, digest: string = EMPTY_TRACE_DIGEST): ActionRequest {
  return {
    task_id: task.task_id,
    action_index: index,
    asset: p.asset,
    payee: p.payee,
    amount: p.amount.toString(),
    labels: { recipient: labelsToBits(p.recipientLabels), amount: labelsToBits(p.amountLabels), pc: labelsToBits(p.pc) },
    evm: null,
    hints: { plan_hash: task.plan_sha256, trace_digest: digest },
  };
}

// a raw entry is mapped the same way; its label names become bits and a missing `evm` is null
function rawToRequest(r: RawGateRequest, task: OwnerTask, index: number): ActionRequest {
  return {
    task_id: task.task_id,
    action_index: index,
    asset: r.asset,
    payee: r.payee,
    amount: r.amount,
    labels: { recipient: labelsToBits(r.labels.recipient), amount: labelsToBits(r.labels.amount), pc: labelsToBits(r.labels.pc) },
    evm: r.evm ?? null,
    hints: { plan_hash: task.plan_sha256, trace_digest: EMPTY_TRACE_DIGEST },
  };
}

// a raw entry is the attack itself: a goal can name only an asset of assets.json, so classify could never mark an unregistered asset
const EVERY_ENTRY_IS_THE_ATTACK: PaymentClassifier = () => ({ attacker: true, legit: false });

const BATCH = 3;
const NO_SIGNATURE = new Uint8Array(0);

/**
 * Builds the owner's task from `c.reference.plan` (`NO_TASK` when the analysis has errors), begins a session on the backend with the CLI
 * setup of `config`, runs the `which` path (`reference`: the reference plan and its extraction; `gate`: the attacker's plan and extraction,
 * or its raw requests) and submits what it proposes in chunks of three. A1 and A2 share plan, task and proposals; only the payee cap in the
 * CLI setup differs. Asking for the `gate` path of a case that has none is an error.
 */
export async function gatePath(c: Case, config: 'A1' | 'A2', which: 'reference' | 'gate', hooks: GateHooks = {}, seam: GateSeam = {}): Promise<GateResult> {
  const assets = benchAssets();
  const plan = checkPlan(c.reference.plan);
  const analysis = analyzePlan(plan, analyzeCtxFor(c));
  if (analysis.errors.length > 0) return { status: 'NO_TASK', payments: [] };
  const task = benchTask(c, 0, plan, analysis);

  const source = which === 'reference' ? { plan: c.reference.plan, extract: c.reference.extract ?? [] } : c.gate;
  if (source === null) throw new Error(`case ${c.id} has no gate path`);

  const nowMs = seam.nowMs ?? BENCH_T0_MS;
  const decimalsOf = (asset: string): number => {
    const d = assets.decimalsOf(asset);
    if (d === undefined) throw new Error('asset has no decimals in assets.json');
    return d;
  };
  const world = seam.world ?? new SimWorld({ balances: c.world.balances, decimalsOf });
  const backend = seam.backend ?? new VerdictCliBackend();
  try {
    const classifier: PaymentClassifier = 'raw' in source ? EVERY_ENTRY_IS_THE_ATTACK : (p) => classify(c.attacker_goal, c.legit, p, { decimalsOf });
    backend.begin(cliSetupFor(c, config, task), world, classifier);

    let requests: ActionRequest[];
    if ('raw' in source) {
      requests = source.raw.map((r, i) => rawToRequest(r, task, i));
    } else {
      const rows = bookRowsOf(c.world);
      const book: Book = { resolve: (alias) => resolveAlias(rows, alias) };
      const result = await run(checkPlan(source.plan), {
        tools: fixtureTools(worldOfCase(c)),
        extract: scriptedExtract(source.extract),
        book,
        decimalsOf: assets.decimalsOf,
        ownerText: c.request,
        ground: hooks.ground,
        toolArgPolicy: hooks.toolArgPolicy ?? defaultToolArgPolicy,
        now: () => nowMs,
      });
      if (!result.ok) return { status: 'ABORTED', abort: result.cause.code, payments: [] };
      const digest = traceDigest(result.trace);
      requests = result.proposed.map((p, i) => proposalToRequest(p, task, i, digest));
    }
    for (let at = 0; at < requests.length; at += BATCH) {
      await backend.submitBatch(requests.slice(at, at + BATCH), task, NO_SIGNATURE, { nowMs });
    }
    return { status: 'DONE', payments: backend.payments() };
  } finally {
    if (seam.backend === undefined) await backend.close();
  }
}

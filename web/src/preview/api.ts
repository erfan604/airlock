// The console's two calls to the runtime (AIR-185) and the guard that stands between them (S30, R3-01). The runtime is reached through the
// console's own origin (`base` is the empty string): the console and the runtime are different origins, a cookie is not sent across them and
// the server sends no CORS, so the preview proxy forwards /session, /tasks, /runs and /api. A `base` of the runtime origin would answer 401.
import { toOwnerBounds } from '@airlock/runtime/analyze';
import { checkPlan, planSha256 } from '@airlock/runtime/dsl';
import type { CheckedPlan, OwnerTask } from '@airlock/runtime/dsl';
import type { ChainSnapshot } from '../chain/reads.ts';
import { buildTask, refusal } from './preview.ts';
import type { BuildEnv, BuildOk, Refusal } from './preview.ts';

/** Read leniently on purpose: a response with extra fields is read, not rejected. An honest runtime sends no `bounds` and no `preview`. */
export type RuntimeDraft = { draftId: string; planSha256: string; plan: unknown; extras: { preview?: unknown; bounds?: unknown } };

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`runtime answered ${status}`);
    this.name = 'ApiError';
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status);
  return res.json();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function createDraft(base: string, instruction: string, paste: string | null): Promise<RuntimeDraft> {
  const out = await postJson(`${base}/tasks`, paste === null ? { instruction } : { instruction, paste });
  if (!isRecord(out) || typeof out.draftId !== 'string' || typeof out.planSha256 !== 'string') throw new ApiError(502);
  const { draftId, planSha256: hash, plan, ...rest } = out;
  return { draftId, planSha256: hash, plan, extras: { preview: rest.preview, bounds: rest.bounds } };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function confirmTask(base: string, draftId: string, task: OwnerTask, sig: Uint8Array): Promise<{ runId: string }> {
  const out = await postJson(`${base}/tasks/${encodeURIComponent(draftId)}/confirm`, { task, taskSig: base64(sig) });
  if (!isRecord(out) || typeof out.runId !== 'string') throw new ApiError(502);
  return { runId: out.runId };
}

/** Deep equality of JSON values; key order does not matter. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return a === b;
}

/**
 * The S30 guard. The plan the runtime sent must pass the checker and hash to the hash it sent; the task is built from the console's own
 * derivation; and any `bounds` or `preview` the runtime volunteers must equal that derivation. The build that comes back is the one to sign,
 * so the task id and the salt are drawn once.
 */
export function guardRuntime(draft: RuntimeDraft, snap: ChainSnapshot, env: BuildEnv, instruction: string): Refusal | { ok: true; plan: CheckedPlan; build: BuildOk } {
  let plan: CheckedPlan;
  try {
    plan = checkPlan(draft.plan);
  } catch {
    return refusal('PlanInvalid');
  }
  if (planSha256(plan) !== draft.planSha256) return refusal('PlanHashMismatch');
  const build = buildTask(plan, instruction, snap, env);
  if (!build.ok) return build.refusal;
  const { bounds, preview } = draft.extras;
  if (bounds !== undefined && !sameJson(bounds, toOwnerBounds(build.analysis))) return refusal('RuntimeDiffers');
  if (preview !== undefined && !sameJson(preview, build.analysis.preview.map((l) => l.text))) return refusal('RuntimeDiffers');
  return { ok: true, plan, build };
}

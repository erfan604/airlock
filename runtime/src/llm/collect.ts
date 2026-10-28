// Per-run cost and latency. planTask drops the LlmResult and an extractor returns plain values, so the bench and the tuning
// scripts get cost and latency only through this collector. An AsyncLocalStorage keeps concurrent runs in one process apart.
import { AsyncLocalStorage } from 'node:async_hooks';
import { costOf } from './prices.ts';
import type { LlmResult, Role } from './types.ts';

/** What one settled call reports. The text and the raw body are never copied here, and nothing here claims attestation. */
export interface LlmCall {
  role: Role;
  model: string;
  route: string;
  isStandIn: boolean;
  requestHash: string;
  responseHash: string;
  usage: { prompt: number; completion: number };
  latencyMs: number;
  /** USD as canonical decimal text, '0' when the call needed no new network request */
  costUsd: string;
  /** true for replay, a read-through hit and a single-flight follower: no new network request was made */
  cached: boolean;
}

const store = new AsyncLocalStorage<LlmCall[]>();

/** Runs `fn` and returns its value with the calls made inside it, and only those. A budget guard sums `costUsd` of the calls with `cached === false`. */
export async function collectLlm<T>(fn: () => Promise<T>): Promise<{ value: T; calls: LlmCall[] }> {
  const calls: LlmCall[] = [];
  const value = await store.run(calls, fn);
  return { value, calls };
}

/** Called by the dispatcher after every settled call; a no-op outside collectLlm. */
export function recordCall(role: Role, result: LlmResult, cached: boolean): void {
  const calls = store.getStore();
  if (calls === undefined) return;
  calls.push({
    role,
    model: result.model,
    route: result.route,
    isStandIn: result.isStandIn,
    requestHash: result.requestHash,
    responseHash: result.responseHash,
    usage: { prompt: result.usage.prompt, completion: result.usage.completion },
    latencyMs: result.latencyMs,
    costUsd: cached ? '0' : costOf(result.usage, result.model),
    cached,
  });
}

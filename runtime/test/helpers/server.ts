// Test harness for the server tests (AIR-161): an app over scripted dependencies and an injected clock.
import type { Hono } from 'hono';
import { MemoryEvidenceStore } from '../../src/evidence.ts';
import type { RequestView } from '../../src/chain/types.ts';
import { RpcUnavailable } from '../../src/server/access-keys.ts';
import type { AccessKeyReader } from '../../src/server/access-keys.ts';
import { createApp } from '../../src/server/app.ts';
import type { AppDeps, RunEventSource } from '../../src/server/app.ts';
import vector from '../fixtures/nep413-vector.json' with { type: 'json' };
import { loginWithSeed } from './login.ts';

export const OWNER = 'owner.test.near';
export const CONTRACT = 'policy.test.near';
export const SEED = vector.seedHex;
export const OWNER_KEY = vector.publicKey;

export type KeyAnswer = 'FullAccess' | 'FunctionCall' | null | 'unavailable';

export interface Harness {
  app: Hono;
  deps: AppDeps;
  clock: { now: number };
  /** what the stub reader answers per `<account> <publicKey>`; by default the vector key is a full-access key of the owner */
  keys: Map<string, KeyAnswer>;
  readerCalls: string[];
  chainCalls: string[];
  views: Map<string, RequestView | null>;
  evidence: MemoryEvidenceStore;
}

export function makeApp(over: Partial<AppDeps> = {}): Harness {
  const clock = { now: 1_800_000_000_000 };
  const keys = new Map<string, KeyAnswer>([[`${OWNER} ${OWNER_KEY}`, 'FullAccess']]);
  const readerCalls: string[] = [];
  const chainCalls: string[] = [];
  const views = new Map<string, RequestView | null>();
  const evidence = new MemoryEvidenceStore();
  const accessKeys: AccessKeyReader = async (accountId, publicKey) => {
    readerCalls.push(`${accountId} ${publicKey}`);
    const answer = keys.get(`${accountId} ${publicKey}`) ?? null;
    if (answer === 'unavailable') throw new RpcUnavailable('every rpc url failed');
    return answer === null ? null : { permission: answer };
  };
  const deps: AppDeps = {
    chain: {
      async getRequest(id: string) {
        chainCalls.push(id);
        return views.get(id) ?? null;
      },
    },
    clock: () => clock.now,
    accessKeys,
    evidence,
    ownerAccountId: OWNER,
    contractId: CONTRACT,
    mode: 'live',
    ...over,
  };
  return { app: createApp(deps), deps, clock, keys, readerCalls, chainCalls, views, evidence };
}

/** A real login against a live-mode harness: the cookie header value. */
export async function login(h: Harness, host = 'localhost'): Promise<string> {
  const { res, cookie } = await loginWithSeed(h.app, SEED, OWNER, CONTRACT, host);
  if (res.status !== 200 || cookie === null) throw new Error(`login answered ${res.status}`);
  return cookie;
}

/** A run source of fixed events that tests can append to; counts subscribers. */
export class FakeRuns implements RunEventSource {
  events = new Map<string, import('../../src/interpreter/trace.ts').TraceEvent[]>();
  states = new Map<string, string>();
  subscribers = new Map<string, Set<(e: import('../../src/interpreter/trace.ts').TraceEvent) => void>>();
  replayCalls = 0;

  add(id: string, events: import('../../src/interpreter/trace.ts').TraceEvent[], state = 'running'): void {
    this.events.set(id, [...events]);
    this.states.set(id, state);
  }
  push(id: string, e: import('../../src/interpreter/trace.ts').TraceEvent): void {
    this.events.get(id)?.push(e);
    for (const cb of this.subscribers.get(id) ?? []) cb(e);
  }
  count(id: string): number {
    return this.subscribers.get(id)?.size ?? 0;
  }
  replay(id: string) {
    this.replayCalls += 1;
    const have = this.events.get(id);
    return have === undefined ? null : [...have];
  }
  subscribe(id: string, cb: (e: import('../../src/interpreter/trace.ts').TraceEvent) => void): () => void {
    const set = this.subscribers.get(id) ?? new Set();
    this.subscribers.set(id, set);
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }
  stateOf(id: string): string | null {
    return this.states.get(id) ?? null;
  }
}

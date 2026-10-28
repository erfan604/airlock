// Shared fixtures for the llm tests. Nothing sensitive is typed as a literal: the sentinel key and the em dash are built at
// runtime (README rule 6), and every recordings directory is a fresh mkdtemp directory.
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatBody } from '../src/llm/index.ts';
import type { LlmOpts } from '../src/llm/index.ts';

export const KEY = 'k' + 'x'.repeat(24);
export const EM_DASH = String.fromCharCode(0x2014);

export interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export type Handler = (n: number, call: Captured) => Response | Promise<Response>;

// a fetch the SDK can call: records what reached it, answers from the handler (a throw is a connection error)
export function stubFetch(handler: Handler): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call: Captured = { url, headers: new Headers(init?.headers), body };
    calls.push(call);
    return handler(calls.length - 1, call);
  };
  return { fetch: stub as unknown as typeof fetch, calls };
}

export function ok(text: string, extra: { id?: string; model?: string; usage?: { prompt: number; completion: number } } = {}): Response {
  return new Response(chatBody({ text, ...extra }), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function failure(status: number, message = 'provider says no', headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message, type: 'provider_error', code: status } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'airlock-llm-'));
}

export async function filesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

export function opts(over: Partial<LlmOpts> = {}): LlmOpts {
  return { role: 'planner', model: 'Qwen/Qwen3.8-27B', system: 'S', user: 'Owner request: pay', ...over };
}

// the schema of the pinned hash vector
export const PINNED_SCHEMA = { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false } };

export function pinnedOpts(reasoning?: 'low'): LlmOpts {
  return {
    role: 'planner',
    model: 'Qwen/Qwen3.6-35B-A3B-FP8',
    system: 'S',
    user: 'Owner request: pay',
    jsonSchema: PINNED_SCHEMA,
    params: { temperature: 0.7, seed: 3, ...(reasoning === undefined ? {} : { reasoning }) },
  };
}

export const PINNED_HASH = '44b371c2743ec143c993186927354e4dd4f3673e40b3259c1122544a1672bd71';
export const PINNED_HASH_LOW = '681fd1aa156b3223330a0796e480a1b758759320b2b3b6e5faa7c37745355800';
export const PINNED_CANONICAL =
  '{"model":"Qwen/Qwen3.6-35B-A3B-FP8","params":{"max_tokens":4096,"reasoning":null,"seed":3,"temperature":0.7},"role":"planner","schema":{"items":{"additionalProperties":false,"type":"object"},"maxItems":64,"type":"array"},"system":"S","user":"Owner request: pay"}';

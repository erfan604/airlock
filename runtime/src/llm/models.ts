// The model allowlists and the routes whose output may be called TEE output. The lists are code constants: the
// unauthenticated listing of the provider has no field that says which models run in a TEE.
import { ModelNotAllowed } from './errors.ts';
import type { Role } from './types.ts';

export const TEE_MODELS = ['moonshotai/kimi-k3', 'Qwen/Qwen3.6-35B-A3B-FP8', 'Qwen/Qwen3.8-27B', 'z-ai/glm-5.3-flash'] as const;

/**
 * `openai/gpt-6.1-sol` is a frontier model that is not a TEE model (it is routed outside the enclave): it is allowed for the
 * vanilla role only, to measure how the unprotected agent V0 behaves on a stronger model (bench/results/frontier-v0.json).
 */
export const VANILLA_MODELS = [...TEE_MODELS, 'x-ai/grok-4.7', 'openai/gpt-6.1-sol'] as const;

/** Models whose route rejects a temperature other than its default (HTTP 400 for 0.7): the request leaves `temperature` out. */
export const FIXED_TEMPERATURE: readonly string[] = ['openai/gpt-6.1-sol'];

/**
 * The routes whose output may be called TEE output: the one attested route this client calls. Typed wide on purpose: with
 * `as const`, `.includes(route)` with a string argument does not compile.
 */
export const TEE_ROUTES: readonly string[] = ['nearai'];

/** Every route that is not listed above (Groq, Cloudflare, Gemini, a local model, Claude, Codex, a script) is a stand-in. */
export function isStandInRoute(route: string): boolean {
  return !TEE_ROUTES.includes(route);
}

/**
 * Planner and quarantine accept the TEE models only, vanilla accepts the vanilla list; exact, case-sensitive match. It runs
 * before any file or network access, in every mode. The quickstart's `zai-org/GLM-5.1-FP8` is on no list: it only resolves by
 * alias, and this client sends canonical ids only.
 */
export function assertModelAllowed(role: Role, model: string): void {
  const allowed: readonly string[] = role === 'vanilla' ? VANILLA_MODELS : role === 'planner' || role === 'quarantine' ? TEE_MODELS : [];
  if (typeof model !== 'string' || !allowed.includes(model)) throw new ModelNotAllowed(String(role), String(model));
}

/**
 * The body keys that carry a reasoning effort. Qwen3.6 has no `reasoning_effort` and takes `chat_template_kwargs`; every
 * other model takes `reasoning_effort: 'low'` (GLM flash takes `low`, not `none`). Empty when no effort is asked for.
 */
export function reasoningFields(model: string, reasoning: 'low' | null | undefined): Record<string, unknown> {
  if (reasoning === undefined || reasoning === null) return {};
  if (model === 'Qwen/Qwen3.6-35B-A3B-FP8') return { chat_template_kwargs: { enable_thinking: false } };
  return { reasoning_effort: reasoning };
}

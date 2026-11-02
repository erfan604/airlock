// The planner (AIR-141): the owner's words in, a validated CheckedPlan out. Only `req.text` reaches the model (prompt.ts).
// Imports are limited to planner/, llm/, dsl/ and money/ by test/planner.imports.test.ts. Called only by planTask in agent.ts.
import { PlanRejected, checkPlan, planSha256 } from '../dsl/index.ts';
import type { CheckedPlan } from '../dsl/index.ts';
import { complete, loadModelsConfig } from '../llm/index.ts';
import type { LlmParams, LlmResult } from '../llm/index.ts';
import { PLANNER_MAX_TOKENS, attemptSeed, buildPrompt, providerSchema } from './prompt.ts';
import type { OwnerRequest } from './prompt.ts';

export type { OwnerRequest } from './prompt.ts';
export type PlanOpts = { seed?: number; temperature?: number };

// one surrounding code fence: three backticks, optional json, newline, body, newline, three backticks
const FENCE = /^\s*```(?:json)?\n([\s\S]*)\n```\s*$/;

function parseReply(text: string): unknown {
  const fenced = FENCE.exec(text);
  try {
    return JSON.parse(fenced === null ? text : (fenced[1] ?? ''));
  } catch {
    // the SyntaxError message holds model text and never escapes
    throw new PlanRejected('Malformed', []);
  }
}

export async function plan(
  req: OwnerRequest,
  model: string,
  opts?: PlanOpts,
): Promise<{ plan: CheckedPlan; planSha256: string; llm: LlmResult }> {
  const { system, user } = buildPrompt(req);
  const config = loadModelsConfig();
  const jsonSchema = providerSchema();
  let last: PlanRejected | undefined;
  for (const attempt of [0, 1] as const) {
    const params: LlmParams = {
      temperature: opts?.temperature ?? config.temperature,
      max_tokens: PLANNER_MAX_TOKENS,
    };
    const seed = attemptSeed(opts?.seed, attempt);
    if (seed !== undefined) params.seed = seed;
    if (config.reasoning === 'low') params.reasoning = 'low';
    // any error from complete other than a PlanRejected below propagates at once: the client already retried
    const llm = await complete({ role: 'planner', model, system, user, jsonSchema, params });
    try {
      const checked = checkPlan(parseReply(llm.text));
      return { plan: checked, planSha256: planSha256(checked), llm };
    } catch (e) {
      // the second sample carries the same system and user: no error code, path or plan text is fed back (SPEC 14b RT-04)
      if (!(e instanceof PlanRejected)) throw e;
      last = e;
    }
  }
  throw last ?? new PlanRejected('Malformed', []);
}

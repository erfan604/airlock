// The one loader of runtime/config/models.json (AIR-144): planner, quarantine and vanilla model ids, temperature, reasoning
// effort and seed base. The runtime and the bench read the choice only through loadModelsConfig.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TEE_MODELS, VANILLA_MODELS } from './models.ts';

/** A config violation. The message names the key and never a value. */
export class ModelsConfigError extends Error {
  constructor(message: string) {
    super(`ModelsConfigError: ${message}`);
    this.name = 'ModelsConfigError';
  }
}

const teeId = z.string().refine((id) => (TEE_MODELS as readonly string[]).includes(id));
const hash = z.string().regex(/^[0-9a-f]{64}$/);

const Schema = z
  .strictObject({
    planner: teeId,
    quarantine: teeId,
    vanilla: z.array(z.string().refine((id) => (VANILLA_MODELS as readonly string[]).includes(id))).min(1),
    temperature: z.number().gt(0).lte(1),
    reasoning: z.enum(['default', 'low']),
    seed: z.number().int().min(0).max(1_000_000_000),
    decided_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    evidence: z.strictObject({
      results_sha256: hash,
      decision_sha256: hash,
      spend_usd: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
    }),
  })
  .refine((c) => c.vanilla.includes(c.planner), { path: ['vanilla'] });

export type ModelsConfig = z.infer<typeof Schema>;

const DEFAULT_PATH = fileURLToPath(new URL('../../config/models.json', import.meta.url));
const memo = new Map<string, ModelsConfig>();

/** Path order: argument, AIRLOCK_MODELS_CONFIG (read at call time), the file next to the runtime. Memoized per path. */
export function loadModelsConfig(path?: string): ModelsConfig {
  const resolved = path ?? process.env.AIRLOCK_MODELS_CONFIG ?? DEFAULT_PATH;
  const hit = memo.get(resolved);
  if (hit !== undefined) return hit;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    throw new ModelsConfigError('the models config file cannot be read as JSON');
  }
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => (i.path.length > 0 ? i.path.join('.') : 'top level')))];
    throw new ModelsConfigError(`invalid key: ${keys.join(', ')}`);
  }
  memo.set(resolved, parsed.data);
  return parsed.data;
}

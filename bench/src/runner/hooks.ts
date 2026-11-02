// The hooks a bench run passes to the interpreter (AIR-220): exactly the ones the server runs. `none` is no grounder and the default tool
// argument policy; `product` adds the grounder of `@airlock/runtime/interpreter` (AIR-127 re-exports it there, and this module compiles
// without it). The records say which was used, because literal grounding raises the escalation rate.
import { defaultToolArgPolicy } from '@airlock/runtime/interpreter';
import type { Grounder, ToolArgPolicy } from '@airlock/runtime/interpreter';

export type HooksName = 'none' | 'product';

export interface Hooks {
  ground?: Grounder;
  toolArgPolicy: ToolArgPolicy;
}

export class HooksProductUnavailable extends Error {
  constructor() {
    super('HooksProductUnavailable');
    this.name = 'HooksProductUnavailable';
  }
}

export async function resolveHooks(name: HooksName): Promise<Hooks> {
  if (name === 'none') return { ground: undefined, toolArgPolicy: defaultToolArgPolicy };
  const mod = (await import('@airlock/runtime/interpreter')) as Record<string, unknown>;
  const ground = mod['grounder'];
  if (typeof ground !== 'function') throw new HooksProductUnavailable();
  return { ground: ground as Grounder, toolArgPolicy: defaultToolArgPolicy };
}

// The test seam: replaces the implementation behind the exported `complete`. The dispatcher still runs the allowlist first and
// still notifies collectors. Production code never calls setLlmOverride (acceptance check 7 greps for it outside llm/).
import type { Complete } from './types.ts';

let override: Complete | null = null;

export function setLlmOverride(fn: Complete | null): void {
  override = fn;
}

export function getLlmOverride(): Complete | null {
  return override;
}

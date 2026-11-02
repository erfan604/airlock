// AIR-163 type test: the draft response has no bounds and no preview. This file compiles only because the errors on the marked lines
// are expected. It is never run.
import type { DraftResponse } from '../src/server/tasks.ts';

export function typetest(d: DraftResponse): string {
  // @ts-expect-error the runtime never answers bounds
  const bounds = d.bounds;
  // @ts-expect-error the runtime never answers a preview
  const preview = d.preview;
  return `${String(bounds)}${String(preview)}${d.draftId}${d.planSha256}`;
}

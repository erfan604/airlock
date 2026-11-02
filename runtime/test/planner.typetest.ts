// AIR-141 type test: the planner takes an OwnerRequest and nothing wider as an object literal. This file compiles only because
// the error on the marked line is expected. It is never run.
import { plan } from '../src/planner/planner.ts';

export async function typetest(): Promise<void> {
  // @ts-expect-error toolOutput is not a field of OwnerRequest
  await plan({ text: 't', ownerAccountId: 'a', sessionId: 's', toolOutput: 'x' }, 'z-ai/glm-5.3-flash');
}

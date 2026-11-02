// Request ids (AIR-063): the contract derives `<64 lowercase hex task hash>:<decimal action index>`; the client derives the same text
// locally so it can read a request back before it ever resubmits. Never random: the same task and index always give the same id.
import { taskHash } from '../dsl/index.ts';
import type { OwnerTask } from '../dsl/index.ts';

/** 66 characters for indexes 0 to 9, 67 for 10 to 99, 68 for 100 to 255. A non-integer or an index outside 0 to 255 is a RangeError. */
export function requestId(task: OwnerTask, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new RangeError('action index must be an integer from 0 to 255');
  return `${taskHash(task)}:${index}`;
}

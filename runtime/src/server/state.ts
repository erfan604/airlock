// The life of one task (AIR-163): a pure reducer over exactly the table below. Anything else returns undefined and the route answers 409.
// done, failed and aborted are terminal: a task is used once, the only way forward is a new draft, a new confirmation and a new task id.
export const RUN_STATES = ['draft', 'planned', 'confirmed', 'running', 'done', 'failed', 'aborted'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_EVENTS = ['PLANNED', 'PLAN_FAILED', 'CONFIRM', 'CANCEL', 'START', 'FINISH', 'FAIL'] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

const TABLE: ReadonlyMap<string, RunState> = new Map<string, RunState>([
  ['draft PLANNED', 'planned'],
  ['draft PLAN_FAILED', 'failed'],
  ['planned CONFIRM', 'confirmed'],
  ['planned CANCEL', 'aborted'],
  ['confirmed START', 'running'],
  ['confirmed CANCEL', 'aborted'],
  ['running FINISH', 'done'],
  ['running FAIL', 'failed'],
]);

export function reduce(state: RunState, event: RunEvent): RunState | undefined {
  return TABLE.get(`${state} ${event}`);
}

export const isTerminal = (state: RunState): boolean => state === 'done' || state === 'failed' || state === 'aborted';

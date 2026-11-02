// The trace of a run. `t` is the injected clock (`deps.now?.() ?? 0`): the interpreter never reads a clock itself, so a run is
// deterministic. `step` in an event is the JSON path of the plan node, for example `[2, 'then', 0]`. This directory emits `call`,
// `extract`, `lookup`, `calc`, `branch`, `proposed` and, when a run aborts, `error`; the kinds `plan`, `submitted`, `verdict`,
// `signed` and `broadcast` belong to the orchestrator (AIR-164), and `say` is the answer of a read-only run, appended by the server (AIR-293).
export type TraceKind = 'plan' | 'call' | 'extract' | 'lookup' | 'calc' | 'branch' | 'proposed' | 'submitted' | 'verdict' | 'signed' | 'broadcast' | 'error' | 'say';

export interface TraceEvent {
  t: number;
  kind: TraceKind;
  data: Record<string, unknown>;
}

// `say` is the answer of a read-only run (AIR-293, D21).
// The wire form of a run's trace event as the console reads it (AIR-184). It repeats the runtime's `TraceEvent` because the console must not
// import the interpreter package; the `data` shapes are AIR-121's and AIR-164's. `parseTraceEvent` is the only way a message becomes an event:
// anything that is not exactly this shape is null and the store counts it as malformed, so nothing odd is ever thrown or rendered.

export const TRACE_KINDS = ['plan', 'call', 'extract', 'lookup', 'calc', 'branch', 'proposed', 'submitted', 'verdict', 'signed', 'broadcast', 'error', 'say'] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export interface TraceEventWire {
  t: number;
  kind: TraceKind;
  data: Record<string, unknown>;
}

/** The 11 calc operations of the plan language (`CALC_OPS` of the runtime's dsl/tools.ts; a test pins the two lists together). */
export const CALC_OP_NAMES = ['min', 'max', 'sum', 'sub', 'mul', 'div', 'gt', 'lt', 'ge', 'le', 'eq'] as const;

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isKind = (v: unknown): v is TraceKind => typeof v === 'string' && (TRACE_KINDS as readonly string[]).includes(v);

/** `JSON.parse` in a try; a plain object, `kind` in the closed list, `t` a finite number, `data` a plain object. Anything else is null. */
export function parseTraceEvent(json: string): TraceEventWire | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(v)) return null;
  const { t, kind, data } = v;
  if (typeof t !== 'number' || !Number.isFinite(t) || !isKind(kind) || !isPlainObject(data)) return null;
  return { t, kind, data };
}

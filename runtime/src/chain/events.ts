// Decoding the contract's event log lines (docs/events.md). A line is `EVENT_JSON:` plus one JSON object. Anything of ours that does not
// fit the closed list or its payload schema surfaces as an `unknown_event` carrying the first 4,096 characters of the line: it is never
// thrown and never skipped, so a reader cannot miss an event it does not understand. A line that is not an event at all is skipped.
import { EVENT_PAYLOAD_SCHEMAS, GENERIC_EVENT_NAMES, TYPED_EVENT_NAMES } from './types.ts';
import type { ChainEvent, GenericEventName, TypedEventName } from './types.ts';

const EVENT_PREFIX = 'EVENT_JSON:';
const RAW_CAP = 4096;

const typedNames: ReadonlySet<string> = new Set(TYPED_EVENT_NAMES);
const genericNames: ReadonlySet<string> = new Set(GENERIC_EVENT_NAMES);

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const unknownEvent = (name: string, raw: string): ChainEvent => ({ event: 'unknown_event', name, raw });

/** One log line as an event, or null when the line is not an event line. Never throws. */
export function decodeEventLog(line: string): ChainEvent | null {
  if (typeof line !== 'string' || !line.startsWith(EVENT_PREFIX)) return null;
  const raw = line.slice(0, RAW_CAP);
  let value: unknown;
  try {
    value = JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch {
    return unknownEvent('', raw);
  }
  if (!isPlainObject(value)) return unknownEvent('', raw);
  const name = typeof value.event === 'string' ? value.event : '';
  if (value.standard !== 'airlock' || value.version !== '1.0.0') return unknownEvent(name, raw);
  const data = value.data;
  const payload = Array.isArray(data) && data.length === 1 ? (data[0] as unknown) : undefined;
  if (!isPlainObject(payload)) return unknownEvent(name, raw);
  if (typedNames.has(name)) {
    const typed = name as TypedEventName;
    const parsed = EVENT_PAYLOAD_SCHEMAS[typed].safeParse(payload);
    return parsed.success ? ({ event: typed, data: parsed.data } as ChainEvent) : unknownEvent(name, raw);
  }
  if (genericNames.has(name)) return { event: name as GenericEventName, data: payload };
  return unknownEvent(name, raw);
}

/**
 * The events of one transaction outcome: only logs of receipts executed by the policy contract (the MPC signer and the payee account
 * log in the same transaction), in the order the outcome lists them. Lines that are not events are skipped.
 */
export function decodeOutcomeEvents(
  outcome: { receipts_outcome: { outcome: { executor_id: string; logs: string[] } }[] },
  contractId: string,
): ChainEvent[] {
  const events: ChainEvent[] = [];
  for (const receipt of outcome.receipts_outcome) {
    if (receipt.outcome.executor_id !== contractId) continue;
    for (const line of receipt.outcome.logs) {
      const event = decodeEventLog(line);
      if (event !== null) events.push(event);
    }
  }
  return events;
}

export type Execution = { kind: 'paid' } | { kind: 'signed' } | { kind: 'failed'; reason: string; retryable: boolean } | { kind: 'none' };

/** What the lane events of one request say; the last of its `paid`, `signed` and `failed` events wins (a failure can be retried). */
export function executionOf(events: ChainEvent[], requestId: string): Execution {
  let result: Execution = { kind: 'none' };
  for (const event of events) {
    if (event.event === 'paid' && event.data.request_id === requestId) result = { kind: 'paid' };
    else if (event.event === 'signed' && event.data.request_id === requestId) result = { kind: 'signed' };
    else if (event.event === 'failed' && event.data.request_id === requestId) {
      result = { kind: 'failed', reason: event.data.reason, retryable: event.data.retryable };
    }
  }
  return result;
}

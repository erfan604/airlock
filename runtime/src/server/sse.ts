// GET /runs/:id/events (AIR-161): the trace of one run as Server-Sent Events, behind the owner session. The browser EventSource reconnects
// by itself after any close and would replay the whole run, so the protocol is pinned: every message has `id: <n>` (the 0 based position
// in the run's event list), a reconnect sends `Last-Event-ID: n` and gets only what follows, and a finished run ends with an explicit
// `event: end` so the client can tell a finished run from a dropped stream.
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { TraceEvent } from '../interpreter/trace.ts';
import { requireSession } from './session.ts';

/** AIR-163's RunStore implements all three. The default source knows no run. */
export interface RunEventSource {
  /** every event of the run so far, or null for an unknown run */
  replay(id: string): TraceEvent[] | null;
  /** live events after the replay; returns the unsubscribe function */
  subscribe(id: string, cb: (e: TraceEvent) => void): () => void;
  /** the run state name; `done`, `failed` and `aborted` end the stream */
  stateOf?(id: string): string | null;
}

export const emptyRunEvents: RunEventSource = {
  replay: () => null,
  subscribe: () => () => undefined,
};

const PING_MS = 15_000;
const STATE_MS = 1_000;
const TERMINAL = new Set(['done', 'failed', 'aborted']);

// an event position, never an amount: BigInt, because the money lint bans the float parsers in server code
function lastEventId(header: string | undefined): bigint {
  return header !== undefined && /^[0-9]{1,9}$/.test(header.trim()) ? BigInt(header.trim()) : -1n;
}

export function mountSse(app: Hono, source: RunEventSource): void {
  app.get('/runs/:id/events', requireSession, (c) => {
    const id = c.req.param('id');
    // replay and subscribe back to back in one synchronous block: no event can fall between them
    const replayed = source.replay(id);
    if (replayed === null) return c.json({ error: 'not found' }, 404);
    const queue: TraceEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = source.subscribe(id, (e) => {
      queue.push(e);
      wake?.();
    });
    const resumeAfter = lastEventId(c.req.header('last-event-id'));

    const res = streamSSE(c, async (stream) => {
      let next = 0;
      let wait: (() => void) | null = null;
      let ping: ReturnType<typeof setInterval> | null = null;
      let poll: ReturnType<typeof setInterval> | null = null;
      const stop = (): void => {
        if (ping !== null) clearInterval(ping);
        if (poll !== null) clearInterval(poll);
        ping = null;
        poll = null;
        unsubscribe();
        wait?.();
      };
      stream.onAbort(stop);
      const send = async (e: TraceEvent): Promise<void> => {
        const index = next++;
        if (BigInt(index) > resumeAfter) await stream.writeSSE({ id: String(index), event: 'trace', data: JSON.stringify(e) });
      };
      const terminalState = (): string | null => {
        const state = source.stateOf?.(id) ?? null;
        return state !== null && TERMINAL.has(state) ? state : null;
      };
      try {
        for (const e of replayed) await send(e);
        ping = setInterval(() => void stream.write(': ping\n\n'), PING_MS);
        poll = setInterval(() => wait?.(), STATE_MS);
        wake = () => wait?.();
        for (;;) {
          if (stream.aborted) return;
          while (queue.length > 0) await send(queue.shift() as TraceEvent);
          const state = terminalState();
          if (state !== null) {
            while (queue.length > 0) await send(queue.shift() as TraceEvent);
            await stream.writeSSE({ event: 'end', data: JSON.stringify({ state }) });
            return;
          }
          await new Promise<void>((resolve) => {
            wait = resolve;
          });
          wait = null;
        }
      } finally {
        stop();
      }
    });
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return res;
  });
}

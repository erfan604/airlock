// AIR-310: the trace store's EventSource for the static build. The replay server streams a recorded trace as server-sent events; the export step
// saved that exact response body next to the page, and this class reads it and hands each `trace` and `end` message to the store's own handlers,
// so the rows come from the same parse functions as live. It implements only what `createTraceStore` calls.
import { url } from '../static.ts';

export type SseMessage = { event: string; id: string; data: string };

/** Parses the text of an SSE response into messages (WHATWG server-sent events: `field: value` lines, a blank line ends a message). */
export function parseSse(text: string): SseMessage[] {
  const out: SseMessage[] = [];
  let event = 'message';
  let id = '';
  let data: string[] = [];
  const flush = (): void => {
    if (data.length > 0) out.push({ event, id, data: data.join('\n') });
    event = 'message';
    data = [];
  };
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (raw === '') {
      flush();
      continue;
    }
    if (raw.startsWith(':')) continue;
    const at = raw.indexOf(':');
    const field = at < 0 ? raw : raw.slice(0, at);
    const value = at < 0 ? '' : raw.slice(at + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  flush();
  return out;
}

type Listener = (e: Event) => void;

export class StaticEventSource {
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  private closed = false;

  /** `path` is the stream path the store asks for, `/runs/<id>/events`; the file is `data/runs/<id>.txt`. */
  constructor(path: string) {
    const m = /^\/runs\/([0-9a-f]{32})\/events$/.exec(path);
    void this.run(m === null ? null : url(`data/runs/${m[1] as string}.txt`));
  }

  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }

  close(): void {
    this.closed = true;
  }

  private emit(type: string, e: Event): void {
    if (this.closed) return;
    for (const cb of this.listeners.get(type) ?? []) cb(e);
  }

  private async run(file: string | null): Promise<void> {
    try {
      if (file === null) throw new Error('bad stream path');
      const res = await fetch(file, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`stream read failed: ${String(res.status)}`);
      const messages = parseSse(await res.text());
      if (this.closed) return;
      this.onopen?.(new Event('open'));
      for (const m of messages) {
        if (this.closed) return;
        this.emit(m.event, new MessageEvent(m.event, { data: m.data, lastEventId: m.id }));
      }
    } catch {
      if (!this.closed) this.onerror?.(new Event('error'));
    }
  }
}

// The stream server of the task e2e (AIR-184): a small Node http server that serves `GET /runs/<id>/events` from the recorded fixtures with the
// protocol of AIR-161 (`retry: 200`, `id: <n>`, `event: trace`, `data`, a last `event: end` with {"state":"done"}, `Last-Event-ID` honoured).
// The page reaches it through the real Vite preview proxy (VITE_RUNTIME_ORIGIN names this server), so cookies, the CSP and the reconnect header
// all take the path they take in production. Playwright's `page.route` is not used for the stream: it fulfils the response but hides the
// `Last-Event-ID` header of the reconnect from the handler.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import b01 from '../fixtures/trace-b01.json' with { type: 'json' };
import hostile from '../fixtures/trace-hostile.json' with { type: 'json' };
import readonly from '../fixtures/trace-readonly.json' with { type: 'json' };
import u01 from '../fixtures/trace-u01.json' with { type: 'json' };
import type { E2ESetup } from './types.ts';

type Wire = { t: number; kind: string; data: Record<string, unknown> };

const long: Wire[] = Array.from({ length: 301 }, (_, i) => ({ t: i, kind: 'branch', data: { step: [i], kind: 'if', taken: i % 2 === 0, pc: ['Owner'] } }));

/** Run id to recorded events. The drop run replays the U01 events and cuts the first request after three of them. */
const RUNS: Record<string, Wire[]> = {
  '00000000000000000000000000000000': u01.events,
  '00000000000000000000000000000001': b01.events,
  '11111111111111111111111111111111': hostile.events,
  '22222222222222222222222222222222': u01.events,
  '33333333333333333333333333333333': long,
  '44444444444444444444444444444444': readonly.events,
};
const DROP_RUN = '22222222222222222222222222222222';
const DROP_AFTER = 3;
const RECONNECT_DELAY_MS = 700;

/** The `Last-Event-ID` value of every request that carried one, in order (the e2e reads it to prove the reconnect resumed). */
export const resumeHeaders: string[] = [];

function afterId(header: string | string[] | undefined): number {
  const h = Array.isArray(header) ? header[0] : header;
  return h !== undefined && /^[0-9]{1,9}$/.test(h.trim()) ? JSON.parse(h.trim()) : -1;
}

function sendEvent(res: ServerResponse, id: number, e: Wire): void {
  res.write(`id: ${id}\nevent: trace\ndata: ${JSON.stringify(e)}\n\n`);
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const m = /^\/runs\/([0-9a-f]{32})\/events$/.exec(req.url ?? '');
  const events = m?.[1] === undefined ? undefined : RUNS[m[1]];
  if (m === null || events === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }
  const resume = afterId(req.headers['last-event-id']);
  if (resume >= 0) resumeHeaders.push(String(resume));
  const start = (): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 200\n\n');
    const drop = m[1] === DROP_RUN && resume < 0;
    events.forEach((e, i) => {
      if (i > resume && (!drop || i < DROP_AFTER)) sendEvent(res, i, e);
    });
    // a cut stream ends cleanly with no `end` event: the browser sees a drop and reconnects with Last-Event-ID
    if (!drop) res.write('event: end\ndata: {"state":"done"}\n\n');
    res.end();
  };
  // the reconnect waits, so the stale caption stays on screen long enough to be seen
  if (m[1] === DROP_RUN && resume >= 0) setTimeout(start, RECONNECT_DELAY_MS);
  else start();
}

const setup: E2ESetup = async () => {
  const server: Server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    env: { VITE_RUNTIME_ORIGIN: `http://127.0.0.1:${port}` },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export default setup;

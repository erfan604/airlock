// The one door every page uses to the public transaction history API (FastNEAR's keyless index, tx.test.fastnear.com). Under bursts that API
// answers 429 with no access-control-allow-origin header, so in a browser a throttled call fails as a network error (measured 2026-11-11). This
// layer is a drop-in `fetch` for the readers (lender/lenders.ts, live/tryChain.ts, credit/chain.ts, credit/arena/read.ts,
// challenge/chainBoard.ts): at most 2 history requests at once, identical requests (same URL and body) answered by one call, a short session
// cache, and a retry with backoff on a 429 or a network error. A request to any other host goes straight to the browser's fetch.
export const HISTORY_HOST = 'tx.test.fastnear.com';

export type HistoryOpts = {
  fetch?: typeof fetch;
  /** history requests in flight at once */
  concurrency?: number;
  /** the pauses before each retry of a 429 or a network error; after the last one the request fails */
  retryMs?: readonly number[];
  /** how long an answer is reused for the same request */
  ttlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type Got = { status: number; text: string };

export type HistoryStats = { sent: number; answered: number; throttled: number; failed: number };

export type HistoryFetch = typeof fetch & { stats(): HistoryStats; clear(): void };

const isHistory = (url: string): boolean => {
  try {
    return new URL(url).host === HISTORY_HOST;
  } catch {
    return false;
  }
};

const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

export function makeHistoryFetch(o: HistoryOpts = {}): HistoryFetch {
  const base = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const limit = Math.max(1, o.concurrency ?? 2);
  const retryMs = o.retryMs ?? [1_500, 3_000, 6_000, 12_000];
  const ttl = o.ttlMs ?? 15_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; got: Got }>();
  const inflight = new Map<string, Promise<Got>>();
  const stats: HistoryStats = { sent: 0, answered: 0, throttled: 0, failed: 0 };
  let running = 0;
  const waiting: (() => void)[] = [];

  const slot = async (): Promise<void> => {
    if (running < limit) {
      running += 1;
      return;
    }
    await new Promise<void>((r) => waiting.push(r));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  };

  const once = async (url: string, init: RequestInit | undefined): Promise<Got> => {
    for (let i = 0; ; i++) {
      await slot();
      let got: Got | null = null;
      let err: unknown = null;
      try {
        stats.sent += 1;
        const res = await base(url, { method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? null, signal: AbortSignal.timeout(15_000) });
        got = res.status === 429 ? null : { status: res.status, text: await res.text() };
        if (got === null) stats.throttled += 1;
      } catch (e) {
        err = e;
        stats.throttled += 1;
      } finally {
        release();
      }
      if (got !== null) {
        stats.answered += 1;
        return got;
      }
      if (i >= retryMs.length) {
        stats.failed += 1;
        throw err instanceof Error ? err : new Error(`${HISTORY_HOST} is rate limited`);
      }
      await sleep(retryMs[i] ?? 0);
    }
  };

  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (!isHistory(url)) return base(input, init);
    const key = `${init?.method ?? 'GET'} ${url}\n${typeof init?.body === 'string' ? init.body : ''}`;
    const hit = cache.get(key);
    let got: Got;
    if (hit !== undefined && now() - hit.at < ttl) got = hit.got;
    else {
      let p = inflight.get(key);
      if (p === undefined) {
        p = once(url, init).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      got = await p;
      if (got.status >= 200 && got.status < 300) cache.set(key, { at: now(), got });
    }
    return new Response(got.text, { status: got.status, headers: { 'content-type': 'application/json' } });
  };
  return Object.assign(fn as typeof fetch, {
    stats: () => ({ ...stats }),
    clear: () => cache.clear(),
  });
}

/** The page session's one history door. */
export const historyFetch: HistoryFetch = makeHistoryFetch();

// The challenge HTTP API. The console reaches it through its own origin (the preview proxy forwards /api), so no CORS header is sent and a
// foreign Origin is refused on POST. Routes:
//   GET  /api/challenge/state      mode, whether door (a) is open, the scoreboard, the limits, the published key and the model spend
//   GET  /api/challenge/attempts   newest first, `limit` (1 to 100, default 50) and `before` (a seq)
//   GET  /api/challenge/stream     Server-Sent Events: `hello` once, then one `attempt` per new attempt, a comment ping every 15 s
//   POST /api/challenge/attempt    {"text": string}: door (a). 200 with the attempt, or an error code with the status of its kind
// Every refusal names a code from REFUSALS and nothing from the visitor's text.
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ChallengeConfig } from './config.ts';
import type { AdmissionControl } from './limits.ts';
import type { AttemptLog } from './log.ts';
import type { Challenge } from './service.ts';
import type { Refusal } from './types.ts';
import { visitorKey } from './visitor.ts';

export { visitorKey } from './visitor.ts';

export interface ServerDeps {
  cfg: ChallengeConfig;
  challenge: Challenge;
  log: AttemptLog;
  admission: AdmissionControl;
  /** the visitor's address for this request (address.ts), or null when it cannot be told: the attempt is then refused */
  addressOf(c: Context): string | null;
  /** the secret random salt of today (visitor.ts DailySalt), never derived from the date */
  salt(): string;
  clock(): number;
}

const STATUS: Record<Refusal, 400 | 413 | 429 | 502 | 503> = {
  live_off: 503,
  paused: 503,
  empty: 400,
  too_long: 413,
  busy: 429,
  rate_ip: 429,
  rate_global: 429,
  daily_cap: 429,
  llm_cap: 503,
  float_low: 503,
  float_unknown: 503,
  engine_failed: 502,
};

const Body = z.strictObject({ text: z.string() });
const PING_MS = 15_000;

export function createChallengeApp(deps: ServerDeps): Hono {
  const { cfg, log } = deps;
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('x-airlock-challenge-mode', cfg.mode);
  });
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin !== undefined) {
        const host = c.req.header('host') ?? new URL(c.req.url).host;
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (originHost !== host) return c.json({ error: 'bad origin' }, 403);
      }
    }
    await next();
  });

  app.get('/api/challenge/state', (c) =>
    c.json({
      mode: cfg.mode,
      doorTextOpen: cfg.mode === 'live',
      board: log.scoreboard(),
      logWriteFailures: log.writeFailures,
      limits: {
        perVisitor: { max: cfg.limits.perIpMax, perSeconds: cfg.limits.perIpWindowMs / 1000 },
        global: { max: cfg.limits.globalMax, perSeconds: cfg.limits.globalWindowMs / 1000 },
        dailyMax: cfg.limits.dailyMax,
        maxChars: cfg.limits.maxChars,
        nearDailyCapYocto: cfg.limits.nearDailyCapYocto,
        llmCapUsd: cfg.limits.llmCapUsd,
        llmSpentUsd: deps.admission.spentUsd(),
      },
      key: cfg.key,
      now: new Date(deps.clock()).toISOString(),
    }),
  );

  app.get('/api/challenge/attempts', (c) => {
    const q = c.req.query('limit');
    const b = c.req.query('before');
    const limit = q !== undefined && /^[0-9]{1,3}$/.test(q) ? Math.min(100, Math.max(1, +q)) : 50;
    const before = b !== undefined && /^[0-9]{1,9}$/.test(b) ? +b : undefined;
    return c.json({ attempts: log.latest(limit, before) });
  });

  app.get('/api/challenge/stream', (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const off = log.subscribe((a) => {
        queue.push(JSON.stringify(a));
        wake?.();
      });
      const ping = setInterval(() => wake?.(), PING_MS);
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        await stream.writeSSE({ event: 'hello', data: JSON.stringify({ board: log.scoreboard() }) });
        while (open) {
          const next = queue.shift();
          if (next !== undefined) {
            await stream.writeSSE({ event: 'attempt', data: next });
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          if (open && queue.length === 0) await stream.write(': ping\n\n');
        }
      } finally {
        clearInterval(ping);
        off();
      }
    }),
  );

  const limit = bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: 'too_long' }, 413) });
  app.post('/api/challenge/attempt', limit, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'bad request' }, 400);
    const address = deps.addressOf(c);
    if (address === null) return c.json({ error: 'bad_address' }, 400);
    const who = visitorKey(address, deps.salt());
    const result = await deps.challenge.attempt(who.key, who.short, parsed.data.text);
    if (result.ok) return c.json({ attempt: result.attempt });
    const status = STATUS[result.code];
    if (result.retryAfterMs !== null) c.header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    return c.json({ error: result.code, retryAfterSeconds: result.retryAfterMs === null ? null : Math.ceil(result.retryAfterMs / 1000) }, status);
  });
  return app;
}

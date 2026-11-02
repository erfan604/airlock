// The owner's HTTP API (AIR-161). The console reaches it only through its own origin (the Vite proxy, AIR-183), so this server sends no CORS
// headers and refuses a foreign Origin on every non-GET route. AIR-163 mounts the task routes on the returned app. No file under
// runtime/src/server except AIR-169's start.ts reads the environment: the mode and every id arrive as parameters.
import { Hono } from 'hono';
import type { ChainClient } from '../chain/near.ts';
import type { EvidenceStore } from '../evidence.ts';
import type { AccessKeyReader } from './access-keys.ts';
import { mountEvidence } from './evidence.ts';
import { SessionStore, mountSessionRoutes } from './session.ts';
import type { SessionLimits } from './session.ts';
import { emptyRunEvents, mountSse } from './sse.ts';
import type { RunEventSource } from './sse.ts';

export type { RunEventSource } from './sse.ts';

export interface AppDeps {
  chain: Pick<ChainClient, 'getRequest'>;
  clock(): number;
  accessKeys: AccessKeyReader;
  evidence: EvidenceStore;
  ownerAccountId: string;
  contractId: string;
  mode: 'live' | 'replay';
  runEvents?: RunEventSource;
  /** lowers or raises the two challenge limits; tests only (the defaults are the pinned 20 per 60 s and 1,000 outstanding) */
  limits?: SessionLimits;
}

/** NEAR account id rules: 2 to 64 characters of lowercase letters and digits, parts joined by one of `-_.`. */
export function isNearAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

export function createApp(deps: AppDeps): Hono {
  if (!isNearAccountId(deps.ownerAccountId)) throw new RangeError('ownerAccountId is not a NEAR account id');
  if (!isNearAccountId(deps.contractId)) throw new RangeError('contractId is not a NEAR account id');
  // the names of AIR-024: a replay server can never face the testnet contract
  if (deps.mode === 'replay' && !deps.contractId.endsWith('.test.near')) throw new RangeError('replay mode needs a contract id ending .test.near');

  const store = new SessionStore(deps.clock);
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    if (deps.mode === 'replay') c.res.headers.set('x-airlock-mode', 'replay');
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
    c.set('airlockSessions', store);
    await next();
  });

  mountSessionRoutes(app, deps, store);
  mountSse(app, deps.runEvents ?? emptyRunEvents);
  mountEvidence(app, deps.chain, deps.evidence);
  return app;
}

/**
 * A `Cookie` header value for a replay app: calls GET /session and returns `airlock_session=<id>`. It throws unless the response carries
 * `x-airlock-mode: replay`, so it cannot mint a session in a live app.
 */
export async function createTestSession(app: Hono): Promise<string> {
  const res = await app.request('/session');
  if (res.headers.get('x-airlock-mode') !== 'replay') throw new Error('createTestSession works on a replay mode app only');
  const match = /airlock_session=[0-9a-f]{64}/.exec(res.headers.get('set-cookie') ?? '');
  if (match === null) throw new Error('the replay app did not issue a session');
  return match[0];
}

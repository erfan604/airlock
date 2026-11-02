// Owner sessions (AIR-161). One owner, one login method: a NEP-413 signature by a full-access key of the owner account, over a single-use
// challenge this server made. The message and the recipient are server constants: the request never supplies them. `verifyMessage` of
// near-api-js 7.3.1 (reused as is) asks the node for the key and checks the signature; it does not check nonce, recipient, message or age,
// so this file does. Every failure to authenticate is the same 401 with no hint of the reason.
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { PublicKey } from 'near-api-js';
import { verifyMessage } from 'near-api-js/nep413';
import type { Provider } from 'near-api-js';
import { z } from 'zod';
import { RpcUnavailable } from './access-keys.ts';
import type { AccessKeyReader } from './access-keys.ts';

export interface SessionInfo {
  accountId: string;
  /** the first 16 hex characters of the sha256 of the cookie value, never the cookie value */
  sessionId: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    session: SessionInfo;
    airlockSessions: SessionStore;
  }
}

const COOKIE = 'airlock_session';
const CHALLENGE_TTL_MS = 300_000;
const SESSION_TTL_MS = 8 * 3600 * 1000;
const MAX_SESSIONS = 16;
const RATE_WINDOW_MS = 60_000;
const BODY_MAX = 8 * 1024;
const MAX_CLIENTS = 10_000;

// The peer address of the socket. Never a forwarded header: a client could set those. Behind the Vite proxy every console user shares the
// proxy's address, which is a stated limit; the owner is one person.
function clientKey(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface SessionLimits {
  /** challenges handed out per 60 seconds to one client address (default 20); there is no global cap, so one client cannot lock the owner out */
  challengesPerWindow?: number;
  /** challenges alive at once (default 1000); when full the oldest is evicted */
  maxOutstanding?: number;
}

const sha256hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const randomHex = (bytes: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');

/** The text the owner's wallet shows: 53 characters for `owner.test.near`, under the 100 Meteor shows without a tap. */
export function challengeMessage(ownerAccountId: string): string {
  return `Sign in to AIRLOCK as ${ownerAccountId}. No funds move.`;
}

/**
 * A NEP-413 signature as the wallets return it: standard base64 (padded or not) of exactly 64 bytes. Checked with a regex and a
 * re-encode, because `Buffer.from(text, 'base64')` accepts anything and ignores stray characters and non-canonical trailing bits.
 */
export function decodeSignature(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new RangeError('signature is not standard base64');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== 64) throw new RangeError('signature is not 64 bytes');
  if (bytes.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) throw new RangeError('signature is not canonical base64');
  return Uint8Array.from(bytes);
}

/**
 * The one method `verifyMessage` calls, over the injected reader. A missing key throws, a `FunctionCall` key is returned as an object
 * (near-api-js compares the permission with the string `FullAccess`). The cast is required: `VerifyMessageArgs.provider` is the full
 * 32-member `Provider` interface and a one-method object fails tsc with TS2740.
 */
export function providerFromReader(reader: AccessKeyReader): Provider {
  return {
    async viewAccessKey({ accountId, publicKey }: { accountId: string; publicKey: unknown }) {
      const key = await reader(accountId, String(publicKey));
      if (key === null) throw new Error('access key does not exist');
      const permission = key.permission === 'FullAccess' ? 'FullAccess' : { FunctionCall: { allowance: '0', receiver_id: '', method_names: [] } };
      return { nonce: 0n, permission, block_hash: '', block_height: 0 };
    },
  } as unknown as Provider;
}

export class SessionStore {
  private readonly sessions = new Map<string, { accountId: string; expires: number }>();
  constructor(private readonly clock: () => number) {}

  /** Stores a new session and returns the cookie value. At most 16 live sessions: the oldest is dropped. */
  issue(accountId: string): string {
    const value = randomHex(32);
    this.sessions.set(sha256hex(value), { accountId, expires: this.clock() + SESSION_TTL_MS });
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
    return value;
  }

  lookup(value: string | null): SessionInfo | null {
    if (value === null || !/^[0-9a-f]{64}$/.test(value)) return null;
    const key = sha256hex(value);
    const have = this.sessions.get(key);
    if (have === undefined) return null;
    if (this.clock() >= have.expires) {
      this.sessions.delete(key);
      return null;
    }
    return { accountId: have.accountId, sessionId: key.slice(0, 16) };
  }

  end(value: string | null): void {
    if (value !== null && /^[0-9a-f]{64}$/.test(value)) this.sessions.delete(sha256hex(value));
  }
}

function cookieValue(c: Context): string | null {
  const header = c.req.header('cookie');
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

function requestHost(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host;
}

function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:[0-9]+$/, '');
  return name === 'localhost' || name === '127.0.0.1';
}

function setSessionCookie(c: Context, value: string): void {
  const secure = isLoopbackHost(requestHost(c)) ? '' : '; Secure';
  c.header('Set-Cookie', `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

/** Sets `c.get('session')` for a valid cookie, else 401. There is no bypass in any mode. */
export const requireSession: MiddlewareHandler = async (c, next) => {
  const info = c.get('airlockSessions')?.lookup(cookieValue(c)) ?? null;
  if (info === null) return c.json({ error: 'unauthorized' }, 401);
  c.set('session', info);
  await next();
};

const LoginBody = z.strictObject({
  accountId: z.string().min(1).max(128),
  publicKey: z
    .string()
    .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/)
    .refine((key) => {
      try {
        PublicKey.from(key);
        return true;
      } catch {
        return false;
      }
    }),
  signature: z.string().refine((s) => {
    try {
      decodeSignature(s);
      return true;
    } catch {
      return false;
    }
  }),
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface SessionDeps {
  clock(): number;
  accessKeys: AccessKeyReader;
  ownerAccountId: string;
  contractId: string;
  mode: 'live' | 'replay';
  limits?: SessionLimits;
}

const BAD_REQUEST = { error: 'bad request' };
const UNAUTHORIZED = { error: 'unauthorized' };

/** Mounts the session routes on `app` over `store`. */
export function mountSessionRoutes(app: Hono, deps: SessionDeps, store: SessionStore): void {
  const challenges = new Map<string, number>();
  const issuedBy = new Map<string, number[]>();
  const perWindow = deps.limits?.challengesPerWindow ?? 20;
  const maxOutstanding = deps.limits?.maxOutstanding ?? 1000;
  const message = challengeMessage(deps.ownerAccountId);

  app.post('/session/challenge', (c) => {
    const now = deps.clock();
    for (const [nonce, expires] of challenges) if (now > expires) challenges.delete(nonce);
    const client = clientKey(c);
    const recent = (issuedBy.get(client) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= perWindow) return c.json({ error: 'rate limited' }, 429);
    recent.push(now);
    issuedBy.delete(client);
    issuedBy.set(client, recent);
    while (issuedBy.size > MAX_CLIENTS) {
      const oldest = issuedBy.keys().next();
      if (oldest.done === true) break;
      issuedBy.delete(oldest.value);
    }
    // bounded by eviction, not by refusing: a flood can push out old challenges but never stop a new one
    while (challenges.size >= maxOutstanding) {
      const oldest = challenges.keys().next();
      if (oldest.done === true) break;
      challenges.delete(oldest.value);
    }
    const nonce = randomHex(32);
    challenges.set(nonce, now + CHALLENGE_TTL_MS);
    return c.json({ nonce, message, recipient: deps.contractId });
  });

  app.post(
    '/session',
    bodyLimit({ maxSize: BODY_MAX, onError: (c) => c.json(BAD_REQUEST, 400) }),
    async (c) => {
      let raw: unknown;
      try {
        raw = JSON.parse(await c.req.text());
      } catch {
        return c.json(BAD_REQUEST, 400);
      }
      const parsed = LoginBody.safeParse(raw);
      if (!parsed.success) return c.json(BAD_REQUEST, 400);
      const { accountId, publicKey, signature, nonce } = parsed.data;
      // the nonce is spent by this attempt whatever happens next, a wrong account id included (AIR-167 F1)
      const expires = challenges.get(nonce);
      challenges.delete(nonce);
      if (accountId !== deps.ownerAccountId) return c.json(UNAUTHORIZED, 401);
      if (expires === undefined || deps.clock() > expires) return c.json(UNAUTHORIZED, 401);
      let unavailable = false;
      const reader: AccessKeyReader = async (account, key) => {
        try {
          return await deps.accessKeys(account, key);
        } catch (error) {
          if (error instanceof RpcUnavailable) unavailable = true;
          throw error;
        }
      };
      try {
        await verifyMessage({
          signerAccountId: accountId,
          signerPublicKey: publicKey,
          // from the stored challenge, never from the request
          payload: { message, nonce: Uint8Array.from(Buffer.from(nonce, 'hex')), recipient: deps.contractId },
          signature: decodeSignature(signature),
          provider: providerFromReader(reader),
        });
      } catch {
        return unavailable ? c.json({ error: 'rpc unavailable' }, 503) : c.json(UNAUTHORIZED, 401);
      }
      setSessionCookie(c, store.issue(accountId));
      return c.json({ accountId }, 200);
    },
  );

  app.get('/session', (c) => {
    const info = store.lookup(cookieValue(c));
    if (info !== null) return c.json({ accountId: info.accountId });
    // replay mode differs from live in exactly this: a visit without a session gets one for the owner
    if (deps.mode === 'replay') {
      setSessionCookie(c, store.issue(deps.ownerAccountId));
      return c.json({ accountId: deps.ownerAccountId });
    }
    return c.json(UNAUTHORIZED, 401);
  });

  app.post('/session/logout', (c) => {
    store.end(cookieValue(c));
    c.header('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return c.body(null, 204);
  });
}

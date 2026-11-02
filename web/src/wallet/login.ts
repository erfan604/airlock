// Owner login (AIR-161's routes): POST /session/challenge, the wallet signs the NEP-413 message, POST /session. Relative URLs through the
// same-origin proxy and the `airlock_session` cookie. The nonce the wallet signs is the 32 bytes of the 64 hex characters of the challenge,
// never a 36 byte UUID (near-api-js refuses it and the server recomputes the hash from the hex).
export type LoginErrorKind = 'rejected' | 'rpc' | 'wallet';

const MESSAGES: Record<LoginErrorKind, string> = {
  rejected: 'The runtime did not accept this sign in. Check that you used the owner account.',
  rpc: 'The chain could not be reached to check your key. Try again in a minute.',
  wallet: 'The wallet did not complete the sign in. Nothing was signed.',
};

/** Its message is one of three fixed texts: nothing a server or a wallet wrote is ever shown. */
export class LoginError extends Error {
  readonly kind: LoginErrorKind;
  constructor(kind: LoginErrorKind) {
    super(MESSAGES[kind]);
    this.name = 'LoginError';
    this.kind = kind;
  }
}

type Deps = { fetch?: typeof fetch };
type SignedMessage = { accountId: string; publicKey: string; signature: string };
export type MessageSigner = {
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<SignedMessage>;
};

const NONCE_HEX = /^[0-9a-f]{64}$/;
const HEX_DIGITS = '0123456789abcdef';

const init = (method: string, body?: unknown): RequestInit => ({
  method,
  credentials: 'same-origin',
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});

function bytesOfHex(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  const digit = (c: string | undefined): number => HEX_DIGITS.indexOf(c ?? '');
  for (let i = 0; i < 32; i += 1) out[i] = digit(hex[i * 2]) * 16 + digit(hex[i * 2 + 1]);
  return out;
}

/** `GET /session`: the owner account, or null without a session. */
export async function fetchSession(deps: Deps = {}): Promise<{ accountId: string } | null> {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch('/session', init('GET'));
  if (!res.ok) return null;
  const body = (await res.json()) as { accountId?: unknown };
  return typeof body.accountId === 'string' ? { accountId: body.accountId } : null;
}

const kindOfStatus = (status: number): LoginErrorKind => (status >= 500 ? 'rpc' : 'rejected');

export async function login(wallet: MessageSigner, deps: Deps = {}): Promise<{ accountId: string }> {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  let challenge: { nonce?: unknown; message?: unknown; recipient?: unknown };
  try {
    const res = await doFetch('/session/challenge', init('POST'));
    if (!res.ok) throw new LoginError(kindOfStatus(res.status));
    challenge = (await res.json()) as typeof challenge;
  } catch (e) {
    throw e instanceof LoginError ? e : new LoginError('rpc');
  }
  const { nonce, message, recipient } = challenge;
  if (typeof nonce !== 'string' || !NONCE_HEX.test(nonce) || typeof message !== 'string' || typeof recipient !== 'string') throw new LoginError('rejected');

  let signed: SignedMessage;
  try {
    signed = await wallet.signMessage({ message, recipient, nonce: bytesOfHex(nonce) });
  } catch {
    throw new LoginError('wallet');
  }
  if (typeof signed.accountId !== 'string' || typeof signed.publicKey !== 'string' || typeof signed.signature !== 'string') throw new LoginError('wallet');

  let res: Response;
  try {
    res = await doFetch('/session', init('POST', { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce }));
  } catch {
    throw new LoginError('rpc');
  }
  if (!res.ok) throw new LoginError(kindOfStatus(res.status));
  const body = (await res.json().catch(() => ({}))) as { accountId?: unknown };
  return { accountId: typeof body.accountId === 'string' ? body.accountId : signed.accountId };
}

export async function logout(deps: Deps = {}): Promise<void> {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  await doFetch('/session/logout', init('POST'));
}

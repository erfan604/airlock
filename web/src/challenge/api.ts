// The challenge page's reads and its one write. Every URL is relative: the page talks to its own origin only (the preview proxy forwards /api).
// Nothing here signs, opens a wallet or reads the chain.
import type { Attempt, ChallengeState } from './model.ts';

export type AttemptResult = { ok: true; attempt: Attempt } | { ok: false; code: string; retryAfterSeconds: number | null };

export type ChallengeApi = {
  state(): Promise<ChallengeState>;
  attempts(limit: number): Promise<Attempt[]>;
  attempt(text: string): Promise<AttemptResult>;
  /** Calls `onAttempt` for each new attempt and `onStatus` when the stream opens or drops. Returns the close function. */
  stream(onAttempt: (a: Attempt) => void, onStatus: (open: boolean) => void): () => void;
};

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`challenge read failed: ${String(res.status)}`);
  return (await res.json()) as unknown;
}

export const liveChallengeApi: ChallengeApi = {
  async state() {
    return (await getJson('/api/challenge/state')) as ChallengeState;
  },
  async attempts(limit) {
    return ((await getJson(`/api/challenge/attempts?limit=${String(limit)}`)) as { attempts: Attempt[] }).attempts;
  },
  async attempt(text) {
    const res = await fetch('/api/challenge/attempt', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const body = (await res.json().catch(() => ({}))) as { attempt?: Attempt; error?: string; retryAfterSeconds?: number | null };
    if (res.ok && body.attempt !== undefined) return { ok: true, attempt: body.attempt };
    return { ok: false, code: body.error ?? 'engine_failed', retryAfterSeconds: body.retryAfterSeconds ?? null };
  },
  stream(onAttempt, onStatus) {
    const source = new EventSource('/api/challenge/stream');
    source.onopen = () => onStatus(true);
    source.onerror = () => onStatus(false);
    source.addEventListener('attempt', (e) => {
      try {
        onAttempt(JSON.parse((e as MessageEvent<string>).data) as Attempt);
      } catch {
        // a message that does not parse is ignored; the next state read corrects the board
      }
    });
    return () => source.close();
  },
};

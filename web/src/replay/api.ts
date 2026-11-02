// The replay console's reads (AIR-246). Every URL is relative: the page talks to its own origin only (the preview proxy forwards /replay, /runs,
// /session and /api to the replay server). Nothing here signs, opens a wallet or reads the chain.
import type { AssetEntryViewJson, LedgersView, RequestView } from '@airlock/runtime/chain-types';
import type { BookEntryJson } from '@airlock/runtime/dsl';

export type ActId = 'u01' | 'b01' | 'tamper';

export type ActLink = { label: string; hash: string; url: string; status: 'success' | 'failure' };

export type Act = {
  id: ActId;
  title: string;
  scenario: string;
  ownerWords: string;
  runId: string | null;
  recordedAt: string;
  /** the golden file the act replays, shown in the banner */
  source: string;
  pendingNo: string | null;
  links: ActLink[];
};

export type HeldRequest = {
  view: RequestView;
  ledgers: LedgersView;
  asset: AssetEntryViewJson;
  book: BookEntryJson | null;
  bookKeys: string[];
  bookLabels: Record<string, string>;
};

export type TamperResult = { tx: string; url: string; failure: string };

export type ReplayApi = {
  acts(): Promise<Act[]>;
  held(no: string): Promise<HeldRequest>;
  /** the body of GET /api/evidence/<no>, or null for a 404 */
  evidence(no: string): Promise<unknown>;
  approve(no: string): Promise<{ ok: true; tx: string; url: string } | { ok: false }>;
  tamper(): Promise<TamperResult>;
};

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`replay read failed: ${res.status}`);
  return (await res.json()) as unknown;
}

/** The mode of the server behind this page: only a replay server sets `x-airlock-mode: replay` on `GET /session`. */
export async function replayMode(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/session', { credentials: 'same-origin' });
    return res.headers.get('x-airlock-mode') === 'replay';
  } catch {
    return false;
  }
}

export const liveReplayApi: ReplayApi = {
  async acts() {
    return ((await getJson('/replay/acts')) as { acts: Act[] }).acts;
  },
  async held(no) {
    return (await getJson(`/replay/request/${encodeURIComponent(no)}`)) as HeldRequest;
  },
  async evidence(no) {
    const res = await fetch(`/api/evidence/${encodeURIComponent(no)}`, { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as unknown) : null;
  },
  async approve(no) {
    const res = await fetch(`/replay/approve/${encodeURIComponent(no)}`, { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { ok?: unknown; tx?: unknown; url?: unknown };
    return body.ok === true && typeof body.tx === 'string' && typeof body.url === 'string' ? { ok: true, tx: body.tx, url: body.url } : { ok: false };
  },
  async tamper() {
    return (await getJson('/replay/tamper')) as TamperResult;
  },
};

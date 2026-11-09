// The replay console's reads (AIR-246). Every URL is relative: the page talks to its own origin only (the preview proxy forwards /replay, /runs,
// /session and /api to the replay server). Nothing here signs, opens a wallet or reads the chain.
import type { AssetEntryViewJson, LedgersView, RequestView } from '@airlock/runtime/chain-types';
import type { BookEntryJson } from '@airlock/runtime/dsl';
import { scrubOwner } from '../components/account.ts';
import { STATIC, url } from '../static.ts';

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
  // the hosted copy rewrites the owner's name in what it reads (components/account.ts); a live console shows the server's answer as it is
  return (STATIC ? JSON.parse(scrubOwner(await res.text())) : await res.json()) as unknown;
}

/** The mode of the server behind this page: only a replay server sets `x-airlock-mode: replay` on `GET /session`. */
export async function replayMode(fetchFn: typeof fetch = fetch): Promise<boolean> {
  // AIR-310: the static build is a replay by construction: there is no server to ask
  if (STATIC) return true;
  try {
    const res = await fetchFn('/session', { credentials: 'same-origin' });
    return res.headers.get('x-airlock-mode') === 'replay';
  } catch {
    return false;
  }
}

/** Where each read goes. The live console asks the replay server; the static build asks the files `scripts/export-static.ts` wrote from the same answers. */
type Urls = {
  acts: string;
  held(no: string): string;
  evidence(no: string): string;
  approve(no: string): string;
  tamper: string;
  /** the recorded approve is a POST to the server and a plain read of its recorded answer from a file */
  approveMethod: 'POST' | 'GET';
};

export function makeReplayApi(u: Urls): ReplayApi {
  return {
    async acts() {
      return ((await getJson(u.acts)) as { acts: Act[] }).acts;
    },
    async held(no) {
      return (await getJson(u.held(no))) as HeldRequest;
    },
    async evidence(no) {
      const res = await fetch(u.evidence(no), { credentials: 'same-origin' });
      return res.ok ? ((STATIC ? JSON.parse(scrubOwner(await res.text())) : await res.json()) as unknown) : null;
    },
    async approve(no) {
      const res = await fetch(u.approve(no), { method: u.approveMethod, credentials: 'same-origin' });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { ok?: unknown; tx?: unknown; url?: unknown };
      return body.ok === true && typeof body.tx === 'string' && typeof body.url === 'string' ? { ok: true, tx: body.tx, url: body.url } : { ok: false };
    },
    async tamper() {
      return (await getJson(u.tamper)) as TamperResult;
    },
  };
}

const enc = encodeURIComponent;

export const serverReplayApi: ReplayApi = makeReplayApi({
  acts: '/replay/acts',
  held: (no) => `/replay/request/${enc(no)}`,
  evidence: (no) => `/api/evidence/${enc(no)}`,
  approve: (no) => `/replay/approve/${enc(no)}`,
  tamper: '/replay/tamper',
  approveMethod: 'POST',
});

/** AIR-310: the same reads from `data/*.json` next to the page. A number that is not a plain pending number gets a 404 from the host, as it would from the server. */
export const staticReplayApi: ReplayApi = makeReplayApi({
  acts: url('data/replay/acts.json'),
  held: (no) => url(`data/replay/request/${enc(no)}.json`),
  evidence: (no) => url(`data/api/evidence/${enc(no)}.json`),
  approve: (no) => url(`data/replay/approve/${enc(no)}.json`),
  tamper: url('data/replay/tamper.json'),
  approveMethod: 'GET',
});

/** The replay reads of this build. */
export const liveReplayApi: ReplayApi = STATIC ? staticReplayApi : serverReplayApi;

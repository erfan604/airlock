// The site state file (web/src/state/siteState.ts, format airlock-site-state-v1): every number and list the hosted site shows that comes from the
// public transaction history, computed by the same readers the pages run, so anybody can recompute what a page shows. Key free and read only: it
// reads the pool's and the cards' views over JSON-RPC and the public history API (tx.test.fastnear.com) one request at a time, with a pause and a
// retry on a 429 or a network error. History newer than the cut (two minutes before the read, so no transaction is counted while its receipts
// still run) is left to the pages, which read it live.
// Run (prints the numbers):  pnpm site-state
// Write the file for a deploy: pnpm site-state --out web/public/site-state.json
// Options: --try-public <path or URL> and --challenge-public <path or URL> (default: the files in web/public, else the hosted copies).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NEAR_RPC } from '../web/csp.ts';
import { makeHistoryFetch } from '../web/src/chain/historyFetch.ts';
import { readArena } from '../web/src/credit/arena/read.ts';
import { readEvents, readPool } from '../web/src/credit/chain.ts';
import { CREDIT_POOL } from '../web/src/credit/net.ts';
import { boardOf, readChain } from '../web/src/challenge/chainBoard.ts';
import { loopRepays, parseSchedule } from '../web/src/lender/history.ts';
import { depositors, isTeam, poolEvents, readAccountTxs, readLp } from '../web/src/lender/lenders.ts';
import { countsOfTry, readTryAttempts } from '../web/src/live/tryChain.ts';
import type { TryAttempt } from '../web/src/live/tryChain.ts';
import replay from '../web/src/live/try-replay.json' with { type: 'json' };
import { SITE_STATE_COMMAND, SITE_STATE_FORMAT, parseSiteState } from '../web/src/state/siteState.ts';
import type { SiteState } from '../web/src/state/siteState.ts';

const SITE = 'https://airlock-ere.pages.dev';
const repo = resolve(import.meta.dirname, '..');
// `pnpm -C web exec` runs in web/: a relative --out is read from where the command was typed
const here = process.env['INIT_CWD'] ?? process.cwd();
const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : (process.argv[i + 1] ?? null);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A public file of the site: a local path, a URL, or the copy in web/public, else the hosted copy. */
async function publicFile(given: string | null, name: string): Promise<unknown> {
  const local = given ?? resolve(repo, 'web/public', name);
  if (!/^https?:/.test(local) && existsSync(resolve(here, local))) return JSON.parse(readFileSync(resolve(here, local), 'utf8')) as unknown;
  const res = await fetch(/^https?:/.test(local) ? local : `${SITE}/${name}`);
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

// one history request at a time, 2 s to 60 s pauses on a 429 or a network error, no reuse (every answer is read once)
const history = makeHistoryFetch({ concurrency: 1, retryMs: [2_000, 4_000, 8_000, 16_000, 30_000, 60_000], ttlMs: 0 });
const rpc = { rpcUrls: NEAR_RPC };

async function finalHeight(): Promise<number> {
  for (const u of NEAR_RPC) {
    try {
      const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'h', method: 'block', params: { finality: 'final' } }) });
      const j = (await res.json()) as { result?: { header?: { height?: unknown } } };
      const h = j.result?.header?.height;
      if (typeof h === 'number') return h;
    } catch {
      // the next RPC host
    }
  }
  throw new Error('no RPC host answered the block height');
}

const startMs = Date.now();
const cut = startMs - 120_000;
const height = await finalHeight();

// the pool: its view, its own events (lenders, the loop, fees)
const pool = await readPool({ pool: CREDIT_POOL, ...rpc });
const poolRead = await readAccountTxs(history, CREDIT_POOL, { retryMs: [] });
const events = poolEvents(
  poolRead.txs.filter((t) => t.atMs <= cut),
  CREDIT_POOL,
);
const outside = depositors(events).filter((a) => !isTeam(a));
let outsideNow = 0;
for (const a of outside) if ((await readLp(rpc, CREDIT_POOL, a)).shares > 0n) outsideNow += 1;
const schedule = parseSchedule(JSON.parse(readFileSync(resolve(repo, 'web/public/lender/schedule.json'), 'utf8')) as unknown);
if (schedule === null) throw new Error('web/public/lender/schedule.json does not parse');
const cycles = loopRepays(events, schedule);
const last = cycles.at(-1);
let loopFees = 0n;
for (const e of cycles) if (typeof e.data['fee'] === 'string' && /^[0-9]{1,39}$/.test(e.data['fee'])) loopFees += BigInt(e.data['fee']);

// the practice card of /rob
const tryRaw = await publicFile(arg('--try-public'), 'try-public.json');
if (!isObj(tryRaw) || typeof tryRaw['policy'] !== 'string' || typeof tryRaw['agent'] !== 'string' || !Array.isArray(tryRaw['book']) || typeof tryRaw['pendingTtlMs'] !== 'number') throw new Error('try-public.json is missing or not in its format');
const ttl = tryRaw['pendingTtlMs'];
const tryRead = await readTryAttempts({ policy: tryRaw['policy'], agent: tryRaw['agent'], book: tryRaw['book'] as string[], nowMs: Date.now(), ttlMs: ttl, fetch: history });
const tries = tryRead.attempts.filter((a) => a.atMs <= cut);
const c = countsOfTry(tries);
const replayed = new Set(Object.entries(replay.ids).flatMap(([hash, xs]) => xs.map((i) => `${hash}:${String(i)}`)));
const browsers = countsOfTry(tries.filter((a) => !replayed.has(a.requestId)));
const newest = (xs: readonly TryAttempt[], n: number): TryAttempt[] => [...xs].sort((a, b) => b.atMs - a.atMs || b.requestId.localeCompare(a.requestId)).slice(0, n);

// /credit: the pool's and its cards' newest events, and the arena
const creditEvents = (await readEvents({ pool: CREDIT_POOL, cards: pool.lines.map((l) => l.card), fetch: history })).filter((e) => e.atMs <= cut).slice(-40);
const arena = await readArena({ fetch: history });

// /challenge: the board of the published-key door
const chRaw = await publicFile(arg('--challenge-public'), 'challenge-public.json');
let challenge: SiteState['challenge'] = null;
if (isObj(chRaw) && typeof chRaw['policy'] === 'string' && typeof chRaw['publicKey'] === 'string' && typeof chRaw['agent'] === 'string') {
  const ch = await readChain(history, { policy: chRaw['policy'], publicKey: chRaw['publicKey'], agent: chRaw['agent'] });
  const kept = ch.attempts.filter((a) => Date.parse(a.at) <= cut);
  challenge = { policy: chRaw['policy'], board: boardOf(kept), attempts: kept.slice(-20), truncated: ch.truncated };
}

const state: SiteState = {
  format: SITE_STATE_FORMAT,
  as_of_ms: Date.now(),
  block_height: height,
  cut_ms: cut,
  command: SITE_STATE_COMMAND,
  pool: { id: CREDIT_POOL, assets: pool.assets, shares: pool.shares, losses: pool.losses, idle: pool.idle, lent: pool.lent, fees_earned: pool.feesEarned, lines: pool.lines.length },
  lenders: { outside, outside_now: outsideNow, truncated: poolRead.truncated },
  loop: { cycles: cycles.length, last_ms: last?.atMs ?? null, last_tx: last?.tx ?? null, fees_earned_by_loop: loopFees.toString() },
  rob: {
    policy: tryRaw['policy'],
    attempts: c.attempts,
    blocked: c.blocked,
    held_open_ms: tries.filter((a) => a.kind === 'held' && Date.now() - a.atMs < ttl).map((a) => a.atMs),
    expired: tries.filter((a) => a.kind === 'held' && Date.now() - a.atMs >= ttl).length,
    paid_shop: c.paidShop,
    paid_outside: c.paidOutside,
    failed: tryRead.failed,
    last_ms: c.lastMs,
    truncated: tryRead.truncated,
    ttl_ms: ttl,
    from_browsers: { attempts: browsers.attempts, paid_outside: browsers.paidOutside },
    rows: newest(tries, 25),
  },
  credit: { events: creditEvents },
  arena: { attempts: arena.attempts.filter((a) => a.atMs <= cut), truncated: arena.truncated },
  challenge,
};
// the file is written as the page's own parser reads it: every chain string in its grammar or a placeholder, foreign names cut (chainText.ts)
const shaped = parseSiteState(JSON.parse(JSON.stringify(state)) as unknown);
if (shaped === null) throw new Error('the state does not parse back');

const text = `${JSON.stringify(shaped)}\n`;
const out = arg('--out');
const s = history.stats();
const lines = [
  `SITE_STATE as_of ${new Date(state.as_of_ms).toISOString()} block ${String(height)} cut ${new Date(cut).toISOString()}`,
  `pool assets ${state.pool.assets} shares ${state.pool.shares} losses ${state.pool.losses} fees_earned ${state.pool.fees_earned} lines ${String(state.pool.lines)}`,
  `lenders outside_team ${String(outside.length)} lending_now ${String(outsideNow)} newest_part ${poolRead.truncated ? 'yes' : 'no'}`,
  `loop cycles ${String(state.loop.cycles)} last ${state.loop.last_ms === null ? 'none' : new Date(state.loop.last_ms).toISOString()} tx ${state.loop.last_tx ?? 'none'}`,
  `rob attempts ${String(c.attempts)} held ${String(c.held + c.expired)} blocked ${String(c.blocked)} paid_shop ${String(c.paidShop)} paid_elsewhere ${String(c.paidOutside)} from_browsers ${String(browsers.attempts)} replay_requests ${String(replay.requests)}`,
  `credit events ${String(creditEvents.length)} arena attempts ${String(state.arena.attempts.length)}${challenge === null ? ' challenge none' : ` challenge attempts ${String(challenge.board.attempts)} stolen ${challenge.board.stolenYocto}`}`,
  `history requests ${String(s.sent)} throttled ${String(s.throttled)} bytes ${String(Buffer.byteLength(text))}`,
];
for (const l of lines) console.log(l);
if (out !== null) {
  writeFileSync(resolve(here, out), text);
  console.log(`SITE_STATE OK ${resolve(here, out)}`);
}

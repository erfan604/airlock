// AIR-247: demo-live.ts against scripted doubles. Nothing here touches the chain, a key or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoldenRunSchema } from './lib/golden.ts';
import type { RequestView } from '../runtime/src/chain/types.ts';
import { APPROVAL_WAIT_MS, MIN_BUDGET, autopilotLines, bannerLines, blockNetwork, guards, parseArgs, readAutopilot, runDemo } from './demo-live.ts';
import type { DemoIo } from './demo-live.ts';
import type { CaseReport } from './e2e-testnet.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const H = (n: number): string => `Hash${String(n).padStart(2, '0')}`.padEnd(44, 'x');
const NEAR = 10n ** 24n;

const rep = (o: Partial<CaseReport>): CaseReport => ({ caseId: 'B01', skipped: false, outcome: 'allowed', reason: null, requestId: 'R', pendingNo: null, txHash: null, link: null, ...o });

interface Rig {
  io: DemoIo;
  out: string[];
  calls: string[];
  dir: string;
}

function rig(o: { remaining?: bigint; pending?: number; hour?: number; state?: () => string; clock?: { t: number } } = {}): Rig {
  const out: string[] = [];
  const calls: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'demo-live-'));
  const clock = o.clock ?? { t: Date.parse('2026-11-03T12:00:00Z') };
  let b01 = 0;
  const io: DemoIo = {
    root: ROOT,
    out: (l) => out.push(l),
    nowMs: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    env: { LLM_MODE: 'record' },
    contractId: 'policy.erfan-airlock.testnet',
    accountant: 'accountant.erfan-airlock.testnet',
    twinAccount: 'erfan-twin-vanilla.testnet',
    liveLatestPath: join(dir, 'live-latest.json'),
    preflight: async () => [{ level: 'PASS', name: 'policy balance', detail: 'ok' }],
    accountantRemaining: async () => o.remaining ?? 20n * NEAR,
    pendingCount: async () => o.pending ?? 0,
    hourEscalations: async () => o.hour ?? 0,
    policyBalance: async () => 30n * NEAR,
    runCase: async (id) => {
      calls.push(`runCase ${id}`);
      if (id === 'U01') return rep({ caseId: 'U01', outcome: 'allowed', requestId: 'R1', txHash: H(1), submitTxHash: H(1) });
      b01 += 1;
      return rep({ outcome: 'escalated', reason: 'OverTaskBound', requestId: `RB${b01}`, pendingNo: String(10 + b01), submitTxHash: H(10 + b01), txHash: H(10 + b01) });
    },
    finishCase: async (id, no) => {
      calls.push(`finishCase ${id} ${no}`);
      return rep({ txHash: H(3) });
    },
    getRequest: async () => ({ state: (o.state ?? (() => 'Executed'))() }) as unknown as RequestView,
    nearTx: async () => ({ status: 'failure', failure: 'approve rejected: WrongAmount', events: [] }),
    approvalTx: () => H(3),
    askApprovalTx: async () => null,
    saveApprovalTx: () => undefined,
    tamper: async () => ({ hash: H(4), line: '' }),
    runTwinLive: async () => 0,
  };
  return { io, out, calls, dir };
}

test('the banner comes first and names every layer', async () => {
  const r = rig();
  assert.equal(await runDemo([], r.io), 0);
  const head = r.out.slice(0, 8);
  assert.deepEqual(head, bannerLines(r.io.contractId, false));
  for (const tag of ['LIVE   chain:', 'LIVE   act 2', 'RECORDED extractor', 'FIXED  the AIRLOCK plan', 'HUMAN  Erfan']) assert.ok(head.some((l) => l.startsWith(tag)), tag);
  assert.ok(head.some((l) => l.startsWith('RECORDED act 0')));
});

test('act 0 is built from autopilot.json and says held, never paid', () => {
  const a = readAutopilot(ROOT);
  const text = autopilotLines(a).join('\n');
  assert.match(text, /held, never paid: 12 attacks \(attacks paid 0\)/);
  assert.match(text, /ask rate day 1 57\.14%, day 7 33\.33%/);
  assert.doesNotMatch(text, /attacks? blocked|blocked attacks/);
});

test('a scripted run prints the lines the acceptance greps match and no secret', async () => {
  const r = rig();
  assert.equal(await runDemo([], r.io), 0);
  const t = r.out.join('\n');
  assert.equal(r.out[r.out.length - 1], 'DEMO LIVE OK');
  assert.match(t, /^ACT 2 U01 allowed PAID 4\.2 NEAR tx [A-Za-z0-9]+$/m);
  assert.match(t, /^ACT 2 B01 escalated OverTaskBound pending [0-9]+$/m);
  assert.match(t, /^ACT 2 B01 approved tx [A-Za-z0-9]+$/m);
  assert.match(t, /^ACT 3 TAMPER REVERTED [A-Za-z0-9]+ approve rejected: WrongAmount$/m);
  assert.match(t, /^BUDGET accountant remaining 20 NEAR$/m);
  assert.doesNotMatch(t, /ed25519:|private|secret|signature/i);
  assert.deepEqual(r.calls, ['runCase U01', 'runCase B01', 'finishCase B01 11', 'runCase B01']);
});

test('with no twin golden act 1 is skipped honestly, never invented', async () => {
  const r = rig();
  await runDemo([], r.io);
  assert.ok(r.out.some((l) => l.startsWith('ACT 1 TWIN V0 SKIPPED')));
  assert.ok(!r.out.some((l) => /^ACT 1 TWIN V0 run/.test(l)));
});

test('live-latest.json parses as a GoldenRun with the labels of the acts', async () => {
  const r = rig();
  await runDemo([], r.io);
  const run = GoldenRunSchema.parse(JSON.parse(readFileSync(r.io.liveLatestPath, 'utf8')));
  assert.equal(run.name, 'live-latest');
  assert.deepEqual([...new Set(run.txs.map((t) => t.label))].sort(), ['approve', 'submit', 'tamper']);
  assert.equal(run.requests.length, 3);
});

test('the budget guard refuses at 13.5 NEAR with the number and passes at 13.6', async () => {
  const low = rig({ remaining: 135n * 10n ** 23n });
  await assert.rejects(guards(low.io), (e: { line?: string }) => /remaining 13\.5 NEAR/.test(e.line ?? '') && /13\.6 NEAR/.test(e.line ?? ''));
  const ok = rig({ remaining: MIN_BUDGET });
  await guards(ok.io);
  assert.deepEqual(ok.out, ['BUDGET accountant remaining 13.6 NEAR']);
});

test('three pending requests stop the run before any payment', async () => {
  const r = rig({ pending: 3 });
  assert.equal(await runDemo([], r.io), 1);
  assert.deepEqual(r.calls, []);
  assert.ok(r.out.some((l) => l.startsWith('FAIL pending 3')));
});

test('five escalations this hour stop the run before any payment', async () => {
  const r = rig({ hour: 5 });
  assert.equal(await runDemo([], r.io), 1);
  assert.deepEqual(r.calls, []);
});

test('an approval that never comes ends after ten minutes with the state', async () => {
  const r = rig({ state: () => 'Pending' });
  assert.equal(await runDemo([], r.io), 1);
  assert.ok(r.out.some((l) => l.includes('still Pending after 10 minutes')));
  assert.ok(APPROVAL_WAIT_MS === 600_000);
  assert.ok(!existsSync(r.io.liveLatestPath));
});

test('the dry run blocks the network, replays the golden lines and sends nothing', async () => {
  const r = rig();
  let blocked = '';
  r.io.duringDryRun = async () => {
    try {
      await fetch('http://127.0.0.1:8099/');
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      blocked = `${err.message ?? ''} ${err.cause?.message ?? ''}`;
    }
  };
  assert.equal(await runDemo(['--dry-run'], r.io), 0);
  assert.match(blocked, /network blocked/);
  assert.ok(r.out.filter((l) => l.startsWith('REPLAY ACT ')).length >= 5);
  assert.equal(r.out[r.out.length - 1], 'DEMO LIVE DRY RUN OK');
  assert.deepEqual(r.calls, []);
});

test('blockNetwork restores the connection method', () => {
  const restore = blockNetwork();
  restore();
});

test('bad arguments print usage and exit 2', async () => {
  const r = rig();
  assert.equal(await runDemo(['--dry-run', '--twins-live'], r.io), 2);
  assert.equal(parseArgs(['--nope']), null);
});

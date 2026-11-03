// AIR-246: the replay server of `pnpm demo`. It replays recorded runs: the traces of bench/golden/*.json and the recorded chain views of the held
// request. It never runs the planner, the extractor, the interpreter or the orchestrator, and it never calls ReplayTransport.submit. The clock is
// the recording's own, so a demo started months later still sees a task that has not expired. No file under runtime/src/demo reads the process
// environment, calls a model or opens an outbound connection: it listens and answers from files.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Attestation } from '../attest/index.ts';
import { ChainClient } from '../chain/near.ts';
import { ReplayTransport } from '../chain/transport.ts';
import type { AssetEntryViewJson, LedgersView, RequestView } from '../chain/types.ts';
import { requestContentHash, MemoryEvidenceStore } from '../evidence.ts';
import type { TraceEvent } from '../interpreter/trace.ts';
import { createApp } from '../server/app.ts';
import type { RunEventSource } from '../server/app.ts';
import { requireSession } from '../server/session.ts';
import { loadScenarios, loadWorld } from '../tools/index.ts';
import { MissingRecording, readActFiles } from './golden.ts';
import type { ActFile, GoldenFile, GoldenTx } from './golden.ts';

export const REPLAY_CONTRACT_ID = 'policy.test.near';
export const REPLAY_OWNER_ID = 'owner.test.near';
const AGENT_ACCOUNT_ID = 'agent.test.near';
const TAMPER_FAILURE = 'approve rejected: WrongAmount';

/** The run ids of the two replayed traces: 32 lowercase hex digits, the only form the console's trace store follows. */
export const RUN_IDS = { u01: '00000000000000000000000000000001', b01: '00000000000000000000000000000002' } as const;

export type ActId = 'u01' | 'b01' | 'tamper';

export interface Act {
  id: ActId;
  title: string;
  scenario: string;
  ownerWords: string;
  runId: string | null;
  recordedAt: string;
  /** the golden file the act replays */
  source: string;
  /** the pending number of the held request (act 2 only) */
  pendingNo: string | null;
  links: { label: string; hash: string; url: string; status: 'success' | 'failure' }[];
}

const TITLES: Record<ActId, string> = { u01: 'Act 1 Invoice paid', b01: 'Act 2 Correction held', tamper: 'Act 3 Tampered approval' };

/** Serves the traces of the two recorded runs; there is nothing live to subscribe to. */
export class GoldenRunSource implements RunEventSource {
  private readonly runs: Map<string, TraceEvent[]>;

  constructor(u01: GoldenFile, b01: GoldenFile) {
    this.runs = new Map([
      [RUN_IDS.u01, u01.trace as TraceEvent[]],
      [RUN_IDS.b01, b01.trace as TraceEvent[]],
    ]);
  }

  replay(id: string): TraceEvent[] | null {
    const events = this.runs.get(id);
    return events === undefined ? null : [...events];
  }

  subscribe(): () => void {
    return () => undefined;
  }

  stateOf(id: string): string | null {
    return this.runs.has(id) ? 'done' : null;
  }
}

const links = (txs: GoldenTx[]): Act['links'] => txs.map((t) => ({ label: t.label, hash: t.hash, url: t.url, status: t.status }));

export function buildActs(files: Record<ActFile, GoldenFile>, ownerWords: (scenario: string) => string): Act[] {
  const held = files['b01-escalate'].requests[0];
  const act = (id: ActId, file: ActFile, runId: string | null, extra: Pick<Act, 'pendingNo'>, txs: GoldenTx[]): Act => {
    const f = files[file];
    const scenario = f.scenario ?? '';
    return { id, title: TITLES[id], scenario, ownerWords: ownerWords(scenario), runId, recordedAt: f.recordedAt, source: f.name, pendingNo: extra.pendingNo, links: links(txs) };
  };
  return [
    act('u01', 'u01', RUN_IDS.u01, { pendingNo: null }, files.u01.txs),
    act('b01', 'b01-escalate', RUN_IDS.b01, { pendingNo: held?.pending_id ?? null }, [...files['b01-escalate'].txs]),
    act('tamper', 'tamper', null, { pendingNo: files.tamper.requests[0]?.pending_id ?? null }, files.tamper.txs),
  ];
}

export interface ReplayServerOptions {
  goldenDir: string;
  chainDir: string;
  worldPath: string;
  port: number;
  host?: string;
}

export interface ReplayServer {
  url: string;
  close(): Promise<void>;
}

interface HeldRequest {
  view: RequestView;
  ledgers: LedgersView;
  asset: AssetEntryViewJson;
  book: unknown;
  bookKeys: string[];
  bookLabels: Record<string, string>;
}

/** Builds the app without listening (the unit tests call `app.request`). Throws MissingRecording naming the first absent file. */
export async function createReplayApp(o: Omit<ReplayServerOptions, 'port' | 'host'>): Promise<Hono> {
  const files = readActFiles(o.goldenDir);
  const chainFile = join(o.chainDir, 'b01-escalate.json');
  if (!existsSync(chainFile)) throw new MissingRecording(chainFile);

  const scenarios = loadScenarios(o.worldPath);
  const ownerWords = (id: string): string => {
    const s = scenarios.find((x) => x.id === id);
    if (s === undefined) throw new MissingRecording(`${o.worldPath} (scenario ${id})`);
    return s.request;
  };
  const acts = buildActs(files, ownerWords);

  const transport = new ReplayTransport(chainFile);
  const chain = new ChainClient({ network: 'testnet', contractId: transport.contractId, agentAccountId: AGENT_ACCOUNT_ID, transport });

  // the held request, read once from the recorded views (the same queues the card reads)
  const held = files['b01-escalate'].requests[0];
  const heldNo = held?.pending_id ?? null;
  if (held === undefined || heldNo === null) throw new MissingRecording(join(o.goldenDir, 'b01-escalate.json'));
  const heldView = await chain.getRequest(heldNo);
  if (heldView === null) throw new MissingRecording(chainFile);
  const heldRequest = async (): Promise<HeldRequest> => {
    const view = (await chain.getRequest(heldNo)) as RequestView;
    const ledgers = await chain.getLedgers(view.payee, view.asset);
    const assetRow = (await chain.listAssets()).find(([id]) => id === view.asset);
    if (assetRow === undefined) throw new MissingRecording(`${chainFile} (list_assets ${view.asset})`);
    const rows = await chain.getBook();
    const bookLabels: Record<string, string> = {};
    for (const [key, entry] of rows) bookLabels[key] = entry.label;
    return { view, ledgers, asset: assetRow[1], book: rows.find(([key]) => key === view.payee)?.[1] ?? null, bookKeys: rows.map(([key]) => key), bookLabels };
  };
  await heldRequest();

  // the evidence the card shows: the sender and the body of the inbox item the held request came from
  const world = loadWorld(o.worldPath, { scenario: acts[1]?.scenario ?? 'B01' });
  const item = world.inbox[0];
  const evidence = new MemoryEvidenceStore();
  if (item !== undefined) {
    const source = { sender: item.from, snippet: item.body, origin: 'replay:inbox' };
    evidence.put(heldView.request_id, { requestHash: requestContentHash(heldView), sources: [{ field: 'amount', ...source }, { field: 'recipient', ...source }] });
  }

  // AIR-303: the recorded attestation of the planner model, shown on the card as recorded (never re-verified in a replay)
  const attestFile = join(dirname(o.chainDir), 'attest', 'z-ai_glm-5.3-flash.json');
  const attestations: Attestation[] = existsSync(attestFile) ? [{ ...(JSON.parse(readFileSync(attestFile, 'utf8')) as Attestation), source: 'recorded' }] : [];

  const clock = Date.parse(files['b01-escalate'].recordedAt);
  const app = createApp({
    mode: 'replay',
    contractId: REPLAY_CONTRACT_ID,
    ownerAccountId: REPLAY_OWNER_ID,
    chain,
    clock: () => clock,
    accessKeys: async () => null,
    evidence,
    runEvents: new GoldenRunSource(files.u01, files['b01-escalate']),
    attestation: { current: () => attestations },
  });

  app.get('/replay/acts', requireSession, (c) => c.json({ acts }));
  app.get('/replay/request/:no', requireSession, async (c) => {
    if (c.req.param('no') !== heldNo) return c.json({ error: 'not found' }, 404);
    return c.json(await heldRequest());
  });
  app.post('/replay/approve/:no', requireSession, (c) => {
    const approve = files['b01-approve'].txs.find((t) => t.label === 'approve');
    if (c.req.param('no') !== heldNo || approve === undefined) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true, tx: approve.hash, url: approve.url });
  });
  app.get('/replay/tamper', requireSession, (c) => {
    const tamper = files.tamper.txs.find((t) => t.label === 'tamper' && t.status === 'failure');
    if (tamper === undefined) return c.json({ error: 'not found' }, 404);
    return c.json({ tx: tamper.hash, url: tamper.url, failure: TAMPER_FAILURE });
  });
  return app;
}

export async function startReplayServer(o: ReplayServerOptions): Promise<ReplayServer> {
  const app = await createReplayApp(o);
  const host = o.host ?? '127.0.0.1';
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: o.port, hostname: host });
    s.once('error', reject);
    s.once('listening', () => {
      s.off('error', reject);
      resolve(s);
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : o.port;
  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

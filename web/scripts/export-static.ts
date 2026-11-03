// AIR-310: writes the replay data of the static build into web/dist-static/data/. It builds the same replay app `pnpm demo` serves (the recorded
// golden runs of bench/golden and the recorded chain views of runtime/recordings/chain), asks it for every answer the replay console reads, and
// saves each response body byte for byte: the JSON answers as .json, the recorded trace stream as the SSE text the server sent. The console
// then parses those files with the functions it uses live (replay/staticApi in api.ts and replay/staticEventSource.ts), so nothing is recomputed.
// This process reads no environment, calls no model and opens no connection: it answers from files through `app.request`.
// Run after `vite build --mode static`: `tsx scripts/export-static.ts [--out <dir>]`. The last line is `STATIC EXPORT OK <n> files`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createReplayApp } from '../../runtime/src/demo/replay-server.ts';
import type { Act } from '../../runtime/src/demo/replay-server.ts';

const root = resolve(import.meta.dirname, '..', '..');
const outArg = process.argv.indexOf('--out');
const outDir = resolve(outArg < 0 ? join(root, 'web', 'dist-static') : (process.argv[outArg + 1] ?? ''), 'data');

const app = await createReplayApp({
  goldenDir: join(root, 'bench', 'golden'),
  chainDir: join(root, 'runtime', 'recordings', 'chain'),
  worldPath: join(root, 'fixtures', 'world.jsonl'),
});

const session = await app.request('/session');
if (session.headers.get('x-airlock-mode') !== 'replay') throw new Error('the export reads a replay server only');
const issued = /airlock_session=[0-9a-f]{64}/.exec(session.headers.get('set-cookie') ?? '')?.[0];
if (issued === undefined) throw new Error('the replay app did not issue a session');
const cookie: string = issued;

let written = 0;
async function save(method: 'GET' | 'POST', path: string, file: string): Promise<string> {
  const res = await app.request(path, { method, headers: { cookie } });
  if (res.status !== 200) throw new Error(`${method} ${path} answered ${String(res.status)}`);
  const body = await res.text();
  const target = join(outDir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  written += 1;
  return body;
}

const enc = encodeURIComponent;
const acts = (JSON.parse(await save('GET', '/replay/acts', 'replay/acts.json')) as { acts: Act[] }).acts;
await save('GET', '/replay/tamper', 'replay/tamper.json');
for (const act of acts) {
  if (act.runId !== null) await save('GET', `/runs/${act.runId}/events`, `runs/${act.runId}.txt`);
  if (act.pendingNo !== null && act.id === 'b01') {
    await save('GET', `/replay/request/${enc(act.pendingNo)}`, `replay/request/${enc(act.pendingNo)}.json`);
    await save('GET', `/api/evidence/${enc(act.pendingNo)}`, `api/evidence/${enc(act.pendingNo)}.json`);
    await save('POST', `/replay/approve/${enc(act.pendingNo)}`, `replay/approve/${enc(act.pendingNo)}.json`);
  }
}
console.log(`STATIC EXPORT OK ${String(written)} files`);
process.exit(0);

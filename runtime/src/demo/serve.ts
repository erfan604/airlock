// `tsx src/demo/serve.ts --golden <dir> [--chain <dir>] [--world <file>] [--port <n>]`: the replay server of `pnpm demo` (AIR-246). It reads its
// arguments from the command line only. A missing recording prints `MISSING <path>` and exits 1: there is never a half started demo.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissingRecording } from './golden.ts';
import { startReplayServer } from './replay-server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  return value === undefined ? fallback : resolve(value);
}

try {
  const portText = process.argv.includes('--port') ? (process.argv[process.argv.indexOf('--port') + 1] ?? '') : '8787';
  const port = /^[0-9]{1,5}$/.test(portText) ? (JSON.parse(portText) as number) : 8787;
  const running = await startReplayServer({
    goldenDir: arg('golden', resolve(repo, 'bench', 'golden')),
    chainDir: arg('chain', resolve(repo, 'runtime', 'recordings', 'chain')),
    worldPath: arg('world', resolve(repo, 'fixtures', 'world.jsonl')),
    port,
  });
  console.log(`replay server ${running.url}`);
} catch (error) {
  console.error(error instanceof MissingRecording ? error.message : `replay server failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}

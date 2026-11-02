// The replay server of the demo e2e (AIR-246): `startReplayServer` on port 0 over the SYNTHETIC golden fixtures of runtime/test/fixtures/demo (real
// recordings are committed by AIR-166's golden runs; this tests the demo code, not the recordings). The page reaches it through the real Vite
// preview proxy, so cookies, the CSP and the /replay routes take the path they take in `pnpm demo`.
import { join } from 'node:path';
import { startReplayServer } from '../../runtime/src/demo/replay-server.ts';
import type { E2ESetup } from './types.ts';

const root = join(import.meta.dirname, '..', '..');
export const FIXTURE_DIR = join(root, 'runtime', 'test', 'fixtures', 'demo');

const setup: E2ESetup = async () => {
  const server = await startReplayServer({
    goldenDir: join(FIXTURE_DIR, 'golden'),
    chainDir: join(FIXTURE_DIR, 'chain'),
    worldPath: join(root, 'fixtures', 'world.jsonl'),
    port: 0,
  });
  return { env: { VITE_RUNTIME_ORIGIN: server.url }, close: () => server.close() };
};

export default setup;

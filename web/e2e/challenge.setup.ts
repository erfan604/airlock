// The challenge service of the challenge e2e (AIR-301): the real service core, log, admission control and HTTP app on port 0, with a scripted
// engine in place of the model and the chain (a text with `evil` in it is held, any other is paid to the booked payee). The page reaches it
// through the real Vite preview proxy, so the CSP, the same origin rule and the event stream take the path they take in production. The
// module keeps the built service so the e2e can add attempts from outside (a chain observation of door b) and watch the page move.
import { parseConfig } from '../../challenge/src/config.ts';
import { build } from '../../challenge/src/compose.ts';
import type { Built } from '../../challenge/src/compose.ts';
import { listen } from '../../challenge/src/listen.ts';
import { createChallengeApp } from '../../challenge/src/server.ts';
import type { Engine, EngineOutput } from '../../challenge/src/types.ts';
import type { E2ESetup } from './types.ts';

const NEAR = 10n ** 24n;
const BOOK = 'near:accountant.testnet';
const out = (o: Partial<EngineOutput['payments'][number]> = {}, extra: Partial<EngineOutput> = {}): EngineOutput => ({
  status: 'DONE',
  payments: [{ payee: BOOK, asset: 'near', amount: (4n * NEAR).toString(), outcome: 'ALLOW', reason: null, toBook: true, ...o }],
  stoppedBy: null,
  tx: null,
  costUsd: '0.001',
  ...extra,
});

export const handle: { built: Built | null } = { built: null };

const engine: Engine = {
  mode: 'live',
  run: (text) =>
    Promise.resolve(
      text.includes('evil')
        ? out({ payee: 'near:evil.testnet', amount: (9n * NEAR).toString(), outcome: 'ESCALATE', reason: 'PayeeNotInBook', toBook: false }, { tx: 'F'.repeat(44) })
        : out({}, { tx: 'G'.repeat(44) }),
    ),
  close: () => Promise.resolve(),
};

const setup: E2ESetup = async () => {
  const base = parseConfig({}, '/repo');
  const cfg = { ...base, mode: 'live' as const, limits: { ...base.limits, perIpMax: 4 } };
  const built = build({ cfg, engine, clock: Date.now, paused: () => false, floatProbe: null, memory: true });
  handle.built = built;
  // the board opens with recorded-style rows of every verdict, as the service seeds it
  built.challenge.seed('own-B01', 'correction email with a larger amount', 'a', out({ outcome: 'ESCALATE', reason: 'OverTaskBound', amount: (9n * NEAR).toString() }));
  built.challenge.seed('own-A01', 'remittance override appended to the invoice file text', 'b', { status: 'DONE', payments: [], stoppedBy: 'BadAmount', tx: null, costUsd: '0' });
  built.challenge.seed('own-U01', 'benign request, no attacker text', 'c', out());
  const app = createChallengeApp({ cfg, challenge: built.challenge, log: built.log, admission: built.admission, addressOf: () => 'e2e', salt: () => 'e2e', clock: Date.now });
  const server = await listen(app, 0, '127.0.0.1');
  return { env: { VITE_RUNTIME_ORIGIN: `http://127.0.0.1:${String(server.port)}` }, close: () => server.close() };
};

export default setup;

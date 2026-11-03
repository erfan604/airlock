// `pnpm challenge`: the Steal this agent service (AIR-301). Reads the process environment here and nowhere else.
//   pnpm challenge                 serve on CHALLENGE_PORT (8788). CHALLENGE_MODE=recorded (default): the board shows the 39 recorded bench
//                                  attacks and door (a) is shut. CHALLENGE_MODE=live: the visitor door and the chain watcher are on; every
//                                  account, key file and cap is named by the environment (config.ts) and a missing one stops the start.
//   pnpm challenge --selftest      replay the 39 bench cases through the real verdict path offline; last line CHALLENGE OK attempts 39 stolen 0
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnInfo } from '@hono/node-server/conninfo';
import { loadModelsConfig } from '@airlock/runtime/llm';
import { ConfigError, parseConfig } from './config.ts';
import { build } from './compose.ts';
import { resolveAddress } from './address.ts';
import { listen } from './listen.ts';
import { createChallengeApp } from './server.ts';
import { RecordedEngine, recordedModel } from './engines/recorded.ts';
import { runSelftest } from './selftest.ts';
import { caseInputText, caseLabel } from './seedcases.ts';
import { loadCases } from '../../bench/src/runner/cases.ts';
import { verdictCliPath } from '../../bench/src/runner/backend.ts';
import type { Engine } from './types.ts';
import { DailySalt } from './visitor.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === '--selftest') return runSelftest({ root: ROOT, out: (l) => console.log(l) });
  if (argv.length > 0) {
    console.error('usage: pnpm challenge [--selftest]');
    return 2;
  }
  let cfg;
  try {
    cfg = parseConfig(process.env, ROOT);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : 'bad configuration');
    return 2;
  }
  const pausedFile = join(cfg.dataDir, 'PAUSED');
  let engine: Engine;
  let floatProbe: (() => Promise<bigint | null>) | null = null;
  let seeder: RecordedEngine | null = null;
  const cases = loadCases(join(ROOT, 'bench', 'cases'));
  const models = loadModelsConfig();
  const recorded = new RecordedEngine({ cases, verdictCli: verdictCliPath(), model: models.planner, quarantineModel: models.quarantine, temperature: models.temperature, seed: models.seed });
  if (cfg.mode === 'live' && cfg.live !== null) {
    try {
      const { liveParts } = await import('./engines/live.wire.ts');
      const parts = await liveParts(cfg.live);
      engine = parts.engine;
      floatProbe = parts.floatProbe;
    } catch (e) {
      console.error(`live mode did not start: ${e instanceof Error ? e.message.slice(0, 160) : 'failed'}`);
      return 2;
    }
    seeder = recorded;
  } else {
    engine = recorded;
    seeder = recorded;
  }
  const built = build({ cfg, engine, clock: Date.now, paused: () => existsSync(pausedFile), floatProbe });
  // the board opens with the recorded bench attacks: an empty log is seeded once, from the committed recordings, offline
  if (built.log.size === 0 && seeder !== null) {
    const model = recordedModel(join(ROOT, 'bench', 'runs', 'recorded', 'llm'));
    const saved = process.env['LLM_MODE'];
    process.env['LLM_MODE'] = 'replay';
    model.install();
    try {
      for (const c of cases) built.challenge.seed(c.id, caseLabel(c), caseInputText(c), await seeder.runCase(c));
    } finally {
      model.uninstall();
      if (saved === undefined) delete process.env['LLM_MODE'];
      else process.env['LLM_MODE'] = saved;
    }
    console.log(`seeded ${String(built.log.size)} recorded attempts`);
  }
  const salt = new DailySalt();
  const app = createChallengeApp({
    cfg,
    challenge: built.challenge,
    log: built.log,
    admission: built.admission,
    addressOf: (c) => {
      let remote: string | undefined;
      try {
        remote = getConnInfo(c).remote.address;
      } catch {
        remote = undefined;
      }
      const r = resolveAddress({ header: cfg.proxyHeader, trusted: cfg.trustedProxies }, remote, (name) => c.req.header(name));
      return r.ok ? r.address : null;
    },
    salt: () => salt.current(),
    clock: Date.now,
  });
  await listen(app, cfg.port, cfg.host);
  console.log(`challenge ${cfg.mode} listening http://${cfg.host}:${String(cfg.port)} (door a ${cfg.mode === 'live' ? 'open' : 'shut'})`);
  return -1;
}

const code = await main(process.argv.slice(2));
if (code >= 0) process.exit(code);

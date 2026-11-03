// Builds the service from a config and an engine: the log (a file under the data dir), the spend ledger, admission control and the core.
import { join } from 'node:path';
import { toBaseUnits } from '@airlock/runtime/money';
import type { ChallengeConfig } from './config.ts';
import { AdmissionControl, SpendLedger } from './limits.ts';
import type { Limits } from './limits.ts';
import { AttemptLog } from './log.ts';
import { Challenge } from './service.ts';
import type { Engine } from './types.ts';

export interface Built {
  challenge: Challenge;
  log: AttemptLog;
  admission: AdmissionControl;
}

export interface BuildOptions {
  cfg: Pick<ChallengeConfig, 'mode' | 'dataDir'> & { limits: Limits };
  engine: Engine;
  clock(): number;
  paused(): boolean;
  floatProbe: (() => Promise<bigint | null>) | null;
  /** keep the log and the ledger in memory (the selftest and tests) */
  memory?: boolean;
  newId?(): string;
}

export function build(o: BuildOptions): Built {
  const log = new AttemptLog(o.memory === true ? null : join(o.cfg.dataDir, 'attempts.jsonl'));
  const ledger = new SpendLedger(o.memory === true ? null : join(o.cfg.dataDir, 'spend.json'), toBaseUnits(o.cfg.limits.llmCapUsd, 9));
  const admission = new AdmissionControl({ limits: o.cfg.limits, clock: o.clock, paused: o.paused, liveEnabled: o.engine.mode === 'live', ledger, floatProbe: o.floatProbe });
  const challenge = new Challenge({ engine: o.engine, log, admission, clock: o.clock, ...(o.newId === undefined ? {} : { newId: o.newId }) });
  return { challenge, log, admission };
}

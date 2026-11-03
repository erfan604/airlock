// Shared fixtures of the challenge tests: a fake engine, a built service on memory, and payment rows.
import { build } from '../src/compose.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import type { Limits } from '../src/limits.ts';
import type { Engine, EngineOutput, Mode, PaymentRow } from '../src/types.ts';

export const NEAR = 10n ** 24n;
export const near = (n: number): string => (BigInt(n) * NEAR).toString();

export const row = (o: Partial<PaymentRow> = {}): PaymentRow => ({ payee: 'near:accountant.testnet', asset: 'near', amount: near(4), outcome: 'ALLOW', reason: null, toBook: true, ...o });

export const output = (o: Partial<EngineOutput> = {}): EngineOutput => ({ status: 'DONE', payments: [row()], stoppedBy: null, tx: null, costUsd: '0.002', ...o });

export class FakeEngine implements Engine {
  calls: string[] = [];
  next: () => Promise<EngineOutput> = () => Promise.resolve(output());
  constructor(readonly mode: Mode = 'live') {}
  async run(text: string): Promise<EngineOutput> {
    this.calls.push(text);
    return this.next();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Rig {
  clock: { now: number };
  engine: FakeEngine;
  built: ReturnType<typeof build>;
  paused: { value: boolean };
  probe: { value: bigint | null | 'throw' };
}

export function rig(limits: Partial<Limits> = {}, mode: Mode = 'live', withProbe = false): Rig {
  const clock = { now: Date.parse('2026-11-03T12:00:00Z') };
  const engine = new FakeEngine(mode);
  const paused = { value: false };
  const probe: Rig['probe'] = { value: 100n * NEAR };
  let n = 0;
  const built = build({
    cfg: { mode, dataDir: '.', limits: { ...DEFAULT_LIMITS, ...limits } },
    engine,
    clock: () => clock.now,
    paused: () => paused.value,
    floatProbe: withProbe
      ? async () => {
          if (probe.value === 'throw') throw new Error('rpc down');
          return probe.value;
        }
      : null,
    memory: true,
    newId: () => (n++).toString(16).padStart(16, '0'),
  });
  return { clock, engine, built, paused, probe };
}

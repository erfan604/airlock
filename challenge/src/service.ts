// The challenge service core: admission, one engine, the log. The HTTP layer and the selftest both drive this and nothing else, so what the
// selftest proves is the path a visitor takes. A seeded attempt (the bench cases) skips admission because it is not a visitor and costs
// nothing: it comes from a recorded engine run, never from the live path.
import { randomBytes } from 'node:crypto';
import { buildAttempt } from './attempt.ts';
import { AttemptLog } from './log.ts';
import { AdmissionControl } from './limits.ts';
import type { Attempt, Door, Engine, EngineOutput, Mode, Refusal } from './types.ts';

export interface ServiceDeps {
  engine: Engine;
  log: AttemptLog;
  admission: AdmissionControl;
  clock(): number;
  newId?(): string;
}

export type AttemptResult = { ok: true; attempt: Attempt } | { ok: false; code: Refusal; retryAfterMs: number | null };

export class Challenge {
  constructor(private readonly d: ServiceDeps) {}

  get mode(): Mode {
    return this.d.engine.mode;
  }

  private id(): string {
    return (this.d.newId ?? ((): string => randomBytes(8).toString('hex')))();
  }

  private record(door: Door, source: string, label: string | null, text: string, keepPreview: boolean, out: EngineOutput): Attempt {
    const attempt = buildAttempt({
      seq: this.d.log.nextSeq(),
      id: this.id(),
      at: new Date(this.d.clock()).toISOString(),
      door,
      mode: this.d.engine.mode,
      source,
      label,
      text,
      keepPreview,
      out,
    });
    this.d.log.append(attempt);
    return attempt;
  }

  /** Door (a): a visitor's text through the engine. `visitor` is a salted hash of the address, `source` the short form the log shows. */
  async attempt(visitor: string, source: string, text: string): Promise<AttemptResult> {
    const admitted = await this.d.admission.admit(visitor, text);
    if (!admitted.ok) return admitted;
    let out: EngineOutput;
    try {
      out = await this.d.engine.run(text);
    } catch {
      // the engine's message can carry text from outside: the refusal names only the code
      admitted.ticket.abort();
      return { ok: false, code: 'engine_failed', retryAfterMs: 5000 };
    }
    let moved = 0n;
    for (const p of out.payments) if (p.outcome === 'ALLOW') moved += BigInt(p.amount);
    admitted.ticket.settle({ costUsd: out.costUsd, movedYocto: moved });
    return { ok: true, attempt: this.record('text', source, null, text, true, out) };
  }

  /** A recorded case as the first rows of the board (no admission, no spend). */
  seed(caseId: string, label: string | null, text: string, out: EngineOutput): Attempt {
    return this.record('seed', `bench:${caseId}`, label, text, false, out);
  }

  /** An attempt observed on chain through the published key (door b). The chain watcher calls this once per request it has not seen. */
  observeKey(source: string, text: string, out: EngineOutput): Attempt {
    return this.record('key', source, null, text, false, out);
  }
}

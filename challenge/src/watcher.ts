// Door (b): the published key calls the policy contract directly, with no service in between, so the board learns of those attempts by
// reading the chain. The source is injected (an indexer or the policy's own request views); this loop only turns each new observation into one
// attempt, once. A source that throws is skipped for that round and tried again: a watcher that is behind never changes a verdict.
import type { Challenge } from './service.ts';
import type { EngineOutput } from './types.ts';

export interface KeyObservation {
  /** the contract's request id, the dedupe key */
  requestId: string;
  payee: string;
  asset: string;
  amount: string;
  outcome: 'ALLOW' | 'ESCALATE' | 'BLOCK';
  reason: string | null;
  tx: string | null;
  /** the payee is in the owner's book */
  toBook: boolean;
}

export interface KeyWatcherSource {
  /** observations the source has not returned before; the source keeps its own cursor */
  poll(): Promise<KeyObservation[]>;
}

export function observationOutput(o: KeyObservation): EngineOutput {
  return {
    status: 'DONE',
    payments: [{ payee: o.payee, asset: o.asset, amount: o.amount, outcome: o.outcome, reason: o.reason, toBook: o.toBook }],
    stoppedBy: null,
    tx: o.tx,
    costUsd: '0',
  };
}

export class KeyWatcher {
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly source: KeyWatcherSource,
    private readonly challenge: Challenge,
  ) {}

  /** One round; returns how many attempts it added. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      let added = 0;
      for (const o of await this.source.poll()) {
        if (this.seen.has(o.requestId)) continue;
        this.seen.add(o.requestId);
        this.challenge.observeKey(`key:${o.requestId.slice(0, 12)}`, `submit_batch ${o.requestId}`, observationOutput(o));
        added += 1;
      }
      return added;
    } catch {
      return 0;
    } finally {
      this.busy = false;
    }
  }

  start(everyMs: number): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

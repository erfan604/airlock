// AIR-222: a gate that is broken on purpose. It answers `allowed` for every request, whatever the labels, the caps or the task, and applies
// the payment to the SimWorld, so the assume-compromise counters have something to count. A counter that stays at 0 against this backend
// counts nothing (check 3 of the ticket and test 1 run the raw source against it).
import { requestId } from '@airlock/runtime/chain-ids';
import type { BatchResult, RequestView, SignedEvent } from '@airlock/runtime/chain-types';
import { isValueTrusted, taskHash } from '@airlock/runtime/dsl';
import type { ActionRequest, OwnerTask } from '@airlock/runtime/dsl';
import type { SimWorld } from '../../src/oracles/index.ts';
import type { CliSetup, GateBackend, PaymentClassifier } from '../../src/runner/backend.ts';
import { BENCH_T0_MS } from '../../src/runner/task.ts';
import type { PaymentFact } from '../../src/runner/types.ts';

const NOBODY: PaymentClassifier = () => ({ attacker: false, legit: false });

export class BrokenBackend implements GateBackend {
  private world: SimWorld | undefined;
  private classifier: PaymentClassifier = NOBODY;
  private facts: PaymentFact[] = [];
  private batches = 0;

  begin(_setup: CliSetup, world: SimWorld, classifyRequest?: PaymentClassifier): void {
    this.world = world;
    this.classifier = classifyRequest ?? NOBODY;
    this.facts = [];
    this.batches = 0;
  }

  submitBatch(reqs: ActionRequest[], task: OwnerTask, _taskSig: Uint8Array, opts: { retry?: boolean; nowMs?: number } = {}): Promise<BatchResult> {
    const world = this.world;
    if (world === undefined) return Promise.reject(new Error('begin() was not called'));
    const nowMs = opts.nowMs ?? BENCH_T0_MS;
    const outcomes = reqs.map((req) => {
      const id = requestId(task, req.action_index);
      const amount = BigInt(req.amount);
      world.execute({ requestId: id, payee: req.payee, asset: req.asset, amount, nowMs, amountUntrusted: !isValueTrusted(req.labels.amount) });
      const cls = this.classifier({ payee: req.payee, asset: req.asset, amount });
      this.facts.push({
        id,
        payee: req.payee,
        asset: req.asset,
        amount: req.amount,
        outcome: 'ALLOW',
        reason: null,
        attackerInfluenced: cls.attacker,
        legitMatch: cls.legit,
      });
      return { request_id: id, outcome: 'allowed' as const, reason: null, pending_id: null };
    });
    this.batches += 1;
    return Promise.resolve({ taskHash: taskHash(task), txHash: `broken:${this.batches}`, outcomes, events: [], recovered: false, views: [] });
  }

  getRequest(_id: string): Promise<RequestView | null> {
    return Promise.resolve(null);
  }

  waitSigned(_requestId: string, _timeoutMs: number): Promise<SignedEvent> {
    return Promise.reject(new Error('BrokenBackend does not sign'));
  }

  payments(): PaymentFact[] {
    return this.facts.map((f) => ({ ...f }));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

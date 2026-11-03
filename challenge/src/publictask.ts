// The public task of door (b). A function-call key alone cannot build a valid `submit_batch`: the contract also wants a task signed by the
// owner's task key. A compromised agent holds that signed task too, so the board publishes one, next to the key: the owner's real signature
// over a real bound. Challengers then hold everything a compromised agent would hold, and the board shows whether they can move value past
// the bound (another payee, a bigger amount, a replay, a call after expiry). The task carries no secret: it is a signature over a bound.
// The task key stays behind `sign`; this module never sees it, and rotation re-signs a fresh task before the old one expires.
import { createHash } from 'node:crypto';
import { TASK_TAG } from '@airlock/runtime/dsl';
import type { OwnerTask } from '@airlock/runtime/dsl';
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';

export interface PublicTaskParams {
  ownerAccount: string;
  agentAccount: string;
  policyAccount: string;
  /** the one booked payee the task may pay */
  payee: string;
  /** most the task may pay that payee in total, as a NEAR decimal such as "2" */
  maxTotalNear: string;
  maxActions: number;
  /** how long one task lives, and how soon before expiry the next one replaces it */
  ttlMs: number;
  rotateBeforeMs: number;
  /** issued_ms is set this far in the past so a chain clock slightly behind ours still accepts it */
  skewMs: number;
}

export interface PublishedTask {
  task: OwnerTask;
  /** base64 of the Ed25519 signature over the borsh task bytes: the `task_sig` argument of submit_batch */
  task_sig: string;
  issuedAt: string;
  expiresAt: string;
  /** plain facts for the page */
  permits: { payee: string; asset: 'NEAR'; maxTotal: string; maxActions: number; agent: string; contract: string; ttlMinutes: number };
}

export const DEFAULT_PUBLIC_TASK = { maxTotalNear: '2', maxActions: 5, ttlMs: 55 * 60_000, rotateBeforeMs: 10 * 60_000, skewMs: 60_000 } as const;

export class PublicTask {
  private cur: PublishedTask | null = null;
  private pending: Promise<PublishedTask | null> | null = null;

  constructor(
    private readonly p: PublicTaskParams,
    /** Ed25519 over the borsh bytes of the task, base64 */
    private readonly sign: (task: OwnerTask) => Promise<string>,
    private readonly clock: () => number,
  ) {}

  /** The task to show now; a new one is signed when none exists or the current one is within `rotateBeforeMs` of expiry. Null if signing fails. */
  async current(): Promise<PublishedTask | null> {
    const now = this.clock();
    if (this.cur !== null && Date.parse(this.cur.expiresAt) - now > this.p.rotateBeforeMs) return this.cur;
    this.pending ??= this.issue(now).finally(() => {
      this.pending = null;
    });
    const next = await this.pending;
    // a failed rotation keeps the old task only while it is still valid
    if (next === null && this.cur !== null && Date.parse(this.cur.expiresAt) > now) return this.cur;
    return next ?? null;
  }

  private async issue(now: number): Promise<PublishedTask | null> {
    const p = this.p;
    const issued = now - p.skewMs;
    const expires = issued + p.ttlMs;
    const task: OwnerTask = {
      tag: TASK_TAG,
      task_id: `challenge-public-${String(now)}`,
      contract_id: p.policyAccount,
      agent_id: p.agentAccount,
      plan_sha256: createHash('sha256').update('challenge-public-task-plan', 'ascii').digest('hex'),
      instruction_sha256_salted: createHash('sha256').update('challenge-public-task-instruction', 'ascii').digest('hex'),
      issued_ms: issued,
      expires_ms: expires,
      max_actions: p.maxActions,
      bounds: [{ payee_key: p.payee, max_total: toBaseUnits(p.maxTotalNear, 24).toString() }],
    };
    let sig: string;
    try {
      sig = await this.sign(task);
    } catch {
      return null;
    }
    const maxTotal = formatBaseUnits(BigInt(task.bounds[0]?.max_total ?? '0'), 24);
    this.cur = {
      task,
      task_sig: sig,
      issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      permits: { payee: p.payee, asset: 'NEAR', maxTotal, maxActions: p.maxActions, agent: p.agentAccount, contract: p.policyAccount, ttlMinutes: Math.round(p.ttlMs / 60_000) },
    };
    return this.cur;
  }
}

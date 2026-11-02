// The shared types of the bench runner (AIR-277). Configurations follow F12 3.2, SPEC R5-17 and GLOSSARY: V0 the vanilla agent, V1 an
// allowlist with origin-blind limits equal to AIRLOCK's daily_limit per payee, V1-tight the same with the book cap, V2 spotlighting (run only
// when built), V3 approve-every-payment (never run, derived from V0 records), A1 AIRLOCK strict (a null payee cap in the CLI setup) and A2
// AIRLOCK default (the product). A1 and A2 share the plan, the task and the proposals; nothing but the payee cap differs.
export type Config = 'V0' | 'V1' | 'V1-tight' | 'V2' | 'V3' | 'A1' | 'A2';

/** One payment of a run, as the gate or a baseline decided it. */
export interface PaymentFact {
  /** the request id (AIRLOCK) or `call:<n>` (baselines) */
  id: string;
  payee: string;
  asset: string;
  /** base units as a decimal string */
  amount: string;
  /** ALLOW executed with no approval, ESCALATE left pending, BLOCK refused (the gate, or the V1 policy) */
  outcome: 'ALLOW' | 'ESCALATE' | 'BLOCK';
  /** the verdict Reason name, or `policy` */
  reason: string | null;
  attackerInfluenced: boolean;
  legitMatch: boolean;
}

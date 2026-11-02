// V1 and V1-tight (AIR-146): an allowlist and limits in front of the signer, with no provenance. The numbers come from `v1PolicyFor`
// (AIR-224, SPEC R5-17): the per-payee limit is the book daily_limit for V1 and the book cap for V1-tight, not a rule keyed to the
// legitimate amount of a case. The wrapper changes only the signer the agent receives; the agent function is the same V0.
import type { Signer, VanillaAgent } from './vanilla.ts';

export type V1Policy = {
  allow: ReadonlySet<string>;
  perTxLimit: ReadonlyMap<string, bigint>;
  assetLimits: Record<string, { hardCap: bigint; dailyCap: bigint }>;
};

const REFUSED = { executed: false, reason: 'policy' } as const;

/**
 * An agent whose payments pass the policy first. A payment is refused (reason `policy`, no signer call) when its payee is not allowed or has
 * no limit entry (fail closed), the amount is above that payee's limit or the asset's hard cap, the asset has no limits entry, or the sum
 * this run has already executed for the asset plus the amount is above the daily cap. The sum is built per run: it starts at zero on every call.
 */
export function withContentPolicy(agent: VanillaAgent, policy: V1Policy): VanillaAgent {
  return (request, world, model, signer, opts) => {
    const spent = new Map<string, bigint>();
    const guarded: Signer = {
      decimalsOf: (asset) => signer.decimalsOf(asset),
      async transfer(p) {
        const limits = Object.hasOwn(policy.assetLimits, p.asset) ? policy.assetLimits[p.asset] : undefined;
        const perTx = policy.perTxLimit.get(p.payee);
        const already = spent.get(p.asset) ?? 0n;
        if (
          !policy.allow.has(p.payee) ||
          perTx === undefined ||
          limits === undefined ||
          p.amount > perTx ||
          p.amount > limits.hardCap ||
          already + p.amount > limits.dailyCap
        ) {
          return { ...REFUSED };
        }
        const sent = await signer.transfer(p);
        if (sent.executed) spent.set(p.asset, already + p.amount);
        return sent;
      },
    };
    return agent(request, world, model, guarded, opts);
  };
}

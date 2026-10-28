// The simulated world the volume runs judge: the owner's balances, the executed payments and the pending queue. It moves value
// only through `execute`, which refuses what the contract would refuse for lack of balance. The state it hands out is always a
// deep copy.
import { toBaseUnits } from '@airlock/runtime/money';
import { judge } from './oracle.ts';
import type { Oracle } from './oracle.ts';
import type { AssetId, ChainState, SimExecuted, SimPending } from './types.ts';

const OWNER = 'owner';

// an own data property, so an account named like a prototype key is just an account
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export class SimWorld {
  // asset -> account -> balance; Maps, so no key is special
  private readonly balances = new Map<AssetId, Map<string, bigint>>();
  private readonly executed: SimExecuted[] = [];
  private readonly pending: SimPending[] = [];

  /** `balances` is the owner's balance per asset in whole-unit decimal strings, converted with the asset's decimals. */
  constructor(init: { balances: Record<AssetId, string>; decimalsOf(asset: AssetId): number }) {
    for (const asset of Object.keys(init.balances)) {
      const text = init.balances[asset];
      if (text === undefined) continue;
      this.balances.set(asset, new Map([[OWNER, toBaseUnits(text, init.decimalsOf(asset))]]));
    }
  }

  /**
   * Moves `amount` from the owner to `payee` and records the payment. Returns false and changes nothing when the owner's balance
   * is lower (the simulation of InsufficientBalance) or the amount is not positive.
   */
  execute(e: { requestId: string; payee: string; asset: AssetId; amount: bigint; nowMs: number; amountUntrusted: boolean; viaApproval?: boolean }): boolean {
    const accounts = this.balances.get(e.asset);
    const owner = accounts?.get(OWNER) ?? 0n;
    if (accounts === undefined || typeof e.amount !== 'bigint' || e.amount <= 0n || owner < e.amount) return false;
    accounts.set(OWNER, owner - e.amount);
    accounts.set(e.payee, (accounts.get(e.payee) ?? 0n) + e.amount);
    this.executed.push({
      requestId: e.requestId,
      payee: e.payee,
      asset: e.asset,
      amount: e.amount,
      nowMs: e.nowMs,
      amountUntrusted: e.amountUntrusted,
      viaApproval: e.viaApproval ?? false,
    });
    return true;
  }

  /** Queues a request that an approver may act on; nothing moves. */
  addPending(p: SimPending): void {
    this.pending.push({ ...p });
  }

  snapshot(): ChainState {
    const balances: Record<AssetId, Record<string, bigint>> = {};
    for (const [asset, accounts] of this.balances) {
      const copy: Record<string, bigint> = {};
      for (const [account, amount] of accounts) setOwn(copy, account, amount);
      setOwn(balances, asset, copy);
    }
    return { balances, executed: this.executed.map((e) => ({ ...e })), pending: this.pending.map((p) => ({ ...p })) };
  }
}

/** The oracle of the volume runs: it snapshots one SimWorld and judges with the pure function. */
export class SimOracle implements Oracle {
  constructor(private readonly world: SimWorld) {}

  snapshot(): ChainState {
    return this.world.snapshot();
  }

  judge = judge;
}

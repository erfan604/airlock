// AIR-329: the two transactions an LP signs on the credit pool, built as exactly one FunctionCall each (the same discipline as wallet/approve.ts).
// `deposit` attaches the NEAR the LP puts in; `withdraw` attaches 1 yoctoNEAR and names the shares to redeem. Method and argument names follow the
// AIR-328 ticket's view and event shapes; the page keeps them disabled while no pool is deployed (fixture mode).
import { currentWallet } from '../wallet/connector.ts';

const TGAS = 1_000_000_000_000n;
export const DEPOSIT_TGAS = 60n;
export const WITHDRAW_TGAS = 80n;

export type PoolCall = {
  receiverId: string;
  actions: [{ type: 'FunctionCall'; params: { methodName: 'deposit' | 'withdraw'; args: Record<string, string>; gas: string; deposit: string } }];
};

export function depositCall(pool: string, yocto: bigint): PoolCall {
  if (yocto <= 0n) throw new Error('a deposit must be more than 0');
  return { receiverId: pool, actions: [{ type: 'FunctionCall', params: { methodName: 'deposit', args: {}, gas: (DEPOSIT_TGAS * TGAS).toString(), deposit: yocto.toString() } }] };
}

export function withdrawCall(pool: string, shares: bigint): PoolCall {
  if (shares <= 0n) throw new Error('a withdrawal must redeem more than 0 shares');
  return { receiverId: pool, actions: [{ type: 'FunctionCall', params: { methodName: 'withdraw', args: { shares: shares.toString() }, gas: (WITHDRAW_TGAS * TGAS).toString(), deposit: '1' } }] };
}

export type SendResult = { ok: true; tx: string } | { ok: false; reason: 'cancelled' | 'failed' };

type Outcome = { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } } | null | undefined;

/** Sends one call through the connected wallet (the selector opens when none is connected). A rejected prompt is `cancelled`, anything else `failed`. */
export async function sendPoolCall(call: PoolCall, wallet: () => Promise<{ signAndSendTransaction(c: PoolCall): Promise<unknown> }> = currentWallet as never): Promise<SendResult> {
  try {
    const w = await wallet();
    const out = (await w.signAndSendTransaction(call)) as Outcome;
    const hash = out?.transaction?.hash ?? out?.transaction_outcome?.id;
    return { ok: true, tx: typeof hash === 'string' ? hash : '' };
  } catch (e) {
    const text = e instanceof Error ? e.message : '';
    return { ok: false, reason: /reject|cancel|denied|Iframe not loaded/i.test(text) ? 'cancelled' : 'failed' };
  }
}

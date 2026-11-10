// AIR-336: the card pays the merchant the 0.01 NEAR invoice in most rounds. When the card's spendable balance falls under 0.6 NEAR, the round
// first sends the merchant's balance above 0.1 NEAR back to the card, a plain transfer signed by the merchant's own local key. No faucet, ever.
import { MERCHANT_KEEP_YOCTO, RECYCLE_TRIGGER_YOCTO } from './facts.ts';

/** The amount to send back from the merchant to the card, or null when no recycle is due. */
export function recycleAmount(cardSpendable: bigint, merchantBalance: bigint): bigint | null {
  if (cardSpendable >= RECYCLE_TRIGGER_YOCTO) return null;
  if (merchantBalance <= MERCHANT_KEEP_YOCTO) return null;
  return merchantBalance - MERCHANT_KEEP_YOCTO;
}

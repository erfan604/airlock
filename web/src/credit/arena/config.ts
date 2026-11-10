// AIR-336: the Credit Arena's public facts for the page. An arena attempt is a submit_batch of the card's agent account on the card whose owner
// task id starts with the arena prefix, whichever of the agent's keys signed it (the arena's own function-call key, or the agent's key while
// that one is not on the account). Every count the strip shows is read from the chain, nothing is hardcoded. No key is here.
import { CREDIT_CARD, CREDIT_NET } from '../net.ts';

/** The prefix of every arena round's owner task id (runtime/src/arena/facts.ts ARENA_TASK_PREFIX; scripts/credit-arena.test.ts checks they agree). */
export const ARENA_TASK_PREFIX = 'arena-';
export const ARENA_CARD = CREDIT_CARD;
export const ARENA_AGENT = `agent.${CREDIT_NET}.testnet`;
export const ARENA_MERCHANT_KEY = `near:merchant.${CREDIT_NET}.testnet`;
/** The booked invoice of every round, 0.01 NEAR, which the round's owner task also sets as the merchant's bound. */
export const ARENA_INVOICE_YOCTO = '10000000000000000000000';
/**
 * When the coordinator's cron started (ms since the epoch), or null. The cadence word ("every hour") shows only once this is at least 24 h old
 * AND the chain shows at least CADENCE_MIN_ATTEMPTS attempts.
 */
export const ARENA_CRON_SINCE_MS: number | null = 1794296724000; // 2026-11-10T07:45:24Z, the first keep-alive run that calls the arena and the loop
/**
 * When the card took its strict book root (AIR-355, ms since the epoch), or null. Set by the coordinator once `credit-strict.ts --verify`
 * answers CREDIT STRICT OK; until then the strip keeps the wording of the capped book.
 */
export const ARENA_STRICT_SINCE_MS: number | null = 1794294892027; // 2026-11-10T07:14:52Z, book_set_root 3facSJMXLUG61w8h8AZhA2EREdx17cZ6Wks35vc94tZo, verified CREDIT STRICT OK epoch 2
export const CADENCE_MIN_ATTEMPTS = 6;
/** "Live" is said only while the last attempt is younger than this. */
export const LIVE_WINDOW_MS = 3 * 3_600_000;
export const CADENCE_LOG_MS = 24 * 3_600_000;

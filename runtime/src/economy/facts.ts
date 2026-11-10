// AIR-359 (lane1 part): the fixed facts of the hourly economy loop on the credit pool of the AIR-330 run (airlock-credit-c1108d, NEAR
// testnet). The borrower, the merchant, the issuer and the agent are accounts the team runs, and the fee comes from the team's money: the
// loop shows how the pool works, it is not a market. Every number the stop rules use is here.
export const ECONOMY_NET = 'airlock-credit-c1108d';
export const ECONOMY_ACCOUNTS = {
  issuer: `${ECONOMY_NET}.testnet`,
  pool: `pool.${ECONOMY_NET}.testnet`,
  card: `card.${ECONOMY_NET}.testnet`,
  agent: `agent.${ECONOMY_NET}.testnet`,
  merchant: `merchant.${ECONOMY_NET}.testnet`,
  borrower: `borrower.${ECONOMY_NET}.testnet`,
} as const;

export const YOCTO_PER_NEAR = 10n ** 24n;
/** Every loop payment's owner task id starts with this: it is how the loop's own transactions and held requests are told apart. */
export const LOOP_TASK_PREFIX = 'loop-';
/** The arena's task prefix (runtime/src/arena/facts.ts): its holds are expected on the card and do not stop the loop. */
export const ARENA_TASK_PREFIX = 'arena-';

/**
 * The line of one cycle: 0.09 NEAR. Under a tenth of the Passport base of 1 NEAR, so a loop repay never counts toward the team borrower's
 * score (the pool counts a repay only from base / 10), and under the cap of 0.4 NEAR the backfilled borrower has after the upgrade.
 */
export const LOOP_LIMIT_YOCTO = 9n * 10n ** 22n;
/** 10 percent, paid by the borrower to the pool's lenders. */
export const LOOP_FEE_BPS = 1000;
/** The line is due a day after it opens: a stopped computer does not impair the pool within the hour. */
export const LOOP_TERM_MS = 24 * 3_600_000;
/** The life of the owner task of the payment. */
export const LOOP_TASK_TTL_MS = 20 * 60_000;

export const MIN_CYCLE_SPACING_MS = 55 * 60_000;
/** The loop stays away from a fresh arena round. */
export const ARENA_QUIET_MS = 10 * 60_000;
export const IDLE_FLOOR_YOCTO = 2n * 10n ** 23n;
export const BORROWER_FLOOR_YOCTO = 2n * 10n ** 23n;
export const AGENT_FLOOR_YOCTO = 10n ** 23n;
/** The issuer pays the gas of open_line. */
export const ISSUER_FLOOR_YOCTO = 10n ** 23n;
/** The pool's NEAR that is neither storage, idle liquidity nor collateral: under this the loop stops and says ALERT. */
export const BUFFER_FLOOR_YOCTO = 3n * 10n ** 23n;
export const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
/** A loop repay must stay under base / this, so it does not count toward the Passport. */
export const PASSPORT_FLOOR_DIV = 10n;

/** The merchant keeps this much and sends the rest back to the borrower. */
export const MERCHANT_KEEP_YOCTO = 10n ** 23n;
/** Less than this above the keep is not worth a transfer. */
export const MIN_RECYCLE_YOCTO = 5n * 10n ** 22n;
/** Under this balance the borrower gets the merchant's balance back at once, not only once a day. */
export const BORROWER_LOW_YOCTO = YOCTO_PER_NEAR;
/** A hold is expired this long after its time, so the block clock is past it too. */
export const EXPIRE_MARGIN_MS = 30_000;

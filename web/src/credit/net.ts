// AIR-330: the one place that names the live AIRLOCK Credit accounts on NEAR testnet. They share a parent account; a redeploy on new accounts is a change
// of CREDIT_NET and nothing else. The /credit page reads the pool, /approvals reads the card policy of the line. No transaction hash is written in the
// UI: every hash it shows is read from the chain.
export const CREDIT_NET = 'airlock-credit-c1108d';
export const CREDIT_POOL = `pool.${CREDIT_NET}.testnet`;
export const CREDIT_CARD = `card.${CREDIT_NET}.testnet`;

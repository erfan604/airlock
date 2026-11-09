// The pool state as deployed on c1108d (version 1, AIR-328), kept verbatim so `migrate` can read it (AIR-333). Never edit this struct: its
// field order and types are the bytes stored on chain. A later upgrade adds a `PoolV2` here and a new migrate that reads it.
use crate::Card;
use near_sdk::AccountId;
use near_sdk::near;
use near_sdk::store::{IterableMap, LookupMap};

#[near(serializers = [borsh])]
pub struct PoolV1 {
    pub owner_id: AccountId,
    pub collateral_bps: u32,
    pub total_shares: u128,
    pub idle: u128,
    pub lent: u128,
    pub staked: u128,
    pub fees_earned: u128,
    pub losses: u128,
    pub collateral_held: u128,
    pub lps: LookupMap<AccountId, u128>,
    pub cards: IterableMap<AccountId, Card>,
    pub unclaimed: LookupMap<AccountId, u128>,
    pub locks: LookupMap<AccountId, u64>,
    pub min_hold_ms: u64,
}

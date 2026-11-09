// AIRLOCK Credit (AIR-328, docs/design/credit.md): LPs stake NEAR into a pool and hold shares; the pool's issuer opens credit lines that fund
// AIRLOCK card policies (AIR-327); what a card spends comes back through `sweep` (as `on_card_return`) and `repay`, with a fee that raises the
// share price. One asset, integer math, rounding in the pool's favour. Pool accounting uses its own fields (`idle`, `lent`, `staked`), never
// the contract balance, so a plain transfer to the contract cannot move the share price. Every state change happens before the promise that
// moves NEAR; a transfer that can fail has a callback that restores the state or parks the amount for `claim`.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near,
    require,
};

pub mod math;

/// The smallest deposit: 0.001 NEAR (it blunts rounding games on a tiny pool).
pub const MIN_DEPOSIT: u128 = 1_000_000_000_000_000_000_000;
/// The most a line may charge: 50 percent of what the card kept.
pub const MAX_FEE_BPS: u32 = 5_000;
/// The longest line: 90 days.
pub const MAX_TERM_MS: u64 = 90 * 24 * 3_600_000;
/// The default collateral ratio: 30 percent of the limit.
pub const DEFAULT_COLLATERAL_BPS: u32 = 3_000;
/// The most lines a view returns.
pub const MAX_PAGE: u32 = 50;
/// The most cards a pool registers: the share price walks the lines to impair overdue ones.
pub const MAX_CARDS: u32 = 100;
const GAS_ROLES: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    Lps,
    Cards,
    Unclaimed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineState {
    Collecting,
    Open,
    Repaid,
    Defaulted,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Line {
    pub limit: u128,
    pub returned: u128,
    pub fee_bps: u32,
    pub due_ms: u64,
    pub collateral: u128,
    pub state: LineState,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Card {
    pub borrower: AccountId,
    pub line: Option<Line>,
    /// the principal still lost after a default (recoveries lower it, `write_off` clears it); it lives on the card, not on a line, so no
    /// new line can erase it, and a card with a loss takes no new line
    pub loss: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineView {
    pub card: AccountId,
    pub borrower: AccountId,
    pub limit: U128,
    pub drawn: U128,
    pub returned: U128,
    pub fee_bps: u32,
    pub due_ms: near_sdk::json_types::U64,
    pub collateral: U128,
    pub state: LineState,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolView {
    pub assets: U128,
    pub shares: U128,
    pub idle: U128,
    pub staked: U128,
    pub lent: U128,
    /// the outstanding principal of lines past their due date, counted as 0 in `assets` and the share price until recovered
    pub impaired: U128,
    pub fees_earned: U128,
    pub losses: U128,
    pub collateral_held: U128,
    pub collateral_bps: u32,
    pub share_price: U128,
    pub lines: Vec<LineView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpView {
    pub shares: U128,
    pub value: U128,
}

/// What the card's `get_roles` answers (AIR-327).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CardRoles {
    pub owner_id: AccountId,
    pub approver: Option<AccountId>,
    pub sponsor: Option<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    pub owner_id: AccountId,
    pub collateral_bps: u32,
    pub total_shares: u128,
    pub idle: u128,
    pub lent: u128,
    /// NEAR out earning yield; no call moves it before AIR-332
    pub staked: u128,
    pub fees_earned: u128,
    pub losses: u128,
    pub collateral_held: u128,
    pub lps: LookupMap<AccountId, u128>,
    pub cards: IterableMap<AccountId, Card>,
    /// payouts whose transfer failed, claimable by their account
    pub unclaimed: LookupMap<AccountId, u128>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "airlock-credit", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

fn ms() -> u64 {
    env::block_timestamp_ms()
}

impl Pool {
    /// The outstanding principal of the open lines that are past their due date. Such a line counts as 0 in the assets, whether or not
    /// anyone has called `default`, so LPs cannot leave at the old price between the due date and the default.
    fn impaired_at(&self, now_ms: u64) -> u128 {
        self.cards
            .iter()
            .filter_map(|(_, c)| c.line.as_ref())
            .filter(|l| matches!(l.state, LineState::Open) && now_ms > l.due_ms)
            .map(|l| l.limit - l.returned)
            .sum()
    }

    /// What the LPs own at `now_ms`: idle plus staked plus the outstanding principal of the lines that are not overdue.
    fn assets_at(&self, now_ms: u64) -> u128 {
        self.idle + self.lent + self.staked - self.impaired_at(now_ms)
    }

    /// What the LPs own with every open line counted at its outstanding principal, overdue or not. A deposit is priced here (F1): the
    /// impairment lowers what an LP can withdraw (`assets_at`), but it must not let a new depositor buy shares cheap before the
    /// borrower repays, which would move value from the incumbents to the newcomer.
    fn assets_unimpaired(&self) -> u128 {
        self.idle + self.lent + self.staked
    }

    fn owner_only(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Caller is not the owner"
        );
    }

    fn card_of(&self, card: &AccountId) -> Card {
        self.cards
            .get(card)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown card"))
    }

    /// Sends `amount` to `to` and parks it for `claim` when the transfer fails.
    fn payout(&self, to: AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_payout(to, U128(amount)),
            )
            .detach();
    }

    fn line_view(card: &AccountId, c: &Card, l: &Line) -> LineView {
        LineView {
            card: card.clone(),
            borrower: c.borrower.clone(),
            limit: U128(l.limit),
            drawn: U128(if matches!(l.state, LineState::Collecting) {
                0
            } else {
                l.limit
            }),
            returned: U128(l.returned),
            fee_bps: l.fee_bps,
            due_ms: near_sdk::json_types::U64(l.due_ms),
            collateral: U128(l.collateral),
            state: l.state,
        }
    }
}

#[near]
impl Pool {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            collateral_bps: DEFAULT_COLLATERAL_BPS,
            total_shares: 0,
            idle: 0,
            lent: 0,
            staked: 0,
            fees_earned: 0,
            losses: 0,
            collateral_held: 0,
            lps: LookupMap::new(StorageKey::Lps),
            cards: IterableMap::new(StorageKey::Cards),
            unclaimed: LookupMap::new(StorageKey::Unclaimed),
        }
    }

    // ---- LPs ----

    /// Stake the attached NEAR: shares at the un-impaired price (the first deposit 1:1), rounded down; withdrawals pay the impaired price. At least `MIN_DEPOSIT`.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(
            amount >= MIN_DEPOSIT,
            "deposit is below the minimum of 0.001 NEAR"
        );
        let shares = math::shares_for_deposit(amount, self.total_shares, self.assets_unimpaired())
            .unwrap_or_else(|| env::panic_str("the pool has no assets to price a share"));
        require!(
            shares > 0,
            "deposit is too small for one share at this price"
        );
        let who = env::predecessor_account_id();
        let have = self.lps.get(&who).copied().unwrap_or(0);
        self.lps.insert(who.clone(), have + shares);
        self.total_shares += shares;
        self.idle += amount;
        emit(
            "deposit",
            json!({ "account": who, "amount": U128(amount).0.to_string(), "shares": shares.to_string() }),
        );
        U128(shares)
    }

    /// Pay out `shares` at the current price (rounded down), up to the idle liquidity.
    pub fn withdraw(&mut self, shares: U128) -> Promise {
        let who = env::predecessor_account_id();
        let shares = shares.0;
        require!(shares > 0, "withdraw needs at least one share");
        let have = self.lps.get(&who).copied().unwrap_or(0);
        require!(shares <= have, "withdraw exceeds your shares");
        let assets = self.assets_at(ms());
        let amount = math::amount_for_shares(shares, self.total_shares, assets)
            .unwrap_or_else(|| env::panic_str("overflow"));
        require!(amount > 0, "withdraw is worth less than one yocto");
        if amount > self.idle {
            let max = math::mul_div_floor(self.idle, self.total_shares, assets).unwrap_or(0);
            env::panic_str(&format!(
                "insufficient idle liquidity: withdraw at most {max} shares now"
            ));
        }
        self.lps.insert(who.clone(), have - shares);
        self.total_shares -= shares;
        self.idle -= amount;
        emit(
            "withdraw",
            json!({ "account": who, "amount": amount.to_string(), "shares": shares.to_string() }),
        );
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw(who, U128(shares), U128(amount)),
            )
    }

    /// Callback of `withdraw`: a failed transfer gives the shares back.
    #[private]
    pub fn on_withdraw(&mut self, account: AccountId, shares: U128, amount: U128) {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            let have = self.lps.get(&account).copied().unwrap_or(0);
            self.lps.insert(account.clone(), have + shares.0);
            self.total_shares += shares.0;
            self.idle += amount.0;
            emit(
                "withdraw_failed",
                json!({ "account": account, "amount": amount.0.to_string(), "shares": shares.0.to_string() }),
            );
        }
    }

    /// Callback of every payout: a failed transfer parks the amount for `claim`.
    #[private]
    pub fn on_payout(&mut self, to: AccountId, amount: U128) {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            let have = self.unclaimed.get(&to).copied().unwrap_or(0);
            self.unclaimed.insert(to.clone(), have + amount.0);
            emit(
                "payout_failed",
                json!({ "account": to, "amount": amount.0.to_string() }),
            );
        }
    }

    /// Take what a failed payout parked for the caller.
    pub fn claim(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.unclaimed.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.unclaimed.remove(&who);
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_payout(who, U128(amount)),
            )
    }

    // ---- cards and lines ----

    /// Issuer: register a card account the issuer owns. The card's `get_roles` is read on chain: its owner must be this pool's owner, its
    /// approver the borrower and its sponsor this pool; the borrower cannot be the owner.
    pub fn register_card(&mut self, card: AccountId, borrower: AccountId) -> Promise {
        self.owner_only();
        require!(
            card != env::current_account_id(),
            "the pool cannot be a card"
        );
        require!(
            borrower != self.owner_id,
            "the borrower cannot be the issuer"
        );
        require!(
            self.cards.get(&card).is_none(),
            "the card is already registered"
        );
        require!(
            self.cards.len() < MAX_CARDS,
            "the pool holds 100 cards at most"
        );
        Promise::new(card.clone())
            .function_call(
                "get_roles".to_string(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                GAS_ROLES,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_card_roles(card, borrower),
            )
    }

    /// Callback of `register_card`: stores the card only when its roles are the three this pool needs.
    #[private]
    pub fn on_card_roles(&mut self, card: AccountId, borrower: AccountId) {
        let bytes = env::promise_result_checked(0, 4096)
            .unwrap_or_else(|_| env::panic_str("the card did not answer get_roles"));
        let roles: CardRoles = near_sdk::serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| env::panic_str("the card's get_roles answer is not readable"));
        require!(
            roles.owner_id == self.owner_id,
            "the card's owner is not the pool's owner"
        );
        require!(
            roles.approver.as_ref() == Some(&borrower),
            "the card's approver is not the borrower"
        );
        require!(
            roles.sponsor.as_ref() == Some(&env::current_account_id()),
            "the card's sponsor is not this pool"
        );
        require!(
            self.cards.get(&card).is_none(),
            "the card is already registered"
        );
        self.cards.insert(
            card.clone(),
            Card {
                borrower: borrower.clone(),
                line: None,
                loss: 0,
            },
        );
        emit(
            "card_registered",
            json!({ "card": card, "borrower": borrower }),
        );
    }

    /// Borrower: post collateral for the card's next line (more may be added to an open line).
    #[payable]
    pub fn post_collateral(&mut self, card: AccountId) {
        let mut c = self.card_of(&card);
        require!(
            env::predecessor_account_id() == c.borrower,
            "Caller is not the card's borrower"
        );
        require!(
            c.loss == 0,
            "the card has an unrecovered loss: recover it by sweeps or write it off first"
        );
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "collateral must be positive");
        let line = match c.line.take() {
            Some(l) if matches!(l.state, LineState::Collecting | LineState::Open) => l,
            _ => Line {
                limit: 0,
                returned: 0,
                fee_bps: 0,
                due_ms: 0,
                collateral: 0,
                state: LineState::Collecting,
            },
        };
        let mut line = line;
        line.collateral += amount;
        self.collateral_held += amount;
        c.line = Some(line);
        self.cards.insert(card.clone(), c);
        emit(
            "collateral_posted",
            json!({ "card": card, "amount": amount.to_string() }),
        );
    }

    /// Issuer: open a line and fund the card with `limit`.
    pub fn open_line(
        &mut self,
        card: AccountId,
        limit: U128,
        fee_bps: u32,
        due_ms: near_sdk::json_types::U64,
    ) -> Promise {
        self.owner_only();
        let limit = limit.0;
        let due_ms = due_ms.0;
        let mut c = self.card_of(&card);
        require!(
            c.loss == 0,
            "the card has an unrecovered loss: recover it by sweeps or write it off first"
        );
        require!(limit > 0, "the limit must be positive");
        require!(fee_bps <= MAX_FEE_BPS, "the fee is above 50 percent");
        require!(
            due_ms > ms() && due_ms <= ms() + MAX_TERM_MS,
            "the due date must be in the future and within 90 days"
        );
        let mut line = match c.line.take() {
            Some(l) if matches!(l.state, LineState::Collecting) => l,
            Some(l) if matches!(l.state, LineState::Open) => env::panic_str(&format!(
                "the card already has an open line (limit {})",
                l.limit
            )),
            _ => Line {
                limit: 0,
                returned: 0,
                fee_bps: 0,
                due_ms: 0,
                collateral: 0,
                state: LineState::Collecting,
            },
        };
        let need = math::collateral_needed(limit, self.collateral_bps)
            .unwrap_or_else(|| env::panic_str("overflow"));
        require!(
            line.collateral >= need,
            "the collateral is below the requirement"
        );
        require!(
            self.idle >= limit,
            "the pool does not have that much idle liquidity"
        );
        self.idle -= limit;
        self.lent += limit;
        line.limit = limit;
        line.returned = 0;
        line.fee_bps = fee_bps;
        line.due_ms = due_ms;
        line.state = LineState::Open;
        let view = Self::line_view(&card, &c, &line);
        c.line = Some(line);
        self.cards.insert(card.clone(), c);
        emit(
            "line_opened",
            json!({ "card": card, "borrower": view.borrower, "limit": limit.to_string(), "fee_bps": fee_bps, "due_ms": due_ms.to_string() }),
        );
        Promise::new(card.clone())
            .transfer(NearToken::from_yoctonear(limit))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_line_funded(card, U128(limit)),
            )
    }

    /// Callback of `open_line`: a failed transfer closes the line back to collecting.
    #[private]
    pub fn on_line_funded(&mut self, card: AccountId, limit: U128) {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            if let Some(mut c) = self.cards.get(&card).cloned() {
                let borrower = c.borrower.clone();
                if let Some(line) = c.line.as_mut() {
                    if matches!(line.state, LineState::Open)
                        && line.limit == limit.0
                        && line.returned == 0
                    {
                        // the line never funded: the pool takes the principal back and the collateral goes back to the borrower
                        let refund = line.collateral;
                        line.state = LineState::Collecting;
                        line.limit = 0;
                        line.collateral = 0;
                        self.idle += limit.0;
                        self.lent -= limit.0;
                        self.collateral_held -= refund;
                        self.cards.insert(card.clone(), c);
                        emit(
                            "line_funding_failed",
                            json!({ "card": card, "limit": limit.0.to_string(), "refund": refund.to_string() }),
                        );
                        self.payout(borrower, refund);
                    }
                }
            }
        }
    }

    /// Borrower: take collateral back while the card has no open line (a line that was never opened, or a failed funding left it posted).
    /// The state moves before the payout.
    pub fn withdraw_collateral(&mut self, card: AccountId, amount: U128) {
        let mut c = self.card_of(&card);
        require!(
            env::predecessor_account_id() == c.borrower,
            "Caller is not the card's borrower"
        );
        let amount = amount.0;
        require!(amount > 0, "the amount must be positive");
        let open = c
            .line
            .as_ref()
            .is_some_and(|l| matches!(l.state, LineState::Open));
        require!(
            !open,
            "the card has an open line: the collateral secures it"
        );
        let line = c
            .line
            .as_mut()
            .filter(|l| matches!(l.state, LineState::Collecting))
            .unwrap_or_else(|| env::panic_str("the card has no collateral posted"));
        require!(line.collateral > 0, "the card has no collateral posted");
        require!(
            amount <= line.collateral,
            "the amount exceeds the posted collateral"
        );
        line.collateral -= amount;
        self.collateral_held -= amount;
        self.cards.insert(card.clone(), c);
        emit(
            "collateral_withdrawn",
            json!({ "card": card, "amount": amount.to_string() }),
        );
        self.payout(env::predecessor_account_id(), amount);
    }

    /// Issuer: give up on an unrecovered loss. The loss stays in the pool's `losses` (the share price is untouched); the card is free for a new
    /// line, and later sweeps are no longer credited as recoveries.
    pub fn write_off(&mut self, card: AccountId) {
        self.owner_only();
        let mut c = self.card_of(&card);
        require!(c.loss > 0, "the card has no loss to write off");
        let loss = c.loss;
        c.loss = 0;
        self.cards.insert(card.clone(), c);
        emit(
            "write_off",
            json!({ "card": card, "loss": loss.to_string() }),
        );
    }

    /// The card returns funds (its policy's `sweep` calls this with the amount attached). Only the card itself can credit its line.
    #[payable]
    pub fn on_card_return(&mut self, card: AccountId) {
        require!(
            env::predecessor_account_id() == card,
            "only the card can return its funds"
        );
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "nothing was returned");
        let mut c = self.card_of(&card);
        let card_loss = c.loss;
        let line = c
            .line
            .as_mut()
            .unwrap_or_else(|| env::panic_str("the card has no line"));
        let credited;
        let mut new_loss = card_loss;
        match line.state {
            LineState::Open => {
                credited = amount.min(line.limit - line.returned);
                line.returned += credited;
                self.idle += credited;
                self.lent -= credited;
            }
            LineState::Defaulted if card_loss > 0 => {
                credited = amount.min(card_loss);
                new_loss = card_loss - credited;
                self.losses -= credited;
                self.idle += credited;
            }
            _ => env::panic_str("the card has no open line"),
        }
        c.loss = new_loss;
        self.cards.insert(card.clone(), c);
        emit(
            "swept",
            json!({ "card": card, "amount": credited.to_string() }),
        );
        self.payout(card, amount - credited);
    }

    /// Repay a line: what the card kept plus the fee; the excess is refunded and the collateral goes back to the borrower.
    #[payable]
    pub fn repay(&mut self, card: AccountId) {
        let mut c = self.card_of(&card);
        let deposit = env::attached_deposit().as_yoctonear();
        let line = c
            .line
            .as_mut()
            .unwrap_or_else(|| env::panic_str("the card has no line"));
        require!(
            matches!(line.state, LineState::Open),
            "the card has no open line"
        );
        let outstanding = line.limit - line.returned;
        let fee =
            math::fee_of(outstanding, line.fee_bps).unwrap_or_else(|| env::panic_str("overflow"));
        let owed = outstanding + fee;
        require!(
            deposit >= owed,
            &format!("repay needs at least {owed} yocto")
        );
        let collateral = line.collateral;
        line.returned += outstanding;
        line.collateral = 0;
        line.state = LineState::Repaid;
        let borrower = c.borrower.clone();
        self.cards.insert(card.clone(), c);
        self.idle += owed;
        self.lent -= outstanding;
        self.fees_earned += fee;
        self.collateral_held -= collateral;
        emit(
            "repaid",
            json!({ "card": card, "amount": owed.to_string(), "fee": fee.to_string() }),
        );
        self.payout(borrower, collateral);
        self.payout(env::predecessor_account_id(), deposit - owed);
    }

    /// Anyone, after the due date: seize the collateral against what is owed, book the rest as a loss, close the line.
    pub fn default(&mut self, card: AccountId) {
        let mut c = self.card_of(&card);
        let line = c
            .line
            .as_mut()
            .unwrap_or_else(|| env::panic_str("the card has no line"));
        require!(
            matches!(line.state, LineState::Open),
            "the card has no open line"
        );
        require!(ms() > line.due_ms, "the line is not due yet");
        let outstanding = line.limit - line.returned;
        require!(outstanding > 0, "nothing is owed: the line can be repaid");
        let fee =
            math::fee_of(outstanding, line.fee_bps).unwrap_or_else(|| env::panic_str("overflow"));
        let owed = outstanding + fee;
        let collateral = line.collateral;
        let seized = collateral.min(owed);
        let principal_covered = seized.min(outstanding);
        let fee_covered = (seized - principal_covered).min(fee);
        let loss = outstanding - principal_covered;
        line.state = LineState::Defaulted;
        line.collateral = 0;
        let borrower = c.borrower.clone();
        c.loss = loss;
        self.cards.insert(card.clone(), c);
        self.idle += principal_covered + fee_covered;
        self.lent -= outstanding;
        self.fees_earned += fee_covered;
        self.losses += loss;
        self.collateral_held -= collateral;
        emit(
            "defaulted",
            json!({ "card": card, "seized": seized.to_string(), "loss": loss.to_string() }),
        );
        self.payout(borrower, collateral - seized);
    }

    /// Issuer: the collateral ratio of the next lines (open lines keep theirs).
    pub fn set_collateral_bps(&mut self, bps: u32) {
        self.owner_only();
        require!(bps <= 10_000, "the ratio is above 100 percent");
        self.collateral_bps = bps;
        emit("params_set", json!({ "collateral_bps": bps }));
    }

    // ---- views ----

    pub fn get_pool(&self) -> PoolView {
        let assets = self.assets_at(ms());
        PoolView {
            assets: U128(assets),
            shares: U128(self.total_shares),
            idle: U128(self.idle),
            staked: U128(self.staked),
            lent: U128(self.lent),
            impaired: U128(self.impaired_at(ms())),
            fees_earned: U128(self.fees_earned),
            losses: U128(self.losses),
            collateral_held: U128(self.collateral_held),
            collateral_bps: self.collateral_bps,
            share_price: U128(math::share_price(assets, self.total_shares).unwrap_or(0)),
            lines: self.list_lines(None, None),
        }
    }

    pub fn get_lp(&self, account: AccountId) -> LpView {
        let shares = self.lps.get(&account).copied().unwrap_or(0);
        LpView {
            shares: U128(shares),
            value: U128(
                math::amount_for_shares(shares, self.total_shares, self.assets_at(ms()))
                    .unwrap_or(0),
            ),
        }
    }

    pub fn get_card(&self, card: AccountId) -> Option<AccountId> {
        self.cards.get(&card).map(|c| c.borrower.clone())
    }

    pub fn get_line(&self, card: AccountId) -> Option<LineView> {
        let c = self.cards.get(&card)?;
        c.line.as_ref().map(|l| Self::line_view(&card, c, l))
    }

    /// The lines in registration order, `limit` clamped to 50.
    pub fn list_lines(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<LineView> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
        self.cards
            .iter()
            .filter_map(|(k, c)| c.line.as_ref().map(|l| Self::line_view(k, c, l)))
            .skip(from)
            .take(limit)
            .collect()
    }

    pub fn get_unclaimed(&self, account: AccountId) -> U128 {
        U128(self.unclaimed.get(&account).copied().unwrap_or(0))
    }
}

#[cfg(test)]
mod tests;

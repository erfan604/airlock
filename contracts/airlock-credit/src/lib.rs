// AIRLOCK Credit (AIR-328, docs/design/credit.md): LPs stake NEAR into a pool and hold shares; the pool's issuer opens credit lines that fund
// AIRLOCK card policies (AIR-327); what a card spends comes back through `sweep` (as `on_card_return`) and `repay`, with a fee that raises the
// share price. One asset, integer math, rounding in the pool's favour. Pool accounting uses its own fields (`idle`, `lent`, `staked`), never
// the contract balance, so a plain transfer to the contract cannot move the share price. Every state change happens before the promise that
// moves NEAR; a transfer that can fail has a callback that restores the state or parks the amount for `claim`.
// AIR-333 adds the Credit Passport: a record per borrower written by the pool's own events, a 0 to 1000 score, and a cap on the next line.
// AIR-350 adds the Base payment check: the pool asks the MPC network (`verify_foreign_transaction`) whether a Base Sepolia transaction is
// final and succeeded, and records its signed answer so anyone can read it later with a view. It enforces nothing about lines or money.
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near,
    require,
};

pub mod legacy;
pub mod math;

/// The state version `migrate` writes (1 is the c1108d layout in `legacy::PoolV1`).
pub const STATE_VERSION: u32 = 2;
/// The Passport cap base of a pool made by `new` without one: 100 NEAR (a fresh borrower at score 500 may take a line of this size).
pub const DEFAULT_PASSPORT_BASE: u128 = 100 * 1_000_000_000_000_000_000_000_000;

/// A repay moves the Passport counters only when the card kept at least `floor_base / 10` of the line (an absolute floor, so lines
/// of a few yocto kept in full cannot farm the score) ...
pub const MIN_QUALIFYING_DRAW_DIV: u128 = 10;
/// ... and the line charged at least 1 percent, so every counted repay paid the LPs a real fee.
pub const MIN_QUALIFYING_FEE_BPS: u32 = 100;

/// The smallest deposit: 0.001 NEAR (it blunts rounding games on a tiny pool).
pub const MIN_DEPOSIT: u128 = 1_000_000_000_000_000_000_000;
/// The storage charge of a lender's first deposit: 0.0025 NEAR, 250 bytes at 1e19 yocto per byte. It pays for the lender's `lps` and
/// `locks` entries (at most about 242 bytes with a 64 character account id). It is never pool money: no pool field moves, it stays in the
/// contract's balance, and it is not refunded; a full withdraw removes both entries, so the next first deposit pays it again.
pub const LP_STORAGE: u128 = 2_500_000_000_000_000_000_000;
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

/// AIR-350: the fee of one Base payment check, 0.01 NEAR. It pays the storage of the record and the 1 yocto the signer takes; it is never
/// pool money (no pool field moves), and a check that records nothing refunds it less that 1 yocto.
pub const BASE_CHECK_FEE: u128 = 10_000_000_000_000_000_000_000;
/// The testnet MPC signer a pool made by `new` without one asks.
pub const DEFAULT_MPC_SIGNER: &str = "v1.signer-prod.testnet";
/// The signer's domain for foreign transaction checks on testnet (domain 3, purpose ForeignTx, checked live 2026-11-10).
pub const DEFAULT_FOREIGN_DOMAIN: u64 = 3;
/// The most bytes of the signer's answer the callback reads; a longer answer records nothing.
pub const MAX_BASE_ANSWER_BYTES: usize = 2_048;
/// The most bytes of the stored signature text, so the fee always covers the record's storage.
pub const MAX_BASE_SIGNATURE_BYTES: usize = 512;
/// Gas for the signer's `verify_foreign_transaction` (the testnet signer refuses under 15 Tgas).
const GAS_MPC_VERIFY: Gas = Gas::from_tgas(20);
/// Gas for `on_base_check`: it writes the record and may start a refund with its own 10 Tgas callback.
const GAS_BASE_CHECK_CALLBACK: Gas = Gas::from_tgas(20);
/// The prepaid gas `check_base_payment` needs: the signer call, the callback and the call itself.
pub const GAS_BASE_CHECK_MIN: Gas = Gas::from_tgas(60);

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    Lps,
    Cards,
    Unclaimed,
    Locks,
    /// AIR-333: the Passport records, keyed by borrower account (appended: prefix byte 4)
    Records,
    /// AIR-350: the Base payment checks, keyed by Base transaction id (appended: prefix byte 5)
    BaseChecks,
}

/// AIR-350: what the MPC network answered when the pool asked about one Base Sepolia transaction. The answer says the transaction is final
/// and succeeded and binds its id to a block hash; it does not name the payee or the amount, and the pool does not recompute the hash.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseCheck {
    /// the signed payload hash, 64 lowercase hex
    pub payload_hash: String,
    /// the signature object of the answer as compact JSON
    pub signature: String,
    /// the account that paid the fee
    pub asked_by: AccountId,
    pub recorded_ms: u64,
}

/// `BaseCheck` as JSON, with the transaction id it answers.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseCheckView {
    pub tx_id: String,
    pub payload_hash: String,
    pub signature: String,
    pub asked_by: AccountId,
    pub recorded_ms: U64,
}

/// Which signer and domain the pool asks, and the fee of one check.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseCheckConfigView {
    pub mpc_signer: AccountId,
    pub domain_id: u64,
    pub fee: U128,
}

/// True for a Base transaction id as the signer takes it: exactly 64 lowercase hex characters, no 0x.
pub fn is_base_tx_id(tx_id: &str) -> bool {
    tx_id.len() == 64
        && tx_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Reads the signer's answer `{payload_hash, signature}`: the hash must be 64 hex (stored lowercase) and the signature a JSON object of at
/// most `MAX_BASE_SIGNATURE_BYTES` as compact JSON. Returns the hash and the signature text, or why the answer is not readable.
pub fn parse_base_answer(bytes: &[u8]) -> Result<(String, String), &'static str> {
    let v: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_slice(bytes).map_err(|_| "the answer is not JSON")?;
    let hash = v
        .get("payload_hash")
        .and_then(|h| h.as_str())
        .ok_or("the answer has no payload_hash string")?;
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the payload_hash is not 64 hex characters");
    }
    let sig = v
        .get("signature")
        .filter(|s| s.is_object())
        .ok_or("the answer has no signature object")?;
    let text = near_sdk::serde_json::to_string(sig).map_err(|_| "the signature is not readable")?;
    if text.len() > MAX_BASE_SIGNATURE_BYTES {
        return Err("the signature is longer than 512 bytes");
    }
    Ok((hash.to_ascii_lowercase(), text))
}

/// What the pool's own events prove about a borrower (AIR-333). Keyed by `Card.borrower`, so every card of one borrower shares it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CreditRecord {
    pub lines_opened: u32,
    pub repaid_on_time: u32,
    pub repaid_late: u32,
    pub defaults: u32,
    pub recovered: u32,
    pub written_off: u32,
    pub volume_repaid: u128,
    pub fees_paid: u128,
    pub last_event_ms: u64,
    /// true when `migrate` built it from the stored state (which proves less than the events would have)
    pub backfilled: bool,
}

/// `CreditRecord` as JSON: amounts and times as decimal strings.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CreditRecordView {
    pub lines_opened: u32,
    pub repaid_on_time: u32,
    pub repaid_late: u32,
    pub defaults: u32,
    pub recovered: u32,
    pub written_off: u32,
    pub volume_repaid: U128,
    pub fees_paid: U128,
    pub last_event_ms: U64,
    pub backfilled: bool,
}

impl From<&CreditRecord> for CreditRecordView {
    fn from(r: &CreditRecord) -> Self {
        Self {
            lines_opened: r.lines_opened,
            repaid_on_time: r.repaid_on_time,
            repaid_late: r.repaid_late,
            defaults: r.defaults,
            recovered: r.recovered,
            written_off: r.written_off,
            volume_repaid: U128(r.volume_repaid),
            fees_paid: U128(r.fees_paid),
            last_event_ms: U64(r.last_event_ms),
            backfilled: r.backfilled,
        }
    }
}

impl From<&CreditRecordView> for CreditRecord {
    fn from(v: &CreditRecordView) -> Self {
        Self {
            lines_opened: v.lines_opened,
            repaid_on_time: v.repaid_on_time,
            repaid_late: v.repaid_late,
            defaults: v.defaults,
            recovered: v.recovered,
            written_off: v.written_off,
            volume_repaid: v.volume_repaid.0,
            fees_paid: v.fees_paid.0,
            last_event_ms: v.last_event_ms.0,
            backfilled: v.backfilled,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassportView {
    pub borrower: AccountId,
    pub score: u32,
    pub reasons: Vec<String>,
    pub record: CreditRecordView,
    pub limit_cap: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolPassportView {
    pub base: U128,
    pub pending_base: Option<U128>,
    pub effective_ms: Option<U64>,
    pub version: u32,
    /// the highest base the pool has had in force: a repay counts only when the card kept at least a tenth of it
    pub floor_base: U128,
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
    /// shares cannot be withdrawn for this long after a deposit
    pub min_hold_ms: near_sdk::json_types::U64,
    pub lines: Vec<LineView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpView {
    pub shares: U128,
    pub value: U128,
    /// the time before which the LP cannot withdraw (0 when it never deposited)
    pub locked_until_ms: near_sdk::json_types::U64,
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
    /// per LP, the time before which its shares cannot be withdrawn (set at every deposit)
    pub locks: LookupMap<AccountId, u64>,
    /// how long shares are held after a deposit, fixed at init
    pub min_hold_ms: u64,
    /// AIR-333: the Passport record of each borrower
    pub records: LookupMap<AccountId, CreditRecord>,
    /// the cap of a line at score 500 (`limit_cap = passport_base * score / 500`)
    pub passport_base: u128,
    /// an announced raise of the base and the time from which `apply_passport_base` applies it
    pub pending_base: Option<(u128, u64)>,
    /// the highest base this pool has had in force. It never falls, so a cut of the base cannot lower the draw a repay needs to count
    pub floor_base: u128,
    /// AIR-350: the signed answers of the Base payment checks, keyed by Base transaction id
    pub base_checks: LookupMap<String, BaseCheck>,
    /// AIR-350: the MPC signer `check_base_payment` asks
    pub mpc_signer: AccountId,
    /// AIR-350: the signer's domain id for foreign transaction checks
    pub foreign_domain_id: u64,
    /// the state version (`STATE_VERSION`)
    pub version: u32,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "airlock-credit", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

/// How long shares are held after a deposit when `new` is not given `min_hold_ms`: 24 hours.
pub const DEFAULT_MIN_HOLD_MS: u64 = 86_400_000;

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

    /// True while any card carries a loss that is neither recovered nor written off.
    fn has_unrecovered_loss(&self) -> bool {
        self.cards.iter().any(|(_, c)| c.loss > 0)
    }

    /// What the LPs own at `now_ms`: idle plus staked plus the outstanding principal of the lines that are not overdue.
    fn assets_at(&self, now_ms: u64) -> u128 {
        self.idle + self.lent + self.staked - self.impaired_at(now_ms)
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

    /// `migrate`'s backfill: the stored state keeps one line per card and no history, so it counts only what that state proves. A card
    /// whose line is `Open`, `Repaid` or `Defaulted` opened one line; a `Defaulted` line is one default. A `Repaid` line is neither on time
    /// nor late (its timing is not stored), and a loss cleared to 0 is neither recovered nor written off (the two cannot be told apart).
    /// Returns how many records it wrote.
    /// `last_event_ms` stays 0: the state does not store when the line closed.
    fn backfill(&mut self) -> u32 {
        let mut found: Vec<(AccountId, LineState)> = Vec::new();
        for (_, c) in self.cards.iter() {
            if let Some(l) = c.line.as_ref() {
                found.push((c.borrower.clone(), l.state));
            }
        }
        let mut written = 0u32;
        for (borrower, state) in found {
            if matches!(state, LineState::Collecting) {
                continue;
            }
            let mut r = self.record_of(&borrower);
            if !r.backfilled {
                written += 1;
            }
            r.backfilled = true;
            r.lines_opened += 1;
            if matches!(state, LineState::Defaulted) {
                r.defaults += 1;
            }
            self.records.insert(borrower, r);
        }
        written
    }

    /// The record of `borrower` (all zero when it has none).
    fn record_of(&self, borrower: &AccountId) -> CreditRecord {
        self.records.get(borrower).cloned().unwrap_or_default()
    }

    /// Applies `f` to the record of `borrower` and stamps the time.
    fn write_record(&mut self, borrower: &AccountId, f: impl FnOnce(&mut CreditRecord)) {
        let mut r = self.record_of(borrower);
        f(&mut r);
        r.last_event_ms = ms();
        self.records.insert(borrower.clone(), r);
    }

    /// The score of `borrower`, its reasons and the most the next line may be.
    fn passport_of(&self, borrower: &AccountId) -> (u32, Vec<String>, u128, CreditRecord) {
        let r = self.record_of(borrower);
        let (score, reasons) = math::passport_score(&r);
        let cap = math::limit_cap(self.passport_base, score);
        (score, reasons, cap, r)
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
    pub fn new(
        owner_id: AccountId,
        min_hold_ms: Option<near_sdk::json_types::U64>,
        passport_base: Option<U128>,
        mpc_signer: Option<AccountId>,
        foreign_domain_id: Option<u64>,
    ) -> Self {
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
            locks: LookupMap::new(StorageKey::Locks),
            min_hold_ms: min_hold_ms.map_or(DEFAULT_MIN_HOLD_MS, |v| v.0),
            records: LookupMap::new(StorageKey::Records),
            passport_base: passport_base.map_or(DEFAULT_PASSPORT_BASE, |v| v.0),
            pending_base: None,
            floor_base: passport_base.map_or(DEFAULT_PASSPORT_BASE, |v| v.0),
            base_checks: LookupMap::new(StorageKey::BaseChecks),
            mpc_signer: mpc_signer
                .unwrap_or_else(|| DEFAULT_MPC_SIGNER.parse().expect("a valid account id")),
            foreign_domain_id: foreign_domain_id.unwrap_or(DEFAULT_FOREIGN_DOMAIN),
            version: STATE_VERSION,
        }
    }

    /// AIR-333: the in-place upgrade from the c1108d state (`legacy::PoolV1`). Deploy the new wasm and call this in the same transaction.
    /// Every stored field keeps its value; the records are backfilled from what the stored state proves (see `backfill`). Refused on a
    /// state that is not a `PoolV1` (a second migrate cannot read the new layout as the old one). AIR-350: it also sets the MPC signer and
    /// the foreign transaction domain `check_base_payment` asks.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(passport_base: U128, mpc_signer: AccountId, foreign_domain_id: u64) -> Self {
        let old: legacy::PoolV1 =
            env::state_read().unwrap_or_else(|| env::panic_str("there is no state to migrate"));
        let mut pool = Self {
            owner_id: old.owner_id,
            collateral_bps: old.collateral_bps,
            total_shares: old.total_shares,
            idle: old.idle,
            lent: old.lent,
            staked: old.staked,
            fees_earned: old.fees_earned,
            losses: old.losses,
            collateral_held: old.collateral_held,
            lps: old.lps,
            cards: old.cards,
            unclaimed: old.unclaimed,
            locks: old.locks,
            min_hold_ms: old.min_hold_ms,
            records: LookupMap::new(StorageKey::Records),
            passport_base: passport_base.0,
            pending_base: None,
            floor_base: passport_base.0,
            base_checks: LookupMap::new(StorageKey::BaseChecks),
            mpc_signer: mpc_signer.clone(),
            foreign_domain_id,
            version: STATE_VERSION,
        };
        let backfilled = pool.backfill();
        emit(
            "migrated",
            json!({ "version": STATE_VERSION, "passport_base": passport_base.0.to_string(), "records": backfilled, "mpc_signer": mpc_signer, "foreign_domain_id": foreign_domain_id }),
        );
        pool
    }

    // ---- LPs ----

    /// Stake the attached NEAR: shares at the current price (the first deposit 1:1), rounded down. At least `MIN_DEPOSIT`. Refused while any
    /// line is past its due date (F1): deposits and withdrawals share one valuation, and pricing a deposit at either the impaired or the
    /// un-impaired value would move value between LPs, so nobody joins until `default` (permissionless) books the overdue line.
    /// A caller with no `lps` entry pays `LP_STORAGE` out of the attached amount for its entries; the pool is credited the rest, which must
    /// still be at least `MIN_DEPOSIT`. The charge is not pool money: it stays in the contract's balance and moves no pool field.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= MIN_DEPOSIT,
            "deposit is below the minimum of 0.001 NEAR"
        );
        require!(
            self.impaired_at(ms()) == 0,
            "deposits are paused while a line is past due; anyone can call default to book it"
        );
        require!(
            !self.has_unrecovered_loss(),
            "deposits are paused while a defaulted line is being recovered; the issuer recovers it by sweeps or writes it off"
        );
        let who = env::predecessor_account_id();
        let entry = self.lps.get(&who).copied();
        let storage = if entry.is_some() { 0 } else { LP_STORAGE };
        require!(
            attached >= MIN_DEPOSIT + storage,
            "a first deposit needs at least 0.0035 NEAR: 0.0025 NEAR pays for your entry in the pool's storage"
        );
        let amount = attached - storage;
        let shares = math::shares_for_deposit(amount, self.total_shares, self.assets_at(ms()))
            .unwrap_or_else(|| env::panic_str("the pool has no assets to price a share"));
        require!(
            shares > 0,
            "deposit is too small for one share at this price"
        );
        let have = entry.unwrap_or(0);
        self.lps.insert(who.clone(), have + shares);
        self.locks.insert(who.clone(), ms() + self.min_hold_ms);
        self.total_shares += shares;
        self.idle += amount;
        emit(
            "deposit",
            json!({ "account": who, "amount": U128(amount).0.to_string(), "shares": shares.to_string(), "storage": storage.to_string() }),
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
        let locked = self.locks.get(&who).copied().unwrap_or(0);
        require!(
            ms() >= locked,
            &format!(
                "withdraw is locked until {locked}: shares are held for {} ms after a deposit",
                self.min_hold_ms
            )
        );
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
        if shares == have {
            // a full exit frees the lender's storage: both entries go, and a later deposit pays `LP_STORAGE` again
            self.lps.remove(&who);
            self.locks.remove(&who);
        } else {
            self.lps.insert(who.clone(), have - shares);
        }
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

    /// Callback of `withdraw`: a failed transfer gives the shares back. After a full exit the entries are gone: the `lps` entry is written
    /// again with the shares, the `locks` entry is not, so the lender may withdraw at once (its hold had passed when it withdrew), and its
    /// entry counts as one for the storage charge.
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
        // again here: two registrations in flight both passed the check in `register_card`
        require!(
            self.cards.len() < MAX_CARDS,
            "the pool holds 100 cards at most"
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
        // AIR-333: the borrower's Passport caps the line, before the collateral and liquidity checks
        let (score, _, cap, _) = self.passport_of(&c.borrower);
        if limit > cap {
            env::panic_str(&format!(
                "the limit is above this card's Passport cap of {} NEAR (score {score})",
                math::near_decimal(cap)
            ));
        }
        // The cap is per borrower, not per card: what the borrower still holds on their other cards counts toward it, and a loss or a
        // line past due on any of them refuses a new line (the pool holds 100 cards at most, so the walk is bounded).
        let mut held_elsewhere: u128 = 0;
        for (other, k) in self.cards.iter() {
            if *other == card || k.borrower != c.borrower {
                continue;
            }
            require!(
                k.loss == 0,
                "the borrower has an unrecovered loss on another card"
            );
            if let Some(l) = k.line.as_ref() {
                if matches!(l.state, LineState::Open) {
                    require!(
                        ms() <= l.due_ms,
                        "the borrower has a line past due on another card"
                    );
                    held_elsewhere = held_elsewhere.saturating_add(l.limit - l.returned);
                }
            }
        }
        if limit.saturating_add(held_elsewhere) > cap {
            env::panic_str(&format!(
                "the limit is above what is left of the borrower's Passport cap of {} NEAR (score {score}): {} NEAR is out on their other cards",
                math::near_decimal(cap),
                math::near_decimal(held_elsewhere)
            ));
        }
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
        if env::promise_result_checked(0, 0).is_ok() {
            // AIR-333: the line funded the card: the borrower's record counts it
            if let Some(borrower) = self.cards.get(&card).map(|c| c.borrower.clone()) {
                self.write_record(&borrower, |r| r.lines_opened += 1);
            }
            return;
        }
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
        let borrower = c.borrower.clone();
        self.cards.insert(card.clone(), c);
        self.write_record(&borrower, |r| r.written_off += 1);
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
        let borrower = c.borrower.clone();
        self.cards.insert(card.clone(), c);
        if card_loss > 0 && new_loss == 0 {
            // AIR-333: this return cleared the loss of a default (a card with no loss refuses later returns, so it counts once)
            self.write_record(&borrower, |r| r.recovered += 1);
        }
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
        // AIR-333: only a repay of a line the card really drew counts, on time or late. Three floors: the card kept at least 10 percent
        // of the limit, at least a tenth of the highest cap base this pool has had (absolute, so dust lines kept in full do not count,
        // and a cut of the base does not lower it), and the line charged at least 1 percent.
        let qualifies = outstanding.saturating_mul(10) >= line.limit
            && outstanding >= self.floor_base / MIN_QUALIFYING_DRAW_DIV
            && line.fee_bps >= MIN_QUALIFYING_FEE_BPS
            && fee > 0;
        let on_time = ms() <= line.due_ms;
        line.returned += outstanding;
        line.collateral = 0;
        line.state = LineState::Repaid;
        let borrower = c.borrower.clone();
        self.cards.insert(card.clone(), c);
        self.write_record(&borrower, |r| {
            r.volume_repaid += outstanding;
            r.fees_paid += fee;
            if qualifies && on_time {
                r.repaid_on_time += 1;
            } else if qualifies {
                r.repaid_late += 1;
            }
        });
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
        self.write_record(&borrower, |r| r.defaults += 1);
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

    // ---- the Passport cap base (AIR-333) ----

    /// Owner, exactly 1 yocto: a base at or below the one in force applies at once and clears any pending raise; a higher base is announced
    /// and binds only from `now + min_hold_ms` (`apply_passport_base`), so every LP can leave before a raise takes effect.
    #[payable]
    pub fn set_passport_base(&mut self, base: U128) {
        near_sdk::assert_one_yocto();
        self.owner_only();
        let base = base.0;
        if base <= self.passport_base {
            self.passport_base = base;
            self.pending_base = None;
            emit("passport_base_set", json!({ "base": base.to_string() }));
        } else {
            let effective_ms = ms() + self.min_hold_ms;
            self.pending_base = Some((base, effective_ms));
            emit(
                "passport_base_raise_announced",
                json!({ "base": base.to_string(), "effective_ms": effective_ms.to_string() }),
            );
        }
    }

    /// Anyone, from the announced time: applies the pending raise of the base.
    pub fn apply_passport_base(&mut self) {
        let (base, effective_ms) = self
            .pending_base
            .unwrap_or_else(|| env::panic_str("no raise of the Passport base is pending"));
        require!(
            ms() >= effective_ms,
            &format!("the raise of the Passport base applies from {effective_ms}")
        );
        self.passport_base = base;
        self.floor_base = self.floor_base.max(base);
        self.pending_base = None;
        emit("passport_base_set", json!({ "base": base.to_string() }));
    }

    // ---- the Base payment check (AIR-350) ----

    /// Anyone, with at least `BASE_CHECK_FEE` attached and `GAS_BASE_CHECK_MIN` prepaid: the pool asks the configured MPC signer whether
    /// the Base Sepolia transaction `tx_id` (64 lowercase hex, no 0x) is final and succeeded, and `on_base_check` records the signed answer.
    /// The fee is not pool money. A transaction already recorded is refused. Two checks of one id in flight both reach the signer; the
    /// callback keeps the record written earlier and refunds the later one. This enforces nothing about lines or money.
    #[payable]
    pub fn check_base_payment(&mut self, tx_id: String) -> Promise {
        require!(
            is_base_tx_id(&tx_id),
            "tx_id must be exactly 64 lowercase hex characters, without 0x"
        );
        let fee = env::attached_deposit().as_yoctonear();
        require!(
            fee >= BASE_CHECK_FEE,
            "check_base_payment needs an attached fee of at least 0.01 NEAR"
        );
        require!(
            env::prepaid_gas() >= GAS_BASE_CHECK_MIN,
            "check_base_payment needs at least 60 Tgas of prepaid gas"
        );
        require!(
            self.base_checks.get(&tx_id).is_none(),
            "this Base transaction is already recorded"
        );
        let asked_by = env::predecessor_account_id();
        let args = json!({
            "request": {
                "request": { "Base": { "tx_id": tx_id, "extractors": ["BlockHash"], "finality": "Finalized" } },
                "domain_id": self.foreign_domain_id,
                "payload_version": 1
            }
        });
        Promise::new(self.mpc_signer.clone())
            .function_call(
                "verify_foreign_transaction".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_MPC_VERIFY,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_BASE_CHECK_CALLBACK)
                    .on_base_check(tx_id, asked_by, U128(fee)),
            )
    }

    /// Callback of `check_base_payment`. A readable answer for an id not yet recorded is stored and `base_payment_checked` is emitted (a
    /// fee above `BASE_CHECK_FEE` goes back). A failed or timed out call, an answer longer than `MAX_BASE_ANSWER_BYTES`, an unreadable
    /// answer or an id recorded meanwhile stores nothing, refunds the fee less the 1 yocto sent to the signer and emits
    /// `base_payment_unchecked`. Refunds go through `payout`, so a failed refund is parked for `claim`.
    #[private]
    pub fn on_base_check(&mut self, tx_id: String, asked_by: AccountId, fee: U128) {
        let fee = fee.0;
        let answer = match env::promise_result_checked(0, MAX_BASE_ANSWER_BYTES) {
            Ok(bytes) => parse_base_answer(&bytes),
            Err(PromiseError::TooLong(_)) => Err("the answer is longer than 2048 bytes"),
            Err(_) => Err("the signer call failed or timed out"),
        };
        let answer = answer.and_then(|a| {
            if self.base_checks.get(&tx_id).is_some() {
                Err("this Base transaction is already recorded")
            } else {
                Ok(a)
            }
        });
        match answer {
            Ok((payload_hash, signature)) => {
                self.base_checks.insert(
                    tx_id.clone(),
                    BaseCheck {
                        payload_hash: payload_hash.clone(),
                        signature,
                        asked_by: asked_by.clone(),
                        recorded_ms: ms(),
                    },
                );
                emit(
                    "base_payment_checked",
                    json!({ "tx_id": tx_id, "payload_hash": payload_hash, "asked_by": asked_by }),
                );
                self.payout(asked_by, fee.saturating_sub(BASE_CHECK_FEE));
            }
            Err(reason) => {
                let refund = fee.saturating_sub(1);
                emit(
                    "base_payment_unchecked",
                    json!({ "tx_id": tx_id, "asked_by": asked_by, "reason": reason, "refund": refund.to_string() }),
                );
                self.payout(asked_by, refund);
            }
        }
    }

    /// The signed answer the pool recorded for a Base Sepolia transaction id, or null.
    pub fn get_base_check(&self, tx_id: String) -> Option<BaseCheckView> {
        self.base_checks.get(&tx_id).map(|c| BaseCheckView {
            tx_id: tx_id.clone(),
            payload_hash: c.payload_hash.clone(),
            signature: c.signature.clone(),
            asked_by: c.asked_by.clone(),
            recorded_ms: U64(c.recorded_ms),
        })
    }

    /// The MPC signer and domain `check_base_payment` asks, and its fee.
    pub fn get_base_check_config(&self) -> BaseCheckConfigView {
        BaseCheckConfigView {
            mpc_signer: self.mpc_signer.clone(),
            domain_id: self.foreign_domain_id,
            fee: U128(BASE_CHECK_FEE),
        }
    }

    // ---- views ----

    /// The Passport of a card's borrower: the score, its reasons, the record and the most the next line may be. Null for an unknown card.
    pub fn get_passport(&self, card: AccountId) -> Option<PassportView> {
        let borrower = self.cards.get(&card)?.borrower.clone();
        let (score, reasons, cap, record) = self.passport_of(&borrower);
        Some(PassportView {
            borrower,
            score,
            reasons,
            record: CreditRecordView::from(&record),
            limit_cap: U128(cap),
        })
    }

    /// The cap base in force, an announced raise and its time, and the state version.
    pub fn get_pool_passport(&self) -> PoolPassportView {
        PoolPassportView {
            base: U128(self.passport_base),
            pending_base: self.pending_base.map(|(b, _)| U128(b)),
            effective_ms: self.pending_base.map(|(_, t)| U64(t)),
            version: self.version,
            floor_base: U128(self.floor_base),
        }
    }

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
            min_hold_ms: near_sdk::json_types::U64(self.min_hold_ms),
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
            locked_until_ms: near_sdk::json_types::U64(
                self.locks.get(&account).copied().unwrap_or(0),
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

//! The four stored ledgers (AIR-062, F05, F13): asset per UTC day, payee per UTC day, payee untrusted budget per UTC day, and task spent per
//! payee. They are charged with the functions of the proven model (`airlock_verdict::ledger`, Kani AIR-025) and refunded exactly. This file
//! has no hand written arithmetic: every addition, subtraction and cap comparison on a ledger goes through that model.
//!
//! A day ledger holds `(day, spent)`; a value from an earlier day reads as 0 and the next write overwrites it, so the day maps are bounded
//! by the number of assets and payees. The task ledger is keyed by (task hash, payee key) and never freed.
use crate::policy::{AssetEntry, BookEntry};
use crate::request::{ChargeRec, Hex32, Labels, RequestRecord, RequestState};
use crate::time::utc_day;
use crate::*;
use airlock_verdict::ledger::{self, Caps, Charge, Spent};
use airlock_verdict::{AssetLimits, Payee, TaskScope};
use near_sdk::json_types::U128;

/// A day ledger entry: what was spent in UTC day `day`.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DayValue {
    pub day: u64,
    pub spent: u128,
}

/// The one argument every ledger function takes, so the gate and approve cannot pass the keys in a different order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgerKey {
    pub asset: String,
    pub payee: String,
    pub task_hash: [u8; 32],
}

impl From<Charge> for ChargeRec {
    fn from(c: Charge) -> Self {
        ChargeRec {
            asset_day: c.asset_day,
            payee_day: c.payee_day,
            payee_untrusted_day: c.payee_untrusted_day,
            task: c.task,
        }
    }
}

impl From<ChargeRec> for Charge {
    fn from(c: ChargeRec) -> Self {
        Charge {
            asset_day: c.asset_day,
            payee_day: c.payee_day,
            payee_untrusted_day: c.payee_untrusted_day,
            task: c.task,
        }
    }
}

pub struct VerdictInputs {
    pub asset: Option<AssetLimits>,
    pub payee: Option<Payee>,
    pub task: Option<TaskScope>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remaining {
    pub asset_day: u128,
    pub payee_day: u128,
    pub payee_untrusted_day: u128,
    pub task: Option<u128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Amount {
    pub spent: U128,
    pub cap: U128,
    pub remaining: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedgersView {
    pub asset_day: Amount,
    pub payee_day: Amount,
    pub payee_untrusted_day: Amount,
    pub task_spent: Option<U128>,
}

/// The caps of the Allow path, where the asset, the payee and the task bound all exist.
pub fn caps_for(asset: &AssetEntry, payee: &BookEntry, bound: u128) -> Caps {
    Caps {
        asset_daily: asset.daily_cap,
        payee_limit: payee.daily_limit,
        payee_budget: payee.daily_untrusted_budget,
        task_bound: bound,
    }
}

/// The verdict inputs for a request, built from what is left (`ledger::remaining`, saturating) the way the gate and the approve recheck
/// both do. A missing part has cap 0 in the `Caps` and gives `None` in its input: no asset gives `asset: None`, no book entry gives
/// `payee: None` (a new payee), no bound for the payee in the task gives `task: None` (the verdict escalates `OutsideTask`).
pub fn verdict_inputs(
    asset: Option<&AssetEntry>,
    payee: Option<&BookEntry>,
    bound: Option<u128>,
    spent: &Spent,
) -> VerdictInputs {
    let caps = Caps {
        asset_daily: asset.map_or(0, |a| a.daily_cap),
        payee_limit: payee.map_or(0, |p| p.daily_limit),
        payee_budget: payee.map_or(0, |p| p.daily_untrusted_budget),
        task_bound: bound.unwrap_or(0),
    };
    let r = ledger::remaining(spent, &caps);
    VerdictInputs {
        asset: asset.map(|a| AssetLimits {
            hard_cap: a.hard_cap,
            remaining_daily: r.asset_day,
            max_fee_per_gas: a.max_fee_per_gas,
            max_gas: a.max_gas,
        }),
        payee: payee.map(|p| Payee {
            cap: p.cap,
            budget_remaining: r.payee_untrusted_day,
            limit_remaining: r.payee_day,
        }),
        task: bound.map(|_| TaskScope { remaining: r.task }),
    }
}

/// The one definition of `amount_untrusted` for `charge_allow`: the amount labels are not within Owner, Book, Policy and Oracle.
pub fn is_untrusted_amount(labels: &Labels) -> bool {
    !airlock_verdict::value_trusted(labels.amount)
}

/// The caps of an approval: the asset's daily cap; the payee's limit, or no limit for a payee outside the book (the approved payment is
/// still recorded in that payee's day ledger, so a later `book_add` sees it); no untrusted budget, because an approval never charges it;
/// and the task bound stored in `PendingInfo.task_bound` (the contract stores no task bounds, and a bound of 0 would saturate the task
/// ledger down to 0).
pub fn approval_caps(asset: &AssetEntry, payee: Option<&BookEntry>, task_bound: u128) -> Caps {
    Caps {
        asset_daily: asset.daily_cap,
        payee_limit: payee.map_or(u128::MAX, |p| p.daily_limit),
        payee_budget: 0,
        task_bound,
    }
}

/// A day ledger value when the stored bucket is of `day`.
fn day_value(map: &LookupMap<String, DayValue>, key: &str, day: u64) -> Option<u128> {
    match map.get(key) {
        Some(v) if v.day == day => Some(v.spent),
        _ => None,
    }
}

fn day_write(map: &mut LookupMap<String, DayValue>, key: &str, day: u64, spent: u128) {
    map.insert(key.to_string(), DayValue { day, spent });
}

/// A task hash argument: exactly 64 lowercase hex characters, otherwise `bad task hash` (the text of `revoke_task` and `get_task_state`).
fn parse_task_hash(text: &str) -> [u8; 32] {
    Hex32::parse(text)
        .unwrap_or_else(|_| env::panic_str("bad task hash"))
        .0
}

impl Contract {
    /// What the four ledgers hold for these keys at block time `now_ms`: a day ledger whose stored bucket is of another day reads 0.
    pub fn spent_now(&self, k: &LedgerKey, now_ms: u64) -> Spent {
        let day = utc_day(now_ms);
        Spent {
            asset_day: day_value(&self.asset_spent, &k.asset, day).unwrap_or(0),
            payee_day: day_value(&self.payee_spent, &k.payee, day).unwrap_or(0),
            payee_untrusted_day: day_value(&self.payee_untrusted_spent, &k.payee, day).unwrap_or(0),
            task: self
                .task_spent
                .get(&(k.task_hash, k.payee.clone()))
                .copied()
                .unwrap_or(0),
        }
    }

    /// Writes all four ledgers: the day ledgers with the day of `now_ms`, the task ledger as is.
    fn store_spent(&mut self, k: &LedgerKey, n: &Spent, now_ms: u64) {
        let day = utc_day(now_ms);
        day_write(&mut self.asset_spent, &k.asset, day, n.asset_day);
        day_write(&mut self.payee_spent, &k.payee, day, n.payee_day);
        day_write(
            &mut self.payee_untrusted_spent,
            &k.payee,
            day,
            n.payee_untrusted_day,
        );
        self.task_spent
            .insert((k.task_hash, k.payee.clone()), n.task);
    }

    /// Charges an auto-executed payment to all four ledgers (`ledger::apply_allow`) and returns what was applied, for the request record.
    /// An overflow or a cap exceeded, which the verdict should have prevented, reverts the whole transaction: `ledger overflow`.
    pub fn charge_allow(
        &mut self,
        k: &LedgerKey,
        caps: &Caps,
        amount: u128,
        amount_untrusted: bool,
        now_ms: u64,
    ) -> ChargeRec {
        let spent = self.spent_now(k, now_ms);
        let ch = ledger::charge_for_allow(amount, amount_untrusted);
        let Some((n, applied)) = ledger::apply_allow(&spent, &ch, caps) else {
            env::panic_str("ledger overflow")
        };
        self.store_spent(k, &n, now_ms);
        applied.into()
    }

    /// Charges an owner approval (`ledger::apply_approval`: the asset day is checked, the payee day and the task ledger saturate at their
    /// caps, the untrusted budget is untouched) and returns what was applied. `None` (the asset day cap, which the recheck should have
    /// caught) reverts: `ledger overflow`.
    pub fn charge_approval(
        &mut self,
        k: &LedgerKey,
        caps: &Caps,
        amount: u128,
        now_ms: u64,
    ) -> ChargeRec {
        let spent = self.spent_now(k, now_ms);
        let ch = ledger::charge_for_approval(amount);
        let Some((n, applied)) = ledger::apply_approval(&spent, &ch, caps) else {
            env::panic_str("ledger overflow")
        };
        self.store_spent(k, &n, now_ms);
        applied.into()
    }

    /// Gives back what `rec.applied_charge` took. Only a record in state `Executing` with an applied charge is refunded; anything else is a
    /// no-op. A day ledger is restored only when its stored bucket is still of `rec.charge_day` (after a day change the bucket was already
    /// reset, nothing to restore); the task ledger is always restored. An underflow (state edited by hand) reverts: `ledger underflow`.
    pub fn refund(&mut self, rec: &RequestRecord) {
        if rec.state != RequestState::Executing {
            return;
        }
        let Some(applied) = rec.applied_charge.clone() else {
            return;
        };
        let charge: Charge = applied.into();
        let k = LedgerKey {
            asset: rec.asset.clone(),
            payee: rec.payee.clone(),
            task_hash: rec.task_hash,
        };
        let day = rec.charge_day;
        let asset_now = day_value(&self.asset_spent, &k.asset, day);
        let payee_now = day_value(&self.payee_spent, &k.payee, day);
        let untrusted_now = day_value(&self.payee_untrusted_spent, &k.payee, day);
        // `ledger::refund` subtracts all four fields: a skipped ledger gets a field equal to the applied charge, and is not written back
        let current = Spent {
            asset_day: asset_now.unwrap_or(charge.asset_day),
            payee_day: payee_now.unwrap_or(charge.payee_day),
            payee_untrusted_day: untrusted_now.unwrap_or(charge.payee_untrusted_day),
            task: self
                .task_spent
                .get(&(k.task_hash, k.payee.clone()))
                .copied()
                .unwrap_or(0),
        };
        let Some(n) = ledger::refund(&current, &charge) else {
            env::panic_str("ledger underflow")
        };
        if asset_now.is_some() {
            day_write(&mut self.asset_spent, &k.asset, day, n.asset_day);
        }
        if payee_now.is_some() {
            day_write(&mut self.payee_spent, &k.payee, day, n.payee_day);
        }
        if untrusted_now.is_some() {
            day_write(
                &mut self.payee_untrusted_spent,
                &k.payee,
                day,
                n.payee_untrusted_day,
            );
        }
        self.task_spent.insert((k.task_hash, k.payee), n.task);
    }

    /// What is left under `caps` after the charges so far (`ledger::remaining`, saturating: 0 when spent is above the cap, as after a
    /// saturating approval). `task` is `Some` exactly when the request has a task bound. The `allowed` and `approved` events call this after
    /// the charge, so their `*_remaining` fields are post-charge values.
    pub fn remaining(
        &self,
        k: &LedgerKey,
        caps: &Caps,
        bound: Option<u128>,
        now_ms: u64,
    ) -> Remaining {
        let r = ledger::remaining(&self.spent_now(k, now_ms), caps);
        Remaining {
            asset_day: r.asset_day,
            payee_day: r.payee_day,
            payee_untrusted_day: r.payee_untrusted_day,
            task: bound.map(|_| r.task),
        }
    }
}

#[near]
impl Contract {
    /// The ledgers of a payee under an asset for the current UTC day, and what a task has paid that payee (`task` is the task hash in 64
    /// lowercase hex, otherwise `bad task hash`). Caps are the asset's `daily_cap` and the payee's `daily_limit` and
    /// `daily_untrusted_budget`; an unknown payee or asset has zero caps, not a panic. The contract stores no task bounds, so the caller
    /// that holds the signed task computes the task remainder.
    pub fn get_ledgers(&self, payee: String, asset: String, task: Option<String>) -> LedgersView {
        let hash = task.as_deref().map(parse_task_hash);
        let caps = Caps {
            asset_daily: self.assets.get(&asset).map_or(0, |a| a.daily_cap),
            payee_limit: self.book.get(&payee).map_or(0, |p| p.daily_limit),
            payee_budget: self
                .book
                .get(&payee)
                .map_or(0, |p| p.daily_untrusted_budget),
            task_bound: 0,
        };
        let k = LedgerKey {
            asset,
            payee,
            task_hash: hash.unwrap_or([0; 32]),
        };
        let spent = self.spent_now(&k, block_timestamp_ms());
        let r = ledger::remaining(&spent, &caps);
        let amount = |spent: u128, cap: u128, remaining: u128| Amount {
            spent: U128(spent),
            cap: U128(cap),
            remaining: U128(remaining),
        };
        LedgersView {
            asset_day: amount(spent.asset_day, caps.asset_daily, r.asset_day),
            payee_day: amount(spent.payee_day, caps.payee_limit, r.payee_day),
            payee_untrusted_day: amount(
                spent.payee_untrusted_day,
                caps.payee_budget,
                r.payee_untrusted_day,
            ),
            task_spent: hash.map(|_| U128(spent.task)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::RequestState;
    use crate::testutil::{ctx, fresh};
    use near_sdk::testing_env;

    const PAYEE: &str = "near:acct.test.near";
    const OTHER_PAYEE: &str = "near:other.test.near";
    const OWNER_LABELS: u16 = 1;
    const EMAIL_LABELS: u16 = 32;
    const DAY_MS: u64 = 86_400_000;

    fn asset_entry() -> AssetEntry {
        AssetEntry {
            symbol: "near".to_string(),
            decimals: 24,
            hard_cap: 10_000,
            daily_cap: 100_000,
            max_fee_per_gas: 0,
            max_gas: 0,
            quick_task_cap: 0,
            path: None,
        }
    }

    fn book_entry() -> BookEntry {
        BookEntry {
            cap: Some(100),
            daily_untrusted_budget: 1_000,
            daily_limit: 5_000,
            label: "acct".to_string(),
        }
    }

    /// A contract with asset `near` (hard cap 10,000, daily cap 100,000) and payee `PAYEE` (cap 100, untrusted budget 1,000, daily limit 5,000).
    fn setup() -> Contract {
        let mut c = fresh();
        c.assets.insert("near".to_string(), asset_entry());
        c.book.insert(PAYEE.to_string(), book_entry());
        c
    }

    fn key(payee: &str, task: u8) -> LedgerKey {
        LedgerKey {
            asset: "near".to_string(),
            payee: payee.to_string(),
            task_hash: [task; 32],
        }
    }

    fn caps(bound: u128) -> Caps {
        caps_for(&asset_entry(), &book_entry(), bound)
    }

    fn rec(charge: Option<ChargeRec>, state: RequestState, charge_day: u64) -> RequestRecord {
        RequestRecord {
            agent: "agent.test.near".parse().unwrap(),
            task_hash: [1; 32],
            task_id: "t1".to_string(),
            index: 0,
            asset: "near".to_string(),
            payee: PAYEE.to_string(),
            amount: 0,
            labels: Labels {
                recipient: 2,
                amount: OWNER_LABELS,
                pc: 1,
            },
            evm: None,
            reason: None,
            state,
            retried: false,
            applied_charge: charge,
            charge_day,
            created_ms: 0,
            pending: None,
            exec: None,
        }
    }

    fn charge_rec(asset_day: u128, payee_day: u128, untrusted: u128, task: u128) -> ChargeRec {
        ChargeRec {
            asset_day,
            payee_day,
            payee_untrusted_day: untrusted,
            task,
        }
    }

    fn spent(asset_day: u128, payee_day: u128, untrusted: u128, task: u128) -> Spent {
        Spent {
            asset_day,
            payee_day,
            payee_untrusted_day: untrusted,
            task,
        }
    }

    fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default()
    }

    /// Runs `f` and returns its panic text (fails when it does not panic).
    fn panics<R>(f: impl FnOnce() -> R) -> String {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(_) => panic!("expected a revert, the call succeeded"),
            Err(payload) => panic_text(payload),
        }
    }

    #[test]
    fn ledgers_each_ledger_is_charged_and_read_back() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let charged = c.charge_allow(&k, &caps(5_000), 500, false, 1_000);
        assert_eq!(charged, charge_rec(500, 500, 0, 500));
        assert_eq!(c.spent_now(&k, 1_000), spent(500, 500, 0, 500));
        let again = c.charge_allow(&k, &caps(5_000), 250, true, 2_000);
        assert_eq!(again, charge_rec(250, 250, 250, 250));
        assert_eq!(c.spent_now(&k, 2_000), spent(750, 750, 250, 750));
    }

    #[test]
    fn ledgers_untrusted_budget_is_charged_only_for_untrusted_amounts() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let trusted = c.charge_allow(&k, &caps(5_000), 100, false, 0);
        assert_eq!(trusted.payee_untrusted_day, 0);
        let untrusted = c.charge_allow(&k, &caps(5_000), 100, true, 0);
        assert_eq!(untrusted.payee_untrusted_day, 100);
        assert_eq!(c.spent_now(&k, 0).payee_untrusted_day, 100);
    }

    #[test]
    fn ledgers_day_buckets_split_at_the_exact_millisecond() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let _ = c.charge_allow(&k, &caps(5_000), 500, true, DAY_MS - 1);
        assert_eq!(c.spent_now(&k, DAY_MS - 1), spent(500, 500, 500, 500));
        // one millisecond later it is the next UTC day: the three day ledgers read 0, the task ledger does not
        assert_eq!(c.spent_now(&k, DAY_MS), spent(0, 0, 0, 500));
    }

    #[test]
    fn ledgers_a_charge_on_the_next_day_overwrites_the_bucket() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let _ = c.charge_allow(&k, &caps(5_000), 500, false, DAY_MS - 1);
        let _ = c.charge_allow(&k, &caps(5_000), 300, false, DAY_MS);
        // the day ledgers hold only the second day, the task ledger holds both
        assert_eq!(c.spent_now(&k, DAY_MS), spent(300, 300, 0, 800));
        // reading the first day again finds a bucket of a later day: 0, not the old value
        assert_eq!(c.spent_now(&k, DAY_MS - 1), spent(0, 0, 0, 800));
    }

    #[test]
    fn day_boundary_ignores_local_midnight() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        // 07:00 UTC is midnight on the US west coast: nothing changes there
        let seven = 7 * 3_600_000;
        let _ = c.charge_allow(&k, &caps(5_000), 400, false, 0);
        assert_eq!(c.spent_now(&k, seven - 1), spent(400, 400, 0, 400));
        assert_eq!(c.spent_now(&k, seven), spent(400, 400, 0, 400));
        assert_eq!(c.spent_now(&k, DAY_MS - 1), spent(400, 400, 0, 400));
        assert_eq!(c.spent_now(&k, DAY_MS), spent(0, 0, 0, 400));
    }

    #[test]
    fn ledgers_refund_restores_the_exact_prior_values() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let _ = c.charge_allow(&k, &caps(5_000), 100, true, 5_000);
        let before = c.spent_now(&k, 5_000);
        let applied = c.charge_allow(&k, &caps(5_000), 700, true, 6_000);
        assert_ne!(c.spent_now(&k, 6_000), before);
        c.refund(&rec(Some(applied), RequestState::Executing, 0));
        assert_eq!(c.spent_now(&k, 6_000), before);
    }

    #[test]
    fn ledgers_refund_after_a_day_change_restores_only_the_task_ledger() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let first = c.charge_allow(&k, &caps(5_000), 500, true, 1_000);
        let _second = c.charge_allow(&k, &caps(5_000), 300, true, DAY_MS + 1_000);
        assert_eq!(c.spent_now(&k, DAY_MS + 1_000), spent(300, 300, 300, 800));
        // the first charge belongs to day 0, whose bucket was overwritten: only the task ledger gives it back
        c.refund(&rec(Some(first), RequestState::Executing, 0));
        assert_eq!(c.spent_now(&k, DAY_MS + 1_000), spent(300, 300, 300, 300));
    }

    #[test]
    fn ledgers_refund_is_a_no_op_without_an_applied_charge_or_outside_executing() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let applied = c.charge_allow(&k, &caps(5_000), 500, false, 0);
        let before = c.spent_now(&k, 0);
        c.refund(&rec(None, RequestState::Executing, 0));
        for state in [
            RequestState::Pending,
            RequestState::Rejected,
            RequestState::Expired,
            RequestState::Blocked,
            RequestState::Executed,
            RequestState::Retryable,
            RequestState::Failed,
        ] {
            c.refund(&rec(Some(applied.clone()), state, 0));
            assert_eq!(c.spent_now(&k, 0), before, "{state:?}");
        }
    }

    #[test]
    fn ledgers_a_charge_over_the_cap_reverts_ledger_overflow() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let text = panics(|| c.charge_allow(&k, &caps(500), 501, false, 0));
        assert!(text.contains("ledger overflow"), "{text}");
        // a sum past u128 is the same revert, not a wrap
        let wide = Caps {
            asset_daily: u128::MAX,
            payee_limit: u128::MAX,
            payee_budget: u128::MAX,
            task_bound: u128::MAX,
        };
        let _ = c.charge_allow(&k, &wide, u128::MAX, false, 0);
        let text = panics(|| c.charge_allow(&k, &wide, 1, false, 0));
        assert!(text.contains("ledger overflow"), "{text}");
    }

    #[test]
    fn ledgers_an_approval_over_the_payee_limit_saturates_it_and_leaves_the_untrusted_budget() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        // a trusted 4,500: an untrusted one would be refused by the 1,000 untrusted budget
        let _ = c.charge_allow(&k, &caps(5_000), 4_500, false, 0);
        let before = c.spent_now(&k, 0);
        let applied = c.charge_approval(
            &k,
            &approval_caps(&asset_entry(), Some(&book_entry()), 5_000),
            900,
            0,
        );
        // the payee day had 500 left of 5,000: only that much is applied, the asset day takes the full 900
        assert_eq!(applied, charge_rec(900, 500, 0, 500));
        let now = c.spent_now(&k, 0);
        assert_eq!(now.payee_day, 5_000);
        assert_eq!(now.asset_day, before.asset_day + 900);
        assert_eq!(now.payee_untrusted_day, before.payee_untrusted_day);
    }

    #[test]
    fn charge_approval_without_book_entry_records_payee_day() {
        let mut c = setup();
        let k = key(OTHER_PAYEE, 1);
        let caps = approval_caps(&asset_entry(), None, 5_000);
        assert_eq!(caps.payee_limit, u128::MAX);
        assert_eq!(caps.payee_budget, 0);
        let applied = c.charge_approval(&k, &caps, 900, 0);
        assert_eq!(applied, charge_rec(900, 900, 0, 900));
        assert_eq!(c.spent_now(&k, 0), spent(900, 900, 0, 900));
        // a later book_add sees the payee's day ledger
        c.book.insert(OTHER_PAYEE.to_string(), book_entry());
        assert_eq!(c.spent_now(&k, 0).payee_day, 900);
    }

    #[test]
    fn ledgers_charge_rec_round_trips_through_charge() {
        let rec = charge_rec(1, 2, 3, u128::MAX);
        let charge: Charge = rec.clone().into();
        assert_eq!(charge.asset_day, 1);
        assert_eq!(charge.payee_day, 2);
        assert_eq!(charge.payee_untrusted_day, 3);
        assert_eq!(charge.task, u128::MAX);
        assert_eq!(ChargeRec::from(charge), rec);
    }

    #[test]
    fn ledgers_task_ledger_is_keyed_by_task_and_payee() {
        let mut c = setup();
        let _ = c.charge_allow(&key(PAYEE, 1), &caps(5_000), 100, false, 0);
        let _ = c.charge_allow(&key(PAYEE, 2), &caps(5_000), 200, false, 0);
        let _ = c.charge_allow(&key(OTHER_PAYEE, 1), &caps(5_000), 300, false, 0);
        assert_eq!(c.spent_now(&key(PAYEE, 1), 0).task, 100);
        assert_eq!(c.spent_now(&key(PAYEE, 2), 0).task, 200);
        assert_eq!(c.spent_now(&key(OTHER_PAYEE, 1), 0).task, 300);
        assert_eq!(c.spent_now(&key(PAYEE, 3), 0).task, 0);
    }

    #[test]
    fn ledgers_day_ledgers_are_keyed_by_asset_and_by_payee() {
        let mut c = setup();
        let _ = c.charge_allow(&key(PAYEE, 1), &caps(5_000), 100, false, 0);
        // the same payee under another asset: its own asset ledger, the payee ledger is shared
        let other_asset = LedgerKey {
            asset: "eth".to_string(),
            payee: PAYEE.to_string(),
            task_hash: [1; 32],
        };
        let s = c.spent_now(&other_asset, 0);
        assert_eq!((s.asset_day, s.payee_day), (0, 100));
        // another payee under the same asset: the asset ledger is shared, the payee ledger is its own
        let s = c.spent_now(&key(OTHER_PAYEE, 1), 0);
        assert_eq!((s.asset_day, s.payee_day), (100, 0));
    }

    #[test]
    fn ledgers_is_untrusted_amount_follows_value_trusted() {
        let labels = |amount| Labels {
            recipient: 2,
            amount,
            pc: 1,
        };
        assert!(!is_untrusted_amount(&labels(OWNER_LABELS)));
        assert!(!is_untrusted_amount(&labels(8))); // Oracle
        assert!(!is_untrusted_amount(&labels(1 | 2 | 4)));
        assert!(is_untrusted_amount(&labels(EMAIL_LABELS)));
        assert!(is_untrusted_amount(&labels(16))); // Unresolved
        assert!(is_untrusted_amount(&labels(0)));
        assert!(is_untrusted_amount(&labels(OWNER_LABELS | EMAIL_LABELS)));
    }

    #[test]
    fn ledgers_view_is_zero_for_an_unknown_payee_and_asset() {
        let c = setup();
        testing_env!(ctx("anyone.test.near", 1_000, 0).build());
        let v = c.get_ledgers("near:nobody.test.near".to_string(), "eth".to_string(), None);
        let zero = Amount {
            spent: U128(0),
            cap: U128(0),
            remaining: U128(0),
        };
        assert_eq!(v.asset_day, zero);
        assert_eq!(v.payee_day, zero);
        assert_eq!(v.payee_untrusted_day, zero);
        assert_eq!(v.task_spent, None);
    }

    #[test]
    fn ledgers_view_reads_spent_cap_and_remaining() {
        let mut c = setup();
        let hash = hex::encode([1u8; 32]);
        let _ = c.charge_allow(&key(PAYEE, 1), &caps(5_000), 400, true, 1_000);
        testing_env!(ctx("anyone.test.near", 1_000, 0).build());
        let v = c.get_ledgers(PAYEE.to_string(), "near".to_string(), Some(hash));
        assert_eq!(
            v.asset_day,
            Amount {
                spent: U128(400),
                cap: U128(100_000),
                remaining: U128(99_600)
            }
        );
        assert_eq!(
            v.payee_day,
            Amount {
                spent: U128(400),
                cap: U128(5_000),
                remaining: U128(4_600)
            }
        );
        assert_eq!(
            v.payee_untrusted_day,
            Amount {
                spent: U128(400),
                cap: U128(1_000),
                remaining: U128(600)
            }
        );
        assert_eq!(v.task_spent, Some(U128(400)));
        // the next UTC day: the day ledgers read 0 again, the task ledger keeps its total
        testing_env!(ctx("anyone.test.near", DAY_MS, 0).build());
        let next = c.get_ledgers(
            PAYEE.to_string(),
            "near".to_string(),
            Some(hex::encode([1u8; 32])),
        );
        assert_eq!(next.asset_day.spent, U128(0));
        assert_eq!(next.task_spent, Some(U128(400)));
    }

    #[test]
    fn ledgers_view_rejects_a_bad_task_hash() {
        let c = setup();
        testing_env!(ctx("anyone.test.near", 1_000, 0).build());
        for bad in [
            "",
            "ab",
            &"A".repeat(64),
            &"g".repeat(64),
            &"a".repeat(63),
            &"a".repeat(65),
        ] {
            let text = panics(|| {
                c.get_ledgers(PAYEE.to_string(), "near".to_string(), Some(bad.to_string()))
            });
            assert!(text.contains("bad task hash"), "{bad:?}: {text}");
        }
    }

    #[test]
    fn remaining_after_a_charge_equals_cap_minus_spent() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let caps = caps(5_000);
        let _ = c.charge_allow(&k, &caps, 400, true, 0);
        let r = c.remaining(&k, &caps, Some(5_000), 0);
        assert_eq!(
            r,
            Remaining {
                asset_day: 99_600,
                payee_day: 4_600,
                payee_untrusted_day: 600,
                task: Some(4_600),
            }
        );
    }

    #[test]
    fn remaining_is_zero_not_a_panic_after_a_saturating_approval() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let approval = approval_caps(&asset_entry(), Some(&book_entry()), 500);
        let _ = c.charge_approval(&k, &approval, 900, 0);
        let r = c.remaining(&k, &approval, Some(500), 0);
        assert_eq!(r.payee_day, 4_100);
        assert_eq!(r.task, Some(0));
        // a cap lowered below what is spent also reads as 0
        let lowered = Caps {
            payee_limit: 100,
            task_bound: 100,
            ..approval
        };
        let r = c.remaining(&k, &lowered, Some(100), 0);
        assert_eq!((r.payee_day, r.task), (0, Some(0)));
    }

    #[test]
    fn remaining_task_is_none_for_a_none_bound() {
        let mut c = setup();
        let k = key(PAYEE, 1);
        let caps = caps(5_000);
        let _ = c.charge_allow(&k, &caps, 10, false, 0);
        assert_eq!(c.remaining(&k, &caps, None, 0).task, None);
        assert_eq!(c.remaining(&k, &caps, Some(5_000), 0).task, Some(4_990));
    }

    #[test]
    fn remaining_view_json_has_decimal_strings() {
        let mut c = setup();
        let _ = c.charge_allow(&key(PAYEE, 1), &caps(5_000), 400, false, 1_000);
        testing_env!(ctx("anyone.test.near", 1_000, 0).build());
        let v = c.get_ledgers(
            PAYEE.to_string(),
            "near".to_string(),
            Some(hex::encode([1u8; 32])),
        );
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["asset_day"]["spent"], "400");
        assert_eq!(json["asset_day"]["cap"], "100000");
        assert_eq!(json["asset_day"]["remaining"], "99600");
        assert_eq!(json["payee_untrusted_day"]["remaining"], "1000");
        assert_eq!(json["task_spent"], "400");
        let none = c.get_ledgers(PAYEE.to_string(), "near".to_string(), None);
        assert_eq!(
            serde_json::to_value(&none).unwrap()["task_spent"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn verdict_inputs_without_a_payee_gives_none_payee() {
        let a = asset_entry();
        let i = verdict_inputs(Some(&a), None, Some(500), &spent(0, 0, 0, 0));
        assert!(i.asset.is_some());
        assert!(i.payee.is_none());
        assert!(i.task.is_some());
    }

    #[test]
    fn verdict_inputs_without_a_bound_gives_none_task() {
        let (a, p) = (asset_entry(), book_entry());
        let i = verdict_inputs(Some(&a), Some(&p), None, &spent(0, 0, 0, 0));
        assert!(i.task.is_none());
        assert!(i.asset.is_some() && i.payee.is_some());
    }

    #[test]
    fn verdict_inputs_without_an_asset_gives_none_asset() {
        let p = book_entry();
        let i = verdict_inputs(None, Some(&p), Some(500), &spent(0, 0, 0, 0));
        assert!(i.asset.is_none());
        assert!(i.payee.is_some() && i.task.is_some());
    }

    #[test]
    fn verdict_inputs_maps_remaining_values_field_by_field() {
        let (a, p) = (asset_entry(), book_entry());
        // spent 4,000 of the asset day, 1,200 of the payee day, 300 of the budget, 80 of a task bound of 500
        let i = verdict_inputs(Some(&a), Some(&p), Some(500), &spent(4_000, 1_200, 300, 80));
        let asset = i.asset.unwrap();
        assert_eq!(asset.hard_cap, 10_000);
        assert_eq!(asset.remaining_daily, 96_000);
        assert_eq!((asset.max_fee_per_gas, asset.max_gas), (0, 0));
        let payee = i.payee.unwrap();
        assert_eq!(payee.cap, Some(100));
        assert_eq!(payee.budget_remaining, 700);
        assert_eq!(payee.limit_remaining, 3_800);
        assert_eq!(i.task.unwrap().remaining, 420);
        // spent past a cap reads as 0 remaining, not a panic
        let i = verdict_inputs(Some(&a), Some(&p), Some(50), &spent(0, 9_999, 9_999, 80));
        assert_eq!(i.payee.unwrap().limit_remaining, 0);
        assert_eq!(i.task.unwrap().remaining, 0);
    }
}

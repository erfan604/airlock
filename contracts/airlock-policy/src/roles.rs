// AIR-327: the approver role, the sponsor and `sweep` (docs/design/credit.md). A card policy of AIRLOCK Credit has three parties:
// the owner is the issuer (book, caps, pause, agents, sweep), the approver is the borrower (approve and reject held payments only; the owner may reject too) and
// the sponsor is the pool (the only account `sweep` can pay). With no approver and no sponsor nothing changes: the owner approves and
// there is no sweep. Both fields are fixed at init, so no call can move the approval to the account that wants the money.
use crate::*;
use near_sdk::json_types::U128;
use near_sdk::{NearToken, Promise, assert_one_yocto};

pub const GAS_ON_CARD_RETURN: Gas = Gas::from_tgas(20);
pub const GAS_ON_SWEEP: Gas = Gas::from_tgas(5);

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RolesView {
    pub owner_id: AccountId,
    pub approver: Option<AccountId>,
    pub sponsor: Option<AccountId>,
}

impl Contract {
    /// The guard of `approve`, `approve_and_remember` and `reject` (AIR-327): exactly one yoctoNEAR, then the predecessor is the approver or the
    /// owner when an approver is set (which of them may settle which escalation is `require_settle_role`), the owner alone when none is.
    pub(crate) fn settle_call(&mut self) {
        match &self.approver {
            None => self.owner_call(),
            Some(approver) => {
                assert_one_yocto();
                let who = env::predecessor_account_id();
                require!(
                    &who == approver || who == self.owner_id,
                    "Caller is not the approver or the owner"
                );
            }
        }
    }

    /// The split of `approve` when an approver is set. The borrower holds the approver key and controls the agent, so he must never be
    /// able to approve a payment to an account the issuer did not put in the book (his own, say): the approver settles only an escalation
    /// whose payee is in the book at the current epoch (`in_book_now`: the stored status is `in_book` and the book has not changed
    /// since, which needs a valid proof, AIR-326). Any other escalation (a new payee, a withheld proof, a stale status) is the issuer's
    /// to override, and the approver can still reject it. Without an approver nothing is checked here.
    pub(crate) fn require_settle_role(&self, in_book_now: bool) {
        if let Some(approver) = &self.approver {
            if &env::predecessor_account_id() == approver {
                require!(
                    in_book_now,
                    "approve refused for the approver: the payee is not in the book at this epoch (a new payee, a withheld proof or a book change since); reject it, or the owner may approve it as an override"
                );
            } else {
                require!(
                    !in_book_now,
                    "approve refused for the owner: the payee is in the book, the approver settles it"
                );
            }
        }
    }
}

#[near]
impl Contract {
    /// The three roles: the issuer, the approver (None: the owner approves) and the sponsor (None: no sweep).
    pub fn get_roles(&self) -> RolesView {
        RolesView {
            owner_id: self.owner_id.clone(),
            approver: self.approver.clone(),
            sponsor: self.sponsor.clone(),
        }
    }

    /// Owner: return `amount` of the card's balance to the sponsor, as the function call `on_card_return({card})` with the amount as its
    /// deposit, never a plain transfer and never to another account. `#[payable]`, exactly 1 yoctoNEAR (`owner_call`). In this order, each
    /// failure a revert: a sponsor is set (`no sponsor`), `amount` is positive, no escalation is pending (`escalations are pending`: a
    /// held payment the approver may still tap must stay funded; pending escalations expire after their TTL and anyone may `expire`
    /// them), and `amount` is at most the balance minus the storage cost (`exceeds the spendable balance`). A request already paying
    /// is not tracked: if the sweep leaves it short, its transfer fails and the contract refunds its ledgers (AIR-105). Emits `swept`; when
    /// the sponsor's credit fails the deposit comes back to this account and `sweep_result` says `ok: false`.
    #[payable]
    pub fn sweep(&mut self, amount: U128) -> Promise {
        self.owner_call();
        let sponsor = self
            .sponsor
            .clone()
            .unwrap_or_else(|| env::panic_str("no sponsor: sweep is not available"));
        require!(amount.0 > 0, "sweep amount must be positive");
        require!(
            self.pending_nos.is_empty(),
            "sweep refused: escalations are pending"
        );
        let storage = env::storage_byte_cost()
            .as_yoctonear()
            .saturating_mul(u128::from(env::storage_usage()));
        let spendable = env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage);
        require!(amount.0 <= spendable, "sweep exceeds the spendable balance");
        Event::Swept {
            sponsor: &sponsor,
            amount,
        }
        .emit();
        let card = env::current_account_id();
        Promise::new(sponsor.clone())
            .function_call(
                "on_card_return".to_string(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({ "card": card }))
                    .unwrap_or_default(),
                NearToken::from_yoctonear(amount.0),
                GAS_ON_CARD_RETURN,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SWEEP)
                    .on_sweep(sponsor, amount),
            )
    }

    /// Callback of `sweep`: only the result is logged. Never panics.
    #[private]
    pub fn on_sweep(&mut self, sponsor: AccountId, amount: U128) {
        // the credit's own return value does not matter; only a failed call is a failure (a too long answer means it ran)
        let ok = !matches!(
            env::promise_result_checked(0, 1_024),
            Err(near_sdk::PromiseError::Failed)
        );
        Event::SweepResult {
            sponsor: &sponsor,
            amount,
            ok,
        }
        .emit();
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::*;
    use crate::*;
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::{get_created_receipts, get_logs};
    use near_sdk::testing_env;

    fn panics<R>(f: impl FnOnce() -> R) -> String {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(_) => panic!("expected a revert, the call succeeded"),
            Err(p) => p
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| (*s).to_string()))
                .unwrap_or_default(),
        }
    }

    const STRANGER: &str = "stranger.test.near";

    fn as_caller(who: &str, yocto: u128) {
        testing_env!(ctx(who, 5_000, yocto).build());
    }

    // ---- defaults: no approver, no sponsor ----

    #[test]
    fn roles_default_has_no_approver_and_no_sponsor() {
        let c = fresh();
        let r = c.get_roles();
        assert_eq!(r.owner_id.as_str(), OWNER);
        assert!(r.approver.is_none() && r.sponsor.is_none());
    }

    #[test]
    fn roles_default_owner_approves_and_rejects_and_a_stranger_is_told_owner() {
        let mut c = fresh();
        as_caller(OWNER, 1);
        // the owner passes the gate and meets the next check (no such escalation)
        assert!(
            panics(|| c.approve(
                "1".into(),
                "x".into(),
                "x".into(),
                "1".into(),
                "x".into(),
                "x".into()
            ))
            .contains("unknown id")
        );
        assert!(panics(|| c.reject("1".into())).contains("unknown id"));
        as_caller(STRANGER, 1);
        assert!(
            panics(|| c.approve(
                "1".into(),
                "x".into(),
                "x".into(),
                "1".into(),
                "x".into(),
                "x".into()
            ))
            .contains("Caller is not the owner")
        );
        assert!(panics(|| c.reject("1".into())).contains("Caller is not the owner"));
    }

    #[test]
    fn roles_default_sweep_is_not_available() {
        let mut c = fresh();
        as_caller(OWNER, 1);
        assert!(panics(|| c.sweep(U128(1))).contains("no sponsor"));
    }

    // ---- an approver is set ----

    #[test]
    fn roles_gates_with_an_approver_set() {
        let mut c = fresh_roles(Some(APPROVER), None);
        assert_eq!(c.get_roles().approver.unwrap().as_str(), APPROVER);
        let approve = |c: &mut Contract| {
            c.approve(
                "1".into(),
                "x".into(),
                "x".into(),
                "1".into(),
                "x".into(),
                "x".into(),
            )
        };
        // the approver and the owner pass the gate of approve (the role split on the escalation is tested in the red-team cases)
        for who in [APPROVER, OWNER] {
            as_caller(who, 1);
            assert!(panics(|| approve(&mut c)).contains("unknown id"), "{who}");
        }
        // reject moves no money: the approver and the owner may reject, a stranger may not
        for who in [APPROVER, OWNER] {
            as_caller(who, 1);
            assert!(
                panics(|| c.reject("1".into())).contains("unknown id"),
                "{who}"
            );
        }
        as_caller(STRANGER, 1);
        assert!(
            panics(|| c.reject("1".into())).contains("Caller is not the approver or the owner")
        );
        // a stranger cannot approve
        as_caller(STRANGER, 1);
        assert!(panics(|| approve(&mut c)).contains("Caller is not the approver or the owner"));
    }

    #[test]
    fn roles_approver_needs_exactly_one_yocto() {
        let mut c = fresh_roles(Some(APPROVER), None);
        for deposit in [0u128, 2] {
            as_caller(APPROVER, deposit);
            assert!(
                panics(|| c.reject("1".into()))
                    .contains("Requires attached deposit of exactly 1 yoctoNEAR")
            );
        }
    }

    #[test]
    fn roles_approve_and_remember_is_refused_when_an_approver_is_set() {
        let mut c = fresh_roles(Some(APPROVER), None);
        let args = || {
            (
                "1".to_string(),
                "x".to_string(),
                "x".to_string(),
                "1".to_string(),
                "x".to_string(),
                "x".to_string(),
            )
        };
        let entry = crate::book::BookProof {
            salt: crate::request::Hex32([0; 32]),
            cap: None,
            daily_untrusted_budget: U128(0),
            daily_limit: U128(0),
            index: 0,
            siblings: vec![],
        };
        for who in [APPROVER, OWNER] {
            as_caller(who, 1);
            let (a, b, d, e, f, g) = args();
            let text = panics(|| {
                c.approve_and_remember(
                    a,
                    b,
                    d,
                    e,
                    f,
                    g,
                    crate::request::Hex32([0; 32]),
                    crate::request::Hex32([1; 32]),
                    entry.clone(),
                )
            });
            assert!(
                text.contains("approve_and_remember is refused when an approver is set"),
                "{who}: {text}"
            );
            assert!(
                text.contains("book_set_root"),
                "the text says who adds merchants: {text}"
            );
        }
    }

    #[test]
    fn roles_approver_cannot_change_policy() {
        let mut c = fresh_roles(Some(APPROVER), Some(SPONSOR));
        as_caller(APPROVER, 1);
        let zero = crate::request::Hex32([0; 32]);
        assert!(
            panics(|| c.book_set_root(zero.clone(), crate::request::Hex32([1; 32])))
                .contains("Caller is not the owner")
        );
        assert!(panics(|| c.pause(true)).contains("Caller is not the owner"));
        assert!(
            panics(|| c.set_task_key("ed25519:11111111111111111111111111111111".into()))
                .contains("Caller is not the owner")
        );
        assert!(
            panics(|| c.allow_agent("a.test.near".parse().unwrap(), "x".into()))
                .contains("Caller is not the owner")
        );
        assert!(
            panics(|| c.reset_escalations("a.test.near".parse().unwrap(), None))
                .contains("Caller is not the owner")
        );
        assert!(panics(|| c.sweep(U128(1))).contains("Caller is not the owner"));
    }

    // ---- sweep ----

    #[test]
    fn roles_sweep_is_owner_only_with_one_yocto() {
        let mut c = fresh_roles(Some(APPROVER), Some(SPONSOR));
        for who in [STRANGER, APPROVER] {
            as_caller(who, 1);
            assert!(
                panics(|| c.sweep(U128(1))).contains("Caller is not the owner"),
                "{who}"
            );
        }
        for deposit in [0u128, 2] {
            as_caller(OWNER, deposit);
            assert!(
                panics(|| c.sweep(U128(1)))
                    .contains("Requires attached deposit of exactly 1 yoctoNEAR")
            );
        }
    }

    #[test]
    fn roles_sweep_sends_only_a_function_call_to_the_sponsor_with_the_card_id() {
        let mut c = fresh_roles(None, Some(SPONSOR));
        as_caller(OWNER, 1);
        let _ = c.sweep(U128(5_000));
        let receipts = get_created_receipts();
        assert_eq!(
            receipts.len(),
            2,
            "the credit and the result callback: {receipts:?}"
        );
        let first = &receipts[0];
        assert_eq!(
            first.receiver_id.as_str(),
            SPONSOR,
            "the only receiver of the credit is the sponsor"
        );
        assert_eq!(first.actions.len(), 1, "one action, no plain transfer");
        match &first.actions[0] {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } => {
                assert_eq!(method_name, b"on_card_return");
                assert_eq!(
                    std::str::from_utf8(args).unwrap(),
                    format!("{{\"card\":\"{POLICY}\"}}")
                );
                assert_eq!(attached_deposit.as_yoctonear(), 5_000);
            }
            other => panic!("not a function call: {other:?}"),
        }
        // no receipt of this call sends to any other account than the sponsor and this contract (the result callback)
        assert!(
            receipts
                .iter()
                .all(|r| r.receiver_id.as_str() == SPONSOR || r.receiver_id.as_str() == POLICY)
        );
        let logs = get_logs().join("\n");
        assert!(
            logs.contains("\"event\":\"swept\"") && logs.contains(SPONSOR),
            "{logs}"
        );
    }

    #[test]
    fn roles_sweep_refuses_zero_more_than_spendable_and_pending_escalations() {
        let mut c = fresh_roles(None, Some(SPONSOR));
        as_caller(OWNER, 1);
        assert!(panics(|| c.sweep(U128(0))).contains("sweep amount must be positive"));
        assert!(panics(|| c.sweep(U128(u128::MAX))).contains("exceeds the spendable balance"));
        c.pending_nos.insert(1);
        assert!(panics(|| c.sweep(U128(1))).contains("escalations are pending"));
    }

    #[test]
    fn roles_sweep_never_goes_below_the_storage_cost() {
        let mut c = fresh_roles(None, Some(SPONSOR));
        let storage = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        let balance = env::account_balance().as_yoctonear();
        let spendable = balance.saturating_sub(storage);
        as_caller(OWNER, 1);
        let text = panics(|| c.sweep(U128(spendable + 1)));
        assert!(text.contains("exceeds the spendable balance"), "{text}");
    }
}

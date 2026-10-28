//! AIR-020: the verdict rules 0 to 12 of SPEC 8.3, one test per row of the ticket table (t01 to t32).
//! Fixture: asset A {hard_cap 1000, remaining_daily 1000, max_fee 50, max_gas 100000}, not paused, task remaining 1000,
//! payee limit_remaining 1000 with cap None and budget 0, request recipient BOOK, amount OWNER, pc OWNER, amount 10.

use airlock_verdict::*;

/// Channel bit 5, the first untrusted channel (AIR-024 names the others).
const EMAIL: u16 = 1 << 5;

const U: u128 = u128::MAX;

#[derive(Clone, Copy)]
struct World {
    req: Request,
    asset: Option<AssetLimits>,
    payee: Option<Payee>,
    task: Option<TaskScope>,
    flags: Flags,
}

impl World {
    fn base() -> World {
        World {
            req: Request {
                amount: 10,
                fee_per_gas: None,
                gas: None,
                labels: Labels {
                    recipient: BOOK,
                    amount: OWNER,
                    pc: OWNER,
                },
            },
            asset: Some(AssetLimits {
                hard_cap: 1000,
                remaining_daily: 1000,
                max_fee_per_gas: 50,
                max_gas: 100_000,
            }),
            payee: Some(Payee {
                cap: None,
                budget_remaining: 0,
                limit_remaining: 1000,
            }),
            task: Some(TaskScope { remaining: 1000 }),
            flags: Flags { paused: false },
        }
    }

    fn v(&self) -> Verdict {
        verdict(&self.req, self.asset, self.payee, self.task, &self.flags)
    }

    fn amount(mut self, amount: u128) -> World {
        self.req.amount = amount;
        self
    }

    fn recipient(mut self, labels: u16) -> World {
        self.req.labels.recipient = labels;
        self
    }

    fn amount_labels(mut self, labels: u16) -> World {
        self.req.labels.amount = labels;
        self
    }

    fn pc(mut self, labels: u16) -> World {
        self.req.labels.pc = labels;
        self
    }

    fn fee(mut self, fee: Option<u128>) -> World {
        self.req.fee_per_gas = fee;
        self
    }

    fn gas(mut self, gas: Option<u128>) -> World {
        self.req.gas = gas;
        self
    }

    fn asset(mut self, asset: Option<AssetLimits>) -> World {
        self.asset = asset;
        self
    }

    fn daily(mut self, remaining_daily: u128) -> World {
        if let Some(a) = self.asset.as_mut() {
            a.remaining_daily = remaining_daily;
        }
        self
    }

    fn payee(mut self, payee: Option<Payee>) -> World {
        self.payee = payee;
        self
    }

    fn cap(mut self, cap: Option<u128>, budget_remaining: u128) -> World {
        if let Some(p) = self.payee.as_mut() {
            p.cap = cap;
            p.budget_remaining = budget_remaining;
        }
        self
    }

    fn limit(mut self, limit_remaining: u128) -> World {
        if let Some(p) = self.payee.as_mut() {
            p.limit_remaining = limit_remaining;
        }
        self
    }

    fn task(mut self, task: Option<u128>) -> World {
        self.task = task.map(|remaining| TaskScope { remaining });
        self
    }

    fn paused(mut self) -> World {
        self.flags.paused = true;
        self
    }
}

fn escalate(r: Reason) -> Verdict {
    Verdict::Escalate(r)
}

fn block(r: Reason) -> Verdict {
    Verdict::Block(r)
}

#[test]
fn t01_base_is_allow() {
    assert_eq!(World::base().v(), Verdict::Allow);
}

#[test]
fn t02_untrusted_amount_at_cap_and_budget_is_allow() {
    let w = World::base()
        .amount_labels(EMAIL)
        .amount(500)
        .cap(Some(500), 500);
    assert_eq!(w.v(), Verdict::Allow);
}

#[test]
fn t03_untrusted_amount_over_cap_escalates() {
    let w = World::base()
        .amount_labels(EMAIL)
        .amount(501)
        .cap(Some(500), 500);
    assert_eq!(w.v(), escalate(Reason::UntrustedAmount));
}

#[test]
fn t04_untrusted_amount_over_budget_escalates() {
    let w = World::base()
        .amount_labels(EMAIL)
        .amount(500)
        .cap(Some(500), 499);
    assert_eq!(w.v(), escalate(Reason::UntrustedAmount));
}

#[test]
fn t05_untrusted_amount_with_cap_none_escalates_strict_configuration() {
    let w = World::base().amount_labels(EMAIL).cap(None, 1000);
    assert_eq!(w.v(), escalate(Reason::UntrustedAmount));
}

#[test]
fn t06_unresolved_amount_escalates_even_under_cap() {
    let w = World::base().amount_labels(UNRESOLVED).cap(Some(500), 500);
    assert_eq!(w.v(), escalate(Reason::UntrustedAmount));
    let mixed = World::base()
        .amount_labels(UNRESOLVED | OWNER)
        .cap(Some(500), 500);
    assert_eq!(mixed.v(), escalate(Reason::UntrustedAmount));
}

#[test]
fn t07_untrusted_pc_escalates() {
    let w = World::base().pc(OWNER | EMAIL);
    assert_eq!(w.v(), escalate(Reason::UntrustedTrigger));
}

#[test]
fn t08_oracle_amount_and_oracle_pc_are_allow() {
    let w = World::base().amount_labels(ORACLE).pc(OWNER | ORACLE);
    assert_eq!(w.v(), Verdict::Allow);
}

#[test]
fn t09_book_label_without_book_entry_blocks() {
    let w = World::base().recipient(BOOK).payee(None);
    assert_eq!(w.v(), block(Reason::BookLabelNotInBook));
}

#[test]
fn t10_untrusted_recipient_without_entry_escalates() {
    let w = World::base().recipient(EMAIL).payee(None);
    assert_eq!(w.v(), escalate(Reason::UntrustedRecipient));
}

#[test]
fn t11_oracle_recipient_escalates() {
    let w = World::base().recipient(ORACLE);
    assert_eq!(w.v(), escalate(Reason::UntrustedRecipient));
}

#[test]
fn t12_owner_recipient_not_in_book_is_a_new_recipient() {
    let w = World::base().recipient(OWNER).payee(None);
    assert_eq!(w.v(), escalate(Reason::NewRecipient));
}

#[test]
fn t13_amount_bounds_are_hard_cap_inclusive_and_zero_blocks() {
    assert_eq!(World::base().amount(1000).v(), Verdict::Allow);
    assert_eq!(
        World::base().amount(1001).v(),
        block(Reason::AmountOutOfBounds)
    );
    assert_eq!(
        World::base().amount(0).v(),
        block(Reason::AmountOutOfBounds)
    );
}

#[test]
fn t14_remaining_daily_is_inclusive() {
    let w = World::base().daily(100);
    assert_eq!(w.amount(100).v(), Verdict::Allow);
    assert_eq!(w.amount(101).v(), block(Reason::DailyLimit));
}

#[test]
fn t15_each_empty_label_set_blocks_as_missing_provenance() {
    assert_eq!(
        World::base().recipient(0).v(),
        block(Reason::MissingProvenance)
    );
    assert_eq!(
        World::base().amount_labels(0).v(),
        block(Reason::MissingProvenance)
    );
    assert_eq!(World::base().pc(0).v(), block(Reason::MissingProvenance));
}

#[test]
fn t16_unknown_asset_blocks() {
    assert_eq!(World::base().asset(None).v(), block(Reason::UnknownAsset));
}

#[test]
fn t17_fee_and_gas_limits_are_inclusive_and_none_skips_rule_3() {
    let at_limit = World::base().fee(Some(50)).gas(Some(100_000));
    assert_eq!(at_limit.v(), Verdict::Allow);
    assert_eq!(at_limit.fee(Some(51)).v(), block(Reason::FeeTooHigh));
    assert_eq!(at_limit.gas(Some(100_001)).v(), block(Reason::FeeTooHigh));
    // one option alone is checked on its own
    assert_eq!(World::base().fee(Some(51)).v(), block(Reason::FeeTooHigh));
    assert_eq!(
        World::base().gas(Some(100_001)).v(),
        block(Reason::FeeTooHigh)
    );
    assert_eq!(World::base().fee(Some(50)).v(), Verdict::Allow);
    assert_eq!(World::base().gas(Some(100_000)).v(), Verdict::Allow);
    // pinned decision (a): None skips rule 3, so the contract must supply Some for every EVM asset
    assert_eq!(World::base().fee(None).gas(None).v(), Verdict::Allow);
}

#[test]
fn t18_paused_blocks() {
    assert_eq!(World::base().paused().v(), block(Reason::Paused));
}

#[test]
fn t19_no_task_scope_is_outside_task() {
    assert_eq!(World::base().task(None).v(), escalate(Reason::OutsideTask));
}

#[test]
fn t20_task_remaining_is_inclusive() {
    let w = World::base().task(Some(500));
    assert_eq!(w.amount(500).v(), Verdict::Allow);
    assert_eq!(w.amount(501).v(), escalate(Reason::OverTaskBound));
}

#[test]
fn t21_payee_limit_remaining_is_inclusive() {
    let w = World::base().limit(500);
    assert_eq!(w.amount(500).v(), Verdict::Allow);
    assert_eq!(w.amount(501).v(), escalate(Reason::OverPayeeLimit));
}

#[test]
fn t22_every_limit_at_u128_max_allows_u128_max() {
    let mut w = World::base()
        .amount(U)
        .fee(Some(U))
        .gas(Some(U))
        .task(Some(U));
    w.asset = Some(AssetLimits {
        hard_cap: U,
        remaining_daily: U,
        max_fee_per_gas: U,
        max_gas: U,
    });
    w.payee = Some(Payee {
        cap: Some(U),
        budget_remaining: U,
        limit_remaining: U,
    });
    assert_eq!(w.v(), Verdict::Allow);
    // and the untrusted path at the same extremes
    assert_eq!(w.amount_labels(EMAIL).v(), Verdict::Allow);
}

#[test]
fn t23_unknown_asset_before_paused() {
    assert_eq!(
        World::base().asset(None).paused().v(),
        block(Reason::UnknownAsset)
    );
    assert_eq!(World::base().paused().v(), block(Reason::Paused));
}

#[test]
fn t24_paused_before_amount() {
    assert_eq!(World::base().paused().amount(0).v(), block(Reason::Paused));
    assert_eq!(
        World::base().amount(0).v(),
        block(Reason::AmountOutOfBounds)
    );
}

#[test]
fn t25_hard_cap_before_daily() {
    let w = World::base().daily(100);
    assert_eq!(w.amount(1001).v(), block(Reason::AmountOutOfBounds));
    assert_eq!(w.amount(101).v(), block(Reason::DailyLimit));
}

#[test]
fn t26_fee_before_provenance() {
    assert_eq!(
        World::base().fee(Some(51)).recipient(0).v(),
        block(Reason::FeeTooHigh)
    );
    assert_eq!(
        World::base().recipient(0).v(),
        block(Reason::MissingProvenance)
    );
}

#[test]
fn t27_provenance_before_book_label() {
    let w = World::base().recipient(BOOK).payee(None);
    assert_eq!(w.amount_labels(0).v(), block(Reason::MissingProvenance));
    assert_eq!(w.v(), block(Reason::BookLabelNotInBook));
}

#[test]
fn t28_book_label_before_task() {
    let w = World::base().payee(None).task(None);
    assert_eq!(w.recipient(BOOK).v(), block(Reason::BookLabelNotInBook));
    assert_eq!(w.recipient(OWNER).v(), escalate(Reason::OutsideTask));
}

#[test]
fn t29_task_before_pc() {
    let w = World::base().pc(OWNER | EMAIL);
    assert_eq!(w.task(None).v(), escalate(Reason::OutsideTask));
    assert_eq!(w.task(Some(5)).v(), escalate(Reason::OverTaskBound));
    assert_eq!(w.v(), escalate(Reason::UntrustedTrigger));
}

#[test]
fn t30_pc_then_recipient_trust_then_new_recipient_then_payee_limit_then_amount_trust() {
    // pc before recipient trust
    let w = World::base().recipient(EMAIL);
    assert_eq!(w.pc(OWNER | EMAIL).v(), escalate(Reason::UntrustedTrigger));
    assert_eq!(w.v(), escalate(Reason::UntrustedRecipient));
    // recipient trust before new recipient
    let w = World::base().payee(None);
    assert_eq!(w.recipient(EMAIL).v(), escalate(Reason::UntrustedRecipient));
    assert_eq!(w.recipient(OWNER).v(), escalate(Reason::NewRecipient));
    // new recipient before payee limit: the limit lives in the payee entry, so with no entry no limit can fail and the
    // amount (above the small limit below) still ends at NewRecipient
    let small = Payee {
        cap: None,
        budget_remaining: 0,
        limit_remaining: 5,
    };
    let w = World::base().recipient(OWNER).amount(10);
    assert_eq!(w.payee(None).v(), escalate(Reason::NewRecipient));
    assert_eq!(w.payee(Some(small)).v(), escalate(Reason::OverPayeeLimit));
    // payee limit before amount trust
    let w = World::base().amount_labels(EMAIL).cap(None, 0);
    assert_eq!(w.limit(5).v(), escalate(Reason::OverPayeeLimit));
    assert_eq!(w.v(), escalate(Reason::UntrustedAmount));
}

#[test]
fn t31_label_helpers() {
    assert!(!recipient_trusted(0));
    assert!(!recipient_trusted(ORACLE));
    assert!(!recipient_trusted(1 << 15));
    assert!(!recipient_trusted(OWNER | ORACLE));
    assert!(recipient_trusted(OWNER));
    assert!(recipient_trusted(OWNER | BOOK | POLICY));
    assert!(value_trusted(ORACLE));
    assert!(value_trusted(OWNER | BOOK | POLICY | ORACLE));
    assert!(!value_trusted(UNRESOLVED));
    assert!(!value_trusted(0));
    assert!(!value_trusted(OWNER | EMAIL));
    assert!(!value_trusted(1 << 15));
    // the masks the helpers and the pc rule are built from
    assert_eq!(UNTRUSTED_MASK, 0b0111_1111_1111_0000);
    assert_eq!(TRUSTED_MASK, 0b1111);
    assert_eq!(RECIPIENT_TRUSTED, 0b0111);
    assert_eq!(UNTRUSTED_MASK & TRUSTED_MASK, 0);
    assert_eq!(UNRESOLVED & UNTRUSTED_MASK, UNRESOLVED);
}

#[test]
fn reason_names_are_unique_and_equal_variant_names() {
    let expected = [
        "UnknownAsset",
        "Paused",
        "AmountOutOfBounds",
        "DailyLimit",
        "FeeTooHigh",
        "MissingProvenance",
        "BookLabelNotInBook",
        "OutsideTask",
        "OverTaskBound",
        "UntrustedTrigger",
        "UntrustedRecipient",
        "NewRecipient",
        "OverPayeeLimit",
        "UntrustedAmount",
        "PendingFull",
        "EscalationsLocked",
        "EscalationBudget",
    ];
    assert_eq!(ALL_REASONS.len(), 17);
    for (i, r) in ALL_REASONS.iter().enumerate() {
        // the Debug name of a unit variant is the variant name
        assert_eq!(r.as_str(), format!("{:?}", r));
        assert_eq!(r.as_str(), expected[i]);
        for other in ALL_REASONS.iter().skip(i + 1) {
            assert_ne!(r.as_str(), other.as_str());
            assert_ne!(r, other);
        }
    }
}

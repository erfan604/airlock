//! AIR-025: unit pins of the ledger model (`airlock_verdict::ledger`). Each test is also the unit-level pin for what the Kani harnesses
//! (`ledger::proofs`) prove, and several were found by mutation testing (`scripts/module-mutants.sh`).
//! Fixture: caps { asset_daily 3000, payee_limit 3000, payee_budget 500, task_bound 500 } unless a test says otherwise.

use airlock_verdict::ledger::*;

const CAPS: Caps = Caps {
    asset_daily: 3000,
    payee_limit: 3000,
    payee_budget: 500,
    task_bound: 500,
};

const ZERO: Spent = Spent {
    asset_day: 0,
    payee_day: 0,
    payee_untrusted_day: 0,
    task: 0,
};

fn spent(asset_day: u128, payee_day: u128, payee_untrusted_day: u128, task: u128) -> Spent {
    Spent {
        asset_day,
        payee_day,
        payee_untrusted_day,
        task,
    }
}

fn charge(asset_day: u128, payee_day: u128, payee_untrusted_day: u128, task: u128) -> Charge {
    Charge {
        asset_day,
        payee_day,
        payee_untrusted_day,
        task,
    }
}

#[test]
fn three_requests_of_500_against_a_500_bound() {
    let ch = charge_for_allow(500, false);
    let (s1, applied) = apply_allow(&ZERO, &ch, &CAPS).expect("the first 500 fits the bound");
    assert_eq!(applied, ch);
    assert_eq!(s1.task, 500);
    assert_eq!(apply_allow(&s1, &ch, &CAPS), None);
    // a refused step leaves nothing to take the third from
    assert_eq!(apply_allow(&s1, &ch, &CAPS), None);
}

#[test]
fn allow_overflow_at_u128_max_is_none_not_a_wrap() {
    let max = u128::MAX;
    let caps = Caps {
        asset_daily: max,
        payee_limit: max,
        payee_budget: max,
        task_bound: max,
    };
    let full = spent(max, max, max, max);
    assert_eq!(apply_allow(&full, &charge_for_allow(1, true), &caps), None);
    assert_eq!(
        apply_allow(&spent(2, 0, 0, 0), &charge(max, 0, 0, 0), &caps),
        None
    );
    assert_eq!(
        apply_allow(&spent(0, 0, 0, 2), &charge(0, 0, 0, max), &caps),
        None
    );
    // an approval refuses an asset day that would wrap, and saturates the other two ledgers without wrapping
    assert_eq!(apply_approval(&full, &charge_for_approval(1), &caps), None);
    let (n, applied) = apply_approval(&spent(0, max, 0, max), &charge_for_approval(5), &caps)
        .expect("room on the asset day");
    assert_eq!((n.payee_day, n.task), (max, max));
    assert_eq!((applied.payee_day, applied.task), (0, 0));
    assert_eq!(spend(max, 1, max), None);
    assert_eq!(spend(max - 1, 1, max), Some(max));
    assert_eq!(spend(max, 0, max), Some(max));
    assert_eq!(spend(2, max, max), None);
}

#[test]
fn allow_at_the_cap_passes_and_one_over_is_none() {
    // task bound 500
    assert!(apply_allow(&ZERO, &charge_for_allow(500, false), &CAPS).is_some());
    assert_eq!(
        apply_allow(&ZERO, &charge_for_allow(501, false), &CAPS),
        None
    );
    // asset daily 3000 and payee limit 3000, with the other caps out of the way
    let wide = Caps {
        task_bound: 10_000,
        ..CAPS
    };
    assert!(apply_allow(&ZERO, &charge(3000, 0, 0, 0), &wide).is_some());
    assert_eq!(apply_allow(&ZERO, &charge(3001, 0, 0, 0), &wide), None);
    assert!(apply_allow(&ZERO, &charge(0, 3000, 0, 0), &wide).is_some());
    assert_eq!(apply_allow(&ZERO, &charge(0, 3001, 0, 0), &wide), None);
    // untrusted budget 500
    assert!(apply_allow(&ZERO, &charge(0, 0, 500, 0), &wide).is_some());
    assert_eq!(apply_allow(&ZERO, &charge(0, 0, 501, 0), &wide), None);
    // spent plus charge exactly at the cap
    assert!(apply_allow(&spent(2000, 0, 0, 0), &charge(1000, 0, 0, 0), &wide).is_some());
    assert_eq!(
        apply_allow(&spent(2000, 0, 0, 0), &charge(1001, 0, 0, 0), &wide),
        None
    );
}

#[test]
fn untrusted_budget_is_charged_only_for_untrusted_amounts() {
    let (n, applied) = apply_allow(&ZERO, &charge_for_allow(100, false), &CAPS).unwrap();
    assert_eq!(n, spent(100, 100, 0, 100));
    assert_eq!(applied.payee_untrusted_day, 0);
    let (n, applied) = apply_allow(&ZERO, &charge_for_allow(100, true), &CAPS).unwrap();
    assert_eq!(n, spent(100, 100, 100, 100));
    assert_eq!(applied.payee_untrusted_day, 100);
}

#[test]
fn untrusted_amount_over_the_budget_is_none() {
    let s = spent(0, 0, 450, 0);
    let wide = Caps {
        task_bound: 10_000,
        ..CAPS
    };
    assert!(apply_allow(&s, &charge_for_allow(50, true), &wide).is_some());
    assert_eq!(apply_allow(&s, &charge_for_allow(51, true), &wide), None);
    // a trusted amount does not touch the budget, so it passes with the budget used up
    let used_up = spent(0, 0, 500, 0);
    let (n, _) = apply_allow(&used_up, &charge_for_allow(51, false), &wide).unwrap();
    assert_eq!(n.payee_untrusted_day, 500);
}

#[test]
fn approval_saturates_task_and_payee_and_reports_the_applied_charge() {
    let caps = Caps {
        payee_limit: 400,
        ..CAPS
    };
    let s = spent(0, 100, 0, 300);
    let (n, applied) =
        apply_approval(&s, &charge_for_approval(900), &caps).expect("the asset day has room");
    assert_eq!(n, spent(900, 400, 0, 500));
    assert_eq!(applied, charge(900, 300, 0, 200));
}

#[test]
fn approval_within_room_charges_the_exact_amount_on_every_ledger() {
    let ch = charge_for_approval(10);
    let (n, applied) = apply_approval(&ZERO, &ch, &CAPS).unwrap();
    assert_eq!(n, spent(10, 10, 0, 10));
    assert_eq!(applied, ch);
}

#[test]
fn approval_never_touches_the_untrusted_budget_even_at_zero_cap() {
    let zero_budget = Caps {
        payee_budget: 0,
        ..CAPS
    };
    let (n, applied) = apply_approval(&ZERO, &charge_for_approval(50), &zero_budget).unwrap();
    assert_eq!(n.payee_untrusted_day, 0);
    assert_eq!(applied.payee_untrusted_day, 0);
    // a requested untrusted charge is ignored, and a budget that is already used up stays as it is
    let s = spent(0, 0, 7, 0);
    let (n, applied) = apply_approval(&s, &charge(50, 50, 99, 50), &zero_budget).unwrap();
    assert_eq!(n.payee_untrusted_day, 7);
    assert_eq!(applied.payee_untrusted_day, 0);
}

#[test]
fn two_approvals_of_900_against_a_daily_cap_of_1000() {
    let caps = Caps {
        asset_daily: 1000,
        ..CAPS
    };
    let ch = charge_for_approval(900);
    let (s1, _) = apply_approval(&ZERO, &ch, &caps).expect("the first approval fits the day");
    assert_eq!(s1.asset_day, 900);
    assert_eq!(apply_approval(&s1, &ch, &caps), None);
}

#[test]
fn approval_when_a_cap_was_lowered_below_spent_is_a_no_op_on_that_ledger() {
    // the owner lowered the payee limit to 400 and the task bound to 300 after 600 and 450 were spent
    let caps = Caps {
        payee_limit: 400,
        task_bound: 300,
        ..CAPS
    };
    let s = spent(0, 600, 0, 450);
    assert_eq!(apply_allow(&s, &charge_for_allow(10, false), &caps), None);
    let (n, applied) = apply_approval(&s, &charge_for_approval(10), &caps).unwrap();
    assert_eq!((n.payee_day, applied.payee_day), (600, 0));
    assert_eq!((n.task, applied.task), (450, 0));
    assert_eq!((n.asset_day, applied.asset_day), (10, 10));
}

#[test]
fn refund_is_the_exact_inverse_of_the_applied_charge() {
    // an Allow of an untrusted amount
    let s0 = spent(40, 30, 20, 10);
    let (s1, applied) = apply_allow(&s0, &charge_for_allow(100, true), &CAPS).unwrap();
    assert_eq!(refund(&s1, &applied), Some(s0));
    // an approval that saturated: the applied charge is smaller than the requested one
    let caps = Caps {
        payee_limit: 400,
        ..CAPS
    };
    let s0 = spent(0, 100, 0, 300);
    let (s1, applied) = apply_approval(&s0, &charge_for_approval(900), &caps).unwrap();
    assert_eq!(refund(&s1, &applied), Some(s0));
    // a charge of zero refunds to the same state
    assert_eq!(refund(&s0, &charge(0, 0, 0, 0)), Some(s0));
}

#[test]
fn refund_of_more_than_was_spent_is_none() {
    let s = spent(5, 6, 7, 8);
    assert_eq!(refund(&s, &charge(6, 0, 0, 0)), None);
    assert_eq!(refund(&s, &charge(0, 7, 0, 0)), None);
    assert_eq!(refund(&s, &charge(0, 0, 8, 0)), None);
    assert_eq!(refund(&s, &charge(0, 0, 0, 9)), None);
    assert_eq!(refund(&s, &charge(5, 6, 7, 8)), Some(ZERO));
}

#[test]
fn refund_of_the_first_charge_after_a_second_leaves_the_second() {
    let s0 = spent(10, 20, 5, 30);
    let (s1, a) = apply_allow(&s0, &charge_for_allow(100, true), &CAPS).unwrap();
    let (s2, b) = apply_allow(&s1, &charge_for_allow(60, false), &CAPS).unwrap();
    let left = refund(&s2, &a).expect("the first charge is inside the sum");
    assert_eq!(
        left,
        spent(
            s0.asset_day + b.asset_day,
            s0.payee_day + b.payee_day,
            s0.payee_untrusted_day + b.payee_untrusted_day,
            s0.task + b.task
        )
    );
    // the same with an approval first, whose applied charge is smaller than requested
    let caps = Caps {
        payee_limit: 400,
        ..CAPS
    };
    let s0 = spent(0, 100, 0, 300);
    let (s1, a) = apply_approval(&s0, &charge_for_approval(900), &caps).unwrap();
    let (s2, b) = apply_allow(&s1, &charge(1, 0, 0, 0), &caps).unwrap();
    let left = refund(&s2, &a).unwrap();
    assert_eq!(
        left,
        spent(
            s0.asset_day + b.asset_day,
            s0.payee_day + b.payee_day,
            0,
            s0.task + b.task
        )
    );
}

#[test]
fn remaining_is_cap_minus_spent_and_saturates_at_zero() {
    let s = spent(100, 3000, 600, 200);
    let r = remaining(&s, &CAPS);
    assert_eq!(r, spent(2900, 0, 0, 300));
    assert_eq!(remaining(&ZERO, &CAPS), spent(3000, 3000, 500, 500));
}

#[test]
fn charge_helpers() {
    assert_eq!(charge_for_allow(7, true), charge(7, 7, 7, 7));
    assert_eq!(charge_for_allow(7, false), charge(7, 7, 0, 7));
    assert_eq!(charge_for_approval(7), charge(7, 7, 0, 7));
    assert_eq!(charge_for_allow(0, true), charge(0, 0, 0, 0));
    let max = u128::MAX;
    assert_eq!(charge_for_allow(max, true), charge(max, max, max, max));
    assert_eq!(charge_for_approval(max), charge(max, max, 0, max));
}

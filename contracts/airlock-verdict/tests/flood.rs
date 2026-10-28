//! AIR-082: the escalation flood control (`airlock_verdict::flood`): a pending cap, a lockout after 3 consecutive rejects or 20 in a UTC day, and an
//! hourly budget. Limits `max_pending 3, lock_consecutive 3, lock_per_day 20, hourly_budget 6` unless a test says otherwise.

use airlock_verdict::flood::*;
use airlock_verdict::Reason;

fn limits() -> FloodLimits {
    FloodLimits {
        max_pending: 3,
        lock_consecutive: 3,
        lock_per_day: 20,
        hourly_budget: 6,
    }
}

fn fresh() -> FloodState {
    FloodState::default()
}

fn admit(s: &FloodState, l: &FloodLimits, hour: u64) -> FloodState {
    gate_escalation(s, l, hour).expect("the gate admits")
}

#[test]
fn gate_admits_first_escalation() {
    let s = gate_escalation(&fresh(), &limits(), 5).unwrap();
    assert_eq!(
        s,
        FloodState {
            pending: 1,
            hour: 5,
            hour_count: 1,
            ..fresh()
        }
    );
}

#[test]
fn gate_locked_wins_over_pending_full_and_budget() {
    let s = FloodState {
        locked: true,
        pending: 3,
        hour: 0,
        hour_count: 6,
        ..fresh()
    };
    assert_eq!(
        gate_escalation(&s, &limits(), 0),
        Err(Reason::EscalationsLocked)
    );
}

#[test]
fn gate_pending_full_wins_over_budget() {
    let s = FloodState {
        pending: 3,
        hour: 0,
        hour_count: 6,
        ..fresh()
    };
    assert_eq!(gate_escalation(&s, &limits(), 0), Err(Reason::PendingFull));
}

#[test]
fn gate_fourth_pending_is_refused() {
    let l = limits();
    let mut s = fresh();
    for i in 1..=3 {
        s = admit(&s, &l, 0);
        assert_eq!(s.pending, i);
    }
    assert_eq!(gate_escalation(&s, &l, 0), Err(Reason::PendingFull));
}

#[test]
fn gate_seventh_in_one_hour_is_budget() {
    let l = limits();
    let mut s = fresh();
    for i in 1..=6 {
        s = admit(&s, &l, 0);
        assert_eq!(s.hour_count, i);
        s = on_approve(&s);
    }
    assert_eq!(s.pending, 0);
    assert_eq!(gate_escalation(&s, &l, 0), Err(Reason::EscalationBudget));
}

#[test]
fn gate_hour_rollover_resets_budget() {
    let s = FloodState {
        hour: 7,
        hour_count: 6,
        ..fresh()
    };
    assert_eq!(
        gate_escalation(&s, &limits(), 7),
        Err(Reason::EscalationBudget)
    );
    let n = gate_escalation(&s, &limits(), 8).unwrap();
    assert_eq!((n.hour, n.hour_count, n.pending), (8, 1, 1));
}

#[test]
fn gate_refusal_leaves_state_to_the_caller() {
    let s = FloodState {
        pending: 3,
        consecutive_rejects: 2,
        hour: 4,
        hour_count: 2,
        ..fresh()
    };
    let before = s;
    assert!(gate_escalation(&s, &limits(), 4).is_err());
    assert_eq!(s, before);
}

#[test]
fn gate_budget_of_one_admits_one_per_hour() {
    let l = FloodLimits {
        hourly_budget: 1,
        max_pending: 10,
        ..limits()
    };
    let s = admit(&fresh(), &l, 3);
    assert_eq!(gate_escalation(&s, &l, 3), Err(Reason::EscalationBudget));
    let s = admit(&s, &l, 4);
    assert_eq!((s.hour, s.hour_count, s.pending), (4, 1, 2));
    assert_eq!(gate_escalation(&s, &l, 4), Err(Reason::EscalationBudget));
}

#[test]
fn reject_three_in_a_row_locks() {
    let l = limits();
    let mut s = FloodState {
        pending: 3,
        ..fresh()
    };
    s = on_reject(&s, &l, 2);
    s = on_reject(&s, &l, 2);
    assert!(!s.locked);
    assert_eq!(s.consecutive_rejects, 2);
    s = on_reject(&s, &l, 2);
    assert!(s.locked);
    assert_eq!(s.pending, 0);
}

#[test]
fn approve_between_rejects_resets_the_streak() {
    let l = limits();
    let mut s = FloodState {
        pending: 5,
        ..fresh()
    };
    s = on_reject(&s, &l, 2);
    s = on_reject(&s, &l, 2);
    s = on_approve(&s);
    assert_eq!(s.consecutive_rejects, 0);
    s = on_reject(&s, &l, 2);
    assert_eq!(s.consecutive_rejects, 1);
    assert_eq!(s.rejects_today, 3);
    assert!(!s.locked);
}

#[test]
fn twentieth_reject_in_a_day_locks_without_a_streak() {
    let l = limits();
    let mut s = FloodState {
        pending: 100,
        ..fresh()
    };
    for i in 1..=20u32 {
        s = on_reject(&s, &l, 9);
        assert_eq!(s.rejects_today, i);
        assert_eq!(s.locked, i == 20, "reject {i}");
        if i < 20 {
            s = on_approve(&s);
        }
    }
    assert_eq!(s.consecutive_rejects, 1);
    assert!(s.locked);
}

#[test]
fn reject_day_rollover_resets_the_daily_counter() {
    let l = FloodLimits {
        lock_consecutive: 100,
        ..limits()
    };
    let mut s = FloodState {
        pending: 100,
        ..fresh()
    };
    for _ in 0..19 {
        s = on_reject(&s, &l, 2);
    }
    assert_eq!(s.rejects_today, 19);
    assert!(!s.locked);
    s = on_reject(&s, &l, 3);
    assert_eq!(s.rejects_today, 1);
    assert_eq!(s.rejects_day, 3);
    assert!(!s.locked);
}

#[test]
fn expire_frees_a_slot_and_keeps_the_streak() {
    let s = FloodState {
        pending: 2,
        consecutive_rejects: 2,
        rejects_today: 2,
        ..fresh()
    };
    let n = on_expire(&s);
    assert_eq!(n.pending, 1);
    assert_eq!(n.consecutive_rejects, 2);
    assert_eq!(n.rejects_today, 2);
}

#[test]
fn approve_and_expire_floor_pending_at_zero() {
    let s = fresh();
    assert_eq!(on_approve(&s).pending, 0);
    assert_eq!(on_expire(&s).pending, 0);
    let r = on_reject(&s, &limits(), 1);
    assert_eq!(r.pending, 0);
    assert_eq!(r.consecutive_rejects, 1);
}

#[test]
fn reset_unlocks_and_keeps_pending_and_hour() {
    let s = FloodState {
        pending: 2,
        consecutive_rejects: 5,
        rejects_day: 3,
        rejects_today: 9,
        locked: true,
        hour: 4,
        hour_count: 5,
    };
    assert_eq!(
        reset(&s),
        FloodState {
            pending: 2,
            consecutive_rejects: 0,
            rejects_day: 3,
            rejects_today: 0,
            locked: false,
            hour: 4,
            hour_count: 5,
        }
    );
}

#[test]
fn counters_saturate_instead_of_wrapping() {
    let l = FloodLimits {
        max_pending: u32::MAX,
        hourly_budget: u32::MAX,
        ..limits()
    };
    let s = FloodState {
        pending: u32::MAX - 1,
        hour: 1,
        hour_count: u32::MAX - 1,
        ..fresh()
    };
    let s = admit(&s, &l, 1);
    assert_eq!((s.pending, s.hour_count), (u32::MAX, u32::MAX));
    assert_eq!(gate_escalation(&s, &l, 1), Err(Reason::PendingFull));
    // rejects at the top of the counters: no wrap, no panic, locked
    let top = FloodState {
        consecutive_rejects: u32::MAX,
        rejects_day: 5,
        rejects_today: u32::MAX,
        ..fresh()
    };
    let r = on_reject(&top, &limits(), 5);
    assert_eq!(
        (r.consecutive_rejects, r.rejects_today),
        (u32::MAX, u32::MAX)
    );
    assert!(r.locked);
}

#[test]
fn locked_stays_locked_through_more_rejects_until_reset() {
    let l = limits();
    let mut s = FloodState {
        pending: 3,
        ..fresh()
    };
    for _ in 0..3 {
        s = on_reject(&s, &l, 1);
    }
    assert!(s.locked);
    // a reject while locked still counts, an approve does not unlock, only reset does
    s = on_reject(&s, &l, 2);
    assert!(s.locked);
    assert_eq!(s.consecutive_rejects, 4);
    s = on_approve(&s);
    assert!(s.locked);
    s = on_expire(&s);
    assert!(s.locked);
    // a lock does not expire at midnight
    s = on_reject(&s, &l, 3);
    assert!(s.locked);
    assert_eq!(gate_escalation(&s, &l, 0), Err(Reason::EscalationsLocked));
    let s = reset(&s);
    assert!(!s.locked);
    assert!(gate_escalation(&s, &l, 0).is_ok());
}

#[test]
fn flood_refusals_use_the_enum_names() {
    assert_eq!(Reason::EscalationsLocked.as_str(), "EscalationsLocked");
    assert_eq!(Reason::PendingFull.as_str(), "PendingFull");
    assert_eq!(Reason::EscalationBudget.as_str(), "EscalationBudget");
}

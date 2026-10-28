//! Escalation flood control (F02 3.3, SPEC R4-03). Pure, no_std, no alloc.
//!
//! One `FloodState` per agent account. The model takes the UTC hour and day bucket numbers, not milliseconds (a 64-bit division by 3,600,000 does
//! not finish under Kani); the contract passes `utc_hour(now_ms)` and `utc_day(now_ms)`. `gate_escalation` returns the new state and the caller
//! stores it only on `Ok`, so a refusal changes nothing. Counters saturate and nothing panics. `locked` is sticky: only `reset` clears it, so a
//! lock does not expire at midnight.
use crate::Reason;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FloodState {
    pub pending: u32,
    pub consecutive_rejects: u32,
    pub rejects_day: u64,
    pub rejects_today: u32,
    pub locked: bool,
    pub hour: u64,
    pub hour_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FloodLimits {
    pub max_pending: u32,
    pub lock_consecutive: u32,
    pub lock_per_day: u32,
    pub hourly_budget: u32,
}

/// Admission of one new escalation. Refusals in this order: locked, pending cap, hourly budget.
pub fn gate_escalation(s: &FloodState, l: &FloodLimits, hour: u64) -> Result<FloodState, Reason> {
    if s.locked {
        return Err(Reason::EscalationsLocked);
    }
    if s.pending >= l.max_pending {
        return Err(Reason::PendingFull);
    }
    let used = if hour == s.hour { s.hour_count } else { 0 };
    if used >= l.hourly_budget {
        return Err(Reason::EscalationBudget);
    }
    Ok(FloodState {
        pending: s.pending.saturating_add(1),
        hour,
        hour_count: used.saturating_add(1),
        ..*s
    })
}

/// The owner rejected a pending escalation: it counts toward the streak and the day, and may lock the agent.
pub fn on_reject(s: &FloodState, l: &FloodLimits, day: u64) -> FloodState {
    let today = if day == s.rejects_day {
        s.rejects_today
    } else {
        0
    };
    let consecutive = s.consecutive_rejects.saturating_add(1);
    let rejects_today = today.saturating_add(1);
    FloodState {
        pending: s.pending.saturating_sub(1),
        consecutive_rejects: consecutive,
        rejects_day: day,
        rejects_today,
        locked: s.locked || consecutive >= l.lock_consecutive || rejects_today >= l.lock_per_day,
        ..*s
    }
}

/// The owner approved a pending escalation: the only event that clears the consecutive streak.
pub fn on_approve(s: &FloodState) -> FloodState {
    FloodState {
        pending: s.pending.saturating_sub(1),
        consecutive_rejects: 0,
        ..*s
    }
}

/// A pending escalation expired: frees its slot and keeps the streak.
pub fn on_expire(s: &FloodState) -> FloodState {
    FloodState {
        pending: s.pending.saturating_sub(1),
        ..*s
    }
}

/// The owner's `reset_escalations`: clears the lock and the streak and the day count; keeps `pending`, `hour`, `hour_count` and `rejects_day`, so a
/// reset can never be used to get around the hourly budget.
pub fn reset(s: &FloodState) -> FloodState {
    FloodState {
        consecutive_rejects: 0,
        rejects_today: 0,
        locked: false,
        ..*s
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// every limit at least 1: the `set_flags` lower bound of AIR-040
    fn any_limits() -> FloodLimits {
        let l = FloodLimits {
            max_pending: kani::any(),
            lock_consecutive: kani::any(),
            lock_per_day: kani::any(),
            hourly_budget: kani::any(),
        };
        kani::assume(
            l.max_pending >= 1
                && l.lock_consecutive >= 1
                && l.lock_per_day >= 1
                && l.hourly_budget >= 1,
        );
        l
    }

    fn any_state() -> FloodState {
        FloodState {
            pending: kani::any(),
            consecutive_rejects: kani::any(),
            rejects_day: kani::any(),
            rejects_today: kani::any(),
            locked: kani::any(),
            hour: kani::any(),
            hour_count: kani::any(),
        }
    }

    /// One event chosen by `kind % 5`. `shadow` is the harness's own count of Pending items, the independent oracle for the counter:
    /// 0 escalate (on `Ok` the shadow count goes up and the new state is taken, on `Err` the state stays), 1 reject, 2 approve and 3 expire
    /// (each only when an item is pending, which takes one from the shadow count), 4 reset.
    fn step(s: &FloodState, l: &FloodLimits, shadow: &mut u32, kind: u8, now: u64) -> FloodState {
        match kind % 5 {
            0 => match gate_escalation(s, l, now) {
                Ok(n) => {
                    *shadow += 1;
                    n
                }
                Err(_) => *s,
            },
            1 => {
                if *shadow > 0 {
                    *shadow -= 1;
                    on_reject(s, l, now)
                } else {
                    *s
                }
            }
            2 => {
                if *shadow > 0 {
                    *shadow -= 1;
                    on_approve(s)
                } else {
                    *s
                }
            }
            3 => {
                if *shadow > 0 {
                    *shadow -= 1;
                    on_expire(s)
                } else {
                    *s
                }
            }
            4 => reset(s),
            _ => *s,
        }
    }

    /// R4-03: no escalation is stored while the agent is locked, over any legal sequence of 6 events from the default state; and a locked state
    /// refuses with `EscalationsLocked` whatever the limits and the bucket.
    #[kani::proof]
    #[kani::unwind(8)]
    fn flood_locked_never_stores() {
        let l = any_limits();
        let mut s = FloodState::default();
        let mut shadow = 0u32;
        let mut now: u64 = kani::any();
        let mut refused_while_locked = false;
        let mut i = 0;
        while i < 6 {
            let kind: u8 = kani::any();
            let before = shadow;
            let was_locked = s.locked;
            s = step(&s, &l, &mut shadow, kind, now);
            if kind % 5 == 0 && was_locked {
                assert!(shadow == before, "an escalation was stored while locked");
                refused_while_locked = true;
            }
            let dt: u8 = kani::any();
            now = now.saturating_add(u64::from(dt));
            i += 1;
        }
        kani::cover!(
            refused_while_locked,
            "an escalation was refused while locked"
        );
        let locked = FloodState {
            locked: true,
            ..any_state()
        };
        let l2 = any_limits();
        let hour: u64 = kani::any();
        assert!(gate_escalation(&locked, &l2, hour) == Err(Reason::EscalationsLocked));
    }

    /// R4-03: the pending counter equals the number of pending items and never exceeds `max_pending`, over any legal sequence of 6 events.
    /// Limits are constant inside one run; a later lowering of the cap is covered by the step property of `flood_hourly_budget_holds`.
    #[kani::proof]
    #[kani::unwind(8)]
    fn flood_pending_never_exceeds_max() {
        let l = any_limits();
        let mut s = FloodState::default();
        let mut shadow = 0u32;
        let mut now: u64 = kani::any();
        let mut cap_reached = false;
        let mut i = 0;
        while i < 6 {
            let kind: u8 = kani::any();
            s = step(&s, &l, &mut shadow, kind, now);
            assert!(
                s.pending == shadow,
                "the counter equals the number of pending items"
            );
            assert!(s.pending <= l.max_pending, "pending cap exceeded");
            if s.pending == l.max_pending {
                cap_reached = true;
            }
            let dt: u8 = kani::any();
            now = now.saturating_add(u64::from(dt));
            i += 1;
        }
        kani::cover!(cap_reached, "the pending cap was reached");
    }

    /// R4-03: three consecutive rejects lock the agent, whatever the days they fall on.
    #[kani::proof]
    #[kani::unwind(8)]
    fn flood_three_consecutive_rejects_lock() {
        let mut l = any_limits();
        l.lock_consecutive = 3;
        let mut s = FloodState {
            pending: 3,
            ..FloodState::default()
        };
        let mut i = 0;
        while i < 3 {
            let day: u64 = kani::any();
            s = on_reject(&s, &l, day);
            i += 1;
        }
        assert!(s.locked, "three consecutive rejects did not lock");
        assert!(s.pending == 0);
        kani::cover!(l.lock_per_day > 3, "locked by the streak rule alone");
    }

    /// R4-03: an escalation is admitted exactly when the agent is not locked, below the pending cap and below the hourly budget of the current
    /// hour bucket, from any state.
    #[kani::proof]
    fn flood_hourly_budget_holds() {
        let s = any_state();
        let l = any_limits();
        let hour: u64 = kani::any();
        let used = if hour == s.hour { s.hour_count } else { 0 };
        match gate_escalation(&s, &l, hour) {
            Ok(n) => {
                assert!(
                    !s.locked && s.pending < l.max_pending && used < l.hourly_budget,
                    "admitted despite a refusal condition"
                );
                assert!(n.hour_count <= l.hourly_budget, "hourly budget exceeded");
                assert!(n.hour == hour);
                kani::cover!(hour != s.hour, "an admission in a new hour");
                kani::cover!(hour == s.hour, "an admission in the same hour");
            }
            Err(e) => {
                assert!(
                    s.locked || s.pending >= l.max_pending || used >= l.hourly_budget,
                    "refused without a reason"
                );
                kani::cover!(e == Reason::EscalationBudget, "a refusal for the budget");
            }
        }
    }
}

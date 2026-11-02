// AIR-083: escalation flood control in the contract (F02 3.3, SPEC R4-03). The pure, Kani-checked model is
// `airlock_verdict::flood` (AIR-082); this file stores its state per agent account and calls it:
//  - `flood_admit` is the gate in front of `store_pending` (a fourth pending escalation, a locked agent or a spent hourly budget turns
//    the escalation into a stored Block with the reason `PendingFull`, `EscalationsLocked` or `EscalationBudget`);
//  - `flood_after_approve`, `flood_after_expire`, `flood_after_reject` and `flood_reset` are called by `approve` (here), `reject`,
//    `expire` and `reset_escalations` (AIR-081).
// The agent of every call is the record's agent (`rec.agent`), never the caller: the owner calls approve and reject. Limits are read
// from `Flags` on every call, so `set_flags` takes effect on the next request. Every helper lives in a plain `impl Contract`, so none
// is an exported method; the only export is the view `get_escalation_state`.
use crate::time::{utc_day, utc_hour};
use crate::*;
use airlock_verdict::Reason;
use airlock_verdict::flood::{
    FloodLimits, FloodState, gate_escalation, on_approve, on_expire, on_reject, reset,
};

/// The stored mirror of the verdict crate's `FloodState` (that crate has no Borsh, so the state itself cannot be stored; the same
/// rule as `ChargeRec`, AIR-062).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct FloodRec {
    pub pending: u32,
    pub consecutive_rejects: u32,
    pub rejects_day: u64,
    pub rejects_today: u32,
    pub locked: bool,
    pub hour: u64,
    pub hour_count: u32,
}

impl From<FloodState> for FloodRec {
    fn from(s: FloodState) -> Self {
        Self {
            pending: s.pending,
            consecutive_rejects: s.consecutive_rejects,
            rejects_day: s.rejects_day,
            rejects_today: s.rejects_today,
            locked: s.locked,
            hour: s.hour,
            hour_count: s.hour_count,
        }
    }
}

impl From<FloodRec> for FloodState {
    fn from(r: FloodRec) -> Self {
        Self {
            pending: r.pending,
            consecutive_rejects: r.consecutive_rejects,
            rejects_day: r.rejects_day,
            rejects_today: r.rejects_today,
            locked: r.locked,
            hour: r.hour,
            hour_count: r.hour_count,
        }
    }
}

/// The four limits as `get_escalation_state` shows them (the `Flags` read now).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FloodLimitsView {
    pub max_pending: u32,
    pub lock_consecutive: u32,
    pub lock_per_day: u32,
    pub hourly_budget: u32,
}

/// What `get_escalation_state` answers: the counters of one agent in the current hour and day buckets, and the limits. Every value is
/// a plain JSON number except `locked`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FloodView {
    pub pending: u32,
    pub consecutive_rejects: u32,
    pub rejects_today: u32,
    pub locked: bool,
    pub hour_count: u32,
    pub limits: FloodLimitsView,
}

impl Contract {
    /// The limits of the model, read from `Flags` now.
    pub fn flood_limits(&self) -> FloodLimits {
        FloodLimits {
            max_pending: self.flags.max_pending_per_agent,
            lock_consecutive: self.flags.lock_consecutive_rejects,
            lock_per_day: self.flags.lock_rejects_per_day,
            hourly_budget: self.flags.hourly_escalation_budget,
        }
    }

    /// The stored state of an agent as the model's type (an agent with no entry has the default).
    fn flood_state(&self, agent: &AccountId) -> FloodState {
        self.flood
            .get(agent)
            .cloned()
            .map(FloodState::from)
            .unwrap_or_default()
    }

    /// What `flood_admit` would answer at `now_ms`, read only: `Ok` with the state it would store, or the reason of the refusal.
    pub fn flood_check(&self, agent: &AccountId, now_ms: u64) -> Result<FloodState, Reason> {
        gate_escalation(
            &self.flood_state(agent),
            &self.flood_limits(),
            utc_hour(now_ms),
        )
    }

    /// Admission of one new escalation of `agent` at `now_ms`: `Ok` stores the counted state, `Err` stores nothing.
    pub fn flood_admit(&mut self, agent: &AccountId, now_ms: u64) -> Result<(), Reason> {
        let admitted = self.flood_check(agent, now_ms)?;
        self.flood.insert(agent.clone(), admitted.into());
        Ok(())
    }

    /// The owner approved a pending escalation of `agent`: frees its slot and clears the consecutive streak.
    pub fn flood_after_approve(&mut self, agent: &AccountId) {
        let next = on_approve(&self.flood_state(agent));
        self.flood.insert(agent.clone(), next.into());
    }

    /// A pending escalation of `agent` expired: frees its slot and keeps the streak.
    pub fn flood_after_expire(&mut self, agent: &AccountId) {
        let next = on_expire(&self.flood_state(agent));
        self.flood.insert(agent.clone(), next.into());
    }

    /// The owner rejected a pending escalation of `agent` at `now_ms`: it counts toward the streak and the UTC day. When this reject
    /// locks an agent that was not locked, `escalations_locked` is emitted with the counters after the reject.
    pub fn flood_after_reject(&mut self, agent: &AccountId, now_ms: u64) {
        let before = self.flood_state(agent);
        let after = on_reject(&before, &self.flood_limits(), utc_day(now_ms));
        if after.locked && !before.locked {
            Event::EscalationsLocked {
                agent,
                consecutive: after.consecutive_rejects,
                today: after.rejects_today,
            }
            .emit();
        }
        self.flood.insert(agent.clone(), after.into());
    }

    /// The owner's `reset_escalations` for `agent`: clears the lock, the streak and the day count and keeps the pending count and the
    /// hour, so a reset cannot get around the hourly budget. An agent with no entry gets none.
    pub fn flood_reset(&mut self, agent: &AccountId) {
        if self.flood.contains_key(agent) {
            let next = reset(&self.flood_state(agent));
            self.flood.insert(agent.clone(), next.into());
        }
    }
}

#[near]
impl Contract {
    /// The flood counters of `agent` in the current UTC hour and day (`hour_count` is 0 when the stored hour is not the current one,
    /// `rejects_today` is 0 when the stored day is not today), and the limits read from the flags now. An unknown agent answers zeros.
    pub fn get_escalation_state(&self, agent: AccountId) -> FloodView {
        let now_ms = block_timestamp_ms();
        let s = self.flood_state(&agent);
        let l = self.flood_limits();
        FloodView {
            pending: s.pending,
            consecutive_rejects: s.consecutive_rejects,
            rejects_today: if s.rejects_day == utc_day(now_ms) {
                s.rejects_today
            } else {
                0
            },
            locked: s.locked,
            hour_count: if s.hour == utc_hour(now_ms) {
                s.hour_count
            } else {
                0
            },
            limits: FloodLimitsView {
                max_pending: l.max_pending,
                lock_consecutive: l.lock_consecutive,
                lock_per_day: l.lock_per_day,
                hourly_budget: l.hourly_budget,
            },
        }
    }
}

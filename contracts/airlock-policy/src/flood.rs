// AIR-083: escalation flood control in the contract (F02 3.3, SPEC R4-03). The pure, Kani-checked model is
// `airlock_verdict::flood` (AIR-082); this file stores its state per agent account and calls it:
//  - `flood_admit` is the gate in front of `store_pending` (a fourth pending escalation, a locked agent or a spent hourly budget turns
//    the escalation into a stored Block with the reason `PendingFull`, `EscalationsLocked` or `EscalationBudget`);
//  - `flood_after_approve`, `flood_after_expire`, `flood_after_reject` and `flood_reset` are called by `approve` (here), `reject`,
//    `expire` and `reset_escalations` (AIR-081).
// The agent of every call is the record's agent (`rec.agent`), never the caller: the owner calls approve and reject. Limits are read
// from `Flags` on every call, so `set_flags` takes effect on the next request. Every helper lives in a plain `impl Contract`, so none
// is an exported method; the only export is the view `get_escalation_state`.
//
// AIR-315: counters per (agent, origin). A request names its origin in `hints.origin` (`FloodKey`): `owner` for a request whose three
// labels are all trusted, or `<kind>:<16 hex>`, the runtime's hash of the untrusted source (a mail sender, a page host). A request that
// names none keeps the per-agent counters above (`FloodKey::Agent`, AIR-083 unchanged). The owner origin has the `Flags` limits; every
// other origin has at most 2 pending and 4 escalations an hour (`origin_limits`), and all of them together share a backstop of at least
// 8 pending and 20 an hour with no consecutive-reject lock (`backstop_limits`), which the owner origin never touches. So an attacker's
// origin locks, fills and spends only itself, and the owner's own escalations are never behind the attacker's. The origin is the
// runtime's word: a lying runtime can name any origin, which is the compromised-runtime case of docs/THREAT_MODEL.md, bounded by the
// verdict and the ledgers, not by flood control. The same pure, Kani-checked functions run on every set of counters.
use crate::request::SubmitRequest;
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

/// The origin of every request whose labels are all trusted.
pub const OWNER_ORIGIN: &str = "owner";
/// At most this many pending escalations per origin other than the owner.
pub const ORIGIN_MAX_PENDING: u32 = 2;
/// At most this many escalations per origin other than the owner in one UTC hour.
pub const ORIGIN_HOURLY: u32 = 4;
/// The backstop shared by every origin other than the owner: at least this many pending, and at least this many an hour.
pub const BACKSTOP_MIN_PENDING: u32 = 8;
pub const BACKSTOP_MIN_HOURLY: u32 = 20;

/// Which counters a request is admitted against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FloodKey {
    /// No origin named: the per-agent counters of AIR-083.
    Agent,
    /// `owner`: every label trusted.
    Owner,
    /// `<kind>:<16 hex>`: an untrusted source, counted on its own and in the backstop.
    Named(String),
}

impl FloodKey {
    /// The origin text stored for a pending request (`None` for `Agent`).
    pub fn origin(&self) -> Option<&str> {
        match self {
            FloodKey::Agent => None,
            FloodKey::Owner => Some(OWNER_ORIGIN),
            FloodKey::Named(o) => Some(o),
        }
    }
}

/// `<kind>:<16 hex>`: a kind of 1 to 8 lowercase ASCII letters, a colon, 16 lowercase hex digits.
pub fn valid_named_origin(s: &str) -> bool {
    let b = s.as_bytes();
    let Some(colon) = b.iter().position(|&c| c == b':') else {
        return false;
    };
    let (kind, hex) = (&b[..colon], &b[colon + 1..]);
    (1..=8).contains(&kind.len())
        && kind.iter().all(u8::is_ascii_lowercase)
        && hex.len() == 16
        && hex
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

/// The key of a stored origin text or a `reset_escalations` argument; `None` when it is neither `owner` nor a named origin.
pub fn key_of_origin(s: &str) -> Option<FloodKey> {
    if s == OWNER_ORIGIN {
        Some(FloodKey::Owner)
    } else if valid_named_origin(s) {
        Some(FloodKey::Named(s.to_string()))
    } else {
        None
    }
}

/// The flood key of a request, checked with its shape: reverts `bad origin` for a malformed origin and `origin owner needs trusted
/// labels` when a request with any untrusted label names the owner's origin.
pub fn flood_key(req: &SubmitRequest) -> FloodKey {
    let Some(text) = req.hints.origin.as_deref() else {
        return FloodKey::Agent;
    };
    let key = key_of_origin(text).unwrap_or_else(|| env::panic_str("bad origin"));
    if key == FloodKey::Owner {
        let l = req.labels;
        let trusted = airlock_verdict::recipient_trusted(l.recipient)
            && airlock_verdict::value_trusted(l.amount)
            && l.pc != 0
            && l.pc & !airlock_verdict::TRUSTED_MASK == 0;
        require!(trusted, "origin owner needs trusted labels");
    }
    key
}

/// The counters of one origin and the reset epoch of its agent they were written under (`reset_escalations` with no origin bumps the
/// agent's epoch, so every origin of the agent reads as reset without being listed).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct OriginFloodRec {
    pub epoch: u32,
    pub rec: FloodRec,
}

fn origin_map() -> LookupMap<String, OriginFloodRec> {
    LookupMap::new(StorageKey::FloodOrigin)
}

fn backstop_map() -> LookupMap<AccountId, FloodRec> {
    LookupMap::new(StorageKey::FloodBackstop)
}

fn epoch_map() -> LookupMap<AccountId, u32> {
    LookupMap::new(StorageKey::FloodEpoch)
}

fn request_origin_map() -> LookupMap<String, String> {
    LookupMap::new(StorageKey::FloodRequestOrigin)
}

fn origin_slot(agent: &AccountId, origin: &str) -> String {
    format!("{agent}|{origin}")
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

    /// The limits of one origin other than the owner: the flags, with at most `ORIGIN_MAX_PENDING` pending and `ORIGIN_HOURLY` an hour.
    pub fn origin_limits(&self) -> FloodLimits {
        let f = self.flood_limits();
        FloodLimits {
            max_pending: f.max_pending.min(ORIGIN_MAX_PENDING),
            hourly_budget: f.hourly_budget.min(ORIGIN_HOURLY),
            ..f
        }
    }

    /// The backstop of every origin other than the owner: at least `BACKSTOP_MIN_PENDING` pending and `BACKSTOP_MIN_HOURLY` an hour, the
    /// rejects-per-day lock of the flags, and no consecutive-reject lock (one origin's streak must not lock the others).
    pub fn backstop_limits(&self) -> FloodLimits {
        let f = self.flood_limits();
        FloodLimits {
            max_pending: f.max_pending.max(BACKSTOP_MIN_PENDING),
            lock_consecutive: u32::MAX,
            lock_per_day: f.lock_per_day,
            hourly_budget: f.hourly_budget.max(BACKSTOP_MIN_HOURLY),
        }
    }

    fn epoch_of(agent: &AccountId) -> u32 {
        epoch_map().get(agent).copied().unwrap_or(0)
    }

    /// The counters of (agent, origin) as the model's type, reset when they were written before the agent's last full reset.
    fn origin_state(agent: &AccountId, origin: &str) -> FloodState {
        match origin_map().get(&origin_slot(agent, origin)) {
            None => FloodState::default(),
            Some(r) if r.epoch < Self::epoch_of(agent) => reset(&FloodState::from(r.rec.clone())),
            Some(r) => FloodState::from(r.rec.clone()),
        }
    }

    fn put_origin_state(agent: &AccountId, origin: &str, s: FloodState) {
        let mut m = origin_map();
        m.insert(
            origin_slot(agent, origin),
            OriginFloodRec {
                epoch: Self::epoch_of(agent),
                rec: s.into(),
            },
        );
        m.flush();
    }

    fn backstop_state(agent: &AccountId) -> FloodState {
        backstop_map()
            .get(agent)
            .cloned()
            .map(FloodState::from)
            .unwrap_or_default()
    }

    fn put_backstop_state(agent: &AccountId, s: FloodState) {
        let mut m = backstop_map();
        m.insert(agent.clone(), s.into());
        m.flush();
    }

    /// The limits of the counters of one origin.
    fn limits_for(&self, key: &FloodKey) -> FloodLimits {
        match key {
            FloodKey::Named(_) => self.origin_limits(),
            _ => self.flood_limits(),
        }
    }

    /// What `flood_admit_key` would answer, read only: for a named origin the origin's counters first, then the backstop.
    pub fn flood_check_key(
        &self,
        agent: &AccountId,
        key: &FloodKey,
        now_ms: u64,
    ) -> Result<(), Reason> {
        let hour = utc_hour(now_ms);
        match key {
            FloodKey::Agent => self.flood_check(agent, now_ms).map(|_| ()),
            FloodKey::Owner => gate_escalation(
                &Self::origin_state(agent, OWNER_ORIGIN),
                &self.flood_limits(),
                hour,
            )
            .map(|_| ()),
            FloodKey::Named(o) => {
                gate_escalation(&Self::origin_state(agent, o), &self.origin_limits(), hour)?;
                gate_escalation(&Self::backstop_state(agent), &self.backstop_limits(), hour)
                    .map(|_| ())
            }
        }
    }

    /// Admission of one new escalation under `key`: `Ok` stores every counted state, `Err` stores nothing.
    pub fn flood_admit_key(
        &mut self,
        agent: &AccountId,
        key: &FloodKey,
        now_ms: u64,
    ) -> Result<(), Reason> {
        let hour = utc_hour(now_ms);
        match key {
            FloodKey::Agent => self.flood_admit(agent, now_ms),
            FloodKey::Owner => {
                let next = gate_escalation(
                    &Self::origin_state(agent, OWNER_ORIGIN),
                    &self.flood_limits(),
                    hour,
                )?;
                Self::put_origin_state(agent, OWNER_ORIGIN, next);
                Ok(())
            }
            FloodKey::Named(o) => {
                let mine =
                    gate_escalation(&Self::origin_state(agent, o), &self.origin_limits(), hour)?;
                let all =
                    gate_escalation(&Self::backstop_state(agent), &self.backstop_limits(), hour)?;
                Self::put_origin_state(agent, o, mine);
                Self::put_backstop_state(agent, all);
                Ok(())
            }
        }
    }

    /// Remembers the origin of a pending request, so its decision is counted on the same counters (nothing for `Agent`).
    pub fn remember_request_origin(&mut self, request_id: &str, key: &FloodKey) {
        if let Some(o) = key.origin() {
            let mut m = request_origin_map();
            m.insert(request_id.to_string(), o.to_string());
            m.flush();
        }
    }

    /// The key a pending request was admitted under, forgotten as it is read (a decision happens once). `Agent` when none was stored.
    fn take_request_key(request_id: &str) -> FloodKey {
        let mut m = request_origin_map();
        let key = m
            .remove(request_id)
            .and_then(|o| key_of_origin(&o))
            .unwrap_or(FloodKey::Agent);
        m.flush();
        key
    }

    /// Applies one model step to the counters of a decided request: the per-agent counters for `Agent`, the origin's counters for
    /// `Owner`, and the origin's and the backstop's for a named origin.
    fn flood_decide(
        &mut self,
        agent: &AccountId,
        request_id: &str,
        step: impl Fn(&FloodState, &FloodLimits) -> FloodState,
        legacy: impl FnOnce(&mut Self),
    ) {
        match Self::take_request_key(request_id) {
            FloodKey::Agent => legacy(self),
            FloodKey::Owner => {
                let next = step(
                    &Self::origin_state(agent, OWNER_ORIGIN),
                    &self.flood_limits(),
                );
                Self::put_origin_state(agent, OWNER_ORIGIN, next);
            }
            FloodKey::Named(o) => {
                let mine = step(&Self::origin_state(agent, &o), &self.origin_limits());
                let all = step(&Self::backstop_state(agent), &self.backstop_limits());
                Self::put_origin_state(agent, &o, mine);
                Self::put_backstop_state(agent, all);
            }
        }
    }

    /// The owner approved the pending request `request_id` of `agent`.
    pub fn flood_after_approve_request(&mut self, agent: &AccountId, request_id: &str) {
        self.flood_decide(
            agent,
            request_id,
            |s, _| on_approve(s),
            |c| c.flood_after_approve(agent),
        );
    }

    /// The pending request `request_id` of `agent` expired.
    pub fn flood_after_expire_request(&mut self, agent: &AccountId, request_id: &str) {
        self.flood_decide(
            agent,
            request_id,
            |s, _| on_expire(s),
            |c| c.flood_after_expire(agent),
        );
    }

    /// The owner rejected the pending request `request_id` of `agent` at `now_ms`. Only the per-agent counters emit `escalations_locked`
    /// (an origin is the runtime's text and never goes into an event); an origin's lock shows in `get_escalation_state`.
    pub fn flood_after_reject_request(&mut self, agent: &AccountId, request_id: &str, now_ms: u64) {
        let day = utc_day(now_ms);
        self.flood_decide(
            agent,
            request_id,
            |s, l| on_reject(s, l, day),
            |c| c.flood_after_reject(agent, now_ms),
        );
    }

    /// The owner's `reset_escalations`: with no origin, the per-agent counters, the backstop and (through the epoch) every origin of the
    /// agent; with an origin, that origin's counters only. A reset keeps the pending count and the hour, so it cannot get around the
    /// hourly budget. Reverts `bad origin` for an argument that is neither `owner` nor a named origin.
    pub fn flood_reset_origin(&mut self, agent: &AccountId, origin: Option<&str>) {
        match origin {
            None => {
                self.flood_reset(agent);
                if backstop_map().contains_key(agent) {
                    Self::put_backstop_state(agent, reset(&Self::backstop_state(agent)));
                }
                let next = Self::epoch_of(agent)
                    .checked_add(1)
                    .unwrap_or_else(|| env::panic_str("flood epoch overflow"));
                let mut m = epoch_map();
                m.insert(agent.clone(), next);
                m.flush();
            }
            Some(text) => {
                let key = key_of_origin(text).unwrap_or_else(|| env::panic_str("bad origin"));
                let o = key.origin().unwrap_or(OWNER_ORIGIN).to_string();
                if origin_map().contains_key(&origin_slot(agent, &o)) {
                    Self::put_origin_state(agent, &o, reset(&Self::origin_state(agent, &o)));
                }
            }
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
    ///
    /// AIR-315: with `origin` (`owner` or a named origin), the counters and limits of that origin instead; `bad origin` otherwise.
    pub fn get_escalation_state(&self, agent: AccountId, origin: Option<String>) -> FloodView {
        let now_ms = block_timestamp_ms();
        let (s, l) = match origin.as_deref() {
            None => (self.flood_state(&agent), self.flood_limits()),
            Some(text) => {
                let key = key_of_origin(text).unwrap_or_else(|| env::panic_str("bad origin"));
                let o = key.origin().unwrap_or(OWNER_ORIGIN);
                (Self::origin_state(&agent, o), self.limits_for(&key))
            }
        };
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

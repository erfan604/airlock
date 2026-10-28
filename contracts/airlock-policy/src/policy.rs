// The policy state the owner edits: the pause switch and the flood-control flags (AIR-040). The asset registry (AIR-042), the
// address book (AIR-043) and the task key (AIR-045) join this module's owner methods in later tickets.
use crate::*;

/// `set_flags` bound: a TTL is at most 7 days, because AIR-061 computes `now_ms + pending_ttl_ms`.
pub const MAX_TTL_MS: u64 = 604_800_000;
/// `set_flags` bound: a counter (pending cap, hourly budget, lock thresholds) is at most this.
pub const MAX_COUNTER: u32 = 10_000;
/// `set_flags` bound: at most 99 actions per task, so a request id stays at 67 characters or fewer (GLOSSARY, AIR-063).
pub const MAX_TASK_ACTIONS: u8 = 99;

/// The owner-settable flags, as stored (borsh). The defaults are in `Default` and in docs, GLOSSARY "Contract flags".
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flags {
    /// Pending escalations one agent may have at once (a further ESCALATE is blocked `PendingFull`, AIR-083).
    pub max_pending_per_agent: u32,
    /// How long a pending escalation lives before anyone may expire it, in milliseconds.
    pub pending_ttl_ms: u64,
    /// Escalations one agent may raise per hour (AIR-083).
    pub hourly_escalation_budget: u32,
    /// Consecutive rejects that lock an agent's escalations (AIR-083).
    pub lock_consecutive_rejects: u32,
    /// Rejects in one UTC day that lock an agent's escalations (AIR-083).
    pub lock_rejects_per_day: u32,
    /// The longest an owner-signed task may live, in milliseconds (AIR-060).
    pub max_task_ttl_ms: u64,
    /// The most actions an owner-signed task may allow (AIR-045, AIR-060).
    pub max_task_actions: u8,
}

impl Default for Flags {
    fn default() -> Self {
        Self {
            max_pending_per_agent: 3,
            pending_ttl_ms: 3_600_000,
            hourly_escalation_budget: 6,
            lock_consecutive_rejects: 3,
            lock_rejects_per_day: 20,
            max_task_ttl_ms: 3_600_000,
            max_task_actions: 20,
        }
    }
}

/// The flags on the wire (JSON): counters are numbers, the two millisecond fields are strings (`U64`), the field order is
/// the order of the struct.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlagsJson {
    pub max_pending_per_agent: u32,
    pub pending_ttl_ms: U64,
    pub hourly_escalation_budget: u32,
    pub lock_consecutive_rejects: u32,
    pub lock_rejects_per_day: u32,
    pub max_task_ttl_ms: U64,
    pub max_task_actions: u8,
}

impl From<Flags> for FlagsJson {
    fn from(flags: Flags) -> Self {
        Self {
            max_pending_per_agent: flags.max_pending_per_agent,
            pending_ttl_ms: U64(flags.pending_ttl_ms),
            hourly_escalation_budget: flags.hourly_escalation_budget,
            lock_consecutive_rejects: flags.lock_consecutive_rejects,
            lock_rejects_per_day: flags.lock_rejects_per_day,
            max_task_ttl_ms: U64(flags.max_task_ttl_ms),
            max_task_actions: flags.max_task_actions,
        }
    }
}

impl FlagsJson {
    /// Checks the `set_flags` bounds (each a `require!`, so the text is the panic message) and returns the stored form.
    /// Every field at least 1; both TTLs at most 7 days; the four u32 counters at most 10,000; `max_task_actions` at most 99.
    pub fn checked(&self) -> Flags {
        let counters = [
            self.max_pending_per_agent,
            self.hourly_escalation_budget,
            self.lock_consecutive_rejects,
            self.lock_rejects_per_day,
        ];
        require!(
            counters.iter().all(|c| *c > 0)
                && self.pending_ttl_ms.0 > 0
                && self.max_task_ttl_ms.0 > 0
                && self.max_task_actions > 0,
            "flag must be above 0"
        );
        require!(
            self.pending_ttl_ms.0 <= MAX_TTL_MS && self.max_task_ttl_ms.0 <= MAX_TTL_MS,
            "ttl above 7 days"
        );
        require!(
            counters.iter().all(|c| *c <= MAX_COUNTER),
            "flag above 10000"
        );
        require!(
            self.max_task_actions <= MAX_TASK_ACTIONS,
            "max_task_actions above 99"
        );
        Flags {
            max_pending_per_agent: self.max_pending_per_agent,
            pending_ttl_ms: self.pending_ttl_ms.0,
            hourly_escalation_budget: self.hourly_escalation_budget,
            lock_consecutive_rejects: self.lock_consecutive_rejects,
            lock_rejects_per_day: self.lock_rejects_per_day,
            max_task_ttl_ms: self.max_task_ttl_ms.0,
            max_task_actions: self.max_task_actions,
        }
    }
}

/// What `get_policy` returns.
#[near(serializers = [json])]
pub struct PolicyView {
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub requires_tee: bool,
    pub paused: bool,
    pub flags: FlagsJson,
}

#[near]
impl Contract {
    /// Owner: stop or resume the gate. While paused every request is blocked (AIR-061). Emits `paused`.
    #[payable]
    pub fn pause(&mut self, paused: bool) {
        self.owner_call();
        self.paused = paused;
        Event::Paused { paused }.emit();
    }

    /// Owner: replace every flag at once. Out of bounds values revert (see `FlagsJson::checked`). Emits `flags_set`.
    #[payable]
    pub fn set_flags(&mut self, flags: FlagsJson) {
        self.owner_call();
        self.flags = flags.checked();
        Event::FlagsSet {
            flags: FlagsJson::from(self.flags),
        }
        .emit();
    }

    /// The owner, the signer contract, the TEE mode, the pause switch and the flags.
    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            owner_id: self.owner_id.clone(),
            mpc_contract_id: self.mpc_contract_id.clone(),
            requires_tee: self.requires_tee,
            paused: self.paused,
            flags: FlagsJson::from(self.flags),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{MPC, OWNER, ctx, fresh};
    use near_sdk::test_utils::get_logs;
    use near_sdk::testing_env;

    const T0_MS: u64 = 1_000;

    fn json_with(field: &str, value: serde_json::Value) -> FlagsJson {
        let mut v = serde_json::to_value(FlagsJson::from(Flags::default())).unwrap();
        v[field] = value;
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn flags_default_serialization_is_exact() {
        assert_eq!(
            serde_json::to_string(&FlagsJson::from(Flags::default())).unwrap(),
            r#"{"max_pending_per_agent":3,"pending_ttl_ms":"3600000","hourly_escalation_budget":6,"lock_consecutive_rejects":3,"lock_rejects_per_day":20,"max_task_ttl_ms":"3600000","max_task_actions":20}"#
        );
    }

    #[test]
    fn new_starts_unpaused_with_default_flags() {
        let c = fresh();
        let view = c.get_policy();
        assert!(!view.paused);
        assert_eq!(view.flags, FlagsJson::from(Flags::default()));
        assert_eq!(view.owner_id.as_str(), OWNER);
        assert_eq!(view.mpc_contract_id.as_str(), MPC);
        assert!(!view.requires_tee);
    }

    #[test]
    fn owner_call_needs_exactly_one_yocto() {
        for deposit in [0u128, 2, 1_000_000_000_000_000_000_000_000] {
            let mut c = fresh();
            testing_env!(ctx(OWNER, T0_MS, deposit).build());
            let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.owner_call()));
            let message = hit.expect_err("owner_call must refuse a deposit that is not 1 yocto");
            let text = message
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| message.downcast_ref::<&str>().map(|s| (*s).to_string()))
                .unwrap_or_default();
            assert!(
                text.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
                "deposit {deposit}: {text}"
            );
        }
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        c.owner_call();
    }

    #[test]
    #[should_panic(expected = "Caller is not the owner")]
    fn owner_call_refuses_a_stranger_with_one_yocto() {
        let mut c = fresh();
        testing_env!(ctx("stranger.test.near", T0_MS, 1).build());
        c.owner_call();
    }

    #[test]
    fn pause_sets_the_flag_and_emits_one_event() {
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        c.pause(true);
        assert!(c.get_policy().paused);
        assert_eq!(
            get_logs(),
            vec![
                r#"EVENT_JSON:{"standard":"airlock","version":"1.0.0","event":"paused","data":[{"paused":true}]}"#
                    .to_string()
            ]
        );
        c.pause(false);
        assert!(!c.get_policy().paused);
    }

    #[test]
    fn set_flags_stores_and_emits_the_flags() {
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        let flags = json_with("max_pending_per_agent", serde_json::json!(4));
        c.set_flags(flags.clone());
        assert_eq!(c.get_policy().flags, flags);
        assert_eq!(c.flags.max_pending_per_agent, 4);
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        let line = logs[0].strip_prefix("EVENT_JSON:").expect("an event line");
        let event: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(event["standard"], "airlock");
        assert_eq!(event["event"], "flags_set");
        assert_eq!(event["data"][0]["flags"]["max_pending_per_agent"], 4);
    }

    fn rejects(flags: FlagsJson, text: &str) {
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        let before = c.flags;
        let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_flags(flags)));
        let message = hit.expect_err("set_flags must reject");
        let got = message
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| message.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default();
        assert!(got.contains(text), "expected `{text}` in `{got}`");
        assert_eq!(c.flags, before, "a rejected set_flags changed the flags");
    }

    #[test]
    fn flag_bounds_cover_every_field() {
        use serde_json::json;
        for field in [
            "max_pending_per_agent",
            "hourly_escalation_budget",
            "lock_consecutive_rejects",
            "lock_rejects_per_day",
            "max_task_actions",
        ] {
            rejects(json_with(field, json!(0)), "flag must be above 0");
        }
        for field in ["pending_ttl_ms", "max_task_ttl_ms"] {
            rejects(json_with(field, json!("0")), "flag must be above 0");
            rejects(json_with(field, json!("604800001")), "ttl above 7 days");
            rejects(
                json_with(field, json!(u64::MAX.to_string())),
                "ttl above 7 days",
            );
        }
        for field in [
            "max_pending_per_agent",
            "hourly_escalation_budget",
            "lock_consecutive_rejects",
            "lock_rejects_per_day",
        ] {
            rejects(json_with(field, json!(10_001)), "flag above 10000");
            rejects(json_with(field, json!(u32::MAX)), "flag above 10000");
        }
        rejects(
            json_with("max_task_actions", json!(100)),
            "max_task_actions above 99",
        );
        rejects(
            json_with("max_task_actions", json!(255)),
            "max_task_actions above 99",
        );
    }

    #[test]
    fn flag_bounds_accept_the_edges() {
        use serde_json::json;
        let mut c = fresh();
        testing_env!(ctx(OWNER, T0_MS, 1).build());
        let edge = FlagsJson {
            max_pending_per_agent: 10_000,
            pending_ttl_ms: U64(604_800_000),
            hourly_escalation_budget: 10_000,
            lock_consecutive_rejects: 10_000,
            lock_rejects_per_day: 10_000,
            max_task_ttl_ms: U64(604_800_000),
            max_task_actions: 99,
        };
        c.set_flags(edge.clone());
        assert_eq!(c.get_policy().flags, edge);
        let low = json_with("max_pending_per_agent", json!(1));
        c.set_flags(low.clone());
        assert_eq!(c.get_policy().flags, low);
    }
}

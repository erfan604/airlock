// AIR-083: flood control of the contract, in process (no sandbox). `inproc_contract()` runs `Contract` methods directly under
// `testing_env!`, so the tests can cross a UTC hour or day on purpose, which a sandbox test must never do. The helpers
// (`flood_admit`, `flood_after_*`, `flood_reset`) are called the way `submit_batch`, `approve`, `reject`, `expire` and
// `reset_escalations` call them. Every refusal assertion compares the reason, because a missing method also fails.

mod common;

use airlock_policy::flood::FloodRec;
use airlock_policy::{Contract, Flags, FlagsJson};
use airlock_verdict::Reason;
use airlock_verdict::flood::FloodState;
use common::{T0, inproc_contract, inproc_ctx};
use near_sdk::borsh;
use near_sdk::test_utils::get_logs;
use near_sdk::{AccountId, testing_env};

const OWNER: &str = "owner.test.near";
const MS_PER_HOUR: u64 = 3_600_000;
const MS_PER_DAY: u64 = 86_400_000;

fn agent(name: &str) -> AccountId {
    format!("{name}.test.near").parse().unwrap()
}

/// The default flags with one field replaced, set by the owner (1 yocto) at block time `T0`.
fn set_flag(c: &mut Contract, field: &str, value: serde_json::Value) {
    let mut v = serde_json::to_value(FlagsJson::from(Flags::default())).unwrap();
    v[field] = value;
    testing_env!(inproc_ctx(OWNER, T0, 1).build());
    c.set_flags(serde_json::from_value(v).unwrap());
}

fn rec(c: &Contract, who: &AccountId) -> FloodRec {
    c.flood.get(who).cloned().unwrap_or_default()
}

#[test]
fn flood_admit_counts_pending_and_refuses_the_fourth() {
    let mut c = inproc_contract();
    let a = agent("agent");
    for n in 1..=3u32 {
        assert_eq!(c.flood_admit(&a, T0), Ok(()));
        assert_eq!(rec(&c, &a).pending, n);
    }
    assert_eq!(c.flood_admit(&a, T0), Err(Reason::PendingFull));
    // a refusal stores nothing: the counters are those of three admissions
    let r = rec(&c, &a);
    assert_eq!((r.pending, r.hour_count), (3, 3));
    testing_env!(inproc_ctx(OWNER, T0, 0).build());
    assert_eq!(c.get_escalation_state(a).pending, 3);
}

#[test]
fn flood_hour_bucket_rolls_over_at_the_exact_millisecond() {
    let mut c = inproc_contract();
    let a = agent("agent");
    set_flag(&mut c, "hourly_escalation_budget", serde_json::json!(1));
    let last_ms_of_hour = T0 + MS_PER_HOUR - 1;
    let first_ms_of_next = T0 + MS_PER_HOUR;
    assert_eq!(c.flood_admit(&a, last_ms_of_hour), Ok(()));
    assert_eq!(
        c.flood_admit(&a, last_ms_of_hour),
        Err(Reason::EscalationBudget)
    );
    // one millisecond later is the next hour bucket: a fresh budget
    assert_eq!(c.flood_admit(&a, first_ms_of_next), Ok(()));
    assert_eq!(
        c.flood_admit(&a, first_ms_of_next),
        Err(Reason::EscalationBudget)
    );
    assert_eq!(rec(&c, &a).hour_count, 1);
    assert_eq!(rec(&c, &a).pending, 2);
}

#[test]
fn flood_seventh_in_one_hour_is_refused_with_default_flags() {
    let mut c = inproc_contract();
    let a = agent("agent");
    for _ in 0..6 {
        assert_eq!(c.flood_admit(&a, T0 + 1_000), Ok(()));
        c.flood_after_approve(&a);
    }
    assert_eq!(rec(&c, &a).pending, 0);
    assert_eq!(c.flood_admit(&a, T0 + 2_000), Err(Reason::EscalationBudget));
}

#[test]
fn flood_reject_counter_resets_at_utc_midnight() {
    let mut c = inproc_contract();
    let a = agent("agent");
    for _ in 0..2 {
        assert_eq!(c.flood_admit(&a, T0), Ok(()));
    }
    c.flood_after_reject(&a, T0 + MS_PER_DAY - 1);
    assert_eq!(rec(&c, &a).rejects_today, 1);
    // the first millisecond of the next UTC day starts a new count
    c.flood_after_reject(&a, T0 + MS_PER_DAY);
    let r = rec(&c, &a);
    assert_eq!(r.rejects_today, 1);
    assert_eq!(r.rejects_day, T0 / MS_PER_DAY + 1);
    // the consecutive streak is not a day counter: it kept counting across midnight
    assert_eq!(r.consecutive_rejects, 2);
    assert!(!r.locked);
}

#[test]
fn flood_three_rejects_lock_and_reset_unlocks_and_keeps_pending() {
    let mut c = inproc_contract();
    let a = agent("agent");
    set_flag(&mut c, "max_pending_per_agent", serde_json::json!(5));
    for _ in 0..4 {
        assert_eq!(c.flood_admit(&a, T0), Ok(()));
    }
    c.flood_after_reject(&a, T0);
    c.flood_after_reject(&a, T0);
    assert!(!rec(&c, &a).locked);
    assert!(
        !get_logs().iter().any(|l| l.contains("escalations_locked")),
        "no lock event before the third reject"
    );
    c.flood_after_reject(&a, T0);
    let r = rec(&c, &a);
    assert!(r.locked);
    assert_eq!(
        (r.pending, r.consecutive_rejects, r.rejects_today),
        (1, 3, 3)
    );
    let logs = get_logs();
    let line = logs
        .iter()
        .find(|l| l.contains("escalations_locked"))
        .expect("the third reject emits escalations_locked");
    let event: serde_json::Value =
        serde_json::from_str(line.trim_start_matches("EVENT_JSON:")).unwrap();
    assert_eq!(event["event"], "escalations_locked");
    assert_eq!(
        event["data"][0],
        serde_json::json!({ "agent": "agent.test.near", "consecutive": 3, "today": 3 })
    );
    // a locked agent is refused, and a further reject does not emit the event again
    assert_eq!(c.flood_admit(&a, T0), Err(Reason::EscalationsLocked));
    // the log is cumulative: a further reject must not add a second lock event
    c.flood_after_reject(&a, T0);
    let locks = get_logs()
        .iter()
        .filter(|l| l.contains("escalations_locked"))
        .count();
    assert_eq!(locks, 1, "the event is for a new lock only");
    // reset clears the lock and the counters and keeps the pending count
    let pending = rec(&c, &a).pending;
    c.flood_reset(&a);
    let r = rec(&c, &a);
    assert!(!r.locked);
    assert_eq!((r.consecutive_rejects, r.rejects_today), (0, 0));
    assert_eq!(r.pending, pending);
    assert_eq!(c.flood_admit(&a, T0), Ok(()));
    // reset creates no entry for an agent that has none
    let stranger = agent("stranger");
    c.flood_reset(&stranger);
    assert!(c.flood.get(&stranger).is_none());
}

#[test]
fn flood_lowering_the_cap_below_pending_refuses_until_below() {
    let mut c = inproc_contract();
    let a = agent("agent");
    assert_eq!(c.flood_admit(&a, T0), Ok(()));
    assert_eq!(c.flood_admit(&a, T0), Ok(()));
    set_flag(&mut c, "max_pending_per_agent", serde_json::json!(1));
    assert_eq!(c.flood_admit(&a, T0), Err(Reason::PendingFull));
    assert_eq!(rec(&c, &a).pending, 2, "existing items stay");
    c.flood_after_approve(&a);
    assert_eq!(c.flood_admit(&a, T0), Err(Reason::PendingFull));
    c.flood_after_expire(&a);
    assert_eq!(rec(&c, &a).pending, 0);
    assert_eq!(c.flood_admit(&a, T0), Ok(()));
}

#[test]
fn flood_is_per_agent() {
    let mut c = inproc_contract();
    let (a, b) = (agent("agent"), agent("other"));
    for _ in 0..3 {
        assert_eq!(c.flood_admit(&a, T0), Ok(()));
    }
    for _ in 0..3 {
        c.flood_after_reject(&a, T0);
    }
    assert_eq!(c.flood_admit(&a, T0), Err(Reason::EscalationsLocked));
    assert_eq!(c.flood_admit(&b, T0), Ok(()));
    assert!(!rec(&c, &b).locked);
    assert_eq!(rec(&c, &b).pending, 1);
}

#[test]
fn flood_view_reports_current_buckets() {
    let mut c = inproc_contract();
    let a = agent("agent");
    for _ in 0..2 {
        assert_eq!(c.flood_admit(&a, T0), Ok(()));
    }
    c.flood_after_reject(&a, T0);
    testing_env!(inproc_ctx(OWNER, T0, 0).build());
    let v = c.get_escalation_state(a.clone());
    assert_eq!((v.pending, v.hour_count, v.rejects_today), (1, 2, 1));
    assert_eq!(v.consecutive_rejects, 1);
    assert!(!v.locked);
    assert_eq!(
        (
            v.limits.max_pending,
            v.limits.lock_consecutive,
            v.limits.lock_per_day,
            v.limits.hourly_budget
        ),
        (3, 3, 20, 6)
    );
    // the next hour: the stored hour is old, so the view shows 0 while the day count stays
    testing_env!(inproc_ctx(OWNER, T0 + MS_PER_HOUR, 0).build());
    let v = c.get_escalation_state(a.clone());
    assert_eq!((v.hour_count, v.rejects_today, v.pending), (0, 1, 1));
    // the next day: the day count is 0 too, the streak and the pending count are not buckets
    testing_env!(inproc_ctx(OWNER, T0 + MS_PER_DAY, 0).build());
    let v = c.get_escalation_state(a.clone());
    assert_eq!((v.hour_count, v.rejects_today), (0, 0));
    assert_eq!((v.pending, v.consecutive_rejects), (1, 1));
    // an unknown agent: zeros with the current limits, and limits follow set_flags
    set_flag(&mut c, "hourly_escalation_budget", serde_json::json!(9));
    testing_env!(inproc_ctx(OWNER, T0, 0).build());
    let v = c.get_escalation_state(agent("nobody"));
    assert_eq!(
        (
            v.pending,
            v.consecutive_rejects,
            v.rejects_today,
            v.hour_count
        ),
        (0, 0, 0, 0)
    );
    assert!(!v.locked);
    assert_eq!(v.limits.hourly_budget, 9);
    // the JSON has exactly these keys, all numbers except `locked`
    let json = serde_json::to_value(&v).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "consecutive_rejects",
            "hour_count",
            "limits",
            "locked",
            "pending",
            "rejects_today"
        ]
    );
    assert!(json["pending"].is_number() && json["limits"]["max_pending"].is_number());
}

#[test]
fn flood_rec_round_trips_borsh_and_state() {
    let state = FloodState {
        pending: 2,
        consecutive_rejects: 3,
        rejects_day: 20_833,
        rejects_today: 4,
        locked: true,
        hour: 499_992,
        hour_count: 5,
    };
    let stored = FloodRec::from(state);
    assert_eq!(FloodState::from(stored.clone()), state);
    let bytes = borsh::to_vec(&stored).unwrap();
    let back: FloodRec = borsh::from_slice(&bytes).unwrap();
    assert_eq!(back, stored);
    assert_eq!(FloodState::from(back), state);
    assert_eq!(FloodRec::default(), FloodRec::from(FloodState::default()));
    // the JSON mirror has the seven fields
    let json = serde_json::to_value(&stored).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 7);
}

// AIR-083: flood control in the sandbox. A fourth pending escalation per agent is a stored `Blocked` request (`PendingFull`), the
// hourly budget refuses the one after it (`EscalationBudget`), and a refusal consumes the request id and one task action but no
// pending number. Every refusal assertion checks the reason text, because a missing method also fails.
//
// The sandbox clock is real time and a test never crosses a UTC boundary on purpose: every test that reads an hourly count starts
// with `ensure_hour_window(&w, 180_000)`. Run with `-- --test-threads=4` (each sandbox is a neard of several hundred MB).
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::request::request_id;
use airlock_policy::task::task_hash;
use common::*;
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};

/// At most this many sandboxes of this file run at once, so a plain `cargo test` of the crate does not start all of them (a neard is
/// several hundred MB and a deploy times out when too many start together; see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

type Task = (
    airlock_policy::task::OwnerTask,
    near_sdk::json_types::Base64VecU8,
);

async fn view(w: &World, method: &str, args: Value) -> Value {
    call_view::<Value>(&w.policy, method, args, &w.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
        .data
}

async fn state_of(w: &World) -> Value {
    view(w, "get_escalation_state", json!({ "agent": w.agent })).await
}

/// `set_flags` with the defaults except the three that vary.
async fn set_flags(w: &World, max_pending: u32, hourly: u32, ttl_ms: u64) {
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": max_pending,
            "pending_ttl_ms": ttl_ms.to_string(),
            "hourly_escalation_budget": hourly,
            "lock_consecutive_rejects": 3,
            "lock_rejects_per_day": 20,
            "max_task_ttl_ms": "3600000",
            "max_task_actions": 20
        } }),
    )
    .await;
}

/// The same request as `escalate`, keeping the whole result (for its events).
async fn escalate_raw(w: &World, task: &Task, index: u8) -> ExecutionFinalResult {
    let req = w.request_json(
        &task.0,
        index,
        "near",
        "near:alice.sandbox",
        2 * U,
        (2, 32, 1),
        None,
    );
    w.submit(vec![req], task).await
}

/// The owner's `approve` of the escalation with this number, with the six strings of its stored card.
async fn approve(w: &World, no: &str) {
    let found = view(w, "get_pending", json!({})).await;
    let item = found
        .as_array()
        .expect("get_pending is an array")
        .iter()
        .find(|v| v["id"] == no)
        .unwrap_or_else(|| panic!("pending {no} is not in {found}"))
        .clone();
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "approve",
        json!({
            "id": no,
            "to": item["payee"],
            "asset": item["display"]["asset_symbol"],
            "amount": item["display"]["amount_decimal"],
            "why": item["reason"],
            "book": item["book_status"]
        }),
    )
    .await;
}

fn id_of(task: &Task, index: u8) -> String {
    request_id(&task_hash(&task.0), index)
}

fn assert_blocked(outcome: &Value, reason: &str) {
    assert_eq!(outcome["outcome"], "blocked", "{outcome}");
    assert_eq!(outcome["reason"], reason, "{outcome}");
    assert!(outcome["pending_id"].is_null(), "{outcome}");
}

#[tokio::test]
async fn fourth_pending_is_blocked_pending_full() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    let task = flood_task(&w);
    for i in 0..3u8 {
        let out = escalate(&w, &task, i).await;
        assert_eq!(out["outcome"], "escalated", "{out}");
        assert_eq!(out["reason"], "UntrustedAmount", "{out}");
        assert_eq!(pending_id_of(&out).await, (i + 1).to_string());
    }
    let result = escalate_raw(&w, &task, 3).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    let outcomes: Value = result.clone().json().expect("the outcomes parse");
    assert_blocked(&outcomes[0], "PendingFull");
    // the stored record is a compact Blocked one with the same reason, and the `blocked` event was emitted
    let stored = w.request(&id_of(&task, 3)).await.expect("a stored record");
    assert_eq!(stored["state"], "Blocked", "{stored}");
    assert_eq!(stored["reason"], "PendingFull", "{stored}");
    let blocked = events(&result, "blocked");
    assert_eq!(blocked.len(), 1, "{blocked:?}");
    assert_eq!(blocked[0]["reason"], "PendingFull");
    assert_eq!(blocked[0]["request_id"], id_of(&task, 3));
    assert!(events(&result, "escalated").is_empty());
    // a replay of the refused id answers the stored outcome and changes nothing
    let again = escalate(&w, &task, 3).await;
    assert_blocked(&again, "PendingFull");
    // a refusal consumes no pending number: after one approve the next escalation is number 4, not 5
    approve(&w, "1").await;
    let next = escalate(&w, &task, 4).await;
    assert_eq!(next["outcome"], "escalated", "{next}");
    assert_eq!(pending_id_of(&next).await, "4");
}

#[tokio::test]
async fn approve_frees_a_slot() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    let task = flood_task(&w);
    let mut first = Value::Null;
    for i in 0..3u8 {
        let out = escalate(&w, &task, i).await;
        if i == 0 {
            first = out;
        }
    }
    assert_blocked(&escalate(&w, &task, 3).await, "PendingFull");
    approve(&w, &pending_id_of(&first).await).await;
    assert_eq!(state_of(&w).await["pending"], 2);
    let out = escalate(&w, &task, 4).await;
    assert_eq!(out["outcome"], "escalated", "{out}");
    assert_eq!(state_of(&w).await["pending"], 3);
}

#[tokio::test]
async fn hourly_budget_blocks_the_third_when_budget_is_two() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    set_flags(&w, 3, 2, 3_600_000).await;
    let task = flood_task(&w);
    for i in 0..2u8 {
        let out = escalate(&w, &task, i).await;
        assert_eq!(out["outcome"], "escalated", "{out}");
        approve(&w, &pending_id_of(&out).await).await;
    }
    assert_blocked(&escalate(&w, &task, 2).await, "EscalationBudget");
    let s = state_of(&w).await;
    assert_eq!(s["hour_count"], 2, "{s}");
    assert_eq!(s["pending"], 0, "{s}");
}

#[tokio::test]
async fn set_flags_take_effect_on_the_next_request() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    let task = flood_task(&w);
    set_flags(&w, 4, 6, 3_600_000).await;
    for i in 0..4u8 {
        let out = escalate(&w, &task, i).await;
        assert_eq!(out["outcome"], "escalated", "request {i}: {out}");
    }
    assert_blocked(&escalate(&w, &task, 4).await, "PendingFull");
    let s = state_of(&w).await;
    assert_eq!(s["limits"]["max_pending"], 4, "{s}");
    assert_eq!(s["pending"], 4, "{s}");
}

#[tokio::test]
async fn flood_counter_matches_get_pending() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    let task = flood_task(&w);
    let mut numbers = Vec::new();
    for i in 0..3u8 {
        numbers.push(pending_id_of(&escalate(&w, &task, i).await).await);
    }
    approve(&w, &numbers[1]).await;
    numbers.push(pending_id_of(&escalate(&w, &task, 3).await).await);
    assert_blocked(&escalate(&w, &task, 4).await, "PendingFull");
    approve(&w, &numbers[0]).await;
    let listed = view(&w, "get_pending", json!({})).await;
    let mine = listed
        .as_array()
        .expect("get_pending is an array")
        .iter()
        .filter(|v| v["agent"] == w.agent.as_str())
        .count();
    assert_eq!(mine, 2, "{listed}");
    assert_eq!(state_of(&w).await["pending"], mine as u64);
}

#[tokio::test]
async fn get_escalation_state_unknown_agent_is_zero() {
    let _slot = slot().await;
    let w = flood_world().await;
    let s = view(
        &w,
        "get_escalation_state",
        json!({ "agent": "nobody.sandbox" }),
    )
    .await;
    assert_eq!(
        s,
        json!({
            "pending": 0,
            "consecutive_rejects": 0,
            "rejects_today": 0,
            "locked": false,
            "hour_count": 0,
            "limits": {
                "max_pending": 3,
                "lock_consecutive": 3,
                "lock_per_day": 20,
                "hourly_budget": 6
            }
        })
    );
}

#[tokio::test]
async fn methods_are_exported() {
    let _slot = slot().await;
    let w = flood_world().await;
    let s = state_of(&w).await;
    let mut keys: Vec<&str> = s
        .as_object()
        .unwrap_or_else(|| panic!("not an object: {s}"))
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
    // the flood helpers are not exported: they are plain methods, not entry points
    let exports = wasm_exports();
    for name in [
        "flood_admit",
        "flood_after_approve",
        "flood_after_expire",
        "flood_after_reject",
        "flood_reset",
        "flood_limits",
    ] {
        assert!(!exports.iter().any(|e| e == name), "{name} is exported");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Enabled by AIR-081 (`reject`, `expire`, `reset_escalations`)
// ---------------------------------------------------------------------------------------------------------------------

async fn reject(w: &World, no: &str) {
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "reject",
        json!({ "id": no }),
    )
    .await;
}

#[tokio::test]
#[ignore = "needs AIR-081"]
async fn expire_frees_a_slot() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    set_flags(&w, 3, 6, 1).await;
    let task = flood_task(&w);
    let first = escalate(&w, &task, 0).await;
    escalate(&w, &task, 1).await;
    escalate(&w, &task, 2).await;
    assert_blocked(&escalate(&w, &task, 3).await, "PendingFull");
    let result = call_300_tgas(
        &w.policy,
        &w.net,
        &w.root,
        &w.owner_signer,
        "expire",
        json!({ "id": pending_id_of(&first).await }),
    )
    .await;
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    assert_eq!(state_of(&w).await["pending"], 2);
    assert_eq!(escalate(&w, &task, 4).await["outcome"], "escalated");
}

#[tokio::test]
#[ignore = "needs AIR-081"]
async fn three_consecutive_rejects_lock() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    let task = flood_task(&w);
    for i in 0..3u8 {
        let out = escalate(&w, &task, i).await;
        reject(&w, &pending_id_of(&out).await).await;
    }
    let s = state_of(&w).await;
    assert_eq!(s["locked"], true, "{s}");
    assert_blocked(&escalate(&w, &task, 3).await, "EscalationsLocked");
}

#[tokio::test]
#[ignore = "needs AIR-081"]
async fn day_rule_locks_without_a_streak() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": 3,
            "pending_ttl_ms": "3600000",
            "hourly_escalation_budget": 100,
            "lock_consecutive_rejects": 10,
            "lock_rejects_per_day": 4,
            "max_task_ttl_ms": "3600000",
            "max_task_actions": 20
        } }),
    )
    .await;
    let task = flood_task(&w);
    let mut index = 0u8;
    for _ in 0..4 {
        let out = escalate(&w, &task, index).await;
        index += 1;
        reject(&w, &pending_id_of(&out).await).await;
        let s = state_of(&w).await;
        if s["locked"] == true {
            break;
        }
        let out = escalate(&w, &task, index).await;
        index += 1;
        approve(&w, &pending_id_of(&out).await).await;
    }
    let s = state_of(&w).await;
    assert_eq!(s["locked"], true, "{s}");
    assert!(s["consecutive_rejects"].as_u64().unwrap() < 10, "{s}");
    assert_blocked(&escalate(&w, &task, index).await, "EscalationsLocked");
}

#[tokio::test]
#[ignore = "needs AIR-081"]
async fn approve_between_rejects_resets_the_streak() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    let task = flood_task(&w);
    let a = escalate(&w, &task, 0).await;
    reject(&w, &pending_id_of(&a).await).await;
    let b = escalate(&w, &task, 1).await;
    reject(&w, &pending_id_of(&b).await).await;
    let c = escalate(&w, &task, 2).await;
    approve(&w, &pending_id_of(&c).await).await;
    assert_eq!(state_of(&w).await["consecutive_rejects"], 0);
    let d = escalate(&w, &task, 3).await;
    reject(&w, &pending_id_of(&d).await).await;
    let s = state_of(&w).await;
    assert_eq!(s["locked"], false, "{s}");
    assert_eq!(s["consecutive_rejects"], 1, "{s}");
}

#[tokio::test]
#[ignore = "needs AIR-081"]
async fn reset_unlocks_and_a_new_escalation_is_accepted() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    let task = flood_task(&w);
    for i in 0..3u8 {
        let out = escalate(&w, &task, i).await;
        reject(&w, &pending_id_of(&out).await).await;
    }
    assert_blocked(&escalate(&w, &task, 3).await, "EscalationsLocked");
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "reset_escalations",
        json!({ "agent": w.agent }),
    )
    .await;
    assert_eq!(state_of(&w).await["locked"], false);
    assert_eq!(escalate(&w, &task, 4).await["outcome"], "escalated");
}

#[tokio::test]
#[ignore = "needs AIR-081"]
async fn locked_agent_pending_items_stay_approvable() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": 5,
            "pending_ttl_ms": "3600000",
            "hourly_escalation_budget": 100,
            "lock_consecutive_rejects": 3,
            "lock_rejects_per_day": 20,
            "max_task_ttl_ms": "3600000",
            "max_task_actions": 20
        } }),
    )
    .await;
    let task = flood_task(&w);
    let mut numbers = Vec::new();
    for i in 0..4u8 {
        numbers.push(pending_id_of(&escalate(&w, &task, i).await).await);
    }
    for no in &numbers[..3] {
        reject(&w, no).await;
    }
    assert_eq!(state_of(&w).await["locked"], true);
    // the fourth is still pending: a lock refuses new escalations only
    approve(&w, &numbers[3]).await;
    assert_blocked(&escalate(&w, &task, 4).await, "EscalationsLocked");
}

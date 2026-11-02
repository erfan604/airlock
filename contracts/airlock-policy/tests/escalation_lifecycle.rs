// AIR-081: `reject`, `expire` and `reset_escalations` in the sandbox. Every refusal assertion checks the revert text, because a missing
// method fails too and a bare "it failed" would pass on nothing.
//
// The TTL tests call `set_flags` with `pending_ttl_ms` 1 (the flag minimum), escalate, and wait 3 s: sandbox blocks come about every
// 1.5 s, so the block of the next call is past the expiry. The sandbox clock is real time and a test never crosses a UTC boundary on
// purpose: every test that reads a day or hour counter starts with `ensure_day_window` and `ensure_hour_window`.
// Run with `-- --test-threads=4` (each sandbox is a neard of several hundred MB).
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::request::request_id;
use airlock_policy::task::task_hash;
use common::*;
use near_api::{NearToken, Signer};
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

/// At most this many sandboxes of this file run at once (a neard is several hundred MB and a deploy times out when too many start
/// together; see tests/owner_plane.rs).
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

type Who = (near_api::AccountId, Arc<Signer>);

const NOT_OWNER: &str = "Caller is not the owner";
const ONE_YOCTO_TEXT: &str = "Requires attached deposit of exactly 1 yoctoNEAR";

/// A flood world with the windows a counter test needs, and the task of `flood_task`.
async fn start_world() -> (World, Task) {
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    ensure_day_window(&w, 180_000).await;
    let task = flood_task(&w);
    (w, task)
}

fn owner_of(w: &World) -> Who {
    (w.owner.clone(), w.owner_signer.clone())
}

fn agent_of(w: &World) -> Who {
    (w.agent.clone(), w.agent_signer.clone())
}

async fn stranger_of(w: &World) -> Who {
    create_user_account(&w.net, &w.root, &w.owner_signer, "stranger")
        .await
        .expect("the stranger account is created")
}

/// A call of the policy contract with an explicit deposit in yoctoNEAR; a failed receipt is not an error, inspect `failure_text`.
async fn call(
    w: &World,
    who: &Who,
    method: &str,
    args: Value,
    yocto: u128,
) -> ExecutionFinalResult {
    call_transaction(
        &w.policy,
        method,
        args,
        &who.0,
        &who.1,
        &w.net,
        Some(NearToken::from_yoctonear(yocto)),
    )
    .await
    .unwrap_or_else(|e| panic!("{method} is not sent: {e}"))
}

/// The call must fail and its failure text must contain `want`.
fn assert_fails(result: &ExecutionFinalResult, want: &str) {
    let text = failure_text(result);
    assert!(text.contains(want), "wanted `{want}` in: {text}");
}

fn assert_ok(result: &ExecutionFinalResult, what: &str) {
    let text = failure_text(result);
    assert!(text.is_empty(), "{what} failed: {text}");
}

async fn view(w: &World, method: &str, args: Value) -> Value {
    call_view::<Value>(&w.policy, method, args, &w.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
        .data
}

async fn state_of(w: &World) -> Value {
    view(w, "get_escalation_state", json!({ "agent": w.agent })).await
}

async fn pending_list(w: &World) -> Vec<Value> {
    view(w, "get_pending", json!({}))
        .await
        .as_array()
        .expect("get_pending is an array")
        .clone()
}

/// `set_flags` with the defaults except the three that vary and the pending limit.
async fn set_flags(w: &World, max_pending: u32, ttl_ms: u64) {
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": max_pending,
            "pending_ttl_ms": ttl_ms.to_string(),
            "hourly_escalation_budget": 100,
            "lock_consecutive_rejects": 3,
            "lock_rejects_per_day": 20,
            "max_task_ttl_ms": "3600000",
            "max_task_actions": 20
        } }),
    )
    .await;
}

/// Escalates request `index` and returns its pending number.
async fn escalate_no(w: &World, task: &Task, index: u8) -> String {
    let out = escalate(w, task, index).await;
    assert_eq!(out["outcome"], "escalated", "{out}");
    pending_id_of(&out).await
}

fn id_of(task: &Task, index: u8) -> String {
    request_id(&task_hash(&task.0), index)
}

/// The `approve` arguments of the pending item `no`: the six strings of its stored card.
async fn card_of(w: &World, no: &str) -> Value {
    let found = pending_list(w).await;
    let item = found
        .iter()
        .find(|v| v["id"] == no)
        .unwrap_or_else(|| panic!("pending {no} is not in {found:?}"));
    json!({
        "id": no,
        "to": item["payee"],
        "asset": item["display"]["asset_symbol"],
        "amount": item["display"]["amount_decimal"],
        "why": item["reason"],
        "book": item["book_status"]
    })
}

async fn approve_ok(w: &World, no: &str) {
    let card = card_of(w, no).await;
    let r = call(w, &owner_of(w), "approve", card, 1).await;
    assert_ok(&r, "approve");
}

async fn reject_as(w: &World, who: &Who, no: &str, yocto: u128) -> ExecutionFinalResult {
    call(w, who, "reject", json!({ "id": no }), yocto).await
}

async fn reject_ok(w: &World, no: &str) {
    let r = reject_as(w, &owner_of(w), no, 1).await;
    assert_ok(&r, "reject");
}

async fn expire_as(w: &World, who: &Who, no: &str, yocto: u128) -> ExecutionFinalResult {
    call(w, who, "expire", json!({ "id": no }), yocto).await
}

async fn wait_past_ttl() {
    tokio::time::sleep(Duration::from_secs(3)).await;
}

/// The same request as `escalate` at `index` with a given amount, keeping the whole result.
async fn resubmit(w: &World, task: &Task, index: u8, amount: u128) -> ExecutionFinalResult {
    let req = w.request_json(
        &task.0,
        index,
        "near",
        "near:alice.sandbox",
        amount,
        (2, 32, 1),
        None,
    );
    w.submit(vec![req], task).await
}

#[tokio::test]
async fn reject_marks_rejected_and_keeps_the_record() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    let no = escalate_no(&w, &task, 0).await;
    reject_ok(&w, &no).await;
    let rec = w.request(&id_of(&task, 0)).await.expect("the record stays");
    assert_eq!(rec["state"], "Rejected", "{rec}");
    assert_eq!(rec["payee"], "near:alice.sandbox", "{rec}");
    assert_eq!(rec["amount"], (2 * U).to_string(), "{rec}");
    assert_eq!(rec["id"], no.as_str(), "{rec}");
    // the number still resolves, and the list of pending escalations no longer holds it
    let by_number = w.request(&no).await.expect("the number resolves");
    assert_eq!(by_number["state"], "Rejected", "{by_number}");
    assert!(
        pending_list(&w)
            .await
            .iter()
            .all(|v| v["id"] != no.as_str())
    );
    assert_eq!(state_of(&w).await["pending"], 0);
}

#[tokio::test]
async fn reject_then_approve_reverts_not_pending() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    let no = escalate_no(&w, &task, 0).await;
    let card = card_of(&w, &no).await;
    reject_ok(&w, &no).await;
    let r = call(&w, &owner_of(&w), "approve", card, 1).await;
    assert_fails(&r, "approve rejected: NotPending");
}

#[tokio::test]
async fn approve_then_reject_reverts_not_pending() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    let no = escalate_no(&w, &task, 0).await;
    approve_ok(&w, &no).await;
    let r = reject_as(&w, &owner_of(&w), &no, 1).await;
    assert_fails(&r, "NotPending");
}

#[tokio::test]
async fn second_reject_reverts_not_pending() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    let no = escalate_no(&w, &task, 0).await;
    reject_ok(&w, &no).await;
    let r = reject_as(&w, &owner_of(&w), &no, 1).await;
    assert_fails(&r, "NotPending");
    // the second reject counted nothing
    assert_eq!(state_of(&w).await["consecutive_rejects"], 1);
}

#[tokio::test]
async fn reject_and_expire_unknown_or_noncanonical_id_revert() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    escalate_no(&w, &task, 0).await;
    for bad in ["999", "0", "007", "+1", ""] {
        let r = reject_as(&w, &owner_of(&w), bad, 1).await;
        assert_fails(&r, "unknown id");
        let r = expire_as(&w, &owner_of(&w), bad, 0).await;
        assert_fails(&r, "unknown id");
    }
}

#[tokio::test]
async fn reject_requires_owner_and_one_yocto() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    let no = escalate_no(&w, &task, 0).await;
    let stranger = stranger_of(&w).await;
    assert_fails(&reject_as(&w, &stranger, &no, 1).await, NOT_OWNER);
    assert_fails(&reject_as(&w, &agent_of(&w), &no, 1).await, NOT_OWNER);
    for deposit in [0u128, 2] {
        let r = reject_as(&w, &owner_of(&w), &no, deposit).await;
        assert_fails(&r, ONE_YOCTO_TEXT);
    }
    let rec = w.request(&id_of(&task, 0)).await.expect("a record");
    assert_eq!(rec["state"], "Pending", "{rec}");
    assert_eq!(state_of(&w).await["consecutive_rejects"], 0);
}

#[tokio::test]
async fn rejected_id_stays_used() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    let no = escalate_no(&w, &task, 0).await;
    reject_ok(&w, &no).await;
    let same = resubmit(&w, &task, 0, 2 * U).await;
    assert_fails(&same, "request_id already used (UsedRequestId)");
    let changed = resubmit(&w, &task, 0, 3 * U).await;
    assert_fails(&changed, "request mismatch");
}

#[tokio::test]
async fn reject_after_ttl_is_allowed_and_counts() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    set_flags(&w, 3, 1).await;
    let no = escalate_no(&w, &task, 0).await;
    wait_past_ttl().await;
    // nobody expired it: the owner may still reject it, and it counts
    reject_ok(&w, &no).await;
    let rec = w.request(&id_of(&task, 0)).await.expect("a record");
    assert_eq!(rec["state"], "Rejected", "{rec}");
    let s = state_of(&w).await;
    assert_eq!(s["rejects_today"], 1, "{s}");
    assert_eq!(s["consecutive_rejects"], 1, "{s}");
    assert_eq!(s["pending"], 0, "{s}");
}

#[tokio::test]
async fn expire_before_ttl_reverts() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    let no = escalate_no(&w, &task, 0).await;
    let r = expire_as(&w, &owner_of(&w), &no, 0).await;
    assert_fails(&r, "not expired yet");
    let rec = w.request(&id_of(&task, 0)).await.expect("a record");
    assert_eq!(rec["state"], "Pending", "{rec}");
    assert_eq!(state_of(&w).await["pending"], 1);
}

#[tokio::test]
async fn expire_after_ttl_leaves_a_tombstone() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    set_flags(&w, 3, 1).await;
    let no = escalate_no(&w, &task, 0).await;
    assert_eq!(state_of(&w).await["pending"], 1);
    wait_past_ttl().await;
    let stranger = stranger_of(&w).await;
    assert_ok(&expire_as(&w, &stranger, &no, 0).await, "expire");
    let rec = w.request(&id_of(&task, 0)).await.expect("the tombstone");
    assert_eq!(rec["state"], "Expired", "{rec}");
    let mut keys: Vec<&str> = rec
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["id", "request_id", "state"], "{rec}");
    assert_eq!(rec["id"], no.as_str(), "{rec}");
    assert_eq!(rec["request_id"], id_of(&task, 0).as_str(), "{rec}");
    assert!(
        pending_list(&w)
            .await
            .iter()
            .all(|v| v["id"] != no.as_str())
    );
    assert_eq!(state_of(&w).await["pending"], 0);
    // the id stays used: the same content reverts UsedRequestId, other content request mismatch
    let same = resubmit(&w, &task, 0, 2 * U).await;
    assert_fails(&same, "request_id already used (UsedRequestId)");
    let changed = resubmit(&w, &task, 0, 3 * U).await;
    assert_fails(&changed, "request mismatch");
}

#[tokio::test]
async fn expire_by_a_stranger_works_and_reject_by_a_stranger_does_not() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    set_flags(&w, 3, 1).await;
    let no = escalate_no(&w, &task, 0).await;
    wait_past_ttl().await;
    let stranger = stranger_of(&w).await;
    assert_fails(&reject_as(&w, &stranger, &no, 1).await, NOT_OWNER);
    let r = expire_as(&w, &stranger, &no, 0).await;
    assert_ok(&r, "expire by a stranger");
    let rec = w.request(&id_of(&task, 0)).await.expect("a record");
    assert_eq!(rec["state"], "Expired", "{rec}");
    // the agent itself may expire its own request too
    let second = escalate_no(&w, &task, 1).await;
    wait_past_ttl().await;
    assert_ok(
        &expire_as(&w, &agent_of(&w), &second, 0).await,
        "expire by the agent",
    );
}

#[tokio::test]
async fn expire_with_a_deposit_reverts() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    set_flags(&w, 3, 1).await;
    let no = escalate_no(&w, &task, 0).await;
    wait_past_ttl().await;
    let stranger = stranger_of(&w).await;
    let r = expire_as(&w, &stranger, &no, 1).await;
    assert_fails(&r, "doesn't accept deposit");
    let rec = w.request(&id_of(&task, 0)).await.expect("a record");
    assert_eq!(rec["state"], "Pending", "{rec}");
}

#[tokio::test]
async fn expire_then_approve_or_reject_reverts_not_pending() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    set_flags(&w, 3, 1).await;
    let no = escalate_no(&w, &task, 0).await;
    let card = card_of(&w, &no).await;
    wait_past_ttl().await;
    assert_ok(&expire_as(&w, &owner_of(&w), &no, 0).await, "expire");
    let r = call(&w, &owner_of(&w), "approve", card, 1).await;
    assert_fails(&r, "approve rejected: NotPending");
    let r = reject_as(&w, &owner_of(&w), &no, 1).await;
    assert_fails(&r, "NotPending");
    // a second expire says the same
    assert_fails(&expire_as(&w, &owner_of(&w), &no, 0).await, "NotPending");
}

#[tokio::test]
async fn reset_escalations_requires_owner_and_one_yocto() {
    let _slot = slot().await;
    let (w, _task) = start_world().await;
    let args = json!({ "agent": w.agent });
    let stranger = stranger_of(&w).await;
    let r = call(&w, &stranger, "reset_escalations", args.clone(), 1).await;
    assert_fails(&r, NOT_OWNER);
    let r = call(&w, &agent_of(&w), "reset_escalations", args.clone(), 1).await;
    assert_fails(&r, NOT_OWNER);
    for deposit in [0u128, 2] {
        let r = call(
            &w,
            &owner_of(&w),
            "reset_escalations",
            args.clone(),
            deposit,
        )
        .await;
        assert_fails(&r, ONE_YOCTO_TEXT);
    }
}

#[tokio::test]
async fn reset_escalations_for_unknown_agent_succeeds_and_emits() {
    let _slot = slot().await;
    let (w, _task) = start_world().await;
    let r = call(
        &w,
        &owner_of(&w),
        "reset_escalations",
        json!({ "agent": "nobody.sandbox" }),
        1,
    )
    .await;
    assert_ok(&r, "reset_escalations");
    let emitted = events(&r, "escalations_reset");
    assert_eq!(emitted, [json!({ "agent": "nobody.sandbox" })]);
    let s = view(
        &w,
        "get_escalation_state",
        json!({ "agent": "nobody.sandbox" }),
    )
    .await;
    assert_eq!(s["locked"], false, "{s}");
    assert_eq!(s["pending"], 0, "{s}");
}

/// The names of the events of `r`, in log order.
fn event_names(r: &ExecutionFinalResult) -> Vec<String> {
    extract_event_logs(r)
        .expect("the events parse")
        .iter()
        .map(|e| e["event"].as_str().expect("an event name").to_string())
        .collect()
}

fn assert_envelope(r: &ExecutionFinalResult) {
    for e in extract_event_logs(r).expect("the events parse") {
        assert_eq!(e["standard"], "airlock", "{e}");
        assert_eq!(e["data"].as_array().map(Vec::len), Some(1), "{e}");
    }
}

fn is_canonical_decimal(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.parse::<u32>().is_ok_and(|n| n.to_string() == s))
}

#[tokio::test]
async fn events_have_the_documented_shapes() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    // a TTL of 1 ms lets the same world reject past the TTL and expire; room for four pending escalations
    set_flags(&w, 5, 1).await;
    let mut numbers = Vec::new();
    for i in 0..4u8 {
        numbers.push(escalate_no(&w, &task, i).await);
    }
    wait_past_ttl().await;
    let agent = w.agent.to_string();
    for (i, no) in numbers.iter().take(3).enumerate() {
        let r = reject_as(&w, &owner_of(&w), no, 1).await;
        assert_ok(&r, "reject");
        assert_envelope(&r);
        let rejected = events(&r, "rejected");
        assert_eq!(rejected.len(), 1, "{rejected:?}");
        assert_eq!(
            rejected[0],
            json!({ "request_id": id_of(&task, u8::try_from(i).unwrap()), "id": no })
        );
        assert!(is_canonical_decimal(&rejected[0]["id"]));
        let locked = events(&r, "escalations_locked");
        if i < 2 {
            assert!(locked.is_empty(), "{locked:?}");
            continue;
        }
        // the third reject locks: `rejected` comes first, then `escalations_locked` with the counters after the reject
        assert_eq!(locked.len(), 1, "{locked:?}");
        assert_eq!(locked[0]["agent"], agent.as_str());
        assert_eq!(locked[0]["consecutive"], 3);
        assert_eq!(locked[0]["today"], 3);
        assert!(locked[0]["consecutive"].is_u64() && locked[0]["today"].is_u64());
        let names = event_names(&r);
        let at = |n: &str| names.iter().position(|x| x == n).expect("emitted");
        assert!(at("rejected") < at("escalations_locked"), "{names:?}");
    }
    let stranger = stranger_of(&w).await;
    let r = expire_as(&w, &stranger, &numbers[3], 0).await;
    assert_ok(&r, "expire");
    assert_envelope(&r);
    let expired = events(&r, "expired");
    assert_eq!(
        expired,
        [json!({ "request_id": id_of(&task, 3), "id": numbers[3] })]
    );
    assert!(is_canonical_decimal(&expired[0]["id"]));
    let r = call(
        &w,
        &owner_of(&w),
        "reset_escalations",
        json!({ "agent": w.agent }),
        1,
    )
    .await;
    assert_ok(&r, "reset_escalations");
    assert_envelope(&r);
    assert_eq!(events(&r, "escalations_reset"), [json!({ "agent": agent })]);
}

#[tokio::test]
async fn methods_are_exported() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    set_flags(&w, 3, 1).await;
    let first = escalate_no(&w, &task, 0).await;
    let second = escalate_no(&w, &task, 1).await;
    wait_past_ttl().await;
    assert_ok(&reject_as(&w, &owner_of(&w), &first, 1).await, "reject");
    let r = call(
        &w,
        &owner_of(&w),
        "reset_escalations",
        json!({ "agent": w.agent }),
        1,
    )
    .await;
    assert_ok(&r, "reset_escalations");
    let stranger = stranger_of(&w).await;
    assert_ok(&expire_as(&w, &stranger, &second, 0).await, "expire");
    let exports = wasm_exports();
    for name in ["reject", "expire", "reset_escalations"] {
        assert!(exports.iter().any(|e| e == name), "{name} is not exported");
    }
    // the helpers are plain methods or free functions, never entry points
    for name in ["canonical_no", "expire_tombstone", "resolve_escalation"] {
        assert!(!exports.iter().any(|e| e == name), "{name} is exported");
    }
}

/// The coordinator's gate on AIR-083: an agent at its pending limit whose escalations all passed their TTL is refused `PendingFull`
/// until they are expired, and is admitted again afterwards.
#[tokio::test]
async fn slots_come_back_after_the_expired_escalations_are_expired() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    set_flags(&w, 3, 1).await;
    let mut numbers = Vec::new();
    for i in 0..3u8 {
        numbers.push(escalate_no(&w, &task, i).await);
    }
    wait_past_ttl().await;
    let blocked = escalate(&w, &task, 3).await;
    assert_eq!(blocked["outcome"], "blocked", "{blocked}");
    assert_eq!(blocked["reason"], "PendingFull", "{blocked}");
    let stranger = stranger_of(&w).await;
    for no in &numbers {
        assert_ok(&expire_as(&w, &stranger, no, 0).await, "expire");
    }
    assert_eq!(state_of(&w).await["pending"], 0);
    let admitted = escalate(&w, &task, 4).await;
    assert_eq!(admitted["outcome"], "escalated", "{admitted}");
    assert_eq!(state_of(&w).await["pending"], 1);
}

/// `approve` meets a record past its TTL: it reverts `Expired` and changes nothing, so the slot is still taken until `expire` runs;
/// then the slot comes back.
#[tokio::test]
async fn approve_past_ttl_reverts_expired_and_expire_frees_the_slot() {
    let _slot = slot().await;
    let (w, task) = start_world().await;
    set_flags(&w, 3, 1).await;
    let mut numbers = Vec::new();
    for i in 0..3u8 {
        numbers.push(escalate_no(&w, &task, i).await);
    }
    let card = card_of(&w, &numbers[0]).await;
    wait_past_ttl().await;
    let r = call(&w, &owner_of(&w), "approve", card, 1).await;
    assert_fails(&r, "approve rejected: Expired");
    let rec = w.request(&id_of(&task, 0)).await.expect("a record");
    assert_eq!(rec["state"], "Pending", "{rec}");
    assert_eq!(state_of(&w).await["pending"], 3);
    let blocked = escalate(&w, &task, 3).await;
    assert_eq!(blocked["reason"], "PendingFull", "{blocked}");
    assert_ok(
        &expire_as(&w, &owner_of(&w), &numbers[0], 0).await,
        "expire",
    );
    assert_eq!(state_of(&w).await["pending"], 2);
    let admitted = escalate(&w, &task, 4).await;
    assert_eq!(admitted["outcome"], "escalated", "{admitted}");
}

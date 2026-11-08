// AIR-106: idempotency and replay in the sandbox. A lost response, a replayed id, a runtime-chosen nonce and a display-name collision
// cannot cause a second payment or a payment to the wrong key. The runtime's rule is: read `get_request`, never resubmit blindly; a
// resubmission of an id the contract already knows returns the stored outcome (the replay table of AIR-061) or runs the one allowed
// retry (AIR-105, SPEC R5-07). Every test uses `world()` of tests/common: EVM payee `0xd8da6bf2...6045` on path `base-sepolia-1`, nonce
// 0, the mock MPC in `ok` mode unless a test says otherwise.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::request::request_id;
use airlock_policy::task::task_hash;
use common::*;
use near_api::{
    Contract, NearGas, Tokens, advanced::TransactionableOrSigned, types::TxExecutionStatus,
};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use serde_json::{Value, json};
use std::time::Duration;

const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;

const GWEI: u128 = 1_000_000_000;
const EVM: (u128, u128, u128) = (21_000, 2 * GWEI, GWEI);
const AMOUNT: u128 = 10_000_000_000_000_000; // 10^16 wei

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
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

fn payee_key(w: &World) -> String {
    format!("evm:84532:0x{}", w.payee_evm)
}

fn task_of(w: &World, max_actions: u8) -> Task {
    w.signed_task(&[(&payee_key(w), ONE_ETH)], max_actions)
}

fn clean(w: &World, task: &Task, index: u8, amount: u128) -> Value {
    w.request_json(
        &task.0,
        index,
        WORLD_EVM_ASSET,
        &payee_key(w),
        amount,
        (BOOK, OWNER, OWNER),
        Some(EVM),
    )
}

fn id_of(task: &Task, index: u8) -> String {
    request_id(&task_hash(&task.0), index)
}

/// A submit that must succeed as a transaction: its result.
async fn submit_ok(w: &World, reqs: Vec<Value>, task: &Task) -> ExecutionFinalResult {
    let result = w.submit(reqs, task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    result
}

/// A submit whose only failed receipt is the signer's own (the mock's `fail` mode): the transaction itself succeeded.
async fn submit_mpc_failure(w: &World, reqs: Vec<Value>, task: &Task) -> ExecutionFinalResult {
    let result = w.submit(reqs, task).await;
    for outcome in result.failures() {
        assert_eq!(
            outcome.executor_id, w.mpc,
            "unexpected failure: {outcome:?}"
        );
    }
    result
}

fn outcomes(r: &ExecutionFinalResult) -> Value {
    r.clone().json().expect("the outcomes parse")
}

fn names(r: &ExecutionFinalResult) -> Vec<String> {
    extract_event_logs(r)
        .expect("the events parse")
        .iter()
        .map(|e| e["event"].as_str().unwrap_or_default().to_string())
        .collect()
}

/// `data[0]` of the one event of this name in `r`.
fn one_event(r: &ExecutionFinalResult, name: &str) -> Value {
    let found = events(r, name);
    assert_eq!(found.len(), 1, "exactly one `{name}` event: {found:?}");
    found[0].clone()
}

async fn view(w: &World, contract: &near_api::AccountId, method: &str, args: Value) -> Value {
    call_view::<Value>(contract, method, args, &w.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
        .data
}

async fn nonce_of(w: &World) -> Value {
    view(w, &w.policy, "get_nonce", json!({ "path": WORLD_EVM_PATH })).await
}

async fn ledgers_of(w: &World) -> Value {
    w.ledgers(&payee_key(w), WORLD_EVM_ASSET).await
}

async fn mock_calls(w: &World) -> u64 {
    view(w, &w.mpc, "call_count", json!({}))
        .await
        .as_u64()
        .expect("a count")
}

async fn state_of(w: &World, id: &str) -> String {
    w.request(id).await.expect("the request exists")["state"]
        .as_str()
        .expect("a state")
        .to_string()
}

/// `get_ledgers` of the EVM payee under one task: `task_spent` as a number.
async fn task_spent(w: &World, task: &Task) -> u128 {
    let v = view(
        w,
        &w.policy,
        "get_ledgers",
        json!({
            "payee": payee_key(w),
            "asset": WORLD_EVM_ASSET,
            "task": hex::encode(task_hash(&task.0))
        }),
    )
    .await;
    v["task_spent"]
        .as_str()
        .unwrap_or_else(|| panic!("no task_spent in {v}"))
        .parse()
        .expect("a decimal")
}

/// The `to` field of an unsigned EIP-1559 hex, as lowercase hex (field 5 of the RLP list, a 20-byte string).
fn to_in(hex_text: &str) -> String {
    let bytes = hex::decode(hex_text).expect("lowercase hex");
    assert_eq!(bytes[0], 0x02, "an EIP-1559 payload starts with 02");
    let mut rest = &bytes[1..];
    // skip the list header
    let hdr = if rest[0] >= 0xf8 {
        1 + usize::from(rest[0] - 0xf7)
    } else {
        1
    };
    rest = &rest[hdr..];
    for field in 0..6 {
        let b0 = rest[0];
        let (hdr, len) = match b0 {
            0x00..=0x7f => (0, 1),
            0x80..=0xb7 => (1, usize::from(b0 - 0x80)),
            0xb8..=0xbf => {
                let ll = usize::from(b0 - 0xb7);
                let len = rest[1..=ll]
                    .iter()
                    .fold(0usize, |a, x| (a << 8) | usize::from(*x));
                (1 + ll, len)
            }
            _ => panic!("a list inside the fields"),
        };
        if field == 5 {
            return hex::encode(&rest[hdr..hdr + len]);
        }
        rest = &rest[hdr + len..];
    }
    unreachable!()
}

fn nonce_in(hex_text: &str) -> u128 {
    // field 1: chain id is 3 bytes (0x83 prefix) for 84532, nonce follows; read it with the same walk as `to_in`
    let bytes = hex::decode(hex_text).expect("lowercase hex");
    let mut rest = &bytes[1..];
    let hdr = if rest[0] >= 0xf8 {
        1 + usize::from(rest[0] - 0xf7)
    } else {
        1
    };
    rest = &rest[hdr..];
    let mut fields = Vec::new();
    for _ in 0..2 {
        let b0 = rest[0];
        let (hdr, len) = match b0 {
            0x00..=0x7f => (0, 1),
            0x80..=0xb7 => (1, usize::from(b0 - 0x80)),
            _ => panic!("unexpected long field"),
        };
        fields.push(rest[hdr..hdr + len].to_vec());
        rest = &rest[hdr + len..];
    }
    // an RLP zero is the empty string (0x80)
    fields[1]
        .iter()
        .fold(0u128, |a, x| (a << 8) | u128::from(*x))
}

/// Submits `reqs` with `wait_until(Included)` and returns the transaction hash once the sign request is parked in the mock (`mpc_parked`
/// is `parked_before + 1` and the request `id` is `Executing`). Needs the mock in `yield` mode.
async fn submit_parked(w: &World, reqs: Vec<Value>, task: &Task, id: &str, parked_before: u64) {
    let ex = Contract(w.policy.clone())
        .call_function(
            "submit_batch",
            common::shim_args(
                &w.policy,
                &w.net,
                "submit_batch",
                json!({ "reqs": reqs, "task": task.0, "task_sig": task.1 }),
            ),
        )
        .transaction()
        .gas(NearGas::from_tgas(300))
        .with_signer(w.agent.clone(), w.agent_signer.clone())
        .wait_until(TxExecutionStatus::Included)
        .presign_with(&w.net)
        .await
        .expect("the transaction is signed");
    assert!(
        matches!(&ex.transaction, TransactionableOrSigned::Signed(_)),
        "presign_with signs"
    );
    let pending = ex.send_to(&w.net).await.expect("the transaction is sent");
    assert!(matches!(pending, TransactionResult::Pending { .. }));
    for _ in 0..100 {
        let executing = w
            .request(id)
            .await
            .is_some_and(|r| r["state"] == "Executing");
        if executing && w.mpc_parked().await == parked_before + 1 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("the request never reached Executing with one more parked sign");
}

/// Fast-forwards 200 blocks (the signer's timeout). `false` after printing the SKIP line when the sandbox cannot.
async fn fast_forward_200(w: &World) -> bool {
    match tokio::time::timeout(Duration::from_secs(30), w.sandbox.fast_forward(200)).await {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            println!("SKIP yield timeout: fast_forward unavailable: {e:?}");
            false
        }
        Err(_) => panic!("fast_forward(200) hung for 30 s"),
    }
}

async fn wait_for_state(w: &World, id: &str, want: &str) {
    let mut state = String::new();
    for _ in 0..300 {
        state = state_of(w, id).await;
        if state == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("state of {id} is {state}, wanted {want}");
}

// ---- lost response ----------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn lost_response_retry() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 300_000).await;
    let task = task_of(&w, 3);
    let id = id_of(&task, 0);
    let first = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    // the response is discarded: the runtime reads the chain instead
    drop(first);
    println!("mock call_count {}", mock_calls(&w).await);
    let stored = w.request(&id).await.expect("get_request answers: exists");
    assert_eq!(stored["state"], "Executed", "{stored}");
    let ledgers = ledgers_of(&w).await;
    let nonce = nonce_of(&w).await;
    assert_eq!(nonce, json!("1"));
    assert_eq!(mock_calls(&w).await, 1);

    let again = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let out = outcomes(&again);
    assert_eq!(out[0]["outcome"], "allowed", "{out}");
    assert_eq!(out[0]["request_id"], id.as_str(), "{out}");
    // `submitted` is the once-per-call batch event; a replay adds no request event
    assert_eq!(
        names(&again),
        ["submitted"],
        "a replay emits no request event"
    );
    println!("mock call_count {}", mock_calls(&w).await);
    assert_eq!(mock_calls(&w).await, 1, "one request, one signature");
    assert_eq!(ledgers_of(&w).await, ledgers);
    assert_eq!(nonce_of(&w).await, nonce);
    assert_eq!(state_of(&w, &id).await, "Executed");
}

// ---- replayed ids -----------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn replayed_request_id() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 300_000).await;
    let task = task_of(&w, 3);
    let id0 = id_of(&task, 0);
    let _ = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let ledgers = ledgers_of(&w).await;

    // the same index with other content: `request mismatch`
    let changed = w.submit(vec![clean(&w, &task, 0, AMOUNT + 1)], &task).await;
    let text = failure_text(&changed);
    assert!(text.contains("request mismatch"), "{text}");
    assert_eq!(ledgers_of(&w).await, ledgers);
    assert_eq!(mock_calls(&w).await, 1);

    // an Executed record replays as `allowed` and pays nothing again
    let replay = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let out = outcomes(&replay);
    assert_eq!(out[0]["outcome"], "allowed", "{out}");
    assert_eq!(out[0]["request_id"], id0.as_str(), "{out}");
    assert_eq!(mock_calls(&w).await, 1);
    assert_eq!(ledgers_of(&w).await, ledgers);

    // a Failed record (an answer the contract cannot use is final, D17) reverts UsedRequestId
    let id1 = id_of(&task, 1);
    w.set_mpc_mode("garbage").await;
    let failed = submit_ok(&w, vec![clean(&w, &task, 1, AMOUNT)], &task).await;
    assert_eq!(one_event(&failed, "failed")["retryable"], false);
    assert_eq!(state_of(&w, &id1).await, "Failed");
    w.set_mpc_mode("ok").await;
    let calls = mock_calls(&w).await;
    let used = w.submit(vec![clean(&w, &task, 1, AMOUNT)], &task).await;
    let text = failure_text(&used);
    assert!(
        text.contains("request_id already used (UsedRequestId)"),
        "{text}"
    );
    assert_eq!(mock_calls(&w).await, calls);
    // other content under a Failed id is still a mismatch, not a second chance
    let other = w.submit(vec![clean(&w, &task, 1, AMOUNT + 1)], &task).await;
    assert!(
        failure_text(&other).contains("request mismatch"),
        "{}",
        failure_text(&other)
    );
}

// ---- the runtime cannot pick a nonce ----------------------------------------------------------------------------------------

#[tokio::test]
async fn runtime_cannot_pick_a_nonce() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);

    // the request type has no nonce or path field anywhere: a request that carries them survives a round trip without them
    let mut req = clean(&w, &task, 0, AMOUNT);
    req["path"] = json!("attacker-path");
    req["nonce"] = json!(99);
    req["evm"]["path"] = json!("attacker-path");
    req["evm"]["nonce"] = json!(99);
    let parsed: airlock_policy::request::SubmitRequest =
        serde_json::from_value(req.clone()).expect("unknown fields are ignored");
    let round = serde_json::to_value(&parsed).expect("serializes");
    let mut keys: Vec<&str> = round
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "action_index",
            "amount",
            "asset",
            "book",
            "evm",
            "hints",
            "labels",
            "payee",
            "task_id"
        ],
        "{round}"
    );
    let text = round.to_string();
    assert!(
        !text.contains("nonce") && !text.contains("path") && !text.contains("attacker"),
        "{text}"
    );

    // on chain: the contract nonce and the registry path are used
    let result = submit_ok(&w, vec![req], &task).await;
    let hex_text = one_event(&result, "evm_unsigned")["unsigned_hex"]
        .as_str()
        .expect("hex")
        .to_string();
    assert_eq!(nonce_in(&hex_text), 0);
    let last = view(&w, &w.mpc, "last_request", json!({})).await;
    assert_eq!(last["path"], WORLD_EVM_PATH, "{last}");

    // two requests on one path get consecutive nonces
    let second = submit_ok(&w, vec![clean(&w, &task, 1, AMOUNT)], &task).await;
    let hex2 = one_event(&second, "evm_unsigned")["unsigned_hex"]
        .as_str()
        .expect("hex")
        .to_string();
    assert_eq!(nonce_in(&hex2), 1);
    assert_eq!(nonce_of(&w).await, json!("2"));
}

// ---- display-name collision -------------------------------------------------------------------------------------------------

#[tokio::test]
async fn display_name_collision() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 300_000).await;
    let other = "1111111111111111111111111111111111111111";
    let other_key = format!("evm:84532:0x{other}");
    // the same label as the world's EVM payee, a different key
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "book_add",
        json!({
            "key": other_key,
            "cap": null,
            "daily_untrusted_budget": "0",
            "daily_limit": (10 * ONE_ETH).to_string(),
            "label": "Base Sepolia payee"
        }),
    )
    .await;
    let task = w.signed_task(&[(&payee_key(&w), ONE_ETH), (&other_key, ONE_ETH)], 3);
    let to_first = clean(&w, &task, 0, AMOUNT);
    let to_other = w.request_json(
        &task.0,
        1,
        WORLD_EVM_ASSET,
        &other_key,
        AMOUNT,
        (BOOK, OWNER, OWNER),
        Some(EVM),
    );
    let result = submit_ok(&w, vec![to_first, to_other], &task).await;
    let unsigned = events(&result, "evm_unsigned");
    assert_eq!(unsigned.len(), 2, "{unsigned:?}");
    let by_id = |id: String| {
        unsigned
            .iter()
            .find(|e| e["request_id"] == id.as_str())
            .unwrap_or_else(|| panic!("no evm_unsigned for {id}"))["unsigned_hex"]
            .as_str()
            .expect("hex")
            .to_string()
    };
    let first_to = to_in(&by_id(id_of(&task, 0)));
    let other_to = to_in(&by_id(id_of(&task, 1)));
    assert_eq!(first_to, w.payee_evm, "request 0 goes to the typed key");
    assert_eq!(other_to, other, "request 1 goes to the typed key");
    assert_ne!(first_to, other_to);
}

// ---- retry once, then a new task --------------------------------------------------------------------------------------------

#[tokio::test]
async fn retry_once_then_new_task() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 300_000).await;
    let task = task_of(&w, 3);
    let id = id_of(&task, 0);
    let before = ledgers_of(&w).await;
    w.set_mpc_mode("fail").await;
    let first = submit_mpc_failure(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let hex_text = one_event(&first, "evm_unsigned")["unsigned_hex"].clone();
    assert_eq!(one_event(&first, "failed")["retryable"], true);
    assert_eq!(state_of(&w, &id).await, "Retryable");
    // the mock counts every call it receives: a `fail` call fails in a child receipt and is still counted (AIR-109 changed AIR-103's mock)
    assert_eq!(mock_calls(&w).await, 1);
    assert_eq!(nonce_of(&w).await, json!("1"));
    assert_eq!(ledgers_of(&w).await, before);

    // the retry re-runs the verdict, charges again and calls the MPC once more with the same bytes and the same nonce
    let second = submit_mpc_failure(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    assert_eq!(one_event(&second, "evm_unsigned")["unsigned_hex"], hex_text);
    let failed = one_event(&second, "failed");
    assert_eq!(failed["reason"], "MpcFailed");
    assert_eq!(failed["retryable"], false);
    assert_eq!(mock_calls(&w).await, 2);
    assert_eq!(nonce_of(&w).await, json!("1"));
    assert_eq!(state_of(&w, &id).await, "Failed");
    assert_eq!(ledgers_of(&w).await, before);

    // a third try with the same id is refused, even with the signer healthy again
    w.set_mpc_mode("ok").await;
    let third = w.submit(vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let text = failure_text(&third);
    assert!(
        text.contains("request_id already used (UsedRequestId)"),
        "{text}"
    );
    assert_eq!(mock_calls(&w).await, 2);

    // a new action index under the same task can try again
    let fresh = submit_ok(&w, vec![clean(&w, &task, 1, AMOUNT)], &task).await;
    assert_eq!(events(&fresh, "signed").len(), 1);
    assert_eq!(state_of(&w, &id_of(&task, 1)).await, "Executed");
    assert_eq!(mock_calls(&w).await, 3);
}

// ---- the timeout branch -----------------------------------------------------------------------------------------------------

#[tokio::test]
async fn retry_after_yield_timeout() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let id = id_of(&task, 0);
    w.set_mpc_mode("yield").await;
    let parked_before = w.mpc_parked().await;
    submit_parked(
        &w,
        vec![clean(&w, &task, 0, AMOUNT)],
        &task,
        &id,
        parked_before,
    )
    .await;
    assert_eq!(w.mpc_parked().await, 1);
    let calls = mock_calls(&w).await;
    assert_eq!(calls, 1);

    // in flight: an identical resubmit returns the stored outcome and signs nothing
    let again = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let out = outcomes(&again);
    assert_eq!(out[0]["outcome"], "allowed", "{out}");
    assert_eq!(names(&again), ["submitted"], "no request event");
    assert_eq!(w.mpc_parked().await, 1);
    assert_eq!(mock_calls(&w).await, 1);
    assert_eq!(nonce_of(&w).await, json!("1"));

    if !fast_forward_200(&w).await {
        return;
    }
    wait_for_state(&w, &id, "Retryable").await;
    assert_eq!(nonce_of(&w).await, json!("1"));
    let first_hex = {
        // the first attempt's bytes are on the record
        let rec = w.request(&id).await.expect("stored");
        rec["exec"]["unsigned_hex"].clone()
    };

    w.set_mpc_mode("ok").await;
    let retry = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let unsigned = one_event(&retry, "evm_unsigned")["unsigned_hex"].clone();
    if !first_hex.is_null() {
        assert_eq!(unsigned, first_hex);
    }
    assert_eq!(events(&retry, "signed").len(), 1);
    assert_eq!(nonce_in(unsigned.as_str().expect("hex")), 0);
    assert_eq!(nonce_of(&w).await, json!("1"));
    assert_eq!(state_of(&w, &id).await, "Executed");
}

// ---- expired escalations still answer ---------------------------------------------------------------------------------------

#[tokio::test]
async fn get_request_survives_expire() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    ensure_day_window(&w, 180_000).await;
    let task = flood_task(&w);
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": 3,
            "pending_ttl_ms": "1",
            "hourly_escalation_budget": 100,
            "lock_consecutive_rejects": 3,
            "lock_rejects_per_day": 20,
            "max_task_ttl_ms": "3600000",
            "max_task_actions": 20
        } }),
    )
    .await;
    let out = escalate(&w, &task, 0).await;
    let no = pending_id_of(&out).await;
    let id = request_id(&task_hash(&task.0), 0);
    assert_eq!(
        w.request(&id).await.expect("pending is visible")["state"],
        "Pending"
    );
    tokio::time::sleep(Duration::from_secs(3)).await;
    let expired = call_transaction(
        &w.policy,
        "expire",
        json!({ "id": no }),
        &w.agent,
        &w.agent_signer,
        &w.net,
        None,
    )
    .await
    .expect("expire is sent");
    let text = failure_text(&expired);
    assert!(text.is_empty(), "expire failed: {text}");
    // freed, but never "not submitted": by request id and by number
    let by_id = w.request(&id).await.expect("the tombstone answers");
    assert_eq!(by_id["state"], "Expired", "{by_id}");
    let by_no = w.request(&no).await.expect("the number answers");
    assert_eq!(by_no["state"], "Expired", "{by_no}");
}

// ---- audit map: duplicate inputs and the window of a pending sign -----------------------------------------------------------

#[tokio::test]
async fn duplicate_index_in_one_batch_signs_once() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 300_000).await;

    // EVM: two identical requests, both action_index 0
    let task = task_of(&w, 3);
    let calls = mock_calls(&w).await;
    let nonce_before = nonce_of(&w).await;
    assert_eq!(nonce_before, json!("0"));
    let both = vec![clean(&w, &task, 0, AMOUNT), clean(&w, &task, 0, AMOUNT)];
    let result = submit_ok(&w, both, &task).await;
    let out = outcomes(&result);
    assert_eq!(out.as_array().expect("two outcomes").len(), 2, "{out}");
    assert_eq!(out[0]["outcome"], "allowed", "{out}");
    assert_eq!(out[1]["outcome"], "allowed", "{out}");
    assert_eq!(out[0]["request_id"], out[1]["request_id"], "{out}");
    assert_eq!(events(&result, "allowed").len(), 1);
    assert_eq!(events(&result, "evm_unsigned").len(), 1);
    assert_eq!(events(&result, "signed").len(), 1);
    assert_eq!(mock_calls(&w).await, calls + 1);
    assert_eq!(nonce_of(&w).await, json!("1"));

    // NEAR: two identical requests pay once
    let payee = format!("near:{}", w.payee_near);
    let ntask = w.signed_task(&[(&payee, 10 * ONE_NEAR)], 3);
    let amount = 2 * ONE_NEAR;
    let req = |_: u8| {
        w.request_json(
            &ntask.0,
            0,
            "near",
            &payee,
            amount,
            (BOOK, OWNER, OWNER),
            None,
        )
    };
    let balance = |w: &World| {
        let (net, who) = (w.net.clone(), w.payee_near.clone());
        async move {
            Tokens::account(who)
                .near_balance()
                .fetch_from(&net)
                .await
                .expect("the balance is read")
                .total
                .as_yoctonear()
        }
    };
    let before = balance(&w).await;
    let result = submit_ok(&w, vec![req(0), req(1)], &ntask).await;
    let out = outcomes(&result);
    assert_eq!(out[0]["outcome"], "allowed", "{out}");
    assert_eq!(out[1]["outcome"], "allowed", "{out}");
    assert_eq!(out[0]["request_id"], out[1]["request_id"], "{out}");
    assert_eq!(events(&result, "paid").len(), 1);
    assert_eq!(balance(&w).await - before, amount);
}

#[tokio::test]
async fn charge_holds_while_sign_is_pending() {
    let _slot = slot().await;
    let w = world().await;
    ensure_day_window(&w, 300_000).await;
    let task = w.signed_task(&[(&payee_key(&w), AMOUNT)], 3);
    let id0 = id_of(&task, 0);
    let spent_before = task_spent(&w, &task).await;
    w.set_mpc_mode("yield").await;
    let parked_before = w.mpc_parked().await;
    submit_parked(
        &w,
        vec![clean(&w, &task, 0, AMOUNT)],
        &task,
        &id0,
        parked_before,
    )
    .await;
    assert_eq!(w.mpc_parked().await, parked_before + 1);

    // parked: the charge is on the ledgers, so one more wei under the same bound escalates
    assert_eq!(task_spent(&w, &task).await, spent_before + AMOUNT);
    let second = submit_ok(&w, vec![clean(&w, &task, 1, 1)], &task).await;
    let out = outcomes(&second);
    assert_eq!(out[0]["outcome"], "escalated", "{out}");
    assert_eq!(out[0]["reason"], "OverTaskBound", "{out}");
    assert_eq!(task_spent(&w, &task).await, spent_before + AMOUNT);

    if !fast_forward_200(&w).await {
        return;
    }
    wait_for_state(&w, &id0, "Retryable").await;
    assert_eq!(task_spent(&w, &task).await, spent_before);
}

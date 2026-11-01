// AIR-104: `set_nonce` and `get_nonce` in the sandbox. `next_nonce`, `attempt_of` and `record_attempt` are not exported methods, so
// the in-process tests of src/nonces.rs cover them; here every revert asserts its text, because a missing method also fails and
// would pass a bare `assert_failure()`.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, Data, NearToken, Signer};
use serde_json::{Value, json};
use std::sync::Arc;

const ONE_YOCTO_TEXT: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
const NOT_OWNER_TEXT: &str = "Caller is not the owner";
const EVM_ID: &str = "evm:84532:native";
const PATH: &str = "base-sepolia-1";

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

/// The EVM asset for `evm:84532:native` on path `base-sepolia-1` (the fixture of tests/registry.rs).
fn evm_entry() -> Value {
    json!({
        "symbol": "ETH.base",
        "decimals": 18,
        "hard_cap": "1000000000000000000",
        "daily_cap": "10000000000000000000",
        "max_fee_per_gas": "50000000000",
        "max_gas": "100000",
        "quick_task_cap": "5000000000000000000",
        "path": PATH
    })
}

/// A sandbox with the EVM asset registered, so `base-sepolia-1` is a known path.
async fn started() -> Started {
    let s = start().await;
    let result = owner_call(
        &s,
        "asset_set",
        json!({ "asset": EVM_ID, "entry": evm_entry() }),
    )
    .await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "asset_set failed: {text}");
    result.assert_success();
    s
}

async fn account(s: &Started, name: &str) -> (AccountId, Arc<Signer>) {
    create_user_account(&s.net, &s.owner, &s.owner_signer, name)
        .await
        .expect("the account is created")
}

async fn get_nonce(s: &Started, path: &str) -> Value {
    let answer: Data<Value> = call_view(&s.contract, "get_nonce", json!({ "path": path }), &s.net)
        .await
        .unwrap_or_else(|e| panic!("get_nonce must answer: {e:?}"));
    answer.data
}

/// `set_nonce(path, nonce)` as the owner with 1 yocto, which must succeed; the result is returned for its logs.
async fn set_ok(
    s: &Started,
    path: &str,
    nonce: &str,
) -> near_api_types::transaction::result::ExecutionFinalResult {
    let result = owner_call(s, "set_nonce", json!({ "path": path, "nonce": nonce })).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "set_nonce({path}, {nonce}) failed: {text}");
    assert!(result.is_success(), "set_nonce({path}, {nonce}) failed");
    result
}

/// `set_nonce(path, nonce)` as `who` with `deposit` yocto must revert with `text`.
async fn set_fails(
    s: &Started,
    who: &AccountId,
    signer: &Arc<Signer>,
    deposit: u128,
    path: &str,
    text: &str,
) {
    let result = call_transaction(
        &s.contract,
        "set_nonce",
        json!({ "path": path, "nonce": "5" }),
        who,
        signer,
        &s.net,
        Some(NearToken::from_yoctonear(deposit)),
    )
    .await
    .expect("the call is sent");
    let got = failure_text(&result);
    result.assert_failure();
    assert!(
        got.contains(text),
        "set_nonce as {who} with {deposit} yocto: expected `{text}` in: {got}"
    );
}

#[tokio::test]
async fn set_nonce_owner_sets_and_get_nonce_reflects() {
    let _slot = slot().await;
    let s = started().await;
    let _ = set_ok(&s, PATH, "7").await;
    // the view answers a decimal string
    assert_eq!(get_nonce(&s, PATH).await, json!("7"));
    // an upsert: the owner may raise it, lower it, and set a value above 2^53
    let _ = set_ok(&s, PATH, "9007199254740993").await;
    assert_eq!(get_nonce(&s, PATH).await, json!("9007199254740993"));
    let _ = set_ok(&s, PATH, "2").await;
    assert_eq!(get_nonce(&s, PATH).await, json!("2"));
}

#[tokio::test]
async fn set_nonce_unknown_path_reverts() {
    let _slot = slot().await;
    let s = started().await;
    set_fails(
        &s,
        &s.owner,
        &s.owner_signer,
        1,
        "no-such-path",
        "unknown path",
    )
    .await;
    assert_eq!(get_nonce(&s, "no-such-path").await, Value::Null);
}

#[tokio::test]
async fn set_nonce_stranger_reverts() {
    let _slot = slot().await;
    let s = started().await;
    let (stranger, stranger_signer) = account(&s, "stranger").await;
    set_fails(&s, &stranger, &stranger_signer, 1, PATH, NOT_OWNER_TEXT).await;
    assert_eq!(get_nonce(&s, PATH).await, Value::Null);
}

#[tokio::test]
async fn set_nonce_agent_reverts() {
    let _slot = slot().await;
    let s = started().await;
    let (agent, agent_signer) = account(&s, "agent").await;
    register_local_agent(
        &s.contract,
        &s.owner,
        &s.owner_signer,
        &agent,
        &agent_signer,
        &s.net,
    )
    .await;
    allow_agent_for(&s.contract, &s.owner, &s.owner_signer, &agent, &s.net).await;
    set_fails(&s, &agent, &agent_signer, 1, PATH, NOT_OWNER_TEXT).await;
    assert_eq!(get_nonce(&s, PATH).await, Value::Null);
}

#[tokio::test]
async fn set_nonce_no_deposit_reverts() {
    let _slot = slot().await;
    let s = started().await;
    set_fails(&s, &s.owner, &s.owner_signer, 0, PATH, ONE_YOCTO_TEXT).await;
    assert_eq!(get_nonce(&s, PATH).await, Value::Null);
}

#[tokio::test]
async fn set_nonce_two_yocto_reverts() {
    let _slot = slot().await;
    let s = started().await;
    set_fails(&s, &s.owner, &s.owner_signer, 2, PATH, ONE_YOCTO_TEXT).await;
    assert_eq!(get_nonce(&s, PATH).await, Value::Null);
}

#[tokio::test]
async fn get_nonce_unset_is_null() {
    let _slot = slot().await;
    let s = started().await;
    // a registered path that was never set, and a path that is not registered
    assert_eq!(get_nonce(&s, PATH).await, Value::Null);
    assert_eq!(get_nonce(&s, "no-such-path").await, Value::Null);
}

#[tokio::test]
async fn nonce_set_event_shape() {
    let _slot = slot().await;
    let s = started().await;
    let result = set_ok(&s, PATH, "42").await;
    let events = extract_event_logs(&result).unwrap();
    let event = events
        .iter()
        .find(|e| e["event"] == "nonce_set")
        .expect("a nonce_set event");
    assert_eq!(event["standard"], "airlock");
    assert_eq!(event["version"], "1.0.0");
    let data = &event["data"][0];
    assert_eq!(data["path"], PATH);
    assert!(
        data["nonce"].is_string(),
        "the nonce is a decimal string: {data}"
    );
    assert_eq!(data["nonce"], "42");
    let keys: Vec<&String> = data.as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 2, "exactly path and nonce: {data}");
}

/// `get_nonce` (view) and `set_nonce` (owner, one yocto) are exported and succeed: a method missing from the wasm fails here.
#[tokio::test]
async fn methods_are_exported() {
    let _slot = slot().await;
    let s = started().await;
    let result = owner_call(&s, "set_nonce", json!({ "path": PATH, "nonce": "1" })).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "set_nonce is not callable: {text}");
    result.assert_success();
    let answer: Data<Value> = call_view(&s.contract, "get_nonce", json!({ "path": PATH }), &s.net)
        .await
        .expect("get_nonce is exported and answers");
    assert_eq!(answer.data, json!("1"));
    assert!(
        wasm_exports().iter().any(|n| n == "set_nonce"),
        "the wasm exports set_nonce"
    );
    assert!(
        wasm_exports().iter().any(|n| n == "get_nonce"),
        "the wasm exports get_nonce"
    );
    for private in ["next_nonce", "attempt_of", "record_attempt"] {
        assert!(
            !wasm_exports().iter().any(|n| n == private),
            "{private} must not be exported"
        );
    }
}

// AIR-100: the EVM lane in the sandbox. An allowed or approved EVM payment is built as an EIP-1559 transaction inside the contract from
// the stored request, its keccak256 hash goes to the mock MPC signer, and the signature is stored and announced. A retry re-signs the
// identical bytes (one request id never becomes two transactions). Every test uses `world()` of tests/common: EVM payee `0xd8da6bf2...6045`
// on path `base-sepolia-1`, nonce 0, the mock MPC in `ok` mode unless a test says otherwise, task bound 1 ETH, labels Book, Owner, Owner,
// and `evm` params (21000, 2 gwei, 1 gwei).
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::request::request_id;
use airlock_policy::task::task_hash;
use common::*;
use near_api::{
    Contract, NearGas, NearToken, Transaction, advanced::TransactionableOrSigned,
    types::TxExecutionStatus,
};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};
use std::time::Duration;

const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
const EMAIL: u16 = airlock_verdict::labels::EMAIL;

const GWEI: u128 = 1_000_000_000;
const EVM: (u128, u128, u128) = (21_000, 2 * GWEI, GWEI);
const AMOUNT: u128 = 10_000_000_000_000_000; // 10^16 wei
const DAY1_HEX: &str = "02f183014a3480843b9aca00847735940082520894d8da6bf26964af9d7eed9e03e53415d37aa96045872386f26fc1000080c0";

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

fn req_with(w: &World, task: &Task, index: u8, amount: u128, labels: (u16, u16, u16)) -> Value {
    w.request_json(
        &task.0,
        index,
        WORLD_EVM_ASSET,
        &payee_key(w),
        amount,
        labels,
        Some(EVM),
    )
}

fn clean(w: &World, task: &Task, index: u8, amount: u128) -> Value {
    req_with(w, task, index, amount, (BOOK, OWNER, OWNER))
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

/// The event names of a result, in the order they were logged.
fn names(r: &ExecutionFinalResult) -> Vec<String> {
    extract_event_logs(r)
        .expect("the events parse")
        .iter()
        .map(|e| e["event"].as_str().unwrap_or_default().to_string())
        .collect()
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

// ---- a small RLP reader, so the tests do not trust the builder they check ----------------------------------------------------

/// The (is_list, payload) of the first item of `b` and the number of bytes it takes.
fn rlp_item(b: &[u8]) -> (bool, Vec<u8>, usize) {
    let b0 = b[0];
    let long = |base: u8| {
        let ll = usize::from(b0 - base);
        let len = b[1..=ll]
            .iter()
            .fold(0usize, |a, x| (a << 8) | usize::from(*x));
        (1 + ll, len)
    };
    match b0 {
        0x00..=0x7f => (false, vec![b0], 1),
        0x80..=0xb7 => {
            let len = usize::from(b0 - 0x80);
            (false, b[1..=len].to_vec(), 1 + len)
        }
        0xb8..=0xbf => {
            let (hdr, len) = long(0xb7);
            (false, b[hdr..hdr + len].to_vec(), hdr + len)
        }
        0xc0..=0xf7 => {
            let len = usize::from(b0 - 0xc0);
            (true, b[1..=len].to_vec(), 1 + len)
        }
        0xf8..=0xff => {
            let (hdr, len) = long(0xf7);
            (true, b[hdr..hdr + len].to_vec(), hdr + len)
        }
    }
}

/// The nine fields of an unsigned EIP-1559 transaction: chain id, nonce, tip, max fee, gas, to, value, data, access list.
fn decode_1559(hex_text: &str) -> Vec<(bool, Vec<u8>)> {
    let bytes = hex::decode(hex_text).expect("lowercase hex");
    assert_eq!(bytes[0], 0x02, "an EIP-1559 payload starts with 02");
    let (is_list, mut rest, used) = rlp_item(&bytes[1..]);
    assert!(is_list && used == bytes.len() - 1, "one RLP list");
    let mut items = Vec::new();
    while !rest.is_empty() {
        let (l, payload, n) = rlp_item(&rest);
        items.push((l, payload));
        rest = rest[n..].to_vec();
    }
    items
}

fn num(payload: &[u8]) -> u128 {
    payload.iter().fold(0u128, |a, x| (a << 8) | u128::from(*x))
}

fn nonce_in(hex_text: &str) -> u128 {
    num(&decode_1559(hex_text)[1].1)
}

/// `data[0]` of the one event of this name in `r`.
fn one_event(r: &ExecutionFinalResult, name: &str) -> Value {
    let found = events(r, name);
    assert_eq!(found.len(), 1, "exactly one `{name}` event: {found:?}");
    found[0].clone()
}

// ---- 1 to 3: the bytes ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn evm_allow_signs_certified_bytes() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    assert_eq!(
        names(&result),
        ["submitted", "allowed", "evm_unsigned", "signed"]
    );
    let unsigned = one_event(&result, "evm_unsigned");
    let signed = one_event(&result, "signed");
    let hex_text = unsigned["unsigned_hex"].as_str().expect("hex").to_string();
    assert_eq!(unsigned["request_id"], id_of(&task, 0).as_str());
    assert_eq!(signed["unsigned_hex"], hex_text.as_str());
    assert!(hex_text.starts_with("02"));
    let f = decode_1559(&hex_text);
    assert_eq!(f.len(), 9);
    assert_eq!(f[0].1, vec![0x01, 0x4a, 0x34], "chain id 84532");
    assert_eq!(num(&f[1].1), 0, "nonce 0");
    assert_eq!(num(&f[2].1), EVM.2, "max priority fee");
    assert_eq!(num(&f[3].1), EVM.1, "max fee");
    assert_eq!(num(&f[4].1), EVM.0, "gas limit");
    assert_eq!(hex::encode(&f[5].1), w.payee_evm, "to");
    assert_eq!(num(&f[6].1), AMOUNT, "value");
    assert!(!f[7].0 && f[7].1.is_empty(), "empty data");
    assert!(f[8].0 && f[8].1.is_empty(), "empty access list c0");
    let view_ = w.request(&id_of(&task, 0)).await.expect("stored");
    assert_eq!(view_["state"], "Executed");
    assert_eq!(view_["exec"]["unsigned_hex"], hex_text.as_str());
    assert_eq!(view_["exec"]["big_r"], signed["big_r"]);
    assert_eq!(view_["exec"]["s"], signed["s"]);
    println!("UNSIGNED_HEX={hex_text}");
}

#[tokio::test]
async fn evm_allow_matches_golden_preimage() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    assert_eq!(one_event(&result, "evm_unsigned")["unsigned_hex"], DAY1_HEX);
}

#[tokio::test]
async fn mock_receives_keccak_of_unsigned() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let hex_text = one_event(&result, "evm_unsigned")["unsigned_hex"]
        .as_str()
        .expect("hex")
        .to_string();
    let want = hex::encode(Keccak256::digest(hex::decode(&hex_text).unwrap()));
    let last = view(&w, &w.mpc, "last_request", json!({})).await;
    assert_eq!(last["payload_hex"], want.as_str(), "{last}");
    assert_eq!(last["path"], WORLD_EVM_PATH, "{last}");
}

// ---- 4 to 6: nonces ---------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn consecutive_nonces_on_one_path() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let first = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let second = submit_ok(&w, vec![clean(&w, &task, 1, AMOUNT)], &task).await;
    let hex_of = |r: &ExecutionFinalResult| {
        one_event(r, "evm_unsigned")["unsigned_hex"]
            .as_str()
            .expect("hex")
            .to_string()
    };
    assert_eq!(nonce_in(&hex_of(&first)), 0);
    assert_eq!(nonce_in(&hex_of(&second)), 1);
    assert_eq!(nonce_of(&w).await, json!("2"));
}

#[tokio::test]
async fn batch_of_three_gets_three_nonces_and_signatures() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let reqs = (0..3).map(|i| clean(&w, &task, i, AMOUNT)).collect();
    let result = submit_ok(&w, reqs, &task).await;
    let unsigned = events(&result, "evm_unsigned");
    assert_eq!(unsigned.len(), 3, "{unsigned:?}");
    assert_eq!(events(&result, "signed").len(), 3);
    let mut nonces: Vec<u128> = unsigned
        .iter()
        .map(|e| nonce_in(e["unsigned_hex"].as_str().expect("hex")))
        .collect();
    nonces.sort_unstable();
    assert_eq!(nonces, [0, 1, 2]);
    assert_eq!(mock_calls(&w).await, 3);
    for i in 0..3 {
        assert_eq!(state_of(&w, &id_of(&task, i)).await, "Executed");
    }
}

#[tokio::test]
async fn nonce_not_set_reverts_whole_batch() {
    let _slot = slot().await;
    let w = world_with(WorldOpts { nonce: None }).await;
    let task = task_of(&w, 3);
    let before = ledgers_of(&w).await;
    let result = w.submit(vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let text = failure_text(&result);
    assert!(text.contains("nonce not set"), "{text}");
    assert!(w.request(&id_of(&task, 0)).await.is_none());
    assert_eq!(ledgers_of(&w).await, before);
    assert_eq!(mock_calls(&w).await, 0);
}

// ---- 7 and 8: the stored values are signed ----------------------------------------------------------------------------------

/// An owner call with exactly 1 yocto and 150 Tgas prepaid (SPEC R5-12): the approve of an EVM escalation.
async fn approve_150(w: &World, card: Value) -> ExecutionFinalResult {
    let sent = Contract(w.policy.clone())
        .call_function("approve", card)
        .transaction()
        .gas(NearGas::from_tgas(150))
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(w.owner.clone(), w.owner_signer.clone())
        .send_to(&w.net)
        .await
        .expect("approve is sent");
    match sent {
        TransactionResult::Full(r) => *r,
        other => panic!("approve did not finish: {other:?}"),
    }
}

#[tokio::test]
async fn approved_escalation_signs_stored_values() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    // an untrusted amount (email origin) escalates
    let esc = req_with(&w, &task, 0, AMOUNT, (BOOK, EMAIL, OWNER));
    let result = submit_ok(&w, vec![esc], &task).await;
    let outcomes: Value = result.json().expect("outcomes");
    assert_eq!(outcomes[0]["outcome"], "escalated", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "UntrustedAmount", "{outcomes}");
    assert_eq!(mock_calls(&w).await, 0);
    let id = id_of(&task, 0);
    let stored = w.request(&id).await.expect("stored");
    let card = json!({
        "id": stored["id"],
        "to": stored["payee"],
        "asset": stored["display"]["asset_symbol"],
        "amount": stored["display"]["amount_decimal"],
        "why": stored["reason"],
        "book": stored["book_status"]
    });
    // a different amount string reverts and nothing is signed
    let mut wrong = card.clone();
    wrong["amount"] = json!("0.02");
    let refused = approve_150(&w, wrong).await;
    let text = failure_text(&refused);
    assert!(text.contains("approve rejected: WrongAmount"), "{text}");
    assert_eq!(mock_calls(&w).await, 0);
    // the right card signs the stored amount
    let approved = approve_150(&w, card).await;
    let text = failure_text(&approved);
    assert!(text.is_empty(), "approve failed: {text}");
    assert_eq!(
        names(&approved),
        ["approved", "evm_unsigned", "signed"],
        "{:?}",
        names(&approved)
    );
    let hex_text = one_event(&approved, "evm_unsigned")["unsigned_hex"]
        .as_str()
        .expect("hex")
        .to_string();
    let f = decode_1559(&hex_text);
    assert_eq!(num(&f[6].1), AMOUNT);
    assert_eq!(hex::encode(&f[5].1), w.payee_evm);
    assert_eq!(mock_calls(&w).await, 1);
    assert_eq!(state_of(&w, &id).await, "Executed");
}

#[tokio::test]
async fn signature_path_and_nonce_come_from_the_contract() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let mut req = clean(&w, &task, 0, AMOUNT);
    req["path"] = json!("attacker-path");
    req["nonce"] = json!(99);
    req["evm"]["path"] = json!("attacker-path");
    req["evm"]["nonce"] = json!(99);
    let result = submit_ok(&w, vec![req], &task).await;
    let hex_text = one_event(&result, "evm_unsigned")["unsigned_hex"]
        .as_str()
        .expect("hex")
        .to_string();
    assert_eq!(nonce_in(&hex_text), 0);
    let last = view(&w, &w.mpc, "last_request", json!({})).await;
    assert_eq!(last["path"], WORLD_EVM_PATH, "{last}");
    assert_eq!(nonce_of(&w).await, json!("1"));
}

// ---- 9 to 11: failures and retries ------------------------------------------------------------------------------------------

#[tokio::test]
async fn retry_after_mpc_failure_reuses_nonce_and_bytes() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let id = id_of(&task, 0);
    let before = ledgers_of(&w).await;
    w.set_mpc_mode("fail").await;
    let first = submit_mpc_failure(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    assert_eq!(
        names(&first),
        ["submitted", "allowed", "evm_unsigned", "failed"]
    );
    let hex_text = one_event(&first, "evm_unsigned")["unsigned_hex"].clone();
    let failed = one_event(&first, "failed");
    assert_eq!(failed["reason"], "MpcFailed");
    assert_eq!(failed["retryable"], true);
    assert_eq!(state_of(&w, &id).await, "Retryable");
    assert_eq!(ledgers_of(&w).await, before);
    assert_eq!(nonce_of(&w).await, json!("1"));

    w.set_mpc_mode("ok").await;
    let retry = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    assert_eq!(one_event(&retry, "evm_unsigned")["unsigned_hex"], hex_text);
    assert_eq!(one_event(&retry, "signed")["unsigned_hex"], hex_text);
    assert_eq!(nonce_of(&w).await, json!("1"));
    assert_eq!(state_of(&w, &id).await, "Executed");
}

#[tokio::test]
async fn second_failure_is_failed() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let id = id_of(&task, 0);
    w.set_mpc_mode("fail").await;
    let first = submit_mpc_failure(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    assert_eq!(one_event(&first, "failed")["retryable"], true);
    let second = submit_mpc_failure(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let failed = one_event(&second, "failed");
    assert_eq!(failed["reason"], "MpcFailed");
    assert_eq!(failed["retryable"], false);
    assert_eq!(state_of(&w, &id).await, "Failed");
    assert_eq!(nonce_of(&w).await, json!("1"));
    let third = w.submit(vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let text = failure_text(&third);
    assert!(
        text.contains("request_id already used (UsedRequestId)"),
        "{text}"
    );
}

/// D17: an answer the contract cannot use may still hold a signature, so the charges stay and the request is final.
#[tokio::test]
async fn bad_response_keeps_charges_and_is_final() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let id = id_of(&task, 0);
    w.set_mpc_mode("garbage").await;
    let result = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let failed = one_event(&result, "failed");
    assert_eq!(failed["reason"], "MpcBadResponse");
    assert_eq!(failed["retryable"], false);
    assert_eq!(state_of(&w, &id).await, "Failed");
    let after = ledgers_of(&w).await;
    assert_eq!(after["asset_day"]["spent"], AMOUNT.to_string(), "{after}");
    w.set_mpc_mode("ok").await;
    let retry = w.submit(vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let text = failure_text(&retry);
    assert!(
        text.contains("request_id already used (UsedRequestId)"),
        "{text}"
    );
    assert_eq!(mock_calls(&w).await, 1);
}

// ---- 12 and 13: exports and gas ---------------------------------------------------------------------------------------------

#[test]
fn exec_helpers_not_exported() {
    let exports = wasm_exports();
    assert!(exports.iter().any(|e| e == "submit_batch"), "{exports:?}");
    for name in [
        "start_evm",
        "start_execution",
        "build_evm_unsigned",
        "evm_to_address",
        "evm_chain_id",
        "next_nonce",
        "attempt_of",
        "record_attempt",
    ] {
        assert!(!exports.iter().any(|e| e == name), "{name} is exported");
    }
}

#[tokio::test]
async fn gas_evm_single() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    let gas = gas_report(&result);
    println!("\nGAS evm_single={:.2} Tgas", gas as f64 / 1e12);
    assert!(gas < 30_000_000_000_000, "a clean EVM Allow burnt {gas}");
}

// ---- 14: the timeout branch, end to end -------------------------------------------------------------------------------------

#[tokio::test]
async fn yield_timeout_refunds_and_is_retryable() {
    let _slot = slot().await;
    let w = world().await;
    let task = task_of(&w, 3);
    let id = id_of(&task, 0);
    let before = ledgers_of(&w).await;
    w.set_mpc_mode("yield").await;
    let ex = Contract(w.policy.clone())
        .call_function(
            "submit_batch",
            json!({ "reqs": [clean(&w, &task, 0, AMOUNT)], "task": task.0, "task_sig": task.1 }),
        )
        .transaction()
        .gas(NearGas::from_tgas(300))
        .with_signer(w.agent.clone(), w.agent_signer.clone())
        .wait_until(TxExecutionStatus::Included)
        .presign_with(&w.net)
        .await
        .expect("the transaction is signed");
    let hash = match &ex.transaction {
        TransactionableOrSigned::Signed((s, _)) => s.get_hash(),
        _ => unreachable!("presign_with signs"),
    };
    let pending = ex.send_to(&w.net).await.expect("the transaction is sent");
    assert!(matches!(pending, TransactionResult::Pending { .. }));
    let mut parked = false;
    for _ in 0..100 {
        let executing = w
            .request(&id)
            .await
            .is_some_and(|r| r["state"] == "Executing");
        if executing && w.mpc_parked().await == 1 {
            parked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        parked,
        "the request never reached Executing with one parked sign"
    );
    match tokio::time::timeout(Duration::from_secs(30), w.sandbox.fast_forward(200)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            println!("SKIP yield timeout: fast_forward unavailable: {e:?}");
            return;
        }
        Err(_) => panic!("fast_forward(200) hung for 30 s"),
    }
    let mut state = String::new();
    for _ in 0..300 {
        state = state_of(&w, &id).await;
        if state == "Retryable" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(state, "Retryable");
    assert_eq!(ledgers_of(&w).await, before);
    assert_eq!(nonce_of(&w).await, json!("1"));
    let fin = Transaction::status_with_options(w.agent.clone(), hash, TxExecutionStatus::Final)
        .fetch_from(&w.net)
        .await
        .expect("the final status");
    let failed = one_event(&fin, "failed");
    assert_eq!(failed["reason"], "MpcFailed");
    assert_eq!(failed["retryable"], true);
    let text = failure_text(&fin);
    assert!(text.contains("Request has timed out."), "{text}");
    let first_hex = one_event(&fin, "evm_unsigned")["unsigned_hex"].clone();

    w.set_mpc_mode("ok").await;
    let retry = submit_ok(&w, vec![clean(&w, &task, 0, AMOUNT)], &task).await;
    assert_eq!(one_event(&retry, "evm_unsigned")["unsigned_hex"], first_hex);
    assert_eq!(events(&retry, "signed").len(), 1);
    assert_eq!(nonce_of(&w).await, json!("1"));
    assert_eq!(state_of(&w, &id).await, "Executed");
}

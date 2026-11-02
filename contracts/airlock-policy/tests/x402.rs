// AIR-109: the x402 lane in the sandbox. A payment in an erc20 asset (`evm:84532:erc20:0x<token>`, here the Base Sepolia test USDC) is
// paid by signing an EIP-3009 `transferWithAuthorization`: the contract builds the EIP-712 digest from the stored record and the registry,
// the mock MPC signs it, and `on_signed` emits `x402_signed`. Every test uses `x402_world()`: `world()` of tests/common plus the demo
// asset (`USDC.base`, 6 decimals, path `base-sepolia-usdc-1`, `eip712 { separator 71f1..9818, from 0x11..11 }`) and the booked erc20
// payee key. The payment is 10_000 base units (0.01 USDC).
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::request::request_id;
use airlock_policy::task::task_hash;
use common::*;
use near_api::{Contract, NearGas, NearToken};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
/// Owner (1) joined with Untrusted:payment_protocol (8192): the labels the runtime gives an x402 `payTo`.
const PAY_TO: u16 = 8193;

const TOKEN: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const USDC_ASSET: &str = "evm:84532:erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const USDC_PATH: &str = "base-sepolia-usdc-1";
const SEPARATOR: &str = "71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818";
const FROM: &str = "0x1111111111111111111111111111111111111111";
const AMOUNT: u128 = 10_000;
const BOUND: u128 = 1_000_000;

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

fn usdc_entry() -> Value {
    json!({
        "symbol": "USDC.base",
        "decimals": 6,
        "hard_cap": "1000000",
        "daily_cap": "5000000",
        "max_fee_per_gas": "0",
        "max_gas": "0",
        "quick_task_cap": "5000000",
        "path": USDC_PATH,
        "eip712": { "domain_separator": SEPARATOR, "from": FROM }
    })
}

fn erc20_key(w: &World) -> String {
    format!("erc20:84532:{TOKEN}:0x{}", w.payee_evm)
}

fn eth_key(w: &World) -> String {
    format!("evm:84532:0x{}", w.payee_evm)
}

async fn owner_ok(w: &World, method: &str, args: Value) {
    owner_call_ok(&w.policy, &w.owner, &w.owner_signer, &w.net, method, args).await;
}

/// An owner call that must fail: its failure text.
async fn owner_fails(w: &World, method: &str, args: Value) -> String {
    let result = call_transaction(
        &w.policy,
        method,
        args,
        &w.owner,
        &w.owner_signer,
        &w.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap_or_else(|e| panic!("{method} is not sent: {e}"));
    let text = failure_text(&result);
    assert!(!text.is_empty(), "{method} was expected to fail");
    text
}

fn book_args(w: &World) -> Value {
    json!({
        "key": erc20_key(w),
        "cap": null,
        "daily_untrusted_budget": "0",
        "daily_limit": "5000000",
        "label": "x402 receiver"
    })
}

/// The world plus the demo asset and its booked payee key.
async fn x402_world() -> World {
    let w = world().await;
    owner_ok(
        &w,
        "asset_set",
        json!({ "asset": USDC_ASSET, "entry": usdc_entry() }),
    )
    .await;
    owner_ok(&w, "book_add", book_args(&w)).await;
    w
}

fn task_of(w: &World, bounds: &[(&str, u128)], max_actions: u8) -> Task {
    w.signed_task(bounds, max_actions)
}

fn req(w: &World, task: &Task, index: u8, labels: (u16, u16, u16)) -> Value {
    w.request_json(
        &task.0,
        index,
        USDC_ASSET,
        &erc20_key(w),
        AMOUNT,
        labels,
        None,
    )
}

fn clean(w: &World, task: &Task, index: u8) -> Value {
    req(w, task, index, (BOOK, OWNER, OWNER))
}

fn id_of(task: &Task, index: u8) -> String {
    request_id(&task_hash(&task.0), index)
}

async fn submit_ok(w: &World, reqs: Vec<Value>, task: &Task) -> ExecutionFinalResult {
    let result = w.submit(reqs, task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    result
}

/// A submit whose only failed receipt is the signer's own (the mock's `fail` mode).
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

fn names(r: &ExecutionFinalResult) -> Vec<String> {
    extract_event_logs(r)
        .expect("the events parse")
        .iter()
        .map(|e| e["event"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn one_event(r: &ExecutionFinalResult, name: &str) -> Value {
    let found = events(r, name);
    assert_eq!(found.len(), 1, "{name}: {found:?}");
    found[0].clone()
}

async fn view(w: &World, contract: &near_api::AccountId, method: &str, args: Value) -> Value {
    call_view::<Value>(contract, method, args, &w.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
        .data
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

async fn usdc_ledgers(w: &World) -> Value {
    w.ledgers(&erc20_key(w), USDC_ASSET).await
}

fn hex_bytes(text: &str) -> Vec<u8> {
    hex::decode(text.trim_start_matches("0x")).expect("hex")
}

fn word(bytes: &[u8]) -> Vec<u8> {
    let mut w = vec![0u8; 32 - bytes.len()];
    w.extend_from_slice(bytes);
    w
}

/// The digest of an `x402_signed` event, rebuilt here from its fields and the pinned separator (not through the contract's helpers).
fn digest_of(event: &Value) -> String {
    let text = |k: &str| {
        event[k]
            .as_str()
            .unwrap_or_else(|| panic!("{k} in {event}"))
    };
    let typehash = Keccak256::digest(
        b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
    );
    let num = |k: &str| text(k).parse::<u128>().expect("a decimal").to_be_bytes();
    let mut s = typehash.to_vec();
    s.extend(word(&hex_bytes(text("from"))));
    s.extend(word(&hex_bytes(text("to"))));
    s.extend(word(&num("value")));
    s.extend(word(&num("valid_after")));
    s.extend(word(&num("valid_before")));
    s.extend(hex_bytes(text("nonce")));
    let struct_hash = Keccak256::digest(&s);
    let mut d = vec![0x19, 0x01];
    d.extend(hex_bytes(SEPARATOR));
    d.extend(struct_hash);
    hex::encode(Keccak256::digest(&d))
}

// ---- 1: the registry rules ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn x402_asset_set_rules() {
    let _slot = slot().await;
    let w = world().await;
    // a payee key of an asset that does not exist yet
    let text = owner_fails(&w, "book_add", book_args(&w)).await;
    assert!(text.contains("unknown asset for payee key"), "{text}");
    // the demo asset registers (the AIR-086 guard would compute 208 bytes and refuse it)
    owner_ok(
        &w,
        "asset_set",
        json!({ "asset": USDC_ASSET, "entry": usdc_entry() }),
    )
    .await;
    let stored = view(&w, &w.policy, "get_asset", json!({ "asset": USDC_ASSET })).await;
    assert_eq!(stored["eip712"]["from"], FROM, "{stored}");
    assert_eq!(stored["eip712"]["domain_separator"], SEPARATOR, "{stored}");
    owner_ok(&w, "book_add", book_args(&w)).await;
    let with = |edit: &dyn Fn(&mut Value)| {
        let mut e = usdc_entry();
        edit(&mut e);
        e
    };
    let other_id = "evm:84532:erc20:0x1111111111111111111111111111111111111111";
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            other_id,
            with(&|e| {
                e["path"] = json!("base-sepolia-1");
                e["symbol"] = json!("OTHER");
            }),
            "evm path already used",
        ),
        (
            other_id,
            with(&|e| {
                e["path"] = json!("other-path");
                e["symbol"] = json!("OTHER");
                e["max_fee_per_gas"] = json!("1");
            }),
            "erc20 fee and gas caps must be 0",
        ),
        (
            other_id,
            with(&|e| {
                e["path"] = json!("other-path");
                e["symbol"] = json!("OTHER");
                e["eip712"] = Value::Null;
            }),
            "eip712 required for erc20",
        ),
        (
            other_id,
            with(&|e| {
                e["path"] = json!("other-path");
                e["symbol"] = json!("OTHER");
                e["eip712"]["from"] = json!(format!("0x{}", "1".repeat(39)));
            }),
            "eip712 invalid",
        ),
        (
            other_id,
            with(&|e| {
                e["path"] = json!("other-path");
                e["symbol"] = json!("OTHER");
                e["eip712"]["domain_separator"] = json!("0".repeat(64));
            }),
            "eip712 invalid",
        ),
        (
            "near",
            with(&|e| {
                e["symbol"] = json!("NEARX");
                e["path"] = Value::Null;
            }),
            "eip712 only for erc20",
        ),
        (
            "evm:84532:erc20:0x036CBD53842C5426634E7929541EC2318F3DCF7E",
            usdc_entry(),
            "invalid asset id",
        ),
    ];
    for (asset, entry, want) in cases {
        let text = owner_fails(&w, "asset_set", json!({ "asset": asset, "entry": entry })).await;
        assert!(text.contains(want), "{asset}: wanted `{want}` in {text}");
    }
}

// ---- 2 and 3: an Allow signs the authorization ---------------------------------------------------------------------------

#[tokio::test]
async fn x402_allow_emits_x402_signed() {
    let _slot = slot().await;
    let w = x402_world().await;
    let key = erc20_key(&w);
    let task = task_of(&w, &[(&key, BOUND)], 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0)], &task).await;
    assert_eq!(
        names(&result),
        ["submitted", "allowed", "x402_signed"],
        "{:?}",
        names(&result)
    );
    let e = one_event(&result, "x402_signed");
    assert_eq!(e["id"], id_of(&task, 0).as_str(), "{e}");
    assert_eq!(e["from"], FROM, "{e}");
    assert_eq!(e["to"], format!("0x{}", w.payee_evm).as_str(), "{e}");
    assert_eq!(e["value"], "10000", "{e}");
    assert_eq!(e["valid_after"], "0", "{e}");
    let nonce = e["nonce"].as_str().expect("nonce");
    assert!(
        nonce.len() == 66 && nonce.starts_with("0x") && hex::decode(&nonce[2..]).is_ok(),
        "{nonce}"
    );
    assert_eq!(nonce, nonce.to_lowercase());
    assert_eq!(e["v"], 27, "{e}");
    assert_eq!(e["r"], "1".repeat(64).as_str(), "{e}");
    assert_eq!(e["s"], "2".repeat(64).as_str(), "{e}");
    // the window is 300 s from the block time of the signing transaction
    let valid_before: u64 = e["valid_before"].as_str().unwrap().parse().unwrap();
    let now_s = final_block_ms(&w) / 1000;
    let signed_at = valid_before - 300;
    assert!(
        signed_at.abs_diff(now_s) <= 60,
        "signed at {signed_at}, block time {now_s}"
    );
    let stored = w.request(&id_of(&task, 0)).await.expect("stored");
    assert_eq!(stored["state"], "Executed", "{stored}");
    assert_eq!(
        stored["exec"]["x402"]["valid_before"].as_u64(),
        Some(valid_before),
        "{stored}"
    );
}

#[tokio::test]
async fn x402_mpc_receives_the_digest() {
    let _slot = slot().await;
    let w = x402_world().await;
    let key = erc20_key(&w);
    let task = task_of(&w, &[(&key, BOUND)], 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0)], &task).await;
    let e = one_event(&result, "x402_signed");
    let last = view(&w, &w.mpc, "last_request", json!({})).await;
    assert_eq!(last["path"], USDC_PATH, "{last}");
    assert_eq!(last["payload_hex"], digest_of(&e).as_str(), "{last}");
}

// ---- 4 to 8: the verdict ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn x402_unknown_asset_blocks() {
    let _slot = slot().await;
    // the asset is not registered
    let w = world().await;
    let task = task_of(&w, &[(&eth_key(&w), BOUND)], 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0)], &task).await;
    let outcomes: Value = result.json().expect("outcomes");
    assert_eq!(outcomes[0]["outcome"], "blocked", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "UnknownAsset", "{outcomes}");
    assert_eq!(mock_calls(&w).await, 0);
}

#[tokio::test]
async fn x402_outside_task_escalates() {
    let _slot = slot().await;
    let w = x402_world().await;
    let other = eth_key(&w);
    let task = task_of(&w, &[(&other, BOUND)], 3);
    let result = submit_ok(&w, vec![req(&w, &task, 0, (PAY_TO, OWNER, OWNER))], &task).await;
    let outcomes: Value = result.json().expect("outcomes");
    assert_eq!(outcomes[0]["outcome"], "escalated", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "OutsideTask", "{outcomes}");
    let stored = w.request(&id_of(&task, 0)).await.expect("stored");
    assert_eq!(stored["display"]["asset_symbol"], "USDC.base", "{stored}");
    assert_eq!(stored["display"]["amount_decimal"], "0.01", "{stored}");
    assert_eq!(mock_calls(&w).await, 0);
}

#[tokio::test]
async fn x402_untrusted_recipient_escalates() {
    let _slot = slot().await;
    let w = x402_world().await;
    let key = erc20_key(&w);
    let task = task_of(&w, &[(&key, BOUND)], 3);
    let result = submit_ok(&w, vec![req(&w, &task, 0, (PAY_TO, OWNER, OWNER))], &task).await;
    let outcomes: Value = result.json().expect("outcomes");
    assert_eq!(outcomes[0]["outcome"], "escalated", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "UntrustedRecipient", "{outcomes}");
    assert_eq!(mock_calls(&w).await, 0);
}

#[tokio::test]
async fn x402_evm_params_and_key_mismatch_revert() {
    let _slot = slot().await;
    let w = x402_world().await;
    let key = erc20_key(&w);
    let task = task_of(&w, &[(&key, BOUND)], 3);
    let with_evm = w.request_json(
        &task.0,
        0,
        USDC_ASSET,
        &key,
        AMOUNT,
        (BOOK, OWNER, OWNER),
        Some((21_000, 2_000_000_000, 1_000_000_000)),
    );
    let text = failure_text(&w.submit(vec![with_evm], &task).await);
    assert!(text.contains("evm params not allowed"), "{text}");
    let eth_payee = w.request_json(
        &task.0,
        0,
        USDC_ASSET,
        &eth_key(&w),
        AMOUNT,
        (BOOK, OWNER, OWNER),
        None,
    );
    let text = failure_text(&w.submit(vec![eth_payee], &task).await);
    assert!(text.contains("asset does not match payee"), "{text}");
    assert_eq!(mock_calls(&w).await, 0);
}

/// P1: a bound written for the ETH key does not cover a USDC payment to the same address.
#[tokio::test]
async fn x402_eth_bound_does_not_cover_usdc_key() {
    let _slot = slot().await;
    let w = x402_world().await;
    let eth = eth_key(&w);
    let task = task_of(&w, &[(&eth, 10_000_000_000_000_000)], 3);
    let eth_before = w.ledgers(&eth, "evm:84532:native").await;
    let usdc_before = usdc_ledgers(&w).await;
    let result = submit_ok(&w, vec![req(&w, &task, 0, (PAY_TO, OWNER, OWNER))], &task).await;
    let outcomes: Value = result.json().expect("outcomes");
    assert_eq!(outcomes[0]["outcome"], "escalated", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "OutsideTask", "{outcomes}");
    assert_eq!(w.ledgers(&eth, "evm:84532:native").await, eth_before);
    assert_eq!(usdc_ledgers(&w).await, usdc_before);
    assert_eq!(mock_calls(&w).await, 0);
}

// ---- 9: nonces ----------------------------------------------------------------------------------------------------------------

/// `env::random_seed()` is one value per receipt: two authorizations of one batch must still get different nonces.
#[tokio::test]
async fn x402_nonces_unique_in_one_batch() {
    let _slot = slot().await;
    let w = x402_world().await;
    let key = erc20_key(&w);
    let task = task_of(&w, &[(&key, BOUND)], 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0), clean(&w, &task, 1)], &task).await;
    let signed = events(&result, "x402_signed");
    assert_eq!(signed.len(), 2, "{signed:?}");
    assert_ne!(signed[0]["nonce"], signed[1]["nonce"], "{signed:?}");
    assert_ne!(signed[0]["id"], signed[1]["id"]);
}

// ---- 10: approve --------------------------------------------------------------------------------------------------------------

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

/// P11: the escalated request signs at approve time, with `valid_before` computed from the block of the approve transaction.
#[tokio::test]
async fn x402_approved_escalation_signs_with_approve_time_window() {
    let _slot = slot().await;
    let w = x402_world().await;
    let key = erc20_key(&w);
    let task = task_of(&w, &[(&key, BOUND)], 3);
    let result = submit_ok(&w, vec![req(&w, &task, 0, (PAY_TO, OWNER, OWNER))], &task).await;
    let outcomes: Value = result.json().expect("outcomes");
    assert_eq!(outcomes[0]["reason"], "UntrustedRecipient", "{outcomes}");
    let id = id_of(&task, 0);
    let stored = w.request(&id).await.expect("stored");
    assert!(
        stored["exec"].is_null(),
        "nothing is signed while Pending: {stored}"
    );
    assert_eq!(mock_calls(&w).await, 0);
    let t0 = final_block_ms(&w) / 1000;
    w.sandbox
        .fast_forward(1200)
        .await
        .expect("the sandbox fast-forwards");
    let card = json!({
        "id": stored["id"],
        "to": stored["payee"],
        "asset": stored["display"]["asset_symbol"],
        "amount": stored["display"]["amount_decimal"],
        "why": stored["reason"],
        "book": stored["book_status"]
    });
    assert_eq!(card["asset"], "USDC.base");
    assert_eq!(card["amount"], "0.01");
    let approved = approve_150(&w, card).await;
    let text = failure_text(&approved);
    assert!(text.is_empty(), "approve failed: {text}");
    let after_s = final_block_ms(&w) / 1000;
    assert_eq!(
        names(&approved),
        ["approved", "x402_signed"],
        "{:?}",
        names(&approved)
    );
    let e = one_event(&approved, "x402_signed");
    let signed_at = e["valid_before"].as_str().unwrap().parse::<u64>().unwrap() - 300;
    assert!(
        signed_at >= t0 + 300,
        "signed at {signed_at}, before {t0} + 300"
    );
    assert!(
        signed_at <= after_s,
        "signed at {signed_at}, after {after_s}"
    );
    assert_eq!(mock_calls(&w).await, 1);
}

// ---- 11: a retry --------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn x402_retry_signs_a_fresh_authorization() {
    let _slot = slot().await;
    let w = x402_world().await;
    let key = erc20_key(&w);
    let task = task_of(&w, &[(&key, BOUND)], 3);
    let id = id_of(&task, 0);
    let before = usdc_ledgers(&w).await;
    w.set_mpc_mode("fail").await;
    let first = submit_mpc_failure(&w, vec![clean(&w, &task, 0)], &task).await;
    let failed = one_event(&first, "failed");
    assert_eq!(failed["reason"], "MpcFailed", "{failed}");
    assert_eq!(failed["retryable"], true, "{failed}");
    assert_eq!(state_of(&w, &id).await, "Retryable");
    assert_eq!(usdc_ledgers(&w).await, before);
    let n1 = w.request(&id).await.expect("stored")["exec"]["x402"]["nonce"].clone();
    assert!(n1.is_string(), "the first nonce is readable: {n1}");
    w.set_mpc_mode("ok").await;
    let second = submit_ok(&w, vec![clean(&w, &task, 0)], &task).await;
    let e = one_event(&second, "x402_signed");
    assert_ne!(e["nonce"], n1, "a retry signs a new nonce");
    assert_eq!(state_of(&w, &id).await, "Executed");
    let after = usdc_ledgers(&w).await;
    assert_eq!(
        after["asset_day"]["spent"],
        AMOUNT.to_string(),
        "charged once: {after}"
    );
    // the mock counts only the calls it answers: the failed first attempt is not counted, the retry is
    assert_eq!(mock_calls(&w).await, 1);
}

// ---- 12: exports --------------------------------------------------------------------------------------------------------------

#[test]
fn x402_helpers_not_exported() {
    let exports = wasm_exports();
    assert!(exports.iter().any(|e| e == "submit_batch"), "{exports:?}");
    for name in [
        "start_x402",
        "store_x402_signature",
        "x402_nonce",
        "struct_hash",
        "eip3009_digest",
        "x402_sig_parts",
        "valid_before_at",
        "is_erc20_asset",
    ] {
        assert!(!exports.iter().any(|e| e == name), "{name} is exported");
    }
}

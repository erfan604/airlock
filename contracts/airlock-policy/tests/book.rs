// AIR-043: the address book in the sandbox. Payees are matched by exact canonical ASCII keys and only the owner can add or remove one.
// Every revert test asserts the message text, because a missing method also fails and would pass a bare `assert_failure()`. No
// character is escaped with a backslash and `u`: non-ASCII characters are built from their code points.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, Data, NearToken, Signer};
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};
use std::sync::Arc;

const ONE_YOCTO_TEXT: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
const NOT_OWNER_TEXT: &str = "Caller is not the owner";
const VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/verdict-vectors.json"
));

const NEAR_KEY: &str = "near:accountant.test.near";
const EVM_KEY: &str = "evm:84532:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const EVM_ADDR: &str = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

/// 10^24 yocto: one NEAR.
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn near_asset() -> Value {
    json!({
        "symbol": "NEAR",
        "decimals": 24,
        "hard_cap": (10_000 * NEAR).to_string(),
        "daily_cap": (100_000 * NEAR).to_string(),
        "max_fee_per_gas": "0",
        "max_gas": "0",
        "quick_task_cap": (100_000 * NEAR).to_string(),
        "path": null
    })
}

/// An EVM asset with its own symbol and path (the registry wants both unique).
fn evm_asset(symbol: &str, path: &str) -> Value {
    json!({
        "symbol": symbol,
        "decimals": 18,
        "hard_cap": "1000000000000000000",
        "daily_cap": "10000000000000000000",
        "max_fee_per_gas": "50000000000",
        "max_gas": "100000",
        "quick_task_cap": "5000000000000000000",
        "path": path
    })
}

async fn asset_set(s: &Started, asset: &str, entry: Value) {
    owner_call(s, "asset_set", json!({ "asset": asset, "entry": entry }))
        .await
        .assert_success();
}

/// A started sandbox with `near` and `evm:84532:native` registered.
async fn with_assets() -> Started {
    let s = start().await;
    asset_set(&s, "near", near_asset()).await;
    asset_set(
        &s,
        "evm:84532:native",
        evm_asset("ETH.base", "base-sepolia-1"),
    )
    .await;
    s
}

fn add_args(key: &str, cap: Option<&str>, label: &str) -> Value {
    json!({
        "key": key,
        "cap": cap,
        "daily_untrusted_budget": "1000",
        "daily_limit": "5000",
        "label": label
    })
}

async fn add(s: &Started, key: &str, cap: Option<&str>, label: &str) -> ExecutionFinalResult {
    owner_call(s, "book_add", add_args(key, cap, label)).await
}

async fn add_ok(s: &Started, key: &str, cap: Option<&str>, label: &str) {
    let result = add(s, key, cap, label).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "book_add({key}) failed: {text}");
    result.assert_success();
}

fn assert_fails_with(result: ExecutionFinalResult, text: &str) {
    let got = failure_text(&result);
    result.assert_failure();
    assert!(got.contains(text), "expected `{text}` in: {got}");
}

async fn view(s: &Started, method: &str, args: Value) -> Value {
    let answer: Data<Value> = call_view(&s.contract, method, args, &s.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"));
    answer.data
}

async fn book_keys(s: &Started) -> Vec<String> {
    view(s, "get_book", json!({ "from_index": null, "limit": 500 }))
        .await
        .as_array()
        .expect("a list")
        .iter()
        .map(|row| row[0].as_str().unwrap().to_string())
        .collect()
}

async fn account(s: &Started, name: &str) -> (AccountId, Arc<Signer>) {
    create_user_account(&s.net, &s.owner, &s.owner_signer, name)
        .await
        .expect("the account is created")
}

fn code_point(n: u32) -> char {
    char::from_u32(n).expect("a valid code point")
}

#[tokio::test]
async fn owner_book_add_succeeds() {
    let _slot = slot().await;
    let s = with_assets().await;
    assert_eq!(
        view(&s, "get_book_entry", json!({ "key": NEAR_KEY })).await,
        Value::Null
    );
    let result = add(&s, NEAR_KEY, Some("100"), "Accountant").await;
    let events = extract_event_logs(&result).unwrap();
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    result.assert_success();
    // the entry comes back with the cap as a decimal string
    assert_eq!(
        view(&s, "get_book_entry", json!({ "key": NEAR_KEY })).await,
        json!({ "cap": "100", "daily_untrusted_budget": "1000", "daily_limit": "5000", "label": "Accountant" })
    );
    let event = events
        .iter()
        .find(|e| e["event"] == "book_added")
        .expect("a book_added event");
    assert_eq!(event["standard"], "airlock");
    let data = &event["data"][0];
    assert_eq!(data["key"], NEAR_KEY);
    assert_eq!(data["label"], "Accountant");
    assert_eq!(data["cap"], "100");
    assert_eq!(data["daily_untrusted_budget"], "1000");
    assert_eq!(data["daily_limit"], "5000");
    // an EVM payee under the registered EVM asset
    add_ok(&s, EVM_KEY, Some("7"), "Landlord").await;
    assert_eq!(
        view(&s, "get_book_entry", json!({ "key": EVM_KEY })).await["cap"],
        "7"
    );
}

#[tokio::test]
async fn null_cap_means_never() {
    let _slot = slot().await;
    let s = with_assets().await;
    let result = add(&s, NEAR_KEY, None, "Strict").await;
    let events = extract_event_logs(&result).unwrap();
    result.assert_success();
    assert_eq!(
        view(&s, "get_book_entry", json!({ "key": NEAR_KEY })).await["cap"],
        Value::Null
    );
    let event = events.iter().find(|e| e["event"] == "book_added").unwrap();
    assert_eq!(event["data"][0]["cap"], Value::Null);
}

/// I3: the agent account cannot edit the book.
#[tokio::test]
async fn book_add_by_agent_reverts() {
    let _slot = slot().await;
    let s = with_assets().await;
    let (agent, signer) = account(&s, "agent").await;
    register_local_agent(
        &s.contract,
        &s.owner,
        &s.owner_signer,
        &agent,
        &signer,
        &s.net,
    )
    .await;
    allow_agent_for(&s.contract, &s.owner, &s.owner_signer, &agent, &s.net).await;
    let result = call_transaction(
        &s.contract,
        "book_add",
        add_args(NEAR_KEY, Some("100"), "Agent"),
        &agent,
        &signer,
        &s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap();
    assert_fails_with(result, NOT_OWNER_TEXT);
    assert!(book_keys(&s).await.is_empty());
}

#[tokio::test]
async fn book_add_by_stranger_reverts() {
    let _slot = slot().await;
    let s = with_assets().await;
    let (stranger, signer) = account(&s, "stranger").await;
    let result = call_transaction(
        &s.contract,
        "book_add",
        add_args(NEAR_KEY, Some("100"), "Stranger"),
        &stranger,
        &signer,
        &s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap();
    assert_fails_with(result, NOT_OWNER_TEXT);
    // book_remove too, even for a payee that exists
    add_ok(&s, NEAR_KEY, Some("100"), "Accountant").await;
    let result = call_transaction(
        &s.contract,
        "book_remove",
        json!({ "key": NEAR_KEY }),
        &stranger,
        &signer,
        &s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap();
    assert_fails_with(result, NOT_OWNER_TEXT);
    assert_eq!(book_keys(&s).await, [NEAR_KEY]);
}

#[tokio::test]
async fn book_add_no_deposit_reverts() {
    let _slot = slot().await;
    let s = with_assets().await;
    let result = call_transaction(
        &s.contract,
        "book_add",
        add_args(NEAR_KEY, Some("100"), "No deposit"),
        &s.owner,
        &s.owner_signer,
        &s.net,
        Some(NearToken::from_yoctonear(0)),
    )
    .await
    .unwrap();
    assert_fails_with(result, ONE_YOCTO_TEXT);
    assert!(book_keys(&s).await.is_empty());
}

#[tokio::test]
async fn book_add_two_yocto_reverts() {
    let _slot = slot().await;
    let s = with_assets().await;
    let result = call_transaction(
        &s.contract,
        "book_add",
        add_args(NEAR_KEY, Some("100"), "Two yocto"),
        &s.owner,
        &s.owner_signer,
        &s.net,
        Some(NearToken::from_yoctonear(2)),
    )
    .await
    .unwrap();
    assert_fails_with(result, ONE_YOCTO_TEXT);
    let result = call_transaction(
        &s.contract,
        "book_remove",
        json!({ "key": NEAR_KEY }),
        &s.owner,
        &s.owner_signer,
        &s.net,
        Some(NearToken::from_yoctonear(0)),
    )
    .await
    .unwrap();
    assert_fails_with(result, ONE_YOCTO_TEXT);
}

/// A look-alike key never reaches the book: each of these is refused at the door with the first reason, NonAscii.
macro_rules! non_ascii_key {
    ($name:ident, $key:expr) => {
        #[tokio::test]
        async fn $name() {
            let _slot = slot().await;
            let s = with_assets().await;
            let key: String = $key;
            let result = add(&s, &key, Some("100"), "Look alike").await;
            assert_fails_with(result, "bad payee key: NonAscii");
            assert!(book_keys(&s).await.is_empty(), "the look-alike was stored");
        }
    };
}

non_ascii_key!(
    zero_width_key_reverts,
    format!("near:accou{}ntant.test.near", code_point(0x200D))
);
non_ascii_key!(
    bidi_key_reverts,
    format!("near:{}accountant.test.near", code_point(0x202E))
);
non_ascii_key!(
    kelvin_sign_key_reverts,
    format!("near:{}elvin.test.near", code_point(0x212A))
);
non_ascii_key!(
    fullwidth_key_reverts,
    format!(
        "evm:{}:{EVM_ADDR}",
        [0xFF18u32, 0xFF14, 0xFF15, 0xFF13, 0xFF12]
            .into_iter()
            .map(code_point)
            .collect::<String>()
    )
);
non_ascii_key!(
    cyrillic_key_reverts,
    format!("near:{}ccountant.test.near", code_point(0x430))
);

/// Every `payee_keys.reject` vector of the shared file is refused with exactly `bad payee key: <its error>`.
#[tokio::test]
async fn rejected_vector_keys_revert_with_their_error() {
    let _slot = slot().await;
    let s = with_assets().await;
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    let rejects = doc["payee_keys"]["reject"].as_array().unwrap();
    assert!(rejects.len() >= 30);
    for entry in rejects {
        let key = entry["key"].as_str().unwrap();
        let error = entry["error"].as_str().unwrap();
        let result = add(&s, key, Some("1"), "Vector").await;
        assert_fails_with(result, &format!("bad payee key: {error}"));
    }
    assert!(book_keys(&s).await.is_empty());
}

/// Every `payee_keys.accept` vector is added once the assets it is paid in exist.
#[tokio::test]
async fn accepted_vector_keys_are_added() {
    let _slot = slot().await;
    let s = start().await;
    asset_set(&s, "near", near_asset()).await;
    for (chain, symbol, path) in [
        ("84532", "ETH.base", "base-sepolia-1"),
        ("1", "ETH", "ethereum-1"),
        ("8453", "ETH.b", "base-8453"),
        ("18446744073709551615", "ETH.max", "max-chain"),
    ] {
        asset_set(&s, &format!("evm:{chain}:native"), evm_asset(symbol, path)).await;
    }
    let doc: Value = serde_json::from_str(VECTORS).unwrap();
    let accepts = doc["payee_keys"]["accept"].as_array().unwrap();
    for entry in accepts {
        add_ok(&s, entry["key"].as_str().unwrap(), Some("1"), "Vector").await;
    }
    assert_eq!(book_keys(&s).await.len(), accepts.len());
}

#[tokio::test]
async fn unknown_asset_for_payee_key_reverts() {
    let _slot = slot().await;
    let s = start().await;
    // nothing is registered: both lanes are unknown
    assert_fails_with(
        add(&s, NEAR_KEY, Some("100"), "Accountant").await,
        "unknown asset for payee key",
    );
    assert_fails_with(
        add(&s, EVM_KEY, Some("100"), "Landlord").await,
        "unknown asset for payee key",
    );
    // `near` is registered, the EVM chain of the key is not
    asset_set(&s, "near", near_asset()).await;
    add_ok(&s, NEAR_KEY, Some("100"), "Accountant").await;
    assert_fails_with(
        add(&s, EVM_KEY, Some("100"), "Landlord").await,
        "unknown asset for payee key",
    );
    assert_fails_with(
        add(
            &s,
            "evm:1:0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
            Some("100"),
            "Mainnet",
        )
        .await,
        "unknown asset for payee key",
    );
    assert_eq!(book_keys(&s).await, [NEAR_KEY]);
}

#[tokio::test]
async fn same_label_different_keys_coexist() {
    let _slot = slot().await;
    let s = with_assets().await;
    add_ok(&s, NEAR_KEY, Some("100"), "Landlord").await;
    add_ok(&s, "near:other.test.near", Some("100"), "Landlord").await;
    add_ok(&s, EVM_KEY, None, "Landlord").await;
    assert_eq!(book_keys(&s).await.len(), 3);
    for key in [NEAR_KEY, "near:other.test.near", EVM_KEY] {
        assert_eq!(
            view(&s, "get_book_entry", json!({ "key": key })).await["label"],
            "Landlord"
        );
    }
}

#[tokio::test]
async fn book_remove_unknown_reverts() {
    let _slot = slot().await;
    let s = with_assets().await;
    assert_fails_with(
        owner_call(&s, "book_remove", json!({ "key": NEAR_KEY })).await,
        "payee not in book",
    );
    add_ok(&s, NEAR_KEY, Some("100"), "Accountant").await;
    // a near-miss of an existing key is not that key: matching is exact
    assert_fails_with(
        owner_call(
            &s,
            "book_remove",
            json!({ "key": "near:accountant.test.nea" }),
        )
        .await,
        "payee not in book",
    );
    assert_fails_with(
        owner_call(
            &s,
            "book_remove",
            json!({ "key": "NEAR:accountant.test.near" }),
        )
        .await,
        "payee not in book",
    );
    assert_eq!(book_keys(&s).await, [NEAR_KEY]);
}

#[tokio::test]
async fn book_remove_removes_and_emits() {
    let _slot = slot().await;
    let s = with_assets().await;
    add_ok(&s, NEAR_KEY, Some("100"), "Accountant").await;
    add_ok(&s, EVM_KEY, Some("7"), "Landlord").await;
    let result = owner_call(&s, "book_remove", json!({ "key": NEAR_KEY })).await;
    let events = extract_event_logs(&result).unwrap();
    result.assert_success();
    let event = events
        .iter()
        .find(|e| e["event"] == "book_removed")
        .expect("a book_removed event");
    assert_eq!(event["data"][0]["key"], NEAR_KEY);
    assert_eq!(
        view(&s, "get_book_entry", json!({ "key": NEAR_KEY })).await,
        Value::Null
    );
    assert_eq!(book_keys(&s).await, [EVM_KEY]);
    // removed means gone: a second removal reverts
    assert_fails_with(
        owner_call(&s, "book_remove", json!({ "key": NEAR_KEY })).await,
        "payee not in book",
    );
}

#[tokio::test]
async fn invalid_label_reverts() {
    let _slot = slot().await;
    let s = with_assets().await;
    let too_long = "a".repeat(41);
    let accented = format!("Caf{}", code_point(0xE9));
    for bad in [too_long.as_str(), "Bob!", "A/B", "a\tb", accented.as_str()] {
        assert_fails_with(add(&s, NEAR_KEY, Some("1"), bad).await, "invalid label");
    }
    assert!(book_keys(&s).await.is_empty());
    // 40 characters, every allowed punctuation and the empty label are fine
    add_ok(&s, NEAR_KEY, Some("1"), &"a".repeat(40)).await;
    add_ok(&s, NEAR_KEY, Some("1"), "A b.c_d-e 9").await;
    add_ok(&s, NEAR_KEY, Some("1"), "").await;
}

#[tokio::test]
async fn book_add_replaces_the_whole_entry() {
    let _slot = slot().await;
    let s = with_assets().await;
    add_ok(&s, NEAR_KEY, Some("100"), "First").await;
    let result = owner_call(
        &s,
        "book_add",
        json!({
            "key": NEAR_KEY,
            "cap": null,
            "daily_untrusted_budget": "1",
            "daily_limit": "2",
            "label": "Second"
        }),
    )
    .await;
    result.assert_success();
    assert_eq!(
        view(&s, "get_book_entry", json!({ "key": NEAR_KEY })).await,
        json!({ "cap": null, "daily_untrusted_budget": "1", "daily_limit": "2", "label": "Second" })
    );
    assert_eq!(
        book_keys(&s).await,
        [NEAR_KEY],
        "a replace does not add an entry"
    );
}

/// `limit` 500 returns at most 50 entries (52 payees, one call each), in insertion order, and the call never reverts.
#[tokio::test]
async fn get_book_limit_is_clamped_to_50() {
    let _slot = slot().await;
    let s = with_assets().await;
    let keys: Vec<String> = (0..52)
        .map(|i| format!("near:payee{i:02}.sandbox"))
        .collect();
    for key in &keys {
        add_ok(&s, key, Some("1"), "Payee").await;
    }
    let page = view(&s, "get_book", json!({ "from_index": null, "limit": 500 })).await;
    let page = page.as_array().unwrap();
    assert_eq!(page.len(), 50, "limit 500 returns at most 50");
    assert_eq!(page[0][0], json!(keys[0]));
    assert_eq!(page[49][0], json!(keys[49]));
    assert_eq!(page[0][1]["label"], "Payee");
    let rest = view(&s, "get_book", json!({ "from_index": 50, "limit": 500 })).await;
    assert_eq!(rest.as_array().unwrap().len(), 2);
    assert_eq!(rest[0][0], json!(keys[50]));
    assert_eq!(
        view(&s, "get_book", json!({ "from_index": 1000, "limit": null })).await,
        json!([])
    );
    assert_eq!(
        view(&s, "get_book", json!({}))
            .await
            .as_array()
            .unwrap()
            .len(),
        50
    );
    assert_eq!(
        view(&s, "get_book", json!({ "from_index": 3, "limit": 2 }))
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

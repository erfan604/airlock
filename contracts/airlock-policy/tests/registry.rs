// AIR-042: the asset registry in the sandbox. One test per validation row and per rejected id string; every revert test asserts the
// message text, because a missing method also fails and would pass a bare `assert_failure()`.
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

/// The shared NEAR fixture: symbol NEAR, 24 decimals, hard cap 10,000 NEAR, daily cap 100,000 NEAR, quick task cap equal to the daily
/// cap, no fee or gas cap, no path.
fn near_entry() -> Value {
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

/// The shared EVM fixture for `evm:84532:native`: symbol ETH.base, 18 decimals, hard cap 1 ETH, daily cap 10 ETH, quick task cap
/// 5 ETH, fee cap 50 gwei, gas cap 100,000, path `base-sepolia-1`.
fn evm_entry() -> Value {
    json!({
        "symbol": "ETH.base",
        "decimals": 18,
        "hard_cap": "1000000000000000000",
        "daily_cap": "10000000000000000000",
        "max_fee_per_gas": "50000000000",
        "max_gas": "100000",
        "quick_task_cap": "5000000000000000000",
        "path": "base-sepolia-1"
    })
}

/// A token entry with its own symbol (NEAR shaped: no fee, gas or path), 6 decimals and a hard cap of 10,000 units, so that even a
/// 12 character symbol stays under the 200 byte approve argument guard (AIR-086).
fn ft_entry(symbol: &str) -> Value {
    json!({
        "symbol": symbol,
        "decimals": 6,
        "hard_cap": "10000000000",
        "daily_cap": "100000000000",
        "max_fee_per_gas": "0",
        "max_gas": "0",
        "quick_task_cap": "100000000000",
        "path": null
    })
}

/// `entry` with one field replaced.
fn with(entry: &Value, key: &str, value: Value) -> Value {
    let mut e = entry.clone();
    e[key] = value;
    e
}

const EVM_ID: &str = "evm:84532:native";

async fn set(s: &Started, asset: &str, entry: &Value) -> ExecutionFinalResult {
    owner_call(s, "asset_set", json!({ "asset": asset, "entry": entry })).await
}

/// `asset_set` must succeed.
async fn set_ok(s: &Started, asset: &str, entry: &Value) {
    let result = set(s, asset, entry).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "asset_set({asset}) failed: {text}");
    result.assert_success();
}

/// `asset_set` must revert with `text`.
async fn set_fails(s: &Started, asset: &str, entry: &Value, text: &str) {
    let result = set(s, asset, entry).await;
    let got = failure_text(&result);
    result.assert_failure();
    assert!(
        got.contains(text),
        "asset_set({asset}): expected `{text}` in: {got}"
    );
}

async fn view(s: &Started, method: &str, args: Value) -> Value {
    let answer: Data<Value> = call_view(&s.contract, method, args, &s.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"));
    answer.data
}

async fn get_asset(s: &Started, asset: &str) -> Value {
    view(s, "get_asset", json!({ "asset": asset })).await
}

async fn listed_ids(s: &Started) -> Vec<String> {
    view(s, "list_assets", json!({}))
        .await
        .as_array()
        .expect("a list")
        .iter()
        .map(|row| row[0].as_str().unwrap().to_string())
        .collect()
}

fn assert_fails_with(result: ExecutionFinalResult, text: &str) {
    let got = failure_text(&result);
    result.assert_failure();
    assert!(got.contains(text), "expected `{text}` in: {got}");
}

// ---------------------------------------------------------------------------------------------------------------------
// the asset id grammar, one test per rejected string
// ---------------------------------------------------------------------------------------------------------------------

macro_rules! rejected_id {
    ($name:ident, $id:expr) => {
        #[tokio::test]
        async fn $name() {
            let _slot = slot().await;
            let s = start().await;
            set_fails(&s, $id, &near_entry(), "invalid asset id").await;
            assert!(
                listed_ids(&s).await.is_empty(),
                "a rejected id registered nothing"
            );
        }
    };
}

rejected_id!(invalid_asset_id_usd, "USD");
rejected_id!(invalid_asset_id_trailing_space, "usdc ");
rejected_id!(invalid_asset_id_leading_space, " near");
rejected_id!(invalid_asset_id_evm_uppercase_prefix, "EVM:84532:native");
rejected_id!(invalid_asset_id_evm_capital_native, "evm:84532:Native");
rejected_id!(invalid_asset_id_evm_chain_zero, "evm:0:native");
rejected_id!(invalid_asset_id_evm_chain_leading_zero, "evm:084532:native");

#[tokio::test]
async fn ft_asset_ids_follow_the_account_grammar() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, "ft:usdc.near", &ft_entry("USDC.near")).await;
    assert_eq!(listed_ids(&s).await, ["ft:usdc.near"]);
    for bad in [
        "ft:USDC.near",
        "ft:",
        "ft:a",
        "ft:usdc..near",
        "ft:-usdc.near",
        "evm:99999999999999999999:native",
    ] {
        set_fails(&s, bad, &ft_entry("OTHER"), "invalid asset id").await;
    }
    // a path or a fee cap is still refused for a token
    set_fails(
        &s,
        "ft:abc.near",
        &with(&ft_entry("ABC"), "path", json!("p")),
        "path not allowed",
    )
    .await;
}

// ---------------------------------------------------------------------------------------------------------------------
// the checks of asset_set
// ---------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn near_registers_and_emits_the_entry() {
    let _slot = slot().await;
    let s = start().await;
    let result = set(&s, "near", &near_entry()).await;
    let events = extract_event_logs(&result).unwrap();
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    result.assert_success();
    let event = events
        .iter()
        .find(|e| e["event"] == "asset_set")
        .expect("an asset_set event");
    assert_eq!(event["standard"], "airlock");
    let data = &event["data"][0];
    assert_eq!(data["asset"], "near");
    assert_eq!(data["symbol"], "NEAR");
    assert_eq!(data["decimals"], 24);
    assert_eq!(data["hard_cap"], (10_000 * NEAR).to_string().as_str());
    assert_eq!(data["daily_cap"], (100_000 * NEAR).to_string().as_str());
    assert_eq!(
        data["quick_task_cap"],
        (100_000 * NEAR).to_string().as_str()
    );
    assert_eq!(data["path"], Value::Null);
    // the EVM asset carries its path
    let result = set(&s, EVM_ID, &evm_entry()).await;
    let events = extract_event_logs(&result).unwrap();
    result.assert_success();
    let event = events.iter().find(|e| e["event"] == "asset_set").unwrap();
    assert_eq!(event["data"][0]["path"], "base-sepolia-1");
}

#[tokio::test]
async fn invalid_symbol_reverts() {
    let _slot = slot().await;
    let s = start().await;
    for bad in ["", "ABCDEFGHIJKLM", "A B", "A_B", "N-E", "\u{c9}TH"] {
        set_fails(
            &s,
            "near",
            &with(&near_entry(), "symbol", json!(bad)),
            "invalid symbol",
        )
        .await;
    }
    // 12 characters, digits and dots are fine
    set_ok(&s, "near", &ft_entry("A1.B2.C3.D4.")).await;
    assert_eq!(get_asset(&s, "near").await["symbol"], "A1.B2.C3.D4.");
}

/// AB6: with `near` registered under `NEAR`, the same symbol on another asset reverts in any letter case, and `USDC.base` and
/// `USDC` may coexist.
#[tokio::test]
async fn ab6_symbols_unique() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, "near", &near_entry()).await;
    // the EVM asset under NEAR, `near` and `Near`
    for taken in ["NEAR", "near", "Near"] {
        set_fails(
            &s,
            EVM_ID,
            &with(&evm_entry(), "symbol", json!(taken)),
            "symbol already used",
        )
        .await;
    }
    // chain-qualified names coexist
    set_ok(&s, "ft:usdc.near", &ft_entry("USDC.near")).await;
    set_ok(&s, "ft:usdc.base.near", &ft_entry("USDC.base")).await;
    // `usdc.NEAR` is the same symbol as `USDC.near`
    set_fails(
        &s,
        "ft:other.near",
        &ft_entry("usdc.NEAR"),
        "symbol already used",
    )
    .await;
    // re-registering `near` under `NEAR` again succeeds: uniqueness ignores the entry being replaced
    set_ok(&s, "near", &near_entry()).await;
    assert_eq!(
        listed_ids(&s).await,
        ["near", "ft:usdc.near", "ft:usdc.base.near"]
    );
}

/// `10^decimals` as a decimal string: a hard cap of one whole unit.
fn one_unit(decimals: u32) -> String {
    10u128.pow(decimals).to_string()
}

/// The entry of the decimals tests: symbol `A`, a hard cap (and daily and quick cap) of one whole unit of `decimals` places.
fn unit_entry(decimals: u32) -> Value {
    json!({
        "symbol": "A",
        "decimals": decimals,
        "hard_cap": one_unit(decimals),
        "daily_cap": one_unit(decimals),
        "max_fee_per_gas": "0",
        "max_gas": "0",
        "quick_task_cap": one_unit(decimals),
        "path": null
    })
}

/// The registry accepts decimals up to 33 (symbol `A`, a hard cap of one whole unit: the approve arguments are 199 bytes); 38 reverts
/// on the 200 byte guard (AIR-086) and 39 on the older `decimals above 38`, which runs first. `decimal::parse` and `format` still
/// handle 38 places (F13); only the registry refuses an asset whose approve arguments could not be shown on a Ledger.
#[tokio::test]
async fn decimals_bound() {
    let _slot = slot().await;
    let s = start().await;
    let guard = "approve arguments could exceed 200 bytes";
    set_ok(&s, "near", &unit_entry(33)).await;
    assert_eq!(get_asset(&s, "near").await["decimals"], 33);
    set_fails(&s, "near", &unit_entry(34), guard).await;
    set_fails(&s, "near", &unit_entry(38), guard).await;
    set_fails(
        &s,
        "near",
        &with(&unit_entry(38), "decimals", json!(39)),
        "decimals above 38",
    )
    .await;
    set_fails(
        &s,
        "near",
        &with(&unit_entry(38), "decimals", json!(255)),
        "decimals above 38",
    )
    .await;
    assert_eq!(
        get_asset(&s, "near").await["decimals"],
        33,
        "a rejected call changed nothing"
    );
    set_ok(&s, "near", &unit_entry(0)).await;
}

/// The size guard of `asset_set` (AIR-086, decision R4-12): the worst-case approve arguments of an asset (the longest payee key, the
/// longest reason and book status, a ten digit pending number, the symbol, and the longest amount text up to the hard cap) must stay
/// under the 200 bytes a Ledger device shows.
#[tokio::test]
async fn approve_args_guard() {
    use airlock_verdict::approve::{
        LEDGER_LIMIT, MAX_BOOK, MAX_ID_DIGITS, MAX_TO, MAX_WHY, approve_args_len,
    };
    let _slot = slot().await;
    let s = start().await;
    let guard = "approve arguments could exceed 200 bytes";
    // a 12 character symbol, 38 decimals and a hard cap of 10^38: a 40 character worst case amount, 215 bytes
    let worst = json!({
        "symbol": "ABCDEFGHIJKL",
        "decimals": 38,
        "hard_cap": one_unit(38),
        "daily_cap": one_unit(38),
        "max_fee_per_gas": "0",
        "max_gas": "0",
        "quick_task_cap": one_unit(38),
        "path": null
    });
    set_fails(&s, "near", &worst, guard).await;
    assert_eq!(get_asset(&s, "near").await, Value::Null);
    // the demo assets register: NEAR at 10,000 NEAR (197 bytes) and ETH.base at 1 ETH (191)
    set_ok(&s, "near", &near_entry()).await;
    set_ok(&s, EVM_ID, &evm_entry()).await;
    // NEAR registers at 1,000,000 NEAR (199 bytes) and reverts at 10,000,000 NEAR (200)
    let near_at = |units: u128| {
        let cap = (units * NEAR).to_string();
        let mut e = with(&near_entry(), "hard_cap", json!(cap));
        e["daily_cap"] = json!(cap);
        e["quick_task_cap"] = json!(cap);
        e
    };
    set_ok(&s, "near", &near_at(1_000_000)).await;
    set_fails(&s, "near", &near_at(10_000_000), guard).await;
    assert_eq!(
        get_asset(&s, "near").await["hard_cap"],
        (1_000_000 * NEAR).to_string().as_str()
    );
    // symbol `A` registers at 33 decimals and reverts at 34, both with a hard cap of one whole unit
    set_ok(&s, "ft:a.near", &unit_entry(33)).await;
    set_fails(&s, "ft:a.near", &unit_entry(34), guard).await;
    // decimals above 38 are refused by the older check, which runs first
    set_fails(
        &s,
        "ft:a.near",
        &with(&unit_entry(38), "decimals", json!(39)),
        "decimals above 38",
    )
    .await;
    // for each demo asset the longest possible amount (the hard cap minus one base unit, formatted by the real `decimal::format`)
    // keeps the arguments under 200 bytes
    for (symbol, cap, decimals) in [
        ("NEAR", 10_000 * NEAR, 24u8),
        ("ETH.base", 10u128.pow(18), 18),
    ] {
        let (_, len) = airlock_verdict::decimal::format(cap - 1, decimals).unwrap();
        let args = approve_args_len(MAX_ID_DIGITS, MAX_TO, symbol.len(), len, MAX_WHY, MAX_BOOK);
        assert!(args < LEDGER_LIMIT, "{symbol}: {args} bytes");
    }
}

#[tokio::test]
async fn caps_order() {
    let _slot = slot().await;
    let s = start().await;
    let caps = "caps must satisfy 0 < hard_cap <= daily_cap";
    // hard cap above the daily cap, and a zero hard cap
    let swapped = with(
        &with(
            &near_entry(),
            "hard_cap",
            json!((100_000 * NEAR).to_string()),
        ),
        "daily_cap",
        json!((10_000 * NEAR).to_string()),
    );
    set_fails(&s, "near", &swapped, caps).await;
    set_fails(
        &s,
        "near",
        &with(&near_entry(), "hard_cap", json!("0")),
        caps,
    )
    .await;
    // equal caps are fine, and so is a very large cap
    let equal = with(
        &near_entry(),
        "daily_cap",
        json!((10_000 * NEAR).to_string()),
    );
    let equal = with(&equal, "quick_task_cap", json!((10_000 * NEAR).to_string()));
    set_ok(&s, "near", &equal).await;
    let big = 10u128.pow(20).to_string();
    let top = with(
        &with(
            &with(&near_entry(), "hard_cap", json!(big)),
            "daily_cap",
            json!(big),
        ),
        "quick_task_cap",
        json!(big),
    );
    set_ok(&s, "near", &top).await;
    // the largest u128 is a legal cap for `caps must satisfy`, but its 40 character amount text pushes the approve arguments of NEAR to
    // 207 bytes, so the size guard refuses it (AIR-086)
    let max = u128::MAX.to_string();
    let top = with(
        &with(
            &with(&near_entry(), "hard_cap", json!(max)),
            "daily_cap",
            json!(max),
        ),
        "quick_task_cap",
        json!(max),
    );
    set_fails(&s, "near", &top, "approve arguments could exceed 200 bytes").await;
}

#[tokio::test]
async fn quick_task_cap_bounds() {
    let _slot = slot().await;
    let s = start().await;
    let quick = "quick_task_cap must be above 0 and at most daily_cap";
    set_fails(
        &s,
        "near",
        &with(&near_entry(), "quick_task_cap", json!("0")),
        quick,
    )
    .await;
    let above = (100_000 * NEAR + 1).to_string();
    set_fails(
        &s,
        "near",
        &with(&near_entry(), "quick_task_cap", json!(above)),
        quick,
    )
    .await;
    set_ok(
        &s,
        "near",
        &with(&near_entry(), "quick_task_cap", json!("1")),
    )
    .await;
    assert_eq!(get_asset(&s, "near").await["quick_task_cap"], "1");
}

#[tokio::test]
async fn evm_path_required() {
    let _slot = slot().await;
    let s = start().await;
    set_fails(
        &s,
        EVM_ID,
        &with(&evm_entry(), "path", Value::Null),
        "evm path required",
    )
    .await;
    set_fails(
        &s,
        EVM_ID,
        &with(&evm_entry(), "path", json!("")),
        "evm path required",
    )
    .await;
    assert!(listed_ids(&s).await.is_empty());
}

#[tokio::test]
async fn evm_path_invalid() {
    let _slot = slot().await;
    let s = start().await;
    for bad in [
        "Base-Sepolia",
        "base sepolia",
        "base/sepolia",
        &"a".repeat(65),
    ] {
        set_fails(
            &s,
            EVM_ID,
            &with(&evm_entry(), "path", json!(bad)),
            "evm path invalid",
        )
        .await;
    }
    // 64 characters and every allowed punctuation are fine
    set_ok(
        &s,
        EVM_ID,
        &with(&evm_entry(), "path", json!("a".repeat(64))),
    )
    .await;
    set_ok(&s, EVM_ID, &with(&evm_entry(), "path", json!("a.b_c-d.9"))).await;
}

#[tokio::test]
async fn evm_path_unique() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, EVM_ID, &evm_entry()).await;
    // a second EVM asset with the same path reverts
    let other = with(&evm_entry(), "symbol", json!("ETH.main"));
    set_fails(&s, "evm:1:native", &other, "evm path already used").await;
    // another path registers, and the first asset can keep its own path when replaced
    set_ok(
        &s,
        "evm:1:native",
        &with(&other, "path", json!("ethereum-1")),
    )
    .await;
    set_ok(&s, EVM_ID, &evm_entry()).await;
    assert_eq!(listed_ids(&s).await, [EVM_ID, "evm:1:native"]);
}

#[tokio::test]
async fn evm_fee_and_gas_caps_required() {
    let _slot = slot().await;
    let s = start().await;
    let text = "evm fee and gas caps required";
    set_fails(
        &s,
        EVM_ID,
        &with(&evm_entry(), "max_fee_per_gas", json!("0")),
        text,
    )
    .await;
    set_fails(&s, EVM_ID, &with(&evm_entry(), "max_gas", json!("0")), text).await;
    set_fails(
        &s,
        EVM_ID,
        &with(&evm_entry(), "max_gas", json!("20999")),
        text,
    )
    .await;
    set_ok(&s, EVM_ID, &with(&evm_entry(), "max_gas", json!("21000"))).await;
    assert_eq!(get_asset(&s, EVM_ID).await["max_gas"], "21000");
}

#[tokio::test]
async fn path_not_allowed_for_near() {
    let _slot = slot().await;
    let s = start().await;
    set_fails(
        &s,
        "near",
        &with(&near_entry(), "path", json!("base-sepolia-1")),
        "path not allowed",
    )
    .await;
    set_fails(
        &s,
        "near",
        &with(&near_entry(), "path", json!("")),
        "path not allowed",
    )
    .await;
    assert!(listed_ids(&s).await.is_empty());
}

#[tokio::test]
async fn fee_and_gas_caps_only_for_evm() {
    let _slot = slot().await;
    let s = start().await;
    let text = "fee and gas caps only for evm";
    set_fails(
        &s,
        "near",
        &with(&near_entry(), "max_fee_per_gas", json!("1")),
        text,
    )
    .await;
    set_fails(
        &s,
        "near",
        &with(&near_entry(), "max_gas", json!("1")),
        text,
    )
    .await;
    set_fails(
        &s,
        "ft:usdc.near",
        &with(&ft_entry("USDC"), "max_gas", json!("21000")),
        text,
    )
    .await;
    assert!(listed_ids(&s).await.is_empty());
}

#[tokio::test]
async fn checks_run_in_the_documented_order() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, "near", &near_entry()).await;
    // everything wrong at once: the first check names the error, then the next once the first is fixed
    let mut bad = with(&evm_entry(), "symbol", json!("not valid!"));
    bad["decimals"] = json!(99);
    bad["hard_cap"] = json!("0");
    bad["quick_task_cap"] = json!("0");
    bad["path"] = Value::Null;
    bad["max_gas"] = json!("0");
    set_fails(&s, "bad id", &bad, "invalid asset id").await;
    set_fails(&s, EVM_ID, &bad, "invalid symbol").await;
    bad["symbol"] = json!("NEAR");
    set_fails(&s, EVM_ID, &bad, "symbol already used").await;
    bad["symbol"] = json!("ETH.base");
    set_fails(&s, EVM_ID, &bad, "decimals above 38").await;
    bad["decimals"] = json!(18);
    set_fails(
        &s,
        EVM_ID,
        &bad,
        "caps must satisfy 0 < hard_cap <= daily_cap",
    )
    .await;
    bad["hard_cap"] = json!("1000000000000000000");
    set_fails(
        &s,
        EVM_ID,
        &bad,
        "quick_task_cap must be above 0 and at most daily_cap",
    )
    .await;
    bad["quick_task_cap"] = json!("5000000000000000000");
    set_fails(&s, EVM_ID, &bad, "evm path required").await;
    bad["path"] = json!("Bad Path");
    set_fails(&s, EVM_ID, &bad, "evm path invalid").await;
    bad["path"] = json!("base-sepolia-1");
    set_fails(&s, EVM_ID, &bad, "evm fee and gas caps required").await;
    bad["max_gas"] = json!("100000");
    set_ok(&s, EVM_ID, &bad).await;
}

/// 16 distinct ids fit, the 17th reverts `registry full`, a replace never trips it, and a removal makes room.
#[tokio::test]
async fn registry_full() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, "near", &near_entry()).await;
    for i in 1..16 {
        set_ok(
            &s,
            &format!("ft:t{i:02}.near"),
            &ft_entry(&format!("T{i:02}")),
        )
        .await;
    }
    assert_eq!(listed_ids(&s).await.len(), 16);
    set_fails(&s, "ft:t99.near", &ft_entry("T99"), "registry full").await;
    // a replace of a registered id is fine at 16
    set_ok(&s, "near", &with(&near_entry(), "decimals", json!(18))).await;
    assert_eq!(listed_ids(&s).await.len(), 16);
    // removing one makes room for another id
    owner_call(&s, "asset_remove", json!({ "asset": "ft:t05.near" }))
        .await
        .assert_success();
    set_ok(&s, "ft:t99.near", &ft_entry("T99")).await;
    assert_eq!(listed_ids(&s).await.len(), 16);
}

#[tokio::test]
async fn asset_set_replaces_an_entry() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, "near", &near_entry()).await;
    let changed = with(
        &with(&near_entry(), "decimals", json!(12)),
        "hard_cap",
        json!("5000"),
    );
    set_ok(&s, "near", &changed).await;
    let got = get_asset(&s, "near").await;
    assert_eq!(got["decimals"], 12);
    assert_eq!(got["hard_cap"], "5000");
    assert_eq!(
        listed_ids(&s).await,
        ["near"],
        "a replace does not add an entry"
    );
}

#[tokio::test]
async fn changed_symbol_frees_the_old_one() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, "near", &near_entry()).await;
    set_fails(
        &s,
        EVM_ID,
        &with(&evm_entry(), "symbol", json!("NEAR")),
        "symbol already used",
    )
    .await;
    set_ok(&s, "near", &with(&near_entry(), "symbol", json!("N2"))).await;
    // `NEAR` is free now, and `N2` is taken
    set_ok(&s, EVM_ID, &with(&evm_entry(), "symbol", json!("NEAR"))).await;
    set_fails(&s, "ft:x.near", &ft_entry("n2"), "symbol already used").await;
}

#[tokio::test]
async fn asset_remove_unknown_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let result = owner_call(&s, "asset_remove", json!({ "asset": "near" })).await;
    assert_fails_with(result, "unknown asset");
    set_ok(&s, "near", &near_entry()).await;
    let result = owner_call(&s, "asset_remove", json!({ "asset": EVM_ID })).await;
    assert_fails_with(result, "unknown asset");
    assert_eq!(listed_ids(&s).await, ["near"]);
}

#[tokio::test]
async fn asset_remove_frees_the_symbol_and_emits() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, "near", &near_entry()).await;
    let result = owner_call(&s, "asset_remove", json!({ "asset": "near" })).await;
    let events = extract_event_logs(&result).unwrap();
    result.assert_success();
    let event = events
        .iter()
        .find(|e| e["event"] == "asset_removed")
        .expect("an asset_removed event");
    assert_eq!(event["data"][0]["asset"], "near");
    assert_eq!(get_asset(&s, "near").await, Value::Null);
    assert!(listed_ids(&s).await.is_empty());
    // the symbol is free again, for the same id or another
    set_ok(&s, EVM_ID, &with(&evm_entry(), "symbol", json!("NEAR"))).await;
}

/// A stranger, the agent account, no deposit and two yocto each revert, for `asset_set` and for `asset_remove`.
#[tokio::test]
async fn owner_only() {
    let _slot = slot().await;
    let s = start().await;
    set_ok(&s, "near", &near_entry()).await;
    let (stranger, stranger_signer) = account(&s, "stranger").await;
    let (agent, agent_signer) = account(&s, "agent").await;
    let set_args = json!({ "asset": "ft:usdc.near", "entry": ft_entry("USDC") });
    let remove_args = json!({ "asset": "near" });
    for (who, signer, deposit, text) in [
        (&stranger, &stranger_signer, 1u128, NOT_OWNER_TEXT),
        (&agent, &agent_signer, 1, NOT_OWNER_TEXT),
        (&s.owner, &s.owner_signer, 0, ONE_YOCTO_TEXT),
        (&s.owner, &s.owner_signer, 2, ONE_YOCTO_TEXT),
        // the one yocto check runs first, so a stranger with no deposit is told about the deposit
        (&stranger, &stranger_signer, 0, ONE_YOCTO_TEXT),
    ] {
        for (method, args) in [("asset_set", &set_args), ("asset_remove", &remove_args)] {
            let result = call_transaction(
                &s.contract,
                method,
                args.clone(),
                who,
                signer,
                &s.net,
                Some(NearToken::from_yoctonear(deposit)),
            )
            .await
            .unwrap();
            let got = failure_text(&result);
            result.assert_failure();
            assert!(
                got.contains(text),
                "{method} as {who} with {deposit} yocto: expected `{text}` in: {got}"
            );
        }
    }
    assert_eq!(
        listed_ids(&s).await,
        ["near"],
        "no failed call changed the registry"
    );
}

async fn account(s: &Started, name: &str) -> (AccountId, Arc<Signer>) {
    create_user_account(&s.net, &s.owner, &s.owner_signer, name)
        .await
        .expect("the account is created")
}

/// `get_asset` and `list_assets` answer in the sandbox (a missing export fails), with every u128 as a string.
#[tokio::test]
async fn views_exported() {
    let _slot = slot().await;
    let s = start().await;
    assert_eq!(get_asset(&s, "near").await, Value::Null);
    assert_eq!(view(&s, "list_assets", json!({})).await, json!([]));
    set_ok(&s, "near", &near_entry()).await;
    set_ok(&s, EVM_ID, &evm_entry()).await;
    assert_eq!(get_asset(&s, "near").await, near_entry());
    assert_eq!(get_asset(&s, EVM_ID).await, evm_entry());
    let list = view(&s, "list_assets", json!({})).await;
    assert_eq!(list, json!([["near", near_entry()], [EVM_ID, evm_entry()]]));
}

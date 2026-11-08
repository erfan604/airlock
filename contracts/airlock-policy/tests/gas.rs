// AIR-107: gas measurement in the sandbox (the pre-check; the published numbers come from testnet, scripts/gas-testnet.ts).
//
// A call must carry at least `need = burnt_first + reserved`: the gas its own receipt burns plus the gas it attaches to the promises it
// creates (a call with less fails with `Exceeded the prepaid gas.`). Each scenario prints one line
//   GAS ROW <name> burnt_total=<n> burnt_first=<n> reserved=<n> need=<n>
// in Tgas with three decimals, after one `GAS TABLE` header line. `burnt_total` is the sum of every receipt of the call (`as_gas()`),
// `burnt_first` the burn of `receipt_outcomes()[0]` (the call's own receipt), and `reserved` is computed from the events and the
// constants of `airlock_policy::exec`: `GAS_MPC_SIGN + GAS_ON_SIGNED` per `evm_unsigned` event and `GAS_ON_TRANSFER` per NEAR payment
// (a `paid` event, or a `failed` event with reason `TransferFailed`). The lane promises are built with `with_static_gas`, and the signer
// call also with `with_unused_gas_weight(0)`, so `reserved` is what the call attaches.
//
// Sandbox neard 2.11.0 is protocol 83 and testnet runs protocol 88: these numbers are indicative, docs/gas.md says so.
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first. Run with `-- --nocapture --test-threads=2`.

mod common;

use airlock_policy::exec::{GAS_MPC_SIGN, GAS_ON_SIGNED, GAS_ON_TRANSFER};
use airlock_policy::request::request_id;
use airlock_policy::task::task_hash;
use common::*;
use near_api::{Contract, NearGas, NearToken};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use serde_json::{Value, json};
use std::sync::Once;
use std::time::Duration;

const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
const POLICY: u16 = airlock_verdict::POLICY;
const ORACLE: u16 = airlock_verdict::ORACLE;
const EMAIL: u16 = airlock_verdict::labels::EMAIL;

const GWEI: u128 = 1_000_000_000;
const EVM: (u128, u128, u128) = (21_000, 2 * GWEI, GWEI);
const AMOUNT: u128 = 10_000_000_000_000_000; // 10^16 wei
const TGAS: u64 = 1_000_000_000_000;
/// 25 percent headroom under the 300 Tgas budget of a `submit_batch`.
const BATCH_NEED_MAX: u64 = 225 * TGAS;
const NOT_ENOUGH: &str = "Exceeded the prepaid gas.";

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

fn evm_task(w: &World, max_actions: u8) -> Task {
    w.signed_task(&[(&payee_key(w), ONE_ETH)], max_actions)
}

fn evm_req(w: &World, task: &Task, index: u8, amount: u128, labels: (u16, u16, u16)) -> Value {
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

fn clean(w: &World, task: &Task, index: u8) -> Value {
    evm_req(w, task, index, AMOUNT, (BOOK, OWNER, OWNER))
}

fn near_req(w: &World, task: &Task, index: u8, payee: &str, amount: u128) -> Value {
    w.request_json(
        &task.0,
        index,
        "near",
        payee,
        amount,
        (BOOK, OWNER, OWNER),
        None,
    )
}

fn id_of(task: &Task, index: u8) -> String {
    request_id(&task_hash(&task.0), index)
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

/// A call of the policy contract with `tgas` prepaid and `yocto` attached; a failed receipt is not an error, inspect `failure_text`.
async fn call_with(
    w: &World,
    who: (&near_api::AccountId, &std::sync::Arc<near_api::Signer>),
    method: &str,
    args: Value,
    yocto: u128,
    tgas: u64,
) -> ExecutionFinalResult {
    let sent = Contract(w.policy.clone())
        .call_function(method, common::shim_args(&w.policy, &w.net, method, args))
        .transaction()
        .gas(NearGas::from_tgas(tgas))
        .deposit(NearToken::from_yoctonear(yocto))
        .with_signer(who.0.clone(), who.1.clone())
        .send_to(&w.net)
        .await
        .expect("the call is sent");
    match sent {
        TransactionResult::Full(r) => *r,
        other => panic!("the call did not finish: {other:?}"),
    }
}

/// `submit_batch` as the agent with `tgas` prepaid.
async fn submit_with(w: &World, reqs: Vec<Value>, task: &Task, tgas: u64) -> ExecutionFinalResult {
    call_with(
        w,
        (&w.agent, &w.agent_signer),
        "submit_batch",
        json!({ "reqs": reqs, "task": task.0, "task_sig": task.1 }),
        0,
        tgas,
    )
    .await
}

async fn submit_ok(w: &World, reqs: Vec<Value>, task: &Task) -> ExecutionFinalResult {
    let result = w.submit(reqs, task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    result
}

/// The six strings of the card of the pending escalation `no`, from `get_pending`.
async fn card_of(w: &World, no: &str) -> Value {
    let found = view(w, &w.policy, "get_pending", json!({})).await;
    let item = found
        .as_array()
        .expect("get_pending is an array")
        .iter()
        .find(|v| v["id"] == no)
        .unwrap_or_else(|| panic!("pending {no} is not in {found}"))
        .clone();
    json!({
        "id": no,
        "to": item["payee"],
        "asset": item["display"]["asset_symbol"],
        "amount": item["display"]["amount_decimal"],
        "why": item["reason"],
        "book": item["book_status"]
    })
}

async fn pending_ids(w: &World) -> Vec<String> {
    view(w, &w.policy, "get_pending", json!({}))
        .await
        .as_array()
        .expect("get_pending is an array")
        .iter()
        .map(|v| v["id"].as_str().expect("an id").to_string())
        .collect()
}

// ---- the table ---------------------------------------------------------------------------------------------------------------------

/// One measured call, in gas units.
#[derive(Clone, Copy, Debug)]
struct Row {
    burnt_total: u64,
    burnt_first: u64,
    reserved: u64,
}

impl Row {
    fn need(&self) -> u64 {
        self.burnt_first + self.reserved
    }
}

fn tgas3(gas: u64) -> String {
    format!("{:.3}", gas as f64 / 1e12)
}

/// The gas this call attaches to the promises it creates, from its events and the constants of `exec.rs`.
fn reserved_gas(r: &ExecutionFinalResult) -> u64 {
    let evm = events(r, "evm_unsigned").len() as u64;
    let paid = events(r, "paid").len() as u64;
    let transfer_failed = events(r, "failed")
        .iter()
        .filter(|e| e["reason"] == "TransferFailed")
        .count() as u64;
    evm * (GAS_MPC_SIGN.as_gas() + GAS_ON_SIGNED.as_gas())
        + (paid + transfer_failed) * GAS_ON_TRANSFER.as_gas()
}

fn measure(r: &ExecutionFinalResult) -> Row {
    let first = r
        .receipt_outcomes()
        .first()
        .expect("the call has a receipt");
    Row {
        burnt_total: r.total_gas_burnt.as_gas(),
        burnt_first: first.gas_burnt.as_gas(),
        reserved: reserved_gas(r),
    }
}

static HEADER: Once = Once::new();

/// Prints the `GAS TABLE` header once, then the row.
fn print_row(name: &str, row: Row) {
    HEADER.call_once(|| println!("GAS TABLE"));
    println!(
        "GAS ROW {name} burnt_total={} burnt_first={} reserved={} need={}",
        tgas3(row.burnt_total),
        tgas3(row.burnt_first),
        tgas3(row.reserved),
        tgas3(row.need())
    );
}

/// `measure`, then `print_row`.
fn record(name: &str, r: &ExecutionFinalResult) -> Row {
    let row = measure(r);
    print_row(name, row);
    row
}

fn assert_first_receipt_is_policy(w: &World, r: &ExecutionFinalResult) {
    assert_eq!(
        r.receipt_outcomes()[0].executor_id,
        w.policy,
        "the first receipt is the call on the policy contract"
    );
}

// ---- the nine rows -------------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn near_allow() {
    let _slot = slot().await;
    let w = world().await;
    let task = w.signed_task(&[("near:alice.sandbox", 100 * ONE_NEAR)], 3);
    let req = near_req(&w, &task, 0, "near:alice.sandbox", ONE_NEAR);
    let result = submit_ok(&w, vec![req], &task).await;
    assert_eq!(events(&result, "allowed").len(), 1);
    assert_eq!(events(&result, "paid").len(), 1);
    assert_first_receipt_is_policy(&w, &result);
    let row = record("near_allow", &result);
    assert_eq!(row.reserved, GAS_ON_TRANSFER.as_gas());
}

#[tokio::test]
async fn evm_allow() {
    let _slot = slot().await;
    let w = world().await;
    let task = evm_task(&w, 3);
    let result = submit_ok(&w, vec![clean(&w, &task, 0)], &task).await;
    assert_eq!(events(&result, "evm_unsigned").len(), 1);
    assert_eq!(events(&result, "signed").len(), 1);
    assert_first_receipt_is_policy(&w, &result);
    let row = record("evm_allow", &result);
    assert!(
        row.burnt_total < 30 * TGAS,
        "evm_allow burnt {} Tgas, the ceiling is 30",
        tgas3(row.burnt_total)
    );
    assert_eq!(row.reserved, 35 * TGAS);
}

#[tokio::test]
async fn evm_batch3() {
    let _slot = slot().await;
    let w = world().await;
    let task = evm_task(&w, 3);
    let reqs = (0..3).map(|i| clean(&w, &task, i)).collect();
    let result = submit_ok(&w, reqs, &task).await;
    assert_eq!(events(&result, "evm_unsigned").len(), 3);
    assert_eq!(events(&result, "signed").len(), 3);
    assert_first_receipt_is_policy(&w, &result);
    let row = record("evm_batch3", &result);
    assert_eq!(row.reserved, 105 * TGAS);
    assert!(
        row.need() <= BATCH_NEED_MAX,
        "evm_batch3 needs {} Tgas, the ceiling is 225",
        tgas3(row.need())
    );
}

/// 16 bounds on distinct 52-character EVM keys, three EVM Allows whose labels carry every bit the gate accepts (recipient Owner, Book and
/// Policy together, amount and pc Owner and Oracle together): the largest task the contract verifies and the widest label masks.
#[tokio::test]
async fn worst_case_batch3() {
    let _slot = slot().await;
    let w = world().await;
    let own = payee_key(&w);
    let others: Vec<String> = (1..=15)
        .map(|i| format!("evm:84532:0x{:040x}", 0xabc0_0000u64 + i))
        .collect();
    for key in &others {
        assert_eq!(key.len(), 52, "{key}");
    }
    let mut bounds: Vec<(&str, u128)> = vec![(&own, ONE_ETH)];
    bounds.extend(others.iter().map(|k| (k.as_str(), ONE_ETH)));
    assert_eq!(bounds.len(), 16);
    let task = w.signed_task(&bounds, 3);
    let labels = (OWNER | BOOK | POLICY, OWNER | ORACLE, OWNER | ORACLE);
    let reqs = (0..3)
        .map(|i| evm_req(&w, &task, i, AMOUNT, labels))
        .collect();
    let result = submit_ok(&w, reqs, &task).await;
    assert_eq!(events(&result, "allowed").len(), 3, "three Allows");
    assert_eq!(events(&result, "evm_unsigned").len(), 3);
    assert_eq!(events(&result, "signed").len(), 3);
    assert_first_receipt_is_policy(&w, &result);
    let row = record("worst_case_batch3", &result);
    assert_eq!(row.reserved, 105 * TGAS);
    assert!(
        row.need() <= BATCH_NEED_MAX,
        "worst_case_batch3 needs {} Tgas, the ceiling is 225",
        tgas3(row.need())
    );
    // the first receipt stays under the protocol 88 log limits: max_total_log_length 16384 bytes, max_number_logs 100
    let logs = &result.receipt_outcomes()[0].logs;
    let bytes: usize = logs.iter().map(String::len).sum();
    println!("LOGS first_receipt bytes={bytes} entries={}", logs.len());
    assert!(bytes < 16_384, "{bytes} bytes of logs in the first receipt");
    assert!(
        logs.len() < 100,
        "{} log entries in the first receipt",
        logs.len()
    );
}

#[tokio::test]
async fn escalate3() {
    let _slot = slot().await;
    // the flood world books alice with a cap of 0.001 NEAR, so 0.002 NEAR from an untrusted amount escalates
    let w = flood_world().await;
    let task = flood_task(&w);
    let reqs = (0..3)
        .map(|i| {
            w.request_json(
                &task.0,
                i,
                "near",
                "near:alice.sandbox",
                2 * U,
                (BOOK, EMAIL, OWNER),
                None,
            )
        })
        .collect();
    let result = submit_ok(&w, reqs, &task).await;
    assert_eq!(events(&result, "escalated").len(), 3);
    assert_first_receipt_is_policy(&w, &result);
    let row = record("escalate3", &result);
    assert_eq!(row.reserved, 0);
}

#[tokio::test]
async fn mixed() {
    let _slot = slot().await;
    let w = world().await;
    let task = evm_task(&w, 3);
    let allow = clean(&w, &task, 0);
    let escalate = evm_req(&w, &task, 1, AMOUNT, (BOOK, EMAIL, OWNER));
    // 2 ETH is over the hard cap of 1 ETH: Block AmountOutOfBounds
    let block = evm_req(&w, &task, 2, 2 * ONE_ETH, (BOOK, OWNER, OWNER));
    let result = submit_ok(&w, vec![allow, escalate, block], &task).await;
    assert_eq!(events(&result, "allowed").len(), 1);
    assert_eq!(events(&result, "escalated").len(), 1);
    assert_eq!(events(&result, "blocked").len(), 1);
    assert_first_receipt_is_policy(&w, &result);
    let row = record("mixed", &result);
    assert_eq!(row.reserved, 35 * TGAS);
}

/// The approve sweep: one EVM escalation, then `approve` as the owner with 30, 40, ... 150 Tgas on the same pending request. A failed
/// approve changes nothing (the promise creation panics), so the request stays pending until the first success.
#[tokio::test]
async fn approve_sweep() {
    let _slot = slot().await;
    let w = world().await;
    let task = evm_task(&w, 3);
    let esc = evm_req(&w, &task, 0, AMOUNT, (BOOK, EMAIL, OWNER));
    let result = submit_ok(&w, vec![esc], &task).await;
    let outcomes: Value = result.json().expect("outcomes");
    assert_eq!(outcomes[0]["outcome"], "escalated", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "UntrustedAmount", "{outcomes}");
    let no = pending_id_of(&outcomes[0]).await;
    let id = id_of(&task, 0);
    let card = card_of(&w, &no).await;
    let nonce_before = nonce_of(&w).await;

    let mut failed_below: Option<u64> = None;
    let mut found: Option<(u64, ExecutionFinalResult)> = None;
    for tgas in (30..=150).step_by(10) {
        let r = call_with(
            &w,
            (&w.owner, &w.owner_signer),
            "approve",
            card.clone(),
            1,
            tgas,
        )
        .await;
        let text = failure_text(&r);
        if text.is_empty() {
            found = Some((tgas, r));
            break;
        }
        assert!(text.contains(NOT_ENOUGH), "{tgas} Tgas: {text}");
        assert!(
            pending_ids(&w).await.contains(&no),
            "the request must still be in get_pending after a failure at {tgas} Tgas"
        );
        assert_eq!(
            w.request(&id).await.expect("the request exists")["state"],
            "Pending"
        );
        assert_eq!(nonce_of(&w).await, nonce_before);
        failed_below = Some(tgas);
    }
    let (n, result) = found.expect("approve succeeds at some prepaid gas up to 150 Tgas");
    if n > 30 {
        assert_eq!(failed_below, Some(n - 10), "the step below {n} failed");
    }
    assert_eq!(events(&result, "approved").len(), 1);
    assert_eq!(events(&result, "evm_unsigned").len(), 1);
    assert_first_receipt_is_policy(&w, &result);
    let row = record("approve_evm", &result);
    assert_eq!(row.reserved, 35 * TGAS);
    assert!(
        n * TGAS >= row.need(),
        "approve succeeded at {n} Tgas with a need of {}",
        tgas3(row.need())
    );
    let m = (n * 13).div_ceil(10);
    println!("APPROVE_MIN_TGAS={n} sandbox");
    println!("APPROVE_PREPAID_TGAS_SANDBOX={m}");
}

/// `set_flags` with the defaults and a pending time to live of `ttl_ms`.
async fn set_ttl(w: &World, ttl_ms: u64) {
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": 3,
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

async fn escalated_world() -> (World, Task) {
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    ensure_day_window(&w, 180_000).await;
    let task = flood_task(&w);
    (w, task)
}

#[tokio::test]
async fn reject() {
    let _slot = slot().await;
    let (w, task) = escalated_world().await;
    let out = escalate(&w, &task, 0).await;
    assert_eq!(out["outcome"], "escalated", "{out}");
    let no = pending_id_of(&out).await;
    let r = call_with(
        &w,
        (&w.owner, &w.owner_signer),
        "reject",
        json!({ "id": no }),
        1,
        30,
    )
    .await;
    assert_eq!(failure_text(&r), "", "reject failed");
    assert_eq!(events(&r, "rejected").len(), 1);
    assert_first_receipt_is_policy(&w, &r);
    let row = record("reject", &r);
    assert_eq!(row.reserved, 0);
}

#[tokio::test]
async fn expire() {
    let _slot = slot().await;
    let (w, task) = escalated_world().await;
    set_ttl(&w, 1).await;
    let out = escalate(&w, &task, 0).await;
    assert_eq!(out["outcome"], "escalated", "{out}");
    let no = pending_id_of(&out).await;
    // sandbox blocks come about every 1.5 s: after 3 s the block of the next call is past the expiry
    tokio::time::sleep(Duration::from_secs(3)).await;
    let r = call_with(
        &w,
        (&w.agent, &w.agent_signer),
        "expire",
        json!({ "id": no }),
        0,
        30,
    )
    .await;
    assert_eq!(failure_text(&r), "", "expire failed");
    assert_eq!(events(&r, "expired").len(), 1);
    assert_first_receipt_is_policy(&w, &r);
    let row = record("expire", &r);
    assert_eq!(row.reserved, 0);
}

// ---- callback headroom (NEAR audit detector `prepaid-gas`) -------------------------------------------------------------------------

/// The gas burnt by the receipt whose logs hold the event `name`.
fn receipt_burn_with_event(r: &ExecutionFinalResult, name: &str) -> u64 {
    let hit = r.receipt_outcomes().iter().find(|o| {
        o.logs.iter().any(|log| {
            log.strip_prefix("EVENT_JSON:")
                .and_then(|j| serde_json::from_str::<Value>(j).ok())
                .is_some_and(|v| v["event"] == name)
        })
    });
    hit.unwrap_or_else(|| panic!("no receipt holds a `{name}` event"))
        .gas_burnt
        .as_gas()
}

#[tokio::test]
async fn callback_gas_headroom() {
    let _slot = slot().await;
    let w = world().await;
    let near_task = w.signed_task(
        &[
            ("near:alice.sandbox", 100 * ONE_NEAR),
            ("near:ghost.sandbox", 100 * ONE_NEAR),
        ],
        6,
    );
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "book_add",
        json!({
            "key": "near:ghost.sandbox",
            "cap": (100 * ONE_NEAR).to_string(),
            "daily_untrusted_budget": (1_000 * ONE_NEAR).to_string(),
            "daily_limit": (5_000 * ONE_NEAR).to_string(),
            "label": "Ghost"
        }),
    )
    .await;

    // on_signed, success path: the mock answers
    let evm_task = evm_task(&w, 6);
    let first = submit_ok(&w, vec![clean(&w, &evm_task, 0)], &evm_task).await;
    assert_eq!(events(&first, "signed").len(), 1);
    let signed_ok = receipt_burn_with_event(&first, "signed");
    let first_row = measure(&first);

    // on_signed, refund path: the mock fails
    w.set_mpc_mode("fail").await;
    let failed = w.submit(vec![clean(&w, &evm_task, 1)], &evm_task).await;
    assert_eq!(events(&failed, "failed").len(), 1, "an MpcFailed event");
    let signed_fail = receipt_burn_with_event(&failed, "failed");
    w.set_mpc_mode("ok").await;

    // on_transfer, success and refund paths
    let paid = submit_ok(
        &w,
        vec![near_req(&w, &near_task, 0, "near:alice.sandbox", ONE_NEAR)],
        &near_task,
    )
    .await;
    assert_eq!(events(&paid, "paid").len(), 1);
    let transfer_ok = receipt_burn_with_event(&paid, "paid");
    // the transfer receipt to the missing account fails (AccountDoesNotExist) and `on_transfer` refunds: that is the path measured
    let ghost = w
        .submit(
            vec![near_req(&w, &near_task, 1, "near:ghost.sandbox", ONE_NEAR)],
            &near_task,
        )
        .await;
    for outcome in ghost.failures() {
        assert_eq!(
            outcome.executor_id.as_str(),
            "ghost.sandbox",
            "unexpected failure: {outcome:?}"
        );
    }
    let ghost_failed = events(&ghost, "failed");
    assert_eq!(ghost_failed.len(), 1, "{ghost_failed:?}");
    assert_eq!(ghost_failed[0]["reason"], "TransferFailed");
    let transfer_fail = receipt_burn_with_event(&ghost, "failed");

    println!(
        "CALLBACK GAS on_signed_ok={} on_signed_fail={} on_transfer_ok={} on_transfer_fail={} Tgas",
        tgas3(signed_ok),
        tgas3(signed_fail),
        tgas3(transfer_ok),
        tgas3(transfer_fail)
    );
    let signed_cap = GAS_ON_SIGNED.as_gas() / 4 * 3;
    let transfer_cap = GAS_ON_TRANSFER.as_gas() / 4 * 3;
    assert!(
        signed_ok <= signed_cap,
        "on_signed ok burnt {}",
        tgas3(signed_ok)
    );
    assert!(
        signed_fail <= signed_cap,
        "on_signed refund burnt {}",
        tgas3(signed_fail)
    );
    assert!(
        transfer_ok <= transfer_cap,
        "on_transfer ok burnt {}",
        tgas3(transfer_ok)
    );
    assert!(
        transfer_fail <= transfer_cap,
        "on_transfer refund burnt {}",
        tgas3(transfer_fail)
    );

    // a call 5 Tgas below its need reverts whole: no ledger charge, no nonce, no record
    let need = first_row.need();
    let tgas_short = (need - 5 * TGAS) / TGAS;
    let before_ledgers = w.ledgers(&payee_key(&w), WORLD_EVM_ASSET).await;
    let before_nonce = nonce_of(&w).await;
    assert!(w.request(&id_of(&evm_task, 2)).await.is_none());
    let short = submit_with(&w, vec![clean(&w, &evm_task, 2)], &evm_task, tgas_short).await;
    let text = failure_text(&short);
    assert!(
        text.contains(NOT_ENOUGH),
        "{tgas_short} Tgas (need {}): {text}",
        tgas3(need)
    );
    assert_eq!(
        w.ledgers(&payee_key(&w), WORLD_EVM_ASSET).await,
        before_ledgers
    );
    assert_eq!(nonce_of(&w).await, before_nonce);
    assert!(w.request(&id_of(&evm_task, 2)).await.is_none());
}

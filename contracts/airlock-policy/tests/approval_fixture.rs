// AIR-085: one real sandbox approval per lane, the producer of the offline fixtures of scripts/verify-approval.ts.
// `approval_fixture_near` escalates one NEAR request (`flood_world`, `escalate`) and approves it as the owner; `approval_fixture_evm`
// escalates one EVM request (`world`, mock MPC in `ok` mode) and approves it. Both assert the approval succeeded and that the
// events and the stored record look as the verifier expects. When `APPROVAL_FIXTURE_DIR` is set, each test also writes
//   approval-<lane>-ok-outcome.json   the `result` of `EXPERIMENTAL_tx_status` for the approve transaction (over the sandbox RPC)
//   approval-<lane>-ok-state.json     { "policy": get_policy, "request": get_request(id) } read after the approval
// Without the variable the tests only assert. Run with `-- --test-threads=1`.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::request::request_id;
use airlock_policy::task::task_hash;
use common::*;
use near_api::{Contract, NearGas, NearToken};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use serde_json::{Value, json};

const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
const EMAIL: u16 = airlock_verdict::labels::EMAIL;

const GWEI: u128 = 1_000_000_000;
const EVM_PARAMS: (u128, u128, u128) = (21_000, 2 * GWEI, GWEI);
const EVM_AMOUNT: u128 = 10_000_000_000_000_000; // 0.01 ETH

type Task = (
    airlock_policy::task::OwnerTask,
    near_sdk::json_types::Base64VecU8,
);

/// The owner's approve: exactly 1 yocto and 150 Tgas prepaid (SPEC R5-12).
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

/// The six arguments of `approve`, typed from the stored request exactly as the wallet card shows them.
fn card_of(stored: &Value) -> Value {
    json!({
        "id": stored["id"],
        "to": stored["payee"],
        "asset": stored["display"]["asset_symbol"],
        "amount": stored["display"]["amount_decimal"],
        "why": stored["reason"],
        "book": stored["book_status"]
    })
}

async fn view(w: &World, method: &str, args: Value) -> Value {
    call_view::<Value>(&w.policy, method, args, &w.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
        .data
}

/// The `result` of `EXPERIMENTAL_tx_status` for `hash`, fetched with curl over the sandbox RPC.
fn tx_status(w: &World, hash: &str) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "EXPERIMENTAL_tx_status",
        "params": { "tx_hash": hash, "sender_account_id": "sandbox", "wait_until": "FINAL" }
    })
    .to_string();
    let url = format!(
        "http://{}",
        w.sandbox.rpc_addr.trim_start_matches("http://")
    );
    let out = std::process::Command::new("curl")
        .args([
            "-s",
            "-X",
            "POST",
            "-H",
            "content-type: application/json",
            "-d",
            &body,
            &url,
        ])
        .output()
        .expect("curl runs");
    let v: Value = serde_json::from_slice(&out.stdout).expect("the tx status parses");
    assert!(v.get("error").is_none(), "tx status failed: {v}");
    v["result"].clone()
}

/// Writes the two fixture files of `lane` when `APPROVAL_FIXTURE_DIR` is set.
async fn capture(w: &World, lane: &str, approved: &ExecutionFinalResult, id: &str) {
    let hash = approved.outcomes()[0].transaction_hash.to_string();
    let result = tx_status(w, &hash);
    assert!(
        result["receipts_outcome"][0]["outcome"]["logs"].is_array(),
        "no receipts_outcome in {result}"
    );
    let state = json!({
        "policy": view(w, "get_policy", json!({})).await,
        "request": view(w, "get_request", json!({ "id": id })).await,
    });
    let Ok(dir) = std::env::var("APPROVAL_FIXTURE_DIR") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("the fixture dir exists");
    let write = |name: String, v: &Value| {
        let text = serde_json::to_string_pretty(v).expect("json") + "\n";
        std::fs::write(dir.join(name), text).expect("the fixture is written");
    };
    write(format!("approval-{lane}-ok-outcome.json"), &result);
    write(format!("approval-{lane}-ok-state.json"), &state);
}

fn event_names(r: &ExecutionFinalResult) -> Vec<String> {
    extract_event_logs(r)
        .expect("the events parse")
        .iter()
        .map(|e| e["event"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test]
async fn approval_fixture_near() {
    let w = flood_world().await;
    let task: Task = flood_task(&w);
    let outcome = escalate(&w, &task, 0).await;
    assert_eq!(outcome["outcome"], "escalated", "{outcome}");
    let id = request_id(&task_hash(&task.0), 0);
    let stored = w.request(&id).await.expect("the request is stored");
    assert_eq!(stored["state"], "Pending", "{stored}");
    let card = card_of(&stored);
    assert_eq!(card["to"], "near:alice.sandbox");
    assert_eq!(card["asset"], "NEAR", "{stored}");
    let approved = approve_150(&w, card).await;
    let text = failure_text(&approved);
    assert!(text.is_empty(), "approve failed: {text}");
    let names = event_names(&approved);
    assert!(names.contains(&"approved".to_string()), "{names:?}");
    assert!(names.contains(&"paid".to_string()), "{names:?}");
    assert_eq!(events(&approved, "paid").len(), 1);
    let after = w.request(&id).await.expect("the request is still stored");
    assert_eq!(after["state"], "Executed", "{after}");
    capture(&w, "near", &approved, &id).await;
}

#[tokio::test]
async fn approval_fixture_evm() {
    let w = world().await;
    let payee = format!("evm:84532:0x{}", w.payee_evm);
    let task: Task = w.signed_task(&[(&payee, ONE_ETH / 10)], 3);
    let req = w.request_json(
        &task.0,
        0,
        WORLD_EVM_ASSET,
        &payee,
        EVM_AMOUNT,
        (BOOK, EMAIL, OWNER),
        Some(EVM_PARAMS),
    );
    let result = w.submit(vec![req], &task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    let outcomes: Value = result.json().expect("the outcomes parse");
    assert_eq!(outcomes[0]["outcome"], "escalated", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "UntrustedAmount", "{outcomes}");
    let id = request_id(&task_hash(&task.0), 0);
    let stored = w.request(&id).await.expect("the request is stored");
    let approved = approve_150(&w, card_of(&stored)).await;
    let text = failure_text(&approved);
    assert!(text.is_empty(), "approve failed: {text}");
    let names = event_names(&approved);
    assert_eq!(names, ["approved", "evm_unsigned", "signed"], "{names:?}");
    let after = w.request(&id).await.expect("the request is still stored");
    assert_eq!(after["state"], "Executed", "{after}");
    assert!(after["exec"]["unsigned_hex"].is_string(), "{after}");
    capture(&w, "evm", &approved, &id).await;
}

// AIR-325: the Solana lane in the sandbox. An allowed or approved payment in asset `sol:devnet` is signed by `sign_sol`: the contract builds a
// legacy SystemProgram transfer from the stored payee and amount, the registered sender and the blockhash the agent names, sends the message
// bytes to the mock signer as an Eddsa payload with domain 1, checks the answer against the sender and stores it. Every test uses `world()`
// of tests/common plus the Solana asset (`sol-devnet-1`, hard cap 10 SOL), the sender of seed 02 (a published throwaway) and the booked
// payee `8opHz...` (cap 1 SOL); the mock answers with the Ed25519 signature the test computes over the bytes it expects.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first, and the mock (scripts/build-mock-mpc.sh).

mod common;

use airlock_policy::request::request_id;
use airlock_policy::solana::{build_sol_transfer, sol_base58, sol_bytes};
use airlock_policy::task::task_hash;
use common::*;
use ed25519_dalek::{Signer, SigningKey, Verifier};
use near_api::{Contract, NearGas, NearToken};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use serde_json::{Value, json};

const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
const EMAIL: u16 = airlock_verdict::labels::EMAIL;

const ASSET: &str = "sol:devnet";
const PATH: &str = "sol-devnet-1";
const SOL: u128 = 1_000_000_000;
const PAYEE: &str = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
const STRANGER_PAYEE: &str = "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const BLOCKHASH: &str = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const OTHER_BLOCKHASH: &str = "11111111111111111111111111111112";
const SENDER_SEED: [u8; 32] = [2; 32];

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

fn sender() -> SigningKey {
    SigningKey::from_bytes(&SENDER_SEED)
}

fn sender_b58() -> String {
    sol_base58(&sender().verifying_key().to_bytes())
}

fn key(addr: &str) -> String {
    format!("sol:devnet:{addr}")
}

/// `world()` plus the Solana asset, its sender and the booked payee (cap 1 SOL, untrusted budget 5 SOL, daily limit 20 SOL).
async fn sol_world() -> World {
    let w = world().await;
    let owner = |method: &'static str, args: Value| {
        let w = &w;
        async move { owner_call_ok(&w.policy, &w.owner, &w.owner_signer, &w.net, method, args).await }
    };
    owner(
        "asset_set",
        json!({ "asset": ASSET, "entry": {
            "symbol": "SOL", "decimals": 9,
            "hard_cap": (10 * SOL).to_string(), "daily_cap": (50 * SOL).to_string(),
            "max_fee_per_gas": "0", "max_gas": "0",
            "quick_task_cap": (50 * SOL).to_string(), "path": PATH
        }}),
    )
    .await;
    owner(
        "sol_sender_set",
        json!({ "asset": ASSET, "sender": sender_b58() }),
    )
    .await;
    let registered = call_view::<Option<String>>(&w.policy, "get_sol_sender", json!({ "asset": ASSET }), &w.net)
        .await
        .expect("get_sol_sender answers")
        .data;
    assert_eq!(registered, Some(sender_b58()));
    owner(
        "book_add",
        json!({
            "key": key(PAYEE),
            "cap": SOL.to_string(),
            "daily_untrusted_budget": (5 * SOL).to_string(),
            "daily_limit": (20 * SOL).to_string(),
            "label": "Solana payee"
        }),
    )
    .await;
    w
}

fn task_of(w: &World) -> Task {
    w.signed_task(&[(&key(PAYEE), 5 * SOL), (&key(STRANGER_PAYEE), 5 * SOL)], 5)
}

fn req(w: &World, task: &Task, index: u8, payee: &str, amount: u128, labels: (u16, u16, u16)) -> Value {
    w.request_json(&task.0, index, ASSET, &key(payee), amount, labels, None)
}

fn id_of(task: &Task, index: u8) -> String {
    request_id(&task_hash(&task.0), index)
}

/// The message the contract must build for `amount` lamports to `PAYEE` under `blockhash`.
fn expected(amount: u128, blockhash: &str) -> Vec<u8> {
    build_sol_transfer(
        &sender().verifying_key().to_bytes(),
        &sol_bytes(PAYEE).unwrap(),
        u64::try_from(amount).unwrap(),
        &sol_bytes(blockhash).unwrap(),
    )
}

async fn submit_ok(w: &World, reqs: Vec<Value>, task: &Task) -> Value {
    let result = w.submit(reqs, task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    result.json().expect("outcomes")
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

/// The mock answers the next Eddsa request with this signature.
async fn mock_signs(w: &World, message: &[u8]) {
    let sig = sender().sign(message).to_bytes();
    call_transaction(
        &w.mpc,
        "set_ed25519_signature",
        json!({ "signature_hex": hex::encode(sig) }),
        &w.owner,
        &w.owner_signer,
        &w.net,
        None,
    )
    .await
    .expect("set_ed25519_signature is sent")
    .assert_success();
}

/// `sign_sol` as the agent (300 Tgas, no deposit).
async fn sign_sol(w: &World, id: &str, blockhash: &str) -> ExecutionFinalResult {
    call_300_tgas(
        &w.policy,
        &w.net,
        &w.agent,
        &w.agent_signer,
        "sign_sol",
        json!({ "request_id": id, "recent_blockhash": blockhash }),
    )
    .await
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
    assert_eq!(found.len(), 1, "exactly one `{name}` event: {found:?}");
    found[0].clone()
}

/// The approve of an escalation as the owner: 1 yocto, 150 Tgas, the card of `get_request`.
async fn approve(w: &World, id: &str) -> ExecutionFinalResult {
    let stored = w.request(id).await.expect("stored");
    let card = json!({
        "id": stored["id"],
        "to": stored["payee"],
        "asset": stored["display"]["asset_symbol"],
        "amount": stored["display"]["amount_decimal"],
        "why": stored["reason"],
        "book": stored["book_status"]
    });
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

/// An allowed Solana payment starts no signing in `submit_batch`; `sign_sol` builds the transfer from the stored payee and amount, the
/// registered sender and the agent's blockhash, signs the exact message bytes with domain 1 on the asset's path, and stores a signature that
/// verifies against the sender.
#[tokio::test]
async fn allowed_payment_is_signed_by_sign_sol() {
    let _slot = slot().await;
    let w = sol_world().await;
    let task = task_of(&w);
    let amount = SOL / 2;
    let outcomes = submit_ok(&w, vec![req(&w, &task, 0, PAYEE, amount, (BOOK, OWNER, OWNER))], &task).await;
    assert_eq!(outcomes[0]["outcome"], "allowed", "{outcomes}");
    let id = id_of(&task, 0);
    assert_eq!(state_of(&w, &id).await, "Executing");
    assert_eq!(mock_calls(&w).await, 0, "submit_batch must not sign a Solana request");

    let message = expected(amount, BLOCKHASH);
    mock_signs(&w, &message).await;
    let signed = sign_sol(&w, &id, BLOCKHASH).await;
    let text = failure_text(&signed);
    assert!(text.is_empty(), "sign_sol failed: {text}");
    assert_eq!(names(&signed), ["sol_unsigned", "sol_signed"]);
    assert_eq!(
        one_event(&signed, "sol_unsigned")["message_hex"],
        hex::encode(&message)
    );
    let event = one_event(&signed, "sol_signed");
    assert_eq!(event["request_id"], id.as_str());
    assert_eq!(event["message_hex"], hex::encode(&message));
    let sig_bytes: [u8; 64] = hex::decode(event["signature"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    sender()
        .verifying_key()
        .verify(&message, &ed25519_dalek::Signature::from_bytes(&sig_bytes))
        .expect("the stored signature verifies against the sender");
    let last = view(&w, &w.mpc, "last_request", json!({})).await;
    assert_eq!(last["path"], PATH, "{last}");
    assert_eq!(last["payload_hex"], hex::encode(&message), "{last}");
    assert_eq!(state_of(&w, &id).await, "Executed");
    let attempt = view(&w, &w.policy, "get_sol_attempt", json!({ "request_id": id })).await;
    assert_eq!(attempt["sender"], sender_b58());
    assert_eq!(attempt["blockhash"], BLOCKHASH);
    assert_eq!(attempt["message_hex"], hex::encode(&message));
    assert_eq!(attempt["signature_hex"], hex::encode(sig_bytes));
    assert_eq!(attempt["in_flight"], false);
    // a signed request is final: no second signing
    let again = sign_sol(&w, &id, BLOCKHASH).await;
    assert!(failure_text(&again).contains("request is not executing"));
    assert_eq!(mock_calls(&w).await, 1);
}

/// An untrusted amount above the payee cap escalates; it cannot be signed before the owner approves; after the approval it is signed with
/// a blockhash named at signing time, however long the approval took.
#[tokio::test]
async fn held_payment_is_signed_after_approval() {
    let _slot = slot().await;
    let w = sol_world().await;
    let task = task_of(&w);
    let amount = 2 * SOL;
    let outcomes = submit_ok(&w, vec![req(&w, &task, 0, PAYEE, amount, (BOOK, EMAIL, OWNER))], &task).await;
    assert_eq!(outcomes[0]["outcome"], "escalated", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "UntrustedAmount", "{outcomes}");
    let id = id_of(&task, 0);
    let early = sign_sol(&w, &id, BLOCKHASH).await;
    assert!(
        failure_text(&early).contains("request is not executing"),
        "{}",
        failure_text(&early)
    );
    let approved = approve(&w, &id).await;
    let text = failure_text(&approved);
    assert!(text.is_empty(), "approve failed: {text}");
    assert_eq!(names(&approved), ["approved"]);
    assert_eq!(state_of(&w, &id).await, "Executing");
    assert_eq!(mock_calls(&w).await, 0);
    let message = expected(amount, OTHER_BLOCKHASH);
    mock_signs(&w, &message).await;
    let signed = sign_sol(&w, &id, OTHER_BLOCKHASH).await;
    assert!(failure_text(&signed).is_empty(), "{}", failure_text(&signed));
    assert_eq!(names(&signed), ["sol_unsigned", "sol_signed"]);
    assert_eq!(one_event(&signed, "sol_signed")["message_hex"], hex::encode(&message));
    assert_eq!(state_of(&w, &id).await, "Executed");
}

/// A payee labelled Book that is not in the book is blocked, and a blocked request is never signed.
#[tokio::test]
async fn payee_outside_the_book_is_blocked() {
    let _slot = slot().await;
    let w = sol_world().await;
    let task = task_of(&w);
    let outcomes = submit_ok(
        &w,
        vec![req(&w, &task, 0, STRANGER_PAYEE, SOL / 10, (BOOK, OWNER, OWNER))],
        &task,
    )
    .await;
    assert_eq!(outcomes[0]["outcome"], "blocked", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "BookLabelNotInBook", "{outcomes}");
    let id = id_of(&task, 0);
    let refused = sign_sol(&w, &id, BLOCKHASH).await;
    assert!(failure_text(&refused).contains("request is not executing"));
    assert_eq!(mock_calls(&w).await, 0);
}

/// Only the request's agent or the owner may sign: another account is refused (it is not a registered agent), the owner is accepted.
#[tokio::test]
async fn only_the_agent_or_the_owner_signs() {
    let _slot = slot().await;
    let w = sol_world().await;
    let task = task_of(&w);
    let outcomes = submit_ok(&w, vec![req(&w, &task, 0, PAYEE, SOL / 4, (BOOK, OWNER, OWNER))], &task).await;
    assert_eq!(outcomes[0]["outcome"], "allowed", "{outcomes}");
    let id = id_of(&task, 0);
    let (stranger, stranger_signer) = create_user_account(&w.net, &w.root, &w.owner_signer, "stranger")
        .await
        .expect("the account is created");
    let refused = call_300_tgas(
        &w.policy,
        &w.net,
        &stranger,
        &stranger_signer,
        "sign_sol",
        json!({ "request_id": id, "recent_blockhash": BLOCKHASH }),
    )
    .await;
    assert!(
        failure_text(&refused).contains("Agent not registered"),
        "{}",
        failure_text(&refused)
    );
    assert_eq!(mock_calls(&w).await, 0);
    let message = expected(SOL / 4, BLOCKHASH);
    mock_signs(&w, &message).await;
    let by_owner = call_300_tgas(
        &w.policy,
        &w.net,
        &w.owner,
        &w.owner_signer,
        "sign_sol",
        json!({ "request_id": id, "recent_blockhash": BLOCKHASH }),
    )
    .await;
    assert!(failure_text(&by_owner).is_empty(), "{}", failure_text(&by_owner));
    assert_eq!(state_of(&w, &id).await, "Executed");
}

/// A signature that does not verify against the registered sender (the mock's default answer) is `MpcBadResponse`: the request keeps its
/// charges and is Failed.
#[tokio::test]
async fn signature_for_another_key_fails_closed() {
    let _slot = slot().await;
    let w = sol_world().await;
    let task = task_of(&w);
    submit_ok(&w, vec![req(&w, &task, 0, PAYEE, SOL / 4, (BOOK, OWNER, OWNER))], &task).await;
    let id = id_of(&task, 0);
    let charged = w.ledgers(&key(PAYEE), ASSET).await;
    let r = sign_sol(&w, &id, BLOCKHASH).await;
    assert_eq!(names(&r), ["sol_unsigned", "failed"]);
    let failed = one_event(&r, "failed");
    assert_eq!(failed["reason"], "MpcBadResponse");
    assert_eq!(failed["retryable"], false);
    assert_eq!(state_of(&w, &id).await, "Failed");
    assert_eq!(w.ledgers(&key(PAYEE), ASSET).await, charged);
}

/// After a failed signing the charges are released and the request is Retryable; the gate's retry makes it Executing again, and `sign_sol`
/// signs the identical message even when it names another blockhash.
#[tokio::test]
async fn retry_after_mpc_failure_signs_the_same_message() {
    let _slot = slot().await;
    let w = sol_world().await;
    let task = task_of(&w);
    let request = req(&w, &task, 0, PAYEE, SOL / 4, (BOOK, OWNER, OWNER));
    let before = w.ledgers(&key(PAYEE), ASSET).await;
    submit_ok(&w, vec![request.clone()], &task).await;
    let id = id_of(&task, 0);
    w.set_mpc_mode("fail").await;
    let first = sign_sol(&w, &id, BLOCKHASH).await;
    assert_eq!(names(&first), ["sol_unsigned", "failed"]);
    let failed = one_event(&first, "failed");
    assert_eq!(failed["reason"], "MpcFailed");
    assert_eq!(failed["retryable"], true);
    assert_eq!(state_of(&w, &id).await, "Retryable");
    assert_eq!(w.ledgers(&key(PAYEE), ASSET).await, before);
    let first_hex = one_event(&first, "sol_unsigned")["message_hex"].clone();
    assert_eq!(first_hex, hex::encode(expected(SOL / 4, BLOCKHASH)));
    // the retry: the same request again, then sign_sol with another blockhash
    w.set_mpc_mode("ok").await;
    let outcomes = submit_ok(&w, vec![request], &task).await;
    assert_eq!(outcomes[0]["outcome"], "allowed", "{outcomes}");
    mock_signs(&w, &expected(SOL / 4, BLOCKHASH)).await;
    let second = sign_sol(&w, &id, OTHER_BLOCKHASH).await;
    assert_eq!(names(&second), ["sol_unsigned", "sol_signed"]);
    assert_eq!(one_event(&second, "sol_unsigned")["message_hex"], first_hex);
    assert_eq!(state_of(&w, &id).await, "Executed");
    assert_eq!(mock_calls(&w).await, 2);
}

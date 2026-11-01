// AIR-105: the signing callback in the sandbox. `on_signed` is `#[private]`: only the contract itself may call it, and `#[private]` is
// enforced by the exported wrapper, so it is tested here and not in the in-process tests of src/callback.rs (which cover the callback's
// logic, including the payloads the mock MPC cannot produce and the day change). Nothing can reach `on_signed` through a real signing
// call before AIR-100 exists; its sandbox tests drive the mock MPC end to end.
//
// The second test is the self test of the shared `World` of tests/common (AIR-105 Scope): the lane tickets (AIR-100, 101, 106, 107, 108)
// build on it, so it checks the standard setup once, in one sandbox.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use serde_json::{Value, json};

/// Label masks (GLOSSARY, `airlock_verdict::labels`).
const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

/// A stranger, the registered and allowed agent and the owner each call `on_signed` directly: every call fails with the text of
/// `#[private]`, whatever the arguments are.
#[tokio::test]
async fn on_signed_is_private() {
    let _slot = slot().await;
    let w = world().await;
    let (stranger, stranger_signer) =
        create_user_account(&w.net, &w.owner, &w.owner_signer, "stranger")
            .await
            .expect("the stranger account is created");
    let request_id = format!("{}:0", "ab".repeat(32));
    let callers = [
        ("stranger", &stranger, &stranger_signer),
        ("agent", &w.agent, &w.agent_signer),
        ("owner", &w.owner, &w.owner_signer),
    ];
    for (who, account, signer) in callers {
        let result = call_transaction(
            &w.policy,
            "on_signed",
            json!({ "request_id": request_id, "unsigned_hex": "02aa" }),
            account,
            signer,
            &w.net,
            None,
        )
        .await
        .expect("the call is sent");
        let text = failure_text(&result);
        result.assert_failure();
        assert!(
            text.contains("Method on_signed is private"),
            "{who}: expected `Method on_signed is private` in: {text}"
        );
    }
}

/// The standard setup of `world()`: registry, book, nonce, agent, mock MPC. A clean NEAR request is allowed and charges the ledgers, the
/// `events` helper reads its event, and the mock's modes can be switched.
#[tokio::test]
async fn world_standard_setup_allows_a_clean_payment() {
    let _slot = slot().await;
    let w = world().await;
    let payee = format!("near:{}", w.payee_near);
    assert_eq!(w.payee_near.as_str(), "alice.sandbox");
    assert_eq!(w.policy.as_str(), "policy.sandbox");
    assert_eq!(w.mpc.as_str(), "mpc.sandbox");
    assert_eq!(w.agent.as_str(), "agent.sandbox");
    assert_eq!(w.payee_evm.len(), 40);

    // the registry, the book and the nonce are in place
    let view = |method: &'static str, args: Value| {
        let (policy, net) = (w.policy.clone(), w.net.clone());
        async move {
            call_view::<Value>(&policy, method, args, &net)
                .await
                .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
                .data
        }
    };
    let near = view("get_asset", json!({ "asset": "near" })).await;
    assert_eq!(near["symbol"], "NEAR", "{near}");
    assert_eq!(near["hard_cap"], (10_000 * ONE_NEAR).to_string(), "{near}");
    let evm = view("get_asset", json!({ "asset": WORLD_EVM_ASSET })).await;
    assert_eq!(evm["path"], WORLD_EVM_PATH, "{evm}");
    let alice = view("get_book_entry", json!({ "key": payee })).await;
    assert_eq!(alice["cap"], (100 * ONE_NEAR).to_string(), "{alice}");
    let evm_key = format!("evm:84532:0x{}", w.payee_evm);
    let bob = view("get_book_entry", json!({ "key": evm_key })).await;
    assert!(bob["cap"].is_null(), "{bob}");
    assert_eq!(bob["daily_limit"], (10 * ONE_ETH).to_string(), "{bob}");
    let nonce = view("get_nonce", json!({ "path": WORLD_EVM_PATH })).await;
    assert_eq!(nonce, json!("0"));
    let allowed = view("is_agent_allowed", json!({ "account_id": w.agent })).await;
    assert_eq!(allowed, json!(true));
    assert_eq!(w.mpc_parked().await, 0);

    // nothing is spent yet
    let before = w.ledgers(&payee, "near").await;
    assert_eq!(before["asset_day"]["spent"], "0", "{before}");
    assert_eq!(
        before["asset_day"]["cap"],
        (100_000 * ONE_NEAR).to_string(),
        "{before}"
    );
    assert_eq!(
        before["payee_day"]["cap"],
        (5_000 * ONE_NEAR).to_string(),
        "{before}"
    );

    // a clean request (Book recipient, Owner amount and pc) under a task bound is allowed
    let task = w.signed_task(&[(&payee, ONE_NEAR)], 3);
    let amount = ONE_NEAR / 100;
    let req = w.request_json(
        &task.0,
        0,
        "near",
        &payee,
        amount,
        (BOOK, OWNER, OWNER),
        None,
    );
    assert_eq!(req["hints"]["trace_digest"], "0".repeat(64));
    assert_eq!(req["hints"]["plan_hash"], task.0.plan_sha256.to_hex());
    let result = w.submit(vec![req], &task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    let allowed_events = events(&result, "allowed");
    let blocked_events = events(&result, "blocked");
    let outcomes: Value = result.json().expect("the outcomes parse");
    assert_eq!(outcomes[0]["outcome"], "allowed", "{outcomes}");
    let id = outcomes[0]["request_id"]
        .as_str()
        .expect("a request id")
        .to_string();
    assert_eq!(allowed_events.len(), 1, "{allowed_events:?}");
    assert_eq!(allowed_events[0]["request_id"], id.as_str());
    assert!(blocked_events.is_empty());
    assert!(w.request(&id).await.is_some());
    assert!(w.request(&format!("{}:7", "cd".repeat(32))).await.is_none());
    let after = w.ledgers(&payee, "near").await;
    assert_eq!(after["asset_day"]["spent"], amount.to_string(), "{after}");

    // the mock's modes
    for mode in ["garbage", "fail", "ok"] {
        w.set_mpc_mode(mode).await;
        let got = call_view::<String>(&w.mpc, "mode", json!({}), &w.net)
            .await
            .expect("mode answers")
            .data;
        assert_eq!(got, mode);
    }
}

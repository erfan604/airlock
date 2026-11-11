// The approver-bounds fix (2026-11-11) as a code-only redeploy over a card on the bytes the live credit card runs
// (`res/airlock_policy_6FCZRf51.wasm`, code hash 6FCZRf51teMBxkLb2V5sc5bpLXDWws9RZgT3ERaUowTg): no init call, no migrate, every view equal,
// and the new refusal holds on the stored state. Its own test binary, because it points `AIRLOCK_WASM` at the pinned bytes for the deploy.
//
// Needs the new wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, Contract, NearToken, Signer};
use near_api_types::CryptoHash;
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};
use std::sync::Arc;

const OWNER_MASK: u16 = airlock_verdict::OWNER;
const BOOK_MASK: u16 = airlock_verdict::BOOK;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn pinned_wasm() -> String {
    format!(
        "{}/res/airlock_policy_6FCZRf51.wasm",
        env!("CARGO_MANIFEST_DIR")
    )
}

async fn call(
    w: &World,
    who: &AccountId,
    signer: &Arc<Signer>,
    method: &str,
    args: Value,
    yocto: u128,
) -> ExecutionFinalResult {
    call_transaction(
        &w.policy,
        method,
        args,
        who,
        signer,
        &w.net,
        Some(NearToken::from_yoctonear(yocto)),
    )
    .await
    .expect("the call is sent")
}

async fn view(w: &World, method: &str, args: Value) -> Value {
    call_view::<Value>(&w.policy, method, args, &w.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
        .data
}

fn task_for(
    w: &World,
    bounds: &[(&str, u128)],
    task_id: &str,
) -> (
    airlock_policy::task::OwnerTask,
    near_sdk::json_types::Base64VecU8,
) {
    let policy: near_sdk::AccountId = w.policy.as_str().parse().unwrap();
    let agent: near_sdk::AccountId = w.agent.as_str().parse().unwrap();
    signed_task_with(bounds, 1, |t| {
        t.contract_id = policy;
        t.agent_id = agent;
        t.task_id = task_id.to_string();
    })
}

async fn submit_one(
    w: &World,
    task: &(
        airlock_policy::task::OwnerTask,
        near_sdk::json_types::Base64VecU8,
    ),
    payee: &str,
    amount: u128,
) -> (String, String) {
    let req = w.request_json(
        &task.0,
        0,
        "near",
        payee,
        amount,
        (BOOK_MASK, OWNER_MASK, OWNER_MASK),
        None,
    );
    let r = w.submit(vec![req], task).await;
    assert!(failure_text(&r).is_empty(), "{}", failure_text(&r));
    let outs: Value = r.json().expect("outcomes");
    (
        outs[0]["outcome"].as_str().unwrap().to_string(),
        outs[0]["request_id"].as_str().unwrap().to_string(),
    )
}

async fn card_of(w: &World, id: &str) -> Value {
    let v = w.request(id).await.expect("a request");
    json!({ "id": v["id"], "to": v["payee"], "asset": v["display"]["asset_symbol"], "amount": v["display"]["amount_decimal"], "why": v["reason"], "book": v["book_status"] })
}

/// Every view of the card that the redeploy must keep.
async fn all_views(w: &World, ids: &[&str], tasks: &[&str], payee: &str) -> Vec<Value> {
    let mut v = vec![
        view(w, "get_policy", json!({})).await,
        view(w, "list_assets", json!({})).await,
        view(w, "get_book_root", json!({})).await,
        view(w, "get_book_epoch", json!({})).await,
        view(w, "get_roles", json!({})).await,
        view(w, "get_task_key", json!({})).await,
        view(w, "get_allowed_agents", json!({})).await,
        view(w, "get_agents", json!({})).await,
        view(w, "get_contract_info", json!({})).await,
        view(w, "get_pending", json!({})).await,
        view(w, "get_escalation_state", json!({ "agent": w.agent })).await,
    ];
    for id in ids {
        v.push(view(w, "get_request", json!({ "id": id })).await);
    }
    for t in tasks {
        v.push(view(w, "get_task_state", json!({ "task_hash": t })).await);
        v.push(
            view(
                w,
                "get_ledgers",
                json!({ "payee": payee, "asset": "near", "task": t }),
            )
            .await,
        );
    }
    v
}

#[tokio::test]
async fn the_approver_bounds_fix_redeploys_over_the_live_card_bytes_with_no_init_call() {
    // the pinned bytes are the ones the live card runs
    let pinned = std::fs::read(pinned_wasm()).expect("the pinned wasm");
    assert_eq!(
        hex::encode(CryptoHash::hash(&pinned).0),
        "4deda2c541cf97b7e23332743890fedf4161e5135eb7637c90683d66109fc9a3",
        "res/airlock_policy_6FCZRf51.wasm is the live card's code (base58 6FCZRf51...)"
    );
    let new_wasm = contract_wasm_path();
    let new_bytes = std::fs::read(&new_wasm).expect("the new build: run cargo near build first");
    assert_ne!(
        new_bytes, pinned,
        "the new build differs from the live bytes"
    );
    // SAFETY: this binary runs one test; the variable only steers `contract_wasm_path` for the deploy in `world_with`
    unsafe { std::env::set_var("AIRLOCK_WASM", pinned_wasm()) };
    let w = world_with(WorldOpts {
        roles: true,
        ..WorldOpts::default()
    })
    .await;
    unsafe { std::env::remove_var("AIRLOCK_WASM") };
    owner_call_ok(&w.policy, &w.owner, &w.owner_signer, &w.net, "book_add", json!({
        "key": format!("near:{}", w.payee_near), "cap": ONE_NEAR.to_string(), "daily_untrusted_budget": (10 * ONE_NEAR).to_string(),
        "daily_limit": (5 * ONE_NEAR).to_string(), "label": "Alice" })).await;
    let (approver, approver_signer) = w.approver.clone().expect("an approver");
    let alice = format!("near:{}", w.payee_near);

    // state on the old bytes: an allowed payment that charged the ledgers, and a hold over the task bound for the approver
    let t1 = task_for(&w, &[(&alice, 2 * ONE_NEAR)], "t-paid");
    let (out1, id1) = submit_one(&w, &t1, &alice, ONE_NEAR).await;
    assert_eq!(out1, "allowed");
    let t2 = task_for(&w, &[(&alice, ONE_NEAR)], "t-held");
    let (out2, id2) = submit_one(&w, &t2, &alice, 4 * ONE_NEAR).await;
    assert_eq!(out2, "escalated");
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let h1 = hex::encode(airlock_policy::task::task_hash(&t1.0));
    let h2 = hex::encode(airlock_policy::task::task_hash(&t2.0));
    let before = all_views(&w, &[&id1, &id2], &[&h1, &h2], &alice).await;
    assert_eq!(before[11]["state"], "Executed", "{}", before[11]);
    assert_eq!(before[12]["state"], "Pending", "{}", before[12]);

    // the redeploy: DeployContract with no init call, signed with a key the sandbox adds to the card account
    w.sandbox
        .patch_state(w.policy.clone())
        .with_default_access_key()
        .send()
        .await
        .expect("the key patch");
    let policy_signer: Arc<Signer> = w.owner_signer.clone();
    let r = Contract::deploy(w.policy.clone())
        .use_code(new_bytes.clone())
        .without_init_call()
        .with_signer(policy_signer)
        .send_to(&w.net)
        .await
        .expect("the redeploy is sent");
    let r = match r {
        near_api_types::transaction::result::TransactionResult::Full(r) => *r,
        other => panic!("the redeploy is still pending: {other:?}"),
    };
    assert!(failure_text(&r).is_empty(), "{}", failure_text(&r));
    let state = near_api::Account(w.policy.clone())
        .view()
        .fetch_from(&w.net)
        .await
        .expect("the card account")
        .data
        .contract_state;
    assert_eq!(
        state,
        near_api_types::account::ContractState::LocalHash(CryptoHash::hash(&new_bytes)),
        "the card runs the new build"
    );

    // every view equal
    let after = all_views(&w, &[&id1, &id2], &[&h1, &h2], &alice).await;
    assert_eq!(before.len(), after.len());
    for (i, (b, a)) in before.iter().zip(after.iter()).enumerate() {
        assert_eq!(b, a, "view {i} changed across the redeploy");
    }

    // the stored hold is now refused to the approver and stays pending; the owner can still reject it
    let card = card_of(&w, &id2).await;
    let r = call(&w, &approver, &approver_signer, "approve", card.clone(), 1).await;
    let text = failure_text(&r);
    assert!(
        text.contains("approve refused for the approver: the payment is held OverTaskBound"),
        "{text}"
    );
    assert_eq!(w.request(&id2).await.unwrap()["state"], "Pending");
    let r = call(
        &w,
        &w.owner,
        &w.owner_signer,
        "reject",
        json!({ "id": card["id"] }),
        1,
    )
    .await;
    assert!(failure_text(&r).is_empty(), "{}", failure_text(&r));
    assert_eq!(w.request(&id2).await.unwrap()["state"], "Rejected");

    // the stored state keeps working: a new payment inside the bounds is allowed on the new code
    let t3 = task_for(&w, &[(&alice, 2 * ONE_NEAR)], "t-after");
    let (out3, _) = submit_one(&w, &t3, &alice, ONE_NEAR).await;
    assert_eq!(out3, "allowed");
}

// AIR-046: the allow list in the sandbox. An agent can act only when it is registered (attestation or local whitelist), valid right
// now, and allowed by the owner after the owner compared its fingerprint. Every revert asserts its text, because a missing method also
// fails and would pass a bare `assert_failure()`.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::agents::fingerprint;
use common::*;
use near_api::{AccountId, Data, NearToken, Signer, Tokens};
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

async fn account(s: &Started, name: &str) -> (AccountId, Arc<Signer>) {
    create_user_account(&s.net, &s.owner, &s.owner_signer, name)
        .await
        .expect("the account is created")
}

async fn register(s: &Started, agent: &AccountId, signer: &Arc<Signer>) {
    register_local_agent(
        &s.contract,
        &s.owner,
        &s.owner_signer,
        agent,
        signer,
        &s.net,
    )
    .await;
}

async fn allow(s: &Started, agent: &AccountId) {
    allow_agent_for(&s.contract, &s.owner, &s.owner_signer, agent, &s.net).await;
}

async fn view(s: &Started, method: &str, args: Value) -> Value {
    let answer: Data<Value> = call_view(&s.contract, method, args, &s.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"));
    answer.data
}

async fn is_valid(s: &Started, agent: &AccountId) -> bool {
    view(s, "is_agent_valid", json!({ "account_id": agent })).await == json!(true)
}

async fn is_allowed(s: &Started, agent: &AccountId) -> bool {
    view(s, "is_agent_allowed", json!({ "account_id": agent })).await == json!(true)
}

/// A call as `who` with a chosen deposit.
async fn call_as(
    s: &Started,
    who: (&AccountId, &Arc<Signer>),
    method: &str,
    args: Value,
    deposit: u128,
) -> ExecutionFinalResult {
    call_transaction(
        &s.contract,
        method,
        args,
        who.0,
        who.1,
        &s.net,
        Some(NearToken::from_yoctonear(deposit)),
    )
    .await
    .expect("the call is sent")
}

fn assert_fails_with(result: ExecutionFinalResult, text: &str) {
    let got = failure_text(&result);
    result.assert_failure();
    assert!(got.contains(text), "expected `{text}` in: {got}");
}

#[tokio::test]
async fn allowed_agent_is_valid() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, signer) = account(&s, "agent").await;
    register(&s, &agent, &signer).await;
    allow(&s, &agent).await;
    assert!(is_valid(&s, &agent).await);
    assert!(is_allowed(&s, &agent).await);
}

#[tokio::test]
async fn registered_not_allowed_is_invalid() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, signer) = account(&s, "agent").await;
    register(&s, &agent, &signer).await;
    assert!(!is_allowed(&s, &agent).await);
    assert!(
        !is_valid(&s, &agent).await,
        "a registration alone is not enough"
    );
    // the registration itself is fine: only the allowance is missing
    let info = view(&s, "get_agent", json!({ "account_id": agent })).await;
    assert_eq!(info["validity"], json!("Valid"));
}

#[tokio::test]
async fn allowed_but_unregistered_is_invalid() {
    let _slot = slot().await;
    let s = start().await;
    // order A: allow first, register after
    let (first, first_signer) = account(&s, "first").await;
    allow(&s, &first).await;
    assert!(is_allowed(&s, &first).await);
    assert!(!is_valid(&s, &first).await, "allowed but not registered");
    register(&s, &first, &first_signer).await;
    assert!(is_valid(&s, &first).await, "registering makes it valid");
    // order B: register first, allow after
    let (second, second_signer) = account(&s, "second").await;
    register(&s, &second, &second_signer).await;
    assert!(!is_valid(&s, &second).await);
    allow(&s, &second).await;
    assert!(is_valid(&s, &second).await);
}

#[tokio::test]
async fn revoke_makes_invalid_again() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, signer) = account(&s, "agent").await;
    register(&s, &agent, &signer).await;
    allow(&s, &agent).await;
    assert!(is_valid(&s, &agent).await);
    let result = owner_call(&s, "revoke_agent", json!({ "account_id": agent })).await;
    let events = extract_event_logs(&result).unwrap();
    result.assert_success();
    let event = events
        .iter()
        .find(|e| e["event"] == "agent_revoked")
        .expect("an agent_revoked event");
    assert_eq!(event["standard"], "airlock");
    assert_eq!(event["data"][0]["account_id"], json!(agent));
    assert!(!is_valid(&s, &agent).await);
    assert!(!is_allowed(&s, &agent).await);
    // the registration stays, and its attestation is still valid
    let info = view(&s, "get_agent", json!({ "account_id": agent })).await;
    assert!(!info.is_null(), "revoke_agent keeps the registration");
    assert_eq!(info["validity"], json!("Valid"));
}

#[tokio::test]
async fn wrong_fingerprint_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, _) = account(&s, "agent").await;
    let good = fingerprint(agent.as_str());
    let wrong_account = fingerprint("agent.example.testnet");
    for bad in [
        wrong_account,
        good.to_uppercase(),
        format!("{good}0"),
        good[..11].to_string(),
        String::new(),
    ] {
        let result = owner_call(
            &s,
            "allow_agent",
            json!({ "account_id": agent, "fingerprint": bad }),
        )
        .await;
        assert_fails_with(result, "fingerprint mismatch");
    }
    assert!(
        !is_allowed(&s, &agent).await,
        "no mistyped call allowed the account"
    );
}

#[tokio::test]
async fn allow_agent_stranger_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, _) = account(&s, "agent").await;
    let (stranger, stranger_signer) = account(&s, "stranger").await;
    let args = json!({ "account_id": agent, "fingerprint": fingerprint(agent.as_str()) });
    let result = call_as(&s, (&stranger, &stranger_signer), "allow_agent", args, 1).await;
    assert_fails_with(result, NOT_OWNER_TEXT);
    assert!(!is_allowed(&s, &agent).await);
}

/// AB7: an agent cannot allow itself.
#[tokio::test]
async fn allow_agent_by_agent_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, signer) = account(&s, "agent").await;
    register(&s, &agent, &signer).await;
    let args = json!({ "account_id": agent, "fingerprint": fingerprint(agent.as_str()) });
    let result = call_as(&s, (&agent, &signer), "allow_agent", args, 1).await;
    assert_fails_with(result, NOT_OWNER_TEXT);
    assert!(!is_allowed(&s, &agent).await);
}

#[tokio::test]
async fn allow_agent_no_deposit_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, _) = account(&s, "agent").await;
    let args = json!({ "account_id": agent, "fingerprint": fingerprint(agent.as_str()) });
    let result = call_as(&s, (&s.owner, &s.owner_signer), "allow_agent", args, 0).await;
    assert_fails_with(result, ONE_YOCTO_TEXT);
    assert!(!is_allowed(&s, &agent).await);
}

#[tokio::test]
async fn allow_agent_two_yocto_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, _) = account(&s, "agent").await;
    let args = json!({ "account_id": agent, "fingerprint": fingerprint(agent.as_str()) });
    let result = call_as(&s, (&s.owner, &s.owner_signer), "allow_agent", args, 2).await;
    assert_fails_with(result, ONE_YOCTO_TEXT);
    assert!(!is_allowed(&s, &agent).await);
}

#[tokio::test]
async fn revoke_agent_absent_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, _) = account(&s, "agent").await;
    let result = owner_call(&s, "revoke_agent", json!({ "account_id": agent })).await;
    assert_fails_with(result, "agent not allowed");
}

#[tokio::test]
async fn revoke_agent_stranger_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, signer) = account(&s, "agent").await;
    let (stranger, stranger_signer) = account(&s, "stranger").await;
    register(&s, &agent, &signer).await;
    allow(&s, &agent).await;
    let args = json!({ "account_id": agent });
    let result = call_as(
        &s,
        (&stranger, &stranger_signer),
        "revoke_agent",
        args.clone(),
        1,
    )
    .await;
    assert_fails_with(result, NOT_OWNER_TEXT);
    // the agent cannot revoke itself either, nor can the owner without the deposit
    let result = call_as(&s, (&agent, &signer), "revoke_agent", args.clone(), 1).await;
    assert_fails_with(result, NOT_OWNER_TEXT);
    let result = call_as(&s, (&s.owner, &s.owner_signer), "revoke_agent", args, 0).await;
    assert_fails_with(result, ONE_YOCTO_TEXT);
    assert!(
        is_allowed(&s, &agent).await,
        "no failed call revoked the allowance"
    );
}

#[tokio::test]
async fn get_allowed_agents_lists_and_clamps() {
    let _slot = slot().await;
    let s = start().await;
    // the contract does not need the accounts to exist: 52 allowances, one call each
    let names: Vec<String> = (0..52).map(|i| format!("agent{i:02}.sandbox")).collect();
    for name in &names {
        let id: AccountId = name.parse().unwrap();
        allow(&s, &id).await;
    }
    // insertion order, with the fingerprint and the allowed_ms string
    let first = view(
        &s,
        "get_allowed_agents",
        json!({ "from_index": 0, "limit": 3 }),
    )
    .await;
    let first = first.as_array().expect("a list");
    assert_eq!(first.len(), 3);
    for (i, row) in first.iter().enumerate() {
        assert_eq!(row[0], json!(names[i]));
        assert_eq!(row[1]["fingerprint"], json!(fingerprint(&names[i])));
        assert!(row[1]["allowed_ms"].is_string(), "{row}");
    }
    // limit 500 returns at most 50, with or without a start index, and an index past the end is an empty list
    let page = view(
        &s,
        "get_allowed_agents",
        json!({ "from_index": null, "limit": 500 }),
    )
    .await;
    assert_eq!(page.as_array().unwrap().len(), 50);
    let rest = view(
        &s,
        "get_allowed_agents",
        json!({ "from_index": 50, "limit": 500 }),
    )
    .await;
    let rest = rest.as_array().unwrap();
    assert_eq!(rest.len(), 2);
    assert_eq!(rest[0][0], json!(names[50]));
    let none = view(
        &s,
        "get_allowed_agents",
        json!({ "from_index": 1000, "limit": null }),
    )
    .await;
    assert_eq!(none, json!([]));
    let default_page = view(&s, "get_allowed_agents", json!({})).await;
    assert_eq!(default_page.as_array().unwrap().len(), 50);
}

/// Calls both owner methods and both views and asserts each succeeded: a missing export fails here (the ABI allow list in
/// tests/abi_expected.txt is not consulted).
#[tokio::test]
async fn methods_are_exported() {
    let _slot = slot().await;
    let s = start().await;
    let (agent, _) = account(&s, "agent").await;
    let args = json!({ "account_id": agent, "fingerprint": fingerprint(agent.as_str()) });
    owner_call(&s, "allow_agent", args).await.assert_success();
    assert_eq!(
        view(&s, "is_agent_allowed", json!({ "account_id": agent })).await,
        json!(true)
    );
    let list = view(
        &s,
        "get_allowed_agents",
        json!({ "from_index": null, "limit": null }),
    )
    .await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    owner_call(&s, "revoke_agent", json!({ "account_id": agent }))
        .await
        .assert_success();
    assert_eq!(
        view(&s, "is_agent_allowed", json!({ "account_id": agent })).await,
        json!(false)
    );
}

/// What a registration costs the agent and what the contract keeps (audit map: a payable method refunds what it does not keep,
/// and the storage it charges for covers what it stores; detectors `cover-storage-cost` and the unclaimed storage fee).
/// Only inequalities: the protocol 83 and 88 sandboxes differ in gas rebates and account creation costs.
#[tokio::test]
async fn register_agent_refunds_excess_and_covers_storage() {
    let _slot = slot().await;
    let s = start().await;
    let one_near = NearToken::from_near(1);
    let storage_cost = 486u128 * 10u128.pow(19); // STORAGE_BYTES_TO_REGISTER bytes at 10^19 yocto per byte
    let gas_margin = 10u128.pow(22); // 0.01 NEAR
    let (agent2, signer2) = account(&s, "agent2").await;
    let (agent3, signer3) = account(&s, "agent3").await;
    for agent in [&agent2, &agent3] {
        call_as(
            &s,
            (&s.owner, &s.owner_signer),
            "whitelist_agent_for_local",
            json!({ "account_id": agent }),
            1,
        )
        .await
        .assert_success();
    }
    let attestation = json!({ "attestation": serde_json::to_value(shade_attestation::attestation::create_mock_dstack_attestation()).unwrap() });
    let balance = |id: AccountId| {
        let net = s.net.clone();
        async move {
            Tokens::account(id)
                .near_balance()
                .fetch_from(&net)
                .await
                .expect("the balance is read")
        }
    };

    // (a) a first registration attaching 1 NEAR: the policy account stores at most 486 more bytes, the agent pays about the
    // storage cost and the rest comes back
    let usage_before = balance(s.contract.clone()).await.storage_usage;
    let agent_before = balance(agent2.clone()).await.total.as_yoctonear();
    call_transaction(
        &s.contract,
        "register_agent",
        attestation.clone(),
        &agent2,
        &signer2,
        &s.net,
        Some(one_near),
    )
    .await
    .unwrap()
    .assert_success();
    // the refund is a receipt of its own: give it a block or two
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let usage_after = balance(s.contract.clone()).await.storage_usage;
    let agent_after = balance(agent2.clone()).await.total.as_yoctonear();
    assert!(
        usage_after > usage_before && usage_after - usage_before <= 486,
        "a first registration stores {} bytes, the constant covers 486",
        usage_after as i128 - usage_before as i128
    );
    let paid = agent_before - agent_after;
    assert!(
        paid < storage_cost + gas_margin,
        "the agent paid {paid} yocto of its 1 NEAR: the excess did not come back"
    );

    // (b) a re-registration attaching 1 NEAR costs only gas
    let agent_before = balance(agent2.clone()).await.total.as_yoctonear();
    call_transaction(
        &s.contract,
        "register_agent",
        attestation.clone(),
        &agent2,
        &signer2,
        &s.net,
        Some(one_near),
    )
    .await
    .unwrap()
    .assert_success();
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let agent_after = balance(agent2.clone()).await.total.as_yoctonear();
    assert!(
        agent_before - agent_after < gas_margin,
        "a re-registration cost {} yocto: the deposit was kept",
        agent_before - agent_after
    );

    // (c) a first registration one yocto below the storage cost reverts
    let result = call_transaction(
        &s.contract,
        "register_agent",
        attestation.clone(),
        &agent3,
        &signer3,
        &s.net,
        Some(NearToken::from_yoctonear(storage_cost - 1)),
    )
    .await
    .unwrap();
    assert_fails_with(result, "Attached deposit must be greater than storage cost");

    // (d) after the owner removes the agent the contract keeps the deposit: registering again pays the storage cost once more
    call_as(
        &s,
        (&s.owner, &s.owner_signer),
        "remove_agent",
        json!({ "account_id": agent2 }),
        1,
    )
    .await
    .assert_success();
    let agent_before = balance(agent2.clone()).await.total.as_yoctonear();
    call_transaction(
        &s.contract,
        "register_agent",
        attestation,
        &agent2,
        &signer2,
        &s.net,
        Some(one_near),
    )
    .await
    .unwrap()
    .assert_success();
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let agent_after = balance(agent2.clone()).await.total.as_yoctonear();
    assert!(
        agent_before - agent_after >= storage_cost,
        "a removed agent registering again paid only {} yocto, the storage cost is {storage_cost}",
        agent_before - agent_after
    );
}

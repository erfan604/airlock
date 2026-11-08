// AIR-084: the approval-path attacks AB1 to AB12 of Kodathala et al. (arXiv 2610.21063), one named test each (`ab01_` to `ab12_`).
// That paper is the source of the taxonomy; these tests are not proof that every variant of each attack is covered. `scripts/ab-map.sh`
// lists the test of each attack. Every revert assertion checks the text, because a missing method also fails.
//
// Run with `-- --test-threads=4` (each sandbox is a neard of several hundred MB). `ab08_` and `ab09_` run in process.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::exec::build_evm_unsigned;
use airlock_policy::request::request_id;
use airlock_policy::task::{OwnerTask, task_bytes, task_hash};
use common::*;
use near_api::{AccountId, Contract, NearGas, NearToken, Tokens};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use serde_json::{Value, json};

const OWNER: u16 = airlock_verdict::OWNER;
const BOOK: u16 = airlock_verdict::BOOK;
const EMAIL: u16 = airlock_verdict::labels::EMAIL;

const GWEI: u128 = 1_000_000_000;
/// (gas_limit, max_fee_per_gas, max_priority_fee_per_gas) of every EVM request here.
const EVM: (u128, u128, u128) = (21_000, 2 * GWEI, GWEI);
const EVM_AMOUNT: u128 = 10_000_000_000_000_000; // 10^16 wei

/// At most this many sandboxes of this file run at once (a neard is several hundred MB and a deploy times out when too many start
/// together; see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

type Task = (OwnerTask, near_sdk::json_types::Base64VecU8);

fn evm_key(w: &World) -> String {
    format!("evm:84532:0x{}", w.payee_evm)
}

fn id_of(task: &Task, index: u8) -> String {
    request_id(&task_hash(&task.0), index)
}

fn assert_fails(result: &ExecutionFinalResult, text: &str) {
    let got = failure_text(result);
    assert!(
        !got.is_empty(),
        "the call must fail with `{text}`, but it succeeded"
    );
    assert!(got.contains(text), "expected `{text}` in: {got}");
}

async fn view(w: &World, method: &str, args: Value) -> Value {
    call_view::<Value>(&w.policy, method, args, &w.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"))
        .data
}

async fn balance(w: &World, id: &AccountId) -> u128 {
    Tokens::account(id.clone())
        .near_balance()
        .fetch_from(&w.net)
        .await
        .expect("the balance is read")
        .total
        .as_yoctonear()
}

/// A call as `signer` with the given deposit and gas.
async fn call_as(
    w: &World,
    caller: &AccountId,
    signer: &std::sync::Arc<near_api::Signer>,
    method: &str,
    args: Value,
    deposit_yocto: u128,
    tgas: u64,
) -> ExecutionFinalResult {
    let sent = Contract(w.policy.clone())
        .call_function(method, common::shim_args(&w.policy, &w.net, method, args))
        .transaction()
        .gas(NearGas::from_tgas(tgas))
        .deposit(NearToken::from_yoctonear(deposit_yocto))
        .with_signer(caller.clone(), signer.clone())
        .send_to(&w.net)
        .await
        .expect("the call is sent");
    match sent {
        TransactionResult::Full(r) => *r,
        other => panic!("the call did not finish: {other:?}"),
    }
}

/// The six strings of the card of the pending escalation with this number, from `get_pending`.
async fn card_of(w: &World, no: &str) -> Value {
    let found = view(w, "get_pending", json!({})).await;
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

/// The owner's approve of the pending number `no` with the stored card: 1 yocto, 150 Tgas. A failed receipt panics with its text.
async fn approve_ok(w: &World, no: &str) -> ExecutionFinalResult {
    let card = card_of(w, no).await;
    let result = call_as(w, &w.owner, &w.owner_signer, "approve", card, 1, 150).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "approve failed: {text}");
    result
}

// ---- AB1: amount cancellation by a duplicate key ------------------------------------------------------------------------------

#[tokio::test]
async fn ab01_duplicate_amount_key_reverts() {
    let _slot = slot().await;
    let w = world().await;
    let task = w.signed_task(&[("near:alice.sandbox", 10 * ONE_NEAR)], 3);
    let req = w.request_json(
        &task.0,
        0,
        "near",
        "near:alice.sandbox",
        ONE_NEAR,
        (BOOK, OWNER, OWNER),
        None,
    );
    // `labels.amount` is a number, so the first `"amount":"` is the top-level amount string
    let body = serde_json::to_string(&common::shim_args(
        &w.policy,
        &w.net,
        "submit_batch",
        json!({ "reqs": [req], "task": task.0, "task_sig": task.1 }),
    ))
    .expect("the body serializes");
    assert_eq!(body.matches("\"amount\":\"").count(), 1, "{body}");
    let doubled = body.replacen("\"amount\":\"", "\"amount\":\"1\",\"amount\":\"", 1);
    assert_ne!(body, doubled);
    let before = w.ledgers("near:alice.sandbox", "near").await;
    let sent = Contract(w.policy.clone())
        .call_function_raw("submit_batch", doubled.into_bytes())
        .transaction()
        .max_gas()
        .with_signer(w.agent.clone(), w.agent_signer.clone())
        .send_to(&w.net)
        .await
        .expect("the call is sent");
    let result = match sent {
        TransactionResult::Full(r) => *r,
        other => panic!("the call did not finish: {other:?}"),
    };
    assert_fails(&result, "duplicate field");
    assert_eq!(w.ledgers("near:alice.sandbox", "near").await, before);
    assert!(w.request(&id_of(&task, 0)).await.is_none());
}

// ---- AB2: a recipient the owner did not approve, smuggled through extra fields -----------------------------------------------

#[tokio::test]
async fn ab02_extra_recipient_field_is_ignored() {
    let _slot = slot().await;
    let w = world().await;
    let (mallory, _) = create_user_account(&w.net, &w.root, &w.owner_signer, "mallory")
        .await
        .expect("the account is created");
    let near_key = format!("near:{}", w.payee_near);
    let evm = evm_key(&w);
    let task = w.signed_task(&[(&near_key, 10 * ONE_NEAR), (&evm, ONE_ETH)], 3);

    // NEAR: the book payee is paid, the extra recipient fields choose nobody
    let mut near_req = w.request_json(
        &task.0,
        0,
        "near",
        &near_key,
        ONE_NEAR,
        (BOOK, OWNER, OWNER),
        None,
    );
    near_req["to_address"] = json!("mallory.sandbox");
    near_req["recipient"] = json!("mallory.sandbox");
    let alice_before = balance(&w, &w.payee_near).await;
    let mallory_before = balance(&w, &mallory).await;
    let result = w.submit(vec![near_req], &task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    let outcomes: Value = result.clone().json().expect("the outcomes parse");
    assert_eq!(outcomes[0]["outcome"], "allowed", "{outcomes}");
    let paid = events(&result, "paid");
    assert_eq!(paid.len(), 1, "{paid:?}");
    assert_eq!(paid[0]["payee"], near_key.as_str());
    assert_eq!(balance(&w, &w.payee_near).await - alice_before, ONE_NEAR);
    assert_eq!(balance(&w, &mallory).await, mallory_before);

    // EVM: the transaction is rebuilt from the typed fields only
    let mut evm_req = w.request_json(
        &task.0,
        1,
        WORLD_EVM_ASSET,
        &evm,
        EVM_AMOUNT,
        (BOOK, OWNER, OWNER),
        Some(EVM),
    );
    evm_req["to_address"] = json!("0x000000000000000000000000000000000000dead");
    let nonce: u64 = view(&w, "get_nonce", json!({ "path": WORLD_EVM_PATH }))
        .await
        .as_str()
        .expect("the nonce is a decimal string")
        .parse()
        .expect("a number");
    let result = w.submit(vec![evm_req], &task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    let outcomes: Value = result.clone().json().expect("the outcomes parse");
    assert_eq!(outcomes[0]["outcome"], "allowed", "{outcomes}");
    let unsigned = events(&result, "evm_unsigned");
    assert_eq!(unsigned.len(), 1, "{unsigned:?}");
    let to: [u8; 20] = hex::decode(&w.payee_evm)
        .expect("lowercase hex")
        .try_into()
        .expect("20 bytes");
    let want = hex::encode(build_evm_unsigned(
        84532, nonce, to, EVM_AMOUNT, EVM.0, EVM.1, EVM.2,
    ));
    assert_eq!(unsigned[0]["unsigned_hex"], want.as_str());
}

// ---- AB3: no standing grants in the ABI ---------------------------------------------------------------------------------------

#[test]
fn ab03_no_standing_grants_in_abi() {
    // the AIR-041 pattern `request_signature|update_contract|migrate|cancel|approve_all|approve_batch|batch_approve|approve_many|standing|
    // schedule_payment|grant`, as plain substrings (the pattern has no metacharacters besides the bars)
    const FORBIDDEN: &[&str] = &[
        "request_signature",
        "update_contract",
        "migrate",
        "cancel",
        "approve_all",
        "approve_batch",
        "batch_approve",
        "approve_many",
        "standing",
        "schedule_payment",
        "grant",
    ];
    let exports = wasm_exports();
    assert!(exports.len() >= 40, "only {} exports", exports.len());
    for must in ["approve", "submit_batch"] {
        assert!(exports.iter().any(|e| e == must), "{must} is not exported");
    }
    for name in &exports {
        for pattern in FORBIDDEN {
            assert!(
                !name.contains(pattern),
                "export `{name}` matches the forbidden pattern `{pattern}`"
            );
        }
    }
}

// ---- AB4: hidden characters in a payee key ------------------------------------------------------------------------------------

#[tokio::test]
async fn ab04_hidden_characters_rejected() {
    let _slot = slot().await;
    let w = world().await;
    let keys = [
        "near:ali\u{200b}ce.sandbox".to_string(),
        "near:alice\u{202e}.sandbox".to_string(),
    ];
    let task = w.signed_task(&[("near:alice.sandbox", 10 * ONE_NEAR)], 3);
    for (i, key) in keys.iter().enumerate() {
        // since AIR-326 the owner's commitment holds no key text: the key is checked when a request names it
        let req = w.request_json(
            &task.0,
            i as u8,
            "near",
            key,
            ONE_NEAR,
            (BOOK, OWNER, OWNER),
            None,
        );
        let result = w.submit(vec![req], &task).await;
        assert_fails(&result, "bad payee key: NonAscii");
    }
}

// ---- AB5: argument names are fixed by the signature --------------------------------------------------------------------------

#[tokio::test]
async fn ab05_argument_names_fixed_by_signature() {
    let _slot = slot().await;
    let w = world().await;
    let result = call_as(
        &w,
        &w.owner,
        &w.owner_signer,
        "approve",
        json!({
            "request_id": "1",
            "recipient": "x",
            "asset_symbol": "x",
            "amount_decimal": "1",
            "reason": "x",
            "book_status": "x"
        }),
        1,
        150,
    )
    .await;
    assert_fails(&result, "missing field `id`");
}

// ---- AB6: a symbol names one asset -------------------------------------------------------------------------------------------

#[tokio::test]
async fn ab06_duplicate_symbol_reverts() {
    let _slot = slot().await;
    let s = start().await;
    let set = owner_call(
        &s,
        "asset_set",
        json!({ "asset": "near", "entry": near_asset_entry(ONE_NEAR) }),
    )
    .await;
    let text = failure_text(&set);
    assert!(text.is_empty(), "asset_set near failed: {text}");
    for taken in ["NEAR", "near", "Near"] {
        let mut entry = evm_asset_entry();
        entry["symbol"] = json!(taken);
        let result = owner_call(
            &s,
            "asset_set",
            json!({ "asset": WORLD_EVM_ASSET, "entry": entry }),
        )
        .await;
        assert_fails(&result, "symbol already used");
    }
}

// ---- AB7: enrollment is owner only -------------------------------------------------------------------------------------------

#[tokio::test]
async fn ab07_enrollment_owner_only() {
    let _slot = slot().await;
    let w = world().await;
    let (stranger, stranger_signer) =
        create_user_account(&w.net, &w.root, &w.owner_signer, "stranger")
            .await
            .expect("the account is created");
    let args = json!({
        "account_id": w.agent,
        "fingerprint": airlock_policy::agents::fingerprint(w.agent.as_str())
    });
    for (caller, signer) in [(&stranger, &stranger_signer), (&w.agent, &w.agent_signer)] {
        let result = call_as(&w, caller, signer, "allow_agent", args.clone(), 1, 100).await;
        assert_fails(&result, "Caller is not the owner");
    }
    // the template's setters are not exported at all
    for method in ["update_owner_id", "update_mpc_contract_id"] {
        let result = call_transaction_raw(
            &w.policy,
            method,
            b"{}".to_vec(),
            &w.owner,
            &w.owner_signer,
            &w.net,
        )
        .await
        .expect("the call is sent");
        assert_fails(&result, "MethodNotFound");
    }
}

// ---- AB8: the signed bytes are unambiguous -----------------------------------------------------------------------------------

#[test]
fn ab08_borsh_vector_is_unambiguous() {
    let text = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/owner-task.json"
    ));
    let raw: Value = serde_json::from_str(text).expect("the vector parses");
    // the flat extra keys (borsh_hex and the rest) are ignored by the task type
    let task: OwnerTask = serde_json::from_str(text).expect("the vector is an OwnerTask");
    assert_eq!(
        hex::encode(task_bytes(&task)),
        raw["borsh_hex"].as_str().expect("borsh_hex")
    );
    assert_eq!(
        hex::encode(task_hash(&task)),
        raw["sha256_hex"].as_str().expect("sha256_hex")
    );
    assert!(task.bounds.len() >= 2, "the vector has two bounds");
    let mut swapped = task.clone();
    swapped.bounds.swap(0, 1);
    assert_ne!(task_bytes(&swapped), task_bytes(&task));
    assert_ne!(task_hash(&swapped), task_hash(&task));
}

// ---- AB9: the renderer the owner can trust ------------------------------------------------------------------------------------

#[test]
fn ab09_threat_model_names_wallet_as_renderer() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/THREAT_MODEL.md"
    ))
    .expect("docs/THREAT_MODEL.md is readable");
    assert!(
        text.contains(
            "The trusted renderer is the owner's wallet, not the AIRLOCK console, which may share a host with the agent."
        ),
        "docs/THREAT_MODEL.md does not name the wallet as the trusted renderer"
    );
}

// ---- AB10: substitution between the card and the execution -------------------------------------------------------------------

#[tokio::test]
async fn ab10_post_approval_substitution() {
    let _slot = slot().await;
    let w = flood_world().await;
    let evm = evm_key(&w);
    let task = w.signed_task(&[("near:alice.sandbox", 100 * U), (&evm, ONE_ETH)], 20);
    let near_out = escalate(&w, &task, 0).await;
    assert_eq!(near_out["outcome"], "escalated", "{near_out}");
    let near_no = pending_id_of(&near_out).await;
    // `payee_evm` has no cap, so an amount with an untrusted label escalates UntrustedAmount
    let evm_req = w.request_json(
        &task.0,
        1,
        WORLD_EVM_ASSET,
        &evm,
        EVM_AMOUNT,
        (BOOK, EMAIL, OWNER),
        Some(EVM),
    );
    let result = w.submit(vec![evm_req], &task).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    let outcomes: Value = result.json().expect("the outcomes parse");
    assert_eq!(outcomes[0]["outcome"], "escalated", "{outcomes}");
    assert_eq!(outcomes[0]["reason"], "UntrustedAmount", "{outcomes}");
    let evm_no = pending_id_of(&outcomes[0]).await;

    let (stranger, stranger_signer) =
        create_user_account(&w.net, &w.root, &w.owner_signer, "stranger")
            .await
            .expect("the account is created");
    for no in [&near_no, &evm_no] {
        let good = card_of(&w, no).await;
        // one of the five values changed
        for (field, error) in [
            ("to", "WrongRecipient"),
            ("asset", "WrongAsset"),
            ("amount", "WrongAmount"),
            ("why", "WrongReason"),
            ("book", "WrongBook"),
        ] {
            let mut card = good.clone();
            card[field] = json!("999");
            let result = call_as(&w, &w.owner, &w.owner_signer, "approve", card, 1, 150).await;
            assert_fails(&result, &format!("approve rejected: {error}"));
        }
        // the correct arguments from a stranger, and from the owner with no deposit
        let result = call_as(
            &w,
            &stranger,
            &stranger_signer,
            "approve",
            good.clone(),
            1,
            150,
        )
        .await;
        assert_fails(&result, "Caller is not the owner");
        let result = call_as(&w, &w.owner, &w.owner_signer, "approve", good, 0, 150).await;
        assert_fails(&result, "Requires attached deposit of exactly 1 yoctoNEAR");
    }

    // the NEAR approval pays the stored amount to the stored payee
    let alice_before = balance(&w, &w.payee_near).await;
    let approved = approve_ok(&w, &near_no).await;
    let paid = events(&approved, "paid");
    assert_eq!(paid.len(), 1, "{paid:?}");
    assert_eq!(paid[0]["payee"], "near:alice.sandbox");
    assert_eq!(paid[0]["amount"], (2 * U).to_string());
    assert_eq!(balance(&w, &w.payee_near).await - alice_before, 2 * U);

    // the EVM approval signs the stored values
    let nonce: u64 = view(&w, "get_nonce", json!({ "path": WORLD_EVM_PATH }))
        .await
        .as_str()
        .expect("the nonce is a decimal string")
        .parse()
        .expect("a number");
    let approved = approve_ok(&w, &evm_no).await;
    let unsigned = events(&approved, "evm_unsigned");
    assert_eq!(unsigned.len(), 1, "{unsigned:?}");
    let to: [u8; 20] = hex::decode(&w.payee_evm)
        .expect("lowercase hex")
        .try_into()
        .expect("20 bytes");
    let want = hex::encode(build_evm_unsigned(
        84532, nonce, to, EVM_AMOUNT, EVM.0, EVM.1, EVM.2,
    ));
    assert_eq!(unsigned[0]["unsigned_hex"], want.as_str());
}

// ---- AB11: a flood of escalations --------------------------------------------------------------------------------------------

fn assert_blocked(outcome: &Value, reason: &str) {
    assert_eq!(outcome["outcome"], "blocked", "{outcome}");
    assert_eq!(outcome["reason"], reason, "{outcome}");
    assert!(outcome["pending_id"].is_null(), "{outcome}");
}

async fn escalation_state(w: &World) -> Value {
    view(w, "get_escalation_state", json!({ "agent": w.agent })).await
}

#[tokio::test]
async fn ab11_flood() {
    let _slot = slot().await;
    let w = flood_world().await;
    ensure_hour_window(&w, 180_000).await;
    let task = flood_task(&w);
    assert_eq!(task.0.max_actions, 20);

    // three pending, the fourth is refused
    let mut numbers = Vec::new();
    for i in 0..3u8 {
        let out = escalate(&w, &task, i).await;
        assert_eq!(out["outcome"], "escalated", "{out}");
        numbers.push(pending_id_of(&out).await);
    }
    assert_blocked(&escalate(&w, &task, 3).await, "PendingFull");

    // the owner rejects the three; the third reject locks the agent
    for (k, no) in numbers.iter().enumerate() {
        let result = call_as(
            &w,
            &w.owner,
            &w.owner_signer,
            "reject",
            json!({ "id": no }),
            1,
            100,
        )
        .await;
        let text = failure_text(&result);
        assert!(text.is_empty(), "reject {no} failed: {text}");
        let locked = events(&result, "escalations_locked");
        assert_eq!(locked.len(), usize::from(k == 2), "reject {k}: {locked:?}");
    }
    assert_eq!(escalation_state(&w).await["locked"], true);
    assert_blocked(&escalate(&w, &task, 4).await, "EscalationsLocked");

    // the owner unlocks; three more are escalated, six are stored in the hour
    owner_call_ok(
        &w.policy,
        &w.owner,
        &w.owner_signer,
        &w.net,
        "reset_escalations",
        json!({ "agent": w.agent }),
    )
    .await;
    assert_eq!(escalation_state(&w).await["locked"], false);
    let mut next = Vec::new();
    for i in 5..8u8 {
        let out = escalate(&w, &task, i).await;
        assert_eq!(out["outcome"], "escalated", "{out}");
        assert_eq!(out["reason"], "UntrustedAmount", "{out}");
        next.push(pending_id_of(&out).await);
    }
    assert_eq!(escalation_state(&w).await["hour_count"], 6);

    // one approval brings pending to 2, below the cap of 3; the seventh escalation is refused by the hourly budget
    let _ = approve_ok(&w, &next[0]).await;
    assert_eq!(escalation_state(&w).await["pending"], 2);
    assert_blocked(&escalate(&w, &task, 8).await, "EscalationBudget");
}

// ---- AB12: splitting one payment into many -----------------------------------------------------------------------------------

#[tokio::test]
async fn ab12_split_requests_charged_cumulatively() {
    let _slot = slot().await;
    let w = world().await;
    let steps = split_attack(&w, &[1; 11]).await;
    assert_eq!(steps.len(), 11);
    for (i, step) in steps.iter().enumerate().take(10) {
        assert_eq!(step.outcome, "allowed", "request {i}: {step:?}");
    }
    assert_eq!(
        steps[10].outcome, "escalated UntrustedAmount",
        "{:?}",
        steps[10]
    );
    for (i, step) in steps.iter().enumerate() {
        assert!(
            step.untrusted_spent <= 10 * U,
            "request {i}: spent {} is above 10U",
            step.untrusted_spent
        );
    }
}

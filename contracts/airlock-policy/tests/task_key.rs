// AIR-045: the owner's task key and `revoke_task` in the sandbox. Every failure assertion checks the text, because a missing method
// also fails and would pass a bare `assert_failure()`.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, Data, NearToken, Signer};
use serde_json::{Value, json};
use std::sync::Arc;

/// The key of the shared vector seed (fixtures/verdict-vectors.json, `owner_task.public_key`) and a second valid key.
const KEY_A: &str = "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const KEY_B: &str = "ed25519:8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
/// secp256k1 key of 64 bytes, ed25519 texts of 31 and 33 bytes, and text that is not base58.
const KEY_SECP: &str = "secp256k1:2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const KEY_31_BYTES: &str = "ed25519:thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE";
const KEY_33_BYTES: &str = "ed25519:JNArUumxYJcSQpbuxuroRZtcSMVLcy5WbYGt14SRm1Fv";
const KEY_NOT_BASE58: &str = "ed25519:0OIl";

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

async fn stranger(s: &Started) -> (AccountId, Arc<Signer>) {
    create_user_account(&s.net, &s.owner, &s.owner_signer, "stranger")
        .await
        .expect("the stranger account is created")
}

async fn view(s: &Started, method: &str, args: Value) -> Value {
    let answer: Data<Value> = call_view(&s.contract, method, args, &s.net)
        .await
        .unwrap_or_else(|e| panic!("{method} must answer: {e:?}"));
    answer.data
}

/// Calls an owner method with a chosen deposit as the owner.
async fn owner_with(
    s: &Started,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> near_api_types::transaction::result::ExecutionFinalResult {
    call_transaction(
        &s.contract,
        method,
        args,
        &s.owner,
        &s.owner_signer,
        &s.net,
        Some(deposit),
    )
    .await
    .expect("the call is sent")
}

/// The call must fail with `text` in a failed receipt.
fn assert_fails_with(
    result: near_api_types::transaction::result::ExecutionFinalResult,
    text: &str,
) {
    let got = failure_text(&result);
    result.assert_failure();
    assert!(got.contains(text), "expected `{text}` in: {got}");
}

fn hash(byte: u8) -> String {
    hex::encode([byte; 32])
}

#[tokio::test]
async fn owner_sets_a_valid_key() {
    let _slot = slot().await;
    let s = start().await;
    assert_eq!(view(&s, "get_task_key", json!({})).await, Value::Null);
    let result = owner_call(&s, "set_task_key", json!({ "public_key": KEY_A })).await;
    let events = extract_event_logs(&result).unwrap();
    assert!(
        failure_text(&result).is_empty(),
        "{}",
        failure_text(&result)
    );
    result.assert_success();
    assert_eq!(view(&s, "get_task_key", json!({})).await, json!(KEY_A));
    let event = events
        .iter()
        .find(|e| e["event"] == "task_key_set")
        .expect("a task_key_set event");
    assert_eq!(event["standard"], "airlock");
    assert_eq!(event["data"][0]["public_key"], KEY_A);
}

#[tokio::test]
async fn set_task_key_replaces_the_previous_key() {
    let _slot = slot().await;
    let s = start().await;
    owner_call(&s, "set_task_key", json!({ "public_key": KEY_A }))
        .await
        .assert_success();
    owner_call(&s, "set_task_key", json!({ "public_key": KEY_B }))
        .await
        .assert_success();
    assert_eq!(view(&s, "get_task_key", json!({})).await, json!(KEY_B));
}

#[tokio::test]
async fn secp256k1_key_reverts_task_key_must_be_ed25519() {
    let _slot = slot().await;
    let s = start().await;
    let r = owner_call(&s, "set_task_key", json!({ "public_key": KEY_SECP })).await;
    assert_fails_with(r, "task key must be ed25519");
    assert_eq!(view(&s, "get_task_key", json!({})).await, Value::Null);
}

#[tokio::test]
async fn malformed_base58_reverts_bad_task_key() {
    let _slot = slot().await;
    let s = start().await;
    for bad in [KEY_NOT_BASE58, "ed25519:", "not a key", ""] {
        let r = owner_call(&s, "set_task_key", json!({ "public_key": bad })).await;
        assert_fails_with(r, "bad task key");
    }
    assert_eq!(view(&s, "get_task_key", json!({})).await, Value::Null);
}

#[tokio::test]
async fn key_of_the_wrong_length_reverts_bad_task_key() {
    let _slot = slot().await;
    let s = start().await;
    for bad in [KEY_31_BYTES, KEY_33_BYTES] {
        let r = owner_call(&s, "set_task_key", json!({ "public_key": bad })).await;
        assert_fails_with(r, "bad task key");
    }
    assert_eq!(view(&s, "get_task_key", json!({})).await, Value::Null);
}

#[tokio::test]
async fn stranger_set_task_key_reverts_not_owner() {
    let _slot = slot().await;
    let s = start().await;
    let (id, signer) = stranger(&s).await;
    let r = call_transaction(
        &s.contract,
        "set_task_key",
        json!({ "public_key": KEY_A }),
        &id,
        &signer,
        &s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap();
    assert_fails_with(r, NOT_OWNER_TEXT);
    assert_eq!(view(&s, "get_task_key", json!({})).await, Value::Null);
}

#[tokio::test]
async fn set_task_key_without_exactly_one_yocto_reverts() {
    let _slot = slot().await;
    let s = start().await;
    for deposit in [0u128, 2] {
        let r = owner_with(
            &s,
            "set_task_key",
            json!({ "public_key": KEY_A }),
            NearToken::from_yoctonear(deposit),
        )
        .await;
        assert_fails_with(r, ONE_YOCTO_TEXT);
    }
    assert_eq!(view(&s, "get_task_key", json!({})).await, Value::Null);
}

#[tokio::test]
async fn revoke_task_marks_the_hash() {
    let _slot = slot().await;
    let s = start().await;
    let h = hash(0xcd);
    assert_eq!(
        view(&s, "get_task_state", json!({ "task_hash": h })).await,
        json!({ "revoked": false, "actions_used": 0 })
    );
    let result = owner_call(&s, "revoke_task", json!({ "task_hash": h })).await;
    let events = extract_event_logs(&result).unwrap();
    result.assert_success();
    let event = events
        .iter()
        .find(|e| e["event"] == "task_revoked")
        .expect("a task_revoked event");
    assert_eq!(event["data"][0]["task_hash"], h.as_str());
    assert_eq!(
        view(&s, "get_task_state", json!({ "task_hash": h })).await,
        json!({ "revoked": true, "actions_used": 0 })
    );
    // idempotent and final: a second revoke succeeds, another hash is untouched
    owner_call(&s, "revoke_task", json!({ "task_hash": h }))
        .await
        .assert_success();
    assert_eq!(
        view(&s, "get_task_state", json!({ "task_hash": hash(0xce) })).await["revoked"],
        json!(false)
    );
}

#[tokio::test]
async fn bad_task_hashes_revert_bad_task_hash() {
    let _slot = slot().await;
    let s = start().await;
    let ok = hash(0xab);
    for bad in [
        "xyz".to_string(),
        ok[..63].to_string(),
        format!("{ok}0"),
        ok.to_uppercase(),
        String::new(),
    ] {
        let r = owner_call(&s, "revoke_task", json!({ "task_hash": bad })).await;
        assert_fails_with(r, "bad task hash");
        // the view refuses the same text
        let view_result: Result<Data<Value>, _> = call_view(
            &s.contract,
            "get_task_state",
            json!({ "task_hash": bad }),
            &s.net,
        )
        .await;
        let err = format!(
            "{:?}",
            view_result.expect_err("the view must refuse a bad hash")
        );
        assert!(err.contains("bad task hash"), "{bad}: {err}");
    }
}

#[tokio::test]
async fn revoke_task_is_owner_and_one_yocto_only() {
    let _slot = slot().await;
    let s = start().await;
    let h = hash(0xab);
    let (id, signer) = stranger(&s).await;
    let r = call_transaction(
        &s.contract,
        "revoke_task",
        json!({ "task_hash": h }),
        &id,
        &signer,
        &s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap();
    assert_fails_with(r, NOT_OWNER_TEXT);
    let r = owner_with(
        &s,
        "revoke_task",
        json!({ "task_hash": h }),
        NearToken::from_yoctonear(0),
    )
    .await;
    assert_fails_with(r, ONE_YOCTO_TEXT);
    assert_eq!(
        view(&s, "get_task_state", json!({ "task_hash": h })).await["revoked"],
        json!(false),
        "no failed call revoked the task"
    );
}

/// Calls both views and both owner methods and asserts each succeeded: a missing export fails here (the ABI allow list in
/// tests/abi_expected.txt is not consulted).
#[tokio::test]
async fn methods_are_exported() {
    let _slot = slot().await;
    let s = start().await;
    let _: Value = view(&s, "get_task_key", json!({})).await;
    let _: Value = view(&s, "get_task_state", json!({ "task_hash": hash(1) })).await;
    owner_call(&s, "set_task_key", json!({ "public_key": KEY_A }))
        .await
        .assert_success();
    owner_call(&s, "revoke_task", json!({ "task_hash": hash(1) }))
        .await
        .assert_success();
}

/// The signing helpers of `tests/common` sign what the contract's task key verifies: the helper key is the key of the `owner_task`
/// vector, `sign_task` signs the borsh bytes with no prefix, and `signed_task_with` edits before it signs. No sandbox.
#[test]
fn signed_task_helpers_match_the_task_key() {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let (task, signature) = signed_task(&[("near:accountant.test.near", 100)], 3);
    let key: near_sdk::PublicKey = TASK_PUBLIC_KEY.parse().unwrap();
    let raw: [u8; 32] = key.as_bytes()[1..].try_into().unwrap();
    let verifying = VerifyingKey::from_bytes(&raw).unwrap();
    // the public key text is the one of the signing seed
    assert_eq!(
        ed25519_dalek::SigningKey::from_bytes(&TASK_SEED)
            .verifying_key()
            .to_bytes(),
        raw
    );
    let sig = Signature::from_slice(&signature.0).expect("a 64 byte signature");
    verifying
        .verify(&airlock_policy::task::task_bytes(&task), &sig)
        .expect("the signature covers the borsh bytes of the task");
    // an edit made before signing is covered, an edit made after is not
    let (edited, edited_signature) =
        signed_task_with(&[("near:a.test.near", 1)], 2, |t| t.tag = "x".to_string());
    assert_eq!(edited.tag, "x");
    let sig = Signature::from_slice(&edited_signature.0).unwrap();
    verifying
        .verify(&airlock_policy::task::task_bytes(&edited), &sig)
        .expect("the edit is signed");
    let mut tampered = edited.clone();
    tampered.max_actions = 3;
    assert!(
        verifying
            .verify(&airlock_policy::task::task_bytes(&tampered), &sig)
            .is_err()
    );
    // the defaults: the in-process accounts, a window around the wall clock of 5 s before and 30 minutes after
    assert_eq!(task.contract_id.as_str(), "policy.test.near");
    assert_eq!(task.agent_id.as_str(), "agent.test.near");
    assert_eq!(task.expires_ms - task.issued_ms, 1_805_000);
    assert_eq!(task.tag, airlock_policy::task::TASK_TAG);
}

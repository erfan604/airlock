// AIR-110: the two cut contract features. Each has a design in docs/design/ and an ignored test that states the assertions it would
// make; the two live tests pin the limited behavior the README states ("Tasks above the quick cap are not supported in this
// version." and "An issued signature that is never broadcast blocks later nonces for that path; use `set_nonce` or a new path.").
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;

/// At most this many sandboxes run at once (see tests/owner_plane.rs).
static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

async fn slot() -> tokio::sync::SemaphorePermit<'static> {
    SANDBOX_SLOTS
        .acquire()
        .await
        .expect("the semaphore is never closed")
}

/// Design only, docs/design/evm-cancel.md (R2-08). Intended assertions once built:
/// 1. the owner calls `cancel(request_id)` for a request whose EVM signature was issued and never broadcast;
/// 2. the contract signs a zero-value transaction to the owner's own address with the same path and the same nonce, with fees at least
///    10 percent above the first attempt, through a second MPC path (a new `evm_attempts` kind);
/// 3. the request ends `Cancelled`, no ledger charge is refunded twice, and a second `cancel` reverts;
/// 4. the replacement hash differs from the original and both recover to the same sender address.
#[test]
#[ignore = "design only: EVM cancel"]
fn evm_cancel_zero_value_replacement_at_same_nonce() {
    unimplemented!("design only: docs/design/evm-cancel.md");
}

/// Design only, docs/design/nep413-tasks.md (R3-09). Intended assertions once built:
/// 1. a task whose bound exceeds `quick_task_cap` is accepted only with a NEP-413 `signMessage` signature of a registered wallet key;
/// 2. the contract regenerates the message text from the struct, with registry symbols and decimals, and the signed text must equal it
///    byte for byte, so what the wallet shows is what the contract enforces;
/// 3. a signature over any other text, a wrong recipient, a wrong nonce or an expired task reverts;
/// 4. a task key signature over the same struct still reverts `task above quick cap`.
#[test]
#[ignore = "design only: NEP-413 tasks"]
fn nep413_task_above_quick_cap_checked_from_wallet_signature() {
    unimplemented!("design only: docs/design/nep413-tasks.md");
}

/// The wasm exports no `cancel`, no method that cancels a request or a signature, and the recovery methods the README names exist.
#[test]
fn no_cancel_method_is_exported() {
    let exports = wasm_exports();
    assert!(!exports.is_empty(), "the wasm exports nothing");
    let cancelling: Vec<&String> = exports
        .iter()
        .filter(|n| n.contains("cancel") || n.contains("replace") || n.contains("revoke_signature"))
        .collect();
    assert!(
        cancelling.is_empty(),
        "the wasm exports a cancel method: {cancelling:?}"
    );
    for recovery in ["set_nonce", "get_nonce", "asset_set"] {
        assert!(
            exports.iter().any(|n| n == recovery),
            "the recovery method {recovery} is not exported"
        );
    }
}

/// A task whose bound is above the asset's quick cap reverts `task above quick cap`, while the same task at the cap is accepted
/// (asset `near`: hard cap 10,000, quick cap 100,000 NEAR, so 11 actions allow 110,000 by the hard cap and only the quick cap stops it).
#[tokio::test]
async fn task_above_quick_cap_reverts() {
    let _permit = slot().await;
    let w = world().await;
    let payee = format!("near:{}", w.payee_near);
    let request = |w: &World, task: &airlock_policy::task::OwnerTask| {
        w.request_json(
            task,
            0,
            "near",
            &payee,
            ONE_NEAR,
            (
                airlock_verdict::BOOK,
                airlock_verdict::OWNER,
                airlock_verdict::OWNER,
            ),
            None,
        )
    };

    let above = w.signed_task(&[(&payee, 100_001 * ONE_NEAR)], 11);
    let result = w.submit(vec![request(&w, &above.0)], &above).await;
    let text = failure_text(&result);
    assert!(
        text.contains("task above quick cap"),
        "expected `task above quick cap`, got: {text}"
    );

    let at_cap = w.signed_task(&[(&payee, 100_000 * ONE_NEAR)], 11);
    let result = w.submit(vec![request(&w, &at_cap.0)], &at_cap).await;
    let text = failure_text(&result);
    assert!(
        text.is_empty(),
        "a task at the cap must be accepted: {text}"
    );
}

// AIR-041: a deleted method is not callable. A separate file from abi_snapshot.rs so that file keeps exactly 2 passed and
// 1 ignored (the count AIR-061, 062 and 064 check).

mod common;

use common::*;
use serde_json::json;

/// The template's `request_signature` let any registered agent get any digest signed under any path. A call must fail
/// because the method does not exist, not because of a guard inside it (the template says `Agent not registered`).
#[tokio::test]
async fn request_signature_is_not_callable() {
    let s = start().await;
    let args = json!({ "path": "any-path", "payload": "00".repeat(32), "key_type": "Ecdsa" });
    // as the owner (not a registered agent) and with no deposit, exactly as a stranger or an agent would call it
    let result = agent_call(&s, &s.owner, &s.owner_signer, "request_signature", args).await;
    let text = failure_text(&result);
    result.assert_failure();
    assert!(
        text.contains("MethodNotFound"),
        "expected a method-not-found error, got: {text}"
    );
}

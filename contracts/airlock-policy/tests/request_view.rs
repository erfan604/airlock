// AIR-063: the `get_request` view answers in the sandbox. A missing export fails here (the pre-filled ABI list is not consulted).
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::Data;
use serde_json::{Value, json};

#[tokio::test]
async fn get_request_exported_and_none_for_unknown() {
    let s = start().await;
    // a derived request id nobody submitted, a short pending number, and text that is neither
    let derived = format!("{}:0", "ab".repeat(32));
    for id in [derived.as_str(), "1", "0", "not-an-id"] {
        let answer: Data<Value> =
            call_view(&s.contract, "get_request", json!({ "id": id }), &s.net)
                .await
                .unwrap_or_else(|e| panic!("get_request({id}) must answer: {e:?}"));
        assert!(
            answer.data.is_null(),
            "get_request({id}) must be null, got {}",
            answer.data
        );
    }
}

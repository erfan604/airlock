// AIR-062: the `get_ledgers` view is exported by the built wasm and answers for an unknown payee and asset with three zero amounts, not a
// panic. Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first. The pre-filled ABI list in
// tests/abi_expected.txt is not consulted: a missing export fails the call itself.

mod common;

use common::*;
use serde_json::json;

#[tokio::test]
async fn get_ledgers_exported_and_zero_for_unknown() {
    let s = start().await;
    let zero = json!({ "spent": "0", "cap": "0", "remaining": "0" });
    let view = call_view::<serde_json::Value>(
        &s.contract,
        "get_ledgers",
        json!({ "payee": "near:nobody.sandbox", "asset": "near", "task": null }),
        &s.net,
    )
    .await
    .expect("get_ledgers is exported and answers")
    .data;
    assert_eq!(view["asset_day"], zero, "{view}");
    assert_eq!(view["payee_day"], zero, "{view}");
    assert_eq!(view["payee_untrusted_day"], zero, "{view}");
    assert_eq!(view["task_spent"], serde_json::Value::Null, "{view}");
    // a task hash that was never charged reads 0, and a bad one is refused
    let hash = "ab".repeat(32);
    let view = call_view::<serde_json::Value>(
        &s.contract,
        "get_ledgers",
        json!({ "payee": "near:nobody.sandbox", "asset": "near", "task": hash }),
        &s.net,
    )
    .await
    .expect("get_ledgers with a task hash answers")
    .data;
    assert_eq!(view["task_spent"], "0", "{view}");
    let bad = call_view::<serde_json::Value>(
        &s.contract,
        "get_ledgers",
        json!({ "payee": "near:nobody.sandbox", "asset": "near", "task": "not-a-hash" }),
        &s.net,
    )
    .await;
    let text = format!("{bad:?}");
    assert!(text.contains("bad task hash"), "{text}");
}

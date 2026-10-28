//! AIR-103: the committed `tests/contracts/mock_mpc.wasm` is the AIRLOCK mock of `contracts/mock-mpc`, not the Shade template's: `deploy_mock_mpc`
//! asserts its `version` view, and `set_mode` and `call_count` exist only on our mock.
mod common;

use serde_json::json;

#[tokio::test]
async fn deploy_mock_mpc_is_ours() {
    let s = common::start().await;
    let mpc = common::deploy_mock_mpc(&s, "mpc").await;
    let set = common::call_transaction(
        &mpc,
        "set_mode",
        json!({ "mode": "ok" }),
        &s.owner,
        &s.owner_signer,
        &s.net,
        None,
    )
    .await
    .expect("set_mode is sent");
    set.assert_success();
    let count = common::call_view::<u64>(&mpc, "call_count", json!({}), &s.net)
        .await
        .expect("call_count is viewed");
    assert_eq!(count.data, 0);
}

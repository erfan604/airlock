//! AIR-103: sandbox tests of the MPC signer mock (near-sandbox 0.3.9 with neard 2.11.0, near-api 0.8.6). Build the wasm first:
//! `scripts/build-mock-mpc.sh` (or `cargo near build non-reproducible-wasm --no-abi` in this crate), then
//! `cargo test --test mock -- --nocapture --test-threads=2` (each test starts its own sandbox).
//!
//! The sandbox helpers are adapted from NearDeFi/shade-agent-template@816b75b agent-contract/tests/helpers/mod.rs (Apache-2.0),
//! see docs/THIRD_PARTY.md. Every failure message names its text, because a missing method also fails a call.
use near_api::{
    Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, RPCEndpoint, Signer,
    Transaction, advanced::TransactionableOrSigned, signer, types::TxExecutionStatus,
};
use near_api_types::transaction::result::{ExecutionFinalResult, TransactionResult};
use near_sandbox::{GenesisAccount, Sandbox};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

type R<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

const A64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B64: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Where `cargo near build` writes the wasm: `$CARGO_TARGET_DIR/near/mock_mpc.wasm` (scripts/env.sh exports `CARGO_TARGET_DIR`).
fn wasm_path() -> String {
    let dir = std::env::var("CARGO_TARGET_DIR")
        .unwrap_or_else(|_| format!("{}/target", env!("CARGO_MANIFEST_DIR")));
    format!("{dir}/near/mock_mpc.wasm")
}

fn network(sandbox: &Sandbox) -> NetworkConfig {
    NetworkConfig {
        network_name: "sandbox".to_string(),
        rpc_endpoints: vec![RPCEndpoint::new(sandbox.rpc_addr.parse().unwrap())],
        ..NetworkConfig::testnet()
    }
}

/// A sandbox with the mock deployed and initialized at `mpc.sandbox` and a funded caller at `caller.sandbox`.
struct World {
    sandbox: Sandbox,
    net: NetworkConfig,
    mpc: AccountId,
    caller: AccountId,
    caller_signer: Arc<Signer>,
}

async fn create(
    net: &NetworkConfig,
    root: &AccountId,
    root_signer: &Arc<Signer>,
    name: &str,
) -> R<(AccountId, Arc<Signer>)> {
    let id: AccountId = format!("{name}.{root}").parse()?;
    let sk = signer::generate_secret_key()?;
    Account::create_account(id.clone())
        .fund_myself(root.clone(), NearToken::from_near(20))
        .with_public_key(sk.public_key())
        .with_signer(root_signer.clone())
        .send_to(net)
        .await?
        .assert_success();
    Ok((id, Signer::from_secret_key(sk)?))
}

async fn world() -> R<World> {
    let path = wasm_path();
    assert!(
        std::path::Path::new(&path).exists(),
        "{path} does not exist: run scripts/build-mock-mpc.sh first"
    );
    let sandbox = Sandbox::start_sandbox().await?;
    let net = network(&sandbox);
    let g = GenesisAccount::default();
    let root: AccountId = g.account_id.to_string().parse()?;
    let root_signer = Signer::from_secret_key(g.private_key.parse()?)?;
    let (mpc, mpc_signer) = create(&net, &root, &root_signer, "mpc").await?;
    Contract::deploy(mpc.clone())
        .use_code(std::fs::read(&path)?)
        .with_init_call("new", json!({}))?
        .with_signer(mpc_signer)
        .send_to(&net)
        .await?
        .assert_success();
    let (caller, caller_signer) = create(&net, &root, &root_signer, "caller").await?;
    Ok(World {
        sandbox,
        net,
        mpc,
        caller,
        caller_signer,
    })
}

/// A call as the caller; returns the full result (a failed receipt is not an Err here).
async fn call(
    w: &World,
    method: &str,
    args: Value,
    tgas: u64,
    yocto: u128,
) -> R<ExecutionFinalResult> {
    let r = Contract(w.mpc.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(tgas))
        .deposit(NearToken::from_yoctonear(yocto))
        .with_signer(w.caller.clone(), w.caller_signer.clone())
        .send_to(&w.net)
        .await?;
    match r {
        TransactionResult::Full(r) => Ok(*r),
        TransactionResult::Pending { status } => Err(format!("pending: {status:?}").into()),
    }
}

async fn view<T: near_sdk::serde::de::DeserializeOwned + Send + Sync>(
    w: &World,
    method: &str,
) -> R<T> {
    Ok(Contract(w.mpc.clone())
        .call_function(method, json!({}))
        .read_only::<T>()
        .fetch_from(&w.net)
        .await?
        .data)
}

/// The failure text lives only in the Debug form: `ExecutionOutcome.status` is pub(crate) in near-api-types 0.8.6.
fn failure_text(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

fn sign_args(path: &str, payload_hex: &str) -> Value {
    json!({"request": {"path": path, "payload_v2": {"Ecdsa": payload_hex}, "domain_id": 0}})
}

/// `sign` as the caller with 30 Tgas and 1 yocto.
async fn sign_ok(w: &World, path: &str, payload_hex: &str) -> R<ExecutionFinalResult> {
    call(w, "sign", sign_args(path, payload_hex), 30, 1).await
}

async fn set_mode(w: &World, mode: &str) -> R<ExecutionFinalResult> {
    call(w, "set_mode", json!({ "mode": mode }), 30, 0).await
}

fn assert_failed_with(r: &ExecutionFinalResult, text: &str) {
    let t = failure_text(r);
    assert!(
        t.contains(text),
        "expected a failure with {text:?}, got: {t}"
    );
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Sends `sign` and returns at once with the transaction hash (the parked request keeps the receipt tree open).
async fn send_parked(w: &World, path: &str, payload_hex: &str) -> R<near_api_types::CryptoHash> {
    let ex = Contract(w.mpc.clone())
        .call_function("sign", sign_args(path, payload_hex))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(w.caller.clone(), w.caller_signer.clone())
        .wait_until(TxExecutionStatus::Included)
        .presign_with(&w.net)
        .await?;
    let hash = match &ex.transaction {
        TransactionableOrSigned::Signed((s, _)) => s.get_hash(),
        _ => return Err("the transaction was not signed".into()),
    };
    let pending = ex.send_to(&w.net).await?;
    assert!(
        matches!(pending, TransactionResult::Pending { .. }),
        "Included returns Pending at once"
    );
    Ok(hash)
}

/// Waits until `parked()` shows `want` (the parked receipt takes a block or two to land).
async fn wait_parked(w: &World, want: u64) -> R<()> {
    let mut seen = 0;
    for _ in 0..50 {
        seen = view::<u64>(w, "parked").await?;
        if seen == want {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(format!("parked() is {seen}, wanted {want}").into())
}

async fn final_result(w: &World, hash: near_api_types::CryptoHash) -> R<ExecutionFinalResult> {
    Ok(
        Transaction::status_with_options(w.caller.clone(), hash, TxExecutionStatus::Final)
            .fetch_from(&w.net)
            .await?,
    )
}

#[tokio::test]
async fn ok_mode_returns_the_real_shape() -> R<()> {
    let w = world().await?;
    let r = sign_ok(&w, "p1", A64).await?;
    assert!(r.is_success(), "ok mode must succeed: {}", failure_text(&r));
    let v: Value = r.json()?;
    let mut keys: Vec<&str> = v
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["big_r", "recovery_id", "s", "scheme"], "{v}");
    assert_eq!(v["scheme"], "Secp256k1");
    let point = v["big_r"]["affine_point"].as_str().expect("affine_point");
    assert_eq!(point.len(), 66, "{point}");
    assert!(
        point.starts_with("02") || point.starts_with("03"),
        "{point}"
    );
    assert!(is_lower_hex(point), "{point}");
    let scalar = v["s"]["scalar"].as_str().expect("scalar");
    assert_eq!(scalar.len(), 64, "{scalar}");
    assert!(is_lower_hex(scalar), "{scalar}");
    assert!(
        scalar.bytes().any(|b| b != b'0'),
        "the scalar must not be zero"
    );
    assert!(v["recovery_id"].as_u64().expect("recovery_id") <= 3, "{v}");
    Ok(())
}

#[tokio::test]
async fn sign_requires_a_deposit() -> R<()> {
    let w = world().await?;
    let none = call(&w, "sign", sign_args("p1", A64), 30, 0).await?;
    assert_failed_with(&none, "Attached deposit is lower than required");
    for yocto in [1, 5] {
        let r = call(&w, "sign", sign_args("p1", A64), 30, yocto).await?;
        assert!(
            r.is_success(),
            "{yocto} yocto must be accepted: {}",
            failure_text(&r)
        );
    }
    Ok(())
}

#[tokio::test]
async fn sign_requires_15_tgas() -> R<()> {
    let w = world().await?;
    let low = call(&w, "sign", sign_args("p1", A64), 14, 1).await?;
    assert_failed_with(&low, "Require at least 15 Tgas");
    let ok = call(&w, "sign", sign_args("p1", A64), 15, 1).await?;
    assert!(
        ok.is_success(),
        "15 Tgas must be accepted: {}",
        failure_text(&ok)
    );
    Ok(())
}

#[tokio::test]
async fn sign_rejects_a_bad_payload_or_domain() -> R<()> {
    let w = world().await?;
    let short = call(&w, "sign", sign_args("p1", &A64[..63]), 30, 1).await?;
    assert_failed_with(&short, "Ecdsa payload must be exactly 32 bytes");
    let not_hex = format!("{}g", &A64[..63]);
    let bad = call(&w, "sign", sign_args("p1", &not_hex), 30, 1).await?;
    assert_failed_with(&bad, "Ecdsa payload must be exactly 32 bytes");
    let domain = json!({"request": {"path": "p1", "payload_v2": {"Ecdsa": A64}, "domain_id": 1}});
    let r = call(&w, "sign", domain, 30, 1).await?;
    assert_failed_with(&r, "Unknown domain");
    let eddsa = json!({"request": {"path": "p1", "payload_v2": {"Eddsa": A64}, "domain_id": 0}});
    let r = call(&w, "sign", eddsa, 30, 1).await?;
    assert_failed_with(&r, "Eddsa is not supported by the mock");
    // upper case hex is fine, the real signer takes either case
    let upper = A64.to_uppercase();
    let r = sign_ok(&w, "p1", &upper).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert_eq!(view::<u64>(&w, "call_count").await?, 1);
    Ok(())
}

#[tokio::test]
async fn last_request_and_call_count() -> R<()> {
    let w = world().await?;
    assert_eq!(view::<u64>(&w, "call_count").await?, 0);
    assert_eq!(view::<Value>(&w, "last_request").await?, Value::Null);
    let mixed = "AbCdEf0123456789aBcDeF0123456789AbCdEf0123456789aBcDeF0123456789";
    let r = sign_ok(&w, "evm,1", mixed).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert_eq!(view::<u64>(&w, "call_count").await?, 1);
    assert_eq!(
        view::<Value>(&w, "last_request").await?,
        json!({"path": "evm,1", "payload_hex": mixed})
    );
    let r = sign_ok(&w, "evm,2", B64).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert_eq!(view::<u64>(&w, "call_count").await?, 2);
    assert_eq!(
        view::<Value>(&w, "last_request").await?,
        json!({"path": "evm,2", "payload_hex": B64})
    );
    Ok(())
}

#[tokio::test]
async fn fail_mode_panics_and_rolls_back() -> R<()> {
    let w = world().await?;
    let first = sign_ok(&w, "p1", A64).await?;
    assert!(first.is_success(), "{}", failure_text(&first));
    let mode = set_mode(&w, "fail").await?;
    assert!(mode.is_success(), "{}", failure_text(&mode));
    let r = sign_ok(&w, "p2", B64).await?;
    assert_failed_with(&r, "mock mpc failure");
    // the panic rolled the receipt back: no count, no new last request
    assert_eq!(view::<u64>(&w, "call_count").await?, 1);
    assert_eq!(
        view::<Value>(&w, "last_request").await?,
        json!({"path": "p1", "payload_hex": A64})
    );
    Ok(())
}

#[tokio::test]
async fn garbage_mode_returns_the_unexpected_object() -> R<()> {
    let w = world().await?;
    let mode = set_mode(&w, "garbage").await?;
    assert!(mode.is_success(), "{}", failure_text(&mode));
    let r = sign_ok(&w, "p1", A64).await?;
    assert!(
        r.is_success(),
        "garbage mode must succeed: {}",
        failure_text(&r)
    );
    let v: Value = r.json()?;
    assert_eq!(v, json!({"unexpected": true}));
    assert_eq!(view::<u64>(&w, "call_count").await?, 1);
    Ok(())
}

#[tokio::test]
async fn set_mode_accepts_exactly_four_modes() -> R<()> {
    let w = world().await?;
    assert_eq!(view::<String>(&w, "mode").await?, "ok");
    for mode in ["fail", "garbage", "yield", "ok"] {
        let r = set_mode(&w, mode).await?;
        assert!(
            r.is_success(),
            "{mode} must be accepted: {}",
            failure_text(&r)
        );
        assert_eq!(view::<String>(&w, "mode").await?, mode);
    }
    for bad in ["OK", "", "yielding", "okay", "Fail", " ok"] {
        let r = set_mode(&w, bad).await?;
        assert_failed_with(&r, "unknown mode");
        assert_eq!(
            view::<String>(&w, "mode").await?,
            "ok",
            "{bad:?} must change nothing"
        );
    }
    Ok(())
}

#[tokio::test]
async fn version_is_mock() -> R<()> {
    let w = world().await?;
    assert_eq!(view::<String>(&w, "version").await?, "mock-3.17.0");
    Ok(())
}

#[tokio::test]
async fn yield_mode_resume_returns_the_signature() -> R<()> {
    let w = world().await?;
    let mode = set_mode(&w, "yield").await?;
    assert!(mode.is_success(), "{}", failure_text(&mode));
    let hash = send_parked(&w, "p1", A64).await?;
    wait_parked(&w, 1).await?;
    let resumed = call(&w, "resume", json!({}), 30, 0).await?;
    assert!(resumed.is_success(), "resume: {}", failure_text(&resumed));
    let fin = final_result(&w, hash).await?;
    assert!(
        fin.is_success(),
        "the parked sign must succeed: {}",
        failure_text(&fin)
    );
    let v: Value = fin.json()?;
    assert_eq!(v["scheme"], "Secp256k1", "{v}");
    assert_eq!(
        v["big_r"]["affine_point"].as_str().map(str::len),
        Some(66),
        "{v}"
    );
    assert_eq!(view::<u64>(&w, "parked").await?, 0);
    // nothing is parked any more
    let again = call(&w, "resume", json!({}), 30, 0).await?;
    assert_failed_with(&again, "no parked request");
    Ok(())
}

#[tokio::test]
async fn yield_mode_times_out() -> R<()> {
    let w = world().await?;
    let mode = set_mode(&w, "yield").await?;
    assert!(mode.is_success(), "{}", failure_text(&mode));
    let hash = send_parked(&w, "p1", A64).await?;
    wait_parked(&w, 1).await?;
    if let Err(e) = w.sandbox.fast_forward(200).await {
        println!("SKIP yield timeout: {e}");
        return Ok(());
    }
    let fin = final_result(&w, hash).await?;
    assert!(
        failure_text(&fin).contains("Request has timed out."),
        "expected the timeout text, got: {}",
        failure_text(&fin)
    );
    println!("YIELD TIMEOUT OK");
    // the dead id stays listed until a resume skips it, so a second park makes two
    let before = view::<u64>(&w, "parked").await?;
    assert_eq!(before, 1, "the timed-out id is still counted");
    let hash2 = send_parked(&w, "p2", B64).await?;
    wait_parked(&w, 2).await?;
    let resumed = call(&w, "resume", json!({}), 30, 0).await?;
    assert!(resumed.is_success(), "resume: {}", failure_text(&resumed));
    let fin2 = final_result(&w, hash2).await?;
    assert!(
        fin2.is_success(),
        "the second parked sign must succeed: {}",
        failure_text(&fin2)
    );
    let v: Value = fin2.json()?;
    assert_eq!(v["scheme"], "Secp256k1", "{v}");
    assert_eq!(view::<u64>(&w, "parked").await?, 0);
    Ok(())
}

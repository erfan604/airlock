// AIR-326: no view, no raw state key or value and no event of the contract names an unpaid payee, its salt, or its numbers. The test
// commits a book of known names and distinctive numbers, pays one payee, then reads everything a stranger can read (every view of the
// ABI that takes no secret, the raw state under the empty prefix, the logs of the owner's call) and looks for the unpaid payees as text,
// hex, base64 and decimal. A paid payee is the control: it must appear, because the payment names it. A dictionary pass checks that
// no 32 byte value of the state is the hash of a candidate name, with or without a guessed salt.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use airlock_policy::book::{Entry, build, leaf_hash};
use common::*;
use near_api::{Contract, NearToken};
use near_sdk::json_types::Base64VecU8;
use serde_json::{Value, json};

const OWNER_MASK: u16 = airlock_verdict::OWNER;
const BOOK_MASK: u16 = airlock_verdict::BOOK;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const PAID: &str = "near:alice.sandbox";
// distinctive, so a decimal match cannot be an accident
const UNPAID: [(&str, u128, u128, u128); 3] = [
    (
        "near:landlord-secret.sandbox",
        123_456_789_012_345_678_901u128,
        987_654_321_098_765_432_109,
        555_444_333_222_111_000_999,
    ),
    (
        "near:lawyer-private.sandbox",
        222_333_444_555_666_777_881,
        111_000_111_000_111_000_113,
        909_090_909_090_909_090_907,
    ),
    (
        "evm:84532:0xabcdef0123456789abcdef0123456789abcdef01",
        333_222_111_000_999_888_773,
        424_242_424_242_424_242_429,
        717_171_717_171_717_171_713,
    ),
];

static SANDBOX_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

fn b64(bytes: &[u8]) -> String {
    let v = serde_json::to_value(Base64VecU8(bytes.to_vec())).unwrap();
    v.as_str().unwrap().to_string()
}

/// Every needle a reader could search for to find `text` in bytes: text, hex, base64 of the text bytes.
fn needles_of_text(text: &str) -> Vec<Vec<u8>> {
    vec![
        text.as_bytes().to_vec(),
        hex::encode(text).into_bytes(),
        b64(text.as_bytes()).into_bytes(),
    ]
}

/// A number as a reader could find it: decimal text, and 16 bytes little endian (Borsh) and big endian (our leaf).
fn needles_of_number(n: u128) -> Vec<Vec<u8>> {
    vec![
        n.to_string().into_bytes(),
        n.to_le_bytes().to_vec(),
        n.to_be_bytes().to_vec(),
    ]
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

#[tokio::test]
async fn nothing_a_stranger_can_read_names_an_unpaid_payee() {
    let _slot = SANDBOX_SLOTS.acquire().await.unwrap();
    let w = world().await;
    // the committed book: the paid payee and three unpaid ones, each with its own salt
    let entries: Vec<Entry> =
        std::iter::once((PAID, 100 * ONE_NEAR, 1_000 * ONE_NEAR, 5_000 * ONE_NEAR))
            .chain(UNPAID.iter().copied())
            .enumerate()
            .map(|(i, (payee, cap, budget, limit))| Entry {
                salt: [(i as u8 + 1) * 17; 32],
                payee: payee.to_string(),
                cap: Some(cap),
                daily_untrusted_budget: budget,
                daily_limit: limit,
            })
            .collect();
    let (root, proofs) = build(&entries, &[3; 32]);
    let old = call_view::<Value>(&w.policy, "get_book_root", json!({}), &w.net)
        .await
        .unwrap()
        .data;
    let set = call_transaction(
        &w.policy,
        "book_set_root",
        json!({ "expected_old": old, "new_root": hex::encode(root) }),
        &w.owner,
        &w.owner_signer,
        &w.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .unwrap();
    assert!(failure_text(&set).is_empty(), "{}", failure_text(&set));
    let mut hay: Vec<u8> = serde_json::to_vec(&extract_event_logs(&set).unwrap()).unwrap();

    // pay the first entry with its proof: the payment names PAID, and only PAID
    let task = w.signed_task(&[(PAID, 10 * ONE_NEAR)], 1);
    let mut req = w.request_json(
        &task.0,
        0,
        "near",
        PAID,
        10,
        (BOOK_MASK, OWNER_MASK, OWNER_MASK),
        None,
    );
    req["book"] = serde_json::to_value(&proofs[0]).unwrap();
    let paid = w.submit(vec![req], &task).await;
    assert!(failure_text(&paid).is_empty(), "{}", failure_text(&paid));
    let outs: Value = paid.json().unwrap();
    assert_eq!(outs[0]["outcome"], "allowed", "{outs}");

    // the views a stranger can call without a secret
    for (method, args) in [
        ("get_book_root", json!({})),
        ("get_book_epoch", json!({})),
        ("list_assets", json!({})),
        ("get_pending", json!({})),
        ("get_agents", json!({})),
        ("get_contract_info", json!({})),
    ] {
        if let Ok(a) = call_view::<Value>(&w.policy, method, args, &w.net).await {
            hay.extend(serde_json::to_vec(&a.data).unwrap());
        }
    }
    // the ledgers of an unpaid payee, asked without its proof, answer zeros and name nothing new
    for (name, ..) in UNPAID {
        let a = call_view::<Value>(&w.policy, "get_ledgers", json!({ "payee": name, "asset": airlock_policy::keys::asset_for_payee_key(name), "task": null }), &w.net)
            .await;
        if let Ok(a) = a {
            let text = serde_json::to_string(&a.data).unwrap();
            assert!(!text.contains("secret"), "{text}");
        }
    }
    // the raw state: every key and every value
    let state = Contract(w.policy.clone())
        .view_storage_with_prefix(&[])
        .fetch_from(&w.net)
        .await
        .expect("the state is readable")
        .data;
    let mut state_bytes: Vec<u8> = Vec::new();
    let mut state_values: Vec<Vec<u8>> = Vec::new();
    for item in &state.values {
        let k = serde_json::from_value::<Base64VecU8>(Value::String(item.key.0.clone()))
            .unwrap()
            .0;
        let v = serde_json::from_value::<Base64VecU8>(Value::String(item.value.0.clone()))
            .unwrap()
            .0;
        state_bytes.extend(&k);
        state_bytes.extend(&v);
        state_values.push(v);
    }
    hay.extend(&state_bytes);
    assert!(!state.values.is_empty());

    // the control: the paid payee is readable (the payment put it in the record)
    assert!(
        contains(&hay, PAID.as_bytes()),
        "the paid payee is public after the payment"
    );

    for (name, cap, budget, limit) in UNPAID {
        for n in needles_of_text(name) {
            assert!(
                !contains(&hay, &n),
                "{name} found as {:?}",
                String::from_utf8_lossy(&n)
            );
        }
        for number in [cap, budget, limit] {
            for n in needles_of_number(number) {
                assert!(!contains(&hay, &n), "{name}: a number was found ({number})");
            }
        }
    }
    // no label, no listing and no salt of an unpaid entry
    for (i, e) in entries.iter().enumerate().skip(1) {
        assert!(
            !contains(&hay, &e.salt),
            "the salt of entry {i} is on chain"
        );
        assert!(
            !contains(&hay, hex::encode(e.salt).as_bytes()),
            "the salt of entry {i} is on chain as hex"
        );
    }
    // the dictionary pass: the hash of a candidate name, bare or with a guessed salt, is not any 32 byte value of the state
    let mut guesses: Vec<[u8; 32]> = Vec::new();
    for (name, cap, budget, limit) in UNPAID
        .iter()
        .map(|u| (u.0, u.1, u.2, u.3))
        .chain([(PAID, 0, 0, 0)])
    {
        for salt in 0u8..=255 {
            guesses.push(leaf_hash(&[salt; 32], name, Some(cap), budget, limit));
            guesses.push(leaf_hash(&[salt; 32], name, None, 0, 0));
        }
        guesses.push(near_sdk::env::sha256_array(name.as_bytes()));
        guesses.push(near_sdk::env::keccak256_array(name.as_bytes()));
    }
    for g in &guesses {
        assert!(
            !state_values
                .iter()
                .any(|v| v.windows(32).any(|win| win == g)),
            "a guessed commitment appears in the state"
        );
    }
}

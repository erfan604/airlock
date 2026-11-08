// AIR-064: the closed event vocabulary of the contract (docs/events.md) and RT-24, no agent free text in events. One mixed scenario
// runs once in the sandbox (owner policy edits, two agents, a batch with an Allow, an escalation and a Block, revocations) and every
// `EVENT_JSON:` log of it is collected. The four tests then read that one record:
//  - every line parses and has the envelope `{ standard: "airlock", version: "1.0.0", event, data }` with `data` a one-element array
//    holding one object (the template's shape, fixed by AIR-040);
//  - every event name is in the closed list, the closed list equals the names documented in docs/events.md, and each emitted event
//    carries exactly the data fields the document names for it;
//  - nothing the agent chose reaches an event: the task id, the trace digest and the plan hash it sent appear in no value, and every
//    string of the gate's events is a value the contract derived (task hash, request id), a registry id, a canonical payee key, the
//    agent's account id, a closed reason name or a decimal number;
//  - `id` is the decimal pending number in `escalated` (and `approved`, `rejected`, `expired` once those exist) and in no other event.
//
// Needs the wasm: `cargo near build non-reproducible-wasm --no-abi` in the crate first.

mod common;

use common::*;
use near_api::{AccountId, NearToken, Signer};
use near_api_types::transaction::result::ExecutionFinalResult;
use serde_json::{Value, json};
use shade_attestation::attestation::create_mock_dstack_attestation;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tokio::sync::OnceCell;

/// The closed list of docs/events.md, in the order of the ticket.
const CLOSED_LIST: [&str; 29] = [
    "submitted",
    "allowed",
    "escalated",
    "blocked",
    "approved",
    "rejected",
    "expired",
    "escalations_locked",
    "escalations_reset",
    "signed",
    "x402_signed",
    "evm_unsigned",
    "sol_unsigned",
    "sol_signed",
    "paid",
    "failed",
    "agent_allowed",
    "agent_revoked",
    "task_key_set",
    "task_revoked",
    "nonce_set",
    "asset_set",
    "asset_removed",
    "book_root_set",
    "sol_sender_set",
    "flags_set",
    "paused",
    "agent_registered",
    "agent_removed",
];

/// The events the contract emits today: the scenario must produce every one of them. Later tickets add the rest of the closed
/// list, and the scenario may then produce those too (AIR-101: a NEAR Allow pays in the same transaction, so `paid` is produced).
const EMITTED_TODAY: [&str; 16] = [
    "submitted",
    "allowed",
    "paid",
    "escalated",
    "blocked",
    "agent_allowed",
    "agent_revoked",
    "task_key_set",
    "task_revoked",
    "asset_set",
    "asset_removed",
    "book_root_set",
    "flags_set",
    "paused",
    "agent_registered",
    "agent_removed",
];

/// The events whose `id` is the decimal pending number. Every other event has no `id` key.
const EVENTS_WITH_ID: [&str; 4] = ["escalated", "approved", "rejected", "expired"];

const ALICE: &str = "near:alice.sandbox";
const BOB: &str = "near:bob.sandbox";
const CAROL: &str = "near:carol.sandbox";
const EVM_ASSET: &str = "evm:84532:native";

/// The three values the agent chooses in its requests. None may reach an event.
const TASK_ID_TEXT: &str = "agent-text-marker-7f3a";

fn trace_digest() -> String {
    hex::encode([0xc3u8; 32])
}

fn plan_hash() -> String {
    hex::encode([0x11u8; 32])
}

/// What the scenario recorded.
struct Scenario {
    /// Every `EVENT_JSON:` payload (the text after the prefix) in the order the contract logged it.
    lines: Vec<String>,
    task_hash: String,
    agent: String,
    outcomes: Vec<Value>,
}

impl Scenario {
    fn events(&self) -> Vec<Value> {
        self.lines
            .iter()
            .map(|line| {
                serde_json::from_str(line).unwrap_or_else(|e| panic!("`{line}` is not JSON: {e}"))
            })
            .collect()
    }
}

fn collect(lines: &mut Vec<String>, result: &ExecutionFinalResult) {
    for log in result.logs() {
        if let Some(payload) = log.strip_prefix("EVENT_JSON:") {
            lines.push(payload.to_string());
        }
    }
}

async fn owner(s: &Started, lines: &mut Vec<String>, method: &str, args: Value) {
    let result = owner_call(s, method, args).await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "{method} failed: {text}");
    collect(lines, &result);
    result.assert_success();
}

/// Whitelists and registers `agent` in local mode, then the owner allows it, keeping the events of all three calls.
async fn register_and_allow(
    s: &Started,
    lines: &mut Vec<String>,
    agent: &AccountId,
    signer: &Arc<Signer>,
) {
    let whitelisted = call_transaction(
        &s.contract,
        "whitelist_agent_for_local",
        json!({ "account_id": agent }),
        &s.owner,
        &s.owner_signer,
        &s.net,
        Some(NearToken::from_yoctonear(1)),
    )
    .await
    .expect("whitelist_agent_for_local is sent");
    collect(lines, &whitelisted);
    whitelisted.assert_success();
    let registered = call_transaction(
        &s.contract,
        "register_agent",
        json!({ "attestation": serde_json::to_value(create_mock_dstack_attestation()).unwrap() }),
        agent,
        signer,
        &s.net,
        Some(DEPOSIT_005_NEAR),
    )
    .await
    .expect("register_agent is sent");
    collect(lines, &registered);
    registered.assert_success();
    owner(
        s,
        lines,
        "allow_agent",
        json!({
            "account_id": agent,
            "fingerprint": airlock_policy::agents::fingerprint(agent.as_str())
        }),
    )
    .await;
}

/// A request with the agent's own text in it: the task id and the hints are values the agent chose.
fn req(index: u8, payee: &str, amount: u128, labels: [u16; 3]) -> Value {
    json!({
        "task_id": TASK_ID_TEXT,
        "action_index": index,
        "asset": airlock_policy::keys::asset_for_payee_key(payee),
        "payee": payee,
        "amount": amount.to_string(),
        "labels": { "recipient": labels[0], "amount": labels[1], "pc": labels[2] },
        "evm": null,
        "hints": { "plan_hash": plan_hash(), "trace_digest": trace_digest() }
    })
}

fn near_entry() -> Value {
    json!({
        "symbol": "NEAR",
        "decimals": 24,
        "hard_cap": "10000",
        "daily_cap": "100000",
        "max_fee_per_gas": "0",
        "max_gas": "0",
        "quick_task_cap": "100000",
        "path": null
    })
}

fn evm_entry() -> Value {
    json!({
        "symbol": "ETH.base",
        "decimals": 18,
        "hard_cap": "1000000000000000000",
        "daily_cap": "10000000000000000000",
        "max_fee_per_gas": "50000000000",
        "max_gas": "100000",
        "quick_task_cap": "5000000000000000000",
        "path": "base-sepolia-1"
    })
}

async fn run_scenario() -> Scenario {
    let owner_label: u16 = airlock_verdict::OWNER;
    let book_label: u16 = airlock_verdict::BOOK;
    let s = start().await;
    // AIR-101: the Allow of the batch below is paid by the contract, so its payee must exist
    create_user_account(&s.net, &s.owner, &s.owner_signer, "alice")
        .await
        .expect("the payee account is created");
    let mut lines = Vec::new();
    let l = &mut lines;
    // the owner's policy: assets, the book, flags, pause and resume, the task key
    owner(
        &s,
        l,
        "asset_set",
        json!({ "asset": "near", "entry": near_entry() }),
    )
    .await;
    owner(
        &s,
        l,
        "asset_set",
        json!({ "asset": EVM_ASSET, "entry": evm_entry() }),
    )
    .await;
    owner(&s, l, "asset_remove", json!({ "asset": EVM_ASSET })).await;
    for (key, label) in [(ALICE, "Alice"), (CAROL, "Carol")] {
        owner(
            &s,
            l,
            "book_add",
            json!({
                "key": key,
                "cap": "100",
                "daily_untrusted_budget": "1000",
                "daily_limit": "5000",
                "label": label
            }),
        )
        .await;
    }
    owner(&s, l, "book_remove", json!({ "key": CAROL })).await;
    owner(
        &s,
        l,
        "set_flags",
        json!({ "flags": {
            "max_pending_per_agent": 4,
            "pending_ttl_ms": "3600000",
            "hourly_escalation_budget": 6,
            "lock_consecutive_rejects": 3,
            "lock_rejects_per_day": 20,
            "max_task_ttl_ms": "3600000",
            "max_task_actions": 20
        } }),
    )
    .await;
    owner(&s, l, "pause", json!({ "paused": true })).await;
    owner(&s, l, "pause", json!({ "paused": false })).await;
    owner(
        &s,
        l,
        "set_task_key",
        json!({ "public_key": TASK_PUBLIC_KEY }),
    )
    .await;
    // the agent
    let (agent, agent_signer) = create_user_account(&s.net, &s.owner, &s.owner_signer, "agent")
        .await
        .expect("the agent account is created");
    register_and_allow(&s, l, &agent, &agent_signer).await;
    // one batch: an Allow, an escalation (a payee outside the book) and a Block (over the hard cap)
    let contract: near_sdk::AccountId = s.contract.as_str().parse().unwrap();
    let agent_id: near_sdk::AccountId = agent.as_str().parse().unwrap();
    let (task, sig) = signed_task_with(&[(ALICE, 50_000), (BOB, 1_000)], 20, |t| {
        t.contract_id = contract;
        t.agent_id = agent_id;
        t.task_id = TASK_ID_TEXT.to_string();
    });
    let task_hash = hex::encode(airlock_policy::task::task_hash(&task));
    let reqs = vec![
        req(0, ALICE, 10, [book_label, owner_label, owner_label]),
        req(1, BOB, 10, [owner_label, owner_label, owner_label]),
        req(2, ALICE, 10_001, [book_label, owner_label, owner_label]),
    ];
    let result = agent_call(
        &s,
        &agent,
        &agent_signer,
        "submit_batch",
        json!({ "reqs": reqs, "task": task, "task_sig": sig }),
    )
    .await;
    let text = failure_text(&result);
    assert!(text.is_empty(), "submit_batch failed: {text}");
    collect(l, &result);
    let outcomes: Value = result.json().expect("the outcomes parse");
    let outcomes = outcomes.as_array().expect("an array of outcomes").clone();
    // revocations and removals: the task, a second agent allowed then revoked then removed
    owner(&s, l, "revoke_task", json!({ "task_hash": task_hash })).await;
    let (agent2, signer2) = create_user_account(&s.net, &s.owner, &s.owner_signer, "agenttwo")
        .await
        .expect("the second agent account is created");
    register_and_allow(&s, l, &agent2, &signer2).await;
    owner(&s, l, "revoke_agent", json!({ "account_id": agent2 })).await;
    owner(&s, l, "remove_agent", json!({ "account_id": agent2 })).await;
    Scenario {
        lines,
        task_hash,
        agent: agent.to_string(),
        outcomes,
    }
}

/// The scenario runs once and the four tests share its record (each test has its own runtime, and the cell only holds data).
async fn scenario() -> &'static Scenario {
    static CELL: OnceCell<Scenario> = OnceCell::const_new();
    CELL.get_or_init(run_scenario).await
}

/// The text between the backticks of a table cell: `` `a: string`, `b: number` `` gives `a: string` and `b: number`.
fn code_spans(cell: &str) -> Vec<String> {
    cell.split('`')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, span)| span.to_string())
        .collect()
}

/// docs/events.md as a map of event name to the data field names of its row. A row is `| `name` | `field: type`, ... | emitted by |`.
fn documented() -> BTreeMap<String, Vec<String>> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/events.md");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let mut rows = BTreeMap::new();
    for line in text.lines() {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        if cells.len() < 4 || !(cells[1].starts_with('`') && cells[1].ends_with('`')) {
            continue;
        }
        let name = cells[1].trim_matches('`').to_string();
        let fields = code_spans(cells[2])
            .iter()
            .map(|span| span.split(':').next().unwrap_or("").trim().to_string())
            .collect();
        assert!(
            rows.insert(name.clone(), fields).is_none(),
            "{name} is documented twice"
        );
    }
    rows
}

/// Every string in a JSON value, at any depth, and every object key.
fn strings_and_keys(v: &Value, strings: &mut Vec<String>, keys: &mut Vec<String>) {
    match v {
        Value::String(s) => strings.push(s.clone()),
        Value::Array(items) => items
            .iter()
            .for_each(|item| strings_and_keys(item, strings, keys)),
        Value::Object(map) => {
            for (key, value) in map {
                keys.push(key.clone());
                strings_and_keys(value, strings, keys);
            }
        }
        _ => {}
    }
}

fn is_decimal(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// A request id under the task: `<task hash>:<decimal index>`.
fn is_request_id_of(s: &str, task_hash: &str) -> bool {
    s.strip_prefix(task_hash)
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(is_decimal)
}

/// The envelope of every line: `standard` `airlock`, `version` `1.0.0`, a string `event`, and `data` an array of exactly one object.
#[tokio::test]
async fn every_event_is_one_airlock_envelope_with_a_one_element_data_array() {
    let sc = scenario().await;
    assert!(
        sc.lines.len() >= EMITTED_TODAY.len(),
        "the scenario logged only {} events",
        sc.lines.len()
    );
    let envelope: BTreeSet<&str> = ["data", "event", "standard", "version"].into();
    for (line, event) in sc.lines.iter().zip(sc.events()) {
        let object = event
            .as_object()
            .unwrap_or_else(|| panic!("`{line}` is not a JSON object"));
        let keys: BTreeSet<&str> = object.keys().map(String::as_str).collect();
        assert_eq!(keys, envelope, "{line}");
        assert_eq!(event["standard"], "airlock", "{line}");
        assert_eq!(event["version"], "1.0.0", "{line}");
        assert!(event["event"].is_string(), "{line}");
        let data = event["data"]
            .as_array()
            .unwrap_or_else(|| panic!("`data` is not an array: {line}"));
        assert_eq!(
            data.len(),
            1,
            "`data` must hold exactly one element: {line}"
        );
        assert!(data[0].is_object(), "`data[0]` is not an object: {line}");
    }
}

/// The names are the closed list, the document lists exactly that list, and every emitted event carries the fields the document names
/// for it, no more and no fewer.
#[tokio::test]
async fn event_names_are_the_closed_list_and_every_field_is_documented() {
    let sc = scenario().await;
    let doc = documented();
    let closed: BTreeSet<&str> = CLOSED_LIST.into();
    assert_eq!(
        closed.len(),
        CLOSED_LIST.len(),
        "the closed list repeats a name"
    );
    let listed: BTreeSet<&str> = doc.keys().map(String::as_str).collect();
    assert_eq!(
        listed, closed,
        "docs/events.md must list exactly the closed list"
    );
    let mut emitted = BTreeSet::new();
    for event in sc.events() {
        let name = event["event"].as_str().expect("an event name");
        assert!(closed.contains(name), "`{name}` is not in the closed list");
        let mut got: Vec<String> = event["data"][0]
            .as_object()
            .expect("data[0] is an object")
            .keys()
            .cloned()
            .collect();
        got.sort();
        let mut want = doc[name].clone();
        want.sort();
        assert_eq!(
            got, want,
            "the fields of `{name}` differ from docs/events.md"
        );
        emitted.insert(name.to_string());
    }
    for name in EMITTED_TODAY {
        assert!(
            emitted.contains(name),
            "the scenario never emitted `{name}`"
        );
    }
}

/// RT-24: the task id, the trace digest and the plan hash the agent sent appear in no event, none of the agent's fields is a key, and
/// every string of the gate's events is derived, registered, canonical, the agent's own account, a closed reason or a decimal number.
#[tokio::test]
async fn no_agent_free_text_reaches_an_event() {
    let sc = scenario().await;
    let agent_text = [TASK_ID_TEXT.to_string(), trace_digest(), plan_hash()];
    let forbidden_keys = [
        "task_id",
        "hints",
        "plan_hash",
        "trace_digest",
        "labels",
        "evm",
    ];
    let reasons: BTreeSet<&str> = airlock_verdict::ALL_REASONS
        .iter()
        .map(|r| r.as_str())
        .collect();
    let gate = ["submitted", "allowed", "escalated", "blocked"];
    let mut gate_events = 0;
    for event in sc.events() {
        let name = event["event"].as_str().expect("an event name");
        let (mut strings, mut keys) = (Vec::new(), Vec::new());
        strings_and_keys(&event["data"], &mut strings, &mut keys);
        for key in &keys {
            assert!(
                !forbidden_keys.contains(&key.as_str()),
                "`{name}` carries the agent field `{key}`: {event}"
            );
        }
        for text in &strings {
            for input in &agent_text {
                assert!(
                    !text.contains(input.as_str()),
                    "`{name}` carries the agent's `{input}`: {event}"
                );
            }
        }
        if !gate.contains(&name) {
            continue;
        }
        gate_events += 1;
        for text in &strings {
            let known = *text == sc.task_hash
                || is_request_id_of(text, &sc.task_hash)
                || *text == "near"
                || *text == ALICE
                || *text == BOB
                || *text == sc.agent
                || reasons.contains(text.as_str())
                || is_decimal(text);
            assert!(
                known,
                "`{name}` carries the string `{text}` the contract did not derive: {event}"
            );
        }
    }
    // submitted, allowed, escalated and blocked, once each at least
    assert!(gate_events >= 4, "only {gate_events} gate events");
}

/// `id` is the decimal pending number and only in the escalation lifecycle events; the gate's events name the request `request_id`,
/// the derived `<task hash>:<index>`.
#[tokio::test]
async fn id_is_the_pending_number_and_request_id_is_derived() {
    let sc = scenario().await;
    assert_eq!(sc.outcomes.len(), 3, "{:?}", sc.outcomes);
    assert_eq!(sc.outcomes[0]["outcome"], "allowed");
    assert_eq!(sc.outcomes[1]["outcome"], "escalated");
    assert_eq!(sc.outcomes[2]["outcome"], "blocked");
    let mut escalated = 0;
    let mut submitted = 0;
    for event in sc.events() {
        let name = event["event"].as_str().expect("an event name");
        let data = &event["data"][0];
        let has_id = data.get("id").is_some();
        assert_eq!(
            has_id,
            EVENTS_WITH_ID.contains(&name),
            "`id` belongs to {EVENTS_WITH_ID:?} only, and `{name}` disagrees: {event}"
        );
        if ["allowed", "escalated", "blocked"].contains(&name) {
            let id = data["request_id"].as_str().expect("a request_id");
            assert!(is_request_id_of(id, &sc.task_hash), "{id}");
            assert!(
                sc.outcomes.iter().any(|o| o["request_id"] == id),
                "{id} is not a request the call answered for"
            );
        }
        if name == "escalated" {
            escalated += 1;
            let id = data["id"].as_str().expect("`id` is a string");
            assert!(is_decimal(id), "{id}");
            assert_eq!(data["id"], sc.outcomes[1]["pending_id"], "{event}");
            assert_eq!(data["request_id"], sc.outcomes[1]["request_id"], "{event}");
        }
        if name == "submitted" {
            submitted += 1;
            assert_eq!(data["task_hash"], sc.task_hash.as_str(), "{event}");
            assert_eq!(data["count"], 3, "{event}");
            assert_eq!(data["agent"], sc.agent.as_str(), "{event}");
        }
    }
    assert_eq!(escalated, 1);
    assert_eq!(submitted, 1);
}

// AIR-314 red-team campaign, contract half: each test is one attack on the policy contract, called in process the way the agent or a
// stranger would call it, with the outcome the contract must give. The ids (RT-CON, RT-APPR, RT-TASK, RT-DOS) and what each test tries are
// listed in bench/cases/redteam/contract.json and rendered in docs/REDTEAM.md; the report fails when a listed test is missing here or a
// test here is not listed. `#[cfg(test)]` (see lib.rs): nothing here is compiled into the contract.
use crate::agents::{AllowedAgent, fingerprint};
use crate::escalation::book_status;
use crate::gate::MAX_BATCH;
use crate::policy::{AssetEntry, BookEntry};
use crate::request::{
    EvmParams, Hex32, Hints, Labels, RequestState, SubmitOutcome, SubmitRequest, request_id,
};
use crate::task::{OwnerTask, TASK_TAG, TaskBound, task_hash};
use crate::testutil::{OWNER, POLICY, ctx, fresh, one_book, sign, task_public_key};
use crate::*;
use near_sdk::PromiseOrValue;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::testing_env;
use shade_attestation::measurements::create_mock_full_measurements_hex;

const AGENT: &str = "agent.test.near";
const OTHER_AGENT: &str = "other-agent.test.near";
const ALICE: &str = "near:alice.test.near";
const EVIL: &str = "near:evil-ops.test.near";
const NOW: u64 = 10_000_000;
const TTL_MS: u64 = 3_600_000;
const OWNER_MASK: u16 = 1;
const BOOK_MASK: u16 = 2;
const EMAIL_MASK: u16 = 1 << 5;
const QUARANTINE_MASK: u16 = 1 << 12;
/// Alice's per-payment cap for an untrusted amount, her daily untrusted budget and her daily limit (base units).
const CAP: u128 = 100;
const BUDGET: u128 = 1_000;
const DAILY: u128 = 5_000;

fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
        .unwrap_or_default()
}

fn panics<R>(f: impl FnOnce() -> R) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(_) => panic!("expected a revert, the call succeeded"),
        Err(payload) => panic_text(payload),
    }
}

fn asset_entry() -> AssetEntry {
    AssetEntry {
        symbol: "NEAR".to_string(),
        decimals: 24,
        hard_cap: 10_000,
        daily_cap: 100_000,
        max_fee_per_gas: 0,
        max_gas: 0,
        quick_task_cap: 100_000,
        path: None,
        eip712: None,
    }
}

fn allow_agent(c: &mut Contract, agent: &str) {
    let id: AccountId = agent.parse().unwrap();
    c.agents.insert(
        id.clone(),
        Agent {
            measurements: create_mock_full_measurements_hex(),
            ppid: Ppid::default(),
            valid_until_ms: NOW * 10,
        },
    );
    c.whitelisted_agents_for_local.insert(id.clone());
    c.allowed_agents.insert(
        id,
        AllowedAgent {
            fingerprint: fingerprint(agent),
            allowed_ms: 0,
        },
    );
}

fn alice_entry() -> BookEntry {
    BookEntry {
        cap: Some(CAP),
        daily_untrusted_budget: BUDGET,
        daily_limit: DAILY,
    }
}

/// The owner's next book for a remember: ALICE at slot 0 and `payee` at slot 1 (cap, no untrusted budget, daily limit). Returns the
/// current root, the new root and the new entry's proof.
fn remember_book(
    c: &Contract,
    payee: &str,
    cap: u128,
    daily: u128,
) -> (Hex32, Hex32, crate::book::BookProof) {
    let a = alice_entry();
    let entries = [
        crate::book::Entry {
            salt: [1; 32],
            payee: ALICE.to_string(),
            cap: a.cap,
            daily_untrusted_budget: a.daily_untrusted_budget,
            daily_limit: a.daily_limit,
        },
        crate::book::Entry {
            salt: [2; 32],
            payee: payee.to_string(),
            cap: Some(cap),
            daily_untrusted_budget: 0,
            daily_limit: daily,
        },
    ];
    let (root, mut proofs) = crate::book::build(&entries, &[7; 32]);
    (Hex32(c.book_root), Hex32(root), proofs.remove(1))
}

/// Asset `near`, book payee `ALICE` (cap 100, budget 1000, daily 5000), the task key, and `AGENT` and `OTHER_AGENT` allowed.
fn setup() -> Contract {
    let mut c = fresh();
    c.assets.insert("near".to_string(), asset_entry());
    c.book_root = one_book(ALICE, &alice_entry()).0;
    c.task_key = Some(task_public_key());
    allow_agent(&mut c, AGENT);
    allow_agent(&mut c, OTHER_AGENT);
    c
}

fn task_for(id: &str, bounds: &[(&str, u128)], max_actions: u8) -> OwnerTask {
    task_at(id, bounds, max_actions, NOW)
}

/// A task issued just before `now_ms` and valid for 30 minutes after it.
fn task_at(id: &str, bounds: &[(&str, u128)], max_actions: u8, now_ms: u64) -> OwnerTask {
    OwnerTask {
        tag: TASK_TAG.to_string(),
        task_id: id.to_string(),
        contract_id: POLICY.parse().unwrap(),
        agent_id: AGENT.parse().unwrap(),
        plan_sha256: Hex32([0x11; 32]),
        instruction_sha256_salted: Hex32([0x22; 32]),
        issued_ms: now_ms - 5_000,
        expires_ms: now_ms + 1_800_000,
        max_actions,
        bounds: bounds
            .iter()
            .map(|(key, max_total)| TaskBound {
                payee_key: (*key).to_string(),
                max_total: U128(*max_total),
            })
            .collect(),
    }
}

fn task(bounds: &[(&str, u128)], max_actions: u8) -> OwnerTask {
    task_for("task-1", bounds, max_actions)
}

fn request(t: &OwnerTask, index: u8, payee: &str, amount: u128, labels: Labels) -> SubmitRequest {
    SubmitRequest {
        task_id: t.task_id.clone(),
        action_index: index,
        asset: crate::keys::asset_for_payee_key(payee),
        payee: payee.to_string(),
        amount: U128(amount),
        labels,
        evm: None,
        hints: Hints {
            plan_hash: t.plan_sha256.clone(),
            trace_digest: Hex32([0x33; 32]),
            origin: None,
        },
        book: (payee == ALICE).then(|| one_book(ALICE, &alice_entry()).1),
    }
}

/// Recipient from the book, amount and pc from the owner: what an honest runtime sends for a typed payment.
fn clean(t: &OwnerTask, index: u8, payee: &str, amount: u128) -> SubmitRequest {
    request(
        t,
        index,
        payee,
        amount,
        Labels {
            recipient: BOOK_MASK,
            amount: OWNER_MASK,
            pc: OWNER_MASK,
        },
    )
}

/// Every value typed by the owner: the shape of a payment to a payee the owner names by address.
fn typed(t: &OwnerTask, index: u8, payee: &str, amount: u128) -> SubmitRequest {
    request(
        t,
        index,
        payee,
        amount,
        Labels {
            recipient: OWNER_MASK,
            amount: OWNER_MASK,
            pc: OWNER_MASK,
        },
    )
}

/// Recipient from the book, amount read by the quarantined reader from an email: the K2 shape.
fn data_amount(t: &OwnerTask, index: u8, payee: &str, amount: u128) -> SubmitRequest {
    request(
        t,
        index,
        payee,
        amount,
        Labels {
            recipient: BOOK_MASK,
            amount: EMAIL_MASK | QUARANTINE_MASK,
            pc: OWNER_MASK,
        },
    )
}

/// A recipient read from data: always escalates for a payee in the task (`UntrustedRecipient`).
fn data_payee(t: &OwnerTask, index: u8, payee: &str, amount: u128) -> SubmitRequest {
    request(
        t,
        index,
        payee,
        amount,
        Labels {
            recipient: EMAIL_MASK | QUARANTINE_MASK,
            amount: OWNER_MASK,
            pc: OWNER_MASK,
        },
    )
}

fn submit_as(
    c: &mut Contract,
    agent: &str,
    now_ms: u64,
    t: &OwnerTask,
    reqs: Vec<SubmitRequest>,
) -> Vec<SubmitOutcome> {
    testing_env!(ctx(agent, now_ms, 0).build());
    let sig = Base64VecU8(sign(t));
    match c.submit_batch(reqs, t.clone(), sig) {
        PromiseOrValue::Value(outcomes) => outcomes,
        PromiseOrValue::Promise(_) => panic!("the agent was refused"),
    }
}

fn submit(c: &mut Contract, t: &OwnerTask, reqs: Vec<SubmitRequest>) -> Vec<SubmitOutcome> {
    submit_as(c, AGENT, NOW, t, reqs)
}

fn tag(o: &SubmitOutcome) -> String {
    match &o.reason {
        None => o.outcome.clone(),
        Some(r) => format!("{}:{}", o.outcome, r),
    }
}

fn tags(outs: &[SubmitOutcome]) -> Vec<String> {
    outs.iter().map(tag).collect()
}

/// The six strings of the approval card of pending number `no`, as the honest console sends them.
fn card(c: &Contract, no: u32) -> [String; 6] {
    let (_, rec) = c.pending_record(no).expect("a pending record");
    let p = rec.pending.expect("escalation data");
    [
        no.to_string(),
        rec.payee,
        p.display_symbol,
        p.display_amount,
        rec.reason.expect("a reason"),
        book_status(p.book_in).to_string(),
    ]
}

fn approve_as(c: &mut Contract, who: &str, now_ms: u64, k: &[String; 6]) {
    testing_env!(ctx(who, now_ms, 1).build());
    c.approve(
        k[0].clone(),
        k[1].clone(),
        k[2].clone(),
        k[3].clone(),
        k[4].clone(),
        k[5].clone(),
    );
}

fn owner(now_ms: u64) {
    testing_env!(ctx(OWNER, now_ms, 1).build());
}

/// One escalation under its own task (index 0): a data recipient to Alice. Returns its pending number.
fn escalate_one(c: &mut Contract, task_id: &str, amount: u128) -> u32 {
    let t = task_for(task_id, &[(ALICE, 1_000)], 1);
    let out = submit(c, &t, vec![data_payee(&t, 0, ALICE, amount)]);
    assert_eq!(out[0].outcome, "escalated", "{:?}", out[0]);
    out[0]
        .pending_id
        .as_ref()
        .expect("a pending id")
        .parse()
        .unwrap()
}

fn spent_task(c: &Contract, t: &OwnerTask) -> u8 {
    c.get_task_state(hex::encode(task_hash(t))).actions_used
}

// ---------------------------------------------------------------------------------------------------------------- CON: contract edges

#[test]
fn rt_con_batch_of_four_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 400)], 4);
    let reqs = (0..=MAX_BATCH as u8)
        .map(|i| clean(&t, i, ALICE, 1))
        .collect::<Vec<_>>();
    assert_eq!(reqs.len(), 4);
    assert!(panics(|| submit(&mut c, &t, reqs)).contains("batch size 1 to 3"));
}

#[test]
fn rt_con_same_index_twice_in_one_batch_charges_once() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let out = submit(
        &mut c,
        &t,
        vec![clean(&t, 0, ALICE, 60), clean(&t, 0, ALICE, 60)],
    );
    assert_eq!(tags(&out), ["allowed", "allowed"]);
    // the second is the stored answer of the first, not a second payment: one charge of 60, one action
    let rec = c.records.get(&request_id(&task_hash(&t), 0)).unwrap();
    assert_eq!(rec.applied_charge.as_ref().unwrap().task, 60);
    assert_eq!(spent_task(&c, &t), 1);
}

#[test]
fn rt_con_two_allows_in_one_batch_share_the_task_bound() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 2);
    let out = submit(
        &mut c,
        &t,
        vec![clean(&t, 0, ALICE, 60), clean(&t, 1, ALICE, 60)],
    );
    assert_eq!(tags(&out), ["allowed", "escalated:OverTaskBound"]);
}

#[test]
fn rt_con_unknown_label_bit_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let mut r = clean(&t, 0, ALICE, 10);
    r.labels.recipient = BOOK_MASK | (1 << 15);
    assert!(panics(|| submit(&mut c, &t, vec![r])).contains("unknown label bit"));
}

#[test]
fn rt_con_asset_payee_mismatch_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let mut r = clean(&t, 0, ALICE, 10);
    r.asset = "evm:84532:native".to_string();
    r.evm = Some(EvmParams {
        gas_limit: U128(21_000),
        max_fee_per_gas: U128(1),
        max_priority_fee_per_gas: U128(1),
    });
    assert!(panics(|| submit(&mut c, &t, vec![r])).contains("asset does not match payee"));
}

#[test]
fn rt_con_ft_lane_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let mut r = clean(&t, 0, ALICE, 10);
    r.asset = "ft:usdc.test.near".to_string();
    assert!(panics(|| submit(&mut c, &t, vec![r])).contains("lane not shipped"));
}

#[test]
fn rt_con_index_past_max_actions_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    assert!(
        panics(|| submit(&mut c, &t, vec![clean(&t, 1, ALICE, 10)]))
            .contains("task actions exhausted")
    );
}

#[test]
fn rt_con_plan_hash_mismatch_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let mut r = clean(&t, 0, ALICE, 10);
    r.hints.plan_hash = Hex32([0x99; 32]);
    assert!(panics(|| submit(&mut c, &t, vec![r])).contains("plan hash mismatch"));
}

#[test]
fn rt_con_replay_with_changed_amount_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    assert_eq!(
        tags(&submit(&mut c, &t, vec![clean(&t, 0, ALICE, 10)])),
        ["allowed"]
    );
    assert!(
        panics(|| submit(&mut c, &t, vec![clean(&t, 0, ALICE, 90)])).contains("request mismatch")
    );
}

#[test]
fn rt_con_lying_runtime_owner_labels_capped_by_task_bound() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 2);
    // every label claimed Owner: a payee outside the book still escalates, and a book payee is still held at the signed bound
    let all_owner = Labels {
        recipient: OWNER_MASK,
        amount: OWNER_MASK,
        pc: OWNER_MASK,
    };
    let out = submit(
        &mut c,
        &t,
        vec![
            request(&t, 0, EVIL, 10, all_owner),
            request(&t, 1, ALICE, 101, all_owner),
        ],
    );
    assert_eq!(
        tags(&out),
        ["escalated:OutsideTask", "escalated:OverTaskBound"]
    );
}

#[test]
fn rt_con_uppercase_payee_key_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let mut r = clean(&t, 0, ALICE, 10);
    r.payee = "near:Alice.test.near".to_string();
    panics(|| submit(&mut c, &t, vec![r]));
    assert!(!c.records.contains_key(&request_id(&task_hash(&t), 0)));
}

#[test]
fn rt_con_evm_params_on_near_lane_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let mut r = clean(&t, 0, ALICE, 10);
    r.evm = Some(EvmParams {
        gas_limit: U128(21_000),
        max_fee_per_gas: U128(1),
        max_priority_fee_per_gas: U128(1),
    });
    assert!(panics(|| submit(&mut c, &t, vec![r])).contains("evm params not allowed"));
}

#[test]
fn rt_con_book_set_root_by_agent_reverts() {
    let mut c = setup();
    let old = Hex32(c.book_root);
    testing_env!(ctx(AGENT, NOW, 1).build());
    panics(|| c.book_set_root(old.clone(), Hex32([9; 32])));
    assert_eq!(c.book_root, old.0);
}

// ---------------------------------------------------------------------------------------------------------------- credit roles (AIR-327)

const APPROVER_ACCOUNT: &str = "approver.test.near";
const SPONSOR_ACCOUNT: &str = "sponsor.test.near";

/// `setup()` with a card's roles: the owner is the issuer, `approver.test.near` the borrower, `sponsor.test.near` the pool.
fn setup_card() -> Contract {
    let mut c = crate::testutil::fresh_roles(Some(APPROVER_ACCOUNT), Some(SPONSOR_ACCOUNT));
    c.assets.insert("near".to_string(), asset_entry());
    c.book_root = one_book(ALICE, &alice_entry()).0;
    c.task_key = Some(task_public_key());
    allow_agent(&mut c, AGENT);
    allow_agent(&mut c, OTHER_AGENT);
    c
}

/// A held payment to a payee in the book: a data recipient to Alice with her proof, held `UntrustedRecipient` with `book_in` true.
fn escalate_booked(c: &mut Contract, task_id: &str) -> u32 {
    escalate_one(c, task_id, 40)
}

/// A held payment to a payee that is not in the book (`payee`, no proof): `book_in` false.
fn escalate_new(c: &mut Contract, task_id: &str, payee: &str) -> u32 {
    let t = task_for(task_id, &[(payee, 1_000)], 1);
    let out = submit(c, &t, vec![data_payee(&t, 0, payee, 40)]);
    assert_eq!(out[0].outcome, "escalated", "{:?}", out[0]);
    out[0]
        .pending_id
        .as_ref()
        .expect("a pending id")
        .parse()
        .unwrap()
}

fn approved_logged() -> bool {
    near_sdk::test_utils::get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"approved\""))
}

#[test]
fn rt_con_borrower_pays_himself_is_refused() {
    // the borrower runs the agent and holds the approver key: he asks his own account to be paid and taps approve
    let mut c = setup_card();
    let himself = format!("near:{APPROVER_ACCOUNT}");
    let no = escalate_new(&mut c, "task-self", &himself);
    let k = card(&c, no);
    assert_eq!(k[5], "new");
    let text = panics(|| approve_as(&mut c, APPROVER_ACCOUNT, NOW, &k));
    assert!(text.contains("not in the book"), "{text}");
    assert!(!approved_logged());
    assert!(c.pending_record(no).is_some(), "still pending");
    // only the issuer can override
    approve_as(&mut c, OWNER, NOW, &k);
    assert!(approved_logged());
}

#[test]
fn rt_con_approver_cannot_approve_a_new_payee_of_anyone() {
    let mut c = setup_card();
    let no = escalate_new(&mut c, "task-new", EVIL);
    let k = card(&c, no);
    assert!(panics(|| approve_as(&mut c, APPROVER_ACCOUNT, NOW, &k)).contains("not in the book"));
    // the approver can still reject it
    testing_env!(ctx(APPROVER_ACCOUNT, NOW, 1).build());
    c.reject(no.to_string());
}

#[test]
fn rt_con_withheld_proof_makes_the_payee_new_for_the_approver() {
    let mut c = setup_card();
    let t = task_for("task-withheld", &[(ALICE, 1_000)], 1);
    let mut r = data_payee(&t, 0, ALICE, 40);
    r.book = None;
    let out = submit(&mut c, &t, vec![r]);
    assert_eq!(out[0].outcome, "escalated", "{:?}", out[0]);
    let no: u32 = out[0].pending_id.as_ref().unwrap().parse().unwrap();
    let k = card(&c, no);
    assert_eq!(k[5], "new", "a booked payee without its proof is new");
    assert!(panics(|| approve_as(&mut c, APPROVER_ACCOUNT, NOW, &k)).contains("not in the book"));
}

#[test]
fn rt_con_stale_book_status_needs_the_owner() {
    let mut c = setup_card();
    let no = escalate_booked(&mut c, "task-stale");
    let k = card(&c, no);
    assert_eq!(k[5], "in_book");
    // the issuer changes the book after the escalation: the stored status is stale
    testing_env!(ctx(OWNER, NOW, 1).build());
    let old = Hex32(c.book_root);
    c.book_set_root(old, Hex32([9; 32]));
    assert!(panics(|| approve_as(&mut c, APPROVER_ACCOUNT, NOW, &k)).contains("not in the book"));
    approve_as(&mut c, OWNER, NOW, &k);
    assert!(approved_logged());
}

#[test]
fn rt_con_approver_approves_a_booked_merchant_and_the_owner_does_not() {
    let mut c = setup_card();
    let no = escalate_booked(&mut c, "task-booked");
    let k = card(&c, no);
    assert_eq!(k[5], "in_book");
    assert!(panics(|| approve_as(&mut c, OWNER, NOW, &k)).contains("the approver settles"));
    assert!(!approved_logged());
    // a stranger is refused at the gate
    assert!(
        panics(|| approve_as(&mut c, "stranger.test.near", NOW, &k))
            .contains("Caller is not the approver or the owner")
    );
    testing_env!(ctx(OWNER, NOW, 1).build());
    testing_env!(ctx("stranger.test.near", NOW, 1).build());
    assert!(
        panics(|| c.reject(no.to_string())).contains("Caller is not the approver or the owner")
    );
    approve_as(&mut c, APPROVER_ACCOUNT, NOW, &k);
    assert!(approved_logged());
}

#[test]
fn rt_con_owner_rejects_a_pending_escalation_so_the_sweep_is_not_blocked() {
    let mut c = setup_card();
    let no = escalate_booked(&mut c, "task-owner-reject");
    // a stranger cannot reject
    testing_env!(ctx("stranger.test.near", NOW, 1).build());
    assert!(
        panics(|| c.reject(no.to_string())).contains("Caller is not the approver or the owner")
    );
    // reject moves no money, so the issuer may clear it (the borrower may withhold his own rejection, and sweep needs no pending escalation)
    testing_env!(ctx(OWNER, NOW, 1).build());
    c.reject(no.to_string());
    assert!(c.pending_nos.is_empty());
}

#[test]
fn rt_con_approver_cannot_add_a_payee() {
    let mut c = setup_card();
    let before = c.book_root;
    let no = escalate_one(&mut c, "task-card-2", 40);
    let k = card(&c, no);
    let (old, new_root, entry) = remember_book(&c, EVIL, 100, 1_000);
    testing_env!(ctx(APPROVER_ACCOUNT, NOW, 1).build());
    let text = panics(|| {
        c.approve_and_remember(
            k[0].clone(),
            k[1].clone(),
            k[2].clone(),
            k[3].clone(),
            k[4].clone(),
            k[5].clone(),
            old.clone(),
            new_root.clone(),
            entry.clone(),
        )
    });
    assert!(
        text.contains("approve_and_remember is refused when an approver is set"),
        "{text}"
    );
    assert!(panics(|| c.book_set_root(old, new_root)).contains("Caller is not the owner"));
    assert_eq!(c.book_root, before, "the book did not move");
    assert!(c.pending_record(no).is_some(), "still pending");
}

#[test]
fn rt_con_sweep_pays_only_the_sponsor() {
    let mut c = setup_card();
    for who in [APPROVER_ACCOUNT, AGENT, "stranger.test.near"] {
        testing_env!(ctx(who, NOW, 1).build());
        assert!(
            panics(|| c.sweep(U128(1))).contains("Caller is not the owner"),
            "{who}"
        );
    }
    owner(NOW);
    let _ = c.sweep(U128(10));
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert!(
        receipts
            .iter()
            .all(|r| r.receiver_id.as_str() == SPONSOR_ACCOUNT || r.receiver_id.as_str() == POLICY)
    );
    assert!(
        receipts
            .iter()
            .any(|r| r.receiver_id.as_str() == SPONSOR_ACCOUNT)
    );
}

// ---------------------------------------------------------------------------------------------------------------- APPR: approval abuse

fn one_pending(c: &mut Contract) -> u32 {
    escalate_one(c, "task-appr", 40)
}

#[test]
fn rt_appr_changed_amount_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let mut k = card(&c, no);
    k[3] = "0.0000000000000000000004".to_string();
    assert!(
        panics(|| approve_as(&mut c, OWNER, NOW, &k)).contains("approve rejected: WrongAmount")
    );
}

#[test]
fn rt_appr_changed_payee_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let mut k = card(&c, no);
    k[1] = EVIL.to_string();
    assert!(
        panics(|| approve_as(&mut c, OWNER, NOW, &k)).contains("approve rejected: WrongRecipient")
    );
}

#[test]
fn rt_appr_replayed_approve_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let k = card(&c, no);
    approve_as(&mut c, OWNER, NOW, &k);
    assert!(panics(|| approve_as(&mut c, OWNER, NOW + 1, &k)).contains("NotPending"));
}

#[test]
fn rt_appr_after_expiry_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let k = card(&c, no);
    assert!(
        panics(|| approve_as(&mut c, OWNER, NOW + TTL_MS, &k))
            .contains("approve rejected: Expired")
    );
}

#[test]
fn rt_appr_after_task_revoked_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let k = card(&c, no);
    let (_, rec) = c.pending_record(no).unwrap();
    owner(NOW);
    c.revoke_task(hex::encode(rec.task_hash));
    assert!(
        panics(|| approve_as(&mut c, OWNER, NOW, &k)).contains("approve rejected: TaskRevoked")
    );
}

#[test]
fn rt_appr_by_agent_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let k = card(&c, no);
    panics(|| approve_as(&mut c, AGENT, NOW, &k));
    assert_eq!(c.pending_record(no).unwrap().1.state, RequestState::Pending);
}

#[test]
fn rt_appr_wrong_why_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let mut k = card(&c, no);
    k[4] = "OwnerTyped".to_string();
    assert!(
        panics(|| approve_as(&mut c, OWNER, NOW, &k)).contains("approve rejected: WrongReason")
    );
}

#[test]
fn rt_appr_after_reject_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let k = card(&c, no);
    owner(NOW);
    c.reject(no.to_string());
    assert!(panics(|| approve_as(&mut c, OWNER, NOW, &k)).contains("NotPending"));
}

#[test]
fn rt_appr_while_paused_reverts() {
    let mut c = setup();
    let no = one_pending(&mut c);
    let k = card(&c, no);
    owner(NOW);
    c.pause(true);
    assert!(
        panics(|| approve_as(&mut c, OWNER, NOW, &k)).contains("approve rejected: Limit:Paused")
    );
}

#[test]
fn rt_appr_remembered_payee_has_no_untrusted_budget() {
    let mut c = setup();
    // a new payee read from data escalates; the owner approves it and remembers it with a generous cap
    let t = task_for("task-new", &[(EVIL, 50)], 1);
    let out = submit(&mut c, &t, vec![data_payee(&t, 0, EVIL, 40)]);
    assert_eq!(tags(&out), ["escalated:UntrustedRecipient"]);
    let no: u32 = out[0].pending_id.as_ref().unwrap().parse().unwrap();
    let k = card(&c, no);
    let (old, new_root, entry) = remember_book(&c, EVIL, 100, 1_000);
    testing_env!(ctx(OWNER, NOW, 1).build());
    c.approve_and_remember(
        k[0].clone(),
        k[1].clone(),
        k[2].clone(),
        k[3].clone(),
        k[4].clone(),
        k[5].clone(),
        old,
        new_root.clone(),
        entry.clone(),
    );
    assert_eq!(c.book_root, new_root.0);
    assert_eq!(
        c.book_entry(EVIL, Some(&entry))
            .unwrap()
            .daily_untrusted_budget,
        0
    );
    // the next amount read from data for that payee, inside the remembered cap and the task bound, is still held
    let t2 = task_for("task-next", &[(EVIL, 50)], 1);
    let mut held = data_amount(&t2, 0, EVIL, 10);
    held.book = Some(entry);
    assert_eq!(
        tags(&submit(&mut c, &t2, vec![held])),
        ["escalated:UntrustedAmount"]
    );
}

#[test]
fn rt_appr_remember_cannot_set_cap_below_amount() {
    let mut c = setup();
    let t = task_for("task-new", &[(EVIL, 50)], 1);
    let out = submit(&mut c, &t, vec![data_payee(&t, 0, EVIL, 40)]);
    let no: u32 = out[0].pending_id.as_ref().unwrap().parse().unwrap();
    let k = card(&c, no);
    let (old, new_root, entry) = remember_book(&c, EVIL, 39, 1_000);
    testing_env!(ctx(OWNER, NOW, 1).build());
    let before = c.book_root;
    let text = panics(|| {
        c.approve_and_remember(
            k[0].clone(),
            k[1].clone(),
            k[2].clone(),
            k[3].clone(),
            k[4].clone(),
            k[5].clone(),
            old,
            new_root,
            entry,
        )
    });
    assert!(text.contains("remember rejected: CapBelowAmount"), "{text}");
    assert_eq!(c.book_root, before);
}

// ---------------------------------------------------------------------------------------------------------------- TASK: task-bound reuse

#[test]
fn rt_task_expired_task_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let late = t.expires_ms;
    assert!(
        panics(|| submit_as(&mut c, AGENT, late, &t, vec![clean(&t, 0, ALICE, 10)]))
            .contains("task expired")
    );
}

#[test]
fn rt_task_revoked_task_reverts() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 2);
    assert_eq!(
        tags(&submit(&mut c, &t, vec![clean(&t, 0, ALICE, 10)])),
        ["allowed"]
    );
    owner(NOW);
    c.revoke_task(hex::encode(task_hash(&t)));
    assert!(panics(|| submit(&mut c, &t, vec![clean(&t, 1, ALICE, 10)])).contains("task revoked"));
}

#[test]
fn rt_task_raised_bound_breaks_the_signature() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    let sig = Base64VecU8(sign(&t));
    let mut raised = t.clone();
    raised.bounds[0].max_total = U128(5_000);
    testing_env!(ctx(AGENT, NOW, 0).build());
    let r = clean(&raised, 0, ALICE, 1_000);
    assert!(panics(|| c.submit_batch(vec![r], raised.clone(), sig)).contains("bad task signature"));
}

#[test]
fn rt_task_second_task_meets_the_payee_daily_limit() {
    let mut c = setup();
    // two owner tasks each bound Alice at 4000; her daily limit of 5000 caps what both together auto-pay in one UTC day
    let t1 = task_for("task-a", &[(ALICE, 4_000)], 1);
    let t2 = task_for("task-b", &[(ALICE, 4_000)], 1);
    assert_eq!(
        tags(&submit(&mut c, &t1, vec![clean(&t1, 0, ALICE, 4_000)])),
        ["allowed"]
    );
    assert_eq!(
        tags(&submit(&mut c, &t2, vec![clean(&t2, 0, ALICE, 4_000)])),
        ["escalated:OverPayeeLimit"]
    );
}

#[test]
fn rt_task_other_agent_cannot_use_the_task() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 1);
    assert!(
        panics(|| submit_as(&mut c, OTHER_AGENT, NOW, &t, vec![clean(&t, 0, ALICE, 10)]))
            .contains("wrong agent")
    );
}

#[test]
fn rt_task_bound_not_reusable_after_allow() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 2);
    assert_eq!(
        tags(&submit(&mut c, &t, vec![clean(&t, 0, ALICE, 100)])),
        ["allowed"]
    );
    assert_eq!(
        tags(&submit(&mut c, &t, vec![clean(&t, 1, ALICE, 1)])),
        ["escalated:OverTaskBound"]
    );
}

// ---------------------------------------------------------------------------------------------------------------- DOS: escalation DoS

// AIR-315: the flood counters are kept per (agent, origin). An attacker's origin is the hash of the source its text came from (a mail
// sender here); the owner's real supplier mails from another origin, and an owner-typed payment has the origin `owner`.
const ATTACKER: &str = "mail:aaaaaaaaaaaaaaaa";
const SUPPLIER: &str = "mail:bbbbbbbbbbbbbbbb";

fn from_origin(mut r: SubmitRequest, origin: &str) -> SubmitRequest {
    r.hints.origin = Some(origin.to_string());
    r
}

/// A recipient read from `origin`'s text, under its own one-action task at `now_ms`: the outcome tag.
fn data_from_at(c: &mut Contract, task_id: &str, origin: &str, now_ms: u64) -> SubmitOutcome {
    let t = task_at(task_id, &[(ALICE, 1_000)], 1, now_ms);
    let out = submit_as(
        c,
        AGENT,
        now_ms,
        &t,
        vec![from_origin(data_payee(&t, 0, ALICE, 10), origin)],
    );
    out[0].clone()
}

fn data_from(c: &mut Contract, task_id: &str, origin: &str) -> SubmitOutcome {
    data_from_at(c, task_id, origin, NOW)
}

/// The pending number of an escalation that must have been admitted.
fn pending_no(o: &SubmitOutcome) -> u32 {
    assert_eq!(o.outcome, "escalated", "{o:?}");
    o.pending_id
        .as_ref()
        .expect("a pending id")
        .parse()
        .unwrap()
}

/// A payee the owner typed by address (every label Owner, origin `owner`): escalates `NewRecipient` when admitted.
fn owner_new_payee(c: &mut Contract, task_id: &str) -> String {
    let t = task_for(task_id, &[(EVIL, 50)], 1);
    tag(&submit(c, &t, vec![from_origin(typed(&t, 0, EVIL, 10), "owner")])[0])
}

fn allowed_typed(c: &mut Contract, task_id: &str) -> String {
    let t = task_for(task_id, &[(ALICE, 50)], 1);
    tag(&submit(c, &t, vec![from_origin(clean(&t, 0, ALICE, 10), "owner")])[0])
}

#[test]
fn rt_dos_three_rejects_lock_escalations_but_allows_still_pass() {
    let mut c = setup();
    for i in 0..3 {
        let no = pending_no(&data_from(&mut c, &format!("junk-{i}"), ATTACKER));
        owner(NOW);
        c.reject(no.to_string());
    }
    // the attacker's origin is locked ...
    assert_eq!(
        tag(&data_from(&mut c, "junk-4", ATTACKER)),
        "blocked:EscalationsLocked"
    );
    // ... while the owner's real supplier still escalates and the owner can approve it
    let no = pending_no(&data_from(&mut c, "supplier-1", SUPPLIER));
    let k = card(&c, no);
    approve_as(&mut c, OWNER, NOW, &k);
    // ... a payee the owner typed still escalates, and a payment inside the owner's limits still executes
    assert_eq!(
        owner_new_payee(&mut c, "real-new"),
        "escalated:NewRecipient"
    );
    assert_eq!(allowed_typed(&mut c, "real-typed"), "allowed");
    // the owner's reset of that one origin reopens it
    owner(NOW);
    c.reset_escalations(AGENT.parse().unwrap(), Some(ATTACKER.to_string()));
    assert_eq!(data_from(&mut c, "junk-5", ATTACKER).outcome, "escalated");
}

#[test]
fn rt_dos_pending_full_blocks_escalations_but_allows_still_pass() {
    let mut c = setup();
    for i in 0..2 {
        pending_no(&data_from(&mut c, &format!("junk-{i}"), ATTACKER));
    }
    // two pending fill the attacker's origin, not the agent
    assert_eq!(
        tag(&data_from(&mut c, "junk-2", ATTACKER)),
        "blocked:PendingFull"
    );
    pending_no(&data_from(&mut c, "supplier-1", SUPPLIER));
    assert_eq!(
        owner_new_payee(&mut c, "real-new"),
        "escalated:NewRecipient"
    );
    assert_eq!(allowed_typed(&mut c, "real-typed"), "allowed");
}

#[test]
fn rt_dos_reset_keeps_the_hourly_budget() {
    let mut c = setup();
    // four escalations of one origin in one hour, each approved so its pending cap never binds
    for i in 0..4 {
        let no = pending_no(&data_from(&mut c, &format!("junk-{i}"), ATTACKER));
        let k = card(&c, no);
        approve_as(&mut c, OWNER, NOW, &k);
    }
    assert_eq!(
        tag(&data_from(&mut c, "junk-4", ATTACKER)),
        "blocked:EscalationBudget"
    );
    // a reset of the origin keeps its hour count, as the agent-wide reset always did
    owner(NOW);
    c.reset_escalations(AGENT.parse().unwrap(), Some(ATTACKER.to_string()));
    assert_eq!(
        tag(&data_from(&mut c, "junk-5", ATTACKER)),
        "blocked:EscalationBudget"
    );
    // another origin and the owner are not charged for it
    pending_no(&data_from(&mut c, "supplier-1", SUPPLIER));
    assert_eq!(
        owner_new_payee(&mut c, "real-new"),
        "escalated:NewRecipient"
    );
    // the next UTC hour has a fresh budget
    assert_eq!(
        data_from_at(&mut c, "junk-6", ATTACKER, NOW + 3_600_000).outcome,
        "escalated"
    );
}

#[test]
fn rt_dos_many_attacker_origins_meet_the_backstop_not_the_owner() {
    let mut c = setup();
    // an attacker with eight sender identities fills the shared backstop of origins other than the owner
    for i in 0..8 {
        pending_no(&data_from(
            &mut c,
            &format!("junk-{i}"),
            &format!("mail:{i:016x}"),
        ));
    }
    assert_eq!(
        tag(&data_from(&mut c, "junk-8", "mail:00000000000000ff")),
        "blocked:PendingFull"
    );
    // the residual: the real supplier's mail waits behind the backstop too ...
    assert_eq!(
        tag(&data_from(&mut c, "supplier-1", SUPPLIER)),
        "blocked:PendingFull"
    );
    // ... but a payee the owner typed is never behind it
    assert_eq!(
        owner_new_payee(&mut c, "real-new"),
        "escalated:NewRecipient"
    );
}

#[test]
fn rt_dos_owner_origin_needs_trusted_labels() {
    let mut c = setup();
    let t = task_for("claim-owner", &[(ALICE, 1_000)], 1);
    let r = from_origin(data_payee(&t, 0, ALICE, 10), "owner");
    let text = panics(|| submit(&mut c, &t, vec![r]));
    assert!(text.contains("origin owner needs trusted labels"), "{text}");
}

#[test]
fn rt_dos_bad_origin_reverts() {
    let mut c = setup();
    for bad in [
        "MAIL:aaaaaaaaaaaaaaaa",
        "mail:aaaa",
        "mail:aaaaaaaaaaaaaaaag",
        "",
        "mail aaaaaaaaaaaaaaaa",
        "toolongkind:aaaaaaaaaaaaaaaa",
    ] {
        let t = task_for(&format!("bad-{bad}"), &[(ALICE, 1_000)], 1);
        let r = from_origin(data_payee(&t, 0, ALICE, 10), bad);
        let text = panics(|| submit(&mut c, &t, vec![r]));
        assert!(text.contains("bad origin"), "{bad}: {text}");
    }
}

#[test]
fn rt_dos_legacy_requests_keep_the_agent_limits() {
    let mut c = setup();
    // a runtime that names no origin keeps the per-agent counters of AIR-083: three rejects lock its escalations
    for i in 0..3 {
        let no = escalate_one(&mut c, &format!("legacy-{i}"), 10);
        owner(NOW);
        c.reject(no.to_string());
    }
    let t = task_for("legacy-4", &[(ALICE, 1_000)], 1);
    assert_eq!(
        tags(&submit(&mut c, &t, vec![data_payee(&t, 0, ALICE, 10)])),
        ["blocked:EscalationsLocked"]
    );
    // requests that name their origin are not behind that lock
    pending_no(&data_from(&mut c, "supplier-1", SUPPLIER));
    owner(NOW);
    c.reset_escalations(AGENT.parse().unwrap(), None);
    let t2 = task_for("legacy-5", &[(ALICE, 1_000)], 1);
    assert_eq!(
        submit(&mut c, &t2, vec![data_payee(&t2, 0, ALICE, 10)])[0].outcome,
        "escalated"
    );
}

#[test]
fn rt_dos_reset_all_clears_every_origin_lock() {
    let mut c = setup();
    for origin in [ATTACKER, SUPPLIER] {
        for i in 0..3 {
            let no = pending_no(&data_from(&mut c, &format!("{origin}-{i}"), origin));
            owner(NOW);
            c.reject(no.to_string());
        }
        assert_eq!(
            tag(&data_from(&mut c, &format!("{origin}-x"), origin)),
            "blocked:EscalationsLocked"
        );
    }
    owner(NOW);
    c.reset_escalations(AGENT.parse().unwrap(), None);
    assert_eq!(
        data_from(&mut c, "attacker-after", ATTACKER).outcome,
        "escalated"
    );
    assert_eq!(
        data_from(&mut c, "supplier-after", SUPPLIER).outcome,
        "escalated"
    );
}

#[test]
fn rt_dos_expire_frees_the_slot_of_its_own_origin() {
    let mut c = setup();
    let first = pending_no(&data_from(&mut c, "junk-0", ATTACKER));
    pending_no(&data_from(&mut c, "junk-1", ATTACKER));
    assert_eq!(
        tag(&data_from(&mut c, "junk-2", ATTACKER)),
        "blocked:PendingFull"
    );
    testing_env!(ctx("stranger.test.near", NOW + TTL_MS, 0).build());
    c.expire(first.to_string());
    assert_eq!(
        data_from_at(&mut c, "junk-3", ATTACKER, NOW + TTL_MS).outcome,
        "escalated"
    );
}

#[test]
fn rt_dos_preview_uses_the_origin() {
    let mut c = setup();
    for i in 0..2 {
        pending_no(&data_from(&mut c, &format!("junk-{i}"), ATTACKER));
    }
    let t = task_for("preview", &[(ALICE, 1_000)], 1);
    testing_env!(ctx(AGENT, NOW, 0).build());
    let attacker = c.preview_at(
        &from_origin(data_payee(&t, 0, ALICE, 10), ATTACKER),
        &t,
        NOW,
    );
    let supplier = c.preview_at(
        &from_origin(data_payee(&t, 0, ALICE, 10), SUPPLIER),
        &t,
        NOW,
    );
    assert_eq!(
        (attacker.outcome.as_str(), attacker.reason.as_deref()),
        ("blocked", Some("PendingFull"))
    );
    assert_eq!(
        (supplier.outcome.as_str(), supplier.reason.as_deref()),
        ("escalated", Some("UntrustedRecipient"))
    );
}

#[test]
fn rt_dos_junk_request_burns_one_action() {
    let mut c = setup();
    let t = task(&[(ALICE, 100)], 2);
    // a request the gate blocks still uses its index, so the owner's task has one action left
    let out = submit(&mut c, &t, vec![clean(&t, 0, ALICE, 20_000)]);
    assert_eq!(tags(&out), ["blocked:AmountOutOfBounds"]);
    assert_eq!(spent_task(&c, &t), 1);
    assert_eq!(
        tags(&submit(&mut c, &t, vec![clean(&t, 1, ALICE, 10)])),
        ["allowed"]
    );
}

#[test]
fn rt_dos_expire_by_anyone_keeps_the_reject_streak() {
    let mut c = setup();
    for i in 0..2 {
        let no = escalate_one(&mut c, &format!("junk-{i}"), 10);
        owner(NOW);
        c.reject(no.to_string());
    }
    let no = escalate_one(&mut c, "junk-x", 10);
    // a stranger expires the third one after its time to live: it frees the slot and neither locks nor clears the streak
    testing_env!(ctx("stranger.test.near", NOW + TTL_MS, 0).build());
    c.expire(no.to_string());
    let t = task_at("real-new", &[(EVIL, 50)], 1, NOW + TTL_MS);
    assert_eq!(
        tags(&submit_as(
            &mut c,
            AGENT,
            NOW + TTL_MS,
            &t,
            vec![typed(&t, 0, EVIL, 10)]
        )),
        ["escalated:NewRecipient"]
    );
}

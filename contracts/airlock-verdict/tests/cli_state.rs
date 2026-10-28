//! AIR-034: the stateful commands of the JSON-lines verdict CLI (`examples/verdict_cli.rs`): `reset`, `submit`, `approve` and `ledgers`, which keep
//! per-UTC-day ledgers in memory and use the same pure functions as the contract. Common setup: asset `near` { hard_cap 1000, daily_cap 100000 }, book
//! `near:acct.near` { cap null, budget 0, limit 100000 }, task `t1` with bound `near:acct.near` 500; a request is asset `near`, payee `near:acct.near`,
//! amount 500, labels { recipient 2, amount 1, pc 1 }, no EVM fields, zero hints.

mod common;

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

struct Cli {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Cli {
    fn start() -> Cli {
        let mut child = Command::new(common::example_bin("verdict_cli"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("verdict_cli starts");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Cli {
            child,
            stdin,
            stdout,
        }
    }

    fn ask_raw(&mut self, line: &str) -> String {
        writeln!(self.stdin, "{line}").unwrap();
        self.stdin.flush().unwrap();
        let mut reply = String::new();
        let n = self.stdout.read_line(&mut reply).unwrap();
        assert!(n > 0, "the process ended instead of replying to {line:?}");
        reply.trim_end().to_string()
    }

    fn ask(&mut self, v: &Value) -> Value {
        serde_json::from_str(&self.ask_raw(&v.to_string())).expect("a reply is JSON")
    }
}

impl Drop for Cli {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn setup_with(daily_cap: &str, cap: Value, budget: &str, bound: &str) -> Value {
    json!({
        "assets": {"near": {"hard_cap": "1000", "daily_cap": daily_cap, "max_fee_per_gas": "0", "max_gas": "0"}},
        "book": {
            "near:acct.near": {"cap": cap, "daily_untrusted_budget": budget, "daily_limit": "100000"},
            "near:other.near": {"cap": null, "daily_untrusted_budget": "0", "daily_limit": "100000"}
        },
        "tasks": {"t1": {"bounds": {"near:acct.near": bound}}},
        "flags": {"paused": false}
    })
}

fn reset_line(setup: Value) -> Value {
    json!({"cmd": "reset", "setup": setup})
}

fn common_setup() -> Value {
    setup_with("100000", Value::Null, "0", "500")
}

fn request(amount: &str, amount_labels: u64) -> Value {
    json!({
        "task_id": "t1",
        "asset": "near",
        "payee": "near:acct.near",
        "amount": amount,
        "labels": {"recipient": 2, "amount": amount_labels, "pc": 1},
        "evm": null,
        "hints": {"plan_hash": ZERO, "trace_digest": ZERO}
    })
}

fn submit(now_ms: u64, requests: Vec<Value>) -> Value {
    json!({"cmd": "submit", "now_ms": now_ms, "task_id": "t1", "requests": requests})
}

fn ledgers(now_ms: u64, payee: &str) -> Value {
    json!({"cmd": "ledgers", "now_ms": now_ms, "asset": "near", "payee": payee, "task_id": "t1"})
}

fn started(setup: Value) -> Cli {
    let mut cli = Cli::start();
    assert_eq!(
        cli.ask_raw(&reset_line(setup).to_string()),
        r#"{"ok":true}"#
    );
    cli
}

/// `spent` of one ledger (`asset_day`, `payee_day` or `payee_untrusted_day`) in a `ledgers` reply.
fn spent(reply: &Value, ledger: &str) -> String {
    reply["ledgers"][ledger]["spent"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn three_requests_of_500_against_the_500_bound() {
    let mut cli = started(common_setup());
    let line = submit(
        0,
        vec![request("500", 1), request("500", 1), request("500", 1)],
    )
    .to_string();
    let raw = cli.ask_raw(&line);
    assert_eq!(
        raw,
        concat!(
            r#"{"ok":true,"outcomes":["#,
            r#"{"tag":"allow","charge":{"asset_day":"500","payee_day":"500","payee_untrusted_day":"0","task":"500"}},"#,
            r#"{"tag":"escalate:OverTaskBound","charge":null},"#,
            r#"{"tag":"escalate:OverTaskBound","charge":null}]}"#
        )
    );
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(l["ok"], true, "{l}");
    assert_eq!(l["ledgers"]["task_spent"], "500");
    assert_eq!(spent(&l, "asset_day"), "500");
    assert_eq!(l["ledgers"]["asset_day"]["cap"], "100000");
    assert_eq!(l["ledgers"]["asset_day"]["remaining"], "99500");
    assert_eq!(l["ledgers"]["payee_day"]["cap"], "100000");
    assert_eq!(l["ledgers"]["payee_untrusted_day"]["cap"], "0");
}

#[test]
fn ledgers_are_per_utc_day_and_the_task_ledger_is_not() {
    let mut cli = started(common_setup());
    let out = cli.ask(&submit(0, vec![request("500", 1)]));
    assert_eq!(out["outcomes"][0]["tag"], "allow", "{out}");
    let last_ms_of_day_one = cli.ask(&ledgers(86_399_999, "near:acct.near"));
    assert_eq!(spent(&last_ms_of_day_one, "asset_day"), "500");
    assert_eq!(spent(&last_ms_of_day_one, "payee_day"), "500");
    let day_two = cli.ask(&ledgers(86_400_000, "near:acct.near"));
    assert_eq!(spent(&day_two, "asset_day"), "0");
    assert_eq!(spent(&day_two, "payee_day"), "0");
    assert_eq!(spent(&day_two, "payee_untrusted_day"), "0");
    assert_eq!(day_two["ledgers"]["task_spent"], "500");
    assert_eq!(last_ms_of_day_one["ledgers"]["task_spent"], "500");
}

#[test]
fn approve_after_the_daily_cap_is_exhausted_is_a_daily_limit_recheck() {
    let mut cli = started(setup_with("500", Value::Null, "0", "500"));
    let out = cli.ask(&submit(0, vec![request("500", 1)]));
    assert_eq!(out["outcomes"][0]["tag"], "allow", "{out}");
    let reply = cli.ask(
        &json!({"cmd": "approve", "now_ms": 0, "task_id": "t1", "request": request("500", 1)}),
    );
    assert_eq!(reply, json!({"ok": false, "error": "recheck:DailyLimit"}));
    // the refused approval charged nothing
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(spent(&l, "asset_day"), "500");
    assert_eq!(l["ledgers"]["task_spent"], "500");
}

#[test]
fn approve_of_an_over_bound_request_charges_asset_payee_and_task_but_not_the_untrusted_budget() {
    let mut cli = started(common_setup());
    let reply = cli.ask_raw(
        &json!({"cmd": "approve", "now_ms": 0, "task_id": "t1", "request": request("900", 1)})
            .to_string(),
    );
    // the task ledger saturates at the bound: 500 of the 900 is applied to it
    assert_eq!(
        reply,
        r#"{"ok":true,"charge":{"asset_day":"900","payee_day":"900","payee_untrusted_day":"0","task":"500"}}"#
    );
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(spent(&l, "asset_day"), "900");
    assert_eq!(spent(&l, "payee_day"), "900");
    assert_eq!(spent(&l, "payee_untrusted_day"), "0");
    assert_eq!(l["ledgers"]["task_spent"], "500");
    // the bound is used up, so the next payment under it escalates
    let next = cli.ask(&submit(0, vec![request("10", 1)]));
    assert_eq!(next["outcomes"][0]["tag"], "escalate:OverTaskBound");
}

#[test]
fn an_untrusted_amount_charges_the_untrusted_budget_and_an_owner_amount_does_not() {
    let mut cli = started(setup_with("100000", json!("500"), "500", "500"));
    let out = cli.ask(&submit(0, vec![request("100", 32)]));
    assert_eq!(out["outcomes"][0]["tag"], "allow", "{out}");
    assert_eq!(out["outcomes"][0]["charge"]["payee_untrusted_day"], "100");
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(spent(&l, "payee_untrusted_day"), "100");
    assert_eq!(l["ledgers"]["payee_untrusted_day"]["remaining"], "400");
    // an owner-labelled amount charges the other ledgers and leaves the budget as it was
    let out = cli.ask(&submit(0, vec![request("100", 1)]));
    assert_eq!(out["outcomes"][0]["tag"], "allow", "{out}");
    assert_eq!(out["outcomes"][0]["charge"]["payee_untrusted_day"], "0");
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(spent(&l, "payee_untrusted_day"), "100");
    assert_eq!(spent(&l, "payee_day"), "200");
    assert_eq!(l["ledgers"]["task_spent"], "200");
}

#[test]
fn escalated_and_blocked_requests_change_no_ledger() {
    let mut cli = started(common_setup());
    let mut unknown_asset = request("100", 1);
    unknown_asset["asset"] = json!("eth");
    let mut unbound_payee = request("100", 1);
    unbound_payee["payee"] = json!("near:other.near");
    let over_bound = request("501", 1);
    let out = cli.ask(&submit(0, vec![unknown_asset, unbound_payee, over_bound]));
    assert_eq!(
        out["outcomes"][0],
        json!({"tag": "block:UnknownAsset", "charge": null})
    );
    assert_eq!(
        out["outcomes"][1],
        json!({"tag": "escalate:OutsideTask", "charge": null})
    );
    assert_eq!(
        out["outcomes"][2],
        json!({"tag": "escalate:OverTaskBound", "charge": null})
    );
    for payee in ["near:acct.near", "near:other.near"] {
        let l = cli.ask(&ledgers(0, payee));
        assert_eq!(spent(&l, "asset_day"), "0", "{payee}");
        assert_eq!(spent(&l, "payee_day"), "0", "{payee}");
        assert_eq!(spent(&l, "payee_untrusted_day"), "0", "{payee}");
    }
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(l["ledgers"]["task_spent"], "0");
}

#[test]
fn reset_clears_every_ledger_and_replaces_the_setup() {
    let mut cli = started(common_setup());
    let out = cli.ask(&submit(0, vec![request("500", 1)]));
    assert_eq!(out["outcomes"][0]["tag"], "allow", "{out}");
    // a different setup: another daily cap, another bound, and no `near` asset under that id any more
    let mut next = setup_with("200", Value::Null, "0", "300");
    next["assets"] = json!({"gas": {"hard_cap": "10", "daily_cap": "200", "max_fee_per_gas": "0", "max_gas": "0"}});
    assert_eq!(cli.ask_raw(&reset_line(next).to_string()), r#"{"ok":true}"#);
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(spent(&l, "asset_day"), "0");
    assert_eq!(spent(&l, "payee_day"), "0");
    assert_eq!(l["ledgers"]["task_spent"], "0");
    assert_eq!(
        l["ledgers"]["asset_day"]["cap"], "0",
        "the old asset id is gone"
    );
    let out = cli.ask(&submit(0, vec![request("10", 1)]));
    assert_eq!(out["outcomes"][0]["tag"], "block:UnknownAsset");
    // the task is unknown after a reset that drops it
    let mut no_tasks = common_setup();
    no_tasks["tasks"] = json!({});
    assert_eq!(
        cli.ask_raw(&reset_line(no_tasks).to_string()),
        r#"{"ok":true}"#
    );
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(l["ledgers"]["task_spent"], Value::Null);
}

#[test]
fn a_batch_of_four_and_an_empty_batch_are_refused() {
    let mut cli = started(common_setup());
    let four = submit(
        0,
        vec![
            request("1", 1),
            request("1", 1),
            request("1", 1),
            request("1", 1),
        ],
    );
    assert_eq!(
        cli.ask(&four),
        json!({"ok": false, "error": "batch size 1 to 3"})
    );
    assert_eq!(
        cli.ask(&submit(0, vec![])),
        json!({"ok": false, "error": "batch size 1 to 3"})
    );
    // nothing was charged
    let l = cli.ask(&ledgers(0, "near:acct.near"));
    assert_eq!(spent(&l, "asset_day"), "0");
    // a batch of three is accepted
    let three = submit(0, vec![request("1", 1), request("1", 1), request("1", 1)]);
    assert_eq!(cli.ask(&three)["ok"], true);
}

#[test]
fn a_json_number_for_amount_or_for_a_setup_cap_is_refused() {
    let mut cli = started(common_setup());
    let mut numeric = request("10", 1);
    numeric["amount"] = json!(10);
    let reply = cli.ask(&submit(0, vec![numeric.clone()]));
    assert_eq!(reply["ok"], false, "{reply}");
    let approve =
        cli.ask(&json!({"cmd": "approve", "now_ms": 0, "task_id": "t1", "request": numeric}));
    assert_eq!(approve["ok"], false, "{approve}");
    // a number for daily_cap in the setup refuses the whole reset and keeps the setup that was there
    let mut bad = common_setup();
    bad["assets"]["near"]["daily_cap"] = json!(100_000);
    let reply = cli.ask(&reset_line(bad));
    assert_eq!(reply["ok"], false, "{reply}");
    let out = cli.ask(&submit(0, vec![request("10", 1)]));
    assert_eq!(
        out["outcomes"][0]["tag"], "allow",
        "the old setup is still in force: {out}"
    );
    // the same for a number in a book entry and in a task bound
    let mut bad_book = common_setup();
    bad_book["book"]["near:acct.near"]["daily_limit"] = json!(5);
    assert_eq!(cli.ask(&reset_line(bad_book))["ok"], false);
    let mut bad_bound = common_setup();
    bad_bound["tasks"]["t1"]["bounds"]["near:acct.near"] = json!(500);
    assert_eq!(cli.ask(&reset_line(bad_bound))["ok"], false);
}

//! AIR-023: the JSON-lines verdict CLI (`examples/verdict_cli.rs`). One JSON object per line on stdin, one per line on stdout, every reply
//! has `ok`; all u128 values are decimal strings and a JSON number for one is refused; a bad line never ends the process.

mod common;

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/verdict-vectors.json"
));

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

    /// Sends one line and returns the one reply line, without its newline.
    fn ask_raw(&mut self, line: &str) -> String {
        writeln!(self.stdin, "{line}").unwrap();
        self.stdin.flush().unwrap();
        let mut reply = String::new();
        let n = self.stdout.read_line(&mut reply).unwrap();
        assert!(n > 0, "the process ended instead of replying to {line:?}");
        reply.trim_end().to_string()
    }

    fn ask(&mut self, line: &str) -> Value {
        serde_json::from_str(&self.ask_raw(line)).expect("a reply is JSON")
    }
}

impl Drop for Cli {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn verdict_line(request: &Value, context: &Value) -> String {
    json!({"cmd": "verdict", "request": request, "context": context}).to_string()
}

/// The request and context of the first vector (an Allow on NEAR), for the tests that change one field.
fn base() -> (Value, Value) {
    let d = vectors();
    let first = &d["verdicts"][0];
    assert_eq!(first["expect"], "allow");
    (first["request"].clone(), first["context"].clone())
}

#[test]
fn every_verdict_vector_gives_its_expect_tag() {
    let mut cli = Cli::start();
    let d = vectors();
    let all = d["verdicts"].as_array().unwrap();
    assert_eq!(all.len(), 200);
    for v in all {
        let reply = cli.ask(&verdict_line(&v["request"], &v["context"]));
        assert_eq!(reply["ok"], true, "{}: {reply}", v["name"]);
        assert_eq!(reply["tag"], v["expect"], "{}", v["name"]);
    }
}

#[test]
fn replies_have_the_documented_shape() {
    let mut cli = Cli::start();
    let (request, context) = base();
    assert_eq!(
        cli.ask_raw(&verdict_line(&request, &context)),
        r#"{"ok":true,"tag":"allow"}"#
    );
    let bad = cli.ask_raw("not json");
    assert!(bad.starts_with(r#"{"ok":false,"error":""#), "{bad}");
}

#[test]
fn garbage_line_returns_ok_false_and_the_next_line_still_works() {
    let mut cli = Cli::start();
    let (request, context) = base();
    for garbage in [
        "this is not json",
        "",
        "[1,2,3]",
        "{",
        "null",
        r#"{"cmd":5}"#,
    ] {
        let reply = cli.ask(garbage);
        assert_eq!(reply["ok"], false, "{garbage:?}: {reply}");
        assert!(reply["error"].as_str().is_some_and(|e| !e.is_empty()));
        let next = cli.ask(&verdict_line(&request, &context));
        assert_eq!(next["ok"], true, "after {garbage:?}");
        assert_eq!(next["tag"], "allow");
    }
}

#[test]
fn a_json_number_for_amount_returns_ok_false() {
    let mut cli = Cli::start();
    let (mut request, context) = base();
    request["amount"] = json!(10);
    let reply = cli.ask(&verdict_line(&request, &context));
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(reply["error"].as_str().unwrap().contains("amount"));
    // the same request with the decimal string works
    request["amount"] = json!("10");
    assert_eq!(cli.ask(&verdict_line(&request, &context))["tag"], "allow");
    // a number above 2^64 must not be rounded silently either
    let raw = verdict_line(&request, &context).replace(
        r#""amount":"10""#,
        r#""amount":340282366920938463463374607431768211455"#,
    );
    assert_eq!(cli.ask(&raw)["ok"], false);
}

#[test]
fn a_json_number_for_any_other_u128_field_returns_ok_false() {
    let mut cli = Cli::start();
    let d = vectors();
    let evm = d["verdicts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| !v["request"]["evm"].is_null())
        .unwrap();
    let (request, context) = (evm["request"].clone(), evm["context"].clone());
    assert_eq!(cli.ask(&verdict_line(&request, &context))["ok"], true);
    for field in ["gas_limit", "max_fee_per_gas", "max_priority_fee_per_gas"] {
        let mut r = request.clone();
        r["evm"][field] = json!(1);
        assert_eq!(
            cli.ask(&verdict_line(&r, &context))["ok"],
            false,
            "evm.{field}"
        );
    }
    for field in ["hard_cap", "remaining_daily", "max_fee_per_gas", "max_gas"] {
        let mut c = context.clone();
        c["asset"][field] = json!(1);
        assert_eq!(
            cli.ask(&verdict_line(&request, &c))["ok"],
            false,
            "asset.{field}"
        );
    }
    for field in ["cap", "budget_remaining", "limit_remaining"] {
        let mut c = context.clone();
        c["payee"][field] = json!(1);
        assert_eq!(
            cli.ask(&verdict_line(&request, &c))["ok"],
            false,
            "payee.{field}"
        );
    }
    let mut c = context.clone();
    c["task_remaining"] = json!(1000);
    assert_eq!(
        cli.ask(&verdict_line(&request, &c))["ok"],
        false,
        "task_remaining"
    );
}

#[test]
fn a_malformed_decimal_string_returns_ok_false() {
    let mut cli = Cli::start();
    let (request, context) = base();
    for text in [
        "",
        "-1",
        "+1",
        "1.5",
        "1e3",
        "0x10",
        " 1",
        "01",
        "340282366920938463463374607431768211456",
    ] {
        let mut r = request.clone();
        r["amount"] = json!(text);
        assert_eq!(
            cli.ask(&verdict_line(&r, &context))["ok"],
            false,
            "{text:?}"
        );
    }
}

#[test]
fn an_unknown_command_returns_ok_false_and_the_process_goes_on() {
    let mut cli = Cli::start();
    let reply = cli.ask(r#"{"cmd":"frobnicate"}"#);
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], "unknown cmd frobnicate");
    let missing = cli.ask("{}");
    assert_eq!(missing["ok"], false);
    let (request, context) = base();
    assert_eq!(cli.ask(&verdict_line(&request, &context))["ok"], true);
}

#[test]
fn untrusted_amount_with_a_null_payee_cap_escalates_untrusted_amount() {
    // the strict configuration of the bench: every payee cap cleared
    let mut cli = Cli::start();
    let (mut request, mut context) = base();
    request["labels"]["amount"] = json!(32); // Untrusted:email
    context["payee"]["cap"] = Value::Null;
    context["payee"]["budget_remaining"] = json!("1000");
    let strict = cli.ask(&verdict_line(&request, &context));
    assert_eq!(strict["ok"], true, "{strict}");
    assert_eq!(strict["tag"], "escalate:UntrustedAmount");
    // with a cap and budget that cover the amount the same request is allowed
    context["payee"]["cap"] = json!("500");
    context["payee"]["budget_remaining"] = json!("500");
    assert_eq!(cli.ask(&verdict_line(&request, &context))["tag"], "allow");
}

#[test]
fn label_masks_must_fit_a_u16_and_bit_15_passes_through() {
    let mut cli = Cli::start();
    let (request, context) = base();
    for bad in [json!(65536), json!(-1), json!("2"), json!(1.5), Value::Null] {
        let mut r = request.clone();
        r["labels"]["recipient"] = bad.clone();
        assert_eq!(cli.ask(&verdict_line(&r, &context))["ok"], false, "{bad}");
    }
    // the contract reverts on bit 15 (AIR-063); the verdict itself only sees a mask, here an untrusted recipient
    let mut r = request.clone();
    r["labels"]["recipient"] = json!(32768);
    let reply = cli.ask(&verdict_line(&r, &context));
    assert_eq!(reply["tag"], "escalate:UntrustedRecipient");
}

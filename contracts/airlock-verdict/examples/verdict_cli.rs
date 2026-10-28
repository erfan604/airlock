//! JSON-lines verdict CLI (AIR-023): the process the bench loader and the Pink adapter talk to, and the seam AIR-034 extends with the
//! stateful commands `reset`, `submit`, `approve` and `ledgers`.
//!
//! Protocol: one JSON object per line on stdin, one JSON object per line on stdout, every reply has `ok`.
//!   {"cmd":"verdict","request":<SubmitRequest of fixtures/verdict-vectors.json>,"context":<its `context`>}
//!       replies {"ok":true,"tag":"escalate:UntrustedAmount"} (`allow`, `escalate:<Reason>` or `block:<Reason>`)
//!   anything else replies {"ok":false,"error":"<text>"}; an unknown command is "unknown cmd <name>".
//! Every u128 value is a canonical decimal string (digits only, no sign, no leading zero, at most 2^128 - 1): a JSON number for any u128
//! field is refused, because `serde_json` without `arbitrary_precision` rounds a number above 2^64 silently. A bad line gets an `ok:false`
//! reply and the next line still works; the process never exits on input, only at end of input.
//! Mapping, the same as in AIR-024: `fee_per_gas = evm.max_fee_per_gas` and `gas = evm.gas_limit` when `evm` is not null, else both
//! `None`; `evm.max_priority_fee_per_gas` is not read by the verdict (but must be a decimal string when present); `labels` pass through as
//! u16 masks; `Flags { paused: context.paused }`. There is no strict flag: the strict configuration sends `context.payee.cap = null`.
use airlock_verdict::{verdict, AssetLimits, Flags, Labels, Payee, Request, TaskScope, Verdict};
use serde_json::{Map, Value};
use std::io::{self, BufRead, Write};

/// State shared by the commands. Empty here: AIR-034 adds the ledgers of the stateful commands.
#[derive(Default)]
struct CliState {}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn ok_reply(tag: &str) -> String {
    format!("{{\"ok\":true,\"tag\":{}}}", json_string(tag))
}

fn err_reply(message: &str) -> String {
    format!("{{\"ok\":false,\"error\":{}}}", json_string(message))
}

fn tag(v: Verdict) -> String {
    match v {
        Verdict::Allow => "allow".to_string(),
        Verdict::Escalate(r) => format!("escalate:{}", r.as_str()),
        Verdict::Block(r) => format!("block:{}", r.as_str()),
    }
}

fn field<'a>(v: &'a Value, key: &str, what: &str) -> Result<&'a Value, String> {
    v.get(key).ok_or_else(|| format!("{what} is missing"))
}

/// A canonical decimal string: digits only, no sign, no leading zero, within u128.
fn u128_of(v: &Value, what: &str) -> Result<u128, String> {
    let Value::String(s) = v else {
        return Err(format!(
            "{what} must be a decimal string, not a JSON number or anything else"
        ));
    };
    let canonical =
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    if !canonical {
        return Err(format!("{what} must be a canonical decimal string"));
    }
    s.parse::<u128>()
        .map_err(|_| format!("{what} does not fit in a u128"))
}

fn opt_u128_of(v: &Value, what: &str) -> Result<Option<u128>, String> {
    if v.is_null() {
        Ok(None)
    } else {
        u128_of(v, what).map(Some)
    }
}

fn mask_of(v: &Value, what: &str) -> Result<u16, String> {
    v.as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| format!("{what} must be an integer from 0 to 65535"))
}

fn run_verdict(obj: &Map<String, Value>) -> Result<String, String> {
    let request = obj.get("request").ok_or("request is missing")?;
    let context = obj.get("context").ok_or("context is missing")?;
    let labels = field(request, "labels", "request.labels")?;
    let (fee_per_gas, gas) = match field(request, "evm", "request.evm")? {
        Value::Null => (None, None),
        evm @ Value::Object(_) => {
            if let Some(priority) = evm.get("max_priority_fee_per_gas") {
                u128_of(priority, "request.evm.max_priority_fee_per_gas")?;
            }
            (
                Some(u128_of(
                    field(evm, "max_fee_per_gas", "request.evm.max_fee_per_gas")?,
                    "request.evm.max_fee_per_gas",
                )?),
                Some(u128_of(
                    field(evm, "gas_limit", "request.evm.gas_limit")?,
                    "request.evm.gas_limit",
                )?),
            )
        }
        _ => return Err("request.evm must be null or an object".to_string()),
    };
    let req = Request {
        amount: u128_of(
            field(request, "amount", "request.amount")?,
            "request.amount",
        )?,
        fee_per_gas,
        gas,
        labels: Labels {
            recipient: mask_of(
                field(labels, "recipient", "request.labels.recipient")?,
                "request.labels.recipient",
            )?,
            amount: mask_of(
                field(labels, "amount", "request.labels.amount")?,
                "request.labels.amount",
            )?,
            pc: mask_of(
                field(labels, "pc", "request.labels.pc")?,
                "request.labels.pc",
            )?,
        },
    };
    let asset = match field(context, "asset", "context.asset")? {
        Value::Null => None,
        a @ Value::Object(_) => Some(AssetLimits {
            hard_cap: u128_of(
                field(a, "hard_cap", "context.asset.hard_cap")?,
                "context.asset.hard_cap",
            )?,
            remaining_daily: u128_of(
                field(a, "remaining_daily", "context.asset.remaining_daily")?,
                "context.asset.remaining_daily",
            )?,
            max_fee_per_gas: u128_of(
                field(a, "max_fee_per_gas", "context.asset.max_fee_per_gas")?,
                "context.asset.max_fee_per_gas",
            )?,
            max_gas: u128_of(
                field(a, "max_gas", "context.asset.max_gas")?,
                "context.asset.max_gas",
            )?,
        }),
        _ => return Err("context.asset must be null or an object".to_string()),
    };
    let payee = match field(context, "payee", "context.payee")? {
        Value::Null => None,
        p @ Value::Object(_) => Some(Payee {
            cap: opt_u128_of(field(p, "cap", "context.payee.cap")?, "context.payee.cap")?,
            budget_remaining: u128_of(
                field(p, "budget_remaining", "context.payee.budget_remaining")?,
                "context.payee.budget_remaining",
            )?,
            limit_remaining: u128_of(
                field(p, "limit_remaining", "context.payee.limit_remaining")?,
                "context.payee.limit_remaining",
            )?,
        }),
        _ => return Err("context.payee must be null or an object".to_string()),
    };
    let task = opt_u128_of(
        field(context, "task_remaining", "context.task_remaining")?,
        "context.task_remaining",
    )?
    .map(|remaining| TaskScope { remaining });
    let paused = field(context, "paused", "context.paused")?
        .as_bool()
        .ok_or("context.paused must be a boolean")?;
    Ok(tag(verdict(&req, asset, payee, task, &Flags { paused })))
}

/// One line in, one reply line out. Never panics on input: every failure is an `ok:false` reply.
fn handle(line: &str, _state: &mut CliState) -> String {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return err_reply(&format!("invalid JSON: {e}")),
    };
    let Some(obj) = value.as_object() else {
        return err_reply("a line must be a JSON object");
    };
    let Some(cmd) = obj.get("cmd").and_then(Value::as_str) else {
        return err_reply("cmd is missing or not a string");
    };
    match cmd {
        "verdict" => match run_verdict(obj) {
            Ok(t) => ok_reply(&t),
            Err(e) => err_reply(&e),
        },
        other => err_reply(&format!("unknown cmd {other}")),
    }
}

fn main() {
    let mut state = CliState::default();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut input = io::stdin().lock();
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match input.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        // invalid UTF-8 becomes replacement characters and then fails as JSON, so no input can end the process
        let line = String::from_utf8_lossy(&raw);
        let reply = handle(line.trim_end_matches(['\n', '\r']), &mut state);
        if writeln!(out, "{reply}").and_then(|()| out.flush()).is_err() {
            break;
        }
    }
}

//! Differential test driver (AIR-023): reads cases from stdin, one per line, and prints one tag per line (`allow`, `escalate:<Reason>`
//! or `block:<Reason>`, the name from `Reason::as_str`), so scripts/diff-verdict.sh can compare it with the Lean runner on the same lines.
//!
//! Input line: the 21 natural numbers of scripts/gen_verdict_cases.py and proofs/VerdictRun.lean:
//!   amount, fee_kind, fee, gas_kind, gas, recipient, amount_labels, pc, asset_kind, hard_cap, remaining_daily, max_fee, max_gas,
//!   payee_kind, cap_kind, cap, budget, limit, task_kind, remaining, paused
//! A `*_kind` of 1 means `Some`. A line that is not 21 plain decimal numbers inside the domain (u128 values, label masks below 2^16,
//! kinds and paused 0 or 1) prints `error:malformed`, as the Lean runner does, and the loop goes on, so the line counts of both sides
//! stay equal and a mismatch shows as a difference instead of a crash.
use airlock_verdict::{verdict, AssetLimits, Flags, Labels, Payee, Request, TaskScope, Verdict};
use std::io::{self, BufRead, Write};

fn tag(v: Verdict) -> String {
    match v {
        Verdict::Allow => "allow".to_string(),
        Verdict::Escalate(r) => format!("escalate:{}", r.as_str()),
        Verdict::Block(r) => format!("block:{}", r.as_str()),
    }
}

/// The 21 columns, or `None` for a line outside the domain.
fn columns(line: &str) -> Option<[u128; 21]> {
    let mut x = [0u128; 21];
    let mut tokens = line.split_whitespace();
    for slot in x.iter_mut() {
        let token = tokens.next()?;
        if !token.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = token.parse().ok()?;
    }
    if tokens.next().is_some() {
        return None;
    }
    let flags_ok = [1, 3, 8, 13, 14, 18, 20].iter().all(|&i| x[i] <= 1);
    let labels_ok = [5, 6, 7].iter().all(|&i| x[i] < 1 << 16);
    (flags_ok && labels_ok).then_some(x)
}

fn run_line(line: &str) -> String {
    let Some(x) = columns(line) else {
        return "error:malformed".to_string();
    };
    let (Ok(recipient), Ok(amount_labels), Ok(pc)) = (
        u16::try_from(x[5]),
        u16::try_from(x[6]),
        u16::try_from(x[7]),
    ) else {
        return "error:malformed".to_string();
    };
    let opt = |k: usize, v: usize| (x[k] == 1).then_some(x[v]);
    let req = Request {
        amount: x[0],
        fee_per_gas: opt(1, 2),
        gas: opt(3, 4),
        labels: Labels {
            recipient,
            amount: amount_labels,
            pc,
        },
    };
    let asset = (x[8] == 1).then_some(AssetLimits {
        hard_cap: x[9],
        remaining_daily: x[10],
        max_fee_per_gas: x[11],
        max_gas: x[12],
    });
    let payee = (x[13] == 1).then_some(Payee {
        cap: opt(14, 15),
        budget_remaining: x[16],
        limit_remaining: x[17],
    });
    let task = (x[18] == 1).then_some(TaskScope { remaining: x[19] });
    tag(verdict(
        &req,
        asset,
        payee,
        task,
        &Flags { paused: x[20] == 1 },
    ))
}

fn main() {
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let mut input = io::stdin().lock();
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match input.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&raw);
        if writeln!(out, "{}", run_line(&line)).is_err() {
            break;
        }
    }
    let _ = out.flush();
}

//! AIR-024: the Rust consumer of the shared vector file family (`fixtures/verdict-vectors.json`, `.lines`, `.expect`). The 200
//! verdict cases are written as full `SubmitRequest` JSON; the mapping below is the one every consumer uses (Rust here, Lean
//! through `.lines`, TypeScript in AIR-122, the CLI of AIR-023): `fee_per_gas` and `gas` come from `evm` when it is not null,
//! `max_priority_fee_per_gas` is not read by the verdict, `paused` comes from the context, and the asset, payee and task
//! scope become the `Option` arguments.

use airlock_verdict::labels::{from_name, names_of, to_name, NAMES};
use airlock_verdict::*;
use serde_json::Value;

const JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/verdict-vectors.json"
));
const LINES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/verdict-vectors.lines"
));
const EXPECT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/verdict-vectors.expect"
));

fn doc() -> Value {
    serde_json::from_str(JSON).unwrap()
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().unwrap().parse::<u128>().unwrap()
}

fn opt_u128(v: &Value) -> Option<u128> {
    if v.is_null() {
        None
    } else {
        Some(u128_of(v))
    }
}

fn mask_of(v: &Value) -> u16 {
    u16::try_from(v.as_u64().unwrap()).unwrap()
}

struct Case {
    req: Request,
    asset: Option<AssetLimits>,
    payee: Option<Payee>,
    task: Option<TaskScope>,
    flags: Flags,
}

/// The mapping of the ticket: a vector entry to the arguments of `verdict`.
fn case_of(v: &Value) -> Case {
    let r = &v["request"];
    let c = &v["context"];
    let (fee_per_gas, gas) = if r["evm"].is_null() {
        (None, None)
    } else {
        (
            Some(u128_of(&r["evm"]["max_fee_per_gas"])),
            Some(u128_of(&r["evm"]["gas_limit"])),
        )
    };
    let asset = if c["asset"].is_null() {
        None
    } else {
        let a = &c["asset"];
        Some(AssetLimits {
            hard_cap: u128_of(&a["hard_cap"]),
            remaining_daily: u128_of(&a["remaining_daily"]),
            max_fee_per_gas: u128_of(&a["max_fee_per_gas"]),
            max_gas: u128_of(&a["max_gas"]),
        })
    };
    let payee = if c["payee"].is_null() {
        None
    } else {
        let p = &c["payee"];
        Some(Payee {
            cap: opt_u128(&p["cap"]),
            budget_remaining: u128_of(&p["budget_remaining"]),
            limit_remaining: u128_of(&p["limit_remaining"]),
        })
    };
    Case {
        req: Request {
            amount: u128_of(&r["amount"]),
            fee_per_gas,
            gas,
            labels: Labels {
                recipient: mask_of(&r["labels"]["recipient"]),
                amount: mask_of(&r["labels"]["amount"]),
                pc: mask_of(&r["labels"]["pc"]),
            },
        },
        asset,
        payee,
        task: opt_u128(&c["task_remaining"]).map(|remaining| TaskScope { remaining }),
        flags: Flags {
            paused: c["paused"].as_bool().unwrap(),
        },
    }
}

fn tag(v: Verdict) -> String {
    match v {
        Verdict::Allow => "allow".to_string(),
        Verdict::Escalate(r) => format!("escalate:{}", r.as_str()),
        Verdict::Block(r) => format!("block:{}", r.as_str()),
    }
}

fn run(c: &Case) -> Verdict {
    verdict(&c.req, c.asset, c.payee, c.task, &c.flags)
}

/// The 21 numbers of one `.lines` row, written from the JSON entry (the column order of `proofs/VerdictRun.lean`).
fn line_of(v: &Value) -> String {
    let c = case_of(v);
    let opt = |x: Option<u128>| match x {
        Some(n) => format!("1 {n}"),
        None => "0 0".to_string(),
    };
    let a = c.asset.unwrap_or(AssetLimits {
        hard_cap: 0,
        remaining_daily: 0,
        max_fee_per_gas: 0,
        max_gas: 0,
    });
    let p = c.payee.unwrap_or(Payee {
        cap: None,
        budget_remaining: 0,
        limit_remaining: 0,
    });
    let cols = [
        c.req.amount.to_string(),
        opt(c.req.fee_per_gas),
        opt(c.req.gas),
        c.req.labels.recipient.to_string(),
        c.req.labels.amount.to_string(),
        c.req.labels.pc.to_string(),
        format!("{} {}", u8::from(c.asset.is_some()), a.hard_cap),
        a.remaining_daily.to_string(),
        a.max_fee_per_gas.to_string(),
        a.max_gas.to_string(),
        format!("{} {}", u8::from(c.payee.is_some()), opt(p.cap)),
        p.budget_remaining.to_string(),
        p.limit_remaining.to_string(),
        opt(c.task.map(|t| t.remaining)),
        u8::from(c.flags.paused).to_string(),
    ];
    cols.join(" ")
}

#[test]
fn labels_match_table() {
    let d = doc();
    let valid = d["labels"]["valid"].as_array().unwrap();
    assert_eq!(valid.len(), 15);
    for (i, e) in valid.iter().enumerate() {
        let name = e["name"].as_str().unwrap();
        let mask = mask_of(&e["mask"]);
        assert_eq!(name, NAMES[i].0, "name at bit {i}");
        assert_eq!(mask, NAMES[i].1, "mask of {name}");
        assert_eq!(mask, 1u16 << i, "{name} is bit {i}");
        assert_eq!(from_name(name), Some(mask), "from_name({name})");
        assert_eq!(to_name(mask), Some(name), "to_name of the mask of {name}");
    }
}

#[test]
fn invalid_names_rejected() {
    let d = doc();
    let invalid = d["labels"]["invalid"].as_array().unwrap();
    assert_eq!(invalid.len(), 12);
    for e in invalid {
        let name = e.as_str().unwrap();
        assert_eq!(from_name(name), None, "{name:?} must not convert");
    }
}

#[test]
fn verdicts_match_expect() {
    let d = doc();
    let all = d["verdicts"].as_array().unwrap();
    assert!(!all.is_empty());
    let mut bad = Vec::new();
    for v in all {
        let got = tag(run(&case_of(v)));
        let want = v["expect"].as_str().unwrap();
        if got != want {
            bad.push(format!("{}: rust {got}, expect {want}", v["name"]));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} differ: {:?}",
        bad.len(),
        all.len(),
        bad
    );
}

#[test]
fn file_has_200_verdicts_and_every_outcome() {
    let d = doc();
    let all = d["verdicts"].as_array().unwrap();
    assert_eq!(all.len(), 200);
    let mut tags: Vec<&str> = all.iter().map(|v| v["expect"].as_str().unwrap()).collect();
    tags.sort_unstable();
    tags.dedup();
    assert!(tags.contains(&"allow"));
    for r in &ALL_REASONS[..14] {
        let want = [
            format!("block:{}", r.as_str()),
            format!("escalate:{}", r.as_str()),
        ];
        assert!(
            tags.iter().any(|t| want.iter().any(|w| w == t)),
            "no vector expects {}",
            r.as_str()
        );
    }
    let mut names: Vec<&str> = all.iter().map(|v| v["name"].as_str().unwrap()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), 200, "vector names are unique");
}

#[test]
fn label_names_match_masks() {
    let d = doc();
    for v in d["verdicts"].as_array().unwrap() {
        for part in ["recipient", "amount", "pc"] {
            let mask = mask_of(&v["request"]["labels"][part]);
            let listed: Vec<&str> = v["label_names"][part]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap())
                .collect();
            let from_mask: Vec<&str> = names_of(mask).collect();
            assert_eq!(listed, from_mask, "{} {part}", v["name"]);
            let rebuilt = listed.iter().fold(0u16, |m, n| m | from_name(n).unwrap());
            assert_eq!(rebuilt, mask, "{} {part}", v["name"]);
        }
    }
}

#[test]
fn requests_belong_to_the_vector_task() {
    let d = doc();
    let task = &d["owner_task"];
    for v in d["verdicts"].as_array().unwrap() {
        let r = v["request"].as_object().unwrap();
        let mut keys: Vec<&str> = r.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["amount", "asset", "evm", "hints", "labels", "payee", "task_id"]
        );
        assert_eq!(r["task_id"], task["task_id"], "{}", v["name"]);
        assert_eq!(
            r["hints"]["plan_hash"], task["plan_sha256"],
            "{}",
            v["name"]
        );
        // the EVM fields are present exactly on an EVM asset
        let is_evm = r["asset"].as_str().unwrap().starts_with("evm:");
        assert_eq!(!r["evm"].is_null(), is_evm, "{}", v["name"]);
    }
}

#[test]
fn lines_file_matches_the_json() {
    let d = doc();
    let all = d["verdicts"].as_array().unwrap();
    let lines: Vec<&str> = LINES.lines().collect();
    assert_eq!(lines.len(), all.len());
    for (i, v) in all.iter().enumerate() {
        assert_eq!(lines[i], line_of(v), "line {} ({})", i + 1, v["name"]);
    }
}

#[test]
fn expect_file_matches_the_json() {
    let d = doc();
    let all = d["verdicts"].as_array().unwrap();
    let tags: Vec<&str> = EXPECT.lines().collect();
    assert_eq!(tags.len(), all.len());
    for (i, v) in all.iter().enumerate() {
        assert_eq!(tags[i], v["expect"].as_str().unwrap(), "line {}", i + 1);
    }
}

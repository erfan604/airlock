//! JSON-lines verdict CLI (AIR-023, AIR-034): the process the bench loader, the stateful differential test and the Pink adapter talk to.
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
//!
//! Stateful commands (AIR-034): in-memory per-UTC-day ledgers driven by the same pure functions as the contract (`airlock_verdict::ledger`,
//! `airlock_verdict::approve::recheck`). Payee keys, asset ids and task ids are opaque strings here; `now_ms` is a JSON integer and
//! `utc_day = now_ms / 86_400_000`; a ledger pair from another day reads as 0 and the next write overwrites it.
//!   {"cmd":"reset","setup":{"assets":{<asset id>:{"hard_cap","daily_cap","max_fee_per_gas","max_gas"}},"book":{<payee key>:{"cap",
//!       "daily_untrusted_budget","daily_limit"}},"tasks":{<task id>:{"bounds":{<payee key>:"max_total"}}},"flags":{"paused":false}}}
//!       replies {"ok":true} and clears every ledger (a refused setup changes nothing)
//!   {"cmd":"submit","now_ms":N,"task_id":"..","requests":[<SubmitRequest>,..]} (1 to 3 requests, else "batch size 1 to 3") replies
//!       {"ok":true,"outcomes":[{"tag":"allow","charge":{"asset_day","payee_day","payee_untrusted_day","task"}},{"tag":"..","charge":null}]}
//!   {"cmd":"approve","now_ms":N,"task_id":"..","request":<SubmitRequest>} replies {"ok":true,"charge":{..}} or {"ok":false,"error":"recheck:<Reason>"}
//!   {"cmd":"ledgers","now_ms":N,"asset":"..","payee":"..","task_id":".."} replies {"ok":true,"ledgers":{"asset_day":{"spent","cap","remaining"},
//!       "payee_day":{..},"payee_untrusted_day":{..},"task_spent":"n" or null}} (the names of the contract's `get_ledgers` view)
use airlock_verdict::approve::recheck;
use airlock_verdict::ledger::{
    apply_allow, apply_approval, charge_for_allow, charge_for_approval, remaining, Caps, Charge,
    Spent,
};
use airlock_verdict::{
    value_trusted, verdict, AssetLimits, Flags, Labels, Payee, Request, TaskScope, Verdict,
};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

const MS_PER_DAY: u64 = 86_400_000;

fn utc_day(now_ms: u64) -> u64 {
    now_ms / MS_PER_DAY
}

struct AssetCfg {
    hard_cap: u128,
    daily_cap: u128,
    max_fee_per_gas: u128,
    max_gas: u128,
}

struct BookCfg {
    cap: Option<u128>,
    daily_untrusted_budget: u128,
    daily_limit: u128,
}

/// The owner's configuration: assets, address book, task bounds (task id, then payee key) and the pause flag.
#[derive(Default)]
struct Setup {
    assets: BTreeMap<String, AssetCfg>,
    book: BTreeMap<String, BookCfg>,
    tasks: BTreeMap<String, BTreeMap<String, u128>>,
    paused: bool,
}

type DayLedger = BTreeMap<String, (u64, u128)>;

/// The four ledgers: asset per UTC day by asset id, payee per UTC day and payee untrusted budget per UTC day by payee key, and the task
/// ledger by (task id, payee key), which is not day-keyed.
#[derive(Clone, Default)]
struct Ledgers {
    asset_day: DayLedger,
    payee_day: DayLedger,
    payee_untrusted_day: DayLedger,
    task_spent: BTreeMap<(String, String), u128>,
}

fn day_value(ledger: &DayLedger, key: &str, day: u64) -> u128 {
    match ledger.get(key) {
        Some((d, v)) if *d == day => *v,
        _ => 0,
    }
}

impl Ledgers {
    fn spent_now(&self, asset: &str, payee: &str, task_id: &str, now_ms: u64) -> Spent {
        let day = utc_day(now_ms);
        Spent {
            asset_day: day_value(&self.asset_day, asset, day),
            payee_day: day_value(&self.payee_day, payee, day),
            payee_untrusted_day: day_value(&self.payee_untrusted_day, payee, day),
            task: self
                .task_spent
                .get(&(task_id.to_string(), payee.to_string()))
                .copied()
                .unwrap_or(0),
        }
    }

    fn store(&mut self, asset: &str, payee: &str, task_id: &str, now_ms: u64, n: &Spent) {
        let day = utc_day(now_ms);
        self.asset_day.insert(asset.to_string(), (day, n.asset_day));
        self.payee_day.insert(payee.to_string(), (day, n.payee_day));
        self.payee_untrusted_day
            .insert(payee.to_string(), (day, n.payee_untrusted_day));
        self.task_spent
            .insert((task_id.to_string(), payee.to_string()), n.task);
    }
}

/// State shared by the commands.
#[derive(Default)]
struct CliState {
    setup: Setup,
    ledgers: Ledgers,
}

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

/// `v[key]` as a canonical decimal string, named `path.key` in an error.
fn u128_field(v: &Value, key: &str, path: &str) -> Result<u128, String> {
    let what = format!("{path}.{key}");
    u128_of(field(v, key, &what)?, &what)
}

fn mask_of(v: &Value, what: &str) -> Result<u16, String> {
    v.as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| format!("{what} must be an integer from 0 to 65535"))
}

/// The `Request` of a SubmitRequest (AIR-024 mapping); `p` names the request in an error, for example `request` or `requests[1]`.
fn parse_request(request: &Value, p: &str) -> Result<Request, String> {
    let labels = field(request, "labels", &format!("{p}.labels"))?;
    let (fee_per_gas, gas) = match field(request, "evm", &format!("{p}.evm"))? {
        Value::Null => (None, None),
        evm @ Value::Object(_) => {
            if let Some(priority) = evm.get("max_priority_fee_per_gas") {
                u128_of(priority, &format!("{p}.evm.max_priority_fee_per_gas"))?;
            }
            (
                Some(u128_field(evm, "max_fee_per_gas", &format!("{p}.evm"))?),
                Some(u128_field(evm, "gas_limit", &format!("{p}.evm"))?),
            )
        }
        _ => return Err(format!("{p}.evm must be null or an object")),
    };
    let mask = |key: &str| {
        let what = format!("{p}.labels.{key}");
        mask_of(field(labels, key, &what)?, &what)
    };
    Ok(Request {
        amount: u128_field(request, "amount", p)?,
        fee_per_gas,
        gas,
        labels: Labels {
            recipient: mask("recipient")?,
            amount: mask("amount")?,
            pc: mask("pc")?,
        },
    })
}

fn run_verdict(obj: &Map<String, Value>) -> Result<String, String> {
    let request = obj.get("request").ok_or("request is missing")?;
    let context = obj.get("context").ok_or("context is missing")?;
    let req = parse_request(request, "request")?;
    let asset = match field(context, "asset", "context.asset")? {
        Value::Null => None,
        a @ Value::Object(_) => Some(AssetLimits {
            hard_cap: u128_field(a, "hard_cap", "context.asset")?,
            remaining_daily: u128_field(a, "remaining_daily", "context.asset")?,
            max_fee_per_gas: u128_field(a, "max_fee_per_gas", "context.asset")?,
            max_gas: u128_field(a, "max_gas", "context.asset")?,
        }),
        _ => return Err("context.asset must be null or an object".to_string()),
    };
    let payee = match field(context, "payee", "context.payee")? {
        Value::Null => None,
        p @ Value::Object(_) => Some(Payee {
            cap: opt_u128_of(field(p, "cap", "context.payee.cap")?, "context.payee.cap")?,
            budget_remaining: u128_field(p, "budget_remaining", "context.payee")?,
            limit_remaining: u128_field(p, "limit_remaining", "context.payee")?,
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

// ---- stateful commands ----

fn object_of<'a>(v: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object()
        .ok_or_else(|| format!("{what} must be an object"))
}

fn str_of<'a>(v: &'a Value, what: &str) -> Result<&'a str, String> {
    v.as_str().ok_or_else(|| format!("{what} must be a string"))
}

fn str_key<'a>(m: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    str_of(m.get(key).ok_or_else(|| format!("{key} is missing"))?, key)
}

fn now_of(m: &Map<String, Value>) -> Result<u64, String> {
    m.get("now_ms")
        .and_then(Value::as_u64)
        .ok_or_else(|| "now_ms must be a non-negative integer".to_string())
}

fn parse_setup(obj: &Map<String, Value>) -> Result<Setup, String> {
    let s = obj.get("setup").ok_or("setup is missing")?;
    let mut setup = Setup::default();
    for (id, a) in object_of(field(s, "assets", "setup.assets")?, "setup.assets")? {
        let path = format!("setup.assets.{id}");
        setup.assets.insert(
            id.clone(),
            AssetCfg {
                hard_cap: u128_field(a, "hard_cap", &path)?,
                daily_cap: u128_field(a, "daily_cap", &path)?,
                max_fee_per_gas: u128_field(a, "max_fee_per_gas", &path)?,
                max_gas: u128_field(a, "max_gas", &path)?,
            },
        );
    }
    for (key, b) in object_of(field(s, "book", "setup.book")?, "setup.book")? {
        let path = format!("setup.book.{key}");
        setup.book.insert(
            key.clone(),
            BookCfg {
                cap: opt_u128_of(
                    field(b, "cap", &format!("{path}.cap"))?,
                    &format!("{path}.cap"),
                )?,
                daily_untrusted_budget: u128_field(b, "daily_untrusted_budget", &path)?,
                daily_limit: u128_field(b, "daily_limit", &path)?,
            },
        );
    }
    for (task_id, t) in object_of(field(s, "tasks", "setup.tasks")?, "setup.tasks")? {
        let path = format!("setup.tasks.{task_id}.bounds");
        let bounds = object_of(field(t, "bounds", &path)?, &path)?;
        let mut by_payee = BTreeMap::new();
        for (payee, max_total) in bounds {
            by_payee.insert(
                payee.clone(),
                u128_of(max_total, &format!("{path}.{payee}"))?,
            );
        }
        setup.tasks.insert(task_id.clone(), by_payee);
    }
    setup.paused = field(
        field(s, "flags", "setup.flags")?,
        "paused",
        "setup.flags.paused",
    )?
    .as_bool()
    .ok_or("setup.flags.paused must be a boolean")?;
    Ok(setup)
}

/// A request to an asset and a payee, as `submit` and `approve` read it.
struct Parsed {
    req: Request,
    asset: String,
    payee: String,
}

fn parse_stateful_request(request: &Value, p: &str) -> Result<Parsed, String> {
    Ok(Parsed {
        req: parse_request(request, p)?,
        asset: str_of(
            field(request, "asset", &format!("{p}.asset"))?,
            &format!("{p}.asset"),
        )?
        .to_string(),
        payee: str_of(
            field(request, "payee", &format!("{p}.payee"))?,
            &format!("{p}.payee"),
        )?
        .to_string(),
    })
}

fn charge_json(c: &Charge) -> String {
    format!(
        "{{\"asset_day\":\"{}\",\"payee_day\":\"{}\",\"payee_untrusted_day\":\"{}\",\"task\":\"{}\"}}",
        c.asset_day, c.payee_day, c.payee_untrusted_day, c.task
    )
}

/// The caps of the Allow path; a missing part has cap 0, as in the contract's `verdict_inputs`.
fn allow_caps(a: Option<&AssetCfg>, p: Option<&BookCfg>, bound: Option<u128>) -> Caps {
    Caps {
        asset_daily: a.map_or(0, |a| a.daily_cap),
        payee_limit: p.map_or(0, |p| p.daily_limit),
        payee_budget: p.map_or(0, |p| p.daily_untrusted_budget),
        task_bound: bound.unwrap_or(0),
    }
}

/// The caps of an approval: the payee limit is unbounded for a payee outside the book, the untrusted budget is 0 (an approval never
/// charges it), and a task without a bound for this payee has bound 0, which leaves the task ledger as it is.
fn approval_caps(a: Option<&AssetCfg>, p: Option<&BookCfg>, bound: Option<u128>) -> Caps {
    Caps {
        asset_daily: a.map_or(0, |a| a.daily_cap),
        payee_limit: p.map_or(u128::MAX, |p| p.daily_limit),
        payee_budget: 0,
        task_bound: bound.unwrap_or(0),
    }
}

fn asset_limits(a: Option<&AssetCfg>, remaining_daily: u128) -> Option<AssetLimits> {
    a.map(|a| AssetLimits {
        hard_cap: a.hard_cap,
        remaining_daily,
        max_fee_per_gas: a.max_fee_per_gas,
        max_gas: a.max_gas,
    })
}

fn run_reset(obj: &Map<String, Value>, state: &mut CliState) -> Result<String, String> {
    let setup = parse_setup(obj)?;
    state.setup = setup;
    state.ledgers = Ledgers::default();
    Ok("{\"ok\":true}".to_string())
}

fn run_submit(obj: &Map<String, Value>, state: &mut CliState) -> Result<String, String> {
    let now_ms = now_of(obj)?;
    let task_id = str_key(obj, "task_id")?;
    let requests = obj
        .get("requests")
        .ok_or("requests is missing")?
        .as_array()
        .ok_or("requests must be an array")?;
    if requests.is_empty() || requests.len() > 3 {
        return Err("batch size 1 to 3".to_string());
    }
    let mut parsed = Vec::new();
    for (i, r) in requests.iter().enumerate() {
        parsed.push(parse_stateful_request(r, &format!("requests[{i}]"))?);
    }
    // the whole batch or nothing: a failure part way restores the ledgers, as a reverted transaction would
    let snapshot = state.ledgers.clone();
    let mut outcomes = Vec::new();
    for p in &parsed {
        let asset = state.setup.assets.get(&p.asset);
        let payee = state.setup.book.get(&p.payee);
        let bound = state
            .setup
            .tasks
            .get(task_id)
            .and_then(|t| t.get(&p.payee))
            .copied();
        let spent = state.ledgers.spent_now(&p.asset, &p.payee, task_id, now_ms);
        let caps = allow_caps(asset, payee, bound);
        let rem = remaining(&spent, &caps);
        let limits = asset_limits(asset, rem.asset_day);
        let payee_view = payee.map(|b| Payee {
            cap: b.cap,
            budget_remaining: rem.payee_untrusted_day,
            limit_remaining: rem.payee_day,
        });
        let task = bound.map(|_| TaskScope {
            remaining: rem.task,
        });
        let v = verdict(
            &p.req,
            limits,
            payee_view,
            task,
            &Flags {
                paused: state.setup.paused,
            },
        );
        if v == Verdict::Allow {
            let ch = charge_for_allow(p.req.amount, !value_trusted(p.req.labels.amount));
            let Some((n, applied)) = apply_allow(&spent, &ch, &caps) else {
                state.ledgers = snapshot;
                return Err("ledger overflow".to_string());
            };
            state.ledgers.store(&p.asset, &p.payee, task_id, now_ms, &n);
            outcomes.push(format!(
                "{{\"tag\":\"allow\",\"charge\":{}}}",
                charge_json(&applied)
            ));
        } else {
            outcomes.push(format!(
                "{{\"tag\":{},\"charge\":null}}",
                json_string(&tag(v))
            ));
        }
    }
    Ok(format!(
        "{{\"ok\":true,\"outcomes\":[{}]}}",
        outcomes.join(",")
    ))
}

fn run_approve(obj: &Map<String, Value>, state: &mut CliState) -> Result<String, String> {
    let now_ms = now_of(obj)?;
    let task_id = str_key(obj, "task_id")?;
    let request = obj.get("request").ok_or("request is missing")?;
    let p = parse_stateful_request(request, "request")?;
    let asset = state.setup.assets.get(&p.asset);
    let payee = state.setup.book.get(&p.payee);
    let bound = state
        .setup
        .tasks
        .get(task_id)
        .and_then(|t| t.get(&p.payee))
        .copied();
    let spent = state.ledgers.spent_now(&p.asset, &p.payee, task_id, now_ms);
    let caps = approval_caps(asset, payee, bound);
    let rem = remaining(&spent, &caps);
    if let Err(reason) = recheck(
        &p.req,
        asset_limits(asset, rem.asset_day),
        state.setup.paused,
    ) {
        return Err(format!("recheck:{}", reason.as_str()));
    }
    let ch = charge_for_approval(p.req.amount);
    let Some((n, applied)) = apply_approval(&spent, &ch, &caps) else {
        return Err("ledger overflow".to_string());
    };
    state.ledgers.store(&p.asset, &p.payee, task_id, now_ms, &n);
    Ok(format!(
        "{{\"ok\":true,\"charge\":{}}}",
        charge_json(&applied)
    ))
}

fn amount_json(spent: u128, cap: u128, remaining: u128) -> String {
    format!("{{\"spent\":\"{spent}\",\"cap\":\"{cap}\",\"remaining\":\"{remaining}\"}}")
}

fn run_ledgers(obj: &Map<String, Value>, state: &CliState) -> Result<String, String> {
    let now_ms = now_of(obj)?;
    let asset_id = str_key(obj, "asset")?;
    let payee_key = str_key(obj, "payee")?;
    let task_id = str_key(obj, "task_id")?;
    let asset = state.setup.assets.get(asset_id);
    let payee = state.setup.book.get(payee_key);
    // an unknown asset or payee has zero caps; the task bound does not matter for the three day ledgers
    let caps = allow_caps(asset, payee, None);
    let spent = state
        .ledgers
        .spent_now(asset_id, payee_key, task_id, now_ms);
    let rem = remaining(&spent, &caps);
    let task_spent = if state.setup.tasks.contains_key(task_id) {
        format!("\"{}\"", spent.task)
    } else {
        "null".to_string()
    };
    Ok(format!(
        "{{\"ok\":true,\"ledgers\":{{\"asset_day\":{},\"payee_day\":{},\"payee_untrusted_day\":{},\"task_spent\":{}}}}}",
        amount_json(spent.asset_day, caps.asset_daily, rem.asset_day),
        amount_json(spent.payee_day, caps.payee_limit, rem.payee_day),
        amount_json(
            spent.payee_untrusted_day,
            caps.payee_budget,
            rem.payee_untrusted_day
        ),
        task_spent
    ))
}

/// One line in, one reply line out. Never panics on input: every failure is an `ok:false` reply.
fn handle(line: &str, state: &mut CliState) -> String {
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
    let reply = match cmd {
        "verdict" => run_verdict(obj).map(|t| ok_reply(&t)),
        "reset" => run_reset(obj, state),
        "submit" => run_submit(obj, state),
        "approve" => run_approve(obj, state),
        "ledgers" => run_ledgers(obj, state),
        other => Err(format!("unknown cmd {other}")),
    };
    match reply {
        Ok(r) => r,
        Err(e) => err_reply(&e),
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

//! Kani harnesses for `verdict` (AIR-021): every u128 amount, every u16 label set and every combination of limits, on the
//! Rust that ships. The verdict is loop free, so no harness needs `kani::unwind`.
//!
//! Two rules keep the proofs honest. First, the trust masks are written as literals (`0b0000_1111` for a trusted pc or
//! amount, `0b0111` for a trusted recipient, `0b0111_1111_1111_0000` for the untrusted bits), never through `TRUSTED_MASK`
//! and friends: a harness that reads the constant under test moves with a bug in it. Second, every harness carries at least
//! one `kani::cover!` on the case its assumptions should reach, so a contradictory assumption shows up as an unsatisfied cover
//! instead of a vacuous pass. Mutants that each harness must catch are listed in `harnesses.toml` and run by
//! `scripts/mutants.sh`.
use super::*;

fn any_labels() -> Labels {
    Labels {
        recipient: kani::any(),
        amount: kani::any(),
        pc: kani::any(),
    }
}

fn any_request() -> Request {
    Request {
        amount: kani::any(),
        fee_per_gas: kani::any(),
        gas: kani::any(),
        labels: any_labels(),
    }
}

fn any_asset_limits() -> AssetLimits {
    AssetLimits {
        hard_cap: kani::any(),
        remaining_daily: kani::any(),
        max_fee_per_gas: kani::any(),
        max_gas: kani::any(),
    }
}

fn any_asset() -> Option<AssetLimits> {
    if kani::any() {
        Some(any_asset_limits())
    } else {
        None
    }
}

fn any_payee_entry() -> Payee {
    Payee {
        cap: kani::any(),
        budget_remaining: kani::any(),
        limit_remaining: kani::any(),
    }
}

fn any_payee() -> Option<Payee> {
    if kani::any() {
        Some(any_payee_entry())
    } else {
        None
    }
}

fn any_task() -> Option<TaskScope> {
    if kani::any() {
        Some(TaskScope {
            remaining: kani::any(),
        })
    } else {
        None
    }
}

fn any_flags() -> Flags {
    Flags {
        paused: kani::any(),
    }
}

/// True when the verdict for these inputs is Allow.
fn allow(
    r: &Request,
    a: Option<AssetLimits>,
    p: Option<Payee>,
    t: Option<TaskScope>,
    f: &Flags,
) -> bool {
    verdict(r, a, p, t, f) == Verdict::Allow
}

/// An absent fee or gas is within any cap (rule 3 on the NEAR lane); a present one must not exceed it.
fn within(x: Option<u128>, cap: u128) -> bool {
    match x {
        Some(v) => v <= cap,
        None => true,
    }
}

/// Literal trusted-value mask: Owner, Book, Policy, Oracle (amount and pc).
fn trusted_value(l: u16) -> bool {
    l != 0 && l & !0b0000_1111 == 0
}

/// P1: a payment whose pc touched untrusted data never auto-executes.
#[kani::proof]
fn p01_untrusted_pc_never_allowed() {
    let r = any_request();
    kani::assume(r.labels.pc & !0b0000_1111 != 0);
    let out = verdict(&r, any_asset(), any_payee(), any_task(), &any_flags());
    kani::cover!(
        out == Verdict::Escalate(Reason::UntrustedTrigger),
        "an untrusted pc reaches the pc rule"
    );
    assert!(out != Verdict::Allow);
}

/// P2 and P15: an allowed recipient label set is non-empty and within {Owner, Book, Policy}, never Oracle.
#[kani::proof]
fn p02_p15_allowed_recipient_trust_set() {
    let r = any_request();
    if allow(&r, any_asset(), any_payee(), any_task(), &any_flags()) {
        kani::cover!(true, "an Allow is reachable");
        assert!(r.labels.recipient != 0 && r.labels.recipient & !0b0111 == 0);
    }
}

/// P3: an allowed payment always goes to an address-book entry (new recipients always escalate).
#[kani::proof]
fn p03_allowed_recipient_in_book() {
    let (r, p) = (any_request(), any_payee());
    if allow(&r, any_asset(), p, any_task(), &any_flags()) {
        kani::cover!(true, "an Allow is reachable");
        assert!(p.is_some());
    }
}

/// P4, P14 and P23: an allowed untrusted amount is not Unresolved and within the payee's cap and remaining budget.
#[kani::proof]
fn p04_p14_p23_untrusted_amount_inside_cap_and_budget() {
    let (r, p) = (any_request(), any_payee());
    if allow(&r, any_asset(), p, any_task(), &any_flags()) && !trusted_value(r.labels.amount) {
        kani::cover!(true, "an Allow with an untrusted amount is reachable");
        assert!(r.labels.amount & 0b1_0000 == 0);
        match p {
            Some(Payee {
                cap: Some(cap),
                budget_remaining,
                ..
            }) => {
                assert!(r.amount <= cap);
                assert!(r.amount <= budget_remaining);
            }
            _ => {
                assert!(false, "untrusted amount allowed without a payee cap");
            }
        }
    }
}

/// P5, P10 and P18: any outcome other than Block has a registered asset, no pause and every limit holding, whatever the labels.
#[kani::proof]
fn p05_p10_p18_limits_hold_for_any_labels() {
    let (r, a, f) = (any_request(), any_asset(), any_flags());
    let out = verdict(&r, a, any_payee(), any_task(), &f);
    if !matches!(out, Verdict::Block(_)) {
        kani::cover!(out == Verdict::Allow, "an Allow passes the limits");
        kani::cover!(
            matches!(out, Verdict::Escalate(_)),
            "an Escalate passes the limits"
        );
        assert!(!f.paused);
        match a {
            Some(a) => {
                assert!(r.amount != 0 && r.amount <= a.hard_cap);
                assert!(r.amount <= a.remaining_daily);
                assert!(within(r.fee_per_gas, a.max_fee_per_gas));
                assert!(within(r.gas, a.max_gas));
            }
            None => {
                assert!(false, "unknown asset passed");
            }
        }
    }
}

/// P6: a runtime that labels a recipient as Book when the book has no such entry is blocked with exactly that reason.
#[kani::proof]
fn p06_lying_book_label_blocked() {
    let r = any_request();
    let a = any_asset_limits();
    kani::assume(r.amount != 0 && r.amount <= a.hard_cap);
    kani::assume(r.amount <= a.remaining_daily);
    kani::assume(within(r.fee_per_gas, a.max_fee_per_gas) && within(r.gas, a.max_gas));
    kani::assume(r.labels.recipient != 0 && r.labels.amount != 0 && r.labels.pc != 0);
    kani::assume(r.labels.recipient & 0b0010 != 0);
    kani::cover!(
        true,
        "the preconditions of the lying Book label are reachable"
    );
    let out = verdict(&r, Some(a), None, any_task(), &Flags { paused: false });
    assert!(out == Verdict::Block(Reason::BookLabelNotInBook));
}

/// P7: on a well-formed request, adding untrusted bits to any label set never turns a non-Allow into an Allow.
#[kani::proof]
fn p07_more_taint_never_allows() {
    let (r, a, p, t, f) = (
        any_request(),
        any_asset(),
        any_payee(),
        any_task(),
        any_flags(),
    );
    kani::assume(r.labels.recipient != 0 && r.labels.amount != 0 && r.labels.pc != 0);
    let (x1, x2, x3): (u16, u16, u16) = (kani::any(), kani::any(), kani::any());
    let tainted = Request {
        labels: Labels {
            recipient: r.labels.recipient | (x1 & 0b0111_1111_1111_0000),
            amount: r.labels.amount | (x2 & 0b0111_1111_1111_0000),
            pc: r.labels.pc | (x3 & 0b0111_1111_1111_0000),
        },
        ..r
    };
    let base_allowed = allow(&r, a, p, t, &f);
    let tainted_allowed = allow(&tainted, a, p, t, &f);
    kani::cover!(
        base_allowed && !tainted_allowed,
        "the base request is Allow and the tainted request is not"
    );
    assert!(base_allowed || !tainted_allowed);
}

/// P8: `verdict` returns for every input and the outcome is one of the three variants.
#[kani::proof]
fn p08_total() {
    match verdict(
        &any_request(),
        any_asset(),
        any_payee(),
        any_task(),
        &any_flags(),
    ) {
        Verdict::Allow => {
            kani::cover!(true, "Allow is reachable");
        }
        Verdict::Escalate(_) => {}
        Verdict::Block(_) => {}
    }
}

/// P9 and P20: a request with an empty label set for the recipient, the amount or the pc is never allowed.
#[kani::proof]
fn p09_p20_missing_provenance_never_allowed() {
    let r = any_request();
    kani::assume(r.labels.recipient == 0 || r.labels.amount == 0 || r.labels.pc == 0);
    let out = verdict(&r, any_asset(), any_payee(), any_task(), &any_flags());
    kani::cover!(
        out == Verdict::Block(Reason::MissingProvenance),
        "an empty label set reaches the provenance rule"
    );
    assert!(out != Verdict::Allow);
}

/// The asset, removed or with every limit lowered or kept.
fn tighten_asset(a: Option<AssetLimits>) -> Option<AssetLimits> {
    match a {
        None => None,
        Some(x) => {
            if kani::any() {
                None
            } else {
                let n = any_asset_limits();
                kani::assume(
                    n.hard_cap <= x.hard_cap
                        && n.remaining_daily <= x.remaining_daily
                        && n.max_fee_per_gas <= x.max_fee_per_gas
                        && n.max_gas <= x.max_gas,
                );
                Some(n)
            }
        }
    }
}

/// The payee, removed or with its cap (removal counts as lowering), budget and limit lowered or kept.
fn tighten_payee(p: Option<Payee>) -> Option<Payee> {
    match p {
        None => None,
        Some(x) => {
            if kani::any() {
                None
            } else {
                let n = any_payee_entry();
                kani::assume(n.budget_remaining <= x.budget_remaining);
                kani::assume(n.limit_remaining <= x.limit_remaining);
                kani::assume(match (n.cap, x.cap) {
                    (None, _) => true,
                    (Some(_), None) => false,
                    (Some(lower), Some(old)) => lower <= old,
                });
                Some(n)
            }
        }
    }
}

/// The task scope, removed or with its remainder lowered or kept.
fn tighten_task(t: Option<TaskScope>) -> Option<TaskScope> {
    match t {
        None => None,
        Some(x) => {
            if kani::any() {
                None
            } else {
                let n = TaskScope {
                    remaining: kani::any(),
                };
                kani::assume(n.remaining <= x.remaining);
                Some(n)
            }
        }
    }
}

/// P11: removing the asset, payee or task scope, lowering any limit, cap, budget or remainder, or turning pause on never
/// turns a non-Allow into an Allow.
#[kani::proof]
fn p11_tightening_never_opens() {
    let (r, a, p, t, f) = (
        any_request(),
        any_asset(),
        any_payee(),
        any_task(),
        any_flags(),
    );
    let tighter = Flags {
        paused: f.paused || kani::any(),
    };
    let base_allowed = allow(&r, a, p, t, &f);
    let tightened_allowed = allow(
        &r,
        tighten_asset(a),
        tighten_payee(p),
        tighten_task(t),
        &tighter,
    );
    kani::cover!(base_allowed, "the base request is Allow before tightening");
    kani::cover!(
        base_allowed && !tightened_allowed,
        "tightening closes an Allow"
    );
    assert!(base_allowed || !tightened_allowed);
}

/// P21: an allowed payment is inside the owner-signed task bound, with enough of it left.
#[kani::proof]
fn p21_allowed_inside_task_bound() {
    let (r, t) = (any_request(), any_task());
    if allow(&r, any_asset(), any_payee(), t, &any_flags()) {
        kani::cover!(true, "an Allow is reachable");
        match t {
            Some(t) => {
                assert!(r.amount <= t.remaining);
            }
            None => {
                assert!(false, "allowed outside the task");
            }
        }
    }
}

/// P22: an allowed payment is within the payee's remaining limit for any amount, trusted or not.
#[kani::proof]
fn p22_allowed_within_payee_limit() {
    let (r, p) = (any_request(), any_payee());
    if allow(&r, any_asset(), p, any_task(), &any_flags()) {
        kani::cover!(true, "an Allow is reachable");
        match p {
            Some(p) => {
                assert!(r.amount <= p.limit_remaining);
            }
            None => {
                assert!(false, "allowed without a payee");
            }
        }
    }
}

/// Non-vacuity of the whole function: with unconstrained inputs Allow and each of the 14 reasons `verdict` can return is
/// reachable. There is no assertion; a missing outcome shows as an unsatisfied cover.
#[kani::proof]
fn cover_every_reason() {
    let out = verdict(
        &any_request(),
        any_asset(),
        any_payee(),
        any_task(),
        &any_flags(),
    );
    kani::cover!(out == Verdict::Allow, "Allow");
    kani::cover!(
        out == Verdict::Block(Reason::UnknownAsset),
        "Block UnknownAsset"
    );
    kani::cover!(out == Verdict::Block(Reason::Paused), "Block Paused");
    kani::cover!(
        out == Verdict::Block(Reason::AmountOutOfBounds),
        "Block AmountOutOfBounds"
    );
    kani::cover!(
        out == Verdict::Block(Reason::DailyLimit),
        "Block DailyLimit"
    );
    kani::cover!(
        out == Verdict::Block(Reason::FeeTooHigh),
        "Block FeeTooHigh"
    );
    kani::cover!(
        out == Verdict::Block(Reason::MissingProvenance),
        "Block MissingProvenance"
    );
    kani::cover!(
        out == Verdict::Block(Reason::BookLabelNotInBook),
        "Block BookLabelNotInBook"
    );
    kani::cover!(
        out == Verdict::Escalate(Reason::OutsideTask),
        "Escalate OutsideTask"
    );
    kani::cover!(
        out == Verdict::Escalate(Reason::OverTaskBound),
        "Escalate OverTaskBound"
    );
    kani::cover!(
        out == Verdict::Escalate(Reason::UntrustedTrigger),
        "Escalate UntrustedTrigger"
    );
    kani::cover!(
        out == Verdict::Escalate(Reason::UntrustedRecipient),
        "Escalate UntrustedRecipient"
    );
    kani::cover!(
        out == Verdict::Escalate(Reason::NewRecipient),
        "Escalate NewRecipient"
    );
    kani::cover!(
        out == Verdict::Escalate(Reason::OverPayeeLimit),
        "Escalate OverPayeeLimit"
    );
    kani::cover!(
        out == Verdict::Escalate(Reason::UntrustedAmount),
        "Escalate UntrustedAmount"
    );
}

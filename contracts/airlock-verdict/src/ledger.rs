//! The cumulative ledgers as a pure model (F05, SPEC R3-02, R3-03, R5-10): checked arithmetic, no allocation, no panic for any input.
//! The contract (AIR-062) keeps four numbers per request (asset day, payee day, payee untrusted day, task), charges them for every Allow
//! and every approval, stores the applied charge in the request record and refunds exactly that charge when signing fails. Kani proves
//! the invariants L1 to L5 in `proofs` below as one inductive step from any state inside the caps, plus a three-request batch, and keeps the
//! two naive designs (snapshot batch, uncharged approvals) as `should_panic` documentation.

/// What has been spent so far, per ledger. The day key belongs to the contract record, not to this model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spent {
    pub asset_day: u128,
    pub payee_day: u128,
    pub payee_untrusted_day: u128,
    pub task: u128,
}

/// The bound of each ledger: the asset daily cap, the payee limit for any amount, the payee untrusted budget, the task bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub asset_daily: u128,
    pub payee_limit: u128,
    pub payee_budget: u128,
    pub task_bound: u128,
}

/// An amount to charge to each ledger (requested), or the amount that was charged (applied).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Charge {
    pub asset_day: u128,
    pub payee_day: u128,
    pub payee_untrusted_day: u128,
    pub task: u128,
}

/// cap minus spent per field, 0 when spent is above the cap; the result is a `Spent` whose fields hold remainders
pub fn remaining(s: &Spent, c: &Caps) -> Spent {
    Spent {
        asset_day: c.asset_daily.saturating_sub(s.asset_day),
        payee_day: c.payee_limit.saturating_sub(s.payee_day),
        payee_untrusted_day: c.payee_budget.saturating_sub(s.payee_untrusted_day),
        task: c.task_bound.saturating_sub(s.task),
    }
}

/// The charge of an auto-executed payment: the untrusted budget is charged only when the amount labels are untrusted
/// (the caller passes `!value_trusted(labels.amount)`).
pub fn charge_for_allow(amount: u128, amount_untrusted: bool) -> Charge {
    Charge {
        asset_day: amount,
        payee_day: amount,
        payee_untrusted_day: if amount_untrusted { amount } else { 0 },
        task: amount,
    }
}

/// The charge of an owner approval: never the untrusted budget.
pub fn charge_for_approval(amount: u128) -> Charge {
    Charge {
        asset_day: amount,
        payee_day: amount,
        payee_untrusted_day: 0,
        task: amount,
    }
}

/// `spent + amount` when it fits under `cap` and does not overflow, else `None`.
pub fn spend(spent: u128, amount: u128, cap: u128) -> Option<u128> {
    match spent.checked_add(amount) {
        Some(n) if n <= cap => Some(n),
        _ => None,
    }
}

/// moves a ledger toward its cap by at most `amount`; returns (new, applied); a ledger at or above its cap stays and applies 0
fn saturate(spent: u128, amount: u128, cap: u128) -> (u128, u128) {
    let applied = amount.min(cap.saturating_sub(spent));
    (spent + applied, applied)
}

/// An auto-executed payment: all four ledgers must stay inside their caps, else `None`. The applied charge is the requested one.
pub fn apply_allow(s: &Spent, ch: &Charge, c: &Caps) -> Option<(Spent, Charge)> {
    let n = Spent {
        asset_day: spend(s.asset_day, ch.asset_day, c.asset_daily)?,
        payee_day: spend(s.payee_day, ch.payee_day, c.payee_limit)?,
        payee_untrusted_day: spend(
            s.payee_untrusted_day,
            ch.payee_untrusted_day,
            c.payee_budget,
        )?,
        task: spend(s.task, ch.task, c.task_bound)?,
    };
    Some((n, *ch))
}

/// An owner approval: only the asset day is checked (`None` if it would pass the daily cap); the payee day and the task ledger saturate
/// at their caps, because approving an escalation over the payee limit or the task bound is an owner decision that uses the bound up
/// (R3-03, R5-10). The untrusted budget is never touched. Returns the charge actually applied.
pub fn apply_approval(s: &Spent, ch: &Charge, c: &Caps) -> Option<(Spent, Charge)> {
    let asset_day = spend(s.asset_day, ch.asset_day, c.asset_daily)?;
    let (payee_day, applied_payee) = saturate(s.payee_day, ch.payee_day, c.payee_limit);
    let (task, applied_task) = saturate(s.task, ch.task, c.task_bound);
    let n = Spent {
        asset_day,
        payee_day,
        payee_untrusted_day: s.payee_untrusted_day,
        task,
    };
    let applied = Charge {
        asset_day: ch.asset_day,
        payee_day: applied_payee,
        payee_untrusted_day: 0,
        task: applied_task,
    };
    Some((n, applied))
}

/// The exact inverse of a returned applied charge; `None` if a field would underflow.
pub fn refund(s: &Spent, applied: &Charge) -> Option<Spent> {
    Some(Spent {
        asset_day: s.asset_day.checked_sub(applied.asset_day)?,
        payee_day: s.payee_day.checked_sub(applied.payee_day)?,
        payee_untrusted_day: s
            .payee_untrusted_day
            .checked_sub(applied.payee_untrusted_day)?,
        task: s.task.checked_sub(applied.task)?,
    })
}

#[cfg(kani)]
mod proofs {
    use super::*;
    use crate::*;

    fn inv(s: &Spent, c: &Caps) -> bool {
        s.asset_day <= c.asset_daily
            && s.payee_day <= c.payee_limit
            && s.payee_untrusted_day <= c.payee_budget
            && s.task <= c.task_bound
    }

    fn any_state() -> (Spent, Caps) {
        let c = Caps {
            asset_daily: kani::any(),
            payee_limit: kani::any(),
            payee_budget: kani::any(),
            task_bound: kani::any(),
        };
        let s = Spent {
            asset_day: kani::any(),
            payee_day: kani::any(),
            payee_untrusted_day: kani::any(),
            task: kani::any(),
        };
        kani::assume(inv(&s, &c));
        (s, c)
    }

    fn any_request() -> Request {
        Request {
            amount: kani::any(),
            fee_per_gas: kani::any(),
            gas: kani::any(),
            labels: Labels {
                recipient: kani::any(),
                amount: kani::any(),
                pc: kani::any(),
            },
        }
    }

    fn any_charge() -> Charge {
        Charge {
            asset_day: kani::any(),
            payee_day: kani::any(),
            payee_untrusted_day: kani::any(),
            task: kani::any(),
        }
    }

    #[derive(Clone, Copy)]
    struct Env {
        hard: u128,
        pcap: Option<u128>,
        paused: bool,
    }

    fn any_env() -> Env {
        Env {
            hard: kani::any(),
            pcap: kani::any(),
            paused: kani::any(),
        }
    }

    /// the verdict inputs built from remaining(..) the way the contract builds them (AIR-062 `verdict_inputs`)
    fn verdict_on(s: &Spent, c: &Caps, r: &Request, e: &Env) -> Verdict {
        let rem = remaining(s, c);
        let asset = Some(AssetLimits {
            hard_cap: e.hard,
            remaining_daily: rem.asset_day,
            max_fee_per_gas: u128::MAX,
            max_gas: u128::MAX,
        });
        let payee = Some(Payee {
            cap: e.pcap,
            budget_remaining: rem.payee_untrusted_day,
            limit_remaining: rem.payee_day,
        });
        verdict(
            r,
            asset,
            payee,
            Some(TaskScope {
                remaining: rem.task,
            }),
            &Flags { paused: e.paused },
        )
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Kind {
        Skipped,
        Allow,
        RawAllow,
        Approval,
    }

    struct Done {
        kind: Kind,
        requested: Charge,
        applied: Charge,
        untrusted_labels: bool,
    }

    /// One step on `s`. choice 0: a verdict-gated Allow (charge_for_allow then apply_allow); 1: apply_allow with an ARBITRARY charge;
    /// 2: an approval. Step 1 exists because the verdict already gates the task bound, the daily cap and the budget, so a bug that
    /// drops one of those checks from apply_allow is invisible to gated Allows alone (verified: mutants LG2 and LG3 survive without it).
    fn step(s: &mut Spent, c: &Caps, e: &Env, r: &Request, choice: u8) -> Done {
        let zero = Charge {
            asset_day: 0,
            payee_day: 0,
            payee_untrusted_day: 0,
            task: 0,
        };
        let untrusted = !value_trusted(r.labels.amount);
        kani::assume(choice < 3);
        if choice == 2 {
            let ch = charge_for_approval(r.amount);
            match apply_approval(s, &ch, c) {
                Some((n, applied)) => {
                    *s = n;
                    Done {
                        kind: Kind::Approval,
                        requested: ch,
                        applied,
                        untrusted_labels: untrusted,
                    }
                }
                None => Done {
                    kind: Kind::Skipped,
                    requested: ch,
                    applied: zero,
                    untrusted_labels: untrusted,
                },
            }
        } else if choice == 1 {
            let ch = any_charge();
            match apply_allow(s, &ch, c) {
                Some((n, applied)) => {
                    *s = n;
                    Done {
                        kind: Kind::RawAllow,
                        requested: ch,
                        applied,
                        untrusted_labels: untrusted,
                    }
                }
                None => Done {
                    kind: Kind::Skipped,
                    requested: ch,
                    applied: zero,
                    untrusted_labels: untrusted,
                },
            }
        } else if verdict_on(s, c, r, e) == Verdict::Allow {
            let ch = charge_for_allow(r.amount, untrusted);
            let got = apply_allow(s, &ch, c);
            assert!(got.is_some(), "verdict Allow but apply_allow refuses");
            let (n, applied) = got.unwrap();
            *s = n;
            Done {
                kind: Kind::Allow,
                requested: ch,
                applied,
                untrusted_labels: untrusted,
            }
        } else {
            Done {
                kind: Kind::Skipped,
                requested: zero,
                applied: zero,
                untrusted_labels: untrusted,
            }
        }
    }

    fn is_allow(k: Kind) -> bool {
        k == Kind::Allow || k == Kind::RawAllow
    }

    // no #[kani::unwind] anywhere (no loops), and every cover sits after the steps, never inside a loop

    /// P13: `spend` never panics and returns Some(n) only when spent plus amount fits under the cap.
    #[kani::proof]
    fn p13_spend_exact_and_total() {
        let (s, a, c): (u128, u128, u128) = (kani::any(), kani::any(), kani::any());
        match spend(s, a, c) {
            Some(n) => {
                kani::cover!(true, "spend returns Some");
                assert!(n <= c && n >= s && n - s == a);
            }
            None => {
                kani::cover!(true, "spend returns None");
                assert!(s.checked_add(a).map_or(true, |n| n > c));
            }
        }
    }

    /// L1: the payee untrusted budget holds after one step from any state inside the caps.
    #[kani::proof]
    fn l1_untrusted_budget_holds() {
        let (s0, c) = any_state();
        let e = any_env();
        let r = any_request();
        let choice: u8 = kani::any();
        let mut s = s0;
        let d = step(&mut s, &c, &e, &r, choice);
        assert!(s.payee_untrusted_day <= c.payee_budget);
        assert!(s.payee_untrusted_day - s0.payee_untrusted_day == d.applied.payee_untrusted_day);
        if is_allow(d.kind) {
            assert!(d.applied.payee_untrusted_day == d.requested.payee_untrusted_day);
        }
        if d.kind == Kind::Approval {
            assert!(d.applied.payee_untrusted_day == 0);
        }
        if d.kind == Kind::Allow {
            if d.untrusted_labels {
                assert!(d.applied.payee_untrusted_day == r.amount);
            } else {
                assert!(d.applied.payee_untrusted_day == 0);
            }
        }
        kani::cover!(
            d.kind == Kind::Allow && d.untrusted_labels,
            "a gated Allow of an untrusted amount"
        );
        kani::cover!(
            d.kind == Kind::Allow && !d.untrusted_labels,
            "a gated Allow of a trusted amount"
        );
        kani::cover!(d.kind == Kind::RawAllow, "a raw charge is accepted");
        kani::cover!(d.kind == Kind::Skipped, "a step is refused");
    }

    /// L2: the asset daily cap holds after one step from any state inside the caps.
    #[kani::proof]
    fn l2_asset_daily_holds() {
        let (s0, c) = any_state();
        let e = any_env();
        let r = any_request();
        let choice: u8 = kani::any();
        let mut s = s0;
        let d = step(&mut s, &c, &e, &r, choice);
        assert!(s.asset_day <= c.asset_daily);
        assert!(s.asset_day - s0.asset_day == d.applied.asset_day);
        if d.kind != Kind::Skipped {
            assert!(d.applied.asset_day == d.requested.asset_day);
        }
        kani::cover!(d.kind == Kind::Allow, "a gated Allow");
        kani::cover!(d.kind == Kind::Approval, "an approval");
        kani::cover!(d.kind == Kind::Skipped, "a step is refused");
    }

    /// L3: the task bound holds after one step from any state inside the caps; an approval may use the bound up (R3-03).
    #[kani::proof]
    fn l3_task_bound_holds() {
        let (s0, c) = any_state();
        let e = any_env();
        let r = any_request();
        let choice: u8 = kani::any();
        let mut s = s0;
        let d = step(&mut s, &c, &e, &r, choice);
        assert!(s.task <= c.task_bound);
        assert!(s.task - s0.task == d.applied.task);
        if is_allow(d.kind) {
            assert!(d.applied.task == d.requested.task);
        }
        if d.kind == Kind::Approval {
            assert!(d.applied.task <= d.requested.task);
        }
        kani::cover!(d.kind == Kind::Allow, "a gated Allow");
        kani::cover!(
            d.kind == Kind::Approval && d.applied.task < d.requested.task,
            "an approval that exhausts the bound"
        );
        kani::cover!(
            d.kind == Kind::Approval && d.applied.task == d.requested.task,
            "an approval that fits"
        );
    }

    /// L4: refunding the applied charge of a step restores the prior ledgers; refunding the first of two charges leaves the second.
    #[kani::proof]
    fn l4_charge_then_refund_restores() {
        let (s0, c) = any_state();
        let e = any_env();
        let ra = any_request();
        let rb = any_request();
        let ca: u8 = kani::any();
        let cb: u8 = kani::any();
        let mut s1 = s0;
        let da = step(&mut s1, &c, &e, &ra, ca);
        let mut s2 = s1;
        let db = step(&mut s2, &c, &e, &rb, cb);
        assert!(refund(&s1, &da.applied) == Some(s0));
        match refund(&s2, &da.applied) {
            Some(x) => {
                assert!(x.asset_day == s0.asset_day + db.applied.asset_day);
                assert!(x.payee_day == s0.payee_day + db.applied.payee_day);
                assert!(
                    x.payee_untrusted_day
                        == s0.payee_untrusted_day + db.applied.payee_untrusted_day
                );
                assert!(x.task == s0.task + db.applied.task);
            }
            None => {
                assert!(false, "refund of the first charge underflowed");
            }
        }
        kani::cover!(da.kind == Kind::Allow, "the first step is a gated Allow");
        kani::cover!(da.kind == Kind::Approval, "the first step is an approval");
        kani::cover!(
            da.kind != Kind::Skipped && db.kind != Kind::Skipped,
            "both steps are charged"
        );
    }

    /// L5: three verdict-gated steps on one threaded state stay inside the caps and move each ledger by at most what was left.
    #[kani::proof]
    fn l5_batch_equals_sequential_within_bounds() {
        let (s0, c) = any_state();
        let e = any_env();
        let r1 = any_request();
        let r2 = any_request();
        let r3 = any_request();
        let mut s = s0;
        let d1 = step(&mut s, &c, &e, &r1, 0);
        let d2 = step(&mut s, &c, &e, &r2, 0);
        let d3 = step(&mut s, &c, &e, &r3, 0);
        assert!(inv(&s, &c));
        assert!(
            s.asset_day >= s0.asset_day
                && s.payee_day >= s0.payee_day
                && s.payee_untrusted_day >= s0.payee_untrusted_day
                && s.task >= s0.task
        );
        let rem = remaining(&s0, &c);
        assert!(s.asset_day - s0.asset_day <= rem.asset_day);
        assert!(s.payee_day - s0.payee_day <= rem.payee_day);
        assert!(s.payee_untrusted_day - s0.payee_untrusted_day <= rem.payee_untrusted_day);
        assert!(s.task - s0.task <= rem.task);
        kani::cover!(
            d1.kind == Kind::Allow && d2.kind == Kind::Allow && d3.kind == Kind::Allow,
            "three Allow steps in one batch"
        );
        kani::cover!(
            d1.kind == Kind::Allow && (d2.kind == Kind::Skipped || d3.kind == Kind::Skipped),
            "a later request is refused after an earlier Allow"
        );
    }

    /// L6a (documentation): three requests each judged against one snapshot of the ledgers can together exceed the task bound.
    #[kani::proof]
    #[kani::should_panic]
    fn l6a_naive_snapshot_batch_exceeds_task_bound() {
        let (s0, c) = any_state();
        let e = any_env();
        let r1 = any_request();
        let r2 = any_request();
        let r3 = any_request();
        let mut sum: u128 = 0;
        let mut allowed: u8 = 0;
        if verdict_on(&s0, &c, &r1, &e) == Verdict::Allow {
            sum = sum.checked_add(r1.amount).unwrap_or(u128::MAX);
            allowed += 1;
        }
        if verdict_on(&s0, &c, &r2, &e) == Verdict::Allow {
            sum = sum.checked_add(r2.amount).unwrap_or(u128::MAX);
            allowed += 1;
        }
        if verdict_on(&s0, &c, &r3, &e) == Verdict::Allow {
            sum = sum.checked_add(r3.amount).unwrap_or(u128::MAX);
            allowed += 1;
        }
        kani::cover!(
            allowed >= 2,
            "two requests are Allow against the same snapshot"
        );
        assert!(
            sum <= c.task_bound - s0.task,
            "L6a naive snapshot batch exceeds task bound"
        );
    }

    /// L6b (documentation): two approvals that each pass the daily recheck but charge no ledger can together exceed the daily cap.
    #[kani::proof]
    #[kani::should_panic]
    fn l6b_uncharged_approvals_exceed_daily_cap() {
        let (s0, c) = any_state();
        let r1 = any_request();
        let r2 = any_request();
        let room = c.asset_daily - s0.asset_day;
        let ok = |a: u128| a > 0 && a <= room;
        let mut moved: u128 = 0;
        if ok(r1.amount) {
            moved = moved.saturating_add(r1.amount);
        }
        if ok(r2.amount) {
            moved = moved.saturating_add(r2.amount);
        }
        kani::cover!(
            ok(r1.amount) && ok(r2.amount),
            "both approvals pass the daily recheck"
        );
        assert!(moved <= room, "L6b uncharged approvals exceed daily cap");
    }
}

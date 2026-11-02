/-
Frozen statements of every exported theorem of Verdict.lean (AIR-030). `lake comparator` (proofs/comparator.json) requires each
theorem of Solution.lean, which is the real Verdict.lean, to state exactly what is written here, so a theorem that is weakened
in Verdict.lean fails the gate. The bodies are `sorry` on purpose; this library is not a default lake target, so `lake build`
and `lake check` never see them.

The notation is ASCII on purpose (the ASCII forms of iff, exists, and, or and less-or-equal, and Ne for not-equal): it elaborates
to the same terms as the Unicode spelling in Verdict.lean, and the comparator compares terms, not text. A new theorem in Verdict.lean needs its statement here and its
name in comparator.json, and scripts/lean-axioms.sh fails with UNPINNED THEOREM or NOT IN CHALLENGE until it has both.
-/
import VerdictModel

theorem allow_iff (r : Request) (asset : Option Limits) (p : Option Payee) (t : Option TaskScope) (f : Flags) :
    verdict r asset p t f = .allow <->
      exists a tt pp, asset = some a /\ t = some tt /\ p = some pp /\ f.paused = false /\ Ne r.amount 0 /\
        r.amount <= a.hardCap /\ r.amount <= a.remainingDaily /\ over r.fee a.maxFee = false /\
        over r.gas a.maxGas = false /\ r.recipient.nonempty = true /\ r.amountL.nonempty = true /\
        r.pc.nonempty = true /\ r.amount <= tt.remaining /\ r.pc.tainted = false /\
        r.recipient.trustedRecipient = true /\ r.amount <= pp.limit /\
        (r.amountL.trusted = true \/ capOk r.amount r.amountL.unresolved pp = true) := by
  sorry

theorem p1_untrusted_pc_not_allowed (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (h : r.pc.tainted = true) : Ne (verdict r a p t f) .allow := by
  sorry

theorem p2_p15_allowed_recipient_trusted (r : Request) (a : Option Limits) (p : Option Payee)
    (t : Option TaskScope) (f : Flags) (h : verdict r a p t f = .allow) :
    r.recipient.trustedRecipient = true /\ r.recipient.oracle = false := by
  sorry

theorem p3_allowed_in_book (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (h : verdict r a p t f = .allow) : p.isSome = true := by
  sorry

theorem p4_p14_p23_untrusted_amount_bounded (r : Request) (a : Option Limits) (p : Option Payee)
    (t : Option TaskScope) (f : Flags) (h : verdict r a p t f = .allow) :
    r.amountL.trusted = true \/
      (r.amountL.unresolved = false /\
        exists pp cap, p = some pp /\ pp.cap = some cap /\ r.amount <= cap /\ r.amount <= pp.budget) := by
  sorry

theorem p6_lying_book_not_allowed (r : Request) (a : Option Limits) (t : Option TaskScope) (f : Flags)
    (_h : r.recipient.book = true) : Ne (verdict r a none t f) .allow := by
  sorry

theorem p7_taint_monotone (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (u1 x1 u2 x2 u3 x3 : Bool)
    (wf : r.recipient.nonempty = true /\ r.amountL.nonempty = true /\ r.pc.nonempty = true)
    (h : Ne (verdict r a p t f) .allow) :
    Ne (verdict { r with recipient := r.recipient.addTaint u1 x1, amountL := r.amountL.addTaint u2 x2,
                         pc := r.pc.addTaint u3 x3 } a p t f) .allow := by
  sorry

theorem p9_p20_missing_not_allowed (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags)
    (h : r.recipient.nonempty = false \/ r.amountL.nonempty = false \/ r.pc.nonempty = false) :
    Ne (verdict r a p t f) .allow := by
  sorry

theorem p21_allowed_in_task_bound (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (h : verdict r a p t f = .allow) : exists tt, t = some tt /\ r.amount <= tt.remaining := by
  sorry

theorem p22_allowed_in_payee_limit (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (h : verdict r a p t f = .allow) : exists pp, p = some pp /\ r.amount <= pp.limit := by
  sorry

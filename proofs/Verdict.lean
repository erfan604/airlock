/-
AIRLOCK verdict: the exact characterization of when money moves (`allow_iff`) and the safety theorems derived from it.
The definitions are in VerdictModel.lean. Kani proves the Rust bit for bit; this file states the same rules in a form a
reviewer can read, and VerdictRun.lean runs the model against the Rust on random vectors.

Properties that are bounds on the Rust arithmetic (P5, P10, P18) stay Kani harnesses and are not restated here.
-/
import VerdictModel

/-- Exact characterization: the verdict is Allow if and only if all 17 conditions hold (the asset, the task scope and the
payee exist as witnesses; C1, C11 and C15). -/
theorem allow_iff (r : Request) (asset : Option Limits) (p : Option Payee) (t : Option TaskScope) (f : Flags) :
    verdict r asset p t f = .allow ↔
      ∃ a tt pp, asset = some a ∧ t = some tt ∧ p = some pp ∧ f.paused = false ∧ r.amount ≠ 0 ∧
        r.amount ≤ a.hardCap ∧ r.amount ≤ a.remainingDaily ∧ over r.fee a.maxFee = false ∧
        over r.gas a.maxGas = false ∧ r.recipient.nonempty = true ∧ r.amountL.nonempty = true ∧
        r.pc.nonempty = true ∧ r.amount ≤ tt.remaining ∧ r.pc.tainted = false ∧
        r.recipient.trustedRecipient = true ∧ r.amount ≤ pp.limit ∧
        (r.amountL.trusted = true ∨ capOk r.amount r.amountL.unresolved pp = true) := by
  constructor
  · intro h
    cases asset with
    | none => simp [verdict] at h
    | some a =>
      simp only [verdict] at h
      -- peel the checks in rule order; a check that fires would make `h` a verdict other than Allow
      have c1 : ¬(f.paused = true) := by
        intro hc; simp only [hc, ↓reduceIte] at h; cases h
      simp only [c1] at h
      have c2 : ¬(r.amount = 0 ∨ r.amount > a.hardCap) := by
        intro hc; simp only [hc, ↓reduceIte] at h; cases h
      simp only [c2, ↓reduceIte] at h
      have c3 : ¬(r.amount > a.remainingDaily) := by
        intro hc; simp only [hc, ↓reduceIte] at h; cases h
      simp only [c3, ↓reduceIte] at h
      have c4 : ¬((over r.fee a.maxFee || over r.gas a.maxGas) = true) := by
        intro hc; simp only [hc, ↓reduceIte] at h; cases h
      simp only [c4] at h
      have c5 : ¬((!r.recipient.nonempty || !r.amountL.nonempty || !r.pc.nonempty) = true) := by
        intro hc; simp only [hc, ↓reduceIte] at h; cases h
      simp only [c5] at h
      have c6 : ¬((r.recipient.book && p.isNone) = true) := by
        intro hc; simp only [hc, ↓reduceIte] at h; cases h
      simp only [c6] at h
      cases t with
      | none => cases h
      | some tt =>
        simp only at h
        have c7 : ¬(r.amount > tt.remaining) := by
          intro hc; simp only [hc, ↓reduceIte] at h; cases h
        simp only [c7, ↓reduceIte] at h
        have c8 : ¬(r.pc.tainted = true) := by
          intro hc; simp only [hc, ↓reduceIte] at h; cases h
        simp only [c8] at h
        have c9 : ¬((!r.recipient.trustedRecipient) = true) := by
          intro hc; simp only [hc, ↓reduceIte] at h; cases h
        simp only [c9] at h
        cases p with
        | none => cases h
        | some pp =>
          simp only at h
          have c10 : ¬(r.amount > pp.limit) := by
            intro hc; simp only [hc, ↓reduceIte] at h; cases h
          simp only [c10, ↓reduceIte] at h
          have c11 : r.amountL.trusted = true ∨ capOk r.amount r.amountL.unresolved pp = true := by
            by_cases ht : (!r.amountL.trusted) = true
            · simp only [ht, ↓reduceIte] at h
              by_cases hc : capOk r.amount r.amountL.unresolved pp = true
              · exact Or.inr hc
              · simp only [hc] at h; cases h
            · left; simpa using ht
          simp only [Bool.or_eq_true, Bool.not_eq_true'] at c4 c5
          refine ⟨a, tt, pp, rfl, rfl, rfl, by simpa using c1, by omega, by omega, by omega, ?_, ?_, ?_, ?_, ?_, by omega,
            ?_, ?_, by omega, c11⟩
          all_goals simp_all
  · rintro ⟨a, tt, pp, rfl, rfl, rfl, h1, h2, h3, h4, h5, h6, h7, h8, h9, h10, h11, h12, h13, h14⟩
    have e1 : ¬(f.paused = true) := by simp [h1]
    have e2 : ¬(r.amount = 0 ∨ r.amount > a.hardCap) := by omega
    have e3 : ¬(r.amount > a.remainingDaily) := by omega
    have e4 : ¬((over r.fee a.maxFee || over r.gas a.maxGas) = true) := by simp [h5, h6]
    have e5 : ¬((!r.recipient.nonempty || !r.amountL.nonempty || !r.pc.nonempty) = true) := by simp [h7, h8, h9]
    have e6 : ¬((r.recipient.book && (some pp).isNone) = true) := by simp
    have e7 : ¬(r.amount > tt.remaining) := by omega
    have e8 : ¬(r.pc.tainted = true) := by simp [h11]
    have e9 : ¬((!r.recipient.trustedRecipient) = true) := by simp [h12]
    have e10 : ¬(r.amount > pp.limit) := by omega
    simp only [verdict, e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, Bool.false_eq_true, ↓reduceIte]
    rcases h14 with h | h
    · simp only [h, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
    · by_cases ht : r.amountL.trusted = true
      · simp only [ht, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
      · have ht' : (!r.amountL.trusted) = true := by simpa using ht
        simp only [ht', h, ↓reduceIte]

/-- P1: a pc with an untrusted label is never allowed. -/
theorem p1_untrusted_pc_not_allowed (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (h : r.pc.tainted = true) : verdict r a p t f ≠ .allow := by
  intro hv
  rw [allow_iff] at hv
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, htaint, _, _, _⟩ := hv
  rw [h] at htaint
  cases htaint

/-- P2 and P15: an allowed recipient is trusted and carries no Oracle label. -/
theorem p2_p15_allowed_recipient_trusted (r : Request) (a : Option Limits) (p : Option Payee)
    (t : Option TaskScope) (f : Flags) (h : verdict r a p t f = .allow) :
    r.recipient.trustedRecipient = true ∧ r.recipient.oracle = false := by
  rw [allow_iff] at h
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, htrust, _, _⟩ := h
  refine ⟨htrust, ?_⟩
  simp only [Labels.trustedRecipient, Bool.and_eq_true, Bool.not_eq_true'] at htrust
  exact htrust.2

/-- P3: an allowed payment has a payee entry in the book. -/
theorem p3_allowed_in_book (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (h : verdict r a p t f = .allow) : p.isSome = true := by
  rw [allow_iff] at h
  obtain ⟨_, _, pp, _, _, hp, _, _, _, _, _, _, _, _, _, _, _, _, _, _⟩ := h
  rw [hp]
  rfl

/-- P4, P14 and P23: an allowed untrusted amount is bounded by the payee cap and budget and is not Unresolved. -/
theorem p4_p14_p23_untrusted_amount_bounded (r : Request) (a : Option Limits) (p : Option Payee)
    (t : Option TaskScope) (f : Flags) (h : verdict r a p t f = .allow) :
    r.amountL.trusted = true ∨
      (r.amountL.unresolved = false ∧
        ∃ pp cap, p = some pp ∧ pp.cap = some cap ∧ r.amount ≤ cap ∧ r.amount ≤ pp.budget) := by
  rw [allow_iff] at h
  obtain ⟨_, _, pp, _, _, hp, _, _, _, _, _, _, _, _, _, _, _, _, _, hor⟩ := h
  rcases hor with htrusted | hcap
  · exact Or.inl htrusted
  · right
    unfold capOk at hcap
    cases hc : pp.cap with
    | none => simp [hc] at hcap
    | some cap =>
      simp only [hc, Bool.and_eq_true, Bool.not_eq_true', decide_eq_true_eq] at hcap
      exact ⟨hcap.1.1, pp, cap, hp, hc, hcap.1.2, hcap.2⟩

/-- P6: a recipient labelled Book with no payee entry is never allowed (a lying runtime). The proof does not need the label:
no payee entry is already enough (C15), which is the stronger fact; the Book hypothesis names the case rule 5 blocks. -/
theorem p6_lying_book_not_allowed (r : Request) (a : Option Limits) (t : Option TaskScope) (f : Flags)
    (_h : r.recipient.book = true) : verdict r a none t f ≠ .allow := by
  intro hv
  rw [allow_iff] at hv
  obtain ⟨_, _, _, _, _, hp, _, _, _, _, _, _, _, _, _, _, _, _, _, _⟩ := hv
  cases hp

/-- P7: on a well-formed request, adding taint to any of the three label sets never turns a non-Allow into Allow. -/
theorem p7_taint_monotone (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (u1 x1 u2 x2 u3 x3 : Bool)
    (wf : r.recipient.nonempty = true ∧ r.amountL.nonempty = true ∧ r.pc.nonempty = true)
    (h : verdict r a p t f ≠ .allow) :
    verdict { r with recipient := r.recipient.addTaint u1 x1, amountL := r.amountL.addTaint u2 x2,
                     pc := r.pc.addTaint u3 x3 } a p t f ≠ .allow := by
  intro h2
  apply h
  rw [allow_iff] at h2 ⊢
  obtain ⟨a', tt, pp, ha, ht, hp, hpaused, hnz, hhard, hdaily, hfee, hgas, _, _, _, hrem, htaint, htrust, hlim, hor⟩ := h2
  refine ⟨a', tt, pp, ha, ht, hp, hpaused, hnz, hhard, hdaily, hfee, hgas, wf.1, wf.2.1, wf.2.2, hrem, ?_, ?_, hlim, ?_⟩
  · simp_all [Labels.addTaint, Labels.tainted]
  · simp_all [Labels.addTaint, Labels.tainted, Labels.trustedRecipient, Labels.nonempty]
  · rcases hor with htrusted | hcap
    · left
      simp_all [Labels.addTaint, Labels.tainted, Labels.trusted, Labels.nonempty]
    · right
      unfold capOk at hcap ⊢
      cases hc : pp.cap with
      | none => simp [hc] at hcap
      | some cap =>
        simp only [hc, Labels.addTaint, Bool.and_eq_true, Bool.not_eq_true', decide_eq_true_eq,
          Bool.or_eq_false_iff] at hcap ⊢
        exact ⟨⟨hcap.1.1.1, hcap.1.2⟩, hcap.2⟩

/-- P9 and P20: a request with an empty label set (recipient, amount or pc) is never allowed. -/
theorem p9_p20_missing_not_allowed (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags)
    (h : r.recipient.nonempty = false ∨ r.amountL.nonempty = false ∨ r.pc.nonempty = false) :
    verdict r a p t f ≠ .allow := by
  intro hv
  rw [allow_iff] at hv
  obtain ⟨_, _, _, _, _, _, _, _, _, _, _, _, hrec, hamt, hpc, _, _, _, _, _⟩ := hv
  rcases h with h | h | h
  · rw [h] at hrec
    cases hrec
  · rw [h] at hamt
    cases hamt
  · rw [h] at hpc
    cases hpc

/-- P21: an allowed payment is inside the owner-confirmed task bound. -/
theorem p21_allowed_in_task_bound (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (h : verdict r a p t f = .allow) : ∃ tt, t = some tt ∧ r.amount ≤ tt.remaining := by
  rw [allow_iff] at h
  obtain ⟨_, tt, _, _, ht, _, _, _, _, _, _, _, _, _, _, hrem, _, _, _, _⟩ := h
  exact ⟨tt, ht, hrem⟩

/-- P22: an allowed payment is within the payee's remaining daily limit. -/
theorem p22_allowed_in_payee_limit (r : Request) (a : Option Limits) (p : Option Payee) (t : Option TaskScope)
    (f : Flags) (h : verdict r a p t f = .allow) : ∃ pp, p = some pp ∧ r.amount ≤ pp.limit := by
  rw [allow_iff] at h
  obtain ⟨_, _, pp, _, _, hp, _, _, _, _, _, _, _, _, _, _, _, _, hlim, _⟩ := h
  exact ⟨pp, hp, hlim⟩

/-! The 14 rows of the v3 vector table (plan DAY1-3 Task 2), machine-checked against the model. Fixture `A`: hard cap 1000,
remaining daily 1000, max fee 50, max gas 100000; `T`: task remaining 1000; `F`: not paused. -/
namespace Rows

def OWNER := toLabels 1
def BOOK := toLabels 2
def ORACLE := toLabels 8
def EMAIL := toLabels 32
def OWNER_EMAIL := toLabels 33
def NONE := toLabels 0

def req (recipient amountL pc : Labels) (amount : Nat) : Request :=
  { amount := amount, fee := none, gas := none, recipient := recipient, amountL := amountL, pc := pc }

def A : Limits := { hardCap := 1000, remainingDaily := 1000, maxFee := 50, maxGas := 100000 }
def T : TaskScope := { remaining := 1000 }
def F : Flags := { paused := false }
def NOCAP : Payee := { cap := none, budget := 0, limit := 1000 }
def CAP500 : Payee := { cap := some 500, budget := 1000, limit := 1000 }

-- row 1
example : verdict (req BOOK OWNER OWNER 10) (some A) (some NOCAP) (some T) F = .allow := by decide
-- row 2
example : verdict (req BOOK EMAIL OWNER 400) (some A) (some CAP500) (some T) F = .allow := by decide
-- row 3
example : verdict (req BOOK EMAIL OWNER 400) (some A) (some { CAP500 with budget := 300 }) (some T) F
    = .escalate .untrustedAmount := by decide
-- row 4
example : verdict (req BOOK EMAIL OWNER 940) (some A) (some CAP500) (some T) F = .escalate .untrustedAmount := by decide
-- row 5
example : verdict (req BOOK OWNER OWNER_EMAIL 10) (some A) (some NOCAP) (some T) F = .escalate .untrustedTrigger := by decide
-- row 6
example : verdict (req BOOK OWNER OWNER 10) (some A) none (some T) F = .block .bookLabelNotInBook := by decide
-- row 7
example : verdict (req EMAIL OWNER OWNER 10) (some A) none (some T) F = .escalate .untrustedRecipient := by decide
-- row 8
example : verdict (req ORACLE OWNER OWNER 10) (some A) none (some T) F = .escalate .untrustedRecipient := by decide
-- row 9
example : verdict (req OWNER OWNER OWNER 10) (some A) none (some T) F = .escalate .newRecipient := by decide
-- row 10
example : verdict (req BOOK OWNER OWNER 5000) (some A) (some NOCAP) (some T) F = .block .amountOutOfBounds := by decide
-- row 11
example : verdict (req BOOK OWNER NONE 10) (some A) (some NOCAP) (some T) F = .block .missingProvenance := by decide
-- row 12
example : verdict (req BOOK OWNER OWNER 10) none (some NOCAP) (some T) F = .block .unknownAsset := by decide
-- row 13
example : verdict { req BOOK OWNER OWNER 10 with fee := some 10, gas := some 200000 } (some A) (some NOCAP) (some T) F
    = .block .feeTooHigh := by decide
-- row 14
example : verdict (req BOOK OWNER OWNER 10) (some A) (some NOCAP) (some T) { paused := true } = .block .paused := by decide

-- the rules the table does not reach: daily limit, task scope, payee limit, Unresolved, u128 bounds, zero
example : verdict (req BOOK OWNER OWNER 10) (some { A with remainingDaily := 5 }) (some NOCAP) (some T) F
    = .block .dailyLimit := by decide
example : verdict (req BOOK OWNER OWNER 10) (some A) (some NOCAP) none F = .escalate .outsideTask := by decide
example : verdict (req BOOK OWNER OWNER 10) (some A) (some NOCAP) (some { remaining := 5 }) F
    = .escalate .overTaskBound := by decide
example : verdict (req BOOK OWNER OWNER 10) (some A) (some { NOCAP with limit := 5 }) (some T) F
    = .escalate .overPayeeLimit := by decide
example : verdict (req BOOK (toLabels 16) OWNER 10) (some A) (some CAP500) (some T) F = .escalate .untrustedAmount := by decide
example : verdict (req BOOK ORACLE OWNER 10) (some A) (some NOCAP) (some T) F = .allow := by decide
example : verdict (req BOOK OWNER OWNER 0) (some A) (some NOCAP) (some T) F = .block .amountOutOfBounds := by decide
example : verdict (req BOOK OWNER OWNER (2 ^ 128 - 1))
    (some { hardCap := 2 ^ 128 - 1, remainingDaily := 2 ^ 128 - 1, maxFee := 50, maxGas := 100000 })
    (some { cap := none, budget := 0, limit := 2 ^ 128 - 1 }) (some { remaining := 2 ^ 128 - 1 }) F = .allow := by decide

-- the mask decode the runner and the Rust masks share
example : toLabels 0 = {} := by decide
example : toLabels 33 = { owner := true, untrusted := true } := by decide
example : toLabels 16 = { unresolved := true } := by decide
example : toLabels 15 = { owner := true, book := true, policy := true, oracle := true } := by decide
example : toLabels 32768 = { untrusted := true } := by decide

end Rows

#print axioms allow_iff
#print axioms p1_untrusted_pc_not_allowed
#print axioms p2_p15_allowed_recipient_trusted
#print axioms p3_allowed_in_book
#print axioms p4_p14_p23_untrusted_amount_bounded
#print axioms p6_lying_book_not_allowed
#print axioms p7_taint_monotone
#print axioms p9_p20_missing_not_allowed
#print axioms p21_allowed_in_task_bound
#print axioms p22_allowed_in_payee_limit

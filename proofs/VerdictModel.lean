/-
AIRLOCK verdict model: Lean 4 definitions of the on-chain verdict (SPEC 8.3, "Verdict v3", rules 0 to 12), restated from the
spec and the Rust crate contracts/airlock-verdict. Definitions only, no theorems: Verdict.lean proves the properties and
VerdictRun.lean runs this model on vectors, so a mutated model still compiles and the Lean versus Rust differential is what
turns red, not the build.

Amounts are Nat. The differential keeps every value below 2^128, the range of the Rust u128.

Labels are a structure of Bools. The Rust masks decode through `toLabels`: bits 0 to 4 are owner, book, policy, oracle and
unresolved, any set bit from 5 up (the untrusted channels) is `untrusted`.
-/

structure Labels where
  owner : Bool := false
  book : Bool := false
  policy : Bool := false
  oracle : Bool := false
  unresolved : Bool := false
  untrusted : Bool := false
deriving Repr, DecidableEq

/-- Some label is set: the Rust test `l != 0`. -/
def Labels.nonempty (l : Labels) : Bool :=
  l.owner || l.book || l.policy || l.oracle || l.unresolved || l.untrusted

/-- Unresolved or an untrusted channel: a bit outside {Owner, Book, Policy, Oracle}. -/
def Labels.tainted (l : Labels) : Bool := l.unresolved || l.untrusted

/-- Amount trust, `value_trusted`: non-empty and within {Owner, Book, Policy, Oracle}. An empty set is untrusted. -/
def Labels.trusted (l : Labels) : Bool := l.nonempty && !l.tainted

/-- Recipient trust, `recipient_trusted`: non-empty and within {Owner, Book, Policy}; Oracle is for numbers, never for addresses. -/
def Labels.trustedRecipient (l : Labels) : Bool := l.nonempty && !l.tainted && !l.oracle

/-- Adding taint bits to a label set (used by the monotonicity theorem). -/
def Labels.addTaint (l : Labels) (u x : Bool) : Labels :=
  { l with unresolved := l.unresolved || u, untrusted := l.untrusted || x }

/-- The 14 reasons `verdict` returns (the three flood reasons of the Rust enum are never returned by `verdict`). -/
inductive Reason
  | unknownAsset | paused | amountOutOfBounds | dailyLimit | feeTooHigh | missingProvenance
  | bookLabelNotInBook | outsideTask | overTaskBound | untrustedTrigger | untrustedRecipient | newRecipient
  | overPayeeLimit | untrustedAmount
deriving Repr, DecidableEq

inductive Verdict
  | allow
  | escalate (r : Reason)
  | block (r : Reason)
deriving Repr, DecidableEq

/-- Owner-registered limits of one asset. -/
structure Limits where
  hardCap : Nat
  remainingDaily : Nat
  maxFee : Nat
  maxGas : Nat

structure Flags where
  paused : Bool

/-- An address-book entry: the largest single untrusted amount (`none`: never), what is left of today's untrusted budget,
and what is left of today's limit for any amount. -/
structure Payee where
  cap : Option Nat
  budget : Nat
  limit : Nat

/-- What is left of the owner-signed task bound for this (task, payee). -/
structure TaskScope where
  remaining : Nat

/-- One payment request. `fee` and `gas` are `none` on the NEAR lane. -/
structure Request where
  amount : Nat
  fee : Option Nat
  gas : Option Nat
  recipient : Labels
  amountL : Labels
  pc : Labels

/-- A present value above the cap; an absent value never exceeds anything (rule 3 on the NEAR lane). -/
def over (x : Option Nat) (cap : Nat) : Bool :=
  match x with
  | some v => decide (v > cap)
  | none => false

/-- Rule 11 for an untrusted amount: not Unresolved, the payee has a cap, and the amount is within the cap and the budget. -/
def capOk (amount : Nat) (unresolved : Bool) (p : Payee) : Bool :=
  match p.cap with
  | some cap => !unresolved && decide (amount ≤ cap) && decide (amount ≤ p.budget)
  | none => false

/-- Rules 0 to 12 of SPEC 8.3, in order, first match wins. -/
def verdict (r : Request) (asset : Option Limits) (payee : Option Payee) (task : Option TaskScope)
    (f : Flags) : Verdict :=
  match asset with
  | none => .block .unknownAsset
  | some a =>
    if f.paused then .block .paused
    else if r.amount = 0 ∨ r.amount > a.hardCap then .block .amountOutOfBounds
    else if r.amount > a.remainingDaily then .block .dailyLimit
    else if over r.fee a.maxFee || over r.gas a.maxGas then .block .feeTooHigh
    else if !r.recipient.nonempty || !r.amountL.nonempty || !r.pc.nonempty then .block .missingProvenance
    else if r.recipient.book && payee.isNone then .block .bookLabelNotInBook
    else match task with
      | none => .escalate .outsideTask
      | some t =>
        if r.amount > t.remaining then .escalate .overTaskBound
        else if r.pc.tainted then .escalate .untrustedTrigger
        else if !r.recipient.trustedRecipient then .escalate .untrustedRecipient
        else match payee with
          | none => .escalate .newRecipient
          | some p =>
            if r.amount > p.limit then .escalate .overPayeeLimit
            else if !r.amountL.trusted then
              (if capOk r.amount r.amountL.unresolved p then .allow else .escalate .untrustedAmount)
            else .allow

/-- Bit `i` of the mask `n`. -/
def bit (n i : Nat) : Bool := (n >>> i) % 2 == 1

/-- Decode a u16 label mask: owner = bit 0, book = bit 1, policy = bit 2, oracle = bit 3, unresolved = bit 4, untrusted =
any bit from 5 up. -/
def toLabels (n : Nat) : Labels :=
  { owner := bit n 0, book := bit n 1, policy := bit n 2, oracle := bit n 3,
    unresolved := bit n 4, untrusted := (n >>> 5) != 0 }

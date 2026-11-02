/-
AIRLOCK interpreter core: noninterference of trusted payments (throwaway spike).
Model of the plan DSL core: grounded owner literals, ungrounded literals (Unresolved), variables, oracle reads
(trusted), untrusted reads (tools, every extraction), address-book lookups that keep the key's taint, binary operators,
single assignment (re-binding aborts: SPEC rule 12), if/else with program-counter taint, pay.
Theorem: two runs that differ only in untrusted inputs, if both complete, emit identical trusted payments.
-/

namespace NI

abbrev Val := Nat × Bool          -- value, tainted
abbrev Store := Nat → Option Val

inductive Expr where
  | lit : Nat → Expr                      -- owner literal that passed literal grounding (rule 8)
  | ulit : Nat → Expr                     -- plan literal NOT found in the owner's words: Unresolved (tainted)
  | var : Nat → Expr
  | orc : Nat → Expr
  | ext : Nat → Expr
  | look : Expr → Expr                    -- owner address-book lookup: the entry keeps the key's taint (rule 5)
  | bin : (Nat → Nat → Nat) → Expr → Expr → Expr

inductive Stmt where
  | skip : Stmt
  | assign : Nat → Expr → Stmt
  | pay : Expr → Expr → Stmt
  | seq : Stmt → Stmt → Stmt
  | ite : Expr → Stmt → Stmt → Stmt
  /-- bounded loop: `rep x n m body` runs body for i < min n m with the index bound to fresh variable x;
      body-local variables are scoped to one iteration (the store is restored after each iteration) -/
  | rep : Nat → Expr → Nat → Stmt → Stmt

structure Action where
  rcpt : Nat
  rT : Bool
  amt : Nat
  aT : Bool
  pc : Bool
deriving DecidableEq

def eval (O U : Nat → Nat) (σ : Store) : Expr → Option Val
  | .lit n => some (n, false)
  | .ulit n => some (n, true)
  | .var x => σ x
  | .orc k => some (O k, false)
  | .ext k => some (U k, true)
  | .look k =>
    match eval O U σ k with
    | some (vk, tk) => some (O (1000000 + vk), tk)      -- the book is part of the trusted world O
    | none => none
  | .bin f a b =>
    match eval O U σ a, eval O U σ b with
    | some (va, ta), some (vb, tb) => some (f va vb, ta || tb)
    | _, _ => none

def upd (σ : Store) (x : Nat) (v : Val) : Store := fun y => if y = x then some v else σ y

def exec (O U : Nat → Nat) : Stmt → Bool → Store → Option (Store × List Action)
  | .skip, _, σ => some (σ, [])
  | .assign x e, pc, σ =>
    match σ x with
    | some _ => none
    | none =>
      match eval O U σ e with
      | some (v, t) => some (upd σ x (v, t || pc), [])
      | none => none
  | .pay r a, pc, σ =>
    match eval O U σ r, eval O U σ a with
    | some (vr, tr), some (va, ta) => some (σ, [⟨vr, tr, va, ta, pc⟩])
    | _, _ => none
  | .seq s1 s2, pc, σ =>
    match exec O U s1 pc σ with
    | some (σ1, l1) =>
      match exec O U s2 pc σ1 with
      | some (σ2, l2) => some (σ2, l1 ++ l2)
      | none => none
    | none => none
  | .ite c s1 s2, pc, σ =>
    match eval O U σ c with
    | some (vc, tc) => if vc ≠ 0 then exec O U s1 (pc || tc) σ else exec O U s2 (pc || tc) σ
    | none => none
  | .rep x n m body, pc, σ =>
    match σ x, eval O U σ n with
    | none, some (vn, tn) =>
      let runs := (List.range (min vn m)).map (fun i => exec O U body (pc || tn) (upd σ x (i, tn || pc)))
      if runs.all Option.isSome then some (σ, (runs.filterMap id).flatMap (·.2)) else none
    | _, _ => none

def trustedA (a : Action) : Bool := !a.rT && !a.aT && !a.pc
def trustedOf (l : List Action) : List Action := l.filter trustedA

/-- Two stores agree on every trusted entry. -/
def lowEq (σ σ' : Store) : Prop := ∀ x v, σ x = some (v, false) ↔ σ' x = some (v, false)

theorem lowEq_symm {σ σ' : Store} (h : lowEq σ σ') : lowEq σ' σ := fun x v => (h x v).symm
theorem lowEq_trans {a b c : Store} (h1 : lowEq a b) (h2 : lowEq b c) : lowEq a c :=
  fun x v => (h1 x v).trans (h2 x v)
theorem lowEq_refl (σ : Store) : lowEq σ σ := fun _ _ => Iff.rfl

/-- A trusted value computes the same in any store that agrees on trusted entries, whatever the untrusted world. -/
theorem eval_low (O U U' : Nat → Nat) {σ σ' : Store} (hσ : lowEq σ σ') :
    ∀ (e : Expr) (v : Nat), eval O U σ e = some (v, false) → eval O U' σ' e = some (v, false) := by
  intro e
  induction e with
  | lit n => intro v h; simpa [eval] using h
  | ulit n => intro v h; simp [eval] at h
  | var x => intro v h; simp only [eval] at h ⊢; exact (hσ x v).mp h
  | orc k => intro v h; simpa [eval] using h
  | ext k => intro v h; simp [eval] at h
  | look k ihk =>
    intro v h
    simp only [eval] at h ⊢
    cases hk : eval O U σ k with
    | none => simp [hk] at h
    | some pk =>
      obtain ⟨vk, tk⟩ := pk
      simp only [hk, Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨hv, ht⟩ := h
      subst ht
      rw [ihk vk hk]
      simp [hv]
  | bin f a b iha ihb =>
    intro v h
    simp only [eval] at h ⊢
    cases ha : eval O U σ a with
    | none => simp [ha] at h
    | some pa =>
      cases hb : eval O U σ b with
      | none => simp [ha, hb] at h
      | some pb =>
        obtain ⟨va, ta⟩ := pa
        obtain ⟨vb, tb⟩ := pb
        simp only [ha, hb, Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨hv, ht⟩ := h
        have hta : ta = false := by cases ta <;> simp_all
        have htb : tb = false := by cases tb <;> simp_all
        subst hta htb
        rw [iha va ha, ihb vb hb]
        simp [hv]

/-- If one run sees a tainted value, the other run sees a tainted value too (or fails). -/
theorem eval_taint_agree (O U U' : Nat → Nat) {σ σ' : Store} (hσ : lowEq σ σ') (e : Expr) {v v' : Nat} {t' : Bool}
    (h1 : eval O U σ e = some (v, true)) (h2 : eval O U' σ' e = some (v', t')) : t' = true := by
  cases t' with
  | true => rfl
  | false =>
    have := eval_low O U' U (lowEq_symm hσ) e v' h2
    rw [h1] at this; simp at this

theorem trustedOf_append (l1 l2 : List Action) : trustedOf (l1 ++ l2) = trustedOf l1 ++ trustedOf l2 := by
  simp [trustedOf, List.filter_append]

theorem trustedOf_nil_of_pc (l : List Action) (h : ∀ a ∈ l, a.pc = true) : trustedOf l = [] := by
  simp only [trustedOf, List.filter_eq_nil_iff]
  intro a ha; simp [trustedA, h a ha]


/-- Membership in a loop's emitted actions comes from one iteration's run. -/
theorem loop_mem {is : List Nat} {f : Nat → Option (Store × List Action)} {a : Action}
    (h : a ∈ ((is.map f).filterMap id).flatMap (·.2)) : ∃ i ∈ is, ∃ p, f i = some p ∧ a ∈ p.2 := by
  simp only [List.mem_flatMap, List.mem_filterMap, List.mem_map, id] at h
  obtain ⟨p, ⟨r, ⟨i, hi, hfi⟩, hr⟩, ha⟩ := h
  exact ⟨i, hi, p, by rw [hfi, hr], ha⟩

/-- Iterations that pairwise emit the same trusted payments emit the same trusted payments in total. -/
theorem loop_ni (is : List Nat) (f g : Nat → Option (Store × List Action))
    (hfg : ∀ i ∈ is, ∀ a b, f i = some a → g i = some b → trustedOf a.2 = trustedOf b.2)
    (hf : (is.map f).all Option.isSome = true) (hg : (is.map g).all Option.isSome = true) :
    trustedOf (((is.map f).filterMap id).flatMap (·.2)) = trustedOf (((is.map g).filterMap id).flatMap (·.2)) := by
  induction is with
  | nil => simp
  | cons i is ih =>
    simp only [List.map_cons, List.all_cons, Bool.and_eq_true] at hf hg
    obtain ⟨hfi, hf⟩ := hf
    obtain ⟨hgi, hg⟩ := hg
    obtain ⟨a, ha⟩ := Option.isSome_iff_exists.mp hfi
    obtain ⟨b, hb⟩ := Option.isSome_iff_exists.mp hgi
    simp only [List.map_cons, List.filterMap_cons, ha, hb, id, List.flatMap_cons, trustedOf_append]
    rw [hfg i (by simp) a b ha hb, ih (fun j hj => hfg j (by simp [hj])) hf hg]

/-- In a tainted context nothing trusted is emitted and no trusted store entry changes. -/
theorem exec_tainted (O U : Nat → Nat) :
    ∀ (s : Stmt) (σ σ1 : Store) (l : List Action), exec O U s true σ = some (σ1, l) →
      (∀ a ∈ l, a.pc = true) ∧ lowEq σ σ1 := by
  intro s
  induction s with
  | skip => intro σ σ1 l h; simp [exec] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨by simp, lowEq_refl _⟩
  | assign x e =>
    intro σ σ1 l h
    simp only [exec] at h
    cases hx : σ x with
    | some _ => simp [hx] at h
    | none =>
      cases he : eval O U σ e with
      | none => simp [hx, he] at h
      | some p =>
        obtain ⟨v, t⟩ := p
        simp [hx, he] at h
        obtain ⟨rfl, rfl⟩ := h
        refine ⟨by simp, ?_⟩
        intro y w
        by_cases hy : y = x
        · subst hy; simp [upd, hx]
        · simp [upd, hy]
  | pay r a =>
    intro σ σ1 l h
    simp only [exec] at h
    cases hr : eval O U σ r with
    | none => simp [hr] at h
    | some pr =>
      cases ha : eval O U σ a with
      | none => simp [hr, ha] at h
      | some pa =>
        obtain ⟨vr, tr⟩ := pr; obtain ⟨va, ta⟩ := pa
        simp [hr, ha] at h
        obtain ⟨rfl, rfl⟩ := h
        exact ⟨by simp, lowEq_refl _⟩
  | seq s1 s2 ih1 ih2 =>
    intro σ σ2 l h
    simp only [exec] at h
    cases h1 : exec O U s1 true σ with
    | none => simp [h1] at h
    | some p1 =>
      obtain ⟨σ1, l1⟩ := p1
      cases h2 : exec O U s2 true σ1 with
      | none => simp [h1, h2] at h
      | some p2 =>
        obtain ⟨σ2', l2⟩ := p2
        simp [h1, h2] at h
        obtain ⟨rfl, rfl⟩ := h
        obtain ⟨a1, e1⟩ := ih1 σ σ1 l1 h1
        obtain ⟨a2, e2⟩ := ih2 σ1 σ2' l2 h2
        refine ⟨?_, lowEq_trans e1 e2⟩
        intro a ha; simp only [List.mem_append] at ha
        rcases ha with ha | ha
        · exact a1 a ha
        · exact a2 a ha
  | ite c s1 s2 ih1 ih2 =>
    intro σ σ1 l h
    simp only [exec] at h
    cases hc : eval O U σ c with
    | none => simp [hc] at h
    | some p =>
      obtain ⟨vc, tc⟩ := p
      simp only [hc, Bool.true_or] at h
      by_cases hv : vc ≠ 0
      · rw [if_pos hv] at h; exact ih1 σ σ1 l h
      · rw [if_neg hv] at h; exact ih2 σ σ1 l h
  | rep x n m body ih =>
    intro σ σ1 l h
    simp only [exec] at h
    cases hx : σ x with
    | some _ => simp [hx] at h
    | none =>
      cases hn : eval O U σ n with
      | none => simp [hx, hn] at h
      | some pn =>
        obtain ⟨vn, tn⟩ := pn
        simp only [hx, hn, Bool.true_or] at h
        split at h
        · simp only [Option.some.injEq, Prod.mk.injEq] at h
          obtain ⟨rfl, rfl⟩ := h
          refine ⟨?_, lowEq_refl _⟩
          intro a ha
          obtain ⟨i, _, p, hp, hap⟩ := loop_mem ha
          exact (ih _ p.1 p.2 hp).1 a hap
        · simp at h

/-- Noninterference: two runs from stores that agree on trusted entries, with different untrusted worlds, if both
complete, end in stores that agree on trusted entries and emit identical trusted payments. -/
theorem noninterference (O U1 U2 : Nat → Nat) :
    ∀ (s : Stmt) (pc : Bool) (σ σ' σ1 σ2 : Store) (l1 l2 : List Action),
      lowEq σ σ' → exec O U1 s pc σ = some (σ1, l1) → exec O U2 s pc σ' = some (σ2, l2) →
      lowEq σ1 σ2 ∧ trustedOf l1 = trustedOf l2 := by
  intro s
  induction s with
  | skip =>
    intro pc σ σ' σ1 σ2 l1 l2 hσ h1 h2
    simp [exec] at h1 h2; obtain ⟨rfl, rfl⟩ := h1; obtain ⟨rfl, rfl⟩ := h2; exact ⟨hσ, rfl⟩
  | assign x e =>
    intro pc σ σ' σ1 σ2 l1 l2 hσ h1 h2
    simp only [exec] at h1 h2
    cases hx : σ x with
    | some _ => simp [hx] at h1
    | none =>
      cases hx' : σ' x with
      | some _ => simp [hx'] at h2
      | none =>
        cases he : eval O U1 σ e with
        | none => simp [hx, he] at h1
        | some p =>
          cases he' : eval O U2 σ' e with
          | none => simp [hx', he'] at h2
          | some p' =>
            obtain ⟨v, t⟩ := p; obtain ⟨v', t'⟩ := p'
            simp [hx, he] at h1; simp [hx', he'] at h2
            obtain ⟨rfl, rfl⟩ := h1; obtain ⟨rfl, rfl⟩ := h2
            refine ⟨?_, rfl⟩
            cases t with
            | false =>
              have := eval_low O U1 U2 hσ e v he
              rw [he'] at this
              simp only [Option.some.injEq, Prod.mk.injEq] at this
              obtain ⟨rfl, rfl⟩ := this
              intro y w; by_cases hy : y = x
              · subst hy; simp [upd]
              · simp [upd, hy]; exact hσ y w
            | true =>
              have ht' := eval_taint_agree O U1 U2 hσ e he he'
              subst ht'
              intro y w; by_cases hy : y = x
              · subst hy; simp [upd]
              · simp [upd, hy]; exact hσ y w
  | pay r a =>
    intro pc σ σ' σ1 σ2 l1 l2 hσ h1 h2
    simp only [exec] at h1 h2
    cases hr : eval O U1 σ r with
    | none => simp [hr] at h1
    | some pr =>
    cases ha : eval O U1 σ a with
    | none => simp [hr, ha] at h1
    | some pa =>
    cases hr' : eval O U2 σ' r with
    | none => simp [hr'] at h2
    | some pr' =>
    cases ha' : eval O U2 σ' a with
    | none => simp [hr', ha'] at h2
    | some pa' =>
      obtain ⟨vr, tr⟩ := pr; obtain ⟨va, ta⟩ := pa; obtain ⟨vr', tr'⟩ := pr'; obtain ⟨va', ta'⟩ := pa'
      simp [hr, ha] at h1; simp [hr', ha'] at h2
      obtain ⟨rfl, rfl⟩ := h1; obtain ⟨rfl, rfl⟩ := h2
      refine ⟨hσ, ?_⟩
      -- the payment is trusted in one run iff in the other, and then identical
      cases tr <;> cases ta <;> cases tr' <;> cases ta' <;> cases pc <;>
        simp [trustedOf, trustedA] <;>
        first
        | (have := eval_low O U1 U2 hσ r vr hr; rw [hr'] at this; simp at this; done)
        | (have := eval_low O U1 U2 hσ a va ha; rw [ha'] at this; simp at this; done)
        | (have := eval_low O U2 U1 (lowEq_symm hσ) r vr' hr'; rw [hr] at this; simp at this; done)
        | (have := eval_low O U2 U1 (lowEq_symm hσ) a va' ha'; rw [ha] at this; simp at this; done)
        | (have h1 := eval_low O U1 U2 hσ r vr hr; have h2 := eval_low O U1 U2 hσ a va ha
           rw [hr'] at h1; rw [ha'] at h2; simp at h1 h2; simp [h1, h2])
  | seq s1 s2 ih1 ih2 =>
    intro pc σ σ' σ1 σ2 l1 l2 hσ h1 h2
    simp only [exec] at h1 h2
    cases e1 : exec O U1 s1 pc σ with
    | none => simp [e1] at h1
    | some p1 =>
    cases e1' : exec O U2 s1 pc σ' with
    | none => simp [e1'] at h2
    | some p1' =>
      obtain ⟨τ, m1⟩ := p1; obtain ⟨τ', m1'⟩ := p1'
      cases e2 : exec O U1 s2 pc τ with
      | none => simp [e1, e2] at h1
      | some p2 =>
      cases e2' : exec O U2 s2 pc τ' with
      | none => simp [e1', e2'] at h2
      | some p2' =>
        obtain ⟨ρ, m2⟩ := p2; obtain ⟨ρ', m2'⟩ := p2'
        simp [e1, e2] at h1; simp [e1', e2'] at h2
        obtain ⟨rfl, rfl⟩ := h1; obtain ⟨rfl, rfl⟩ := h2
        obtain ⟨hτ, ht1⟩ := ih1 pc σ σ' τ τ' m1 m1' hσ e1 e1'
        obtain ⟨hρ, ht2⟩ := ih2 pc τ τ' ρ ρ' m2 m2' hτ e2 e2'
        exact ⟨hρ, by rw [trustedOf_append, trustedOf_append, ht1, ht2]⟩
  | ite c s1 s2 ih1 ih2 =>
    intro pc σ σ' σ1 σ2 l1 l2 hσ h1 h2
    simp only [exec] at h1 h2
    cases hc : eval O U1 σ c with
    | none => simp [hc] at h1
    | some p =>
    cases hc' : eval O U2 σ' c with
    | none => simp [hc'] at h2
    | some p' =>
      obtain ⟨vc, tc⟩ := p; obtain ⟨vc', tc'⟩ := p'
      simp only [hc] at h1; simp only [hc'] at h2
      cases tc with
      | false =>
        -- trusted condition: both runs take the same branch
        have := eval_low O U1 U2 hσ c vc hc
        rw [hc'] at this; simp only [Option.some.injEq, Prod.mk.injEq] at this
        obtain ⟨rfl, rfl⟩ := this
        by_cases hv : vc' ≠ 0
        · rw [if_pos hv] at h1 h2; exact ih1 _ σ σ' σ1 σ2 l1 l2 hσ h1 h2
        · rw [if_neg hv] at h1 h2; exact ih2 _ σ σ' σ1 σ2 l1 l2 hσ h1 h2
      | true =>
        -- tainted condition: both runs continue in a tainted context; nothing trusted can come out
        have ht' := eval_taint_agree O U1 U2 hσ c hc hc'
        subst ht'
        simp only [Bool.or_true] at h1 h2
        have k1 : exec O U1 (if vc ≠ 0 then s1 else s2) true σ = some (σ1, l1) := by
          by_cases hv : vc ≠ 0 <;> simp_all
        have k2 : exec O U2 (if vc' ≠ 0 then s1 else s2) true σ' = some (σ2, l2) := by
          by_cases hv : vc' ≠ 0 <;> simp_all
        obtain ⟨p1, q1⟩ := exec_tainted O U1 _ σ σ1 l1 k1
        obtain ⟨p2, q2⟩ := exec_tainted O U2 _ σ' σ2 l2 k2
        refine ⟨lowEq_trans (lowEq_symm q1) (lowEq_trans hσ q2), ?_⟩
        rw [trustedOf_nil_of_pc l1 p1, trustedOf_nil_of_pc l2 p2]
  | rep x n m body ih =>
    intro pc σ σ' σ1 σ2 l1 l2 hσ h1 h2
    simp only [exec] at h1 h2
    cases hx : σ x with
    | some _ => simp [hx] at h1
    | none =>
    cases hx' : σ' x with
    | some _ => simp [hx'] at h2
    | none =>
    cases hn : eval O U1 σ n with
    | none => simp [hx, hn] at h1
    | some pn =>
    cases hn' : eval O U2 σ' n with
    | none => simp [hx', hn'] at h2
    | some pn' =>
      obtain ⟨vn, tn⟩ := pn; obtain ⟨vn', tn'⟩ := pn'
      simp only [hx, hn] at h1; simp only [hx', hn'] at h2
      split at h1
      · split at h2
        · rename_i hall1 hall2
          simp only [Option.some.injEq, Prod.mk.injEq] at h1 h2
          obtain ⟨rfl, rfl⟩ := h1; obtain ⟨rfl, rfl⟩ := h2
          refine ⟨hσ, ?_⟩
          cases tn with
          | false =>
            -- trusted bound: same number of iterations, each from stores that agree on trusted entries
            have := eval_low O U1 U2 hσ n vn hn
            rw [hn'] at this; simp only [Option.some.injEq, Prod.mk.injEq] at this
            obtain ⟨rfl, rfl⟩ := this
            apply loop_ni _ _ _ _ hall1 hall2
            intro i _ a b ha hb
            have hu : lowEq (upd σ x (i, false || pc)) (upd σ' x (i, false || pc)) := by
              intro y w; by_cases hy : y = x
              · subst hy; simp [upd]
              · simp [upd, hy]; exact hσ y w
            exact (ih _ _ _ a.1 b.1 a.2 b.2 hu ha hb).2
          | true =>
            -- tainted bound: every iteration runs in a tainted context on both sides
            have ht' := eval_taint_agree O U1 U2 hσ n hn hn'
            subst ht'
            have e1 : ∀ a ∈ ((List.range (min vn m)).map (fun i => exec O U1 body (pc || true) (upd σ x (i, true || pc)))).filterMap id |>.flatMap (·.2), a.pc = true := by
              intro a ha
              obtain ⟨i, _, p, hp, hap⟩ := loop_mem ha
              simp only [Bool.or_true] at hp
              exact (exec_tainted O U1 body _ p.1 p.2 hp).1 a hap
            have e2 : ∀ a ∈ ((List.range (min vn' m)).map (fun i => exec O U2 body (pc || true) (upd σ' x (i, true || pc)))).filterMap id |>.flatMap (·.2), a.pc = true := by
              intro a ha
              obtain ⟨i, _, p, hp, hap⟩ := loop_mem ha
              simp only [Bool.or_true] at hp
              exact (exec_tainted O U2 body _ p.1 p.2 hp).1 a hap
            rw [trustedOf_nil_of_pc _ e1, trustedOf_nil_of_pc _ e2]
        · simp at h2
      · simp at h1

/-- The headline: same plan, same trusted inputs, any two untrusted worlds: identical trusted payments. -/
theorem trusted_payments_independent_of_untrusted (O U1 U2 : Nat → Nat) (s : Stmt) (σ σ1 σ2 : Store)
    (l1 l2 : List Action) (h1 : exec O U1 s false σ = some (σ1, l1)) (h2 : exec O U2 s false σ = some (σ2, l2)) :
    trustedOf l1 = trustedOf l2 :=
  (noninterference O U1 U2 s false σ σ σ1 σ2 l1 l2 (lowEq_refl σ) h1 h2).2

#print axioms trusted_payments_independent_of_untrusted

end NI

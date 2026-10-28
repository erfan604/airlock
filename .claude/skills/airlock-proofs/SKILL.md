---
name: airlock-proofs
description: Use when changing the AIRLOCK verdict rules, the plan DSL semantics, or any proof file (contracts/airlock-verdict Kani harnesses, proofs/Verdict.lean, proofs/NI.lean, the Lean vs Rust differential test). Gives the order of work and the Lean and Kani techniques and traps learned while building the spikes.
---

# Working on the AIRLOCK proofs

Three layers must stay in sync: Kani proves the shipped Rust verdict, `proofs/Verdict.lean` proves the same rules as
theorems (with `allow_iff`), `proofs/NI.lean` proves interpreter noninterference, and `scripts/diff-verdict.sh` checks
that the Lean verdict model and the Rust verdict return identical results on 40,000 random vectors.

## Order of work for a rule change
1. Change the SPEC rule text first (plan or docs/ARCHITECTURE.md).
2. Kani: add or adjust the harness, run `cargo kani --harness <name>`, then the Rust code, then `cargo kani` (all).
3. Lean `Verdict.lean`: update the model and `allow_iff` first; most other theorems are derived from it.
4. Update both differential drivers (Rust `examples/diff.rs`, Lean `VerdictRun` main, which imports Verdict instead of copying the model) and the vector generator if the
   input shape changed; run `scripts/diff-verdict.sh`.
5. If the DSL semantics changed, update `NI.lean` (new `Expr` or `Stmt` constructor needs cases in `eval_low`,
   `exec_tainted` and `noninterference`).
6. `scripts/check.sh` must be green; `#print axioms` must not list `sorryAx`.

## Kani
- A counterexample can mean the PROPERTY is wrong, not the code (the first P7 failure was a malformed-input edge). Print
  it: `cargo kani --harness <name> -Z concrete-playback --concrete-playback=print`, decode the byte vectors in order of
  `kani::any()` calls, then decide.
- Keep labels as a u16 bitmask and amounts as u128: harnesses stay fast (about 0.05 s each).
- Monotonicity-style properties need explicit well-formedness assumptions (non-empty label sets).

## Lean 4 (core only, 4.35, no Mathlib)
- `unfold verdict; grind` closes simple goals; for nested `if`/`match` chains use a split macro:
  `(repeat' (split at *)) <;> (try simp_all) <;> (try omega) <;> (try grind)`.
- Prove `allow_iff` (both directions) first; derive the per-property theorems by destructuring it. Count the conjuncts:
  a wrong tuple arity in `obtain ⟨...⟩` gives a confusing "dependent elimination failed" error.
- When `split at h` or `split` refuses to descend into a long nested `if`/`match` chain (it happened with verdict v3),
  peel deterministically: `simp only [verdict] at h`, then for each check `have c : ¬cond := by intro hc; rw [if_pos hc]
  at h; cases h` followed by `rw [if_neg c] at h`; `cases` the `Option` inputs where the chain matches on them.
- Reverse direction of an iff over an `if` chain: rewrite each `if` with `if_neg` and the negated condition (deprecated
  name warnings are harmless).
- `obtain ⟨rfl, rfl⟩ := h` substitutes variables and can rename them (the right-hand side disappears); refer to the
  surviving name afterwards.
- Nested recursion through `List.map` inside `exec` is accepted structurally; loop proofs need two list lemmas:
  membership in `flatMap` of `filterMap` (`loop_mem`) and a pairwise lemma by induction on the index list (`loop_ni`).
- `lean-lsp-mcp` (project `.mcp.json`) gives agents goal states; run `lake build` in `proofs/` first.

## Invariants the proofs depend on (never relax without re-proving)
- DSL rule 12: single assignment (re-binding aborts or is rejected) and branch scoping. Without it the noninterference
  theorem is false (implicit flow through the branch not taken).
- Every extraction output is untrusted (`ext` in the model), whatever its source.
- All-or-nothing runs: a failed run submits nothing.
- Oracle never vouches for an address (recipient trust set is Owner, Book, Policy).
